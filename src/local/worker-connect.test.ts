import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { workerConnectCommand } from './worker-connect.js';
import gruntWorkerExtension from './worker-pi.js';

let directory: string;
let runtime: string;
const savedPort = 19876;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "grunt setup's "));
  runtime = join(directory, 'runtime', 'dist', 'local');
  await mkdir(runtime, { recursive: true });
  await Promise.all(['main.js', 'worker-client.js', 'worker-pi.js'].map(name => writeFile(join(runtime, name), '', { mode: 0o600 })));
  await writeFile(join(directory, 'installed-port.json'), JSON.stringify(savedPort), { mode: 0o600 });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

const settings = () => ({ env: { GRUNT_CONFIG_DIR: directory }, node: '/path to/node', notify: vi.fn() });

it('configures Codex with the managed runtime, saved port, and a sufficient tool timeout', async () => {
  const options = settings();
  await workerConnectCommand(['codex'], options);
  const output = options.notify.mock.calls[0]![0];
  expect(output).toContain('[mcp_servers.grunt-workers]');
  expect(output).toContain('command = "/path to/node"');
  expect(output).toContain('tool_timeout_sec = 330');
  expect(output).toContain(`args = ${JSON.stringify([join(runtime, 'main.js'), 'workers', 'mcp', '--port', String(savedPort)])}`);
});

it.each(['1.19.5', '2.0.0'])('uses the OpenCode %s layout', async version => {
  const options = settings();
  await workerConnectCommand(['opencode', '--port', '19877'], { ...options, openCodeVersion: async () => version });
  const config = JSON.parse(options.notify.mock.calls[0]![0].split('\n\n')[1]);
  const current = version.startsWith('2.');
  expect((current ? config.mcp.servers : config.mcp)['grunt-workers']).toEqual({
    type: 'local', command: ['/path to/node', join(runtime, 'main.js'), 'workers', 'mcp', '--port', '19877'], timeout: 330000,
    ...(current ? { codemode: false } : { enabled: true })
  });
});

it('gives Pi and Claude commands that safely quote managed paths', async () => {
  const options = settings();
  await workerConnectCommand(['pi'], options);
  await workerConnectCommand(['claude'], options);
  expect(options.notify.mock.calls[0]![0]).toContain(`--extension '${join(runtime, 'worker-pi.js').replaceAll("'", "'\\''")}' --grunt-worker-port ${savedPort}`);
  expect(options.notify.mock.calls[1]![0]).toContain(`claude mcp add --scope user --transport stdio grunt-workers -- '/path to/node' '${join(runtime, 'main.js').replaceAll("'", "'\\''")}' 'workers' 'mcp' '--port' '${savedPort}'`);
});

it('rejects an invalid port and an untrusted or older runtime', async () => {
  const options = settings();
  await expect(workerConnectCommand(['codex', '--port', '65536'], options)).rejects.toThrow('Invalid Grunt port');
  await rm(join(runtime, 'worker-client.js'));
  await expect(workerConnectCommand(['pi'], options)).rejects.toThrow('current managed Grunt runtime');
  await symlink(join(runtime, 'main.js'), join(runtime, 'worker-client.js'));
  await expect(workerConnectCommand(['codex'], options)).rejects.toThrow('current managed Grunt runtime');
  expect(options.notify).not.toHaveBeenCalled();
});

