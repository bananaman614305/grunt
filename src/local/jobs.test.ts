import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { JobScheduler, createLocalJobRunner, jobEnvironment, jobsStateDirectory, parseJobInput, readJobResult, requestJobCancel } from './jobs.js';
import type { JobRunner, JobExecution } from './jobs.js';
const dirs: string[] = [], stores: JobScheduler[] = [];
let helper = '';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function directory() { const p = await mkdtemp(join(tmpdir(), 'grunt-jobs-test-')); dirs.push(p); return p; }
async function make(runner: JobRunner, extra: Partial<Parameters<typeof JobScheduler.open>[0]> = {}) {
  const root = await directory(); const store = await JobScheduler.open({ stateDirectory: root, sessionId: 'test-session', runner, ...extra }); stores.push(store); return { root, store };
}
function delayed() {
  const started: string[] = [], releases = new Map<string, () => void>();
  const runner: JobRunner = async request => { started.push(request.id); await new Promise<void>(resolve => { releases.set(request.id, resolve); request.signal.addEventListener('abort', () => resolve(), { once: true }); }); return { stdout: 'done', stderr: '', exitCode: 0 }; };
  return { started, releases, runner };
}
async function eventually(fn: () => Promise<boolean> | boolean, timeout = 4000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw Error('Condition did not complete'); await new Promise(r => setTimeout(r, 10)); } }
beforeAll(async () => {
  const p = await directory(); helper = join(p, 'jobs.js'); await writeFile(join(p, 'package.json'), '{"type":"module"}');
  const source = await readFile(new URL('./jobs.ts', import.meta.url), 'utf8');
  await writeFile(helper, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, { mode: 0o600 });
  const verification = await readFile(new URL('./verification.ts', import.meta.url), 'utf8');
  await writeFile(join(p, 'verification.js'), ts.transpileModule(verification, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, { mode: 0o600 });
});
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); vi.useRealTimers(); });
afterAll(async () => { await Promise.all(dirs.map(p => rm(p, { recursive: true, force: true }))); });

