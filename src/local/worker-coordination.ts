import { randomUUID } from 'node:crypto';
import type { AgentWorkerBatches } from './worker-agent-client.js';
import { parseWorkerTask, workerActivities } from './worker-pool.js';
import type { WorkerTask } from './worker-pool.js';
import { workerRelativePath } from './worker-tool-helper.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const idPattern = /^[a-z][a-z0-9_-]{0,47}$/;
const overlaps = (left: string, right: string) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
const pathList = (value: unknown, allowEmpty = false) => {
  if (!Array.isArray(value) || value.length > 32 || !allowEmpty && !value.length) throw new Error('Declare up to 32 relative owned paths.');
  const paths = value.map(path => workerRelativePath(path));
  if (new Set(paths).size !== paths.length) throw new Error('Owned paths must be distinct.');
  return paths;
};
interface PlannedTask { id: string; input: WorkerTask; dependsOn: string[]; state: 'pending' | 'running' | 'completed' | 'failed' | 'unresolved'; batchId?: string; workerId?: string; artifactId?: string; requiresIntegration?: boolean }
interface Plan { id: string; mainPaths: string[]; tasks: PlannedTask[]; batches: { id: string; tasks: string[]; terminal?: boolean }[] }
export interface CoordinationCapacity { workerSlots: number; idleToolSources: number; dispatchSlots: number }

/** Admission metadata is conservative scheduling advice, never a grant to use a provider. */
export async function readCoordinationCapacity(port: number, signal: AbortSignal, fetcher = fetch): Promise<CoordinationCapacity> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local worker port.');
  const read = async (path: string) => {
    const response = await fetcher(`http://127.0.0.1:${port}/v1/${path}`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok || !response.body) throw new Error('Local capacity metadata is unavailable.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 1024 * 1024) throw new Error('Local capacity metadata is too large.'); chunks.push(part.value); }
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const [workers, runtime] = await Promise.all([read('workers'), read('status')]);
  if (!Array.isArray(workers.active) || workers.active.length > 2 || !Array.isArray(workers.queued) || workers.queued.length > 16
      || !Array.isArray(runtime.sources) || runtime.sources.length > 100) throw new Error('Invalid local capacity metadata.');
  const seen = new Set<string>();
  const idleToolSources = runtime.sources.filter(value => {
    const row = object(value);
    if (typeof row.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id) || seen.has(row.id)) throw new Error('Invalid local capacity metadata.');
    seen.add(row.id);
    return (row.state === 'ready' || row.state === 'available') && row.supportsFunctionTools === true && row.active === 0;
  }).length;
  const workerSlots = Math.max(0, 2 - workers.active.length - workers.queued.length);
  // Preserve one idle eligible route for the main agent. The daemon still owns
  // actual provider selection, current free guards, admission and quotas.
  return { workerSlots, idleToolSources, dispatchSlots: Math.min(workerSlots, Math.max(0, idleToolSources - 1)) };
}

function parsePlan(input: Record<string, unknown>): Plan {
  if (!exact(input, ['operation', 'main', 'tasks']) || input.operation !== 'plan') throw new Error('Provide a main task and scoped worker tasks.');
  const main = object(input.main);
  if (!exact(main, ['task', 'ownedPaths']) || typeof main.task !== 'string' || !main.task.trim() || Buffer.byteLength(main.task) > 8192) throw new Error('Declare the main agent task.');
  const mainPaths = pathList(main.ownedPaths, true);
  if (!Array.isArray(input.tasks) || input.tasks.length > 8) throw new Error('Plan at most eight bounded worker tasks.');
  const tasks: PlannedTask[] = input.tasks.map(value => {
    const row = object(value);
    if (!exact(row, ['id', 'task', 'context', 'activity', 'ownedPaths', 'dependsOn']) || typeof row.id !== 'string' || !idPattern.test(row.id) || row.id === 'main') throw new Error('Provide distinct task IDs; main is reserved.');
    const { id, dependsOn, ...rest } = row;
    const parsed = parseWorkerTask({ ...rest, mode: 'agent', ownedPaths: pathList(row.ownedPaths) });
    if (!parsed || dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.length > 8 || dependsOn.some(id => typeof id !== 'string' || !idPattern.test(id)) || new Set(dependsOn).size !== dependsOn.length)) throw new Error('Provide bounded scoped tasks and distinct dependency IDs.');
    return { id, input: parsed, dependsOn: dependsOn as string[] | undefined ?? [], state: 'pending' };
  });
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Task IDs must be distinct.');
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visit = (id: string, ancestors: Set<string>) => {
    if (id === 'main') return;
    if (ancestors.has(id)) throw new Error('Worker task dependencies contain a cycle.');
    const task = byId.get(id); if (!task) throw new Error('A dependency references an unknown task.');
    for (const dependency of task.dependsOn) visit(dependency, new Set([...ancestors, id]));
  };
  for (const task of tasks) visit(task.id, new Set());
  // Dependent work may intentionally own the same files, but cannot be
  // scheduled until the main agent has reviewed/integrated and replanned it.
  const ready = tasks.filter(task => !task.dependsOn.length);
  const owners: string[][] = [mainPaths];
  for (const task of ready) {
    const paths = task.input.ownedPaths!;
    if (owners.some(other => paths.some(path => other.some(owned => overlaps(path, owned))))) throw new Error('Independent worker and main owned paths must not overlap. Add a dependency or split ownership.');
    owners.push(paths);
  }
  return { id: randomUUID(), mainPaths, tasks, batches: [] };
}

