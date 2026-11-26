import { serve } from '@hono/node-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { DiagnosticsStore } from './diagnostics.js';
import { FreeApi } from './free-api.js';
import { Kilo, KILO_ORIGIN, KILO_PARTICLE } from './kilo.js';
import { Sources, SourceError, emitStreamText } from './source.js';
import type { Completion, Source } from './source.js';
import { Zro, ZRO_DEEPSEEK } from './zro.js';

const servers: ReturnType<typeof serve>[] = [];
const dirs: string[] = [];
const pools: Sources[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function startLocal(sources: Sources) {
  pools.push(sources);
  let port = 0;
  const app = createLocalApp(sources, { cwd: tmpdir(), get port() { return port; } });
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  port = (server.address() as { port: number }).port;
  return { port, url: (path: string) => `http://127.0.0.1:${port}/v1/${path}` };
}

function sse(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

it.each([
  ['chat/completions', 'chat'],
  ['messages', 'messages'],
  ['responses', 'responses']
] as const)('emits incremental SSE tokens on %s before the upstream stream finishes', async (endpoint, api) => {
  const encoder = new TextEncoder();
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const grant = { base_url: 'https://grant.test/zro', token: 'synthetic-grant', free_account_verified: true as const, verified_at: '2026-11-24T00:00:00Z' };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: ZRO_DEEPSEEK, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] })}\n\n`));
      await secondGate;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: ZRO_DEEPSEEK, choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: ZRO_DEEPSEEK, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

  const zro = new Zro({ loadGrant: async () => grant, fetcher });
  const local = await startLocal(new Sources([zro]));
  const body = api === 'responses'
    ? { model: 'grunt', input: 'Say hello', stream: true }
    : { model: 'grunt', messages: [{ role: 'user', content: 'Say hello' }], stream: true, ...(api === 'chat' ? { stream_options: { include_usage: true } } : {}) };
  const response = await fetch(local.url(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('x-grunt-source')).toBe('zro');
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  // Prove the first chunk reaches the client while the upstream stream is still blocked on secondGate.
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('Hello ')) {
    const part = await reader.read();
    expect(part.done).toBe(false);
    received += decoder.decode(part.value, { stream: true });
  }
  expect(received).not.toContain('world');

  // Unblock upstream and drain the rest of the stream.
  releaseSecond();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    received += decoder.decode(part.value, { stream: true });
  }
  expect(received).toContain('world');
  if (api === 'chat') {
    expect(received).toContain('"prompt_tokens":10');
    expect(received).toContain('data: [DONE]');
  } else if (api === 'messages') {
    expect(received).toContain('event: content_block_delta');
    expect(received).toContain('event: message_stop');
  } else {
    expect(received).toContain('event: response.output_text.delta');
    expect(received).toContain('event: response.completed');
  }
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
});

it('fails over cleanly on pre-first-delta 429 before committing SSE headers', async () => {
  const grant = { base_url: 'https://grant.test/p', token: 'synthetic-grant' };
  const limited = new FreeApi('zro', {
    loadGrant: async () => grant,
    fetcher: vi.fn<typeof fetch>(async () => new Response(null, { status: 429, headers: { 'Retry-After': '30' } }))
  });
  const backup = new FreeApi('runcrate', {
    loadGrant: async () => grant,
    fetcher: vi.fn<typeof fetch>(async () => sse([
      JSON.stringify({ model: 'deepseek-ai/DeepSeek-V4.1-Flash', choices: [{ index: 0, delta: { content: 'Recovered ' }, finish_reason: null }] }),
      JSON.stringify({ model: 'deepseek-ai/DeepSeek-V4.1-Flash', choices: [{ index: 0, delta: { content: 'stream' }, finish_reason: 'stop' }] }),
      '[DONE]'
    ]))
  });
  const local = await startLocal(new Sources([limited, backup]));
  const response = await fetch(local.url('chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', messages: [{ role: 'user', content: 'hi' }], stream: true })
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-grunt-source')).toBe('runcrate');
  const wire = await response.text();
  expect(wire).toContain('Recovered ');
  expect(wire).toContain('stream');
  expect(wire).toContain('data: [DONE]');
});

it('buffers streamed tool-call arguments until validated by guardToolCalls, and rejects malformed tool calls before committing headers', async () => {
  const grant = { base_url: 'https://grant.test/p', token: 'synthetic-grant' };
  const badTool = new FreeApi('zro', {
    loadGrant: async () => grant,
    fetcher: vi.fn<typeof fetch>(async () => sse([
      JSON.stringify({ model: ZRO_DEEPSEEK, choices: [{ index: 0, delta: { content: 'é'.repeat(128) }, finish_reason: null }] }),
      JSON.stringify({ model: ZRO_DEEPSEEK, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] }),
      JSON.stringify({ model: ZRO_DEEPSEEK, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]'
    ]))
  });
  const goodTool = new FreeApi('runcrate', {
    loadGrant: async () => grant,
    fetcher: vi.fn<typeof fetch>(async () => sse([
      JSON.stringify({ model: 'deepseek-ai/DeepSeek-V4.1-Flash', choices: [{ index: 0, delta: { content: 'Checking file.' }, finish_reason: null }] }),
      JSON.stringify({ model: 'deepseek-ai/DeepSeek-V4.1-Flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ok', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] }),
      JSON.stringify({ model: 'deepseek-ai/DeepSeek-V4.1-Flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: null }] }),
      JSON.stringify({ model: 'deepseek-ai/DeepSeek-V4.1-Flash', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]'
    ]))
  });
  const local = await startLocal(new Sources([badTool, goodTool]));
  const response = await fetch(local.url('chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grunt',
      messages: [{ role: 'user', content: 'read README' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      stream: true
    })
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-grunt-source')).toBe('runcrate');
  const wire = await response.text();
  expect(wire).not.toContain('é');
  expect(wire).not.toContain('call_bad');
  expect(wire).toContain('Checking file.');
  expect(wire).toContain('"id":"call_ok"');
  expect(wire).toContain('\\"path\\":\\"README.md\\"');
  expect(wire).toContain('"finish_reason":"tool_calls"');
});

it('streams incremental tokens from Kilo while still verifying model identity and zero-cost usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grunt-kilo-stream-'));
  dirs.push(dir);
  await recordDataSharingConsent(dir, ['kilo']);
  const encoder = new TextEncoder();
  let releaseSecond!: () => void;
  const gate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url) === `${KILO_ORIGIN}/models`) {
      return Response.json({ data: [{ id: KILO_PARTICLE, isFree: true, pricing: { prompt: '0', completion: '0' }, context_length: 1048576, supported_parameters: ['tools', 'max_tokens'] }] });
    }
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: KILO_PARTICLE, choices: [{ index: 0, delta: { content: 'Kilo ' }, finish_reason: null }] })}\n\n`));
        await gate;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: KILO_PARTICLE, choices: [{ index: 0, delta: { content: 'streams!' }, finish_reason: 'stop' }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ model: KILO_PARTICLE, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0, cost_details: { upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 } } })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  });
  const kilo = new Kilo({ directory: dir, fetcher });
  const local = await startLocal(new Sources([kilo]));
  const response = await fetch(local.url('chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kilo', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } })
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('x-grunt-source')).toBe('kilo');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('Kilo ')) {
    const part = await reader.read();
    expect(part.done).toBe(false);
    received += decoder.decode(part.value, { stream: true });
  }
  expect(received).not.toContain('streams!');
  releaseSecond();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    received += decoder.decode(part.value, { stream: true });
  }
  expect(received).toContain('streams!');
  expect(received).toContain('"total_tokens":15');
  expect(received).toContain('data: [DONE]');
});

