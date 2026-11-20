import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VerificationBroker, parseVerificationBrokerRequest } from './verification-broker.js';
import type { VerificationBrokerRunner, VerificationBrokerRequest } from './verification-broker.js';
import { createVerificationBrokerFileClient, tickVerificationBroker } from './verification-broker-client.js';
import { captureVerificationState, signVerificationReceipt, verificationEnvironmentDigest } from './verification.js';
import type { VerificationPlan } from './verification.js';

const exec = promisify(execFile);
let root: string, project: string, authority: string;
const plan: VerificationPlan = { version: 1, id: 'publish', mode: 'release', checks: [{ id: 'unit', command: 'trusted synthetic unit command', timeoutSeconds: 5, artifactPaths: ['dist'] }] };
const environmentDigest = verificationEnvironmentDigest({ FIXTURE: 'synthetic' });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grunt-broker-')); project = join(root, 'project'); authority = join(root, 'authority');
  await mkdir(project, { mode: 0o700 }); await mkdir(join(project, 'dist')); await writeFile(join(project, 'input.txt'), 'original'); await writeFile(join(project, 'dist/play.txt'), 'built');
  await exec('git', ['init', '-q'], { cwd: project }); await exec('git', ['add', '.'], { cwd: project });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: project });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture(runner: VerificationBrokerRunner = async r => {
  expect(await readFile(join(r.workspaceRoot, 'input.txt'), 'utf8')).toBe('original');
  expect(r.command).toBe(plan.checks[0]!.command); expect(r.workspaceRoot).not.toBe(project);
  return { exitCode: 0 };
}) {
  const run = vi.fn(runner), broker = await VerificationBroker.open({ projectRoot: project, authorityDirectory: authority, plans: [plan], runner: run, environmentDigest });
  const state = await captureVerificationState(project);
  const request: VerificationBrokerRequest = { version: 1, id: randomUUID(), planId: plan.id, checkId: 'unit', expectedHead: state.head, expectedTreeDigest: state.treeDigest };
  return { broker, request, run };
}
it('executes a policy-pinned check against a private exact-head snapshot and signs host-only release authority', async () => {
  const f = await fixture(), result = await f.broker.run(f.request);
  expect(result.state).toBe('completed'); expect(result.receipt?.signature).toMatch(/^[a-f0-9]{64}$/); expect(f.run).toHaveBeenCalledTimes(1);
  expect((await f.broker.verifiedReceipt(f.request.id)).verified).toBe(true);
  expect((await f.broker.verifyPlan('publish', [f.request.id])).checkIds).toEqual(['unit']);
  expect(await readFile(join(project, 'input.txt'), 'utf8')).toBe('original');
  await expect(readFile(join(project, 'authority.key'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('never accepts model commands, unknown plans, or a different expected head/tree', async () => {
  const f = await fixture();
  expect(() => parseVerificationBrokerRequest({ ...f.request, command: 'forged command' })).toThrow();
  expect(() => f.broker.run({ ...f.request, planId: 'model-controlled' })).toThrow();
  const result = await f.broker.run({ ...f.request, expectedTreeDigest: 'f'.repeat(64) });
  expect(result.state).toBe('failed'); expect(f.run).not.toHaveBeenCalled(); await expect(f.broker.verifiedReceipt(f.request.id)).rejects.toThrow();
});
it('rejects dirty or ignored-artifact changes and never runs a mismatched release check', async () => {
  const f = await fixture(); await writeFile(join(project, 'input.txt'), 'modified');
  expect((await f.broker.run(f.request)).state).toBe('failed'); expect(f.run).not.toHaveBeenCalled();
});
it('authenticates receipts from protected host state, rejecting writable copied/forged authority', async () => {
  const f = await fixture(); await f.broker.run(f.request);
  const path = join(authority, 'requests', f.request.id, 'verification.json'), original = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...original, exitCode: 99 }));
  await expect(f.broker.verifiedReceipt(f.request.id)).rejects.toThrow();
});
it('does not reuse an authenticated check after source or artifact bytes change', async () => {
  const f = await fixture(); await f.broker.run(f.request); await writeFile(join(project, 'dist/play.txt'), 'different');
  await expect(f.broker.verifiedReceipt(f.request.id)).rejects.toThrow();
});
it('isolates execution from main-agent changes and invalidates a changed original checkout', async () => {
  const f = await fixture(async r => {
    await writeFile(join(project, 'input.txt'), 'concurrent main edit');
    expect(await readFile(join(r.workspaceRoot, 'input.txt'), 'utf8')).toBe('original');
    return { exitCode: 0 };
  });
  const result = await f.broker.run(f.request); expect(result.state).toBe('failed'); expect(result.code).toBe('inputs_changed');
  expect(result.receipt?.unchanged).toBe(false); expect(await readFile(join(project, 'input.txt'), 'utf8')).toBe('concurrent main edit');
});
it('never publishes a failed, interrupted, or throwing runner as success, without retaining raw errors', async () => {
  const f = await fixture(async () => { throw new Error('private upstream fixture-secret'); });
  const result = await f.broker.run(f.request); expect(result.state).toBe('failed'); expect(JSON.stringify(result)).not.toContain('fixture-secret');
  await expect(f.broker.verifiedReceipt(f.request.id)).rejects.toThrow();
});
it('records nonzero check exit codes as authenticated failures rather than release proof', async () => {
  const f = await fixture(async () => ({ exitCode: 7 })); const r = await f.broker.run(f.request);
  expect(r.state).toBe('failed'); expect(r.receipt?.exitCode).toBe(7); await expect(f.broker.verifiedReceipt(f.request.id)).rejects.toThrow();
});
it('is idempotent for concurrent duplicate requests and across broker instances', async () => {
  const f = await fixture(); const results = await Promise.all([f.broker.run(f.request), f.broker.run({ ...f.request })]);
  expect(results.map(r => r.state)).toEqual(['completed', 'completed']); expect(f.run).toHaveBeenCalledTimes(1);
  const again = await VerificationBroker.open({ projectRoot: project, authorityDirectory: authority, plans: [plan], runner: f.run, environmentDigest });
  expect((await again.run(f.request)).state).toBe('completed'); expect(f.run).toHaveBeenCalledTimes(1);
  await expect(again.run({ ...f.request, expectedHead: '1'.repeat(40) })).rejects.toThrow();
});
it('blocks changed trusted execution environment from reusing an old receipt', async () => {
  const f = await fixture(); await f.broker.run(f.request);
  const changed = await VerificationBroker.open({ projectRoot: project, authorityDirectory: authority, plans: [plan], runner: f.run, environmentDigest: 'a'.repeat(64) });
  await expect(changed.verifiedReceipt(f.request.id)).rejects.toThrow();
});
it('refuses exposed/symlinked authority, unsafe key permissions, and unsafe request paths', async () => {
  await expect(VerificationBroker.open({ projectRoot: project, authorityDirectory: join(project, 'authority'), plans: [plan], runner: async () => ({ exitCode: 0 }), environmentDigest })).rejects.toThrow();
  const f = await fixture(); await chmod(join(authority, 'authority.key'), 0o644);
  await expect(VerificationBroker.open({ projectRoot: project, authorityDirectory: authority, plans: [plan], runner: f.run, environmentDigest })).rejects.toThrow();
  await expect(f.broker.status('../escape')).rejects.toThrow();
  const alias = join(root, 'authority-alias'); await symlink(authority, alias);
  await expect(VerificationBroker.open({ projectRoot: project, authorityDirectory: alias, plans: [plan], runner: f.run, environmentDigest })).rejects.toThrow();
});
it('provides plan/check-only Pi file transport and authoritative finite host ticks', async () => {
  const f = await fixture(), channels = { projectRoot: project, inboxDirectory: join(root, 'inbox'), resultDirectory: join(root, 'results') };
  const client = createVerificationBrokerFileClient(channels), queued = await client.start({ planId: 'publish', checkId: 'unit' }, { cwd: project });
  expect((await client.status({ id: queued.id }, { cwd: project })).state).toBe('queued');
  const results = await tickVerificationBroker({ ...channels, broker: f.broker }); expect(results[0]?.state).toBe('completed');
  const result = await client.result({ id: queued.id }, { cwd: project }); expect(result.state).toBe('completed'); expect(result.verified).toBe(false);
  expect((await f.broker.verifiedReceipt(queued.id)).verified).toBe(true);
  expect(f.run).toHaveBeenCalledTimes(1); expect(await tickVerificationBroker({ ...channels, broker: f.broker })).toEqual([]);
});
it('rejects symlinked request files without following them or executing a check', async () => {
  const f = await fixture(), channels = { projectRoot: project, inboxDirectory: join(root, 'inbox'), resultDirectory: join(root, 'results') };
  await mkdir(channels.inboxDirectory, { mode: 0o700 }); await symlink(join(authority, 'authority.key'), join(channels.inboxDirectory, f.request.id + '.json'));
  expect(await tickVerificationBroker({ ...channels, broker: f.broker })).toEqual([]); expect(f.run).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(channels.resultDirectory, f.request.id + '.json'), 'utf8')).code).toBe('invalid_request');
  expect((await readFile(join(authority, 'authority.key'))).byteLength).toBe(32);
});
it('pins result directory descriptors while a worker renames its channel during execution', async () => {
  const channels = { projectRoot: project, inboxDirectory: join(root, 'inbox'), resultDirectory: join(root, 'results') };
  const f = await fixture(async () => { await rename(channels.resultDirectory, channels.resultDirectory + '-original'); await symlink(authority, channels.resultDirectory); return { exitCode: 0 }; });
  const client = createVerificationBrokerFileClient(channels), queued = await client.start({ planId: 'publish', checkId: 'unit' }, { cwd: project });
  expect((await tickVerificationBroker({ ...channels, broker: f.broker }))[0]?.state).toBe('completed');
  await expect(readFile(join(authority, queued.id + '.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(join(channels.resultDirectory + '-original', queued.id + '.json'), 'utf8')).state).toBe('completed');
});
it('does not mistake dot-prefixed project children for an authority outside the project', async () => {
  await expect(VerificationBroker.open({ projectRoot: project, authorityDirectory: join(project, '..authority'), plans: [plan], runner: async () => ({ exitCode: 0 }), environmentDigest })).rejects.toThrow();
});
it('executes a shared request once when two host broker instances receive it concurrently', async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { await pending; return { exitCode: 0 }; });
  const other = await VerificationBroker.open({ projectRoot: project, authorityDirectory: authority, plans: [plan], runner: f.run, environmentDigest });
  const first = f.broker.run(f.request); const second = other.run({ ...f.request });
  release();
  const results = await Promise.all([first, second]);
  expect(results.some(r => r.state === 'completed')).toBe(true); expect(f.run).toHaveBeenCalledTimes(1);
});
it('reconciles a dead host owner without rerunning its check or deleting its partial snapshot', async () => {
  const f = await fixture(), path = join(authority, 'requests', f.request.id);
  await mkdir(path); await writeFile(join(path, 'request.json'), JSON.stringify(f.request), { mode: 0o600 });
  await writeFile(join(path, 'status.json'), JSON.stringify({ version: 1, id: f.request.id, planId: 'publish', checkId: 'unit', state: 'running', ownerPid: 2147483647, ownerStartTicks: '1' }), { mode: 0o600 });
  const snapshot = join(authority, 'snapshots', f.request.id); await mkdir(snapshot); await writeFile(join(snapshot, 'partial'), 'preserve');
  const result = await f.broker.run(f.request); expect(result.state).toBe('failed'); expect(result.code).toBe('interrupted'); expect(f.run).not.toHaveBeenCalled();
  expect(await readFile(join(snapshot, 'partial'), 'utf8')).toBe('preserve');
});
it('recovers a completed authenticated receipt if the host exited before final status publication', async () => {
  const f = await fixture(); await f.broker.run(f.request);
  await writeFile(join(authority, 'requests', f.request.id, 'status.json'), JSON.stringify({ version: 1, id: f.request.id, planId: 'publish', checkId: 'unit', state: 'running', ownerPid: 2147483647, ownerStartTicks: '1' }));
  expect((await f.broker.status(f.request.id))?.state).toBe('completed'); expect((await f.broker.verifiedReceipt(f.request.id)).verified).toBe(true); expect(f.run).toHaveBeenCalledTimes(1);
});
it('prunes only old terminal host receipts that are not protected by pending publication', async () => {
  let now = Date.now(); const f = await fixture();
  const broker = await VerificationBroker.open({ projectRoot: project, authorityDirectory: authority, plans: [plan], runner: f.run, environmentDigest, now: () => now });
  await broker.run(f.request); now += 8 * 86400000;
  expect(await broker.prune([f.request.id])).toEqual({ removed: 0 }); expect(await broker.prune([])).toEqual({ removed: 1 });
  expect(await broker.status(f.request.id)).toBeUndefined();
});

it('rejects a worker-created FIFO result without waiting for a writer', async () => {
  const channels = { projectRoot: project, inboxDirectory: join(root, 'inbox'), resultDirectory: join(root, 'results') };
  const client = createVerificationBrokerFileClient(channels), queued = await client.start({ planId: 'publish', checkId: 'unit' }, { cwd: project });
  const path = join(channels.resultDirectory, queued.id + '.json'); await exec('mkfifo', ['-m', '600', path]);
  const pending = client.result({ id: queued.id }, { cwd: project }).then(() => 'accepted', () => 'rejected');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked'), 500); });
  const outcome = await Promise.race([pending, deadline]); if (timer) clearTimeout(timer);
  // If a regression blocks in open(), release it before asserting, so no worker/thread is abandoned.
  const release = await open(path, constants.O_RDWR | constants.O_NONBLOCK); await release.close(); await pending;
  expect(outcome).toBe('rejected');
});

it('rejects absent required artifacts both at execution and when authenticating a completed receipt', async () => {
  await rm(join(project, 'dist'), { recursive: true }); await exec('git', ['add', '-u'], { cwd: project });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'remove fixture artifacts'], { cwd: project });
  const f = await fixture(), result = await f.broker.run(f.request);
  expect(result.state).toBe('failed'); expect(result.receipt?.after.missingArtifacts).toEqual(['dist']);
  await expect(f.broker.verifiedReceipt(f.request.id)).rejects.toThrow();
  // Simulate authentic evidence from an older broker: host authentication must independently fail closed.
  const path = join(authority, 'requests', f.request.id);
  const legacy = signVerificationReceipt({ ...result.receipt!, state: 'completed' }, await readFile(join(authority, 'authority.key')));
  await writeFile(join(path, 'verification.json'), JSON.stringify(legacy), { mode: 0o600 });
  await writeFile(join(path, 'status.json'), JSON.stringify({ ...result, state: 'completed', receipt: undefined }), { mode: 0o600 });
  await expect(f.broker.verifiedReceipt(f.request.id)).rejects.toThrow();
});