/** The model chooses project work; this coordinator enforces bounded safe dispatch. */
export class WorkerCoordinator {
  private plan: Plan | undefined;
  private dispatching = false;
  private capacity: CoordinationCapacity | undefined;
  constructor(private options: { batches: Pick<AgentWorkerBatches, 'start' | 'result'>; capacity(signal: AbortSignal): Promise<CoordinationCapacity> }) {}
  private refresh() {
    for (const batch of this.plan?.batches ?? []) {
      // The shared frontend client evicts old completed batches. Once consumed,
      // our bounded task summaries must not depend on that cache's lifetime.
      if (batch.terminal) continue;
      let result: ReturnType<AgentWorkerBatches['result']>;
      try { result = this.options.batches.result({ batchId: batch.id }); }
      catch {
        // A lost result is not proof that a task never ran. Preserve its ID,
        // stop automatic dispatch, and ask the caller to inspect retention.
        batch.terminal = true;
        for (const id of batch.tasks) this.plan!.tasks.find(row => row.id === id)!.state = 'unresolved';
        continue;
      }
      if (result.state !== 'completed') continue;
      for (const [index, id] of batch.tasks.entries()) {
        const task = this.plan!.tasks.find(row => row.id === id)!; const entry = result.results?.[index];
        task.state = entry?.ok ? 'completed' : 'failed';
        if (entry?.id) task.workerId = entry.id;
        if (entry && 'artifact' in entry && entry.artifact?.id) task.artifactId = entry.artifact.id;
        task.requiresIntegration = !!(entry && 'artifact' in entry && entry.artifact?.fileCount);
      }
      batch.terminal = true;
    }
  }
  snapshot() {
    this.refresh(); const plan = this.plan;
    const paths = (values: string[]) => ({ ownedPathCount: values.length, ownedPaths: values.slice(0, 4).map(value => Buffer.byteLength(value) <= 128 ? value : Buffer.from(value).subarray(0, 124).toString('utf8') + '…'), omittedOwnedPaths: Math.max(0, values.length - 4) });
    const reconciliationRequired = !!plan?.tasks.some(task => task.state === 'unresolved');
    return { state: plan ? 'planned' : 'unplanned', ...(plan ? { planId: plan.id, main: paths(plan.mainPaths), reconciliationRequired,
      tasks: plan.tasks.map(task => ({ id: task.id, state: task.state, ...paths(task.input.ownedPaths!), dependsOn: task.dependsOn,
        ...(task.batchId ? { batchId: task.batchId } : {}), ...(task.workerId ? { workerId: task.workerId } : {}), ...(task.artifactId ? { artifactId: task.artifactId } : {}), ...(task.requiresIntegration ? { requiresIntegration: true } : {}),
        ...(task.state === 'unresolved' ? { reconciliation: 'inspect_retained_artifacts' } : {}),
        ...(task.dependsOn.length ? { deferredReason: 'Review and integrate dependencies, then create a new plan.' } : {}) })) } : {}),
      ...(this.capacity ? { capacity: this.capacity } : {}),
      nextAction: !plan ? 'Declare a main task and independent worker tasks. Empty tasks are valid when no independent work exists.'
        : reconciliationRequired ? 'Inspect retained artifacts for the unresolved batch IDs before explicitly replanning. Do not repeat work based on a missing frontend result.'
        : plan.tasks.some(task => task.state === 'running') ? 'Continue the main task; collect completed artifacts with grunt_worker_result before review/integration.'
          : 'Dispatch ready tasks when capacity permits. Review and integrate results before replanning dependent work. After frontend batch expiry, inspect retained artifacts using workerId.' };
  }
  async execute(raw: unknown, signal: AbortSignal) {
    signal.throwIfAborted(); const input = object(raw);
    if (input.operation === 'plan') {
      this.refresh();
      if (this.dispatching || this.plan?.tasks.some(task => task.state === 'running')) throw new Error('Collect or cancel the running coordination batch before replacing its plan.');
      this.plan = parsePlan(input); this.capacity = undefined; return this.snapshot();
    }
    if (!exact(input, ['operation']) || !['status', 'dispatch'].includes(String(input.operation))) throw new Error('Use plan, status or dispatch. Project and provider overrides are not accepted.');
    this.refresh();
    if (input.operation === 'status') return this.snapshot();
    if (!this.plan) throw new Error('Create a coordination plan before dispatch.');
    if (this.plan.tasks.some(task => task.state === 'unresolved')) return { ...this.snapshot(), dispatch: 'reconciliation_required' };
    if (this.dispatching || this.plan.tasks.some(task => task.state === 'running')) return { ...this.snapshot(), dispatch: 'already_running' };
    const ready = this.plan.tasks.filter(task => task.state === 'pending' && !task.dependsOn.length);
    if (!ready.length) return { ...this.snapshot(), dispatch: 'no_independent_tasks' };
    this.dispatching = true;
    try {
      this.capacity = await this.options.capacity(signal); signal.throwIfAborted();
      const slots = this.capacity.dispatchSlots;
      if (!Number.isSafeInteger(slots) || slots < 0 || slots > 2) throw new Error('Invalid coordination capacity.');
      if (!slots) return { ...this.snapshot(), dispatch: 'capacity_unavailable', nextAction: 'Continue the main task. Wait for natural capacity recovery; do not reset quotas or probe providers.' };
      const selected = ready.slice(0, slots), batch = await this.options.batches.start({ tasks: selected.map(task => task.input).map(({ mode: _mode, ...task }) => task) }, signal);
      this.plan.batches.push({ id: batch.batchId, tasks: selected.map(task => task.id) });
      for (const task of selected) { task.state = 'running'; task.batchId = batch.batchId; }
      return { ...this.snapshot(), dispatch: 'started', batchId: batch.batchId, dispatchedTasks: selected.map(task => task.id) };
    } finally { this.dispatching = false; }
  }
}