it.each([
  { text: 'Hello', tools: [], cancel: false },
  { text: 'é'.repeat(128) + '!', tools: [{ type: 'function', function: { name: 'read_file' } }], cancel: false },
  { text: 'Hello', tools: [], cancel: true }
])('records stream-midflight-false-pass after settlement or cancellation ($cancel)', async ({ text, tools, cancel }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first: Source = {
    id: 'first',
    supportsFunctionTools: true,
    available: async () => true,
    complete: async (): Promise<Completion> => {
      emitStreamText(text);
      await gate;
      throw new SourceError('upstream', 'cut stream', undefined, undefined, { failureReason: 'stream_incomplete' });
    }
  };
  const backup: Source = {
    id: 'backup',
    supportsFunctionTools: true,
    available: async () => true,
    complete: vi.fn(async (): Promise<Completion> => ({ text: 'should not run' }))
  };
  const pool = new Sources([first, backup]);
  const directory = await mkdtemp(join(tmpdir(), 'grunt-stream-diagnostics-'));
  dirs.push(directory);
  const store = await DiagnosticsStore.open({ directory });
  onTestFinished(() => store.close());
  pool.setDiagnostics(store);
  const records = vi.spyOn(store, 'record');
  const finishes = () => records.mock.calls.map(([event]) => event).filter(event => event.type === 'request.finish');
  const local = await startLocal(pool);
  const client = new AbortController();
  const response = await fetch(local.url('chat/completions'), {
    signal: client.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', messages: [{ role: 'user', content: 'hi' }], tools, stream: true })
  });
  const beforeFailure = finishes();
  if (cancel) {
    client.abort();
    try {
      await vi.waitFor(() => expect(finishes()).toEqual([expect.objectContaining({ outcome: 'cancelled' })]));
    } finally { release(); }
    return;
  }
  release();
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(wire).toContain(text);
  expect(wire).toContain(JSON.stringify({ error: { type: 'server_error', code: 'upstream', message: 'cut stream' } }));
  expect(beforeFailure).toEqual([]);
  expect(finishes()).toEqual([expect.objectContaining({ outcome: 'failed', errorCode: 'upstream', responseBytes: Buffer.byteLength(text), httpStatus: 200 })]);
  expect(wire).not.toContain('should not run');
  expect(wire).not.toContain('data: [DONE]');
  expect(backup.complete).not.toHaveBeenCalled();
});

