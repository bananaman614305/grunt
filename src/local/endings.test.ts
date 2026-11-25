import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiagnosticsStore, sanitizeDiagnosticEvent, withDiagnosticContext } from './diagnostics.js';
import { SourceStatus } from './source-status.js';
import { SourceError, completionEnding, endingOf, guardToolCalls, withEnding } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';
import { uploadFleet } from './fleet-upload.js';
import { validateAdminEvent } from '../admin/types.js';
import { HOUR } from '../fleet.js';

const directories: string[] = [], stores: DiagnosticsStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); vi.restoreAllMocks(); });
const dir = async () => { const d = await mkdtemp(join(await realpath(tmpdir()), 'grunt-endings-')); directories.push(d); return d; };
const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], cwd: '/private', stream: false, tools: [] };
const call = { id: 'call_1', type: 'function' as const, function: { name: 'probe', arguments: '{}' } };
const source = (reply: () => Completion): Source => ({ id: 'kilo', available: async () => true, complete: async () => reply() });

it('maps finish reasons to a fixed set and keeps no raw provider string', () => {
  expect(completionEnding('stop', {}, false)).toEqual({ finish: 'stop', toolCalls: false });
  expect(completionEnding('tool_calls', {}, true)).toEqual({ finish: 'tool_calls', toolCalls: true });
  expect(completionEnding('max_tokens', {}, false).finish).toBe('length');
  for (const raw of ['PRIVATE_SECRET_REASON', 'eos', 7, {}, '']) expect(completionEnding(raw, {}, false)).toEqual({ finish: 'other', toolCalls: false });
  expect(completionEnding(null, {}, false)).toEqual({ toolCalls: false });
  expect(completionEnding('stop', { completion_tokens_details: { reasoning_tokens: 42 } }, false).reasoningTokens).toBe(42);
  expect(completionEnding('stop', { completion_tokens_details: { reasoning_tokens: -1 } }, false)).not.toHaveProperty('reasoningTokens');
  expect(completionEnding('stop', { completion_tokens_details: { reasoning_tokens: '9' } }, false)).not.toHaveProperty('reasoningTokens');
});
it('records content-free endings on a successful attempt and lists them per attempt', async () => {
  const journal = await DiagnosticsStore.open({ directory: await dir() }); stores.push(journal);
  const status = new SourceStatus(['kilo']); status.setDiagnostics(journal);
  const requestId = randomUUID();
  await withDiagnosticContext({ requestId, kind: 'user' }, () => status.complete(source(() => withEnding({ text: 'PRIVATE_ANSWER', free: true, servedModel: 'm/free', inputTokens: 3, outputTokens: 4 },
    completionEnding('PRIVATE_SECRET_REASON', { completion_tokens_details: { reasoning_tokens: 2 } }, false))), request, new AbortController().signal));
  await withDiagnosticContext({ requestId: randomUUID(), kind: 'user' }, () => status.complete(source(() => ({ text: 'plain' })), request, new AbortController().signal));
  const { events } = await journal.list();
  const finished = events.filter(e => e.type === 'attempt.finish');
  expect(finished[0]).toMatchObject({ outcome: 'passed', model: 'm/free', finishReason: 'other', hadToolCalls: false, reasoningTokens: 2 });
  // An adapter that reports nothing records nothing new.
  expect(finished[1]).not.toHaveProperty('finishReason'); expect(finished[1]).not.toHaveProperty('hadToolCalls'); expect(finished[1]).not.toHaveProperty('reasoningTokens');
  const stored = JSON.stringify(events);
  expect(stored).not.toContain('PRIVATE'); expect(stored).not.toContain('call_1');
  expect((await journal.trace(requestId)).events.find(e => e.type === 'attempt.finish')).toMatchObject({ finishReason: 'other' });
  expect(sanitizeDiagnosticEvent({ ...finished[0], finishReason: 'PRIVATE_SECRET_REASON', hadToolCalls: 'yes', reasoningTokens: -3 })).not.toHaveProperty('finishReason');
});
it('rejects a tool-call ending with no call as an invalid sample, and leaves text stops alone', () => {
  const ended = (finish: string, extra: Partial<Completion> = {}) => withEnding({ text: 'I will call it now', inputTokens: 5, outputTokens: 9, ...extra }, completionEnding(finish, {}, false));
  for (const finish of ['tool_calls', 'function_call']) {
    expect(() => guardToolCalls(ended(finish), {})).toThrow(SourceError);
    try { guardToolCalls(ended(finish), {}); } catch (error) {
      expect(error).toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'response_tools', httpStatus: 200 } });
      expect((error as Error).message).not.toContain('I will call');
    }
  }
  for (const finish of ['stop', 'content_filter', 'other', 'length']) { const reply = ended(finish); expect(guardToolCalls(reply, {})).toBe(reply); }
  const unknown: Completion = { text: 'No ending reported' }; expect(guardToolCalls(unknown, {})).toBe(unknown);
  const withCall = withEnding({ text: '', calls: [call] }, completionEnding('tool_calls', {}, true)); expect(guardToolCalls(withCall, {})).toBe(withCall);
  // At its output budget the reply was cut off, not malformed.
  const cut = guardToolCalls(ended('tool_calls'), { maxTokens: 9 });
  expect(cut).toMatchObject({ text: 'I will call it now', finishReason: 'length' }); expect(endingOf(cut)?.finish).toBe('length');
});
it('reaches the pool as a failed attempt that is not a provider outage', async () => {
  const journal = await DiagnosticsStore.open({ directory: await dir() }); stores.push(journal);
  const status = new SourceStatus(['kilo']); status.setDiagnostics(journal);
  await expect(withDiagnosticContext({ requestId: randomUUID(), kind: 'user' }, () => status.complete(source(() => withEnding({ text: 'x' }, completionEnding('tool_calls', {}, false))), request, new AbortController().signal)))
    .rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'response_tools', httpStatus: 200 } });
  expect((await journal.list()).events.find(e => e.type === 'attempt.finish')).toMatchObject({ outcome: 'failed', errorCode: 'upstream', failureReason: 'response_tools', httpStatus: 200 });
});
it('keeps endings out of fleet uploads and the collector projection', async () => {
  const end = Math.floor(Date.UTC(2026, 10, 24, 12) / HOUR) * HOUR;
  const bodies: string[] = [], metrics: unknown[] = [];
  vi.spyOn(performance, 'now').mockReturnValue(0);
  for (const withEndings of [false, true]) {
    const directory = await dir(); let now = end - 2 * HOUR + 1000;
    const journal = await DiagnosticsStore.open({ directory, now: () => now, runtimeVersion: '1.2.3' }); stores.push(journal);
    const status = new SourceStatus(['kilo'], () => now); status.setDiagnostics(journal);
    for (const finish of ['stop', 'tool_calls', 'weird']) {
      const reply: Completion = { text: 'a', inputTokens: 1, outputTokens: 2 };
      if (finish === 'tool_calls') reply.calls = [call];
      await withDiagnosticContext({ requestId: randomUUID(), kind: 'user' }, () => status.complete(source(() => withEndings
        ? withEnding({ ...reply }, completionEnding(finish, { completion_tokens_details: { reasoning_tokens: 5 } }, !!reply.calls)) : { ...reply }), request, new AbortController().signal));
    }
    now = end;
    await uploadFleet(journal, directory, ['https://registry.test'], 'a'.repeat(97), end, async (_url, init) => { bodies.push(String(init?.body)); return new Response(null, { status: 204 }); });
    const m = await journal.metrics({ since: end - 2 * HOUR, until: end });
    metrics.push(JSON.parse(JSON.stringify({ buckets: m.buckets, histogram: m.histogram })));
    if (withEndings) {
      const event = (await journal.list()).events.find(e => e.type === 'attempt.finish' && e.finishReason === 'tool_calls')!;
      expect(event).toMatchObject({ hadToolCalls: true, reasoningTokens: 5 });
      expect(validateAdminEvent(event)).not.toHaveProperty('finishReason');
      expect(validateAdminEvent(event)).not.toHaveProperty('hadToolCalls');
      expect(validateAdminEvent(event)).not.toHaveProperty('reasoningTokens');
    }
  }
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies[0]).toBe(bodies.at(-1));
  expect(metrics[0]).toEqual(metrics[1]);
  expect(bodies.join()).not.toMatch(/finishReason|hadToolCalls|reasoningTokens/);
});
