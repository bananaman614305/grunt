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
  available(): Promise<boolean>;
  healthCheck?(): Promise<boolean>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<Completion>;
  close?(): Promise<void>;
}
export class Sources {
  private router: StickyRouter | undefined;
  // Adapters whose background setup has not finished yet.
  readonly preparing = new Set<string>();
  constructor(public readonly sources: Source[], routing?: RoutingOptions) {
    if (!sources.length || new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Configure distinct grunt sources');
    if (routing) this.router = new StickyRouter(sources, routing);
  }
  healthy(id: string) { this.router?.healthy(id); }
  async models() {
    const available = await Promise.all(this.sources.map(async s => {
      if (this.router && !this.router.listed(s.id) || !await s.available()) return null;
      if (this.router?.needsHealthCheck(s.id) && await s.healthCheck?.().catch(() => false)) this.healthy(s.id);
      return s.id;
    }));
    return [...(this.router ? ['grunt'] : []), 'milo', ...available.filter((id): id is string => id !== null)];
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    if (this.router) return this.router.complete(request, signal);
    const known = this.sources.some(s => s.id === request.model);
    if (request.model !== 'milo' && !known) console.error(`grunt model mapping: ${request.model} -> milo`);
    const candidates = request.model === 'milo' || !known ? this.sources : this.sources.filter(s => s.id === request.model);
    let last = new SourceError('not_installed', `No source for model ${request.model}`);
    for (const source of candidates) {
      signal.throwIfAborted();
      let completion: Completion;
      try { completion = await source.complete(request, signal); }
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
