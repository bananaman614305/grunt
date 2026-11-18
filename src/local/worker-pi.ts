import { gruntDelegateTool, gruntWorkerCancelTool, gruntWorkerResultTool, gruntWorkerStatusTool, readWorkerStatus, resolveWorkerPort, WorkerBatches } from './worker-client.js';

interface PiWorkerTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: object;
  execute(id: string, input: unknown, signal?: AbortSignal): Promise<{
    content: { type: 'text'; text: string }[];
    details: unknown;
  }>;
}

interface PiWorkerExtension {
  registerFlag(name: string, options: { type: 'string'; description: string }): void;
  getFlag(name: string): string | boolean | undefined;
  registerTool(tool: PiWorkerTool): void;
  on(event: 'session_shutdown', handler: () => Promise<void>): void;
}

const portFlag = 'grunt-worker-port';

export default function gruntWorkerExtension(pi: PiWorkerExtension) {
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
  register(gruntWorkerResultTool, 'Retrieve results from a batch of Grunt subworkers', async input => (await batches()).result(input));
  register(gruntWorkerCancelTool, 'Cancel pending work in a Grunt subworker batch', async input => (await batches()).cancel(input));
  register(gruntWorkerStatusTool, 'Get local Grunt worker status', async (_input, signal) => readWorkerStatus(await port(), signal));
}
