import { pairDots } from './dots-link.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { housekeeping, userText } from './harness.js';
import { RequestError, SourceError, answeredBy, observeRequestInput } from './source.js';
import type { Completion, Message, ModelRequest, Tool, ToolCall, Sources } from './source.js';
import { currentDiagnosticContext, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticContext } from './diagnostics.js';
import { OBSERVATION_PATH, observationLimit, observeDaemon } from './observe.js';
import type { ObservationRuntime } from './observe.js';
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
// A saved conversation can hold a call whose arguments were never a JSON object: a reply cut off by its
// output limit and stored by the client, or an empty or non-object value. The client already ran or
// rejected that call, so only the unusable arguments are replaced, by "{}"; id, name and result stay.
// Valid arguments pass through byte for byte, so the same history always yields the same request.
function historicalArguments(value: unknown): string {
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return value; } catch { /* Replaced below. */ }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  return '{}';
}
function historicalCalls(calls: unknown): ToolCall[] | undefined {
  if (!Array.isArray(calls)) return calls as ToolCall[] | undefined;
  return calls.map(call => {
    const fn = object(call).function;
    return fn && typeof fn === 'object' && !Array.isArray(fn) ? { ...call, function: { ...fn, arguments: historicalArguments((fn as Obj).arguments) } } : call;
  });
}
// Image blocks of the three wire formats. Grunt forwards no image data to any source, so a conversation that holds an
// image is only routable to a source that lists image input. When none does (the free registry today), each block is
// replaced by a short, deterministic note instead of killing the whole conversation: the same bytes always give the
// same note, and the note never carries data, a URL or a path.
const IMAGE_BLOCKS = new Set(['image', 'input_image', 'image_url']);
const isImage = (block: unknown) => IMAGE_BLOCKS.has(String(object(block).type));
const hasImage = (content: unknown): boolean => Array.isArray(content) && content.some(block => isImage(block) || object(block).type === 'tool_result' && hasImage(object(block).content));
function imageNote(block: unknown): string {
  const b = object(block), source = object(b.source), ref = object(b.image_url);
  const url = typeof b.image_url === 'string' ? b.image_url : typeof ref.url === 'string' ? ref.url : undefined;
  const embedded = url === undefined ? undefined : /^data:([a-z]+\/[a-z0-9.+-]{1,40})?(?:;[^,;]*)*;base64,/i.exec(url);
  const mediaType = typeof source.media_type === 'string' && /^[a-z]+\/[a-z0-9.+-]{1,40}$/i.test(source.media_type) ? source.media_type : embedded?.[1];
  const data = typeof source.data === 'string' ? source.data : embedded && url ? url.slice(embedded[0].length) : undefined;
  const bytes = data !== undefined && /^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0 ? data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : undefined;
  const detail = [mediaType?.toLowerCase(), bytes === undefined ? undefined : `${bytes} bytes`].filter(Boolean).join(', ');
  return `[image omitted${detail ? ` (${detail})` : ''}: no free source on this route accepts images; inspect it with tools instead]`;
}
function noImages(content: unknown): unknown {
  if (!hasImage(content)) return content;
  return (content as unknown[]).map(block => isImage(block) ? { type: 'text', text: imageNote(block) }
    : object(block).type === 'tool_result' ? { ...object(block), content: noImages(object(block).content) } : block);
}
// Content positions only: tool arguments that happen to hold {"type":"image"} are never touched.
function withoutImages(body: Obj, api: string): Obj {
  const turns = api === 'responses' ? body.input : body.messages;
  if (!Array.isArray(turns)) return body;
  const swapped = turns.map(value => {
    const m = object(value);
    if (!hasImage(m.content) && !hasImage(m.output)) return value;
    return { ...m, ...(hasImage(m.content) ? { content: noImages(m.content) } : {}), ...(hasImage(m.output) ? { output: text(noImages(m.output)) } : {}) };
  });
  return { ...body, [api === 'responses' ? 'input' : 'messages']: swapped };
}
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
// Responses input is a flat item list. Parallel function_call items form one assistant turn, and message
// items that arrive while calls are unanswered wait until the matching outputs, so results stay adjacent.
function responsesMessages(items: unknown[]): Message[] {
  const out: Message[] = [], pending = new Set<string>(), held: Message[] = [];
  const flush = () => { if (!pending.size) out.push(...held.splice(0)); };
  for (const v of items) {
    const m = object(v);
    if (m.type === 'function_call_output') {
      pending.delete(String(m.call_id));
      out.push({ role: 'tool', content: typeof m.output === 'string' ? m.output : JSON.stringify(m.output) ?? '', tool_call_id: String(m.call_id) });
      flush();
    } else if (m.type === 'function_call') {
      const call: ToolCall = { id: String(m.call_id), type: 'function', function: { name: typeof m.namespace === 'string' ? `${m.namespace}__${String(m.name)}` : String(m.name), arguments: historicalArguments(m.arguments) } };
      const last = out.at(-1);
      if (last?.role === 'assistant' && last.tool_calls?.length && !held.length && !last.content) last.tool_calls.push(call);
      else out.push({ role: 'assistant', content: '', tool_calls: [call] });
      pending.add(call.id);
    } else if (!m.type || m.type === 'message') {
      const message = { role: String(m.role ?? 'user'), content: text(m.content) };
      if (pending.size) held.push(message); else out.push(message);
    }
  }
  out.push(...held);
  return out;
}
export function decode(original: Obj, api: string, fallback?: string, options: { omitImages?: boolean } = {}): ModelRequest & {
  cwdSource: 'request' | 'fallback' | 'scratch';
  responseNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>;
} {
  // Only the messages are rewritten. The task key (userMessages) still comes from the original turns, so stickiness is the same
  // with or without the note.
  const body = options.omitImages ? withoutImages(original, api) : original;
  let messages: Message[];
  if (api === 'responses') {
    messages = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : responsesMessages(array(body.input));
    if (body.instructions) messages.unshift({ role: 'developer', content: text(body.instructions) });
  } else {
    messages = array(body.messages).flatMap(v => {
      const m = object(v);
      if (api !== 'messages' || typeof m.content === 'string') return [{ role: String(m.role), content: text(m.content), ...(m.tool_calls ? { tool_calls: historicalCalls(m.tool_calls)! } : {}), ...(m.tool_call_id ? { tool_call_id: String(m.tool_call_id) } : {}) }];
      const blocks = array(m.content).map(object);
      const calls: ToolCall[] = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: String(b.id), type: 'function', function: { name: String(b.name), arguments: historicalArguments(b.input) } }));
      const content = text(blocks.filter(b => b.type !== 'tool_use' && b.type !== 'tool_result'));
      const turn: Message[] = content || calls.length ? [{ role: String(m.role), content, ...(calls.length ? { tool_calls: calls } : {}) }] : [];
      // Results answer the assistant's tool calls, so they must directly follow them. Claude Code adds
      // reminders and queued commands as text blocks beside the results; that text comes after them.
      return [...blocks.filter(b => b.type === 'tool_result').map(b => ({ role: 'tool', content: text(b.content), tool_call_id: String(b.tool_use_id) })), ...turn];
    });
    if (body.system) messages.unshift({ role: 'system', content: text(body.system) });
  }
  if (!messages.length) throw new Error('Provide messages or input');
  const responseNamespaces = new Map<string, { namespace: string; name: string }>();
  const tools: Tool[] = array(body.tools).flatMap((v): Tool[] => {
    const t = object(v), f = object(t.function ?? t);
    if (api === 'responses' && t.type === 'namespace' && typeof t.name === 'string') {
      const namespace = t.name;
      return array(t.tools).flatMap((value): Tool[] => {
        const child = object(value);
        if (child.type !== 'function' || typeof child.name !== 'string') return [];
        const name = `${namespace}__${child.name}`;
        responseNamespaces.set(name, { namespace, name: child.name });
        return [{ type: 'function', function: { name, parameters: child.parameters ?? {}, ...(typeof child.description === 'string' ? { description: child.description } : {}) } }];
      });
    }
    if (t.type && t.type !== 'function' && !t.input_schema) return [t as Tool];
    return [{ type: 'function', function: { name: String(f.name), parameters: f.parameters ?? f.input_schema ?? {}, ...(typeof f.description === 'string' ? { description: f.description } : {}) } }];
  });
  const context = messages.filter(m => ['system', 'developer'].includes(m.role) || /<environment_context>|# Environment/.test(m.content)).map(m => m.content).join('\n');
  const matches = [...context.matchAll(/(?:<cwd>\s*([^<\n]+)\s*<\/cwd>|(?:Working directory|Current working directory|Primary working directory|cwd):\s*([^\n<]+))/gi)];
  const absolute = matches.filter(m => isAbsolute((m[1] ?? m[2] ?? '').trim()));
  const inferred = absolute.find(m => /^Primary working directory:/i.test(m[0])) ?? absolute[0];
  const namedCwd = typeof body.cwd === 'string' ? body.cwd : (inferred?.[1] ?? inferred?.[2])?.trim();
  const rawTurns = api === 'responses' ? (typeof original.input === 'string' ? [{ role: 'user', content: original.input }] : array(original.input)) : array(original.messages);
  const userMessages = rawTurns.map(object).filter(m => (m.role === 'user' || (api === 'responses' && !m.role && !m.type))).map(m => typeof m.content === 'string' ? userText(m.content) : array(m.content).map(object).filter(b => b.type === 'text' || b.type === 'input_text').map(b => userText(String(b.text ?? ''))).filter(t => t.length > 0).join('\n')).filter(t => t.length > 0);
  const cwdSource = namedCwd !== undefined ? 'request' : fallback !== undefined ? 'fallback' : 'scratch';
  const cwd = namedCwd ?? fallback ?? join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'grunt/scratch', createHash('sha256').update(userMessages[0] ?? '').digest('hex').slice(0, 24));
  if (!isAbsolute(cwd)) throw new Error('Working directory must be an absolute path');
  const tokens = body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
  const imageInput = !options.omitImages && /"type"\s*:\s*"(?:image|input_image|image_url)"/.test(JSON.stringify(body.input ?? body.messages));
  return { model: String(body.model ?? 'grunt'), messages, userMessages, tools, cwd, cwdSource, ...(responseNamespaces.size ? { responseNamespaces } : {}), stream: body.stream === true, ...(imageInput ? { imageInput: true } : {}), ...(typeof tokens === 'number' ? { maxTokens: tokens } : {}) };
}
function toolInput(arguments_: string): unknown {
  try { return JSON.parse(arguments_ || '{}'); } catch { return arguments_; }
}
interface ChatUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
// Preserve the legacy JSON encoding without presenting its fallback zeros as
// measured token counts to streaming clients. Entries die with their response.
const encodedChatUsage = new WeakMap<Obj, ChatUsage | null>();
function measuredChatUsage(input: unknown, output: unknown): ChatUsage | null {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0
    || typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0
    || !Number.isSafeInteger(input + output)) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}
