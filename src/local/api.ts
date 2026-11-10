import { pairDots } from './dots-link.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { housekeeping, userText } from './harness.js';
import { SourceError } from './source.js';
import type { Completion, Message, ModelRequest, Tool, ToolCall, Sources } from './source.js';
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  return array(v).flatMap(b => {
    const p = object(b);
    if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') return String(p.text ?? '');
    if (p.type === 'tool_result') return text(p.content);
    if (p.type === 'tool_use') return `[tool ${p.name}] ${JSON.stringify(p.input)}`;
    return [];
  }).join('\n');
}
export function decode(body: Obj, api: string, fallback: string): ModelRequest {
  let messages: Message[];
  if (api === 'responses') {
    messages = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : array(body.input).flatMap((v): Message[] => {
      const m = object(v);
      if (m.type === 'function_call_output') return [{ role: 'tool', content: typeof m.output === 'string' ? m.output : JSON.stringify(m.output) ?? '', tool_call_id: String(m.call_id) }];
      if (m.type === 'function_call') return [{ role: 'assistant', content: '', tool_calls: [{ id: String(m.call_id), type: 'function', function: { name: String(m.name), arguments: String(m.arguments) } }] }];
      if (m.type && m.type !== 'message') return [];
      return [{ role: String(m.role ?? 'user'), content: text(m.content) }];
    });
    if (body.instructions) messages.unshift({ role: 'developer', content: text(body.instructions) });
  } else {
    messages = array(body.messages).flatMap(v => {
      const m = object(v);
      if (api !== 'messages' || typeof m.content === 'string') return [{ role: String(m.role), content: text(m.content), ...(m.tool_calls ? { tool_calls: m.tool_calls as ToolCall[] } : {}), ...(m.tool_call_id ? { tool_call_id: String(m.tool_call_id) } : {}) }];
      const blocks = array(m.content).map(object);
      const calls: ToolCall[] = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: String(b.id), type: 'function', function: { name: String(b.name), arguments: JSON.stringify(b.input) } }));
      const content = text(blocks.filter(b => b.type !== 'tool_use' && b.type !== 'tool_result'));
      const turn: Message[] = content || calls.length ? [{ role: String(m.role), content, ...(calls.length ? { tool_calls: calls } : {}) }] : [];
      return [...turn, ...blocks.filter(b => b.type === 'tool_result').map(b => ({ role: 'tool', content: text(b.content), tool_call_id: String(b.tool_use_id) }))];
    });
    if (body.system) messages.unshift({ role: 'system', content: text(body.system) });
  }
  if (!messages.length) throw new Error('Provide messages or input');
  const tools: Tool[] = array(body.tools).map(v => {
    const t = object(v), f = object(t.function ?? t);
    if (t.type && t.type !== 'function' && !t.input_schema) return t as Tool;
    return { type: 'function', function: { name: String(f.name), parameters: f.parameters ?? f.input_schema ?? {}, ...(typeof f.description === 'string' ? { description: f.description } : {}) } };
  });
  const context = messages.filter(m => ['system', 'developer'].includes(m.role) || /<environment_context>|# Environment/.test(m.content)).map(m => m.content).join('\n');
  const matches = [...context.matchAll(/(?:<cwd>\s*([^<\n]+)\s*<\/cwd>|(?:Working directory|Current working directory|Primary working directory|cwd):\s*([^\n<]+))/gi)];
  const absolute = matches.filter(m => isAbsolute((m[1] ?? m[2] ?? '').trim()));
  const inferred = absolute.find(m => /^Primary working directory:/i.test(m[0])) ?? absolute[0];
  const cwd = typeof body.cwd === 'string' ? body.cwd : (inferred?.[1] ?? inferred?.[2])?.trim() ?? fallback;
  if (!isAbsolute(cwd)) throw new Error('Working directory must be an absolute path');
  const rawTurns = api === 'responses' ? (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : array(body.input)) : array(body.messages);
  const userMessages = rawTurns.map(object).filter(m => (m.role === 'user' || (api === 'responses' && !m.role && !m.type))).map(m => typeof m.content === 'string' ? userText(m.content) : array(m.content).map(object).filter(b => b.type === 'text' || b.type === 'input_text').map(b => userText(String(b.text ?? ''))).filter(t => t.length > 0).join('\n')).filter(t => t.length > 0);
  const tokens = body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
  return { model: String(body.model ?? 'milo'), messages, userMessages, tools, cwd, stream: body.stream === true, ...(typeof tokens === 'number' ? { maxTokens: tokens } : {}) };
}
function toolInput(arguments_: string): unknown {
  try { return JSON.parse(arguments_ || '{}'); } catch { return arguments_; }
}
export function encode(result: Completion, model: string, api: string) {
  const id = randomUUID(), input = result.inputTokens ?? 0, output = result.outputTokens ?? 0;
  if (api === 'messages') return { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [...(result.text ? [{ type: 'text', text: result.text }] : []), ...(result.calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: toolInput(c.function.arguments) }))], stop_reason: result.calls?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: input, output_tokens: output } };
  if (api === 'responses') return { id: `resp_${id}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', error: null, incomplete_details: null, model, output: [...(result.text ? [{ id: `msg_${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: result.text, annotations: [] }] }] : []), ...(result.calls ?? []).map(c => ({ id: `fc_${c.id}`, type: 'function_call', status: 'completed', call_id: c.id, name: c.function.name, arguments: c.function.arguments }))], usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, parallel_tool_calls: true, tools: [], tool_choice: 'auto' };
  return { id: `chatcmpl-${id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: result.text || null, ...(result.calls?.length ? { tool_calls: result.calls } : {}) }, finish_reason: result.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}
export function events(value: Obj, api: string): { event?: string; data: string }[] {
  const out: { event?: string; data: string }[] = [];
  let seq = 0;
  const push = (event: string, data: Obj) => out.push({ ...(api !== 'chat' ? { event } : {}), data: JSON.stringify(api === 'responses' ? { ...data, sequence_number: seq++ } : data) });
  if (api === 'chat') {
    const choice = object(array(value.choices)[0]), message = object(choice.message);
    const chunk = (delta: Obj, finish: unknown = null) => push('', { id: value.id, object: 'chat.completion.chunk', created: value.created, model: value.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    chunk({ role: 'assistant', content: '' });
    if (message.content) chunk({ content: message.content });
    array(message.tool_calls).forEach((c, index) => chunk({ tool_calls: [{ ...object(c), index }] }));
    chunk({}, choice.finish_reason);
    out.push({ data: '[DONE]' });
  } else if (api === 'messages') {
    push('message_start', { type: 'message_start', message: { ...value, content: [], stop_reason: null, usage: { ...object(value.usage), output_tokens: 0 } } });
    array(value.content).forEach((v, index) => {
      const b = object(v), tool = b.type === 'tool_use';
      push('content_block_start', { type: 'content_block_start', index, content_block: tool ? { ...b, input: {} } : { type: 'text', text: '' } });
      push('content_block_delta', { type: 'content_block_delta', index, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } : { type: 'text_delta', text: b.text } });
      push('content_block_stop', { type: 'content_block_stop', index });
    });
    push('message_delta', { type: 'message_delta', delta: { stop_reason: value.stop_reason, stop_sequence: null }, usage: { output_tokens: object(value.usage).output_tokens } });
    push('message_stop', { type: 'message_stop' });
  } else {
    for (const type of ['response.created', 'response.in_progress']) push(type, { type, response: { ...value, status: 'in_progress', output: [], usage: null } });
    array(value.output).forEach((v, output_index) => {
      const item = object(v), tool = item.type === 'function_call';
      push('response.output_item.added', { type: 'response.output_item.added', output_index, item: tool ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] } });
      const common = { item_id: item.id, output_index, content_index: 0 };
      if (tool) {
        push('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', ...common, delta: item.arguments });
        push('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', ...common, arguments: item.arguments });
      } else {
        const part = object(array(item.content)[0]);
        push('response.content_part.added', { type: 'response.content_part.added', ...common, part: { ...part, text: '' } });
        push('response.output_text.delta', { type: 'response.output_text.delta', ...common, delta: part.text, logprobs: [] });
        push('response.output_text.done', { type: 'response.output_text.done', ...common, text: part.text, logprobs: [] });
        push('response.content_part.done', { type: 'response.content_part.done', ...common, part });
      }
      push('response.output_item.done', { type: 'response.output_item.done', output_index, item });
    });
    push('response.completed', { type: 'response.completed', response: value });
  }
  return out;
}
export function createLocalApp(sources: Sources, options: { cwd?: string; port?: number; log?: (cwd: string) => void; dotsEnv?: NodeJS.ProcessEnv } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const port = options.port ?? 8788;
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || (c.req.raw.headers.has('origin') && c.req.path !== '/dots/pair')) return c.json({ error: { message: 'Forbidden local request' } }, 403);
    if (c.req.method === 'POST' && c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: { message: 'Content-Type must be application/json' } }, 415);
    await next();
  });
  app.get('/dots/pair', c => pairDots(c.req.raw, options.dotsEnv ?? process.env));
  app.get('/v1/models', async c => c.json({ object: 'list', data: (await sources.models()).map(id => ({ id, object: 'model', created: 0, owned_by: 'milo' })) }));
  for (const [path, api] of [['chat/completions', 'chat'], ['messages', 'messages'], ['responses', 'responses']] as const) {
    app.post(`/v1/${path}`, async c => {
      let request: ModelRequest;
      try { request = decode(object(await c.req.json()), api, options.cwd ?? process.cwd()); }
      catch (e) { return c.json({ ...(api === 'messages' ? { type: 'error' } : {}), error: { type: 'invalid_request_error', message: e instanceof Error ? e.message : 'Invalid request' } }, 400); }
      const local = housekeeping(request);
      options.log?.(`${request.cwd}; cwd=${request.cwd === (options.cwd ?? process.cwd()) ? 'fallback-or-explicit' : 'request'}; classification=${local === undefined ? 'user' : 'housekeeping'}`);
      const complete = (signal: AbortSignal) => local === undefined ? sources.complete(request, signal) : Promise.resolve({ text: local });
      const controller = new AbortController();
      const abort = () => controller.abort();
      c.req.raw.signal.addEventListener('abort', abort, { once: true });
      const failure = (e: unknown) => {
        const err = e instanceof SourceError ? e : new SourceError('upstream', 'Milo source failed');
        return { err, body: { ...(api === 'messages' ? { type: 'error' } : {}), error: { type: api === 'messages' ? 'api_error' : 'server_error', code: err.code, message: err.message } } };
      };
      if (request.stream) return streamSSE(c, async stream => {
        stream.onAbort(abort);
        // Send headers immediately and keep slow app turns alive without inventing model text.
        await stream.write(': Milo is waiting for the source\n\n');
        const ping = setInterval(() => { void stream.write(': keepalive\n\n').catch(abort); }, 15000);
        try {
          const result = encode(await complete(controller.signal), request.model, api);
          for (const event of events(result, api)) await stream.writeSSE(event);
        } catch (e) {
          const { body } = failure(e);
          await stream.writeSSE({ ...(api !== 'chat' ? { event: 'error' } : {}), data: JSON.stringify(api === 'responses' ? { type: 'error', code: body.error.code, message: body.error.message, param: null, sequence_number: 0 } : body) });
        } finally { clearInterval(ping); c.req.raw.signal.removeEventListener('abort', abort); }
      });
      try {
        return c.json(encode(await complete(controller.signal), request.model, api));
      } catch (e) {
        const { err, body } = failure(e);
        return c.json(body, err.code === 'timeout' ? 504 : 503);
      } finally { c.req.raw.signal.removeEventListener('abort', abort); }
    });
  }
  return app;
}
