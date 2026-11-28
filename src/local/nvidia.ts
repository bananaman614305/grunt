import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { configRoot } from '../brand.js';
import { diagnosticFetch, observeAttemptDispatch } from './diagnostics.js';
import { constants } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyHttpFailure } from './provider-error.js';
import { lengthLimited, truncatedCompletion, withObservedEnding, SourceError } from './source.js';
import type { ModelRequest, Source, ToolCall } from './source.js';
import { readVaultGrant } from './vault.js';

export const NVIDIA_DEEPSEEK = 'deepseek-ai/deepseek-v4.1-flash';
export interface NvidiaGrant { base_url: string; token: string }
const configDirectory = () => configRoot();
function validateGrant(value: unknown): NvidiaGrant {
  const grant = value as Partial<NvidiaGrant> | null;
  if (!grant || typeof grant.base_url !== 'string' || typeof grant.token !== 'string' || !grant.token.trim()) throw new Error('Invalid NVIDIA Squire grant');
  const url = new URL(grant.base_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid NVIDIA Squire endpoint');
  return { base_url: grant.base_url.replace(/\/$/, ''), token: grant.token };
}
export async function readNvidiaGrant(directory = configDirectory(), env: NodeJS.ProcessEnv = process.env): Promise<NvidiaGrant> {
  const vaulted = await readVaultGrant('nvidia', directory, env);
  if (vaulted) return validateGrant({ base_url: vaulted.base_url, token: vaulted.token });
  const file = await openPrivateFile(join(directory, 'nvidia.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600)) throw new Error('Unsafe NVIDIA grant file');
    return validateGrant(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
// Store only the revocable, host-scoped Squire grant, never the NVIDIA API key.
export async function writeNvidiaGrant(grant: NvidiaGrant, directory = configDirectory()) {
  const value = validateGrant(grant), temporary = join(directory, `nvidia.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, 'nvidia.json'));
  } finally { await rm(temporary, { force: true }); }
}
export class Nvidia implements Source {
  readonly inferenceOnly = true;
  readonly id = 'nvidia';
  readonly supportsFunctionTools = true;
  private shutdown = new AbortController();
  constructor(private options: { directory?: string; fetcher?: typeof fetch; timeout?: number; loadGrant?: () => Promise<NvidiaGrant> } = {}) {}
  private get fetcher() { return this.options.fetcher ?? fetch; }
  private async grant() { return validateGrant(await (this.options.loadGrant?.() ?? readNvidiaGrant(this.options.directory))); }
  async available() {
    try {
      const grant = await this.grant();
      const response = await this.fetcher(`${grant.base_url}/v1/models`, { headers: { Authorization: `Bearer ${grant.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      return response.ok;
    } catch { return false; }
  }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, caller: AbortSignal) {
    caller.throwIfAborted();
    let grant: NvidiaGrant;
    try { grant = await this.grant(); }
    catch { throw new SourceError('logged_out', 'NVIDIA access is unavailable; rerun usegrunt setup'); }
    if (request.tools.some(tool => tool.type !== 'function')) throw new SourceError('upstream', 'NVIDIA Chat Completions requires function tools');
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 120000)]);
    let response: Response;
    try {
      // This grant is bound to integrate.api.nvidia.com. There is no local
      // aggregator or secondary provider that could answer or spend paid quota.
      observeAttemptDispatch({ model: NVIDIA_DEEPSEEK, account: 'vaulted', maxOutputTokens: request.maxTokens });
      response = await diagnosticFetch(this.fetcher, this.id, 'chat.completions')(`${grant.base_url}/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` },
        body: JSON.stringify({ model: NVIDIA_DEEPSEEK, messages: request.messages, tools: request.tools.length ? request.tools : undefined,
          stream: false, max_tokens: request.maxTokens })
      });
    } catch {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'NVIDIA request cancelled during shutdown');
      throw new SourceError(signal.aborted ? 'timeout' : 'upstream', 'NVIDIA endpoint is unavailable');
    }
    if (!response.ok) {
      const header = response.headers.get('retry-after');
      const seconds = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
      await response.body?.cancel();
      throw classifyHttpFailure({
        source: 'NVIDIA',
        status: response.status,
        ...(Number.isFinite(seconds) ? { retryAfter: Math.max(1, seconds) } : {})
      });
    }
    try {
      const result = await response.json() as { choices?: { finish_reason?: unknown; message?: { content?: string | null; tool_calls?: ToolCall[]; refusal?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const message = result.choices?.[0]?.message;
      if (message?.refusal) throw new SourceError('refused', 'NVIDIA refused the request');
      if (lengthLimited(result.choices?.[0]?.finish_reason)) return truncatedCompletion(message?.content, result.usage, result.choices?.[0]?.finish_reason);
      if (!message || (typeof message.content !== 'string' && !message.tool_calls?.length)) throw new SourceError('upstream', 'NVIDIA returned an invalid completion');
      return withObservedEnding({ text: message.content ?? '', ...(message.tool_calls ? { calls: message.tool_calls } : {}), inputTokens: result.usage?.prompt_tokens ?? 0, outputTokens: result.usage?.completion_tokens ?? 0 },
        result.choices?.[0]?.finish_reason, result.usage, !!message.tool_calls?.length);
    } catch (error) {
      caller.throwIfAborted();
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'NVIDIA returned an invalid completion');
    }
  }
  async close() { this.shutdown.abort(); }
}
