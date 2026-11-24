import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireExecutionHostLease, createPublicationFileChannel, executionHostCommand, executionHostExec, executionHostPolicy, loadExecutionHostChannels, loadExecutionHostPolicy, openExecutionHost } from './efficiency-host.js';
import type { ExecutionHostPolicy, HostExec } from './efficiency-host.js';
import { createVerificationBrokerFileClient } from './verification-broker-client.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8' }).trim();
/** Appends `count` synthetic commits to the current branch in one fast-import pass; `secretAt` adds then removes a private path. */
function synthesizeHistory(projectRoot: string, count: number, secretAt?: number) {
  const branch = git(projectRoot, 'symbolic-ref', 'HEAD'); let stream = '';
  const commit = (index: number, change: string) => { const message = 'synthetic history ' + index; stream += `commit ${branch}\ncommitter Synthetic Fixture <synthetic@example.invalid> ${1700000000 + index} +0000\ndata ${message.length}\n${message}\n${index === 0 ? 'from ' + branch + '^0\n' : ''}${change}\n`; };
  for (let i = 0; i < count; i++) {
    const body = 'history ' + i;
    commit(i, `M 100644 inline history/${i}.txt\ndata ${body.length}\n${body}\n` + (i === secretAt ? `M 100644 inline deep/nested/.netrc\ndata 9\nsynthetic\n` : i === (secretAt ?? -2) + 1 ? 'D deep/nested/.netrc\n' : ''));
  }
  execFileSync('/usr/bin/git', ['fast-import', '--quiet'], { cwd: projectRoot, input: stream });
  git(projectRoot, 'reset', '--hard', '--quiet');
}
async function fixture(options: { deletedSecret?: boolean; history?: number; secretAt?: number; maxScreenedCommits?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'grunt-host-synthetic-')); roots.push(root);
  const projectRoot = join(root, 'project'); await mkdir(projectRoot, { mode: 0o700 });
  git(projectRoot, 'init', '--initial-branch=main'); git(projectRoot, 'config', 'user.email', 'synthetic@example.invalid'); git(projectRoot, 'config', 'user.name', 'Synthetic Fixture');
  await writeFile(join(projectRoot, 'source.txt'), 'base'); await writeFile(join(projectRoot, '.gitignore'), 'dist/\nnode_modules\n');
  if (options.deletedSecret) await writeFile(join(projectRoot, '.netrc'), 'synthetic old secret fixture');
  git(projectRoot, 'add', '.'); git(projectRoot, 'commit', '-m', 'synthetic base'); const base = git(projectRoot, 'rev-parse', 'HEAD');
  git(projectRoot, 'checkout', '-b', 'grunt/fixture'); if (options.deletedSecret) git(projectRoot, 'rm', '.netrc'); await writeFile(join(projectRoot, 'source.txt'), 'candidate'); git(projectRoot, 'commit', '-am', 'synthetic candidate');
  if (options.history) synthesizeHistory(projectRoot, options.history, options.secretAt);
  const head = git(projectRoot, 'rev-parse', 'HEAD'), gitTree = git(projectRoot, 'rev-parse', 'HEAD^{tree}');
  await mkdir(join(projectRoot, 'dist')); await writeFile(join(projectRoot, 'dist/index.html'), 'synthetic page');
  const policy: ExecutionHostPolicy = { version: 1, projectRoot, stateDirectory: join(root, 'authority'), channelDirectory: join(root, 'channels'), workerPort: 8793,
    gitConfigSha256: createHash('sha256').update(await readFile(join(projectRoot, '.git/config'))).digest('hex'),
    plans: [{ version: 1, id: 'release', mode: 'release', checks: [{ id: 'tests', command: 'synthetic tests only', artifactPaths: ['dist'], timeoutSeconds: 10 }] }],
    sandboxArgv: ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--bind', '$WORKSPACE', '$PROJECT', '--chdir', '$PROJECT', '/bin/sh', '-lc', '$COMMAND'],
    publication: { version: 1, projectRoot, repository: 'synthetic/fixture', base: 'main', headPrefix: 'grunt/', requiredChecks: ['tests'], reviewPaths: ['source.txt'], artifactDirectory: 'dist', pagesBranch: 'gh-pages', allowMerge: true, allowDeploy: true, ...(options.maxScreenedCommits ? { maxScreenedCommits: options.maxScreenedCommits } : {}) } };
  const refs = new Map([['main', base], ['gh-pages', 'd'.repeat(40)]]), commits = new Map<string, Record<string, unknown>>([
    [head, { sha: head, tree: { sha: gitTree }, message: 'candidate' }], [base, { sha: base, tree: { sha: gitTree }, message: 'base' }], ['d'.repeat(40), { sha: 'd'.repeat(40), tree: { sha: gitTree }, message: 'old pages' }],
  ]);
  let counter = 10;
  const pr = () => ({ number: 7, html_url: 'https://github.com/synthetic/fixture/pull/7', state: 'open', draft: false, head: { sha: head, ref: 'grunt/fixture', repo: { full_name: policy.publication.repository } }, base: { ref: 'main', sha: base, repo: { full_name: policy.publication.repository } } });
  const mutations: string[] = [];
  const exec: HostExec = vi.fn(async (argv, options) => {
    if (argv[0] === '/usr/bin/git') {
      if (argv.includes('push')) { mutations.push('push'); return { code: 0, stdout: '' }; }
      return executionHostExec(argv, options);
    }
    expect(argv[0]).toBe('/usr/bin/gh'); const method = argv[3], path = argv[4]!.slice(('repos/' + policy.publication.repository).length), body = options.input ? JSON.parse(options.input) as Record<string, unknown> : undefined;
    if (method !== 'GET') mutations.push(method + ' ' + path);
    let result: unknown;
    if (!path) result = { full_name: policy.publication.repository, private: false, archived: false };
    else if (path.startsWith('/compare/')) result = { status: path.includes('/compare/' + base) ? 'ahead' : 'behind' };
    else if (path.startsWith('/git/ref/heads/')) result = { object: { sha: refs.get(path.slice('/git/ref/heads/'.length)) } };
    else if (path.startsWith('/git/commits/') && method === 'GET') result = commits.get(path.slice('/git/commits/'.length));
    else if (path === '/git/commits' && method === 'POST') { const id = (++counter).toString(16).padStart(40, '0'); result = { ...body, tree: { sha: body!.tree }, sha: id }; commits.set(id, result as Record<string, unknown>); }
    else if (path.startsWith('/git/refs/heads/') && method === 'PATCH') { const name = path.slice('/git/refs/heads/'.length), next = commits.get(String(body!.sha)); expect(body!.force).toBe(false); expect(next!.parents).toContain(refs.get(name)); refs.set(name, String(body!.sha)); result = { object: { sha: body!.sha } }; }
    else if (path.startsWith('/pulls?')) result = [pr()];
    else if (path === '/pulls/7') result = pr();
    else if (path === '/pages') result = { html_url: 'https://synthetic.github.io/fixture/', source: { branch: 'gh-pages', path: '/' } };
    else if (path === '/git/blobs') { expect(body!.content).toBe(Buffer.from('synthetic page').toString('base64')); result = { sha: (++counter).toString(16).padStart(40, '0') }; }
    else if (path === '/git/trees') result = { sha: (++counter).toString(16).padStart(40, '0') };
    else if (path === '/pages/builds' && method === 'POST') result = { status: 'queued' };
    else if (path === '/pages/builds?per_page=20') result = [{ commit: refs.get('gh-pages'), status: 'built' }];
    else throw new Error('Unexpected synthetic API ' + path);
    return { code: 0, stdout: JSON.stringify(result) };
  });
  const runner = vi.fn(async (request: { workspaceRoot: string; command: string }) => { expect(request.command).toBe('synthetic tests only'); expect(await readFile(join(request.workspaceRoot, 'source.txt'), 'utf8')).toBe('candidate'); expect(await readFile(join(request.workspaceRoot, 'dist/index.html'), 'utf8')).toBe('synthetic page'); expect(request.workspaceRoot.startsWith(policy.stateDirectory)).toBe(true); return { exitCode: 0 }; });
  return { root, projectRoot, policy, base, head, exec, runner, mutations };
}

