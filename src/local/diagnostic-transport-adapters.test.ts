import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiagnosticsStore, withDiagnosticContext } from './diagnostics.js';
import { FreeLLMAPI } from './freellmapi.js';
import { TokenHarbor } from './tokenharbor.js';
import { verifyBeatAPIAccess } from './beatapi.js';
import { verifyPollinationsAccess } from './pollinations.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { runMistralVibeProcess } from './mistral-vibe.js';
import { openPerchACP, runPerchCommand } from './perch-process.js';
import type { ModelRequest } from './source.js';

const directories: string[] = [];
const stores: DiagnosticsStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-transport-'));
  directories.push(directory);
  const store = await DiagnosticsStore.open({ directory }); stores.push(store);
  const requestId = randomUUID();
  return { directory, store, requestId, run: <T>(fn: () => T) => withDiagnosticContext({ requestId, kind: 'diagnostic', sink: store }, fn) };
}
const request: ModelRequest = { model: 'freellmapi', messages: [{ role: 'user', content: 'private synthetic prompt' }], tools: [], cwd: tmpdir(), stream: false };
const privateBody = 'synthetic-private-upstream-body';
const privateToken = 'synthetic-private-token';
const privateGrant = 'g_AAAAAAAAAAAAAAAAAAAAAAAA';
const grant = { base_url: `https://trusty-squire-api.fly.dev/v1/egress/${privateGrant}`, token: privateToken };
function expectMetadataOnly(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const text of [privateBody, privateToken, privateGrant, 'private synthetic prompt', 'Authorization', 'stdout', 'stderr']) expect(serialized).not.toContain(text);
}

it('retains the real HTTP status and Retry-After without recording an error body, URL, authorization or prompt', async () => {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(privateBody, { status: 429, headers: { 'Retry-After': '73' } }));
  const source = new FreeLLMAPI({ key: privateToken, fetcher });
  await expect(f.run(() => source.complete(request, new AbortController().signal))).rejects.toMatchObject({ code: 'quota', diagnostics: { httpStatus: 429, transport: 'http' } });
  const result = await f.store.list({ requestId: f.requestId });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({ type: 'transport.finish', source: 'freellmapi', httpStatus: 429, httpMethod: 'POST', endpointLabel: 'chat.completions', errorCode: 'quota', retryAfterSeconds: 73 });
  expectMetadataOnly(result);
});

it('records availability metadata failures that the provider intentionally converts into false', async () => {
  const f = await fixture(); await recordDataSharingConsent(f.directory, ['tokenharbor']);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(privateBody, { status: 401 }));
  const source = new TokenHarbor({ directory: f.directory, loadGrant: async () => grant, fetcher });
  expect(await f.run(() => source.available())).toBe(false);
  const result = await f.store.list({ requestId: f.requestId });
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({ source: 'tokenharbor', endpointLabel: 'account', httpMethod: 'GET', httpStatus: 401, errorCode: 'logged_out' });
  expectMetadataOnly(result);
});

it('preserves BeatAPI quota classification and its retry delay on nonbillable account requests', async () => {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(privateBody, { status: 429, headers: { 'Retry-After': '11' } }));
  await expect(f.run(() => verifyBeatAPIAccess(grant, { fetcher }))).rejects.toMatchObject({ code: 'quota', retryAfter: 11, diagnostics: { httpStatus: 429 } });
  const result = await f.store.list({ requestId: f.requestId });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.events[0]).toMatchObject({ source: 'beatapi', endpointLabel: 'account', httpStatus: 429, retryAfterSeconds: 11 });
  expectMetadataOnly(result);
});

it('observes each Pollinations account/catalog check without exposing grant paths or multiplying requests', async () => {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(privateBody, { status: 403 }));
  await expect(f.run(() => verifyPollinationsAccess(grant, { fetcher }))).rejects.toMatchObject({ code: 'refused', diagnostics: { httpStatus: 403 } });
  const result = await f.store.list({ requestId: f.requestId });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(result.events).toHaveLength(3);
  expect(result.events.filter(event => event.endpointLabel === 'models')).toHaveLength(1);
  expect(result.events.every(event => event.httpStatus === 403 && event.source === 'pollinations')).toBe(true);
  expectMetadataOnly(result);
});

it('leaves unreported usage unknown and returns successful completions despite a broken diagnostic sink', async () => {
  const f = await fixture();
  vi.spyOn(f.store, 'record').mockImplementation(() => { throw new Error('synthetic recorder failure'); });
  const response = Response.json({ choices: [{ message: { content: 'answer' } }] });
  const fetcher = vi.fn<typeof fetch>(async () => response);
  const source = new FreeLLMAPI({ key: privateToken, fetcher });
  const completion = await f.run(() => source.complete(request, new AbortController().signal));
  expect(completion.text).toBe('answer');
  expect(completion.inputTokens).toBeUndefined(); expect(completion.outputTokens).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('records actual CLI exit codes while native stdout/stderr stay outside persistent diagnostics', async () => {
  const f = await fixture();
  const options = { cwd: f.directory, env: { PATH: '/usr/bin:/bin' }, signal: AbortSignal.timeout(5000) };
  const command = `process.stdout.write(${JSON.stringify(privateBody)});process.stderr.write(${JSON.stringify(privateToken)});process.exit(7)`;
  const result = await f.run(() => runMistralVibeProcess(process.execPath, ['-e', command], options));
  expect(result.code).toBe(7); expect(result.stdout).toBe(privateBody);
  await f.run(() => runPerchCommand(process.execPath, ['-e', 'process.exit(3)'], options));
  const events = (await f.store.list({ requestId: f.requestId })).events;
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'mistral-vibe', transport: 'cli', exitCode: 7, outcome: 'failed' }),
    expect.objectContaining({ source: 'perch', transport: 'cli', exitCode: 3, outcome: 'failed' })
  ]));
  expectMetadataOnly(events);
});

it('records an unexpected Perch ACP exit without exposing the raw protocol or command arguments', async () => {
  const f = await fixture(), binary = join(f.directory, 'acp.cjs');
  await writeFile(binary, `process.stderr.write(${JSON.stringify(privateToken)});process.exit(9)`, { mode: 0o600 });
  await f.run(async () => {
    const session = await openPerchACP(binary, { cwd: f.directory, env: { PATH: '/usr/bin:/bin' }, signal: AbortSignal.timeout(5000) });
    await expect(session.request('initialize', {})).rejects.toBeDefined();
    await session.close();
  });
  const result = await f.store.list({ requestId: f.requestId });
  expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'perch', transport: 'cli', exitCode: 9, outcome: 'failed' })]));
  expectMetadataOnly(result);
});