it('starts two tracked jobs without blocking main work, queues FIFO and collects results', async () => {
  const d = delayed(), { store, root } = await make(d.runner);
  const a = await store.start({ command: 'first', category: 'test' }, root), b = await store.start({ command: 'second' }, root), c = await store.start({ command: 'third' }, root);
  await eventually(() => d.started.length === 2);
  expect(store.snapshot().active).toHaveLength(2); expect(store.snapshot().queued.map(x => x.id)).toEqual([c.id]);
  expect((await store.result(a.id)).state).toBe('running');
  d.releases.get(a.id)!(); expect((await store.wait(a.id)).state).toBe('completed'); await eventually(() => d.started.length === 3);
  expect(d.started).toEqual([a.id, b.id, c.id]); d.releases.get(b.id)!(); d.releases.get(c.id)!();
  expect((await store.wait(c.id)).stdout).toBe('done');
});
it('serializes concurrent admission so a burst cannot bypass the queue bound', async () => {
  const d = delayed(), { store, root } = await make(d.runner);
  const starts = await Promise.allSettled(Array.from({ length: 22 }, () => store.start({ command: 'hold' }, root)));
  expect(starts.filter(x => x.status === 'fulfilled')).toHaveLength(18); expect(store.snapshot().active).toHaveLength(2); expect(store.snapshot().queued).toHaveLength(16);
});
it('cancels queued jobs without executing them and leaves unrelated active jobs alone', async () => {
  const d = delayed(), { store, root } = await make(d.runner, { maxActive: 1 });
  const a = await store.start({ command: 'first' }, root), b = await store.start({ command: 'never start' }, root);
  await eventually(() => d.started.length === 1); expect(store.cancel(b.id).state).toBe('cancelled'); expect((await store.result(b.id)).code).toBe('cancelled');
  expect(d.started).toEqual([a.id]); d.releases.get(a.id)!(); await store.wait(a.id); expect(d.started).toEqual([a.id]);
});
it('persists private metadata without commands, paths or command output', async () => {
  const privateText = 'private-command-and-output', { store, root } = await make(async () => ({ stdout: privateText, stderr: '', exitCode: 0 }));
  const job = await store.start({ command: privateText, category: 'build' }, root); await store.wait(job.id); await store.flush();
  const path = join(store.directory, 'snapshot.json'), snapshot = await readFile(path, 'utf8'), receipt = await readFile(join(store.directory, 'jobs', job.id, 'receipt.json'), 'utf8');
  expect(snapshot + receipt).not.toContain(privateText); expect(snapshot + receipt).not.toContain(root); expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await readJobResult(root, job.id)).stdout).toBe(privateText);
});
it('heartbeats safe snapshots while a long job is running', async () => {
  vi.useFakeTimers(); const d = delayed(), { store, root } = await make(d.runner);
  await store.start({ command: 'hold' }, root); await store.flush(); const old = JSON.parse(await readFile(join(store.directory, 'snapshot.json'), 'utf8')).observedAt;
  await vi.advanceTimersByTimeAsync(5100); await store.flush();
  expect(JSON.parse(await readFile(join(store.directory, 'snapshot.json'), 'utf8')).observedAt).toBeGreaterThan(old);
});
it('recovers old running metadata as interrupted without replaying commands', async () => {
  const root = await directory(), session = join(root, 'sessions', 'old'), job = '12345678-1234-1234-1234-123456789abc';
  await mkdir(join(session, 'jobs', job), { recursive: true, mode: 0o700 });
  await writeFile(join(session, 'owner.json'), JSON.stringify({ ownerPid: 999999999, token: 'old' }), { mode: 0o600 });
  await writeFile(join(session, 'jobs', job, 'receipt.json'), JSON.stringify({ id: job, state: 'running', category: 'test', createdAt: 1, ownerPid: 999999999 }), { mode: 0o600 });
  const runner = vi.fn(async (): Promise<JobExecution> => ({ stdout: '', stderr: '', exitCode: 0 }));
  const store = await JobScheduler.open({ stateDirectory: root, sessionId: 'old', runner }); stores.push(store);
  expect(await store.result(job)).toMatchObject({ state: 'cancelled', code: 'interrupted' }); expect(runner).not.toHaveBeenCalled();
});
it('refuses a second live owner and rejects unsafe state modes and path inputs', async () => {
  const { root } = await make(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await expect(JobScheduler.open({ stateDirectory: root, sessionId: 'test-session', runner: vi.fn() })).rejects.toThrow('live owner');
  await expect(JobScheduler.open({ stateDirectory: root, sessionId: '../other', runner: vi.fn() })).rejects.toThrow('session');
  expect(() => jobsStateDirectory({ GRUNT_JOBS_STATE_DIR: 'relative' })).toThrow('absolute');
  expect(() => parseJobInput({ command: 'ok', cwd: '/unexpected' })).toThrow(); expect(() => parseJobInput({ command: 'ok', timeoutSeconds: 1801 })).toThrow();
});
it('scrubs credentials and routing overrides from command environments', () => {
  const env = jobEnvironment({ PATH: '/bin', HOME: '/private', LANG: 'C', OPENAI_API_KEY: 'secret', GRUNT_TOKEN: 'secret', NODE_OPTIONS: '--import unsafe', BASH_ENV: '/unsafe' });
  expect(env).toMatchObject({ PATH: '/bin', HOME: '/private', LANG: 'C', NPM_CONFIG_USERCONFIG: '/dev/null' }); expect(JSON.stringify(env)).not.toContain('secret'); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.BASH_ENV).toBeUndefined();
});
it('runs a real local command through the bounded helper and records actual exit status', async () => {
  const { store, root } = await make(createLocalJobRunner({ helperEntry: helper }));
  const job = await store.start({ command: 'printf background-ok; printf error >&2; exit 7', category: 'test' }, root);
  expect(await store.wait(job.id)).toMatchObject({ state: 'failed', exitCode: 7, stdout: 'background-ok', stderr: 'error' });
});
it('bounds output and kills an overflowing command', async () => {
  const { store, root } = await make(createLocalJobRunner({ helperEntry: helper }), { maxOutputBytes: 16 });
  const job = await store.start({ command: `${quote(process.execPath)} -e ${quote('process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)')}` }, root);
  const result = await store.wait(job.id); expect(result).toMatchObject({ state: 'failed', code: 'output_limit', truncated: true }); expect(Buffer.byteLength(result.stdout ?? '')).toBe(16);
});
it('times out a command and reaps its same-group descendants', async () => {
  const { store, root } = await make(createLocalJobRunner({ helperEntry: helper })), pidfile = join(root, 'child.pid');
  const childScript = `require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000)`;
  const job = await store.start({ command: `${quote(process.execPath)} -e ${quote(childScript)} & wait`, timeoutSeconds: 1 }, root);
  const result = await store.wait(job.id); expect(result).toMatchObject({ state: 'failed', code: 'timeout' });
  const pid = Number(await readFile(pidfile, 'utf8')); await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});