it('composes a synthetic worker check, authenticated host evidence, builder-recorded review and exact GitData/Pages release end to end', async () => {
  const f = await fixture(), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  expect(f.exec).not.toHaveBeenCalled(); expect(f.runner).not.toHaveBeenCalled();
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot });
  await host.tick(); expect(await verification.result({ id: check.id }, { cwd: f.projectRoot })).toMatchObject({ state: 'completed', verified: false });
  expect(await host.broker.verifiedReceipt(check.id)).toMatchObject({ verified: true, head: f.head });
  const publication = createPublicationFileChannel({ version: 1, projectRoot: f.projectRoot, channelDirectory: f.policy.channelDirectory });
  const prepared = await publication.request('prepare', { head: f.head, branch: 'grunt/fixture', title: 'Synthetic release', body: 'Synthetic fixture only.', verificationIds: [check.id] }, { cwd: f.projectRoot }) as { id: string };
  await host.tick(); expect(await host.queue.status(prepared.id)).toMatchObject({ phase: 'awaiting_review' });
  await publication.request('advance', { id: prepared.id }, { cwd: f.projectRoot }); await host.tick(); expect(await host.queue.status(prepared.id)).toMatchObject({ phase: 'awaiting_review' });
  const gitTree = git(f.projectRoot, 'rev-parse', 'HEAD^{tree}');
  await publication.request('review-record', { id: prepared.id, head: f.head, gitTree, verdict: 'approve', summary: 'Self-review of the synthetic diff: no findings.' }, { cwd: f.projectRoot }); await host.tick();
  expect(await host.queue.status(prepared.id)).toMatchObject({ phase: 'ready' });
  expect(await readdir(join(f.policy.channelDirectory, 'publication-inbox'))).toEqual([]);
  for (const phase of ['pull_request', 'deploying', 'deployed']) { await publication.request('advance', { id: prepared.id }, { cwd: f.projectRoot }); await host.tick(); expect(await host.queue.status(prepared.id)).toMatchObject({ phase }); }
  expect(f.runner).toHaveBeenCalledTimes(1);
  const status = await publication.request('status', { id: prepared.id }, { cwd: f.projectRoot }); expect(status).toMatchObject({ phase: 'deployed', trusted: false, deploymentUrl: 'https://synthetic.github.io/fixture/' });
  expect(f.mutations).toContain('push'); expect(f.mutations).toContain('POST /pages/builds');
  expect(await readdir(f.policy.channelDirectory)).not.toContain('authority.key');
});

