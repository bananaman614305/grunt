import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentWorkerBatches } from './worker-agent-client.js';
import { COORDINATION_POLICY, readCoordinationCapacity, WorkerCoordinator } from './worker-coordination.js';
import gruntWorkerExtension from './worker-pi.js';

const signal = () => new AbortController().signal;
const plan = () => ({ operation: 'plan', main: { task: 'Integrate the caller-selected change', ownedPaths: ['src/main.ts'] }, tasks: [
  { id: 'one', task: 'Implement module one', ownedPaths: ['src/one'], context: 'Only the supplied bounded context' },
  { id: 'two', task: 'Implement module two', ownedPaths: ['src/two'] },
  { id: 'review', task: 'Review integrated module one', ownedPaths: ['src/one'], dependsOn: ['one'] }
] });
function fixture() {
  const snapshots = new Map<string, ReturnType<AgentWorkerBatches['result']>>();
  const batches = {
    start: vi.fn(async () => { const batchId = randomUUID(); snapshots.set(batchId, { batchId, state: 'running' }); return { batchId, state: 'running' as const }; }),
    result: vi.fn((input: unknown) => snapshots.get((input as { batchId: string }).batchId)!)
  };
  const capacity = vi.fn(async () => ({ workerSlots: 2, idleToolSources: 3, dispatchSlots: 2 }));
  return { store: new WorkerCoordinator({ batches, capacity }), batches, capacity, snapshots };
}
afterEach(() => { vi.unstubAllGlobals(); });

it('dispatches independent disjoint work nonblockingly while leaving main work and dependent review to the caller', async () => {
  const f = fixture();
  await f.store.execute(plan(), signal());
  const dispatched = await f.store.execute({ operation: 'dispatch' }, signal());
  expect(dispatched).toMatchObject({ dispatch: 'started', dispatchedTasks: ['one', 'two'], tasks: [
    { id: 'one', state: 'running' }, { id: 'two', state: 'running' }, { id: 'review', state: 'pending', deferredReason: expect.stringContaining('integrate') }
  ] });
  expect(f.batches.start).toHaveBeenCalledExactlyOnceWith({ tasks: [
    { task: 'Implement module one', ownedPaths: ['src/one'], context: 'Only the supplied bounded context' },
    { task: 'Implement module two', ownedPaths: ['src/two'] }
  ] }, expect.any(AbortSignal));
  expect((await f.store.execute({ operation: 'dispatch' }, signal()))).toMatchObject({ dispatch: 'already_running' });
  expect(f.capacity).toHaveBeenCalledTimes(1);
  const batchId = [...f.snapshots.keys()][0]!;
  f.snapshots.set(batchId, { batchId, state: 'completed', results: [
    { ok: true, id: randomUUID(), source: 'kilo', text: 'Ready', artifact: { id: randomUUID(), complete: true, truncated: false, view: 'summary', fileCount: 1, files: [], omittedFiles: 1, integration: 'Review before applying', inspect: 'Inspect' } },
    { ok: false, code: 'quota' }
  ] });
  expect(await f.store.execute({ operation: 'status' }, signal())).toMatchObject({ tasks: [
    { id: 'one', state: 'completed', requiresIntegration: true }, { id: 'two', state: 'failed' }, { id: 'review', state: 'pending' }
  ] });
  expect(await f.store.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'no_independent_tasks' });
  expect(f.batches.start).toHaveBeenCalledTimes(1); // Neither failed jobs nor dependency work are replayed.
});

it('does not emit task or context bodies into repeated status results', async () => {
  const f = fixture(); await f.store.execute(plan(), signal());
  const text = JSON.stringify(await f.store.execute({ operation: 'status' }, signal()));
  expect(text).not.toContain('Only the supplied bounded context'); expect(text).not.toContain('Implement module one');
  expect(f.capacity).not.toHaveBeenCalled(); expect(f.batches.start).not.toHaveBeenCalled();
});

it('bounds repeated ownership summaries while retaining complete paths for overlap checks', async () => {
  const f = fixture();
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `task${i}`, task: 'Bounded work', ownedPaths: Array.from({ length: 32 }, (_, j) => `module${i}/${j}-${'x'.repeat(450)}`) }));
  const result = await f.store.execute({ ...plan(), tasks }, signal());
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16384);
  expect(result).toMatchObject({ tasks: tasks.map(task => ({ id: task.id, ownedPathCount: 32, omittedOwnedPaths: 28 })) });
});

