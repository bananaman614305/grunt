import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CoordinationStore } from './coordination-store.js';
import { WorkerCoordinator } from './worker-coordination.js';
import type { AgentWorkerBatches } from './worker-agent-client.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const signal = () => new AbortController().signal;
const input = { operation: 'plan', main: { task: 'Integrate modules', ownedPaths: ['main.ts'] }, tasks: [
  { id: 'one', task: 'Bounded first edit', ownedPaths: ['one.ts'] }, { id: 'two', task: 'Bounded second edit', ownedPaths: ['two.ts'] }
] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grunt-coordination-state-')); roots.push(root);
  const projectRoot = join(root, 'project'), stateDirectory = join(root, 'state'); await mkdir(projectRoot);
  const options = { projectRoot, sessionId: 'session-one', stateDirectory };
  const batches = { start: vi.fn(async () => ({ batchId: '11111111-1111-4111-8111-111111111111', state: 'running' as const })),
    result: vi.fn<AgentWorkerBatches['result']>(() => { throw new Error('Unknown frontend batch'); }) };
  const capacity = vi.fn(async () => ({ workerSlots: 2, idleToolSources: 2, dispatchSlots: 1 }));
  const open = (overrides: Partial<typeof options> = {}) => WorkerCoordinator.open({ ...options, ...overrides, batches, capacity });
  const records = async () => {
    const st = await lstat(projectRoot), hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const project = hash(`${projectRoot}:${st.dev}:${st.ino}`), session = hash(options.sessionId);
    const directory = join(stateDirectory, project, session); return { directory, files: (await readdir(directory)).filter(name => name.endsWith('.json')).sort() };
  };
  return { ...options, root, batches, capacity, open, records };
}

it('restores an undispatched plan in the same project/session and requires explicit dispatch', async () => {
  const f = await fixture(), first = await f.open();
  const planned = await first.execute(input, signal()), restarted = await f.open();
  expect(await restarted.execute({ operation: 'status' }, signal())).toMatchObject({ planId: planned.planId, tasks: [{ id: 'one', state: 'pending' }, { id: 'two', state: 'pending' }] });
  expect(f.batches.start).not.toHaveBeenCalled(); expect(f.capacity).not.toHaveBeenCalled();
  await restarted.execute({ operation: 'dispatch' }, signal()); expect(f.batches.start).toHaveBeenCalledOnce();
});

it('keeps completed summaries after restart and never replays a completed task', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  f.batches.result.mockReturnValue({ batchId: '11111111-1111-4111-8111-111111111111', state: 'completed', results: [{ ok: true, id: '22222222-2222-4222-8222-222222222222', source: 'synthetic', text: 'Completed',
    artifact: { id: '33333333-3333-4333-8333-333333333333', complete: true, truncated: false, view: 'summary', files: [], fileCount: 1, omittedFiles: 1, inspect: 'Inspect', integration: 'Review' } }] });
  await first.execute({ operation: 'dispatch' }, signal());
  f.batches.result.mockImplementation(() => { throw new Error('Frontend results lost'); });
  const restarted = await f.open();
  expect(await restarted.execute({ operation: 'status' }, signal())).toMatchObject({ tasks: [{ id: 'one', state: 'completed', requiresIntegration: true, workerId: '22222222-2222-4222-8222-222222222222' }, { id: 'two', state: 'pending' }] });
  expect(f.batches.start).toHaveBeenCalledOnce();
  expect(JSON.stringify(await restarted.execute({ operation: 'status' }, signal()))).not.toContain('Bounded first edit');
});

it('turns lost running batch IDs into unresolved advisory references and blocks all replay', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  f.batches.result.mockReturnValue({ batchId: '11111111-1111-4111-8111-111111111111', state: 'running' });
  await first.execute({ operation: 'dispatch' }, signal());
  f.batches.result.mockImplementation(() => { throw new Error('Frontend results lost'); });
  const restarted = await f.open();
  expect(await restarted.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'reconciliation_required', tasks: [{ id: 'one', state: 'unresolved', batchId: '11111111-1111-4111-8111-111111111111' }, { id: 'two', state: 'pending' }] });
  expect(f.batches.start).toHaveBeenCalledOnce();
});

it('persists an ambiguous admission intent before submission, even if frontend start fails', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  f.batches.start.mockImplementationOnce(async () => {
    const restarted = await f.open();
    expect(await restarted.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'reconciliation_required', tasks: [{ id: 'one', state: 'unresolved' }, { id: 'two', state: 'pending' }] });
    throw new Error('Unknown admission outcome');
  });
  await expect(first.execute({ operation: 'dispatch' }, signal())).rejects.toThrow('Unknown admission');
  expect(await (await f.open()).execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'reconciliation_required' });
  expect(f.batches.start).toHaveBeenCalledOnce();
});

it('uses exclusive revisions to prevent concurrent frontend dispatch of the same pending plan', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  const second = await f.open();
  let arrive!: () => void; const both = new Promise<void>(resolve => { arrive = resolve; }); let waiting = 0;
  f.capacity.mockImplementation(async () => { if (++waiting === 2) arrive(); await both; return { workerSlots: 2, idleToolSources: 2, dispatchSlots: 1 }; });
  f.batches.result.mockReturnValue({ batchId: '11111111-1111-4111-8111-111111111111', state: 'running' });
  const attempts = await Promise.allSettled([first.execute({ operation: 'dispatch' }, signal()), second.execute({ operation: 'dispatch' }, signal())]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(f.batches.start).toHaveBeenCalledOnce();
});

