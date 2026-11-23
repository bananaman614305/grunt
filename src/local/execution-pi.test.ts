import { afterEach, expect, it, vi } from 'vitest';
import type { JobPiContext, PiJobTool } from './jobs-pi.js';
import gruntExecutionExtension from './execution-pi.js';
import { checkpointResumePolicy } from './execution-checkpoint-pi.js';

const host = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./efficiency-host.js', () => ({ loadExecutionHostChannels: host.load }));
function fixture(enabled: string[]) {
  const tools = new Map<string, PiJobTool>();
  const handlers = new Map<string, Array<(event: never, context: JobPiContext) => unknown>>();
  const flags = new Set(enabled);
  gruntExecutionExtension({ registerFlag: vi.fn(), getFlag: name => flags.has(name),
    registerTool: tool => { if (tools.has(tool.name)) throw new Error('Duplicate tool'); tools.set(tool.name, tool); },
    exec: vi.fn(), on: ((event: string, handler: (event: never, context: JobPiContext) => unknown) => {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
    }) as never });
  const context = { cwd: '/synthetic/project', sessionManager: { getSessionId: () => 'saved-session' } };
  return { tools, flags, async start() { for (const handler of handlers.get('session_start') ?? []) await handler(undefined as never, context); },
    async prompt(text: string) { for (const handler of handlers.get('before_agent_start') ?? []) {
      const result = await handler({ systemPrompt: text } as never, context) as { systemPrompt?: string } | undefined;
      if (result?.systemPrompt !== undefined) text = result.systemPrompt;
    } return text; }, context };
}
afterEach(() => { vi.unstubAllEnvs(); host.load.mockReset(); });

it('keeps host work lazy and composes the checkpoint policy once across resumed sessions', async () => {
  vi.stubEnv('GRUNT_EXECUTION_CHANNEL_FILE', '/synthetic/readonly-channel.json');
  const f = fixture(['grunt-background-jobs', 'grunt-checkpoints', 'grunt-publication']);
  await f.start(); await f.start();
  for (const name of ['grunt_job_start', 'grunt_checkpoint_resume', 'grunt_verify_release', 'grunt_release_prepare']) expect(f.tools.has(name)).toBe(true);
  expect(host.load).not.toHaveBeenCalled();
  const original = 'Original task and permissions.';
  const prompt = await f.prompt(original);
  expect(prompt.startsWith(original)).toBe(true);
  expect(prompt).toContain(checkpointResumePolicy);
  expect(await f.prompt(prompt)).toBe(prompt);
  f.flags.clear(); expect(await f.prompt(original)).toBe(original);
  await expect(f.tools.get('grunt_release_prepare')!.execute('call', {}, undefined, undefined, f.context)).rejects.toThrow('trusted');
  expect(host.load).not.toHaveBeenCalled();
});

it('never enables publication or release verification from flags without a trusted channel', async () => {
  vi.stubEnv('GRUNT_EXECUTION_CHANNEL_FILE', '');
  const f = fixture(['grunt-publication', 'grunt-background-jobs']); await f.start();
  expect(f.tools.has('grunt_release_prepare')).toBe(false); expect(f.tools.has('grunt_verify_release')).toBe(false);
  expect(host.load).not.toHaveBeenCalled();
});

it('passes the live harness context through the constrained channel and can recover a failed lazy load', async () => {
  vi.stubEnv('GRUNT_EXECUTION_CHANNEL_FILE', '/synthetic/readonly-channel.json');
  const request = vi.fn(async () => ({ id: 'synthetic-request', phase: 'queued' }));
  host.load.mockRejectedValueOnce(new Error('Channel not mounted')).mockResolvedValue({ publicationChannel: { request } });
  const f = fixture(['grunt-publication']); await f.start();
  const tool = f.tools.get('grunt_release_prepare')!, signal = new AbortController().signal;
  await expect(tool.execute('first', {}, signal, undefined, f.context)).rejects.toThrow('not mounted');
  expect((await tool.execute('second', { head: 'candidate' }, signal, undefined, f.context)).details).toMatchObject({ phase: 'queued' });
  expect(request).toHaveBeenCalledExactlyOnceWith('prepare', { head: 'candidate' }, f.context, signal);
  expect(host.load).toHaveBeenCalledTimes(2);
});