function piFixture() {
  const definitions: Parameters<Parameters<typeof gruntWorkerExtension>[0]['registerTool']>[0][] = [];
  const registerFlag = vi.fn(), on = vi.fn();
  const getFlag = vi.fn(() => '19879');
  gruntWorkerExtension({ registerFlag, getFlag, on, exec: vi.fn(), registerTool: tool => { definitions.push(tool); } });
  const tool = (name: string) => definitions.find(definition => definition.name === name)!;
  expect(registerFlag).toHaveBeenCalledWith('grunt-worker-port', expect.objectContaining({ type: 'string' }));
  expect(on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  return { tool, getFlag, close: async () => { for (const [event, handler] of on.mock.calls) if (event === 'session_shutdown') await handler(); } };
}

it('starts a Pi batch without waiting and returns provider results through a later tool', async () => {
  const { tool, getFlag, close } = piFixture();
  let answer!: (response: Response) => void;
  const provider = new Promise<Response>(resolve => { answer = resolve; });
  const fetcher = vi.fn(async (_url: string, request: RequestInit) => request.method === 'POST'
    ? (await provider).clone() : Response.json({ active: [], queued: [], recent: [] }));
  vi.stubGlobal('fetch', fetcher);
  const start = await tool('grunt_delegate').execute('call', { tasks: [{ task: 'Review this' }, { task: 'Review that' }] });
  const batchId = (start.details as { batchId: string }).batchId;
  expect(start.details).toEqual({ batchId: expect.any(String), state: 'running' });
  const read = () => tool('grunt_worker_result').execute('result', { batchId });
  expect((await read()).details).toEqual({ batchId, state: 'running' });
  expect((await tool('grunt_worker_status').execute('status', {})).details).toEqual({ active: [], queued: [], recent: [] });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'http://127.0.0.1:19879/v1/workers/run', 'http://127.0.0.1:19879/v1/workers/run', 'http://127.0.0.1:19879/v1/workers'
  ]);
  answer(Response.json({ ok: true, id: 'e3b224c8-beb3-4380-a82c-90a93a3fea46', source: 'kilo', text: 'Reviewed' }));
  const reply = expect.objectContaining({ source: 'kilo', text: 'Reviewed' });
  await vi.waitFor(async () => expect((await read()).details).toEqual({ batchId, state: 'completed', results: [reply, reply] }));
  expect(getFlag).toHaveBeenCalledWith('grunt-worker-port');
  await close();
});

it('aborts pending Pi workers when their session closes', async () => {
  const { tool, close } = piFixture();
  const aborted = vi.fn();
  vi.stubGlobal('fetch', vi.fn((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => { aborted(); reject(request.signal?.reason); }, { once: true });
  })));
  await tool('grunt_delegate').execute('call', { tasks: [{ task: 'Review this' }, { task: 'Review that' }] });
  await close();
  expect(aborted).toHaveBeenCalledTimes(2);
});

it('enables agent workers only with explicit trusted project scope for MCP connectors', async () => {
  const options = settings();
  await expect(workerConnectCommand(['codex', '--agentic'], options)).rejects.toThrow('Usage');
  await workerConnectCommand(['codex', '--agentic', '--project', directory], options);
  expect(options.notify.mock.calls.at(-1)![0]).toContain('"--agentic","--project"');
  await workerConnectCommand(['claude', '--agentic', '--project', directory], options);
  expect(options.notify.mock.calls.at(-1)![0]).toContain('mcp add --scope project');
  await workerConnectCommand(['pi', '--agentic'], options);
  expect(options.notify.mock.calls.at(-1)![0]).toContain('--grunt-agent-workers --grunt-background-jobs --grunt-checkpoints');
});

it('registers tool workers at session_start only after the launch flag is enabled', async () => {
  const tools: { name: string }[] = [], handlers = new Map<string, (() => Promise<void> | void)[]>();
  let enabled = false;
  gruntWorkerExtension({ registerFlag: vi.fn(), getFlag: name => name === 'grunt-agent-workers' ? enabled : name === 'grunt-worker-port' ? '8793' : false,
    registerTool: tool => { tools.push(tool); }, exec: vi.fn(), on: (event, handler) => { handlers.set(event, [...handlers.get(event) ?? [], handler as () => Promise<void> | void]); } });
  expect(tools.some(tool => tool.name === 'grunt_spawn')).toBe(false);
  for (const handler of handlers.get('session_start') ?? []) await handler();
  expect(tools.some(tool => tool.name === 'grunt_spawn')).toBe(false);
  enabled = true;
  for (const handler of handlers.get('session_start') ?? []) await handler();
  for (const handler of handlers.get('session_start') ?? []) await handler();
  expect(tools.filter(tool => tool.name === 'grunt_spawn')).toHaveLength(1);
});