it('rejects writable policy, symlink manifests, authority mounts, arbitrary commands and unknown host fields', async () => {
  const f = await fixture();
  expect(() => executionHostPolicy({ ...f.policy, source: 'model-supplied' })).toThrow();
  expect(() => executionHostPolicy({ ...f.policy, sandboxArgv: [...f.policy.sandboxArgv, '--ro-bind', f.policy.stateDirectory, '/secrets'] })).toThrow();
  expect(() => executionHostPolicy({ ...f.policy, sandboxArgv: [...f.policy.sandboxArgv, '--ro-bind', '/', '/'] })).toThrow();
  expect(() => executionHostPolicy({ ...f.policy, sandboxArgv: ['/bin/sh', '-lc', '$COMMAND'] })).toThrow();
  const path = join(f.root, 'policy.json'); await writeFile(path, JSON.stringify(f.policy), { mode: 0o644 }); await expect(loadExecutionHostPolicy(path)).rejects.toThrow(); await chmod(path, 0o600); expect(await loadExecutionHostPolicy(path)).toEqual(f.policy);
  const manifest = join(f.root, 'channel.json'); await symlink(path, manifest); await expect(loadExecutionHostChannels(manifest)).rejects.toThrow();
});

it('does not accept forged verification authority from the worker channel or start checks for malformed intents', async () => {
  const f = await fixture(), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  const id = randomUUID(); await writeFile(join(f.policy.channelDirectory, 'verification-inbox', id + '.json'), JSON.stringify({ version: 1, id, command: 'arbitrary host shell' }), { mode: 0o600 });
  const fake = randomUUID(); await writeFile(join(f.policy.channelDirectory, 'verification-results', fake + '.json'), JSON.stringify({ version: 1, id: fake, verified: true, head: f.head, state: 'completed' }), { mode: 0o600 });
  const channel = createPublicationFileChannel({ version: 1, projectRoot: f.projectRoot, channelDirectory: f.policy.channelDirectory });
  const queued = await channel.request('prepare', { head: f.head, branch: 'grunt/fixture', title: 'Synthetic forged proof', body: 'Fixture', verificationIds: [fake] }, { cwd: f.projectRoot }) as { id: string };
  await host.tick(); expect(f.runner).not.toHaveBeenCalled(); expect(await host.queue.status(queued.id)).toMatchObject({ phase: 'blocked', reason: 'verification_required' }); expect(f.mutations).toEqual([]);
});

