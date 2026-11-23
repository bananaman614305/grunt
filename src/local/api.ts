import { pairDots } from './dots-link.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { housekeeping, userText } from './harness.js';
import { RequestError, SourceError, answeredBy } from './source.js';
import type { Completion, Message, ModelRequest, Tool, ToolCall, Sources } from './source.js';
import { currentDiagnosticContext, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticContext } from './diagnostics.js';
import type { WorkerPool } from './worker-pool.js';
import { WorkerScopes, WorkerScopeError } from './worker-scopes.js';
import { getWorkerCapabilities } from './worker-workspace.js';
import { WORKER_SNAPSHOT_TRANSPORT } from './worker-transport.js';
import { validOwnedPath } from './worker-agent.js';
import type { WorkerInitialFile } from './worker-agent.js';
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
export function decode(body: Obj, api: string, fallback?: string): ModelRequest & {
  cwdSource: 'request' | 'fallback' | 'scratch';
  responseNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>;
} {
  let messages: Message[];
  if (api === 'responses') {
    messages = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : array(body.input).flatMap((v): Message[] => {
      const m = object(v);
      if (m.type === 'function_call_output') return [{ role: 'tool', content: typeof m.output === 'string' ? m.output : JSON.stringify(m.output) ?? '', tool_call_id: String(m.call_id) }];
      if (m.type === 'function_call') return [{ role: 'assistant', content: '', tool_calls: [{ id: String(m.call_id), type: 'function', function: { name: typeof m.namespace === 'string' ? `${m.namespace}__${String(m.name)}` : String(m.name), arguments: String(m.arguments) } }] }];
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
  const rawTurns = api === 'responses' ? (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : array(body.input)) : array(body.messages);
  const userMessages = rawTurns.map(object).filter(m => (m.role === 'user' || (api === 'responses' && !m.role && !m.type))).map(m => typeof m.content === 'string' ? userText(m.content) : array(m.content).map(object).filter(b => b.type === 'text' || b.type === 'input_text').map(b => userText(String(b.text ?? ''))).filter(t => t.length > 0).join('\n')).filter(t => t.length > 0);
  const cwdSource = namedCwd !== undefined ? 'request' : fallback !== undefined ? 'fallback' : 'scratch';
  const cwd = namedCwd ?? fallback ?? join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'grunt/scratch', createHash('sha256').update(userMessages[0] ?? '').digest('hex').slice(0, 24));
  if (!isAbsolute(cwd)) throw new Error('Working directory must be an absolute path');
  const tokens = body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
  const imageInput = /"type"\s*:\s*"(?:image|input_image|image_url)"/.test(JSON.stringify(body.input ?? body.messages));
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
  if (api === 'messages') return { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [...(result.text ? [{ type: 'text', text: result.text }] : []), ...(result.calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: toolInput(c.function.arguments) }))], stop_reason: result.calls?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: input, output_tokens: output } };
  if (api === 'responses') return { id: `resp_${id}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', error: null, incomplete_details: null, model, output: [...(result.text ? [{ id: `msg_${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: result.text, annotations: [] }] }] : []), ...(result.calls ?? []).map(c => ({ id: `fc_${c.id}`, type: 'function_call', status: 'completed', call_id: c.id, ...(namespaces?.get(c.function.name) ?? { name: c.function.name }), arguments: c.function.arguments }))], usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, parallel_tool_calls: true, tools: [], tool_choice: 'auto' };
  const value = { id: `chatcmpl-${id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: result.text || null, ...(result.calls?.length ? { tool_calls: result.calls } : {}) }, finish_reason: result.calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
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
/** Strictly bounded transport data, not model-controlled filesystem authority. */
function parseWorkerSnapshot(input: unknown): WorkerInitialFile[] | undefined {
  if (!Array.isArray(input) || input.length > 5000) return;
  const paths = new Set<string>();
  let bytes = 0;
  const files: WorkerInitialFile[] = [];
  for (const value of input) {
    const row = object(value);
    if (Object.keys(row).some(key => !['path', 'content', 'binary', 'sha256'].includes(key)) || !validOwnedPath(row.path)
      || paths.has(row.path) || typeof row.content !== 'string' || row.binary !== undefined && typeof row.binary !== 'boolean'
      || row.sha256 !== undefined && (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256))) return;
    if (row.binary && (row.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.content))) return;
    const content = Buffer.from(row.content, row.binary ? 'base64' : 'utf8');
    if (row.binary && content.toString('base64') !== row.content) return;
    bytes += content.byteLength;
    if (content.byteLength > WORKER_SNAPSHOT_TRANSPORT.maxFileBytes || bytes > WORKER_SNAPSHOT_TRANSPORT.maxSnapshotBytes
      || row.sha256 && createHash('sha256').update(content).digest('hex') !== row.sha256) return;
    paths.add(row.path);
    files.push({ path: row.path, content: row.content, ...(row.binary === undefined ? {} : { binary: row.binary }), ...(row.sha256 === undefined ? {} : { sha256: row.sha256 as string }) });
  }
  return files;
}
export function createLocalApp(sources: Sources, options: { cwd?: string; port?: number; log?: (cwd: string) => void; dotsEnv?: NodeJS.ProcessEnv; workers?: WorkerPool; workerScopes?: WorkerScopes } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const port = options.port ?? 8788;
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || (c.req.raw.headers.has('origin') && c.req.path !== '/dots/pair')) return c.json({ error: { message: 'Forbidden local request' } }, 403);
    const tracked = c.req.method === 'POST' && ['/v1/chat/completions', '/v1/messages', '/v1/responses'].includes(c.req.path);
    const store = sources.diagnosticStore(), requestId = randomUUID(), started = Date.now(), startedMono = performance.now();
    const context: DiagnosticContext = { requestId, kind: 'user', actor: 'client', requestRecorded: true, ...(store ? { sink: store } : {}) };
    if (tracked) { c.header('X-Grunt-Request-Id', requestId); store?.record({ version: 1, id: randomUUID(), at: started, requestId, kind: 'user', actor: 'client', type: 'request.start' }); }
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
            ...(source ? { source } : {}), ...(context.local ? { reason: 'local' } : {}), ...(context.errorCode ? { errorCode: context.errorCode } : {}) });
        }
      }
    };
    return tracked ? withDiagnosticContext(context, run) : run();
  });
  app.get('/dots/pair', c => pairDots(c.req.raw, options.dotsEnv ?? process.env));
  const workers = options.workers;
  app.get('/v1/status', c => {
    c.header('Cache-Control', 'no-store');
    return c.json({ ...sources.status(), ...(workers ? { workers: workers.status() } : {}) });
  });
  if (workers) {
    const scopes = options.workerScopes ?? new WorkerScopes();
    const token = (authorization: string | undefined) => authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const smallBody = bodyLimit({ maxSize: 8 * 1024, onError: c => c.json({ ok: false, code: 'invalid_task' }, 413) });
    app.use('/v1/workers/*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      try { await workers.ready(); } catch { return c.json({ ok: false, code: 'unavailable' }, 503); }
      await next();
    });
    app.get('/v1/workers', c => {
      c.header('Cache-Control', 'no-store');
      return c.json(workers.status());
    });
    app.get('/v1/workers/capabilities', async c => c.json({ ...await getWorkerCapabilities(), snapshotTransport: WORKER_SNAPSHOT_TRANSPORT }));
    app.post('/v1/workers/projects/challenge', smallBody, async c => {
      try {
        const body = object(await c.req.json());
        if (Object.keys(body).length !== 1 || !('projectRoot' in body)) return c.json({ ok: false, code: 'invalid_task' }, 400);
        return c.json(await scopes.challenge(body.projectRoot));
      } catch (error) { return c.json({ ok: false, code: error instanceof WorkerScopeError ? error.code : 'invalid_task' }, error instanceof WorkerScopeError && error.code === 'busy' ? 429 : 400); }
    });
    app.post('/v1/workers/projects/register', smallBody, async c => {
      try {
        const body = object(await c.req.json());
        if (Object.keys(body).length !== 1 || !('challengeId' in body)) return c.json({ ok: false, code: 'invalid_task' }, 400);
        return c.json(await scopes.register(body.challengeId));
      } catch (error) { return c.json({ ok: false, code: error instanceof WorkerScopeError ? error.code : 'invalid_task' }, error instanceof WorkerScopeError ? 403 : 400); }
    });
    app.post('/v1/workers/projects/revoke', smallBody, c => c.json({ ok: scopes.revoke(token(c.req.header('authorization'))) }));
    app.get('/v1/workers/retained', async c => {
      const scope = await scopes.resolve(token(c.req.header('authorization')));
      if (!scope) return c.json({ ok: false, code: 'invalid_scope' }, 403);
      return c.json({ retained: workers.retained(scope) });
    });
    app.get('/v1/workers/artifacts/:id', async c => {
      const scope = await scopes.resolve(token(c.req.header('authorization')));
      if (!scope) return c.json({ ok: false, code: 'invalid_scope' }, 403);
      const artifact = workers.artifact(c.req.param('id'), scope), ownedPaths = workers.artifactOwnership(c.req.param('id'), scope);
      return artifact && ownedPaths ? c.json({ artifact, ownedPaths }) : c.json({ ok: false, code: 'not_found' }, 404);
    });
    app.post('/v1/workers/artifacts/:id/discard', smallBody, async c => {
      const scope = await scopes.resolve(token(c.req.header('authorization')));
      if (!scope) return c.json({ ok: false, code: 'invalid_scope' }, 403);
      const ok = await workers.discardArtifact(c.req.param('id'), scope);
      return ok ? c.json({ ok }) : c.json({ ok: false, code: 'not_found' }, 404);
    });
    app.post('/v1/workers/run', async (c, next) => {
      // Only an already proved project gets the larger complete-snapshot transport.
      // Revalidate the lease below before authorizing execution; none of these
      // transport fields grant filesystem or model-selected project authority.
      const scope = await scopes.resolve(token(c.req.header('authorization')));
      return bodyLimit({ maxSize: scope ? WORKER_SNAPSHOT_TRANSPORT.maxRequestBytes : 256 * 1024,
        onError: c => c.json({ ok: false, code: 'invalid_task' }, 413) })(c, next);
    }, async c => {
      let input: unknown, raw: string;
      try { raw = await c.req.text(); input = JSON.parse(raw); }
      catch { return c.json({ ok: false, code: 'invalid_task' }, 400); }
      const body = object(input), agent = body.mode === 'agent';
      if (!agent && Buffer.byteLength(raw) > 256 * 1024) return c.json({ ok: false, code: 'invalid_task' }, 413);
      const scope = agent ? await scopes.resolve(token(c.req.header('authorization'))) : undefined;
      if (agent && !scope) return c.json({ ok: false, code: 'invalid_scope' }, 403);
      let snapshot: WorkerInitialFile[] | undefined;
      if (agent && body.initialSnapshot !== undefined) {
        snapshot = parseWorkerSnapshot(body.initialSnapshot);
        if (!snapshot) return c.json({ ok: false, code: 'invalid_snapshot' }, 400);
      }
      // Private transport fields never become part of the model's task input.
      const task = agent ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'initialSnapshot')) : input;
      const result = await workers.run(task, c.req.raw.signal, scope ? { ...scope, ...(snapshot === undefined ? {} : { initialSnapshot: snapshot }) } : undefined);
      if (result.ok) return c.json(result);
      const status = { invalid_task: 400, busy: 429, cancelled: 409, timeout: 504, quota: 429, unavailable: 503 } as const;
      if (result.retryAfter !== undefined) c.header('Retry-After', String(result.retryAfter));
      return c.json(result, status[result.code]);
    });
  }
  app.get('/v1/diagnostics/events', async c => {
    c.header('Cache-Control', 'no-store'); const store = sources.diagnosticStore();
    if (!store) return c.json({ error: 'Diagnostics are not enabled' }, 503);
    try {
      const after = c.req.query('after'), source = c.req.query('source'), requestId = c.req.query('requestId'), limit = c.req.query('limit');
      return c.json(await store.list({ ...(after === undefined ? {} : { after }), ...(source === undefined ? {} : { source }), ...(requestId === undefined ? {} : { requestId }), ...(limit === undefined ? {} : { limit: Number(limit) }) }));
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
        includeUsage = api === 'chat' && object(body.stream_options).include_usage === true;
      }
      catch (e) { return c.json({ ...(api === 'messages' ? { type: 'error' } : {}), error: { type: 'invalid_request_error', message: e instanceof Error ? e.message : 'Invalid request' } }, 400); }
      if (c.req.header('x-grunt-context') === 'public') request.publicContext = true;
      const local = housekeeping(request);
      if (local !== undefined) { const context = currentDiagnosticContext(); if (context) context.local = true; }
      options.log?.(`${request.cwd}; cwd=${request.cwdSource}; classification=${local === undefined ? 'user' : 'housekeeping'}`);
      const complete = (signal: AbortSignal): Promise<Completion> => local === undefined ? sources.complete(request, signal) : Promise.resolve({ text: local });
      const controller = new AbortController();
      const abort = () => controller.abort();
      c.req.raw.signal.addEventListener('abort', abort, { once: true });
      const failure = (e: unknown) => {
        const err = e instanceof SourceError ? e : new SourceError('upstream', 'grunt source failed');
        const invalid = err instanceof RequestError;
        return { err, body: { ...(api === 'messages' ? { type: 'error' } : {}), error: { type: invalid ? 'invalid_request_error' : api === 'messages' ? 'api_error' : 'server_error', code: err.code, message: err.message } } };
      };
      try {
        // Agent adapters return final text, not incremental tokens. Resolve routing
        // before committing SSE headers so exhausted routes still return HTTP 429.
        if (request.cwdSource === 'scratch') await mkdir(request.cwd, { recursive: true });
        const completion = await complete(controller.signal);
        const source = answeredBy.get(completion);
        if (source) c.header('X-Grunt-Source', source);
        if (sources.preparing.size) c.header('X-Grunt-Preparing', [...sources.preparing].join(','));
        const result = encode(completion, request.model, api, request.responseNamespaces);
        if (request.stream) return streamSSE(c, async stream => {
          stream.onAbort(abort);
          for (const event of events(result, api, { includeUsage })) await stream.writeSSE(event);
        });
        return c.json(result);
      } catch (e) {
        const { err, body } = failure(e);
        if (sources.preparing.size) c.header('X-Grunt-Preparing', [...sources.preparing].join(','));
        if (err.retryAfter !== undefined) c.header('Retry-After', String(Math.max(1, Math.ceil(err.retryAfter))));
        return c.json(body, err instanceof RequestError ? 400 : err.code === 'quota' ? 429 : err.code === 'timeout' ? 504 : 503);
      } finally { c.req.raw.signal.removeEventListener('abort', abort); }
    });
  }
  return app;
}