it('external CLI cancellation writes an owned request and the helper honors it', async () => {
  const { store, root } = await make(createLocalJobRunner({ helperEntry: helper }));
  const job = await store.start({ command: 'sleep 30' }, root); await eventually(async () => { try { await lstat(join(store.directory, 'jobs', job.id, 'request.json')); return true; } catch { return false; } });
  expect((await requestJobCancel(root, job.id)).cancellationRequested).toBe(true);
  expect(await store.wait(job.id)).toMatchObject({ state: 'cancelled', code: 'cancelled' });
});
it('captures head and cleanliness from the runner rather than caller metadata', async () => {
  const { store, root } = await make(createLocalJobRunner({ helperEntry: helper })); const project = join(root, 'project'); await mkdir(project);
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }); expect(result.status).toBe(0); return result.stdout.trim(); };
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid'); await writeFile(join(project, 'file'), 'one'); git('add', 'file'); git('commit', '-qm', 'fixture'); const head = git('rev-parse', 'HEAD');
  const job = await store.start({ command: 'printf two > file', category: 'build' }, project);
  expect(await store.wait(job.id)).toMatchObject({ state: 'completed', headAtStart: head, headAtFinish: head, cleanAtStart: true, cleanAtFinish: false });
});

it('waits on completion events, records only bounded wait metadata, and aborts waits without cancelling work', async () => {
  const d = delayed(), { store, root } = await make(d.runner), job = await store.start({ command: 'hold-private' }, root);
  await eventually(() => d.started.length === 1);
  const controller = new AbortController(), pending = store.wait(job.id, { timeoutMs: 1000, signal: controller.signal, track: true });
  await eventually(() => store.snapshot().waiting.length === 1);
  expect(store.snapshot().waiting[0]).toMatchObject({ id: job.id, state: 'waiting' }); expect(JSON.stringify(store.snapshot())).not.toContain('hold-private');
  controller.abort(new Error('stop-wait')); await expect(pending).rejects.toThrow('stop-wait'); expect(store.snapshot().waiting).toEqual([]); expect((await store.result(job.id)).state).toBe('running');
  const completed = store.wait(job.id, { timeoutMs: 1000, track: true }); d.releases.get(job.id)!(); expect(await completed).toMatchObject({ state: 'completed' }); expect(store.snapshot().waiting).toEqual([]);
});
it('a bounded wait timeout returns running status without cancelling the job', async () => {
  const d = delayed(), { store, root } = await make(d.runner), job = await store.start({ command: 'hold' }, root);
  expect(await store.wait(job.id, { timeoutMs: 10, track: true })).toMatchObject({ state: 'running' }); expect(store.snapshot().waiting).toEqual([]);
});
it('keeps a long-lived session accepting jobs after collected results are archived', async () => {
  const { store, root } = await make(async () => ({ stdout: 'done', stderr: '', exitCode: 0 }));
  let first = '';
  for (let index = 0; index < 130; index++) { const job = await store.start({ command: 'private-command' }, root); first ||= job.id; await store.wait(job.id); }
  expect(store.snapshot().recent).toHaveLength(100); await expect(store.result(first)).rejects.toThrow('not available');
  const archived = await readdir(join(store.directory, 'receipts')); expect(archived.length).toBeGreaterThan(0);
  expect(await readFile(join(store.directory, 'receipts', archived[0]!), 'utf8')).not.toContain('private-command');
});
it('session shutdown cancels only its owned jobs and preserves interrupted receipts', async () => {
  const d = delayed(), { store, root } = await make(d.runner), job = await store.start({ command: 'hold' }, root);
  await eventually(() => d.started.length === 1); await store.close();
  expect(await store.result(job.id)).toMatchObject({ state: 'cancelled', code: 'interrupted' });
});

