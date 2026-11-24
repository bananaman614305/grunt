import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { MillionSeek, MILLIONSEEK_MODEL, MILLIONSEEK_PREFLIGHT_MS } from './millionseek.js';
import { Sources, SourceError } from './source.js';
import type { ModelRequest } from './source.js';

const now = Date.parse('2026-11-20T15:00:00Z'), reset = '2026-11-21T00:00:00.000Z';
const grant = { base_url: 'https://100milionseek.top', token: 'synthetic-key' };
let directory: string, clock = now;
const headers = { 'x-quota-limit': '100000000', 'x-quota-used': '0', 'x-quota-remaining': '100000000', 'x-quota-reset': reset };
const status = () => ({ updated_at: new Date(clock).toISOString(), base_daily_tokens: 100000000, model: { id: MILLIONSEEK_MODEL, context_length: 198000, max_output_tokens: 65536, tools: true }, allowance: { reset: '00:00 UTC', session_limit: 5, daily_tokens: 100000000 } });
const offer = { id: MILLIONSEEK_MODEL, owned_by: '100milionseek', context_length: 198000, max_output_tokens: 65536, quota_multiplier: 1 };
const req = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'millionseek', messages: [{ role: 'user', content: 'Synthetic hello' }], tools: [], stream: false, cwd: directory, maxTokens: 128, ...extra });
const tool = { type: 'function', function: { name: 'record_probe', parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } } };

// One SSE event per entry. `wire` lets a test split bytes anywhere, including inside an event.
const event = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ id: 'c1', model: MILLIONSEEK_MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const usage = { prompt_tokens: 20, completion_tokens: 3 };
function sse(parts: string[], end: 'close' | 'error' | 'stall' = 'close') {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      if (end === 'close') controller.close(); else if (end === 'error') controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }));
    },
  }), { headers: { 'content-type': 'text/event-stream', ...headers } });
}
const stream = (...events: unknown[]) => sse([...events.map(event), event('[DONE]')]);
function transport(completion: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async input => String(input).endsWith('/api/status') ? Response.json(status())
    : String(input).endsWith('/v1/models') ? Response.json({ data: [offer] }, { headers })
      : completion());
}
const source = (fetcher: typeof fetch) => new MillionSeek({ directory, fetcher, now: () => clock, loadGrant: async () => grant });
beforeEach(async () => { clock = now; vi.spyOn(Date, 'now').mockReturnValue(now); directory = await mkdtemp(join(tmpdir(), 'millionseek-stream-')); await recordDataSharingConsent(directory, ['millionseek']); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('assembles content deltas, ignores reasoning text and reports usage, with the same Completion shape as a whole reply', async () => {
  const progress = vi.fn();
  const fetcher = transport(() => stream(chunk({ role: 'assistant' }), chunk({ reasoning_content: 'thinking' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }), chunk({}, 'stop'), { model: MILLIONSEEK_MODEL, choices: [], usage }));
  await expect(source(fetcher).complete(req(), AbortSignal.timeout(1000), progress)).resolves.toEqual({ text: 'Hello', inputTokens: 20, outputTokens: 3 });
  const [, init] = fetcher.mock.calls.at(-1)!;
  expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 128 });
  // Reasoning and each content delta are progress; the role-only chunk and the finish chunk are not.
  expect(progress).toHaveBeenCalledTimes(3);
});
it('reassembles tool-call deltas split across chunks by index and validates the schema', async () => {
  const fragments = [
    chunk({ tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'record_probe', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"mark' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call-b', type: 'function', function: { name: 'record_probe', arguments: '{"marker":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'er":"one"}' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '"two"}' } }] }),
    chunk({}, 'tool_calls'), { model: MILLIONSEEK_MODEL, choices: [], usage },
  ];
  const request = req({ tools: [tool] });
  await expect(source(transport(() => stream(...fragments))).complete(request, AbortSignal.timeout(1000))).resolves.toEqual({ text: '', inputTokens: 20, outputTokens: 3, calls: [
    { id: 'call-a', type: 'function', function: { name: 'record_probe', arguments: '{"marker":"one"}' } },
    { id: 'call-b', type: 'function', function: { name: 'record_probe', arguments: '{"marker":"two"}' } }] });
  // Schema-invalid arguments, an unknown tool and a reused conversation id are all refused as before.
  const bad = (arguments_: string, id = 'call-a', name = 'record_probe') => stream(
    chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: arguments_ } }] }), chunk({}, 'tool_calls'), { model: MILLIONSEEK_MODEL, choices: [], usage });
  await expect(source(transport(() => bad('{"marker":42}'))).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  await expect(source(transport(() => bad('{"marker":"x"}', 'call-a', 'other'))).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  const replay = req({ tools: [tool], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'record_probe', arguments: '{"marker":"x"}' } }] }, { role: 'tool', content: 'ok', tool_call_id: 'call-a' }, { role: 'user', content: 'again' }] });
  await expect(source(transport(() => bad('{"marker":"x"}'))).complete(replay, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
});
it('accepts events split across network reads and CRLF separators', async () => {
  const wire = [chunk({ content: 'Hi ' }), chunk({ content: 'there' }), chunk({}, 'stop')].map(event).join('').replace(/\n\n/g, '\r\n\r\n') + event('[DONE]');
  const parts = [wire.slice(0, 17), wire.slice(17, 60), wire.slice(60, 61), wire.slice(61)];
  await expect(source(transport(() => sse(parts))).complete(req(), AbortSignal.timeout(1000))).resolves.toEqual({ text: 'Hi there' });
});
it('keeps a valid stream without a usage block, leaving token counts unknown', async () => {
  const fetcher = transport(() => stream(chunk({ content: 'No usage' }), chunk({}, 'stop')));
  const reply = await source(fetcher).complete(req(), AbortSignal.timeout(1000));
  expect(reply).toEqual({ text: 'No usage' });
  expect(reply).not.toHaveProperty('inputTokens');
});
it.each([
  ['a charged usage block', () => stream(chunk({ content: 'x' }), chunk({}, 'stop'), { model: MILLIONSEEK_MODEL, choices: [], usage: { ...usage, cost: 1 } })],
  ['an output over the requested budget', () => stream(chunk({ content: 'x' }), chunk({}, 'stop'), { model: MILLIONSEEK_MODEL, choices: [], usage: { prompt_tokens: 20, completion_tokens: 129 } })],
  ['a different model', () => stream({ ...chunk({ content: 'x' }), model: 'unverified' }, chunk({}, 'stop'))],
  ['a refusal', () => stream(chunk({ refusal: 'no' }), chunk({}, 'stop'))],
  ['an in-stream error', () => stream(chunk({ content: 'x' }), { error: { message: 'boom' } })],
  ['an empty reply', () => stream(chunk({}), chunk({}, 'stop'))],
])('rejects %s', async (_name, completion) => {
  await expect(source(transport(completion)).complete(req(), AbortSignal.timeout(1000))).rejects.toBeInstanceOf(SourceError);
});
it('classifies a mid-stream disconnect and a missing DONE as slow upstream failures', async () => {
  await expect(source(transport(() => sse([event(chunk({ content: 'par' }))], 'error'))).complete(req(), AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'stream_read' } });
  await expect(source(transport(() => sse([event(chunk({ content: 'par' }))], 'close'))).complete(req(), AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'upstream', diagnostics: { failureReason: 'stream_incomplete' } });
  await expect(source(transport(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); })).complete(req(), AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'upstream', diagnostics: { networkCode: 'ECONNRESET' } });
});
it('reports gateway statuses as upstream failures carrying their HTTP status', async () => {
  for (const code of [502, 503, 524]) await expect(source(transport(() => new Response('<html>gateway</html>', { status: code, headers: { 'content-type': 'text/html' } }))).complete(req(), AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'upstream', diagnostics: { httpStatus: code } });
});

