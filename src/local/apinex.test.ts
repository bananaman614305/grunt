import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Apinex, APINEX_DEEPSEEK, readApinexGrant, writeApinexGrant } from './apinex.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { Sources } from './source.js';
import { createLocalApp } from './api.js';

const paths: string[] = [];
const grant = { base_url: 'https://grant.test/apinex', token: 'synthetic-private-grant' };
const request = { model: 'grunt', messages: [{ role: 'user', content: 'hello' }], tools: [], cwd: process.cwd(), stream: false };
const active = { mode: 'free', plan: null, allowed: true, tokens_remaining: 25000000, resets_at_utc: '2026-11-16T00:00:00Z' };
async function directory(approved = true) {
  const path = await mkdtemp(join(tmpdir(), 'grunt-apinex-')); paths.push(path);
  if (approved) await recordDataSharingConsent(path, ['apinex']);
  return path;
}
const reply = (model: unknown = APINEX_DEEPSEEK) => Response.json({ model, choices: [{ message: { content: 'Hello from APInex' } }], usage: { prompt_tokens: 19, completion_tokens: 4 } });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('writes a private current-UTC check-in receipt and probes documented free quota without inference', async () => {
  const path = await directory(); await writeApinexGrant(grant, path);
  const stored = await readApinexGrant(path);
  expect(stored).toMatchObject({ ...grant, free_account_verified: true }); expect(stored.daily_checkin_at.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  expect((await stat(join(path, 'apinex.json'))).mode & 0o777).toBe(0o600);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(active));
  expect(await new Apinex({ directory: path, fetcher }).available()).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]![0]).toBe(`${grant.base_url}/v1/subscription`);
});

it('rechecks live free quota and sends only the exact free model through Grunt', async () => {
  const path = await directory(); await writeApinexGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/subscription') ? Response.json(active) : reply());
  const sources = new Sources([new Apinex({ directory: path, fetcher })]);
  const response = await createLocalApp(sources).request('http://127.0.0.1:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, max_tokens: 80000 })
  });
  expect(response.status).toBe(200); expect(response.headers.get('x-grunt-source')).toBe('apinex');
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [url, init] = fetcher.mock.calls[1]!;
  expect(url).toBe(`${grant.base_url}/v1/chat/completions`);
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: APINEX_DEEPSEEK, stream: false, max_tokens: 80000 });
  await sources.close();
});

it('requires a new verified check-in after the UTC date changes, including sticky/direct completions', async () => {
  const path = await directory(); await writeApinexGrant(grant, path);
  let now = Date.parse('2026-11-15T23:59:59Z');
  await writeFile(join(path, 'apinex.json'), JSON.stringify({ ...grant, free_account_verified: true, daily_checkin_at: '2026-11-15T04:46:00Z' }), { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/subscription') ? Response.json(active) : reply());
  const source = new Apinex({ directory: path, fetcher, now: () => now });
  expect(await source.available()).toBe(true);
  await source.complete(request, AbortSignal.timeout(1000)); expect(fetcher).toHaveBeenCalledTimes(3);
  now = Date.parse('2026-11-16T00:00:00Z');
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'logged_out', message: 'APInex daily free check-in is required; rerun usegrunt setup' });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each([{ ...active, mode: 'paid' }, { ...active, allowed: false }, { ...active, tokens_remaining: 0 }, { ...active, tokens_remaining: '100' }])('does not infer through an inactive or unverified free allowance', async state => {
  const path = await directory(); await writeApinexGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(state)), source = new Apinex({ directory: path, fetcher });
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: state.mode === 'paid' ? 'refused' : 'quota' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/subscription'))).toBe(true);
});

it('requires consent and fails closed immediately after it is revoked', async () => {
  const path = await directory(false); await writeApinexGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/subscription') ? Response.json(active) : reply());
  const source = new Apinex({ directory: path, fetcher });
  expect(await source.available()).toBe(false);
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).not.toHaveBeenCalled();
  await recordDataSharingConsent(path, ['apinex']); await source.complete(request, AbortSignal.timeout(1000));
  await rm(join(path, 'data-sharing-consent.json'));
  await expect(source.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(['deepseek-v4-flash', 'deepseek-v3.2', null])('does not attribute a different or unidentified returned model to APInex', async model => {
  const path = await directory(); await writeApinexGrant(grant, path);
  const fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/subscription') ? Response.json(active) : reply(model));
  await expect(new Apinex({ directory: path, fetcher }).complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'upstream' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('rejects grant files without check-in verification, broad permissions, symlinks, or insecure URLs', async () => {
  const path = await directory(); await writeFile(join(path, 'apinex.json'), JSON.stringify(grant), { mode: 0o600 });
  await expect(readApinexGrant(path)).rejects.toThrow('verification');
  await writeApinexGrant(grant, path); await chmod(join(path, 'apinex.json'), 0o644);
  await expect(readApinexGrant(path)).rejects.toThrow('Unsafe');
  await rm(join(path, 'apinex.json')); await writeFile(join(path, 'target.json'), JSON.stringify(grant), { mode: 0o600 });
  await symlink(join(path, 'target.json'), join(path, 'apinex.json')); await expect(readApinexGrant(path)).rejects.toThrow();
  await expect(writeApinexGrant({ ...grant, base_url: 'http://grant.test' }, path)).rejects.toThrow('endpoint');
  expect((await readFile(join(path, 'target.json'), 'utf8'))).toBe(JSON.stringify(grant));
});

it('cancels an in-flight quota read without starting inference', async () => {
  const path = await directory(); await writeApinexGrant(grant, path);
  let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
  const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    started(); init?.signal?.addEventListener('abort', () => reject(new Error('private cancellation details')), { once: true });
  }));
  const source = new Apinex({ directory: path, fetcher }), caller = new AbortController();
  const pending = source.complete(request, caller.signal); await waiting; caller.abort(new Error('caller cancelled'));
  await expect(pending).rejects.toThrow('caller cancelled'); expect(fetcher).toHaveBeenCalledOnce();
});