it.each([
  { tasks: [{ id: 'one', task: 'Overlap main', ownedPaths: ['src/main.ts/sub'] }] },
  { tasks: [{ id: 'one', task: 'One', ownedPaths: ['src/other'] }, { id: 'two', task: 'Two', ownedPaths: ['src/other/a'] }] },
  { tasks: [{ id: 'one', task: 'Cycle', ownedPaths: ['one'], dependsOn: ['two'] }, { id: 'two', task: 'Cycle', ownedPaths: ['two'], dependsOn: ['one'] }] },
  { tasks: [{ id: 'one', task: 'Unknown', ownedPaths: ['one'], dependsOn: ['missing'] }] },
  { tasks: [{ id: 'one', task: 'Unsafe', ownedPaths: ['.env'] }] },
  { tasks: [{ id: 'one', task: 'Escape', ownedPaths: ['../outside'] }] },
  { tasks: [{ id: 'one', task: 'Select', ownedPaths: ['one'], provider: 'paid' }] },
  { main: { task: 'Select', ownedPaths: ['main'], projectRoot: '/private' } }
])('rejects invalid dependency/ownership/authority declarations before any dispatch: %j', async patch => {
  const f = fixture(); await expect(f.store.execute({ ...plan(), ...patch }, signal())).rejects.toThrow();
  expect(f.batches.start).not.toHaveBeenCalled(); expect(f.capacity).not.toHaveBeenCalled();
});

it('allows a serial plan without fabricated worker work or capacity calls', async () => {
  const f = fixture(); await f.store.execute({ operation: 'plan', main: { task: 'One dependent edit', ownedPaths: [] }, tasks: [] }, signal());
  expect(await f.store.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'no_independent_tasks' });
  expect(f.capacity).not.toHaveBeenCalled();
});

it('uses only one task when capacity leaves one worker slot and reserves the remaining ready task', async () => {
  const f = fixture(); f.capacity.mockResolvedValue({ workerSlots: 2, idleToolSources: 2, dispatchSlots: 1 }); await f.store.execute(plan(), signal());
  expect(await f.store.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatchedTasks: ['one'], tasks: [{ id: 'one', state: 'running' }, { id: 'two', state: 'pending' }, { id: 'review', state: 'pending' }] });
});

it('never dispatches on missing capacity, metadata errors or caller cancellation', async () => {
  const f = fixture(); await f.store.execute(plan(), signal());
  f.capacity.mockResolvedValue({ workerSlots: 2, idleToolSources: 1, dispatchSlots: 0 });
  expect(await f.store.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'capacity_unavailable' });
  f.capacity.mockRejectedValueOnce(new Error('Metadata unavailable'));
  await expect(f.store.execute({ operation: 'dispatch' }, signal())).rejects.toThrow('Metadata unavailable');
  const controller = new AbortController(); f.capacity.mockImplementationOnce(async () => { controller.abort(); return { workerSlots: 2, idleToolSources: 3, dispatchSlots: 2 }; });
  await expect(f.store.execute({ operation: 'dispatch' }, controller.signal)).rejects.toThrow();
  expect(f.batches.start).not.toHaveBeenCalled();
});

it('prevents concurrent dispatch and plan replacement while a start is in flight', async () => {
  const f = fixture(); await f.store.execute(plan(), signal());
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.capacity.mockImplementationOnce(async () => { await pending; return { workerSlots: 2, idleToolSources: 3, dispatchSlots: 2 }; });
  const first = f.store.execute({ operation: 'dispatch' }, signal());
  expect(await f.store.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'already_running' });
  await expect(f.store.execute(plan(), signal())).rejects.toThrow('running');
  release(); await first; expect(f.batches.start).toHaveBeenCalledTimes(1);
});

