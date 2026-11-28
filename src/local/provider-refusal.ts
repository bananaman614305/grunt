import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DelegatingSource } from './delegating-source.js';
import { SetupRefusal } from './setup-failure.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

// A provider that answers a saved key with HTTP 403, or says the account is
// banned, has refused this account. Signing up again only makes more accounts
// and can get the provider to ban them all, so setup records the refusal here,
// the daemon stops routing to the source, and no new signup starts until the
// person clears it with `usegrunt add <provider> --force`.
// Each provider has its own marker file, written by atomic rename and cleared by
// removal, so concurrent setup runs never rewrite another provider's record.
const DIRECTORY = 'refused-providers';
export interface ProviderRefusal { reason: string; http_status?: number; refused_at: string }
const markerPath = (directory: string, provider: string) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider) || provider.includes('..')) throw new Error('Invalid provider id');
  return join(directory, DIRECTORY, `${provider}.json`);
};

export function isAccountRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof ProviderRefusedError) return true;
  if (error instanceof SourceError && error.diagnostics?.httpStatus === 403) return true;
  return /\bbanned\b/i.test(error.message);
}

export class ProviderRefusedError extends SetupRefusal {
  constructor(readonly provider: string, refusal: ProviderRefusal) {
    super(`account refused by provider; run usegrunt add ${provider} --force to retry`,
      `${provider} refused this account (${refusal.reason}) on ${refusal.refused_at.slice(0, 10)}; setup will not sign up again. Run usegrunt add ${provider} --force to retry`);
  }
}

// Reads at most a few kilobytes of a rejected response and reports whether the
// provider says the account is banned. The body is never copied into output.
export async function bannedResponse(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 8192) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength; chunks.push(part.value);
    }
  } catch { return false; } finally { void reader.cancel().catch(() => {}); }
  return /\bbanned\b/i.test(Buffer.concat(chunks).toString('utf8'));
}

export async function readProviderRefusal(directory: string, provider: string): Promise<ProviderRefusal | undefined> {
  const path = markerPath(directory, provider);
  try {
    const refusal = JSON.parse(await readFile(path, 'utf8')) as Partial<ProviderRefusal> | null;
    if (refusal && typeof refusal.reason === 'string' && typeof refusal.refused_at === 'string') return refusal as ProviderRefusal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // An unreadable or damaged marker still blocks signup until the person clears it.
    return { reason: 'unreadable refusal record', refused_at: new Date(0).toISOString() };
  }
  return { reason: 'unreadable refusal record', refused_at: new Date(0).toISOString() };
}
// Records the refusal and returns the error that stops setup for this provider.
export async function recordProviderRefusal(directory: string, provider: string, error: unknown): Promise<ProviderRefusedError> {
  if (error instanceof ProviderRefusedError && error.provider === provider) return error;
  const status = error instanceof SourceError ? error.diagnostics?.httpStatus : undefined;
  const refusal: ProviderRefusal = {
    reason: status === 403 ? 'HTTP 403' : 'account banned',
    ...(status !== undefined ? { http_status: status } : {}),
    refused_at: new Date().toISOString()
  };
  const path = markerPath(directory, provider);
  await mkdir(join(directory, DIRECTORY), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(refusal), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return new ProviderRefusedError(provider, refusal);
}
export async function clearProviderRefusal(directory: string, provider: string): Promise<boolean> {
  try { await rm(markerPath(directory, provider)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
// Throws when the person has not cleared a recorded refusal for this provider.
export async function assertProviderNotRefused(directory: string, provider: string) {
  const refusal = await readProviderRefusal(directory, provider);
  if (refusal) throw new ProviderRefusedError(provider, refusal);
}

// Switches a refused source off in the daemon until the refusal is cleared.
export class RefusalSource extends DelegatingSource {
  constructor(source: Source, private directory: string) { super(source); }
  private async refused() { return Boolean(await readProviderRefusal(this.directory, this.id)); }
  async available(signal?: AbortSignal) { return !await this.refused() && await super.available(signal); }
  async healthCheck(signal?: AbortSignal) {
    if (await this.refused()) return false;
    signal?.throwIfAborted();
    return await (this.source.healthCheck?.(signal) ?? super.available(signal));
  }
  async complete(request: ModelRequest, signal: AbortSignal, output?: () => void, beforeNativeWork?: () => void) {
    signal.throwIfAborted();
    if (await this.refused()) throw new SourceError('refused', `${this.id} refused this account; run usegrunt add ${this.id} --force to retry`);
    return super.complete(request, signal, output, beforeNativeWork);
  }
}