it('pins Git configuration before any publication capture or credential execution', async () => {
  const f = await fixture(), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  git(f.projectRoot, 'config', 'url.https://synthetic.invalid/.insteadOf', 'https://github.com/');
  await expect(host.queue.prepare({ head: f.head, branch: 'grunt/fixture', title: 'Fixture', body: 'Fixture', verificationIds: [randomUUID()] })).rejects.toThrow('configuration changed');
  expect(f.exec).not.toHaveBeenCalled(); expect(f.mutations).toEqual([]);
});

it('awaits a pending synthetic verification in one-shot mode and stops a managed daemon without dropping work', async () => {
  const f = await fixture(); let started!: () => void, finish!: () => void;
  const beginning = new Promise<void>(done => { started = done; }), ending = new Promise<void>(done => { finish = done; });
  const runner = vi.fn(async (request: { signal: AbortSignal }) => { started(); await Promise.race([ending, new Promise<void>(done => request.signal.addEventListener('abort', () => done(), { once: true }))]); return { exitCode: 0 }; });
  const host = await openExecutionHost(f.policy, { exec: f.exec, runner });
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); let settled = false;
  const tick = host.tick().then(() => { settled = true; }); await beginning; expect(settled).toBe(false); finish(); await tick; expect(settled).toBe(true);
  const controller = new AbortController(); const serve = host.serve(controller.signal); controller.abort(); await serve;
});


it('refuses mutable config includes and fails closed before any release work', async () => {
  const f = await fixture();
  await writeFile(join(f.projectRoot, '.git/extra'), '[url "https://synthetic.invalid/"]\n insteadOf = https://github.com/\n');
  git(f.projectRoot, 'config', 'include.path', 'extra');
  f.policy.gitConfigSha256 = createHash('sha256').update(await readFile(join(f.projectRoot, '.git/config'))).digest('hex');
  const host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  await expect(host.queue.prepare({ head: f.head, branch: 'grunt/fixture', title: 'Fixture', body: 'Fixture', verificationIds: [randomUUID()] })).rejects.toThrow('execution-sensitive');
  expect(f.mutations).toEqual([]);
});

it('rejects private committed filenames before contacting Github', async () => {
  const f = await fixture(); await writeFile(join(f.projectRoot, '.netrc'), 'synthetic secret fixture'); git(f.projectRoot, 'add', '.netrc'); git(f.projectRoot, 'commit', '-m', 'synthetic secret guard');
  const host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  await expect(host.queue.prepare({ head: git(f.projectRoot, 'rev-parse', 'HEAD'), branch: 'grunt/fixture', title: 'Fixture', body: 'Fixture', verificationIds: [randomUUID()] })).rejects.toThrow('Private-looking');
  expect(f.mutations).toEqual([]);
  expect((f.exec as ReturnType<typeof vi.fn>).mock.calls.some(call => call[0][0] === '/usr/bin/gh')).toBe(false);
});

