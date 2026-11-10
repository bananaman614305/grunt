import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { userTurns } from './harness.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const DOTS_INSTRUCTION = 'Answer here in this conversation. Do not start Codex or Work tasks.';
type SlackMessage = { ts?: string; thread_ts?: string; user?: string; text?: string; subtype?: string; edited?: { ts?: string } };
type SlackResult = { ok?: boolean; error?: string; user_id?: string; ts?: string; messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } };
const timestamp = (value?: string): value is string => typeof value === 'string' && /^\d+\.\d+$/.test(value);

export class Dots implements Source {
  readonly id = 'dots';
  private sessions = new Map<string, string>();
  private busy = new Set<string>();
  private shutdown = new AbortController();
  constructor(private options: { token?: string; channel?: string; mention?: string; timeout?: number; poll?: number; settle?: number; fetcher?: typeof fetch } = {}) {}
  private get configured() { return !!(this.options.token && this.options.channel); }
  private async call(method: string, body: Record<string, string>, signal: AbortSignal): Promise<SlackResult> {
    const write = method === 'chat.postMessage';
    const parameters = new URLSearchParams(body).toString();
    const response = await (this.options.fetcher ?? fetch)(`https://slack.com/api/${method}${!write && parameters ? `?${parameters}` : ''}`, {
      method: write ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      ...(write ? { body: parameters } : {})
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After') ?? 1);
      await delay(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000, undefined, { signal });
      throw new SourceError('upstream', 'Slack rate limited the dots request');
    }
    if (!response.ok) throw new SourceError(response.status === 401 ? 'logged_out' : 'upstream', `Slack returned HTTP ${response.status}`);
    const result = await response.json() as SlackResult;
    if (!result?.ok) throw new SourceError(['invalid_auth', 'token_revoked', 'not_authed', 'account_inactive'].includes(result?.error ?? '') ? 'logged_out' : 'upstream', 'Slack rejected the dots request');
    return result;
  }
  async available() {
    if (!this.configured) return false;
    try { return !!(await this.call('auth.test', {}, AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000)]))).user_id; }
    catch { return false; }
  }
  async complete(request: ModelRequest, caller: AbortSignal) {
    if (!this.configured) throw new SourceError('not_installed', 'Dots Slack is not configured');
    const turns = userTurns(request), prompt = turns.at(-1);
    if (!prompt) throw new SourceError('upstream', 'No user text in this request');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 300000)]);
    let thread: string | undefined;
    try {
      const cwd = await realpath(request.cwd);
      const key = (history: string[]) => createHash('sha256').update(JSON.stringify([cwd, history])).digest('hex');
      const prior = turns.length > 1 ? this.sessions.get(key(turns.slice(0, -1))) : undefined;
      thread = prior && !this.busy.has(prior) ? prior : undefined;
      if (thread) this.busy.add(thread);
      const identity = await this.call('auth.test', {}, signal);
      if (!identity.user_id) throw new SourceError('logged_out', 'Slack did not identify the dots user');
      const posted = await this.call('chat.postMessage', {
        channel: this.options.channel!, text: `${this.options.mention ? `${this.options.mention}\n` : ''}${prompt}\n\n${DOTS_INSTRUCTION}`,
        ...(thread ? { thread_ts: thread } : {}), unfurl_links: 'false', unfurl_media: 'false'
      }, signal);
      if (!timestamp(posted.ts)) throw new SourceError('upstream', 'Slack returned an invalid message timestamp');
      thread ??= posted.ts;
      this.busy.add(thread);
      let last = '', stableSince = Date.now();
      while (true) {
        const messages: SlackMessage[] = [];
        let cursor = '';
        do {
          const page = await this.call('conversations.replies', { channel: this.options.channel!, ts: thread, limit: '100', ...(cursor ? { cursor } : {}) }, signal);
          messages.push(...(page.messages ?? []));
          cursor = page.response_metadata?.next_cursor ?? '';
        } while (cursor);
        const latest = messages.filter(m => timestamp(m.ts) && Number(m.ts) > Number(posted.ts) && m.thread_ts === thread && m.user !== identity.user_id && m.subtype !== 'message_deleted' && typeof m.text === 'string' && m.text.trim())
          .sort((a, b) => Number(a.ts) - Number(b.ts)).at(-1);
        const signature = latest ? JSON.stringify([latest.ts, latest.text, latest.edited?.ts]) : '';
        if (signature !== last) { last = signature; stableSince = Date.now(); }
        if (latest && Date.now() - stableSince >= (this.options.settle ?? 4000)) {
          const text = latest.text!;
          if (/(?:usage|message|rate|weekly|daily)\s+limit|quota\s+(?:exceeded|exhausted)|(?:reached|hit|exceeded).{0,40}limit|out of (?:messages|credits)/i.test(text)) throw new SourceError('quota', 'Dots reached a usage limit');
          // Bound retained conversations; no Slack text or token is stored in the keys.
          if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!);
          this.sessions.set(key(turns), thread);
          return { text };
        }
        await delay(this.options.poll ?? 1000, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw new SourceError('timeout', 'Dots request timed out or was cancelled');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Dots Slack request failed');
    } finally { if (thread) this.busy.delete(thread); }
  }
  async close() { this.shutdown.abort(); this.sessions.clear(); }
}
