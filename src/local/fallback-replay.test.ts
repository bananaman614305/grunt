import { afterEach, expect, it, vi } from 'vitest';
import { createReplaySource, currentReplayRuntime, fallbackReplayScenarios, runFallbackReplay } from './fallback-replay.js';
import type { FallbackReplayScenario } from './fallback-replay.js';
import { Sources } from './source.js';

const request = { model: 'grunt', cwd: '/tmp', stream: false, tools: [], messages: [{ role: 'user', content: 'Synthetic only.' }] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('distinguishes useful progress from heartbeats, and cleans up after a stalled stream', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = createReplaySource('openference', [{ durationMs: 100, outcome: 'passed', completion: { text: 'too late' },
    progress: [{ atMs: 1, kind: 'meaningful' }, ...[5, 10, 15, 20].map(atMs => ({ atMs, kind: 'heartbeat' as const }))] }], { reportsProgress: true });
  const second = createReplaySource('runcrate', [{ durationMs: 1, outcome: 'passed', completion: { text: 'verified' } }]);
  const pool = new Sources([first.source, second.source], undefined, new Set(), 12);
  try {
    const work = pool.complete(request, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(work).resolves.toEqual({ text: 'verified' });
    expect(first.observation.meaningfulProgressEvents).toBe(1);
    expect(first.observation.heartbeatEvents).toBe(2);
    expect(first.observation.attempts[0]).toMatchObject({ outcome: 'cancelled', errorCode: 'timeout' });
    expect(first.observation.activeAttempts).toBe(0); expect(first.observation.activeTimers).toBe(0);
    expect(second.observation.attemptsFinished).toBe(1);
  } finally { await pool.close(); }
});

it('keeps healthy slow progress and opaque native replies under their original deadline semantics', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const selected = fallbackReplayScenarios.filter(scenario => ['healthy-slow-progress', 'opaque-native-turn-limit'].includes(scenario.id));
  const work = runFallbackReplay(currentReplayRuntime, selected);
  await vi.runAllTimersAsync();
  const result = await work;
  expect(result.tasks.map(task => [task.id, task.outcome, task.attempts])).toEqual([
    ['opaque-native-turn-limit', 'passed', 2], ['healthy-slow-progress', 'passed', 1]
  ]);
  expect(result.tasks.every(task => task.cleanupComplete)).toBe(true);
});

it('keeps incorrect answers, failures and deadlines in the batch denominator and separates quota hints', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const failure: FallbackReplayScenario = { id: 'all-failed', expectedText: 'verified', firstOutputMs: 10, deadlineMs: 100,
    sources: [{ id: 'numes', attempts: [{ durationMs: 2, outcome: 'failed', errorCode: 'upstream' }] }] };
  const work = runFallbackReplay(currentReplayRuntime, [...fallbackReplayScenarios, failure]);
  await vi.runAllTimersAsync();
  const result = await work;
  expect(result.totalTasks).toBe(7); expect(result.completedTasks).toBe(4); expect(result.completionRate).toBe(4 / 7);
  expect(result.tasks.find(task => task.id === 'incorrect-fast-answer')?.outcome).toBe('incorrect');
  expect(result.tasks.find(task => task.id === 'deadline-kept-in-denominator')?.outcome).toBe('timed_out');
  expect(result.tasks.find(task => task.id === 'all-failed')?.outcome).toBe('failed');
  expect(result.tasks.find(task => task.id === 'quota-then-success')).toMatchObject({ quotaAttempts: 1, advertisedQuotaWaitSeconds: 3600, attempts: 2 });
  expect(result.tasks.every(task => task.cleanupComplete)).toBe(true);
  expect(result.verifiedTasksPerHour).toBeGreaterThan(0);
});

it('caller cancellation and close settle the attempt and clear every owned timer', async () => {
  vi.useFakeTimers();
  const replay = createReplaySource('mistral-vibe', [{ durationMs: 100, outcome: 'passed', completion: { text: 'answer' },
    progress: [{ atMs: 50, kind: 'heartbeat' }] }]);
  const controller = new AbortController(), reason = new Error('Synthetic cancelled.');
  const result = replay.source.complete(request, controller.signal).catch(error => error);
  expect(replay.observation.activeTimers).toBe(2);
  controller.abort(reason);
  expect(await result).toBe(reason);
  await replay.source.close?.();
  expect(replay.observation).toMatchObject({ activeTimers: 0, activeAttempts: 0, attemptsStarted: 1, attemptsFinished: 1 });
  await vi.runAllTimersAsync(); expect(replay.observation.heartbeatEvents).toBe(0);
});

it('pins fixtures, rejects invalid bounds, and never requests network access', async () => {
  vi.useFakeTimers();
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed.'));
  const fixture = [{ durationMs: 1, outcome: 'passed' as const, completion: { text: 'pinned' } }];
  const replay = createReplaySource('numes', fixture); fixture[0]!.completion.text = 'mutated';
  const work = replay.source.complete(request, new AbortController().signal);
  await vi.runAllTimersAsync(); await expect(work).resolves.toEqual({ text: 'pinned' });
  await replay.source.close?.(); expect(network).not.toHaveBeenCalled();
  expect(() => createReplaySource('url/secret', fixture)).toThrow('Invalid');
  expect(() => createReplaySource('numes', [{ durationMs: Infinity, outcome: 'failed' }])).toThrow('Invalid');
  expect(() => createReplaySource('numes', [{ durationMs: 1, outcome: 'passed' }])).toThrow('Invalid');
  await expect(runFallbackReplay(currentReplayRuntime, [])).rejects.toThrow('Invalid');
});