it('isolates another session and project and rejects copied identity records', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  expect(await (await f.open({ sessionId: 'other' })).execute({ operation: 'status' }, signal())).toMatchObject({ state: 'unplanned' });
  const other = join(f.root, 'other-project'); await mkdir(other);
  expect(await (await f.open({ projectRoot: other })).execute({ operation: 'status' }, signal())).toMatchObject({ state: 'unplanned' });
  const { directory, files } = await f.records(), target = join(directory, files.at(-1)!); const record = JSON.parse(await readFile(target, 'utf8')); record.session = 'wrong'; await writeFile(target, JSON.stringify(record));
  await expect(f.open()).rejects.toThrow('coordination');
});

it('keeps state private, bounded and outside worker project inputs, and refuses symlink records', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  const { directory, files } = await f.records(), target = join(directory, files.at(-1)!);
  expect((await lstat(directory)).mode & 0o077).toBe(0); expect((await lstat(target)).mode & 0o077).toBe(0);
  await expect(f.open({ stateDirectory: join(f.projectRoot, 'state') })).rejects.toThrow('coordination');
  await rm(target); const outside = join(f.root, 'outside.json'); await writeFile(outside, '{}', { mode: 0o600 }); await symlink(outside, target);
  await expect(f.open()).rejects.toThrow('coordination');
  await rm(target); await writeFile(target, 'x'.repeat(512 * 1024 + 1), { mode: 0o600 }); await expect(f.open()).rejects.toThrow('coordination');
  await writeFile(target, '{}'); await chmod(target, 0o644); await expect(f.open()).rejects.toThrow('coordination');
});

it('rejects corrupt or authority-injecting plans before any provider work and bounds retained revisions', async () => {
  const f = await fixture(), store = await CoordinationStore.open(f), first = await f.open();
  await first.execute(input, signal());
  const { directory, files } = await f.records(), target = join(directory, files.at(-1)!); const record = JSON.parse(await readFile(target, 'utf8'));
  record.plan.tasks[0].input.provider = 'paid'; await writeFile(target, JSON.stringify(record)); await expect(f.open()).rejects.toThrow('saved coordination');
  expect(f.batches.start).not.toHaveBeenCalled();
  delete record.plan.tasks[0].input.provider; await writeFile(target, JSON.stringify(record));
  for (let revision = 1; revision < 12; revision++) await store.write(record.plan, revision);
  expect((await f.records()).files).toHaveLength(8);
});

it('recovers a crashed atomic publisher temporary hardlink but rejects arbitrary external aliases', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  const { directory, files } = await f.records(), target = join(directory, files.at(-1)!);
  const temporary = join(directory, '.pending-11111111-1111-4111-8111-111111111111'); await link(target, temporary);
  expect(await (await f.open()).execute({ operation: 'status' }, signal())).toMatchObject({ state: 'planned' });
  expect((await lstat(target)).nlink).toBe(1);
  await link(target, join(f.root, 'external-link')); await expect(f.open()).rejects.toThrow('coordination');
});

it('refuses symlinked state parents, corrupt JSON and replacement project identities', async () => {
  const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside, { mode: 0o700 });
  const alias = join(f.root, 'alias'); await symlink(outside, alias);
  await expect(f.open({ stateDirectory: join(alias, 'state') })).rejects.toThrow('coordination');
  const coordinator = await f.open(); await coordinator.execute(input, signal());
  const { directory, files } = await f.records(); await writeFile(join(directory, files.at(-1)!), '{'); await expect(f.open()).rejects.toThrow('coordination');
  const store = await CoordinationStore.open(f); await rm(f.projectRoot, { recursive: true }); await mkdir(f.projectRoot);
  await expect(store.read()).rejects.toThrow('coordination');
});

it('rejects a suspended writer after a newer head prunes and frees its exclusive revision name', async () => {
  const f = await fixture(), older = await CoordinationStore.open(f), newer = await CoordinationStore.open(f);
  await older.write({ label: 'initial' }, 0);
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), captured = new Promise<void>(resolve => { arrived = resolve; });
  const read = older.read.bind(older);
  vi.spyOn(older, 'read').mockImplementationOnce(async () => { const value = await read(); arrived(); await gate; return value; });
  const stale = older.write({ label: 'stale-admission' }, 1);
  await captured;
  for (let revision = 1; revision < 10; revision++) await newer.write({ label: 'newer-plan' }, revision);
  expect((await f.records()).files).not.toContain('0000000000000002.json');
  release();
  await expect(stale).rejects.toThrow('revision conflict');
  expect(await newer.read()).toMatchObject({ revision: 10, plan: { label: 'newer-plan' } });
});

it('never replaces an in-flight dispatch plan with a newer status restore before recording admission', async () => {
  const f = await fixture(), first = await f.open(); await first.execute(input, signal());
  const second = await f.open();
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), capacityStarted = new Promise<void>(resolve => { arrived = resolve; });
  f.capacity.mockImplementationOnce(async () => { arrived(); await gate; return { workerSlots: 2, idleToolSources: 2, dispatchSlots: 1 }; });
  const dispatch = first.execute({ operation: 'dispatch' }, signal());
  await capacityStarted;
  await second.execute({ operation: 'plan', main: { task: 'New owner-selected work', ownedPaths: [] }, tasks: [{ id: 'new', task: 'Different work', ownedPaths: ['new.ts'] }] }, signal());
  await first.execute({ operation: 'status' }, signal());
  release();
  await expect(dispatch).rejects.toThrow('revision conflict');
  expect(f.batches.start).not.toHaveBeenCalled();
  expect(await (await f.open()).execute({ operation: 'status' }, signal())).toMatchObject({ tasks: [{ id: 'new', state: 'pending' }] });
});
