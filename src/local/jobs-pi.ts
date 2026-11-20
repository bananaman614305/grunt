import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createPiJobRunner, JOB_CATEGORIES, JobScheduler, jobsStateDirectory } from './jobs.js';
import type { JobExec } from './jobs.js';

export const BACKGROUND_JOBS_FLAG = 'grunt-background-jobs';
export interface JobPiContext { cwd: string; sessionManager?: { getSessionId(): string } }
export interface PiJobTool {
  name: string; label: string; description: string; promptSnippet: string; parameters: object;
  execute(id: string, input: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: JobPiContext): Promise<{ content: { type: 'text'; text: string }[]; details: unknown }>;
}
export interface JobPiExtension {
  registerFlag(name: string, options: { type: 'boolean'; default?: boolean; description: string }): void;
  getFlag(name: string): string | boolean | undefined;
  registerTool(tool: PiJobTool): void;
  exec: JobExec;
  on(event: 'session_start', handler: (event: unknown, context: JobPiContext) => Promise<void> | void): void;
  on(event: 'session_shutdown', handler: () => Promise<void>): void;
  on(event: 'tool_call', handler: (event: { toolName: string; input?: unknown }) => { block: true; reason: string } | undefined): void;
}
export interface JobPiOptions { stateDirectory?: string; helperEntry?: string; scheduler?: (sessionId: string) => Promise<JobScheduler> }
const noArgs = { type: 'object', additionalProperties: false, properties: {} };
const idArgs = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'The id returned by grunt_job_start.' } } };
const waitArgs = { ...idArgs, properties: { ...idArgs.properties, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120 } } };
const startArgs = { type: 'object', additionalProperties: false, required: ['command'], properties: {
  command: { type: 'string', minLength: 1, maxLength: 8192, description: 'A command in the current coding interface working directory.' },
  category: { type: 'string', enum: JOB_CATEGORIES }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800 }
} };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Deliberately conservative: only simple top-level delay/control commands, never code, quoting, pipelines or loops. */
export function blockingSleepSeconds(command: unknown): number | undefined {
  if (typeof command !== 'string' || command.length > 8192 || /["'`$\\{}()<>|&]/.test(command)) return;
  const commands = command.trim().split(/[;\n]+/).map(part => part.trim()).filter(Boolean);
  if (!commands.length || commands.length > 8) return;
  let seconds = 0;
  for (const part of commands) {
    const delay = /^sleep\s+(\d+(?:\.\d+)?)([smh]?)$/.exec(part);
    if (delay) { seconds += Number(delay[1]) * (delay[2] === 'h' ? 3600 : delay[2] === 'm' ? 60 : 1); continue; }
    if (/^(?:date(?:\s+-[a-zA-Z0-9]+)*|true|:)\s*$/.test(part)) continue;
    return;
  }
  return seconds > 10 && Number.isFinite(seconds) ? seconds : undefined;
}

/** Opt-in local tools. Their custom tool_call approval rules apply; they do not inherit bash-name-only approvals. */
export function registerJobTools(pi: JobPiExtension, options: JobPiOptions = {}) {
  pi.registerFlag(BACKGROUND_JOBS_FLAG, { type: 'boolean', default: false, description: 'Enable session-owned background command jobs in the current coding interface permissions. Configure approval rules for grunt_job_start.' });
  let registered = false; let sessionId: string = randomUUID();
  const schedulers = new Map<string, Promise<JobScheduler>>();
  const enabled = () => pi.getFlag(BACKGROUND_JOBS_FLAG) === true;
  const scheduler = (context?: JobPiContext) => {
    if (!enabled()) throw new Error('Background jobs require the trusted --grunt-background-jobs launch flag.');
    if (!context || !isAbsolute(context.cwd)) throw new Error('The current coding interface must supply the working directory.');
    const id = context.sessionManager?.getSessionId() ?? sessionId;
    let pending = schedulers.get(id);
    if (!pending) {
      pending = options.scheduler?.(id) ?? JobScheduler.open({ sessionId: id, stateDirectory: options.stateDirectory ?? jobsStateDirectory(), runner: createPiJobRunner(pi.exec.bind(pi), options.helperEntry ? { helperEntry: options.helperEntry } : {}) });
      schedulers.set(id, pending);
      void pending.catch(() => { schedulers.delete(id); });
    }
    return pending;
  };
  const register = (name: string, label: string, description: string, promptSnippet: string, parameters: object, handle: (input: unknown, context?: JobPiContext, signal?: AbortSignal) => Promise<unknown>) => {
    pi.registerTool({ name, label, description, promptSnippet, parameters,
      async execute(_id, input, signal, _onUpdate, context) {
        signal?.throwIfAborted();
        if (!enabled()) throw new Error('Background jobs are disabled for this launch.');
        const details = await handle(input, context, signal);
        if (signal?.aborted) { if (name === 'grunt_job_start') (await scheduler(context)).cancel({ id: record(details).id }); signal.throwIfAborted(); }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
    });
  };
  pi.on('session_start', (_event, context) => {
    // Pi populates CLI flags after loading extension factories. Dynamic tool registration refreshes its tool set.
    if (!enabled() || registered) return;
    sessionId = context.sessionManager?.getSessionId() ?? sessionId;
    register('grunt_job_start', 'Start background job', 'Start a bounded command job using the current interface working directory and permissions. This custom tool requires its own approval policy. Returns immediately so you can continue independent work. Never use this to change accounts or bypass permissions.', 'Start long tests, builds and renders in the background; continue other work', startArgs,
      async (input, ctx) => (await scheduler(ctx)).start(input, ctx!.cwd));
    register('grunt_job_status', 'Background job status', 'Read safe queued, running and recent job metadata without waiting or retrieving command output.', 'Check background work without sleeping', noArgs,
      async (input, ctx) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(record(input)).length) throw new Error('Job status accepts no arguments.'); return (await scheduler(ctx)).snapshot(); });
    register('grunt_job_result', 'Background job result', 'Retrieve one job status and its bounded command output. A running job returns immediately; keep working instead of waiting in a shell.', 'Collect a completed job result before using its outcome', idArgs,
      async (input, ctx) => (await scheduler(ctx)).result(input));
    register('grunt_job_wait', 'Wait for blocked background work', 'Wait up to 120 seconds for one job only when all independent useful work is blocked. Completion wakes this tool without polling or shell sleep. Timeout returns current status; it does not cancel the job. Collect or cancel owned jobs before ending a session.', 'Wait for a blocking job only after exhausting ready independent work', waitArgs,
      async (input, ctx, signal) => {
        const value = record(input), timeoutSeconds = value.timeoutSeconds ?? 30;
        if (Object.keys(value).some(key => !['id', 'timeoutSeconds'].includes(key)) || !Number.isSafeInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 120) throw new Error('Wait from 1 to 120 seconds for an existing job.');
        return (await scheduler(ctx)).wait({ id: value.id }, { timeoutMs: Number(timeoutSeconds) * 1000, ...(signal ? { signal } : {}), track: true });
      });
    register('grunt_job_cancel', 'Cancel background job', 'Cancel an owned session job and its process group without touching other sessions or processes.', 'Cancel background work that is no longer needed', idArgs,
      async (input, ctx) => (await scheduler(ctx)).cancel(input));
    registered = true;
  });
  pi.on('tool_call', event => {
    if (!enabled() || !registered || event.toolName !== 'bash') return;
    const seconds = blockingSleepSeconds(record(event.input).command);
    if (seconds === undefined) return;
    return { block: true, reason: `This foreground command contains ${Math.round(seconds)} seconds of explicit waiting. Use grunt_job_start for background work and continue an independent task. If all useful work is blocked on quota, checkpoint and let the supervisor wait for the known reset instead.` };
  });
  pi.on('session_shutdown', async () => { const pending = [...schedulers.values()]; schedulers.clear(); await Promise.allSettled(pending.map(async store => (await store).close())); });
}
