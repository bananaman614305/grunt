import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_JOBS_FLAG, blockingSleepSeconds, registerJobTools } from './jobs-pi.js';
import type { JobPiContext, JobPiExtension, PiJobTool } from './jobs-pi.js';
import { JobScheduler } from './jobs.js';
const paths: string[] = [], stores: JobScheduler[] = [];
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
function fake(enabled = true) {
  const tools = new Map<string, PiJobTool>(), handlers = new Map<string, (...args: unknown[]) => unknown>();
  let flag = enabled;
  const pi = { registerFlag: vi.fn(), getFlag: vi.fn(() => flag), registerTool: vi.fn((tool: PiJobTool) => tools.set(tool.name, tool)), exec: vi.fn(), on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)) };
  return { pi: pi as unknown as JobPiExtension, raw: pi, tools, handlers, setFlag: (value: boolean) => { flag = value; } };
}
it('requires an explicit launch flag and waits for session_start before registering tools', () => {
  const f = fake(false); registerJobTools(f.pi);
  expect(f.raw.registerFlag).toHaveBeenCalledWith(BACKGROUND_JOBS_FLAG, expect.objectContaining({ type: 'boolean', default: false })); expect(f.tools.size).toBe(0);
  f.handlers.get('session_start')!({}, { cwd: '/tmp' }); expect(f.tools.size).toBe(0);
  expect(f.handlers.get('tool_call')!({ toolName: 'bash', input: { command: 'sleep 900' } })).toBeUndefined();
  f.setFlag(true); f.handlers.get('session_start')!({}, { cwd: '/tmp' }); expect([...f.tools.keys()]).toEqual(['grunt_job_start', 'grunt_job_status', 'grunt_job_result', 'grunt_job_wait', 'grunt_job_cancel']);
});
it('starts asynchronously using only trusted context cwd, then collects and closes owned jobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-pi-jobs-')); paths.push(root);
  let release: (() => void) | undefined, receivedCwd = '';
  const store = await JobScheduler.open({ stateDirectory: root, sessionId: 'fixture', runner: async request => { receivedCwd = request.cwd; await new Promise<void>(resolve => { release = resolve; request.signal.addEventListener('abort', () => resolve()); }); return { stdout: 'done', stderr: '', exitCode: 0 }; } }); stores.push(store);
  const f = fake(); registerJobTools(f.pi, { scheduler: async () => store }); const ctx: JobPiContext = { cwd: root, sessionManager: { getSessionId: () => 'fixture' } }; f.handlers.get('session_start')!({}, ctx);
  const start = await f.tools.get('grunt_job_start')!.execute('call', { command: 'synthetic-command', category: 'test' }, undefined, undefined, ctx);
  const id = (start.details as { id: string }).id; expect(id).toBeTruthy();
  const state = await f.tools.get('grunt_job_result')!.execute('call', { id }, undefined, undefined, ctx); expect(state.details).toMatchObject({ state: 'running' });
  while (!release) await new Promise(r => setTimeout(r, 1)); expect(receivedCwd).toBe(root); release(); await store.wait(id);
  const result = await f.tools.get('grunt_job_result')!.execute('call', { id }, undefined, undefined, ctx); expect(result.details).toMatchObject({ state: 'completed', stdout: 'done' });
  await expect(f.tools.get('grunt_job_start')!.execute('call', { command: 'cmd', cwd: '/unauthorized' }, undefined, undefined, ctx)).rejects.toThrow('working directory');
  f.setFlag(false); await expect(f.tools.get('grunt_job_status')!.execute('call', {}, undefined, undefined, ctx)).rejects.toThrow('disabled'); f.setFlag(true);
  await f.handlers.get('session_shutdown')!();
});
it('does not accept caller-supplied contexts when the interface context is absent', async () => {
  const f = fake(); registerJobTools(f.pi); f.handlers.get('session_start')!({}, { cwd: '/tmp' });
  await expect(f.tools.get('grunt_job_start')!.execute('call', { command: 'ok', cwd: '/tmp' })).rejects.toThrow('working directory');
});
it.each(['sleep 600', 'date -u; sleep 20; date -u', 'sleep 0.5m', 'sleep 5; sleep 6'])('blocks only a known foreground long wait: %s', command => {
  expect(blockingSleepSeconds(command)).toBeGreaterThan(10);
  const f = fake(); registerJobTools(f.pi); f.handlers.get('session_start')!({}, { cwd: '/tmp' }); expect(f.handlers.get('tool_call')!({ toolName: 'bash', input: { command } })).toMatchObject({ block: true });
});
it.each(['sleep 10', 'date -u', 'echo "sleep 600"', "node -e 'setTimeout(()=>{},600000)'", 'npm test', 'while true; do sleep 5; done', 'cat <<EOF\nsleep 600\nEOF', 'printf sleep; sleep 5', 'sleep 5 | cat'])('leaves other shell/code commands alone: %s', command => {
  expect(blockingSleepSeconds(command)).toBeUndefined();
});
it('never treats a background job command as a blocking core bash sleep', () => {
  const f = fake(); registerJobTools(f.pi); f.handlers.get('session_start')!({}, { cwd: '/tmp' }); expect(f.handlers.get('tool_call')!({ toolName: 'grunt_job_start', input: { command: 'sleep 900' } })).toBeUndefined();
});

