import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch, observeAttemptDispatch } from './diagnostics.js';
import type { FreeApiGrant } from './free-api.js';
import { readPromotionalStream } from './promotional-api.js';
import { validateProviderGrant } from './provider-grant.js';
import { calendarQuotaDelay } from './quota-policy.js';
import { quotaObject, quotaRetryAfter, readQuotaError } from './quota-timing.js';
import { emitStreamText, lengthLimited, truncatedCompletion, withObservedEnding, SourceError } from './source.js';
import type { ModelRequest, Source, ToolCall } from './source.js';

export const KENARI_FREE_MODEL = 'ernie-5-5-flash-preview:free';
interface CatalogEntry {
  id?: string;
  context_length?: number;
  pricing?: { free?: boolean };
  tool_call?: boolean;
}

async function readGrant(directory: string) {
  const file = await open(join(directory, 'kenari.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe Kenari grant file');
    return validateProviderGrant(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}

export class Kenari implements Source {
  readonly inferenceOnly = true;
  readonly reportsOutput = true;
  readonly reportsProgress = true;
  readonly id = 'kenari';
  readonly supportsFunctionTools = true;
  private directory: string;
  private fetcher: typeof fetch;
  private shutdown = new AbortController();

  constructor(private options: { directory?: string; fetcher?: typeof fetch; loadGrant?: () => Promise<FreeApiGrant> } = {}) {
    this.directory = options.directory ?? configRoot();
    this.fetcher = options.fetcher ?? fetch;
  }

  private approved() { return readDataSharingConsent(this.directory, [this.id]).then(ids => ids.includes(this.id)); }
  private grant() { return (this.options.loadGrant?.() ?? readGrant(this.directory)).then(validateProviderGrant); }

  private async hasFreeRoute(grant: FreeApiGrant, signal: AbortSignal = this.shutdown.signal) {
    const response = await diagnosticFetch(this.fetcher, this.id, 'models')(`${grant.base_url}/v1/models`, {
      headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(5000), signal])
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const { data } = await response.json() as { data?: CatalogEntry[] };
    return Array.isArray(data) && data.some(entry => entry?.id === KENARI_FREE_MODEL && entry.pricing?.free === true
      && Number(entry.context_length) >= 200_000 && entry.tool_call === true);
  }

  async available() {
    if (!await this.approved()) return false;
    try {
      const grant = await this.grant();
      // The model catalogue is public. Use an authenticated, read-only
      // endpoint as well so a revoked upstream key cannot look installed.
      const response = await diagnosticFetch(this.fetcher, this.id, 'account')(`${grant.base_url}/v1/usage`, {
        headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(5000), this.shutdown.signal])
      });
      await response.body?.cancel();
      return response.ok && await this.hasFreeRoute(grant);
    } catch { return false; }
  }

  async complete(request: ModelRequest, caller: AbortSignal, output?: () => void) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(120000)]);
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', 'Kenari data sharing needs approval before routing');
    let grant: FreeApiGrant;
    try { grant = await this.grant(); }
    catch { throw new SourceError('logged_out', 'Kenari access is not configured'); }
    const free = await this.hasFreeRoute(grant, signal).catch(() => false);
    signal.throwIfAborted();
    if (!free) throw new SourceError('refused', 'Kenari is missing the advertised free ERNIE route');

    if (request.tools.some(tool => tool.type !== 'function')) throw new SourceError('upstream', 'Kenari requires function tools');
    observeAttemptDispatch({ model: KENARI_FREE_MODEL, account: 'vaulted', maxOutputTokens: request.maxTokens });
    const send = diagnosticFetch(this.fetcher, this.id, 'chat.completions');
    try {
      const response = await send(`${grant.base_url}/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: KENARI_FREE_MODEL, messages: request.messages, tools: request.tools.length ? request.tools : undefined,
          stream: true, stream_options: { include_usage: true }, max_tokens: request.maxTokens })
      });
      if (!response.ok) {
        if (response.status === 429) {
          let retryAfter = quotaRetryAfter(response.headers.get('Retry-After'));
          if (retryAfter === undefined) {
            const error = quotaObject((await readQuotaError(response)).error);
            if (error.code === 'free_quota_daily') retryAfter = calendarQuotaDelay(this.id);
          } else await response.body?.cancel();
          throw new SourceError('quota', 'Kenari free quota is temporarily unavailable', retryAfter);
        }
        await response.body?.cancel();
        throw new SourceError([401, 403].includes(response.status) ? 'logged_out' : 'upstream', `Kenari returned HTTP ${response.status}`);
      }
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        return await readPromotionalStream(response, KENARI_FREE_MODEL, signal, {
          ...(output ? { progress: output } : {}),
          ...(request.stream ? { text: emitStreamText } : {}),
          strictToolArgs: false,
          allowAnyFinishReason: true,
          failure: () => {},
          cleanup: () => {}
        });
      }
      const body = await response.json() as { model?: string; choices?: { finish_reason?: unknown; message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } };
      signal.throwIfAborted();
      if (body.model !== KENARI_FREE_MODEL) throw new SourceError('upstream', 'Kenari returned HTTP 502 for an unverified model');
      const choice = body.choices?.[0], message = choice?.message;
      if (lengthLimited(choice?.finish_reason)) return truncatedCompletion(message?.content, body.usage, choice?.finish_reason);
      if (!message || (typeof message.content !== 'string' && !message.tool_calls?.length)) throw new Error('Invalid completion');
      return withObservedEnding({ text: message.content ?? '', ...(message.tool_calls ? { calls: message.tool_calls } : {}),
        ...(body.usage?.prompt_tokens === undefined ? {} : { inputTokens: body.usage.prompt_tokens }),
        ...(body.usage?.completion_tokens === undefined ? {} : { outputTokens: body.usage.completion_tokens }) },
      choice?.finish_reason, body.usage, !!message.tool_calls?.length);
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Kenari source closed');
      if (signal.aborted) throw new SourceError('timeout', 'Kenari response timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Kenari returned an invalid completion');
    }
  }

  async close() { this.shutdown.abort(); }
}