it('bounds UTF-8 result bytes even when a cap splits a multibyte character', async () => {
  const { store, root } = await make(async () => ({ stdout: '🔥'.repeat(20), stderr: 'more', exitCode: 0 }), { maxOutputBytes: 7 });
  const job = await store.start({ command: 'unicode' }, root), result = await store.wait(job.id);
  expect(Buffer.byteLength((result.stdout ?? '') + (result.stderr ?? ''))).toBeLessThanOrEqual(7); expect(result.truncated).toBe(true);
});
it('admits only one owner when many processes race to recover the same stale generation', async () => {
  const root = await directory(), session = join(root, 'sessions', 'takeover');
  await mkdir(session, { recursive: true, mode: 0o700 });
  await writeFile(join(session, 'owner.json'), JSON.stringify({ ownerPid: 999999999, token: 'stale-generation' }), { mode: 0o600 });
  const attempts = await Promise.allSettled(Array.from({ length: 32 }, () => JobScheduler.open({ stateDirectory: root, sessionId: 'takeover', runner: vi.fn() })));
  const owners = attempts.filter((result): result is PromiseFulfilledResult<JobScheduler> => result.status === 'fulfilled').map(result => result.value); stores.push(...owners);
  expect(owners).toHaveLength(1);
  const lease = JSON.parse(await readFile(join(session, 'owner.json'), 'utf8')); expect(lease.ownerPid).toBe(process.pid);
  const before = await readFile(join(session, 'owner.json'), 'utf8');
  await expect(JobScheduler.open({ stateDirectory: root, sessionId: 'takeover', runner: vi.fn() })).rejects.toThrow('live owner');
  expect(await readFile(join(session, 'owner.json'), 'utf8')).toBe(before);
});

it('recovers a stale owner even if prior recovery claimants died before publishing their owner lease', async () => {
  const root = await directory(), session = join(root, 'sessions', 'abandoned'), claims = join(session, 'takeovers');
  await mkdir(claims, { recursive: true, mode: 0o700 });
  const original = { ownerPid: 999999999, token: 'stale-generation' }, abandoned = { ownerPid: 999999998, token: 'abandoned-recovery' };
  const key = (lease: object) => createHash('sha256').update(JSON.stringify(lease)).digest('hex');
  await writeFile(join(session, 'owner.json'), JSON.stringify(original), { mode: 0o600 });
  await writeFile(join(claims, key(original) + '.json'), JSON.stringify(abandoned), { mode: 0o600 });
  const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => JobScheduler.open({ stateDirectory: root, sessionId: 'abandoned', runner: vi.fn() })));
  const owners = attempts.filter((result): result is PromiseFulfilledResult<JobScheduler> => result.status === 'fulfilled').map(result => result.value); stores.push(...owners);
  expect(owners).toHaveLength(1);
  expect(JSON.parse(await readFile(join(claims, key(original) + '.json'), 'utf8'))).toEqual(abandoned);
  const recoveredClaim = JSON.parse(await readFile(join(claims, key(abandoned) + '.json'), 'utf8')); expect(recoveredClaim.ownerPid).toBe(process.pid);
  await expect(JobScheduler.open({ stateDirectory: root, sessionId: 'abandoned', runner: vi.fn() })).rejects.toThrow('live owner');
});

it('acquires a missing owner after a claimant died between stale removal and fresh publication', async () => {
  const root = await directory(), session = join(root, 'sessions', 'removed'), claims = join(session, 'takeovers');
  await mkdir(claims, { recursive: true, mode: 0o700 });
  await writeFile(join(claims, 'a'.repeat(64) + '.json'), JSON.stringify({ ownerPid: 999999999, token: 'dead-after-removal' }), { mode: 0o600 });
  const store = await JobScheduler.open({ stateDirectory: root, sessionId: 'removed', runner: vi.fn() }); stores.push(store);
  expect(JSON.parse(await readFile(join(session, 'owner.json'), 'utf8')).ownerPid).toBe(process.pid);
});