export function encode(result: Completion, model: string, api: string, namespaces?: ReadonlyMap<string, { namespace: string; name: string }>) {
  const id = randomUUID(), input = result.inputTokens ?? 0, output = result.outputTokens ?? 0;
  if (api === 'messages') return { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [...(result.text ? [{ type: 'text', text: result.text }] : []), ...(result.calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: toolInput(c.function.arguments) }))], stop_reason: result.finishReason === 'length' ? 'max_tokens' : result.calls?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: input, output_tokens: output } };
  const status = result.finishReason === 'length' ? 'incomplete' : 'completed';
  if (api === 'responses') return { id: `resp_${id}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status, error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null, model, output: [...(result.text ? [{ id: `msg_${id}`, type: 'message', status, role: 'assistant', content: [{ type: 'output_text', text: result.text, annotations: [] }] }] : []), ...(result.calls ?? []).map(c => ({ id: `fc_${c.id}`, type: 'function_call', status, call_id: c.id, ...(namespaces?.get(c.function.name) ?? { name: c.function.name }), arguments: c.function.arguments }))], usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, parallel_tool_calls: true, tools: [], tool_choice: 'auto' };
  const value = { id: `chatcmpl-${id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: result.text || null, ...(result.calls?.length ? { tool_calls: result.calls } : {}) }, finish_reason: result.finishReason ?? (result.calls?.length ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
  encodedChatUsage.set(value, measuredChatUsage(result.inputTokens, result.outputTokens));
  return value;
}
export function events(value: Obj, api: string, options: { includeUsage?: boolean } = {}): { event?: string; data: string }[] {
  const out: { event?: string; data: string }[] = [];
  let seq = 0;
  const push = (event: string, data: Obj) => out.push({ ...(api !== 'chat' ? { event } : {}), data: JSON.stringify(api === 'responses' ? { ...data, sequence_number: seq++ } : data) });
  if (api === 'chat') {
    const choice = object(array(value.choices)[0]), message = object(choice.message);
    const base = { id: value.id, object: 'chat.completion.chunk', created: value.created, model: value.model };
    const chunk = (delta: Obj, finish: unknown = null) => push('', { ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...(options.includeUsage ? { usage: null } : {}) });
    chunk({ role: 'assistant', content: '' });
    if (message.content) chunk({ content: message.content });
    array(message.tool_calls).forEach((c, index) => chunk({ tool_calls: [{ ...object(c), index }] }));
    chunk({}, choice.finish_reason);
    if (options.includeUsage) {
      const raw = object(value.usage);
      const usage = encodedChatUsage.has(value) ? encodedChatUsage.get(value)!
        : measuredChatUsage(raw.prompt_tokens, raw.completion_tokens);
      push('', { ...base, choices: [], usage });
    }
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
    for (const type of ['response.created', 'response.in_progress']) push(type, { type, response: { ...value, status: 'in_progress', incomplete_details: null, output: [], usage: null } });
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
    const terminal = value.status === 'incomplete' ? 'response.incomplete' : 'response.completed';
    push(terminal, { type: terminal, response: value });
  }
  return out;
}
const removedWorkers = (c: Context) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: false, code: 'unavailable', error: { type: 'removed', message: 'Grunt subworkers were removed. Use your coding harness\'s own subagents; update or stop the installed grunt_delegate/grunt_spawn tools.' } }, 410);
};
const inferenceEndpoints = new Map<string, 'chat' | 'messages' | 'responses'>([
  ['/v1/chat/completions', 'chat'], ['/v1/messages', 'messages'], ['/v1/responses', 'responses']
]);
const callerAgents = [['claude-code', /\bclaude-cli\b|\bclaude-code\b/i], ['codex', /\bcodex(?:[-_][\w-]+)?\b/i],
  ['opencode', /\bopencode\b/i], ['beeline', /\bbeeline\b/i], ['pi', /\bpi-coding-agent\b/i]] as const;