it('retains terminal coordination metadata after direct spawns evict the shared client batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-coordination-eviction-'));
  const challengeId = randomUUID(), fileName = `.grunt-workspace-${randomUUID()}.proof`;
  const workerId = randomUUID(), artifactId = randomUUID();
  const fetcher = vi.fn<typeof fetch>(async url => {
    const path = String(url).split('/v1/workers')[1];
    if (path === '/projects/challenge') return Response.json({ challengeId, fileName, nonce: 'a'.repeat(64) });
    if (path === '/projects/register') return Response.json({ token: 'b'.repeat(64), expiresAt: Date.now() + 86400000 });
    if (path === '/capabilities') return Response.json({ initialSnapshotRequired: false });
    if (path === '/projects/revoke') return Response.json({ ok: true });
    if (path === '/run') return Response.json({ ok: true, id: workerId, source: 'kilo', text: 'Ready', artifact: {
      id: artifactId, complete: true, truncated: false,
      files: [{ path: 'src/one', beforeSha256: null, afterSha256: 'c'.repeat(64), content: 'synthetic retained artifact' }]
    } });
    throw new Error('Unexpected fixture request');
  });
  const batches = new AgentWorkerBatches(8793, directory, fetcher);
  const store = new WorkerCoordinator({ batches, capacity: async () => ({ workerSlots: 2, idleToolSources: 3, dispatchSlots: 2 }) });
  const input = { ...plan(), tasks: [plan().tasks[0]!] };
  try {
    await store.execute(input, signal());
    const dispatched = await store.execute({ operation: 'dispatch' }, signal());
    const id = (dispatched as { batchId: string }).batchId;
    await batches.wait({ batchId: id }, signal());
    expect(await store.execute({ operation: 'status' }, signal())).toMatchObject({ tasks: [{ id: 'one', state: 'completed', requiresIntegration: true }] });
    for (let index = 0; index < 8; index++) {
      const next = await batches.start({ tasks: [{ task: 'Explicit direct spawn', ownedPaths: [`src/direct-${index}`] }] });
      await batches.wait({ batchId: next.batchId }, signal());
    }
    expect(batches.has({ batchId: id })).toBe(false); // Actual eight-batch shared-client retention limit.
    expect(await store.execute({ operation: 'status' }, signal())).toMatchObject({ tasks: [{ id: 'one', state: 'completed', batchId: id, workerId, artifactId, requiresIntegration: true }] });
    expect(await store.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'no_independent_tasks' });
    expect(await store.execute(input, signal())).toMatchObject({ tasks: [{ id: 'one', state: 'pending' }] });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/run'))).toHaveLength(9); // Explicit replan does not dispatch/replay work.
  } finally { await batches.close(); await rm(directory, { recursive: true, force: true }); }
});

it('reconciles unknown batches as unresolved without replay and permits an explicit new plan', async () => {
  const f = fixture(); f.capacity.mockResolvedValue({ workerSlots: 2, idleToolSources: 2, dispatchSlots: 1 });
  await f.store.execute(plan(), signal());
  await f.store.execute({ operation: 'dispatch' }, signal());
  f.batches.result.mockImplementation(() => { throw new Error('Unknown scoped worker batch. Retained artifacts can be recovered.'); });
  expect(await f.store.execute({ operation: 'status' }, signal())).toMatchObject({ reconciliationRequired: true, tasks: [
    { id: 'one', state: 'unresolved', reconciliation: 'inspect_retained_artifacts' }, { id: 'two', state: 'pending' }, { id: 'review', state: 'pending' }
  ] });
  expect(await f.store.execute({ operation: 'dispatch' }, signal())).toMatchObject({ dispatch: 'reconciliation_required' });
  expect(f.batches.start).toHaveBeenCalledTimes(1);
  expect(await f.store.execute({ operation: 'plan', main: { task: 'Inspect retained artifacts before choosing new work', ownedPaths: [] }, tasks: [] }, signal())).toMatchObject({ state: 'planned', tasks: [] });
  expect(f.batches.start).toHaveBeenCalledTimes(1);
});