it('offers bounded event-driven job waits only with validated arguments and propagates tool cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-pi-wait-')); paths.push(root);
  const store = await JobScheduler.open({ stateDirectory: root, sessionId: 'fixture', runner: request => new Promise(resolve => { request.signal.addEventListener('abort', () => resolve({ stdout: '', stderr: '', code: 'cancelled' })); }) }); stores.push(store);
  const f = fake(); registerJobTools(f.pi, { scheduler: async () => store }); const ctx: JobPiContext = { cwd: root }; f.handlers.get('session_start')!({}, ctx);
  const started = await f.tools.get('grunt_job_start')!.execute('call', { command: 'hold' }, undefined, undefined, ctx), id = (started.details as { id: string }).id;
  const wait = f.tools.get('grunt_job_wait')!;
  await expect(wait.execute('call', { id, timeoutSeconds: 121 }, undefined, undefined, ctx)).rejects.toThrow('120');
  const abort = new AbortController(), pending = wait.execute('call', { id, timeoutSeconds: 1 }, abort.signal, undefined, ctx);
  while (!store.snapshot().waiting.length) await new Promise(resolve => setTimeout(resolve, 1));
  abort.abort(new Error('cancel-tool-wait')); await expect(pending).rejects.toThrow('cancel-tool-wait'); expect(store.snapshot().active).toHaveLength(1);
});

it.each(['npm run test:browser', 'cd /tmp/project && pnpm run test:mobile', 'npx playwright test --project=mobile', 'bun run test:e2e'])('redirects a known long verification command into managed jobs: %s', command => {
  const f = fake(); registerJobTools(f.pi); f.handlers.get('session_start')!({}, { cwd: '/tmp' });
  expect(f.handlers.get('tool_call')!({ toolName: 'bash', input: { command } })).toMatchObject({ block: true, reason: expect.stringContaining('grunt_job_start') });
  expect(f.handlers.get('tool_call')!({ toolName: 'grunt_job_start', input: { command } })).toBeUndefined();
});
it.each(['echo "npm run test:browser"', 'node -e "npm run test:browser"', 'npm test', 'npm run test:browser && echo complete', 'printf test:mobile'])('leaves ambiguous or ordinary foreground code alone: %s', command => {
  const f = fake(); registerJobTools(f.pi); f.handlers.get('session_start')!({}, { cwd: '/tmp' });
  expect(f.handlers.get('tool_call')!({ toolName: 'bash', input: { command } })).toBeUndefined();
});
it('never cancels an existing shared check when a deduplicated start caller is cancelled', async () => {
  const controller = new AbortController(), cancel = vi.fn(), start = vi.fn(async () => { controller.abort(new Error('cancel-new-caller')); return { id: 'existing', state: 'running', reused: true }; });
  const scheduler = { start, cancel } as unknown as JobScheduler;
  const f = fake(); registerJobTools(f.pi, { scheduler: async () => scheduler }); const ctx = { cwd: '/tmp' }; f.handlers.get('session_start')!({}, ctx);
  await expect(f.tools.get('grunt_job_start')!.execute('call', { command: 'test' }, controller.signal, undefined, ctx)).rejects.toThrow('cancel-new-caller');
  expect(cancel).not.toHaveBeenCalled();
});
it('exposes host release verification only through a trusted configured broker, with ids and interface context', async () => {
  const f = fake(), broker = { start: vi.fn(async () => ({ id: '12345678-1234-1234-1234-123456789abc', state: 'queued' })), status: vi.fn(async () => ({ state: 'running' })), result: vi.fn(async () => ({ state: 'completed' })) };
  registerJobTools(f.pi, { verificationBroker: broker }); const ctx = { cwd: '/tmp/project' }; f.handlers.get('session_start')!({}, ctx);
  const tool = f.tools.get('grunt_verify_release')!; expect(tool).toBeDefined();
  await expect(tool.execute('call', { planId: 'release', checkId: 'unit', command: 'true' }, undefined, undefined, ctx)).rejects.toThrow('trusted plan');
  await expect(tool.execute('call', { planId: 'release', checkId: 'unit' })).rejects.toThrow('current project');
  await tool.execute('call', { planId: 'release', checkId: 'unit' }, undefined, undefined, ctx); expect(broker.start).toHaveBeenCalledWith({ planId: 'release', checkId: 'unit' }, ctx, undefined);
  await f.tools.get('grunt_verify_release_result')!.execute('call', { id: '12345678-1234-1234-1234-123456789abc' }, undefined, undefined, ctx); expect(broker.result).toHaveBeenCalled();
});
