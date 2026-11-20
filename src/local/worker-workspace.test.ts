import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as FileSystem from 'node:fs/promises';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as unixServer } from 'node:net';
import * as resources from './worker-resources.js';
import ts from 'typescript';
import { captureWorkerInitialSnapshot, createWorkerWorkspace, restoreWorkerWorkspace } from './worker-workspace.js';
import type { WorkerWorkspace, WorkerWorkspaceOptions } from './worker-workspace.js';
import { WorkerSandbox } from './worker-sandbox.js';
import { privateWorkerPath, workerRelativePath, ownsWorkerPath, snapshotWorkerFiles } from './worker-tool-helper.js';

const captureHook = vi.hoisted(() => ({ beforeOpen: undefined as ((path: unknown) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => { await captureHook.beforeOpen?.(args[0]); return actual.open(...args); } };
});
const signal = () => new AbortController().signal;
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const roots: string[] = [], workspaces: WorkerWorkspace[] = [];
let helperRoot: string, helperPath: string, namespaces = false;
async function directory() { const root = await mkdtemp(join(tmpdir(), 'grunt-workspace-test-')); roots.push(root); return root; }
async function fixture() {
  const root = await directory(); await mkdir(join(root, 'src')); await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/b.ts'), 'export const b = 2;\n'); await writeFile(join(root, 'outside.txt'), 'do not edit');
  await writeFile(join(root, '.gitignore'), 'dist/\nignored.log\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], { stdio: 'pipe', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  await writeFile(join(root, 'src/a.ts'), 'export const a = 3; // dirty\n'); await writeFile(join(root, 'src/new.ts'), 'new untracked source');
  await writeFile(join(root, '.env'), 'CREDENTIAL=fixture-private'); await writeFile(join(root, 'credentials-other.json'), 'fixture-private');
  await writeFile(join(root, '.grunt-workspace-test.proof'), 'private nonce'); await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/fixture.txt'), 'readonly dependency');
  await symlink(join(root, '.env'), join(root, 'src/escape')); await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/ignored.js'), 'generated');
  return { root, git };
}
async function workspace(options: Partial<WorkerWorkspaceOptions> = {}) {
  const result = await createWorkerWorkspace({ projectRoot: '/not-accessed/original', ownedPaths: ['src'], initialSnapshot: [{ path: 'src/a.ts', content: 'one two\n' }, { path: 'outside.txt', content: 'original' }], sandbox: { mode: 'filesystem' }, ...options }, signal());
  workspaces.push(result); return result;
}
beforeAll(async () => {
  helperRoot = await mkdtemp(join(tmpdir(), 'grunt-helper-test-')); helperPath = join(helperRoot, 'worker-tool-helper.mjs');
  const source = await readFile(new URL('./worker-tool-helper.ts', import.meta.url), 'utf8');
  await writeFile(helperPath, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, { mode: 0o600 });
  const root = await directory();
  const probe = await WorkerSandbox.create({ root, ownedPaths: ['src'], readOnly: false, maxFiles: 100, maxFileBytes: 1024 * 1024, maxOutputBytes: 4096 }, { helperPath }, signal());
  namespaces = probe.capabilities.commands;
});
afterEach(async () => { for (const worker of workspaces.splice(0)) await worker.cleanup(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
afterAll(async () => { await rm(helperRoot, { recursive: true, force: true }); });

it('normalizes safe ownership prefixes and rejects portable traversal, secrets, devices and ADS', () => {
  expect(workerRelativePath('src/')).toBe('src'); expect(workerRelativePath('.', true)).toBe('');
  for (const path of ['/etc/passwd', '../file', 'src/../../x', 'src//a', './src', 'a\\b', 'src/a:secret', 'src/a.', 'src/a ', 'con.txt', 'src/COM1', '.GIT/config', 'src/.env.local', 'src/credentials-prod.json', '.grunt-workspace-test.proof']) expect(() => workerRelativePath(path), path).toThrow();
  expect(privateWorkerPath('src/CREDENTIALS')).toBe(true); expect(ownsWorkerPath('src/abc', ['src/a'])).toBe(false); expect(ownsWorkerPath('src/a/b', ['src/a'])).toBe(true);
});
it('captures the current dirty caller working copy without Git, secrets, dependencies, proof files or symlinks', async () => {
  const { root } = await fixture(), snapshot = await captureWorkerInitialSnapshot(root);
  expect(snapshot.map(file => file.path).sort()).toEqual(['.gitignore', 'outside.txt', 'src/a.ts', 'src/b.ts', 'src/new.ts']);
  expect(snapshot.find(file => file.path === 'src/a.ts')).toEqual({ path: 'src/a.ts', content: 'export const a = 3; // dirty\n', sha256: hash('export const a = 3; // dirty\n') });
});
it.each(['client', 'sandbox helper'])('pins every source ancestor against a deterministic confidential-directory swap during %s capture', async mode => {
  const root = await directory(), destination = await directory(); await mkdir(join(root, 'src')); await mkdir(join(root, '.config'));
  await writeFile(join(root, 'src/target.ts'), 'public source'); await writeFile(join(root, '.config/target.ts'), 'PRIVATE_CREDENTIAL');
  captureHook.beforeOpen = async path => {
    if (typeof path === 'string' && path.endsWith('/target.ts')) {
      captureHook.beforeOpen = undefined;
      await rename(join(root, 'src'), join(root, 'original-src')); await symlink('.config', join(root, 'src'));
    }
  };
  try {
    if (mode === 'client') {
      const files = await captureWorkerInitialSnapshot(root); expect(files.find(file => file.path === 'src/target.ts')?.content).toBe('public source'); expect(JSON.stringify(files)).not.toContain('PRIVATE_CREDENTIAL');
    } else {
      await snapshotWorkerFiles(root, { root: destination, ownedPaths: ['src'], readOnly: false, maxFileBytes: 4096, maxFiles: 100, maxOutputBytes: 4096 }, ['src/target.ts'], 4096);
      expect(await readFile(join(destination, 'src/target.ts'), 'utf8')).toBe('public source');
    }
  } finally { captureHook.beforeOpen = undefined; }
});
it('portable filesystem mode requires a supplied snapshot before reading any original path', async () => {
  await expect(createWorkerWorkspace({ projectRoot: '/does-not-exist/private-project', ownedPaths: ['src'], sandbox: { mode: 'filesystem' } }, signal())).rejects.toMatchObject({ code: 'snapshot_required' });
  const worker = await workspace(); expect(worker.capabilities).toEqual({ filesystem: true, commands: false, sandbox: 'filesystem' });
  expect(worker.tools.some(tool => (tool.function as { name: string }).name === 'worker_command')).toBe(false);
  expect(await worker.executeTool('worker_command', { command: 'touch nope' }, signal())).toMatchObject({ ok: false, code: 'unsupported_sandbox' });
  expect(await worker.executeTool('worker_read', { path: 'src/a.ts' }, signal())).toMatchObject({ ok: true, content: 'one two\n' });
});
it('fails closed when requested command sandbox is missing; auto mode remains explicit filesystem-only', async () => {
  const worker = await workspace({ sandbox: { mode: 'auto', bwrapPath: '/does-not-exist/bwrap' } }); expect(worker.capabilities.commands).toBe(false);
  await expect(workspace({ sandbox: { mode: 'bubblewrap', bwrapPath: '/does-not-exist/bwrap' } })).rejects.toThrow();
});
it('scoped text tools edit only assigned files and emit baseline hashes without touching original files', async () => {
  const { root } = await fixture(), initialSnapshot = await captureWorkerInitialSnapshot(root), worker = await workspace({ projectRoot: root, initialSnapshot });
  expect(await worker.executeTool('worker_edit', { path: 'src/a.ts', oldText: '3', newText: '4' }, signal())).toMatchObject({ ok: true });
  expect(await worker.executeTool('worker_write', { path: 'outside.txt', content: 'bad' }, signal())).toMatchObject({ ok: false, code: 'ownership' });
  expect(await worker.executeTool('worker_write', { path: 'src/sub/file.ts', content: 'new content' }, signal())).toMatchObject({ ok: true });
  expect(await worker.executeTool('worker_delete', { path: 'src/new.ts' }, signal())).toMatchObject({ ok: true });
  const artifact = await worker.artifact(); expect(artifact).toMatchObject({ complete: true, truncated: false });
  expect(artifact.files).toEqual([
    { path: 'src/a.ts', beforeSha256: hash('export const a = 3; // dirty\n'), afterSha256: hash('export const a = 4; // dirty\n'), binary: false, content: 'export const a = 4; // dirty\n' },
    { path: 'src/new.ts', beforeSha256: hash('new untracked source'), afterSha256: null, deleted: true },
    { path: 'src/sub/file.ts', beforeSha256: null, afterSha256: hash('new content'), binary: false, content: 'new content' },
  ]);
  expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain('3; // dirty'); expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('do not edit');
});
it('filesystem tools refuse symlink escapes, secret paths, traversal and unexpected arguments', async () => {
  const worker = await workspace(), outside = await directory(); await writeFile(join(outside, 'secret'), 'never reveal');
  await symlink(outside, join(worker.path, 'src/link'));
  for (const path of ['src/link/secret', '.git/config', '../secret', 'src/.env', 'src/a:secret']) {
    expect(await worker.executeTool('worker_read', { path }, signal())).toMatchObject({ ok: false });
    expect(await worker.executeTool('worker_write', { path, content: 'bad' }, signal())).toMatchObject({ ok: false });
  }
  expect(await worker.executeTool('worker_read', { path: 'src/a.ts', projectRoot: outside }, signal())).toMatchObject({ ok: false, code: 'invalid_arguments' });
  expect(await worker.artifact()).toMatchObject({ complete: false }); expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('never reveal');
});
it('review workers expose only read tools and cannot export changes', async () => {
  const worker = await workspace({ readOnly: true, ownedPaths: [] });
  for (const name of ['worker_write', 'worker_edit', 'worker_delete']) expect(await worker.executeTool(name, { path: 'src/a.ts', content: 'bad' }, signal())).toMatchObject({ ok: false, code: 'unsupported_tool' });
  expect(await worker.executeTool('worker_search', { query: 'two' }, signal())).toMatchObject({ ok: true, matches: [{ path: 'src/a.ts', line: 1, text: 'one two' }] });
  await writeFile(join(worker.path, 'src/a.ts'), 'operator fixture mutation'); expect(await worker.artifact()).toMatchObject({ complete: false });
});
it('rejects malformed snapshots and oversize captures instead of silently dropping source', async () => {
  for (const initialSnapshot of [[{ path: '../secret', content: 'bad' }], [{ path: 'src/a', content: 'x', sha256: 'wrong' }], [{ path: 'src/a', content: '??', binary: true }], [{ path: 'src/a', content: 'x' }, { path: 'src/a', content: 'y' }]]) await expect(workspace({ initialSnapshot })).rejects.toThrow();
  await expect(workspace({ limits: { maxSnapshotBytes: 2 } })).rejects.toMatchObject({ code: 'snapshot_too_large' });
  const { root } = await fixture(); await expect(captureWorkerInitialSnapshot(root, { maxSnapshotBytes: 2 })).rejects.toMatchObject({ code: 'snapshot_too_large' });
});
it('bounds tools and exported JSON while retaining the full private changes for explicit recovery', async () => {
  const worker = await workspace({ limits: { maxArtifactBytes: 400, maxOutputBytes: 32, maxFileBytes: 1024 } });
  expect(await worker.executeTool('worker_write', { path: 'src/a.ts', content: 'a'.repeat(600) }, signal())).toMatchObject({ ok: true });
  expect(await worker.executeTool('worker_read', { path: 'src/a.ts' }, signal())).toMatchObject({ ok: true, truncated: true, content: 'a'.repeat(32) });
  const artifact = await worker.artifact(); expect(artifact).toMatchObject({ complete: false, truncated: true }); expect(Buffer.byteLength(JSON.stringify(artifact))).toBeLessThanOrEqual(400);
  expect(await readFile(join(worker.path, 'src/a.ts'), 'utf8')).toHaveLength(600);
  expect(await worker.executeTool('worker_write', { path: 'src/large', content: 'a'.repeat(1025) }, signal())).toMatchObject({ ok: false, code: 'too_large' });
});
it('retains prior edits across cancellation and supports explicit cleanup', async () => {
  const worker = await workspace(); await worker.executeTool('worker_write', { path: 'src/a.ts', content: 'partial change' }, signal());
  const controller = new AbortController(); controller.abort(new Error('cancel fixture'));
  await expect(worker.executeTool('worker_read', { path: 'src/a.ts' }, controller.signal)).rejects.toThrow('cancel fixture');
  expect(await worker.artifact()).toMatchObject({ complete: true, files: [{ content: 'partial change' }] });
  await access(worker.path); await worker.cleanup(); await expect(access(worker.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('persists protected recovery metadata and recovers the latest partial bytes without original reads', async () => {
  const stateDirectory = await directory(), worker = await workspace({ stateDirectory });
  await worker.executeTool('worker_write', { path: 'src/a.ts', content: 'completed before daemon restart' }, signal());
  // The manifest lives outside the model-writable working copy.
  expect(await readdir(worker.path)).not.toContain(worker.recoveryId + '.json');
  const restored = await restoreWorkerWorkspace({ recoveryId: worker.recoveryId, workspaceId: worker.id, stateDirectory, sandbox: { mode: 'filesystem' } }, signal());
  workspaces.push(restored); expect(restored.tools).toEqual([]);
  expect(await restored.executeTool('worker_write', { path: 'src/a.ts', content: 'never resumed' }, signal())).toMatchObject({ ok: false });
  expect(await restored.artifact()).toMatchObject({ id: worker.id, complete: true, files: [{ path: 'src/a.ts', beforeSha256: hash('one two\n'), content: 'completed before daemon restart' }] });
  await expect(restoreWorkerWorkspace({ recoveryId: '../elsewhere', workspaceId: worker.id, stateDirectory }, signal())).rejects.toMatchObject({ code: 'invalid_workspace' });
  await expect(restoreWorkerWorkspace({ recoveryId: worker.recoveryId, workspaceId: '00000000-0000-0000-0000-000000000000', stateDirectory }, signal())).rejects.toMatchObject({ code: 'invalid_workspace' });
  await restored.cleanup(); await expect(access(join(stateDirectory, worker.recoveryId + '.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('marks oversized file-count artifacts incomplete while preserving omitted changes', async () => {
  const worker = await workspace({ limits: { maxFiles: 300 } });
  for (let index = 0; index < 260; index++) await worker.executeTool('worker_write', { path: 'src/file-' + index, content: 'changed' }, signal());
  const artifact = await worker.artifact(); expect(artifact).toMatchObject({ complete: false, truncated: true }); expect(artifact.files).toHaveLength(256);
  expect(await readFile(join(worker.path, 'src/file-259'), 'utf8')).toBe('changed');
});

describe('verified Linux namespace integration', () => {
  async function linux(options: Partial<WorkerWorkspaceOptions> = {}) { return workspace({ sandbox: { mode: 'bubblewrap', helperPath }, ...options }); }
  it('isolates filesystem tools and commands from host credentials, original Git, source mounts and environment', async context => {
    if (!namespaces) { context.skip(); return; }
    const { root } = await fixture(), worker = await linux({ projectRoot: root, initialSnapshot: undefined });
    expect(worker.capabilities).toEqual({ filesystem: true, commands: true, sandbox: 'bubblewrap' });
    expect(await worker.executeTool('worker_read', { path: 'src/a.ts' }, signal())).toMatchObject({ content: 'export const a = 3; // dirty\n' });
    process.env.GRUNT_FIXTURE_SECRET = 'private-env-fixture';
    try {
      const script = `const fs=require('fs');for(const p of ${JSON.stringify([join(root, '.env'), join(root, '.git/config'), '/workspace/.git', '/source', '/home/alan/.ssh'])}){if(fs.existsSync(p))throw Error('host path visible');}if(process.env.GRUNT_FIXTURE_SECRET)throw Error('env leaked');console.log(process.env.HOME);console.log(fs.readFileSync('/workspace/node_modules/fixture.txt','utf8'));`;
      expect(await worker.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote(script) }, signal())).toMatchObject({ ok: true, stdout: '/home/worker\nreadonly dependency\n' });
    } finally { delete process.env.GRUNT_FIXTURE_SECRET; }
    expect(await readdir(worker.path)).not.toContain('.git'); expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain('3; // dirty');
  }, 15000);
  it('rejects a replaced registered project before capture and portable snapshots avoid original identity reads', async context => {
    const portable = await workspace({ projectIdentity: hash('registered inode') });
    expect(await portable.artifact()).toMatchObject({ complete: true, files: [] });
    if (!namespaces) { context.skip(); return; }
    const { root } = await fixture(), stat = await lstat(root), projectIdentity = hash(`${stat.dev}:${stat.ino}`);
    await rename(root, root + '-original'); roots.push(root + '-original'); await mkdir(root); await writeFile(join(root, 'secret'), 'replacement');
    await expect(linux({ projectRoot: root, projectIdentity, initialSnapshot: undefined })).rejects.toMatchObject({ code: 'invalid_workspace' });
  }, 10000);
  it('rejects project replacement after capture before any dependencies or workspace are returned', async context => {
    if (!namespaces) { context.skip(); return; }
    const { root } = await fixture(), stat = await lstat(root), projectIdentity = hash(`${stat.dev}:${stat.ino}`);
    const original = WorkerSandbox.prototype.snapshot;
    const mocked = vi.spyOn(WorkerSandbox.prototype, 'snapshot').mockImplementation(async function(...args) {
      const result = await original.apply(this, args);
      await rename(root, root + '-original'); roots.push(root + '-original'); await mkdir(root);
      return result;
    });
    try { await expect(linux({ projectRoot: root, projectIdentity, initialSnapshot: undefined })).rejects.toMatchObject({ code: 'invalid_workspace' }); }
    finally { mocked.mockRestore(); }
  }, 10000);
  it('keeps dependency directory inode pinned when its pathname becomes a vault symlink', async context => {
    if (!namespaces) { context.skip(); return; }
    const { root } = await fixture(), vault = await directory(); await writeFile(join(vault, 'secret.txt'), 'must never be mounted');
    const original = WorkerSandbox.prototype.copyDependencies;
    const mocked = vi.spyOn(WorkerSandbox.prototype, 'copyDependencies').mockImplementation(async function(...args) {
      const handle = await original.apply(this, args);
      await rename(join(root, 'node_modules'), join(root, 'node_modules-old')); await symlink(vault, join(root, 'node_modules'));
      return handle;
    });
    try {
      const worker = await linux({ projectRoot: root, initialSnapshot: undefined });
      const script = "const fs=require('fs');if(fs.existsSync('node_modules/secret.txt'))throw Error('vault mounted');for(const d of ['/workspace/node_modules',...fs.readdirSync('/proc/self/fd').map(f=>'/proc/self/fd/'+f)]){try{if(fs.existsSync(d+'/fixture.txt')){fs.writeFileSync(d+'/fixture.txt','LEAK');throw Error('writable dependency FD')}}catch(e){if(e.message==='writable dependency FD')throw e;}}console.log(fs.readFileSync('node_modules/fixture.txt','utf8'))";
      expect(await worker.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote(script) }, signal())).toMatchObject({ ok: true, stdout: 'readonly dependency\n' });
    } finally { mocked.mockRestore(); }
  }, 10000);
  it('sanitizes dependency secrets and sockets while preserving safe internal package links', async context => {
    if (!namespaces) { context.skip(); return; }
    const { root } = await fixture(), deps = join(root, 'node_modules');
    await writeFile(join(deps, '.env'), 'PRIVATE_DEP_CREDENTIAL'); await writeFile(join(deps, 'credentials-prod.json'), 'PRIVATE_DEP_CREDENTIAL');
    await mkdir(join(deps, 'pkg')); await writeFile(join(deps, 'pkg/index.js'), 'safe package'); await mkdir(join(deps, '.bin')); await symlink('../pkg/index.js', join(deps, '.bin/tool'));
    const server = unixServer(); await new Promise<void>(resolve => server.listen(join(deps, 'service.sock'), resolve));
    try {
      const worker = await linux({ projectRoot: root, initialSnapshot: undefined }); expect(worker.dependencyStatus).toMatchObject({ available: true });
      const script = "const fs=require('fs');for(const p of ['.env','credentials-prod.json','service.sock'])if(fs.existsSync('node_modules/'+p))throw Error('private dependency copied');console.log(fs.readFileSync('node_modules/.bin/tool','utf8'))";
      expect(await worker.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote(script) }, signal())).toMatchObject({ ok: true, stdout: 'safe package\n' });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 10000);
  it('retains safe namespace snapshots but withholds commands when resource limits cannot be enforced', async context => {
    if (!namespaces) { context.skip(); return; }
    const mocked = vi.spyOn(resources, 'probeWorkerResources').mockResolvedValue(false);
    try {
      const { root } = await fixture(), worker = await linux({ projectRoot: root, initialSnapshot: undefined });
      expect(worker.capabilities).toEqual({ filesystem: true, commands: false, sandbox: 'bubblewrap' });
      expect(await worker.executeTool('worker_read', { path: 'src/a.ts' }, signal())).toMatchObject({ ok: true });
      expect(await worker.executeTool('worker_command', { command: 'echo forbidden' }, signal())).toMatchObject({ ok: false, code: 'unsupported_sandbox' });
    } finally { mocked.mockRestore(); }
  }, 10000);
  it('denies network access including the trusted parent localhost listener', async context => {
    if (!namespaces) { context.skip(); return; }
    const server = createServer((_request, response) => response.end('private-parent'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture listener');
      const worker = await linux(), script = `const net=require('net');const s=net.connect({host:'127.0.0.1',port:${address.port}});s.on('connect',()=>{console.log('LEAK');process.exit(1)});s.on('error',()=>console.log('denied'));setTimeout(()=>process.exit(2),1000).unref();`;
      expect(await worker.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote(script) }, signal())).toMatchObject({ ok: true, stdout: 'denied\n' });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 10000);
  it('rejects unowned command changes, tolerates new generated output, and never hides baseline changes', async context => {
    if (!namespaces) { context.skip(); return; }
    const worker = await linux({ initialSnapshot: [{ path: 'src/a.ts', content: 'old' }, { path: 'dist/tracked.js', content: 'tracked generated' }] });
    expect(await worker.executeTool('worker_command', { command: 'mkdir -p dist; echo generated > dist/new.js; echo good > src/a.ts' }, signal())).toMatchObject({ ok: true });
    expect(await worker.artifact()).toMatchObject({ complete: true, files: [{ path: 'src/a.ts', content: 'good\n' }] });
    expect(await worker.executeTool('worker_command', { command: 'echo bad > dist/tracked.js' }, signal())).toMatchObject({ ok: false, code: 'ownership_violation' });
    expect(await worker.artifact()).toMatchObject({ complete: false });
  }, 10000);
  it('exports binary changes canonically and rejects created symlinks as unsafe', async context => {
    if (!namespaces) { context.skip(); return; }
    const worker = await linux();
    expect(await worker.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote("require('fs').writeFileSync('src/asset.bin',Buffer.from([0,255,1]))") }, signal())).toMatchObject({ ok: true });
    const binary = (await worker.artifact()).files.find(file => file.path === 'src/asset.bin'); expect(binary).toMatchObject({ binary: true, content: 'AP8B', afterSha256: hash(Buffer.from([0, 255, 1])) });
    expect(await worker.executeTool('worker_command', { command: 'ln -s /etc/passwd src/link' }, signal())).toMatchObject({ ok: false, code: 'ownership_violation' });
    expect(await worker.executeTool('worker_read', { path: 'src/link' }, signal())).toMatchObject({ ok: false }); expect(await worker.artifact()).toMatchObject({ complete: false });
  }, 10000);
  it('kills cancelled command descendants and preserves completed private edits', async context => {
    if (!namespaces) { context.skip(); return; }
    const worker = await linux(), controller = new AbortController();
    const operation = worker.executeTool('worker_command', { command: 'echo partial > src/a.ts; (sleep 2; echo escaped > src/descendant) & wait' }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 300)); controller.abort(new Error('cancel sandbox fixture'));
    await expect(operation).rejects.toThrow('cancel sandbox fixture');
    await new Promise(resolve => setTimeout(resolve, 2200)); await expect(access(join(worker.path, 'src/descendant'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await worker.artifact()).toMatchObject({ complete: true, files: [{ path: 'src/a.ts', content: 'partial\n' }] });
  }, 10000);
  it('enforces aggregate workspace growth and per-file disk bounds', async context => {
    if (!namespaces) { context.skip(); return; }
    const worker = await linux({ limits: { maxWorkspaceBytes: 4096, maxFileBytes: 8192 } });
    expect(await worker.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote("require('fs').writeFileSync('src/large',Buffer.alloc(5000));setTimeout(()=>{},10000)"), timeoutSeconds: 5 }, signal())).toMatchObject({ ok: false, code: 'workspace_limit' });
    const unboundDeps = await linux({ limits: { maxWorkspaceBytes: 4096, maxFileBytes: 8192 } });
    expect(await unboundDeps.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote("require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/growth',Buffer.alloc(5000));setTimeout(()=>{},10000)"), timeoutSeconds: 5 }, signal())).toMatchObject({ ok: false, code: 'workspace_limit' });
    const separate = await linux({ limits: { maxFileBytes: 4096 } });
    expect(await separate.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote("require('fs').writeFileSync('src/large',Buffer.alloc(8192))") }, signal())).toMatchObject({ ok: false });
  }, 10000);
  it('bounds command time and output and keeps review snapshots read-only', async context => {
    if (!namespaces) { context.skip(); return; }
    const worker = await linux({ limits: { maxOutputBytes: 64 } });
    expect(await worker.executeTool('worker_command', { command: 'sleep 10', timeoutSeconds: 1 }, signal())).toMatchObject({ ok: false, code: 'timeout' });
    const output = await worker.executeTool('worker_command', { command: '/opt/grunt/node -e ' + quote("process.stdout.write('x'.repeat(200))") }, signal());
    expect(output).toMatchObject({ ok: true, stdout: 'x'.repeat(64), truncated: true });
    const review = await linux({ readOnly: true, ownedPaths: [] }); expect(await review.executeTool('worker_command', { command: 'echo changed > src/a.ts' }, signal())).toMatchObject({ ok: false });
    expect(await review.artifact()).toMatchObject({ complete: true, files: [] });
  }, 15000);
});