async function kiloWithStream(reply: () => Response) {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-stream-recovery-'));
  dirs.push(directory);
  await recordDataSharingConsent(directory, ['kilo']);
  return new Kilo({ directory, anonymous: () => true, fetcher: async url => String(url) === `${KILO_ORIGIN}/models`
    ? Response.json({ data: [{ id: KILO_PARTICLE, isFree: true, pricing: { prompt: '0', completion: '0' }, context_length: 1048576, supported_parameters: ['tools', 'max_tokens'] }] })
    : reply() });
}

it('discards the rejected Kilo sample before buffering the retry preamble', async () => {
  const rejected = 'x'.repeat(200), accepted = 'y'.repeat(200);
  let samples = 0;
  const kilo = await kiloWithStream(() => {
    const first = ++samples === 1;
    return sse([
      JSON.stringify({ model: KILO_PARTICLE, choices: [{ index: 0, delta: { content: first ? rejected : accepted }, finish_reason: first ? 'tool_calls' : 'stop' }] }),
      JSON.stringify({ model: KILO_PARTICLE, choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0, cost_details: { upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 } } }),
      '[DONE]'
    ]);
  });
  const local = await startLocal(new Sources([kilo]));
  const response = await fetch(local.url('chat/completions'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kilo', stream: true, messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }] })
  });
  const wire = await response.text();
  expect(samples).toBe(2);
  expect(wire).not.toContain(rejected);
  expect(wire).toContain(accepted);
  expect(wire).toContain('data: [DONE]');
});

it.each(['kilo', 'runcrate'])('cuts off an open %s stream after its first token', async id => {
  const reply = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const frame = { model: KILO_PARTICLE, choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const source = id === 'kilo' ? await kiloWithStream(reply) : new FreeApi('runcrate', {
    loadGrant: async () => ({ base_url: 'https://grant.test/p', token: 'synthetic' }), fetcher: async () => reply()
  });
  const local = await startLocal(new Sources([source], undefined, new Set(), 150));
  const response = await fetch(local.url('chat/completions'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(2000),
    body: JSON.stringify({ model: id, stream: true, messages: [{ role: 'user', content: 'hi' }] })
  });
  const wire = await response.text();
  expect(wire).toContain('Hello');
  expect(wire).toContain('"code":"timeout"');
  expect(wire).not.toContain('data: [DONE]');
});

it.each([
  ['cost', { cost: 0.01 }, 'first'],
  ['total_cost', { total_cost: 0.02 }, 'first'],
  ['credits_charged', { credits_charged: 1 }, 'first'],
  ['cost', { cost: 0.01 }, 'trailing'],
  ['total_cost', { total_cost: 0.02 }, 'trailing'],
  ['credits_charged', { credits_charged: 1 }, 'trailing']
] as const)('rejects a Kilo SSE stream carrying nonzero top-level %s on a %s chunk', async (_field, billingPatch, position) => {
  const dir = await mkdtemp(join(tmpdir(), 'grunt-kilo-stream-billing-'));
  dirs.push(dir);
  await recordDataSharingConsent(dir, ['kilo']);
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url) === `${KILO_ORIGIN}/models`) {
      return Response.json({ data: [{ id: KILO_PARTICLE, isFree: true, pricing: { prompt: '0', completion: '0' }, context_length: 1048576, supported_parameters: ['tools', 'max_tokens'] }] });
    }
    const zeroUsage = { prompt_tokens: 12, completion_tokens: 3, cost: 0, cost_details: { upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 } };
    return sse([
      JSON.stringify({ ...(position === 'first' ? billingPatch : {}), model: KILO_PARTICLE, choices: [{ index: 0, delta: { content: 'Charged?' }, finish_reason: 'stop' }] }),
      JSON.stringify({ ...(position === 'trailing' ? billingPatch : {}), model: KILO_PARTICLE, choices: [], usage: zeroUsage }),
      '[DONE]'
    ]);
  });
  const kilo = new Kilo({ directory: dir, fetcher });
  await expect(kilo.complete({ model: 'kilo', messages: [{ role: 'user', content: 'hi' }], tools: [], cwd: dir, stream: true }, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'completion_billing' } });
  await kilo.close();
});
