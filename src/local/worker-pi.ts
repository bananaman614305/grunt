import { AgentWorkerBatches, gruntSpawnTool } from './worker-agent-client.js';
import { registerJobTools } from './jobs-pi.js';
import type { JobPiContext, JobPiExtension } from './jobs-pi.js';
import { gruntDelegateTool, gruntWorkerCancelTool, gruntWorkerResultTool, gruntWorkerStatusTool, readWorkerStatus, resolveWorkerPort, WorkerBatches } from './worker-client.js';

interface PiWorkerTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: object;
  execute(id: string, input: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: JobPiContext): Promise<{
    content: { type: 'text'; text: string }[];
    details: unknown;
  }>;
}

interface PiWorkerExtension extends Omit<JobPiExtension, 'registerFlag'> {
  registerFlag(name: string, options: { type: 'string' | 'boolean'; default?: boolean; description: string }): void;
  getFlag(name: string): string | boolean | undefined;
  registerTool(tool: PiWorkerTool): void;
}

export const AGENT_WORKERS_FLAG = 'grunt-agent-workers';
const portFlag = 'grunt-worker-port';

export default function gruntWorkerExtension(pi: PiWorkerExtension) {
  registerJobTools(pi);
  pi.registerFlag(AGENT_WORKERS_FLAG, { type: 'boolean', default: false, description: 'Enable isolated tool-using workers scoped to the current project. Review custom tool approval rules for grunt_spawn.' });
  const agentBatches = new Map<string, Promise<AgentWorkerBatches>>();
  const agentStore = (ctx?: JobPiContext) => {
    if (pi.getFlag(AGENT_WORKERS_FLAG) !== true || !ctx) throw new Error('Scoped workers require --grunt-agent-workers and a harness project directory.');
    let store = agentBatches.get(ctx.cwd);
    if (!store) { store = port().then(value => new AgentWorkerBatches(value, ctx.cwd)).catch((error: unknown) => { agentBatches.delete(ctx.cwd); throw error; }); agentBatches.set(ctx.cwd, store); }
    return store;
  };
  let agentRegistered = false;
  pi.on('session_start', () => {
    if (pi.getFlag(AGENT_WORKERS_FLAG) !== true || agentRegistered) return;
    pi.registerTool({ name: gruntSpawnTool.name, label: gruntSpawnTool.annotations.title, description: gruntSpawnTool.description, promptSnippet: 'Delegate independent scoped edits to tool-using free-source workers and continue working', parameters: gruntSpawnTool.inputSchema,
      async execute(_id, input, signal = new AbortController().signal, _update, ctx) {
        signal.throwIfAborted();
        const details = await (await agentStore(ctx)).start(input, signal);
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } });
    agentRegistered = true;
  });
  const agentBatch = async (input: unknown) => {
    for (const pending of agentBatches.values()) { const store = await pending; if (store.has(input)) return store; }
    return undefined;
  };
  pi.registerFlag(portFlag, { type: 'string', description: 'Local Grunt daemon port for subworkers' });

  const port = () => {
    const value = pi.getFlag(portFlag);
    return resolveWorkerPort(typeof value === 'string' ? ['--port', value] : []);
  };
  let pending: Promise<WorkerBatches> | undefined;
  const batches = () => pending ??= port().then(value => new WorkerBatches(value)).catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  pi.on('session_shutdown', async () => {
    await Promise.allSettled([...agentBatches.values()].map(async store => (await store).close()));
    agentBatches.clear();
    const old = pending;
    pending = undefined;
    await old?.then(store => store.close(), () => {});
  });
  const register = (tool: typeof gruntDelegateTool | typeof gruntWorkerResultTool | typeof gruntWorkerCancelTool | typeof gruntWorkerStatusTool,
    promptSnippet: string, handle: (input: unknown, signal: AbortSignal) => Promise<unknown>) => {
    pi.registerTool({ name: tool.name, label: tool.annotations.title, description: tool.description, promptSnippet, parameters: tool.inputSchema,
      async execute(_id, input, signal = new AbortController().signal) {
        signal.throwIfAborted();
        const details = await handle(input, signal);
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }
    });
  };
  register(gruntDelegateTool, 'Start up to two independent Grunt subworkers and keep working', async (input, signal) => {
    const store = await batches();
    signal.throwIfAborted();
    return store.start(input);
  });
  register(gruntWorkerResultTool, 'Retrieve results from a batch of Grunt subworkers', async input => (await agentBatch(input) ?? await batches()).result(input));
  register(gruntWorkerCancelTool, 'Cancel pending work in a Grunt subworker batch', async input => (await agentBatch(input) ?? await batches()).cancel(input));
  register(gruntWorkerStatusTool, 'Get local Grunt worker status', async (_input, signal) => readWorkerStatus(await port(), signal));
}
