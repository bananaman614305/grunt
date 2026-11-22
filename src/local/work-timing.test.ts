import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkTimingObserver, measureWorkTiming, startWorkTiming } from './work-timing.js';
import type { DiagnosticEvent } from './diagnostics.js';
import type { WorkTimingObserver } from './work-timing.js';

it('correlates nested stages with monotonic durations without recording work contents', async () => {
  const events: DiagnosticEvent[] = []; let wall = 1000, elapsed = 0;
  const timing = createWorkTimingObserver({ sink: { record: event => events.push(event) }, now: () => wall, monotonicNow: () => elapsed, runtimeVersion: '0.9.6' });
  const parentId = randomUUID();
  const value = await measureWorkTiming('tool', async () => {
    elapsed = 8; wall = 900; // Wall-clock correction must not create negative durations.
    return measureWorkTiming('capture', async () => { elapsed = 13; return 'private-command-output'; });
  }, { timing, parentId });
  expect(value).toBe('private-command-output');
  expect(events.map(e => [e.type, e.stage])).toEqual([['work.start', 'tool'], ['work.start', 'capture'], ['work.finish', 'capture'], ['work.finish', 'tool']]);
  expect(events[0]).toMatchObject({ parentId, actor: 'worker', runtimeVersion: '0.9.6' });
  expect(events[1]?.parentId).toBe(events[0]?.requestId);
  expect(events[2]).toMatchObject({ durationMs: 5, outcome: 'passed' });
  expect(events[3]).toMatchObject({ durationMs: 13, outcome: 'passed' });
  expect(JSON.stringify(events)).not.toContain('private-command-output');
});

it('records one terminal outcome for failure and cancellation while preserving the original error', async () => {
  const events: DiagnosticEvent[] = [], timing = createWorkTimingObserver({ sink: { record: e => events.push(e) } });
  const failure = new Error('private failure');
  await expect(measureWorkTiming('checkpoint', async () => { throw failure; }, { timing })).rejects.toBe(failure);
  const controller = new AbortController();
  await expect(measureWorkTiming('collection', async () => { controller.abort(failure); throw failure; }, { timing, signal: controller.signal })).rejects.toBe(failure);
  expect(events.filter(e => e.type === 'work.finish').map(e => e.outcome)).toEqual(['failed', 'cancelled']);
  expect(JSON.stringify(events)).not.toContain('private failure');
  const span = startWorkTiming('verification', { timing, workDisposition: 'deduplicated' }); span.finish('skipped'); span.finish('passed');
  expect(events.filter(e => e.requestId === span.id && e.type === 'work.finish')).toEqual([expect.objectContaining({ outcome: 'skipped', workDisposition: 'deduplicated' })]);
});

it('does not allow a failing observer or clock to alter execution', async () => {
  const expected = new Error('actual work failed');
  const timing = createWorkTimingObserver({ sink: { record() { throw Error('storage failed'); } } });
  expect(await measureWorkTiming('tool', async () => 42, { timing })).toBe(42);
  await expect(measureWorkTiming('tool', async () => { throw expected; }, { timing })).rejects.toBe(expected);
  const broken: WorkTimingObserver = { start() { throw Error('observer failed'); } };
  expect(await measureWorkTiming('tool', async () => 7, { timing: broken })).toBe(7);
  const invalidSpan: WorkTimingObserver = { start() { return { get id(): string { throw Error('getter'); }, finish() { throw Error('finish'); }, run() { throw Error('observer must not wrap execution'); } }; } };
  let executions = 0;
  expect(await measureWorkTiming('tool', async () => ++executions, { timing: invalidSpan })).toBe(1); expect(executions).toBe(1);
  const clock = createWorkTimingObserver({ sink: { record() { throw Error('never'); } }, now() { throw Error('clock'); }, monotonicNow() { throw Error('clock'); } });
  expect(await measureWorkTiming('setup', async () => 9, { timing: clock })).toBe(9);
});

it('has no observation or task completion inference when no observer is configured', async () => {
  expect(await measureWorkTiming('tool', async () => ({ exitCode: 0 }))).toEqual({ exitCode: 0 });
});