it('keeps host authority intact when writable publication directories are swapped while a review is recorded', async () => {
  const f = await fixture(); let swapped = false;
  const exec: HostExec = async (argv, options) => {
    if (!swapped && argv[0] === '/usr/bin/git' && argv.includes('diff')) {
      swapped = true;
      for (const child of ['publication-results', 'releases']) {
        await rename(join(f.policy.channelDirectory, child), join(f.policy.channelDirectory, child + '-held'));
        await symlink(join(f.policy.stateDirectory, 'publication'), join(f.policy.channelDirectory, child));
      }
    }
    return f.exec(argv, options);
  };
  const host = await openExecutionHost(f.policy, { exec, runner: f.runner });
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  const channel = createPublicationFileChannel({ version: 1, projectRoot: f.projectRoot, channelDirectory: f.policy.channelDirectory });
  const request = await channel.request('prepare', { head: f.head, branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [check.id] }, { cwd: f.projectRoot }) as { id: string }; await host.tick();
  await channel.request('review-record', { id: request.id, head: f.head, gitTree: git(f.projectRoot, 'rev-parse', 'HEAD^{tree}'), verdict: 'approve', summary: 'Synthetic self-review.' }, { cwd: f.projectRoot }); await host.tick();
  expect(swapped).toBe(true);
  expect(await host.queue.status(request.id)).toMatchObject({ phase: 'ready' });
  const protectedRecord = JSON.parse(await readFile(join(f.policy.stateDirectory, 'publication', request.id + '.json'), 'utf8'));
  expect(protectedRecord.review).toMatchObject({ source: 'builder', verdict: 'approve' }); expect(protectedRecord.snapshot.head).toBe(f.head);
  expect(await readdir(join(f.policy.stateDirectory, 'publication'))).toEqual([request.id + '.json']);
});

it('rejects a malformed or mismatched review-record request without changing the release', async () => {
  const f = await fixture(), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  const channel = createPublicationFileChannel({ version: 1, projectRoot: f.projectRoot, channelDirectory: f.policy.channelDirectory });
  const prepared = await channel.request('prepare', { head: f.head, branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [check.id] }, { cwd: f.projectRoot }) as { id: string }; await host.tick();
  const results = join(f.policy.channelDirectory, 'publication-results'), gitTree = git(f.projectRoot, 'rev-parse', 'HEAD^{tree}');
  const send = async (input: unknown) => { const queued = await channel.request('review-record', input, { cwd: f.projectRoot }) as { requestId: string }; await host.tick(); return JSON.parse(await readFile(join(results, queued.requestId + '.json'), 'utf8')); };
  await expect(channel.request('review-record', { id: prepared.id }, { cwd: f.projectRoot })).rejects.toThrow();
  expect(await send({ id: prepared.id, head: f.base, gitTree, verdict: 'approve', summary: 'Wrong commit.' })).toMatchObject({ state: 'failed', code: 'review_not_recorded' });
  expect(await send({ id: prepared.id, head: f.head, gitTree: f.base, verdict: 'approve', summary: 'Wrong tree.' })).toMatchObject({ state: 'failed', code: 'review_not_recorded' });
  expect(await send({ id: randomUUID(), head: f.head, gitTree, verdict: 'approve', summary: 'Unknown release.' })).toMatchObject({ state: 'failed', code: 'review_not_recorded' });
  expect(await host.queue.status(prepared.id)).toMatchObject({ phase: 'awaiting_review' });
  expect(await send({ id: prepared.id, head: f.head, gitTree, verdict: 'changes_requested', summary: 'Synthetic finding.' })).toMatchObject({ state: 'completed', release: { phase: 'blocked', reason: 'changes_requested' } });
  expect(f.mutations).toEqual([]);
});

