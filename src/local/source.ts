export type ErrorCode = 'not_installed' | 'logged_out' | 'quota' | 'timeout' | 'upstream';
export class SourceError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); }
}
export interface Message { role: string; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type Tool = { type: 'function'; function: { name: string; description?: string; parameters: unknown } } | { type: string; [key: string]: unknown };
export interface ModelRequest { model: string; messages: Message[]; tools: Tool[]; cwd: string; stream: boolean; maxTokens?: number }
export interface Completion { text: string; calls?: ToolCall[]; inputTokens?: number; outputTokens?: number }
export interface Source {
  id: string;
  available(): Promise<boolean>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<Completion>;
  close?(): Promise<void>;
}
export class Sources {
  constructor(public readonly sources: Source[]) {
    if (!sources.length || new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Configure distinct Milo sources');
  }
  async models() {
    const available = await Promise.all(this.sources.map(async s => await s.available() ? s.id : null));
    return ['milo', ...available.filter((id): id is string => id !== null)];
  }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    const candidates = request.model === 'milo' ? this.sources : this.sources.filter(s => s.id === request.model);
    let last = new SourceError('not_installed', `No source for model ${request.model}`);
    for (const source of candidates) {
      signal.throwIfAborted();
      try { return await source.complete(request, signal); }
      catch (error) {
        signal.throwIfAborted();
        last = error instanceof SourceError ? error : new SourceError('upstream', `Source ${source.id} failed`);
        if (last.code === 'timeout') throw last;
      }
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
        body: JSON.stringify({ model: 'milo', messages: request.messages, tools: request.tools.length ? request.tools : undefined, stream: false, max_tokens: request.maxTokens })
      });
    } catch { signal.throwIfAborted(); throw new SourceError('upstream', 'Milo gateway is unavailable'); }
    if (!response.ok) throw new SourceError(response.status === 401 || response.status === 403 ? 'logged_out' : response.status === 429 ? 'quota' : 'upstream', `Milo gateway returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = body.choices?.[0]?.message;
    if (!message || (typeof message.content !== 'string' && !message.tool_calls?.length)) throw new SourceError('upstream', 'Milo gateway returned an invalid completion');
    return { text: message.content ?? '', ...(message.tool_calls ? { calls: message.tool_calls } : {}), inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
  }
}
