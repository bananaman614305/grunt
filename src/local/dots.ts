import { userTurns } from './harness.js';
import { readDotsLink } from './dots-link.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const DOTS_INSTRUCTION = 'Answer here in this conversation. Do not start Codex or Work tasks.';
export class Dots implements Source {
  readonly id = 'dots';
  private shutdown = new AbortController();
  constructor(private options: { env?: NodeJS.ProcessEnv; timeout?: number; fetcher?: typeof fetch } = {}) {}
  private get enabled() { return (this.options.env ?? process.env).MILO_SOURCES?.split(',').some(id => id.trim() === 'dots') ?? false; }
  private async call(link: { gateway: string; deviceSecret: string }, path: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    const response = await (this.options.fetcher ?? fetch)(link.gateway + path, { method, redirect: 'error', signal, headers: { Authorization: `Bearer ${link.deviceSecret}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 204) return {};
    if (response.status === 202) return { pending: true };
    const result = await response.json() as { id?: string; text?: string; error?: string; linked?: boolean; subscribed?: boolean; pending?: boolean };
    if (!response.ok || result.error) {
      const code = response.status === 401 ? 'logged_out' : result.error === 'quota' ? 'quota' : response.status === 410 ? 'timeout' : response.status === 409 ? 'not_installed' : 'upstream';
      throw new SourceError(code, `Dots relay request failed (${code})`);
    }
    return result;
  }
  async available() {
    if (!this.enabled) return false;
    const link = await readDotsLink(this.options.env);
    if (!link) return false;
    try { const status = await this.call(link, '/dots/status', AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000)])); return !!(status.linked && status.subscribed); }
    catch { return false; }
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    if (!this.enabled) throw new SourceError('not_installed', 'Add dots to MILO_SOURCES to enable it');
    const link = await readDotsLink(this.options.env);
    if (!link) throw new SourceError('not_installed', 'Run usegrunt dots link to configure your dot');
    const prompt = userTurns(request).at(-1);
    if (!prompt) throw new SourceError('upstream', 'No user text in this request');
    const timeout = this.options.timeout ?? 300000;
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(timeout)]);
    let id: string | undefined;
    try {
      const messages = request.messages.filter(m => ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, content: m.content }));
      // The harness may supply canonical user turns separately from wire messages.
      const latest = messages.findLastIndex(m => m.role === 'user');
      if (latest < 0) messages.push({ role: 'user', content: prompt + '\n\n' + DOTS_INSTRUCTION });
      else messages[latest] = { role: 'user', content: prompt + '\n\n' + DOTS_INSTRUCTION };
      const queued = await this.call(link, '/dots/requests', signal, 'POST', { messages, timeout });
      id = queued.id;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new SourceError('upstream', 'Dots relay returned an invalid request');
      while (true) {
        signal.throwIfAborted();
        const reply = await this.call(link, `/dots/requests/${id}`, signal);
        if (reply.pending) continue;
        if (typeof reply.text !== 'string') throw new SourceError('upstream', 'Dots relay returned no answer');
        return { text: reply.text };
      }
    } catch (error) {
      if (signal.aborted) throw new SourceError('timeout', 'Dots request timed out or was cancelled');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Dots relay is unavailable');
    } finally {
      if (id) await this.call(link, `/dots/requests/${id}`, AbortSignal.timeout(2000), 'DELETE').catch(() => {});
    }
  }
  async close() { this.shutdown.abort(); }
}