const taskProperties = { id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' }, task: { type: 'string', minLength: 1, maxLength: 8192 },
  context: { type: 'string', maxLength: 32768 }, activity: { type: 'string', enum: [...workerActivities] },
  ownedPaths: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } }, dependsOn: { type: 'array', maxItems: 8, items: { type: 'string' } } };
export const gruntCoordinateTool = {
  name: 'grunt_coordinate', label: 'Coordinate independent Grunt work',
  description: 'Plan main-agent work plus up to eight scoped tasks, inspect status, then dispatch at most two independent tasks through existing isolated workers when local metadata leaves capacity for the main agent. Declare disjoint ownership. Dependent tasks stay deferred until their changes are reviewed/integrated and you create a new plan. Never applies artifacts, selects providers, changes quotas or creates project work on its own.',
  promptSnippet: 'Plan independent scoped work, dispatch when capacity permits, and continue the main task',
  parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    operation: { type: 'string', enum: ['plan', 'status', 'dispatch'] }, main: { type: 'object', additionalProperties: false, required: ['task', 'ownedPaths'], properties: { task: taskProperties.task, ownedPaths: { ...taskProperties.ownedPaths, minItems: 0 } } },
    tasks: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['id', 'task', 'ownedPaths'], properties: taskProperties } }
  } }
};

export const COORDINATION_POLICY = '\n\nGrunt execution coordination: At each new work chunk, call grunt_coordinate with operation plan to declare your main task and any genuinely independent scoped tasks. Use an empty tasks list when decomposition would duplicate or conflict with main work. Call dispatch once, then continue your disjoint main task while workers run. Status is nonblocking; collect each completed batch through grunt_worker_result, inspect and integrate retained artifacts before replanning dependent work. Use managed background jobs for long independent verification when enabled. Do not sleep or repeatedly poll to simulate parallel work. Local capacity advice does not authorize provider selection, paid usage, quota resets, account changes, or permission bypasses. Checkpoint pending batch/artifact IDs before ending a work chunk.';
