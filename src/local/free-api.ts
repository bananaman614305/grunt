import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceError } from './source.js';
import type { ModelRequest, Source, ToolCall } from './source.js';
import { diagnosticFetch } from './diagnostics.js';

// Low-level pinned clients. Production wrappers add provider-specific access
// receipts, quota checks and data-sharing consent before enabling a route.
export const FREE_API_PROVIDERS = {
  zro: { model: 'deepseek-v4.1-flash', prefix: '/v1' },
  amd: { model: 'DeepSeek-V4.1-Flash', prefix: '/radeon/api/v1' },
  tokenharbor: { model: 'deepseek-v4.1-flash:free', prefix: '/v1' },
  runcrate: { model: 'deepseek-ai/DeepSeek-V4.1-Flash', prefix: '/v1' },
  apinex: { model: 'free/deepseek-v4.1-flash', prefix: '/v1' },
  livekit: { model: 'deepseek-ai/deepseek-v4.1-flash', prefix: '/v1' },
  nous: { model: 'qwen/qwen4-max:free', prefix: '/v1' },
  numes: { model: 'z-ai/glm-5.3-flash:free', prefix: '/api/v1' }
} as const;
export type FreeApiProvider = keyof typeof FREE_API_PROVIDERS;
export interface FreeApiGrant { base_url: string; token: string }
// Official API metadata maps deepseek-flash to DeepSeek-V4.1-Flash:
// https://api-docs.deepseek.com/api/list-models/ . Other aliases below are the
// explicit V4.1 IDs used by these providers, not loose family-name matches.
const deepSeekV41Aliases = new Set(['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017',
  'deepseek-v4.1-flash-free', 'deepseek-v4.1-flash:free', 'free/deepseek-v4.1-flash']);
export function isDeepSeekV41Model(value: unknown): boolean {
  return typeof value === 'string' && deepSeekV41Aliases.has(value.toLowerCase().replace(/^deepseek(?:-ai)?\//, ''));
}
const directory = () => configRoot();
function providerName(value: string): FreeApiProvider {
  if (!Object.hasOwn(FREE_API_PROVIDERS, value)) throw new Error('Unsupported free API provider');
  return value as FreeApiProvider;
}
function validateGrant(value: unknown): FreeApiGrant {
  const grant = value as Partial<FreeApiGrant> | null;
  if (!grant || typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !grant.token.trim()) throw new Error('Invalid free API grant');
  let url: URL;
  try { url = new URL(grant.base_url); } catch { throw new Error('Invalid free API grant endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid free API grant endpoint');
  return { base_url: grant.base_url.replace(/\/$/, ''), token: grant.token };
}
export async function readFreeApiGrant(provider: FreeApiProvider, location = directory()): Promise<FreeApiGrant> {
  const name = providerName(provider);
  const file = await open(join(location, `${name}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe free API grant file');
    return validateGrant(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const validCalls = (value: unknown): value is ToolCall[] => Array.isArray(value) && value.every(call => call && typeof call.id === 'string'
  && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function?.arguments === 'string');

export class FreeApi implements Source {
  readonly id: FreeApiProvider;
  readonly supportsFunctionTools = true;
  private shutdown = new AbortController();
  constructor(provider: FreeApiProvider, private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<FreeApiGrant> } = {}) {
    this.id = providerName(provider);
  }
  private get spec() { return FREE_API_PROVIDERS[this.id]; }
  private grant() { return (this.options.loadGrant?.() ?? readFreeApiGrant(this.id, this.options.directory)).then(validateGrant); }
  // Availability here means private access is configured. Only the live probe
  // establishes whether the provider will serve the requested free model.
  async available() { try { await this.grant(); return true; } catch { return false; } }
  async complete(request: ModelRequest, caller: AbortSignal) {
    caller.throwIfAborted();
    if (![this.id, 'grunt', 'milo'].includes(request.model)) throw new SourceError('upstream', 'Free API probe requires an explicit provider');
    if (request.tools.some(tool => tool.type !== 'function')) throw new SourceError('upstream', 'Free API probe requires function tools');
    let grant: FreeApiGrant;
    try { grant = await this.grant(); }
    catch { throw new SourceError('logged_out', `${this.id} access is not configured`); }
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    let response: Response;
    try {
      response = await diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'chat.completions')(`${grant.base_url}${this.spec.prefix}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
        body: JSON.stringify({ model: this.spec.model, messages: request.messages,
          tools: request.tools.length ? request.tools : undefined, stream: false,
          max_tokens: Math.min(4096, Math.max(1, request.maxTokens ?? 4096)) })
      });
    } catch {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Free API probe closed');
      throw new SourceError(signal.aborted ? 'timeout' : 'upstream', `${this.id} endpoint is unavailable`);
    }
    if (!response.ok) {
      const raw = response.headers.get('retry-after');
      const retry = raw === null ? NaN : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
      await response.body?.cancel();
      throw new SourceError(response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
        `${this.id} returned HTTP ${response.status}`, Number.isFinite(retry) ? Math.max(1, retry) : undefined, undefined,
        { httpStatus: response.status, transport: 'http', httpMethod: 'POST', endpointLabel: 'chat.completions' });
    }
    try {
      const body = await response.json() as { choices?: { message?: { content?: unknown; tool_calls?: unknown; refusal?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      signal.throwIfAborted();
      const message = body.choices?.[0]?.message;
      if (message?.refusal) throw new SourceError('refused', `${this.id} refused the request`);
      const calls = message?.tool_calls;
      if (!message || (typeof message.content !== 'string' && !(validCalls(calls) && calls.length)) || (calls !== undefined && !validCalls(calls))) throw new SourceError('upstream', `${this.id} returned an invalid completion`);
      const inputTokens = tokens(body.usage?.prompt_tokens), outputTokens = tokens(body.usage?.completion_tokens);
      return { text: typeof message.content === 'string' ? message.content : '', ...(validCalls(calls) && calls.length ? { calls } : {}),
        ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Free API probe closed');
      if (signal.aborted) throw new SourceError('timeout', `${this.id} endpoint is unavailable`);
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', `${this.id} returned an invalid completion`);
    }
  }
  async close() { this.shutdown.abort(); }
}