it('recovers a dead process lease, refuses a live owner and preserves private evidence', async () => {
  const f = await fixture(); await mkdir(f.policy.stateDirectory, { mode: 0o700 });
  const retained = join(f.policy.stateDirectory, 'retained.json'); await writeFile(retained, 'synthetic retained evidence', { mode: 0o600 });
  await writeFile(join(f.policy.stateDirectory, 'host.lock'), JSON.stringify({ ownerPid: 2147483647, token: randomUUID(), startTicks: '1' }), { mode: 0o600 });
  const release = await acquireExecutionHostLease(f.policy.stateDirectory);
  await expect(acquireExecutionHostLease(f.policy.stateDirectory)).rejects.toThrow('live owner');
  expect(await readFile(retained, 'utf8')).toBe('synthetic retained evidence'); await release();
  const releases = await Promise.allSettled([acquireExecutionHostLease(f.policy.stateDirectory), acquireExecutionHostLease(f.policy.stateDirectory)]);
  expect(releases.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  for (const result of releases) if (result.status === 'fulfilled') await result.value();
});

it('supports the public finite tick CLI without starting external work', async () => {
  const f = await fixture(), path = join(f.root, 'policy.json'); await writeFile(path, JSON.stringify(f.policy), { mode: 0o600 });
  await executionHostCommand(['tick', '--config', path]);
  expect(await readdir(f.policy.stateDirectory)).not.toContain('host.lock');
  await expect(executionHostCommand(['nonsense', '--config', path])).rejects.toThrow('Usage:');
  expect(() => executionHostPolicy({ ...f.policy, plans: [f.policy.plans[0], { ...f.policy.plans[0], id: 'weaker' }] })).toThrow('unique');
});


it('rejects a review of a candidate whose changed paths include a deleted private file', async () => {
  const f = await fixture({ deletedSecret: true }), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  const request = await host.queue.prepare({ head: f.head, branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [check.id] });
  git(f.projectRoot, 'replace', f.base, f.head); expect(git(f.projectRoot, 'diff', f.base, f.head)).toBe('');
  const review = { id: request.id, head: f.head, gitTree: git(f.projectRoot, 'rev-parse', 'HEAD^{tree}'), verdict: 'approve' as const, summary: 'Synthetic self-review.' };
  await expect(host.queue.recordReview(request.id, review)).rejects.toThrow('Private-looking changed paths');
  expect(await host.queue.status(request.id)).toMatchObject({ phase: 'awaiting_review' }); expect(f.mutations).toEqual([]);
});

it('keeps explicit requests pending under startup hold and exposes local health without invoking checks', async () => {
  const f = await fixture(), hold = join(f.root, 'startup-hold'); f.policy.holdFiles = [hold]; await writeFile(hold, 'synthetic hold', { mode: 0o600 });
  const host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  expect(JSON.parse(await readFile(join(f.policy.stateDirectory, 'health.json'), 'utf8'))).toMatchObject({ state: 'held', pid: process.pid });
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const queued = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  expect(f.runner).not.toHaveBeenCalled(); expect(f.exec).not.toHaveBeenCalled(); expect(await readdir(join(f.policy.channelDirectory, 'verification-inbox'))).toContain(queued.id + '.json');
  await rm(hold); await host.tick(); expect(f.runner).toHaveBeenCalledTimes(1); expect(await host.broker.verifiedReceipt(queued.id)).toMatchObject({ verified: true });
});

it('substitutes only trusted check argv into the isolated workspace and omits host credentials from the runner environment', async () => {
  const f = await fixture(); let workspace = '';
  const exec: HostExec = async (argv, options) => {
    if (argv[0] !== '/usr/bin/bwrap') return f.exec(argv, options);
    workspace = options.cwd!;
    expect(argv).toContain(workspace); expect(argv).toContain(f.projectRoot); expect(argv.at(-1)).toBe('synthetic tests only');
    expect(options.environment).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
    expect(workspace.startsWith(join(f.policy.stateDirectory, 'verification/snapshots/'))).toBe(true);
    expect(argv).not.toContain(join(f.policy.stateDirectory, 'verification/authority.key'));
    return { code: 0, stdout: '' };
  };
  const host = await openExecutionHost(f.policy, { exec });
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  expect(workspace).not.toBe(''); expect(await host.broker.verifiedReceipt(check.id)).toMatchObject({ verified: true });
});


it('pins dependency directories before bwrap so a worker symlink swap cannot expose host authority', async () => {
  const f = await fixture(), dependency = join(f.projectRoot, 'node_modules'); await mkdir(dependency); await writeFile(join(dependency, 'marker'), 'synthetic dependency');
  f.policy.sandboxArgv.splice(5, 0, '--ro-bind', dependency, dependency);
  let pinned = false;
  const guardedExec: HostExec = async (argv, options) => {
    if (argv[0] !== '/usr/bin/bwrap') return f.exec(argv, options);
    const position = argv.indexOf('--ro-bind-fd'); expect(argv[position + 1]).toBe('3'); expect(argv[position + 2]).toBe(dependency);
    await rename(dependency, join(f.root, 'dependency-held')); await symlink(f.policy.stateDirectory, dependency);
    const fd = options.descriptors![0]!; expect(await readFile('/proc/self/fd/' + fd + '/marker', 'utf8')).toBe('synthetic dependency');
    await expect(readFile('/proc/self/fd/' + fd + '/verification/authority.key')).rejects.toThrow(); pinned = true;
    return { code: 0, stdout: '' };
  };
  const host = await openExecutionHost(f.policy, { exec: guardedExec });
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  expect(pinned).toBe(true); expect(await host.broker.verifiedReceipt(check.id)).toMatchObject({ verified: true });
});

it('awaits group escalation after a redirected descendant ignores TERM and its parent exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-host-cancellation-')); roots.push(root); const marker = join(root, 'descendant.pid');
  const controller = new AbortController();
  const running = executionHostExec(['/bin/sh', '-c', 'sh -c \'trap "" TERM; echo $$ > "$1"; exec sleep 30\' child "$1" >/dev/null 2>&1 & wait', 'parent', marker], { signal: controller.signal, timeoutMs: 5000 });
  for (let retry = 0; retry < 100; retry++) { try { await readFile(marker); break; } catch { await new Promise(done => setTimeout(done, 10)); } }
  const pid = Number(await readFile(marker, 'utf8')); controller.abort(); await running;
  let live = false;
  try { const stat = await readFile('/proc/' + pid + '/stat', 'utf8'); live = stat.split(') ').at(-1)!.split(' ')[0] !== 'Z'; } catch { /* process already reaped */ }
  expect(live).toBe(false);
});