it.each([
  [[], [], ['ready', 'available', 'available'], 2],
  [[{}], [], ['ready', 'available', 'available'], 1],
  [[], [{}], ['ready', 'available', 'available'], 1],
  [[], [], ['ready'], 0],
  [[], [], ['unknown', 'limited', 'answering', 'error', 'disabled'], 0]
])('conservatively reserves main capacity from metadata, without selecting or probing providers', async (active, queued, states, slots) => {
  const fetcher = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/workers') ? { active, queued, recent: [] }
    : { sources: states.map((state, i) => ({ id: `source-${i}`, state, supportsFunctionTools: true, active: 0, credential: 'synthetic-private' })) }));
  const result = await readCoordinationCapacity(8793, signal(), fetcher);
  expect(result.dispatchSlots).toBe(slots);
  expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual(['http://127.0.0.1:8793/v1/status', 'http://127.0.0.1:8793/v1/workers']);
  expect(JSON.stringify(result)).not.toContain('source-'); expect(JSON.stringify(result)).not.toContain('synthetic-private');
  expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error' && !init.method && !init.body)).toBe(true);
});

it('fails closed for malformed capacity metadata and redirects', async () => {
  const malformed = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/workers') ? { active: [], queued: [] }
    : { sources: [{ id: 'same', active: 0, state: 'ready', supportsFunctionTools: true }, { id: 'same', active: 0, state: 'ready', supportsFunctionTools: true }] }));
  await expect(readCoordinationCapacity(8793, signal(), malformed)).rejects.toThrow('Invalid');
  await expect(readCoordinationCapacity(8793, signal(), async () => new Response(null, { status: 302 }))).rejects.toThrow('unavailable');
});

it('registers coordination only for trusted worker launches and preserves system instructions in the orchestration hook', async () => {
  const tools: Parameters<Parameters<typeof gruntWorkerExtension>[0]['registerTool']>[0][] = [];
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>(); let enabled = false;
  gruntWorkerExtension({ registerFlag: vi.fn(), registerTool: tool => tools.push(tool), exec: vi.fn(),
    getFlag: name => name === 'grunt-agent-workers' ? enabled : name === 'grunt-worker-port' ? '8793' : false,
    on: ((name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler])) as Parameters<typeof gruntWorkerExtension>[0]['on'] });
  const start = async () => { for (const handler of handlers.get('session_start') ?? []) await handler({}, { cwd: '/tmp' }); };
  await start(); expect(tools.some(tool => tool.name === 'grunt_coordinate')).toBe(false);
  enabled = true; await start(); await start(); expect(tools.filter(tool => tool.name === 'grunt_coordinate')).toHaveLength(1);
  const before = async (initial: string) => {
    let systemPrompt = initial;
    for (const handler of handlers.get('before_agent_start') ?? []) {
      const result = await handler({ systemPrompt }, { cwd: '/tmp' }) as { systemPrompt?: string } | undefined;
      if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
    }
    return systemPrompt;
  };
  expect(await before('Existing permissions and task.')).toEqual('Existing permissions and task.' + COORDINATION_POLICY);
  expect(await before('Existing permissions and task.' + COORDINATION_POLICY)).toEqual('Existing permissions and task.' + COORDINATION_POLICY);
  enabled = false; expect(await before('Existing')).toBe('Existing');
});

it('keeps coordination plans separate when a harness switches sessions in the same project', async () => {
  const tools: Parameters<Parameters<typeof gruntWorkerExtension>[0]['registerTool']>[0][] = [];
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  gruntWorkerExtension({ registerFlag: vi.fn(), registerTool: tool => tools.push(tool), exec: vi.fn(),
    getFlag: name => name === 'grunt-agent-workers' ? true : name === 'grunt-worker-port' ? '8793' : false,
    on: ((name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler])) as Parameters<typeof gruntWorkerExtension>[0]['on'] });
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
  for (const handler of handlers.get('session_start') ?? []) await handler({}, { cwd: '/tmp' });
  const tool = tools.find(tool => tool.name === 'grunt_coordinate')!;
  const context = (id: string) => ({ cwd: '/tmp', sessionManager: { getSessionId: () => id } });
  const first = await tool.execute('one', plan(), signal(), undefined, context('one'));
  const second = await tool.execute('two', plan(), signal(), undefined, context('two'));
  expect((first.details as { planId: string }).planId).not.toBe((second.details as { planId: string }).planId);
  expect((await tool.execute('status', { operation: 'status' }, signal(), undefined, context('one'))).details).toMatchObject({ planId: (first.details as { planId: string }).planId });
  expect(fetcher).not.toHaveBeenCalled();
  for (const handler of handlers.get('session_shutdown') ?? []) await handler();
});
