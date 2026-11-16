export type ErrorCode = 'not_installed' | 'logged_out' | 'quota' | 'timeout' | 'upstream' | 'refused' | 'cancelled';
export class SourceError extends Error {
  constructor(public code: ErrorCode, message: string, public retryAfter?: number, public output?: string) { super(message); }
}
export interface Message { role: string; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type Tool = { type: 'function'; function: { name: string; description?: string; parameters: unknown } } | { type: string; [key: string]: unknown };
export interface ModelRequest { model: string; messages: Message[]; userMessages?: string[]; tools: Tool[]; cwd: string; stream: boolean; maxTokens?: number; imageInput?: boolean; handoffPrompt?: string }
export interface Completion { text: string; calls?: ToolCall[]; inputTokens?: number; outputTokens?: number }
// Names the adapter that produced each completion; setup checks it against the requested adapter.
export const answeredBy = new WeakMap<Completion, string>();
export interface Source {
  id: string;
  supportsFunctionTools?: boolean;
  available(): Promise<boolean>;
  healthCheck?(): Promise<boolean>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<Completion>;
  close?(): Promise<void>;
}
// A request that carries Pi's function tools expects tool calls back, so Pi
// keeps the agent loop. Automatic selection skips sources that run their own
// tools instead (OpenCode). A source the caller names explicitly stays eligible.
export const needsFunctionTools = (request: ModelRequest) => request.tools.some(tool => tool.type === 'function');
export const toolCapable = (source: Source) => source.supportsFunctionTools === true;
export const NO_TOOL_SOURCE = 'No tool-capable adapter is available for a request with function tools; finish setup or retry after quota resets';
export class Sources {
  private router: StickyRouter | undefined;
  private observation: SourceStatus;
  // Adapters whose background setup has not finished yet.
  readonly preparing = new Set<string>();
  // Foreground signups must not probe or dispatch incomplete sources. Routine
  // background checks remain metadata and do not interrupt already-bound work.
  readonly pending = new Set<string>();
  // An exact-ID setup probe may run without admitting that source to the pool.
  readonly verifying = new Set<string>();
  // Foreground approval metadata contains adapter IDs only, never handoff URLs.
  readonly approvals = new Set<string>();
  constructor(public readonly sources: Source[], private routing?: RoutingOptions, private disabledModels: ReadonlySet<string> = new Set()) {
    if ((!sources.length && !disabledModels.size) || new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Configure distinct grunt sources');
    this.observation = new SourceStatus(sources.map(source => source.id), routing?.now);
    if (routing) this.router = new StickyRouter(sources, { ...routing, pending: this.pending, observation: this.observation });
  }
  healthy(id: string) { this.router?.healthy(id); this.observation.healthy(id); }
  status(): PoolSnapshot {
    return this.observation.snapshot({ ids: this.sources.map(source => source.id), disabled: this.disabledModels,
      pending: this.pending, verifying: this.verifying, approvals: this.approvals, preparing: this.preparing,
      ...(this.router ? { listed: (id: string) => this.router!.listed(id), cooldown: (id: string) => this.router!.cooldown(id) } : {}),
      model: id => {
        const adapter = this.routing?.registry().adapters.find(adapter => adapter.id === id);
        // A rotation is a configured set, not an assertion about which model
        // generated the latest answer. Never inspect private adapter configs.
        const model = adapter?.models && adapter.models.length > 1 ? 'Free model rotation' : adapter?.models?.[0] ?? adapter?.model;
        return model && /^[a-zA-Z0-9][a-zA-Z0-9._:/+ -]{0,159}$/.test(model) ? model : undefined;
      }
    });
  }
  async models() {
    const available = await Promise.all(this.sources.map(async s => {
      if (this.pending.has(s.id) || this.router && !this.router.listed(s.id) || !await this.observation.available(s)) return null;
      if (this.router?.needsHealthCheck(s.id) && s.healthCheck && await this.observation.available(s, true).catch(() => false)) this.healthy(s.id);
      return s.id;
    }));
    return [...(this.router ? ['grunt'] : []), 'milo', ...available.filter((id): id is string => id !== null)];
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    signal.throwIfAborted();
    if (this.disabledModels.has(request.model)) throw new SourceError('refused', `${request.model} routing is disabled`);
    if (this.pending.has(request.model)) {
      if (!this.verifying.has(request.model)) throw new SourceError('not_installed', `${request.model} setup is still in progress`);
      const source = this.sources.find(source => source.id === request.model);
      if (!source) throw new SourceError('not_installed', `No source for model ${request.model}`);
      if (this.router && !this.router.listed(source.id)) throw new SourceError('not_installed', `${request.model} is not in the current provider registry`);
      if (this.router && !this.router.supportsInput(source.id, request.imageInput)) throw new SourceError('refused', `${request.model} does not support this input modality`);
      // A setup probe is one exact-source call, never sticky failover or a
      // retry of a provider refusal. The source retains every normal guard.
      const completion = await this.observation.complete(source, request, signal);
      signal.throwIfAborted();
      this.router?.verified(source.id);
      answeredBy.set(completion, source.id);
      return completion;
    }
    if (this.router) return this.router.complete(request, signal);
    const known = this.sources.some(s => s.id === request.model);
    if (request.model !== 'milo' && !known) console.error(`grunt model mapping: ${request.model} -> milo`);
    const toolsRequired = (request.model === 'milo' || !known) && needsFunctionTools(request);
    const candidates = request.model === 'milo' || !known ? this.sources.filter(s => !toolsRequired || toolCapable(s)) : this.sources.filter(s => s.id === request.model);
    let last = toolsRequired ? new SourceError('not_installed', NO_TOOL_SOURCE) : new SourceError('not_installed', `No source for model ${request.model}`);
    for (const source of candidates) {
      signal.throwIfAborted();
      if (this.pending.has(source.id)) continue;
      let completion: Completion;
      try { completion = await this.observation.complete(source, request, signal); }
      catch (error) {
        if (signal.aborted || (error instanceof SourceError && error.code === 'cancelled')) {
          console.error(`grunt source: ${source.id} cancelled for model ${request.model}`);
          signal.throwIfAborted();
          throw error;
        }
        last = error instanceof SourceError ? error : new SourceError('upstream', `Source ${source.id} failed`);
        console.error(`grunt source: ${source.id} failed (${last.code}) for model ${request.model}`);
        // Only dots and OpenCode deadlines fall through; caller cancellation stops above.
        if (last.code === 'timeout' && source.id !== 'dots' && source.id !== 'opencode') throw last;
        continue;
      }
      console.error(`grunt source: ${source.id} answered model ${request.model}`);
      answeredBy.set(completion, source.id);
      return completion;
    }
    throw last;
  }
  async close() { await Promise.allSettled(this.sources.map(s => s.close?.())); }
}
export class Gateway implements Source {
  id = 'gateway';
  readonly supportsFunctionTools = true;
  private url: string;
  constructor(url: string, private key: string, private fetcher: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid MILO_GATEWAY_URL');
    this.url = `${url.replace(/\/$/, '')}/chat/completions`;
  }
  async available() { return true; }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    if (request.tools.some(t => t.type !== 'function')) throw new SourceError('upstream', 'Gateway Chat Completions cannot forward native Responses tools; use the local app source');
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: 'milo', messages: request.messages, tools: request.tools.length ? request.tools : undefined, stream: false, max_tokens: request.maxTokens ?? 4096 })
      });
    } catch { signal.throwIfAborted(); throw new SourceError('upstream', 'grunt gateway is unavailable'); }
    if (!response.ok) throw new SourceError(response.status === 401 || response.status === 403 ? 'logged_out' : response.status === 429 ? 'quota' : 'upstream', `grunt gateway returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = body.choices?.[0]?.message;
    if (!message || (typeof message.content !== 'string' && !message.tool_calls?.length)) throw new SourceError('upstream', 'grunt gateway returned an invalid completion');
    return { text: message.content ?? '', ...(message.tool_calls ? { calls: message.tool_calls } : {}), inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
  }
}
import { StickyRouter } from './routing.js';
import type { RoutingOptions } from './routing.js';
import { SourceStatus } from './source-status.js';
import type { PoolSnapshot } from './source-status.js';
