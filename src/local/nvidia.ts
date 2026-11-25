import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lengthLimited, truncatedCompletion, SourceError } from './source.js';
import type { ModelRequest, Source, ToolCall } from './source.js';

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
export async function readNvidiaGrant(directory = configDirectory()): Promise<NvidiaGrant> {
  const file = await open(join(directory, 'nvidia.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe NVIDIA grant file');
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
      response = await this.fetcher(`${grant.base_url}/v1/chat/completions`, {
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
      throw new SourceError(response.status === 401 ? 'logged_out' : [402, 429].includes(response.status) ? 'quota' : response.status === 403 ? 'refused' : 'upstream',
        `NVIDIA returned HTTP ${response.status}`, Number.isFinite(seconds) ? Math.max(1, seconds) : undefined);
    }
    try {
      const result = await response.json() as { choices?: { finish_reason?: unknown; message?: { content?: string | null; tool_calls?: ToolCall[]; refusal?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const message = result.choices?.[0]?.message;
      if (message?.refusal) throw new SourceError('refused', 'NVIDIA refused the request');
      if (lengthLimited(result.choices?.[0]?.finish_reason)) return truncatedCompletion(message?.content, result.usage);
      if (!message || (typeof message.content !== 'string' && !message.tool_calls?.length)) throw new SourceError('upstream', 'NVIDIA returned an invalid completion');
      return { text: message.content ?? '', ...(message.tool_calls ? { calls: message.tool_calls } : {}), inputTokens: result.usage?.prompt_tokens ?? 0, outputTokens: result.usage?.completion_tokens ?? 0 };
    } catch (error) {
      caller.throwIfAborted();
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'NVIDIA returned an invalid completion');
    }
  }
  async close() { this.shutdown.abort(); }
}