it('rejects private files in newly reachable intermediate commits even when removed from the candidate', async () => {
  const f = await fixture();
  await writeFile(join(f.projectRoot, '.netrc'), 'synthetic historical secret'); git(f.projectRoot, 'add', '.netrc'); git(f.projectRoot, 'commit', '-m', 'synthetic intermediate secret');
  git(f.projectRoot, 'rm', '.netrc'); git(f.projectRoot, 'commit', '-m', 'synthetic remove secret');
  const head = git(f.projectRoot, 'rev-parse', 'HEAD'), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  expect(git(f.projectRoot, 'ls-tree', '-r', '--name-only', head)).not.toContain('.netrc');
  await expect(host.queue.prepare({ head, branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [randomUUID()] })).rejects.toThrow('Private-looking');
  expect(f.mutations).toEqual([]);
});

it('ignores grafted ancestry when the local candidate does not contain the pinned public base', async () => {
  const f = await fixture(); git(f.projectRoot, 'checkout', '--orphan', 'grunt/orphan'); git(f.projectRoot, 'commit', '-m', 'synthetic unrelated candidate');
  const head = git(f.projectRoot, 'rev-parse', 'HEAD'); await writeFile(join(f.projectRoot, '.git/info/grafts'), head + ' ' + f.base + '\n');
  expect(git(f.projectRoot, 'merge-base', '--is-ancestor', f.base, head)).toBe('');
  const host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  await expect(host.queue.prepare({ head, branch: 'grunt/orphan', title: 'Synthetic release', body: 'Fixture', verificationIds: [randomUUID()] })).rejects.toThrow('current base');
  expect(f.mutations).toEqual([]);
});

