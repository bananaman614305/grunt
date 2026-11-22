import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { registerCheckpointTools, CHECKPOINTS_FLAG } from './execution-checkpoint-pi.js';
import type { CheckpointPiExtension } from './execution-checkpoint-pi.js';
import type { PiJobTool } from './jobs-pi.js';
import { createWorkTimingObserver } from './work-timing.js';
import type { DiagnosticEvent } from './diagnostics.js';
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
function fake(enabled = true) {
  const tools = new Map<string, PiJobTool>(), handlers = new Map<string, (...args: unknown[]) => unknown>(); let flag = enabled;
  const pi = { registerFlag: vi.fn(), getFlag: vi.fn(() => flag), registerTool: vi.fn((t: PiJobTool) => tools.set(t.name, t)), on: vi.fn((n: string, f: (...args: unknown[]) => unknown) => handlers.set(n, f)) };
  return { pi: pi as unknown as CheckpointPiExtension, tools, handlers, raw: pi, setFlag: (v: boolean) => { flag = v; } };
}
it('registers three custom tools only after trusted flag/session_start, never changes original system prompts', () => {
  const f = fake(false); registerCheckpointTools(f.pi); expect(f.raw.registerFlag).toHaveBeenCalledWith(CHECKPOINTS_FLAG, expect.objectContaining({ default: false }));
  f.handlers.get('session_start')!({}, { cwd: '/tmp' }); expect(f.tools.size).toBe(0);
  f.setFlag(true); f.handlers.get('session_start')!({}, { cwd: '/tmp' }); expect([...f.tools.keys()]).toEqual(['grunt_checkpoint_write', 'grunt_checkpoint_read', 'grunt_checkpoint_resume']);
  expect([...f.handlers.keys()]).toEqual(['before_agent_start', 'session_start']);
  const original = 'SYSTEM: preserve every word\nUSER: exact goal and requirements';
  expect(f.handlers.get('before_agent_start')!({ systemPrompt: original }, { cwd: '/tmp' })).toMatchObject({ systemPrompt: expect.stringMatching(/^SYSTEM: preserve every word\nUSER: exact goal and requirements/) });
  const extended = f.handlers.get('before_agent_start')!({ systemPrompt: original }, { cwd: '/tmp' }) as { systemPrompt: string };
  expect(f.handlers.get('before_agent_start')!({ systemPrompt: extended.systemPrompt }, { cwd: '/tmp' })).toBeUndefined();
  f.setFlag(false); expect(f.handlers.get('before_agent_start')!({ systemPrompt: original }, { cwd: '/tmp' })).toBeUndefined();
});
it('uses only harness cwd/session, returns private write metadata and focused tool-result data on explicit resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-checkpoint-pi-')); paths.push(root); const cwd = join(root, 'project'); await mkdir(cwd); await writeFile(join(cwd, 'src.txt'), 'existing source');
  const events: DiagnosticEvent[] = [], timing = createWorkTimingObserver({ sink: { record: e => events.push(e) } });
  const f = fake(); registerCheckpointTools(f.pi, { stateDirectory: join(root, 'state'), timing }); const context = { cwd, sessionManager: { getSessionId: () => 'fixture' } };
  f.handlers.get('session_start')!({}, context);
  const value = { taskId: 'work', expectedRevision: 0, goal: 'Synthetic task', requirements: ['preserve A'], nextAction: 'collect', files: ['src.txt'], facts: [{ id: 'detail', text: 'private selected fact' }] };
  const saved = await f.tools.get('grunt_checkpoint_write')!.execute('call', value, undefined, undefined, context); expect(saved.details).toMatchObject({ revision: 1, testsOrReviewAttested: false }); expect(JSON.stringify(saved)).not.toContain('private selected fact');
  const listed = await f.tools.get('grunt_checkpoint_read')!.execute('call', {}, undefined, undefined, context); expect(listed.details).toMatchObject({ tasks: [{ taskId: 'work', revision: 1 }] }); expect(JSON.stringify(listed)).not.toContain('private selected fact');
  const read = await f.tools.get('grunt_checkpoint_read')!.execute('call', { taskId: 'work' }, undefined, undefined, context); expect(read.details).toMatchObject({ revision: 1, factIds: ['detail'] }); expect(JSON.stringify(read)).not.toContain('private selected fact');
  const resumed = await f.tools.get('grunt_checkpoint_resume')!.execute('call', { taskId: 'work', factIds: ['detail'] }, undefined, undefined, context); expect(resumed.details).toMatchObject({ authority: 'untrusted-checkpoint-data', context: { facts: [{ text: 'private selected fact' }] } });
  await expect(f.tools.get('grunt_checkpoint_write')!.execute('call', { ...value, cwd: '/unauthorized' }, undefined, undefined, context)).rejects.toThrow();
  await expect(f.tools.get('grunt_checkpoint_read')!.execute('call', { taskId: 'work' })).rejects.toThrow('current coding-interface');
  f.setFlag(false); await expect(f.tools.get('grunt_checkpoint_read')!.execute('call', { taskId: 'work' }, undefined, undefined, context)).rejects.toThrow();
  expect(events.filter(e => e.type === 'work.finish' && e.stage === 'checkpoint').map(e => [e.workOperation, e.outcome])).toEqual([['checkpoint_write', 'passed'], ['checkpoint_read', 'passed'], ['checkpoint_read', 'passed'], ['checkpoint_resume', 'passed'], ['checkpoint_write', 'failed']]);
  expect(JSON.stringify(events)).not.toContain('private selected fact'); expect(JSON.stringify(events)).not.toContain(cwd);
  expect(events.some(e => e.stage === 'task')).toBe(false);
});
it('does no state work when the tool was cancelled before execution', async () => {
  const f = fake(), store = vi.fn(); registerCheckpointTools(f.pi, { store }); f.handlers.get('session_start')!({}, { cwd: '/tmp' });
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await expect(f.tools.get('grunt_checkpoint_read')!.execute('call', { taskId: 'work' }, controller.signal, undefined, { cwd: '/tmp' })).rejects.toThrow('stop'); expect(store).not.toHaveBeenCalled();
});