export function createLocalApp(sources: Sources, options: { cwd?: string; port?: number; log?: (cwd: string) => void; dotsEnv?: NodeJS.ProcessEnv; observation?: () => ObservationRuntime } = {}) {
  const app = new Hono();
  const startedAt = Date.now();
  app.use('*', async (c, next) => {
    const port = options.port ?? 8788;
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || (c.req.raw.headers.has('origin') && c.req.path !== '/dots/pair')) return c.json({ error: { message: 'Forbidden local request' } }, 403);
    const endpoint = c.req.method === 'POST' ? inferenceEndpoints.get(c.req.path) : undefined;
    const tracked = endpoint !== undefined;
    const store = sources.diagnosticStore(), requestId = randomUUID(), started = Date.now(), startedMono = performance.now();
    const context: DiagnosticContext = { requestId, kind: 'user', actor: 'client', requestRecorded: true, ...(store ? { sink: store } : {}) };
    if (tracked) {
      c.header('X-Grunt-Request-Id', requestId);
      const caller = c.req.header('x-grunt-caller')?.toLowerCase()
        ?? callerAgents.find(([, pattern]) => pattern.test(c.req.header('user-agent') ?? ''))?.[0];
      store?.record({ version: 1, id: randomUUID(), at: started, requestId, kind: 'user', actor: 'client', type: 'request.start', endpoint,
        ...(caller === undefined ? {} : { caller }) });
    }
    let status: number | undefined;
    const run = async () => {
      try {
        if (c.req.method === 'POST' && c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { status = 415; return c.json({ error: { message: 'Content-Type must be application/json' } }, 415); }
        await next();
      } catch (error) { status = 500; throw error; }
      finally {
        if (tracked) {
          const httpStatus = status ?? c.res.status, source = c.res.headers.get('X-Grunt-Source');
          store?.record({ version: 1, id: randomUUID(), at: Date.now(), requestId, kind: context.kind, type: 'request.finish', httpStatus,
            durationMs: Math.max(0, performance.now() - startedMono), outcome: c.req.raw.signal.aborted ? 'cancelled' : httpStatus >= 400 ? 'failed' : 'passed',
            ...(source ? { source } : {}), ...(context.local ? { reason: 'local' } : {}), ...(context.errorCode ? { errorCode: context.errorCode } : {}),
            ...(context.responseBytes === undefined ? {} : { responseBytes: context.responseBytes }),
            ...(context.incomplete ? { failureReason: 'length' } : {}) });
        }
      }
    };
    return tracked ? withDiagnosticContext(context, run) : run();
  });
  app.get('/dots/pair', c => pairDots(c.req.raw, options.dotsEnv ?? process.env));
  app.get('/v1/status', c => {
    c.header('Cache-Control', 'no-store');
    return c.json(sources.status());
  });
  app.get(OBSERVATION_PATH, async c => {
    c.header('Cache-Control', 'no-store');
    let limit: number;
    try { limit = observationLimit(c.req.query('limit')); }
    catch { return c.json({ error: 'Observation limit must be a nonnegative integer' }, 400); }
    return c.json(await observeDaemon(sources, limit, options.observation?.() ?? { port: options.port ?? 8788, startedAt }));
  });
  // Grunt subworkers were removed. Older installed Pi extensions and MCP servers get a clear
  // error shaped like their old failure response (code 'unavailable') instead of a bare 404.
  app.all('/v1/workers/*', removedWorkers);
  app.all('/v1/workers', removedWorkers);
  app.get('/v1/diagnostics/events', async c => {
    c.header('Cache-Control', 'no-store'); const store = sources.diagnosticStore();
    if (!store) return c.json({ error: 'Diagnostics are not enabled' }, 503);
    try {
      const after = c.req.query('after'), source = c.req.query('source'), requestId = c.req.query('requestId'), limit = c.req.query('limit');
      return c.json(await store.list({ ...(after === undefined ? {} : { after }), ...(source === undefined ? {} : { source }), ...(requestId === undefined ? {} : { requestId }),
        ...(limit === undefined ? {} : { limit: Number(limit) }), includeDetails: c.req.query('details') === '1' }));
    } catch { return c.json({ error: 'Invalid diagnostic filter' }, 400); }
  });
  app.get('/v1/diagnostics/summary', async c => {
    c.header('Cache-Control', 'no-store'); const store = sources.diagnosticStore();
    if (!store) return c.json({ error: 'Diagnostics are not enabled' }, 503);
    try { const since = c.req.query('since'); return c.json(await store.summary(since === undefined ? {} : { since: Number(since) })); }
    catch { return c.json({ error: 'Invalid diagnostic time' }, 400); }
  });
  app.get('/v1/diagnostics/metrics', async c => {
    c.header('Cache-Control', 'no-store'); const store = sources.diagnosticStore();
    if (!store) return c.json({ error: 'Diagnostics are not enabled' }, 503);
    try {
      const since = c.req.query('since'), until = c.req.query('until');
      const result = await store.metrics({ ...(since === undefined ? {} : { since: Number(since) }), ...(until === undefined ? {} : { until: Number(until) }) });
      return c.json(result, result.coverage.available ? 200 : 503);
    } catch { return c.json({ error: 'Invalid diagnostic metrics window' }, 400); }
  });
  app.get('/v1/diagnostics/traces/:id', async c => {
    c.header('Cache-Control', 'no-store'); const store = sources.diagnosticStore();
    if (!store) return c.json({ error: 'Diagnostics are not enabled' }, 503);
    try { return c.json(await store.trace(c.req.param('id'))); }
    catch { return c.json({ error: 'Invalid diagnostic identifier' }, 400); }
  });
  app.get('/v1/models', async c => c.json({ object: 'list', data: (await sources.models()).map(id => ({ id, object: 'model', created: 0, owned_by: 'grunt' })) }));
  for (const [path, api] of [['chat/completions', 'chat'], ['messages', 'messages'], ['responses', 'responses']] as const) {
    app.post(`/v1/${path}`, async c => {
      let request: ReturnType<typeof decode>;
      let includeUsage = false;
      try {
        const body = object(await c.req.json());
        request = decode(body, api, options.cwd);
        // Same conversation as text when no source could take the image. Otherwise it is routed as sent.
        if (request.imageInput && !sources.acceptsImages(request)) request = decode(body, api, options.cwd, { omitImages: true });
        includeUsage = api === 'chat' && object(body.stream_options).include_usage === true;
      }
      catch (e) { return c.json({ ...(api === 'messages' ? { type: 'error' } : {}), error: { type: 'invalid_request_error', message: e instanceof Error ? e.message : 'Invalid request' } }, 400); }
      observeRequestInput(request);
      if (c.req.header('x-grunt-context') === 'public') request.publicContext = true;
      const local = housekeeping(request);
      if (local !== undefined) { const context = currentDiagnosticContext(); if (context) context.local = true; }
      options.log?.(`${request.cwd}; cwd=${request.cwdSource}; classification=${local === undefined ? 'user' : 'housekeeping'}`);
      const complete = (signal: AbortSignal, onStreamText?: (source: string, text: string) => void): Promise<Completion> => local === undefined ? sources.complete(request, signal, onStreamText) : Promise.resolve({ text: local });
      const controller = new AbortController();
      const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
      const failure = (e: unknown) => {
        const err = e instanceof SourceError ? e : new SourceError('upstream', 'grunt source failed');
        const invalid = err instanceof RequestError;
        return { err, body: { ...(api === 'messages' ? { type: 'error' } : {}), error: { type: invalid ? 'invalid_request_error' : api === 'messages' ? 'api_error' : 'server_error', code: err.code, message: err.message } } };
      };
      try {
        if (request.cwdSource === 'scratch') await mkdir(request.cwd, { recursive: true });
        if (request.stream && local === undefined) {
          // Wait until either the first verified text delta arrives (committing SSE headers
          // so tokens stream incrementally) or the completion settles/fails (preserving HTTP
          // 429/5xx failover before the first delta and non-streaming/tool-call fallback).
          const queue: string[] = [];
          let wake: (() => void) | undefined;
          let startedSource: string | undefined;
          let streamStarted = false;
          let done = false;
          let completionResult: Completion | undefined;
          let completionError: unknown;
          let resolveReady!: () => void;
          const ready = new Promise<void>(resolve => { resolveReady = resolve; });
          const notify = () => { wake?.(); wake = undefined; };
          const onText = (sourceId: string, delta: string) => {
            if (!delta) return;
            if (!streamStarted) {
              streamStarted = true;
              startedSource = sourceId;
              queue.push(delta);
              resolveReady();
            } else {
              queue.push(delta);
              notify();
            }
          };
          void complete(signal, onText).then(
            result => { completionResult = result; done = true; resolveReady(); notify(); },
            error => { completionError = error; done = true; resolveReady(); notify(); }
          );
          await ready;
          if (!streamStarted) {
            if (completionError !== undefined) throw completionError;
            signal.throwIfAborted();
            const completion = completionResult!;
            const context = currentDiagnosticContext();
            if (context) context.responseBytes = Buffer.byteLength(completion.text);
            const source = answeredBy.get(completion);
            if (source) c.header('X-Grunt-Source', source);
            if (sources.preparing.size) c.header('X-Grunt-Preparing', [...sources.preparing].join(','));
            const result = encode(completion, request.model, api, request.responseNamespaces);
            return streamSSE(c, async stream => {
              stream.onAbort(() => controller.abort());
              for (const event of events(result, api, { includeUsage })) await stream.writeSSE(event);
            });
          }
          if (startedSource) c.header('X-Grunt-Source', startedSource);
          if (sources.preparing.size) c.header('X-Grunt-Preparing', [...sources.preparing].join(','));
          const context = currentDiagnosticContext();
          return streamSSE(c, async stream => {
            stream.onAbort(() => { controller.abort(); notify(); });
            const nextDelta = async (): Promise<string | undefined> => {
              while (!queue.length && !done && !signal.aborted) {
                await new Promise<void>(resolve => { wake = resolve; });
              }
              return queue.shift();
            };
            const id = randomUUID(), created = Math.floor(Date.now() / 1000);
            if (api === 'chat') {
              const base = { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created, model: request.model };
              const writeChunk = (delta: Obj, finish: unknown = null) => stream.writeSSE({
                data: JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...(includeUsage ? { usage: null } : {}) })
              });
              await writeChunk({ role: 'assistant', content: '' });
              for (let delta = await nextDelta(); delta !== undefined; delta = await nextDelta()) {
                await writeChunk({ content: delta });
              }
              if (signal.aborted || completionError !== undefined || !completionResult) return;
              if (context) context.responseBytes = Buffer.byteLength(completionResult.text);
              for (let index = 0; index < (completionResult.calls?.length ?? 0); index++) {
                await writeChunk({ tool_calls: [{ ...completionResult.calls![index]!, index }] });
              }
              const finishReason = completionResult.finishReason ?? (completionResult.calls?.length ? 'tool_calls' : 'stop');
              await writeChunk({}, finishReason);
              if (includeUsage) {
                const usage = measuredChatUsage(completionResult.inputTokens, completionResult.outputTokens);
                await stream.writeSSE({ data: JSON.stringify({ ...base, choices: [], usage }) });
              }
              await stream.writeSSE({ data: '[DONE]' });
            } else if (api === 'messages') {
              const msgId = `msg_${id}`;
              await stream.writeSSE({ event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }) });
              await stream.writeSSE({ event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) });
              for (let delta = await nextDelta(); delta !== undefined; delta = await nextDelta()) {
                await stream.writeSSE({ event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }) });
              }
              if (signal.aborted) return;
              if (completionError !== undefined || !completionResult) {
                const { err } = failure(completionError);
                await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }) });
                return;
              }
              if (context) context.responseBytes = Buffer.byteLength(completionResult.text);
              await stream.writeSSE({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) });
              for (let i = 0; i < (completionResult.calls?.length ?? 0); i++) {
                const call = completionResult.calls![i]!, index = i + 1;
                await stream.writeSSE({ event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.function.name, input: {} } }) });
                await stream.writeSSE({ event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput(call.function.arguments)) } }) });
                await stream.writeSSE({ event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index }) });
              }
              const stopReason = completionResult.finishReason === 'length' ? 'max_tokens' : completionResult.calls?.length ? 'tool_use' : 'end_turn';
              await stream.writeSSE({ event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: completionResult.outputTokens ?? 0 } }) });
              await stream.writeSSE({ event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) });
            } else {
              let seq = 0;
              const respId = `resp_${id}`, msgId = `msg_${id}`;
              const push = (event: string, data: Obj) => stream.writeSSE({ event, data: JSON.stringify({ ...data, sequence_number: seq++ }) });
              const inProgress = { id: respId, object: 'response', created_at: created, status: 'in_progress', error: null, incomplete_details: null, model: request.model, output: [], usage: null, parallel_tool_calls: true, tools: [], tool_choice: 'auto' };
              await push('response.created', { type: 'response.created', response: inProgress });
              await push('response.in_progress', { type: 'response.in_progress', response: inProgress });
              await push('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
              await push('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
              for (let delta = await nextDelta(); delta !== undefined; delta = await nextDelta()) {
                await push('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta, logprobs: [] });
              }
              if (signal.aborted) return;
              if (completionError !== undefined || !completionResult) {
                const { err } = failure(completionError);
                await push('error', { type: 'error', code: err.code, message: err.message });
                return;
              }
              if (context) context.responseBytes = Buffer.byteLength(completionResult.text);
              const status = completionResult.finishReason === 'length' ? 'incomplete' : 'completed';
              const part = { type: 'output_text', text: completionResult.text, annotations: [] };
              const msgItem = { id: msgId, type: 'message', status, role: 'assistant', content: [part] };
              await push('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text: completionResult.text, logprobs: [] });
              await push('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part });
              await push('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: msgItem });
              const outputItems: Obj[] = [msgItem];
              for (let i = 0; i < (completionResult.calls?.length ?? 0); i++) {
                const call = completionResult.calls![i]!, outputIndex = i + 1;
                const fcItem: Obj = { id: `fc_${call.id}`, type: 'function_call', status, call_id: call.id, ...(request.responseNamespaces?.get(call.function.name) ?? { name: call.function.name }), arguments: call.function.arguments };
                outputItems.push(fcItem);
                await push('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...fcItem, status: 'in_progress', arguments: '' } });
                const common = { item_id: fcItem.id, output_index: outputIndex, content_index: 0 };
                await push('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', ...common, delta: call.function.arguments });
                await push('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', ...common, arguments: call.function.arguments });
                await push('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: fcItem });
              }
              const input = completionResult.inputTokens ?? 0, output = completionResult.outputTokens ?? 0;
              const finalResponse = { ...inProgress, status, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null, output: outputItems, usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
              const terminal = status === 'incomplete' ? 'response.incomplete' : 'response.completed';
              await push(terminal, { type: terminal, response: finalResponse });
            }
          });
        }
        const completion = await complete(signal);
        signal.throwIfAborted();
        const context = currentDiagnosticContext();
        if (context) context.responseBytes = Buffer.byteLength(completion.text);
        const source = answeredBy.get(completion);
        if (source) c.header('X-Grunt-Source', source);
        if (sources.preparing.size) c.header('X-Grunt-Preparing', [...sources.preparing].join(','));
        const result = encode(completion, request.model, api, request.responseNamespaces);
        if (request.stream) return streamSSE(c, async stream => {
          stream.onAbort(() => controller.abort());
          for (const event of events(result, api, { includeUsage })) await stream.writeSSE(event);
        });
        return c.json(result);
      } catch (e) {
        const { err, body } = failure(e);
        if (sources.preparing.size) c.header('X-Grunt-Preparing', [...sources.preparing].join(','));
        if (err.retryAfter !== undefined) c.header('Retry-After', String(Math.max(1, Math.ceil(err.retryAfter))));
        return c.json(body, err instanceof RequestError ? 400 : err.code === 'quota' ? 429 : err.code === 'timeout' ? 504 : 503);
      }
    });
  }
  return app;
}