it('runs a real isolated synthetic bwrap check with inherited readonly mount descriptors', async () => {
  const f = await fixture();
  f.policy.sandboxArgv.splice(5, 0, '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  f.policy.plans[0]!.checks[0]!.command = 'read content < source.txt; test "$content" = candidate';
  const host = await openExecutionHost(f.policy);
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  expect(await host.broker.verifiedReceipt(check.id)).toMatchObject({ verified: true });
});


it.each(['/dev/null', '/tmp/synthetic-custom-hooks', '/dev/null\n'])('accepts pinned core.hooksPath only with the exact safe value: %j', async hooksPath => {
  const f = await fixture(); git(f.projectRoot, 'config', 'core.hooksPath', hooksPath);
  f.policy.gitConfigSha256 = createHash('sha256').update(await readFile(join(f.projectRoot, '.git/config'))).digest('hex');
  const host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  const request = { head: f.head, branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [randomUUID()] };
  if (hooksPath === '/dev/null') expect(await host.queue.prepare(request)).toMatchObject({ phase: 'blocked', reason: 'verification_required' });
  else await expect(host.queue.prepare(request)).rejects.toThrow('execution-sensitive');
  expect(f.mutations).toEqual([]);
});

async function release(f: Awaited<ReturnType<typeof fixture>>, host: Awaited<ReturnType<typeof openExecutionHost>>) {
  const verification = createVerificationBrokerFileClient({ projectRoot: f.projectRoot, inboxDirectory: join(f.policy.channelDirectory, 'verification-inbox'), resultDirectory: join(f.policy.channelDirectory, 'verification-results') });
  const check = await verification.start({ planId: 'release', checkId: 'tests' }, { cwd: f.projectRoot }); await host.tick();
  const head = git(f.projectRoot, 'rev-parse', 'HEAD');
  return { head, request: { head, branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [check.id] } };
}

it('screens a long unpublished history in one pass and still releases it after a builder-recorded review', async () => {
  const f = await fixture({ history: 320 }), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  expect(Number(git(f.projectRoot, 'rev-list', '--count', 'HEAD', '^' + f.base))).toBeGreaterThan(300);
  const { head, request } = await release(f, host);
  const prepared = await host.queue.prepare(request);
  expect(prepared).toMatchObject({ phase: 'awaiting_review', head });
  const review = { id: prepared.id, head, gitTree: git(f.projectRoot, 'rev-parse', 'HEAD^{tree}'), verdict: 'approve' as const, summary: 'Synthetic self-review of a long history.' };
  expect(await host.queue.recordReview(prepared.id, review)).toMatchObject({ phase: 'ready' });
  expect(await host.queue.advance(prepared.id)).toMatchObject({ phase: 'pull_request' });
  expect(f.mutations).toContain('push');
});

it('rejects a private path added and removed deep in a long unpublished history', async () => {
  const f = await fixture({ history: 320, secretAt: 40 }), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  expect(git(f.projectRoot, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.netrc');
  expect(git(f.projectRoot, 'log', '--all', '--format=', '--name-only', '--diff-filter=A')).toContain('deep/nested/.netrc');
  await expect(host.queue.prepare({ head: git(f.projectRoot, 'rev-parse', 'HEAD'), branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [randomUUID()] })).rejects.toThrow('Private-looking');
  expect(f.mutations).toEqual([]);
});

it('keeps a policy without maxScreenedCommits byte-identical and bounds the screened history only when configured', async () => {
  const plain = await fixture(), bounded = await fixture({ history: 120, maxScreenedCommits: 100 });
  expect(JSON.stringify(executionHostPolicy(JSON.parse(JSON.stringify(plain.policy))))).toBe(JSON.stringify(plain.policy));
  expect(JSON.stringify(executionHostPolicy(plain.policy).publication)).not.toContain('maxScreenedCommits');
  for (const bad of [0, -1, 1.5, 100001, '10', null]) expect(() => executionHostPolicy({ ...plain.policy, publication: { ...plain.policy.publication, maxScreenedCommits: bad } })).toThrow();
  const host = await openExecutionHost(bounded.policy, { exec: bounded.exec, runner: bounded.runner });
  await expect(host.queue.prepare({ head: git(bounded.projectRoot, 'rev-parse', 'HEAD'), branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [randomUUID()] })).rejects.toThrow('maxScreenedCommits');
});

it('tells the builder through release status why a release was refused, without leaking other errors', async () => {
  const f = await fixture({ history: 120, maxScreenedCommits: 100 }), host = await openExecutionHost(f.policy, { exec: f.exec, runner: f.runner });
  const publication = createPublicationFileChannel({ version: 1, projectRoot: f.projectRoot, channelDirectory: f.policy.channelDirectory });
  const request = { head: git(f.projectRoot, 'rev-parse', 'HEAD'), branch: 'grunt/fixture', title: 'Synthetic release', body: 'Fixture', verificationIds: [randomUUID()] };
  const refused = await publication.request('prepare', request, { cwd: f.projectRoot }) as { id: string }; await host.tick();
  expect(await publication.request('status', { id: refused.id }, { cwd: f.projectRoot })).toMatchObject({ phase: 'blocked', lastRequestError: 'release_not_advanced', lastRequestDetail: expect.stringContaining('maxScreenedCommits') });
  git(f.projectRoot, 'checkout', '--detach', '--quiet');
  const detached = await publication.request('prepare', request, { cwd: f.projectRoot }) as { id: string }; await host.tick();
  expect(await publication.request('status', { id: detached.id }, { cwd: f.projectRoot })).toMatchObject({ lastRequestDetail: expect.stringContaining('named branch') });
});