// The first-output deadline: a stalled request fails over early, a healthy-but-slow one is left alone.
function pool(completion: () => Response | Promise<Response>, deadline: { first: number; idle: number }) {
  const millionseek = Object.assign(source(transport(completion)), { firstOutputMs: deadline.first, idleMs: deadline.idle });
  return new Sources([millionseek], undefined, new Set(), 60000);
}
const never = (end: 'stall') => new Response(new ReadableStream<Uint8Array>({ start() { void end; } }), { headers: { 'content-type': 'text/event-stream', ...headers } });
it('fails a request that produces no output before the first-output deadline', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const started = performance.now();
  await expect(pool(() => never('stall'), { first: 80, idle: 80 }).complete({ ...req(), model: 'grunt' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('produced no output within 0.08 seconds') });
  expect(performance.now() - started).toBeLessThan(2000);
});
it('does not count a role-only event or keepalive comments as first output', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const parts = [': keepalive\n\n', event(chunk({ role: 'assistant' }))];
  await expect(pool(() => new Response(new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); } }), { headers: { 'content-type': 'text/event-stream', ...headers } }), { first: 80, idle: 80 })
    .complete({ ...req(), model: 'grunt' }, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
});
it('cuts a stream that goes silent after starting, but not one that is slow yet steady', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const encoder = new TextEncoder();
  const silent = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(event(chunk({ content: 'one' })))); } }), { headers: { 'content-type': 'text/event-stream', ...headers } });
  await expect(pool(silent, { first: 200, idle: 80 }).complete({ ...req(), model: 'grunt' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('no further output within 0.08 seconds') });
  // Total time exceeds the idle deadline, but no gap does.
  const steady = () => new Response(new ReadableStream<Uint8Array>({ async start(c) {
    for (const word of ['a', 'b', 'c', 'd']) { await new Promise(r => setTimeout(r, 40)); c.enqueue(encoder.encode(event(chunk({ content: word })))); }
    c.enqueue(encoder.encode(event(chunk({}, 'stop')) + event('[DONE]'))); c.close();
  } }), { headers: { 'content-type': 'text/event-stream', ...headers } });
  await expect(pool(steady, { first: 200, idle: 80 }).complete({ ...req(), model: 'grunt' }, new AbortController().signal)).resolves.toMatchObject({ text: 'abcd' });
});

it('consumes a real HTTP event stream incrementally, before the upstream has finished', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server: Server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
    response.write(event(chunk({ content: 'first ' })));
    void gate.then(() => { response.write(event(chunk({ content: 'second' })) + event(chunk({}, 'stop')) + event('[DONE]')); response.end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const fetcher: typeof fetch = (input, init) => String(input).endsWith('/v1/chat/completions') ? fetch(`http://127.0.0.1:${port}/v1/chat/completions`, init)
      : transport(() => new Response())(input, init);
    // The upstream holds its second event until the adapter reports progress, so this only finishes if the first
    // event is delivered while the response is still open.
    const reply = await source(fetcher).complete(req(), AbortSignal.timeout(5000), release);
    expect(reply.text).toBe('first second');
  } finally { release(); server.closeAllConnections(); server.close(); }
});

it('reuses the entitlement check for a minute and discards it when a completion fails', async () => {
  const ok = () => stream(chunk({ content: 'ok' }), chunk({}, 'stop'));
  const replies = [ok, ok, () => new Response('x', { status: 502 }), ok, ok];
  let next = 0;
  const fetcher = transport(() => replies[next++]!());
  const s = source(fetcher), checks = () => fetcher.mock.calls.filter(([input]) => !String(input).endsWith('/chat/completions')).length;
  await s.complete(req(), AbortSignal.timeout(1000)); expect(checks()).toBe(2);
  await s.complete(req(), AbortSignal.timeout(1000)); expect(checks()).toBe(2);
  expect(await s.available()).toBe(true); expect(checks()).toBe(2);
  clock += MILLIONSEEK_PREFLIGHT_MS; await s.complete(req(), AbortSignal.timeout(1000)).catch(() => {}); expect(checks()).toBe(4);
  // That completion failed (502), so the cached check was discarded: the next request checks again, then reuses it.
  await s.complete(req(), AbortSignal.timeout(1000)); expect(checks()).toBe(6);
  await s.complete(req(), AbortSignal.timeout(1000)).catch(() => {}); expect(checks()).toBe(6);
});
it('does not cache a failed or stale entitlement', async () => {
  const fetcher = transport(() => stream(chunk({ content: 'ok' }), chunk({}, 'stop')));
  const s = source(fetcher);
  const stale = vi.fn<typeof fetch>(async input => String(input).endsWith('/api/status') ? Response.json({ ...status(), base_daily_tokens: 1 }) : fetcher(input));
  await expect(source(stale).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  await expect(source(stale).complete(req(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(stale.mock.calls.filter(([input]) => String(input).endsWith('/api/status'))).toHaveLength(2);
  await expect(s.complete(req(), AbortSignal.timeout(1000))).resolves.toMatchObject({ text: 'ok' });
});
