import { afterEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { createLocalApp, decode } from './api.js';
import { RequestError, SourceError, Sources } from './source.js';
import type { ModelRequest, Source } from './source.js';

// An image in a conversation used to set imageInput, which filtered every adapter out (none lists image input) and made the
// whole conversation fail with a misleading 429 for as long as the image stayed in history. With no source that could take
// the image, each image block is now a short deterministic text note and the request routes as text.
const png = 'AAAA'; // three bytes
const NOTE = '[image omitted (image/png, 3 bytes): no free source on this route accepts images; inspect it with tools instead]';
const pools: Sources[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.close())); vi.useRealTimers(); });
const source = (id: string): Source => ({ id, supportsFunctionTools: true, available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: `${id} done` })) });
function pool(options: { image?: string[]; ids?: string[]; now?: () => number } = {}) {
  const items = (options.ids ?? ['kilo', 'runcrate']).map(source);
  const registry = { ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1,
    modalities: options.image?.includes(item.id) ? ['text', 'image'] as const : ['text'] as const })) } as typeof bundledRegistry;
  const sources = new Sources(items, { registry: () => registry, random: () => 0, ...(options.now ? { now: options.now } : {}) });
  pools.push(sources);
  return { items, sources, app: createLocalApp(sources) };
}
const read = { name: 'Read', description: 'read', input_schema: { type: 'object' } };
const post = (app: ReturnType<typeof createLocalApp>, path: string, body: unknown) => app.request(`http://localhost:8788/v1/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const seen = (item: Source) => vi.mocked(item.complete).mock.calls.map(call => call[0] as ModelRequest);

const messagesBody = (content: unknown, extra: Record<string, unknown> = {}) => ({ model: 'grunt', max_tokens: 100, tools: [read], messages: [{ role: 'user', content }], ...extra });
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
const chatImage = { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } };
const responsesImage = { type: 'input_image', image_url: `data:image/png;base64,${png}` };

it('replaces an image block by a deterministic note with no data, URL or path, in every wire format', () => {
  const messages = decode({ model: 'grunt', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, image] }] }, 'messages', '/tmp', { omitImages: true });
  expect(messages.messages).toEqual([{ role: 'user', content: `look\n${NOTE}` }]);
  expect(messages.imageInput).toBeUndefined();
  const chat = decode({ model: 'grunt', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, chatImage] }] }, 'chat', '/tmp', { omitImages: true });
  expect(chat.messages).toEqual([{ role: 'user', content: `look\n${NOTE}` }]);
  const responses = decode({ model: 'grunt', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, responsesImage] }] }, 'responses', '/tmp', { omitImages: true });
  expect(responses.messages).toEqual([{ role: 'user', content: `look\n${NOTE}` }]);
  const again = decode({ model: 'grunt', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, image] }] }, 'messages', '/tmp', { omitImages: true });
  expect(again.messages).toEqual(messages.messages);
  // A remote URL or file reference gives a note without any detail, never the address.
  const remote = decode({ model: 'grunt', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.example/secret/photo.png' } }] }] }, 'chat', '/tmp', { omitImages: true });
  expect(remote.messages).toEqual([{ role: 'user', content: '[image omitted: no free source on this route accepts images; inspect it with tools instead]' }]);
});

it('handles an image inside a tool result, mixed text, several images and an earlier turn of the history', () => {
  const body = { model: 'grunt', messages: [
    { role: 'user', content: [{ type: 'text', text: 'first' }, image, image] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/home/someone/shot.png', type: 'image' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'shot.png' }, image] }, { type: 'text', text: 'what is in it?' }] }] };
  const kept = decode(body, 'messages', '/tmp'), omitted = decode(body, 'messages', '/tmp', { omitImages: true });
  expect(kept.imageInput).toBe(true); expect(omitted.imageInput).toBeUndefined();
  expect(omitted.messages).toEqual([
    { role: 'user', content: `first\n${NOTE}\n${NOTE}` },
    { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/home/someone/shot.png","type":"image"}' } }] },
    { role: 'tool', content: `shot.png\n${NOTE}`, tool_call_id: 'toolu_1' },
    { role: 'user', content: 'what is in it?' }]);
  // The task key is the user's own words, so it is the same with or without the note.
  expect(omitted.userMessages).toEqual(kept.userMessages);
  expect(JSON.stringify(omitted)).not.toContain(png.repeat(2));
  // A tool argument that merely says "image" is not an image: nothing is flagged or changed once the images are replaced.
  const argument = decode({ model: 'grunt', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { type: 'image' } }] }] }, 'messages', '/tmp', { omitImages: true });
  expect(argument.imageInput).toBeUndefined(); expect(argument.messages[0]!.tool_calls![0]!.function.arguments).toBe('{"type":"image"}');
});

it('replaces images in a Responses function result and a Chat tool message', () => {
  const responses = decode({ model: 'grunt', input: [
    { type: 'function_call', call_id: 'c1', name: 'view', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'ok' }, responsesImage] }] }, 'responses', '/tmp', { omitImages: true });
  expect(responses.messages.at(-1)).toEqual({ role: 'tool', content: `ok\n${NOTE}`, tool_call_id: 'c1' });
  const chat = decode({ model: 'grunt', messages: [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: [chatImage] }] }, 'chat', '/tmp', { omitImages: true });
  expect(chat.messages.at(-1)).toEqual({ role: 'tool', content: NOTE, tool_call_id: 'c1' });
});

it.each([
  ['messages', 'messages', (blocks: unknown[]) => messagesBody([{ type: 'text', text: 'describe' }, ...blocks]), image],
  ['chat', 'chat/completions', (blocks: unknown[]) => ({ model: 'grunt', tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, ...blocks] }] }), chatImage],
  ['responses', 'responses', (blocks: unknown[]) => ({ model: 'grunt', tools: [{ type: 'function', name: 'Read', parameters: {} }], input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'describe' }, ...blocks] }] }), responsesImage]
] as const)('serves a conversation with an image as text when no source takes images (%s route)', async (_name, path, build, block) => {
  const { items, app } = pool();
  const response = await post(app, path, build([block]));
  expect(response.status).toBe(200);
  const request = items.flatMap(seen)[0]!;
  expect(request.imageInput).toBeUndefined();
  expect(request.messages.map(m => m.content).join('\n')).toContain(NOTE);
  // The same conversation again, with the image still in its history, keeps working and keeps its source.
  const first = response.headers.get('x-grunt-source');
  const next = await post(app, path, build([block]));
  expect(next.status).toBe(200); expect(next.headers.get('x-grunt-source')).toBe(first);
});

it('leaves the image alone when an adapter that takes images is listed, so the request is routed as sent', async () => {
  const { items, app, sources } = pool({ image: ['runcrate'] });
  expect(sources.acceptsImages({ model: 'grunt', messages: [], tools: [], cwd: '/tmp', stream: false, imageInput: true })).toBe(true);
  const response = await post(app, 'messages', messagesBody([{ type: 'text', text: 'describe' }, image]));
  expect(response.status).toBe(200);
  const request = items.flatMap(seen)[0]!;
  expect(request.imageInput).toBe(true); expect(JSON.stringify(request.messages)).not.toContain('image omitted');
  expect(items.find(item => item.id === 'runcrate')!.complete).toHaveBeenCalledOnce();
});

it('requires a tool-capable image source for a tools request', async () => {
  const items = [source('kilo'), { ...source('runcrate'), supportsFunctionTools: false }];
  const registry = { ...bundledRegistry, adapters: items.map(item => ({ ...bundledRegistry.adapters.find(a => a.id === item.id)!, weight: 1, modalities: item.id === 'runcrate' ? ['text', 'image'] : ['text'] })) } as typeof bundledRegistry;
  const sources = new Sources(items, { registry: () => registry }); pools.push(sources);
  const request = { model: 'grunt', messages: [], cwd: '/tmp', stream: false, imageInput: true as const };
  expect(sources.acceptsImages({ ...request, tools: [] })).toBe(true);
  expect(sources.acceptsImages({ ...request, tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }] })).toBe(false);
});

it('keeps the image for a briefly benched image source (a true 429 with its retry time) and substitutes when it is gone for long', async () => {
  let now = 1_000_000;
  const { items, sources, app } = pool({ image: ['runcrate'], now: () => now });
  const request = { model: 'grunt', messages: [{ role: 'user', content: 'x' }], tools: [], cwd: '/tmp', stream: false, imageInput: true as const };
  const capable = items.find(item => item.id === 'runcrate')!;
  // A 2-minute quota window: waiting is honest, so the image stays and the answer is a real 429.
  vi.mocked(capable.complete).mockRejectedValue(new SourceError('quota', 'limit', 120));
  await sources.complete({ ...request, tools: [], messages: [{ role: 'user', content: 'prime' }] }, AbortSignal.timeout(2000)).catch(() => undefined);
  expect(sources.acceptsImages(request)).toBe(true);
  const kept = await post(app, 'messages', messagesBody([{ type: 'text', text: 'describe' }, image], { tools: undefined }));
  expect(kept.status).toBe(429); expect(Number(kept.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(JSON.stringify(vi.mocked(capable.complete).mock.calls.at(-1)?.[0].messages ?? '')).not.toContain('image omitted');
  // Once it is benched for hours, the image no longer holds the conversation: it is answered as text.
  now += 200_000;
  vi.mocked(capable.complete).mockRejectedValue(new SourceError('quota', 'daily limit', 6 * 3600));
  await sources.complete({ ...request, messages: [{ role: 'user', content: 'prime again' }] }, AbortSignal.timeout(2000)).catch(() => undefined);
  expect(sources.acceptsImages(request)).toBe(false);
  const text = await post(app, 'messages', messagesBody([{ type: 'text', text: 'describe' }, image], { tools: undefined }));
  expect(text.status).toBe(200);
});

it('does not break an explicit request for an image-capable source, and answers text-only named sources as text', async () => {
  const { items, app } = pool({ image: ['runcrate'] });
  const capable = await post(app, 'messages', messagesBody([{ type: 'text', text: 'describe' }, image], { model: 'runcrate', tools: undefined }));
  expect(capable.status).toBe(200);
  expect(seen(items.find(item => item.id === 'runcrate')!)[0]!.imageInput).toBe(true);
  const plain = await post(app, 'messages', messagesBody([{ type: 'text', text: 'describe' }, image], { model: 'kilo', tools: undefined }));
  expect(plain.status).toBe(200);
  expect(seen(items.find(item => item.id === 'kilo')!)[0]!.imageInput).toBeUndefined();
});

it('answers an image request that reaches the router unchanged with an invalid-request error, not a quota error', async () => {
  const { sources } = pool();
  const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'x' }], tools: [], cwd: '/tmp', stream: false, imageInput: true };
  const failure = await sources.complete(request, AbortSignal.timeout(2000)).catch(error => error);
  expect(failure).toBeInstanceOf(RequestError);
  expect(failure.message).toMatch(/no source on this route accepts image input/);
});

it('still reports a real quota wait as quota when nothing is wrong with the modality', async () => {
  const { items, sources } = pool({ ids: ['kilo'] });
  vi.mocked(items[0]!.complete).mockRejectedValue(new SourceError('quota', 'limit', 90));
  const failure = await sources.complete({ model: 'grunt', messages: [{ role: 'user', content: 'x' }], tools: [], cwd: '/tmp', stream: false }, AbortSignal.timeout(2000)).catch(error => error);
  expect(failure).toMatchObject({ code: 'quota' }); expect(failure).not.toBeInstanceOf(RequestError);
});

it('preserves structured image content parts across Chat Completions, Responses, and Anthropic Messages when omitImages is false', () => {
  const chat = decode({ model: 'grunt', messages: [
    { role: 'user', content: 'plain text stays a string' },
    { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}`, detail: 'high' } }, { type: 'image_url', image_url: 'https://example.com/diagram.png' }] }
  ] }, 'chat', '/tmp');
  expect(chat.imageInput).toBe(true);
  expect(chat.messages).toEqual([
    { role: 'user', content: 'plain text stays a string' },
    { role: 'user', content: [
      { type: 'text', text: 'inspect' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}`, detail: 'high' } },
      { type: 'image_url', image_url: { url: 'https://example.com/diagram.png' } }
    ] }
  ]);

  const responses = decode({ model: 'grunt', input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'plain only' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see this' }, { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'low' }] },
    { type: 'function_call', call_id: 'c1', name: 'capture', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'captured' }, responsesImage] }
  ] }, 'responses', '/tmp');
  expect(responses.imageInput).toBe(true);
  expect(responses.messages).toEqual([
    { role: 'user', content: 'plain only' },
    { role: 'user', content: [
      { type: 'text', text: 'see this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}`, detail: 'low' } }
    ] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'capture', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: [
      { type: 'text', text: 'captured' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
    ] }
  ]);

  const messages = decode({ model: 'grunt', messages: [
    { role: 'user', content: [image] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.png' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'shot' }, image] },
      { type: 'image', source: { type: 'url', url: 'https://example.com/photo.jpg' } }
    ] }
  ] }, 'messages', '/tmp');
  expect(messages.imageInput).toBe(true);
  expect(messages.messages).toEqual([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.png"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_1', content: [{ type: 'text', text: 'shot' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } }] }
  ]);

  // Tool arguments containing {"type":"image"} never flag imageInput even when omitImages is false.
  const toolArg = decode({ model: 'grunt', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { type: 'image' } }] }] }, 'messages', '/tmp');
  expect(toolArg.imageInput).toBeUndefined();
});

it('substitutes unforwardable image block references with deterministic notes on both image-capable and text-only routes', async () => {
  const unsupported = { type: 'input_image', file_id: 'file_123' };
  const payload = { model: 'grunt', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, unsupported] }] };
  expect(decode(payload, 'responses', '/tmp').messages).toEqual([{ role: 'user', content: 'look' }]);
  for (const p of [pool({ image: ['kilo'] }), pool()]) {
    const ok = await post(p.app, 'responses', payload);
    expect(ok.status).toBe(200);
    expect(p.items.flatMap(seen)[0]!.messages[0]!.content).toContain('[image omitted:');
    expect(p.items.flatMap(seen)[0]!.imageInput).toBeUndefined();
  }
});
