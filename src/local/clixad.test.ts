import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BinaryLike, BinaryToTextEncoding } from 'node:crypto';
import type * as NativeOS from 'node:os';
import type * as NativeCrypto from 'node:crypto';
import type { ClixadRunResult, ClixadRunner } from './clixad.js';
import type { ModelRequest } from './source.js';
const state = vi.hoisted(() => ({ nativeHome: '', hashes: new Map<string, string>() }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof NativeOS>(), homedir: () => state.nativeHome }));
vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof NativeCrypto>();
  return { ...original, createHash: (...args: Parameters<typeof original.createHash>) => {
    const hash = original.createHash(...args), update = hash.update.bind(hash), digest = hash.digest.bind(hash); let fixture = '';
    // Portable synthetic installation fixtures: every other digest, including
    // consent fingerprints and call IDs, uses the real hash implementation.
    hash.update = ((data: BinaryLike) => { fixture += typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(); update(data); return hash; }) as typeof hash.update;
    hash.digest = ((encoding?: BinaryToTextEncoding) => args[0] === 'sha256' && encoding === 'hex' && state.hashes.has(fixture) ? state.hashes.get(fixture) : encoding ? digest(encoding) : digest()) as typeof hash.digest;
    return hash;
  } };
});
import { Clixad, CLIXAD_CORE_SHA256, CLIXAD_GATEWAY, CLIXAD_MODEL, clixadEnvironment, clixadPaths, prepareClixadDirectories, readClixadInstallReceipt, verifyClixadAccess, writeClixadInstallReceipt } from './clixad.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';
let directory: string;
const sources: Clixad[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-clixad-test-')); state.nativeHome = join(directory, 'native');
  await mkdir(join(state.nativeHome, '.clixad'), { recursive: true, mode: 0o700 });
  await writeFile(join(state.nativeHome, '.clixad/config.json'), 'synthetic-native-owned-auth-must-not-be-read', { mode: 0o600 });
  const paths = await prepareClixadDirectories(directory); await mkdir(join(paths.package, 'dist'), { recursive: true, mode: 0o700 });
  for (const [name, digest] of Object.entries(CLIXAD_CORE_SHA256)) { const content = `synthetic-clixad-core:${name}`; state.hashes.set(content, digest); await writeFile(join(paths.package, 'dist', name), content, { mode: 0o600 }); }
  await writeClixadInstallReceipt(directory); await recordDataSharingConsent(directory, ['clixad']);
});
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.close())); vi.restoreAllMocks(); vi.unstubAllEnvs(); state.hashes.clear(); await rm(directory, { recursive: true, force: true }); });
const request = (): ModelRequest => ({ model: 'clixad', messages: [{ role: 'user', content: 'Say Hello' }], tools: [], cwd: '/tmp', stream: false });
const catalog = () => ({ data: [{ id: CLIXAD_MODEL, free: true, auto_mode: false, context_window: 1048576 }] });
const publicFetch = () => vi.fn<typeof fetch>(async () => Response.json(catalog()));
const wallet = (patch: Record<string, unknown> = {}): ClixadRunResult => ({ code: 0, stdout: '', events: [{ event: 'http', operation: 'streak', status: 200 }, { event: 'http', operation: 'wallet', status: 200 }, { event: 'wallet', balance: 0, modelEligible: true, dailyCredits: 120000, creditsLeft: 100000, ...patch }] });
const completion = (patch: Record<string, unknown> = {}, text = '{"version":1,"type":"final","text":"Hello."}'): ClixadRunResult => ({ code: 0, stdout: `assistant ${text}\n  [0 credits · balance 0]\n`, events: [{ event: 'dispatch', model: CLIXAD_MODEL }, { event: 'http', operation: 'chat', status: 200 }, { event: 'completion', inputTokens: 30, outputTokens: 50, free: true, creditsCharged: 0, balance: 0, creditsLeft: 99999, ...patch }] });
function fixture(options: { ask?: ClixadRunResult; wallets?: ClixadRunResult[]; model?: string; fetcher?: typeof fetch; timeout?: number } = {}) {
  let wallets = 0;
  const runner = vi.fn<ClixadRunner>(async (_entry, mode) => mode === 'model' ? { code: 0, stdout: `current model: ${options.model ?? CLIXAD_MODEL}\n`, events: [] }
    : mode === 'wallet' ? options.wallets?.[wallets++] ?? wallet() : options.ask ?? completion());
  const fetcher = options.fetcher ?? publicFetch(), source = new Clixad({ directory, runner, fetcher, ...(options.timeout ? { timeout: options.timeout } : {}) }); sources.push(source);
  return { source, runner, fetcher, asks: () => runner.mock.calls.filter(([, mode]) => mode === 'ask') };
}
it('background availability checks only private metadata and public catalog, never native wallet or streak', async () => {
  const f = fixture(); expect(await f.source.available()).toBe(true); expect(await f.source.healthCheck()).toBe(true);
  expect(f.runner).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.fetcher).mock.calls.every(([url, init]) => url === `${CLIXAD_GATEWAY}/v1/models` && init?.method === undefined && new Headers(init?.headers).get('authorization') === null)).toBe(true);
});
it('runs model/wallet checks, one no-action ask and post-wallet guard, preserving prompt contents and measured usage', async () => {
  const f = fixture(); const req = { ...request(), messages: [{ role: 'user', content: 'Keep literal Pi and Freebuff names unchanged.' }], maxTokens: 1000 };
  expect(await f.source.complete(req, new AbortController().signal)).toEqual({ text: 'Hello.', inputTokens: 30, outputTokens: 50 });
  expect(f.runner.mock.calls.map(([, mode]) => mode)).toEqual(['model', 'wallet', 'ask', 'wallet']);
  const [, , options] = f.asks()[0]!; expect(options.cwd).not.toBe(req.cwd); expect(options.input).toContain(req.messages[0]!.content); expect(options.input).toContain('1000 tokens');
  expect(await readFile(join(state.nativeHome, '.clixad/config.json'), 'utf8')).toBe('synthetic-native-owned-auth-must-not-be-read');
});
it('requires current sharing consent before native commands or public requests', async () => {
  await rm(join(directory, 'data-sharing-consent.json')); const f = fixture(); expect(await f.source.available()).toBe(false);
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.runner).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([{ free: false }, { auto_mode: true }, { context_window: 199999 }, { id: 'another-model' }])('refuses stale/nonfree public model metadata before native calls (%j)', async patch => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ ...catalog().data[0], ...patch }] })), f = fixture({ fetcher });
  expect(await f.source.available()).toBe(false); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.runner).not.toHaveBeenCalled();
});
it('rejects a changed native model without overwriting the CLI preference or sending an ask', async () => {
  const f = fixture({ model: 'gpt-5-nano' }); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.runner.mock.calls.map(([, mode]) => mode)).toEqual(['model']);
});
it.each([[401, 'logged_out'], [403, 'refused']] as const)('sanitizes native wallet HTTP %i and never starts an ask', async (status, code) => {
  const denied = { code: 0, stdout: 'synthetic-private-native-error', events: [{ event: 'http', operation: 'wallet', status }] };
  const f = fixture({ wallets: [denied] });
  const error = await f.source.complete(request(), new AbortController().signal).catch(value => value);
  expect(error).toMatchObject({ code }); expect(error.message).not.toContain('synthetic-private'); expect(f.asks()).toHaveLength(0);
});
it('rejects oversized prompts before native wallet or any other provider request', async () => {
  const f = fixture();
  await expect(f.source.complete({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] }, new AbortController().signal)).rejects.toThrow('input size');
  expect(f.runner).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([{ balance: 1 }, { modelEligible: false }, { dailyCredits: 0 }, { creditsLeft: -1 }])('refuses funded or missing free access before inference (%j)', async patch => {
  const f = fixture({ wallets: [wallet(patch)] }); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(f.asks()).toHaveLength(0);
});
it('returns quota for exhausted free allowance, and accepts a successful last free completion that leaves zero allowance', async () => {
  const exhausted = fixture({ wallets: [wallet({ creditsLeft: 0 })] }); await expect(exhausted.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'quota' }); expect(exhausted.asks()).toHaveLength(0);
  const last = fixture({ wallets: [wallet(), wallet({ creditsLeft: 0 })] }); expect((await last.source.complete(request(), new AbortController().signal)).text).toBe('Hello.');
});
it.each([
  [{ free: false }, 'completion_billing'],
  [{ creditsCharged: 1 }, 'completion_billing'],
  [{ balance: 1 }, 'completion_billing'],
  [{ returnedModel: 'another-model' }, 'completion_model'],
  [{ outputTokens: 4097 }, 'completion_usage'],
  [{ inputTokens: undefined }, 'completion_usage'],
  [{ outputTokens: 0 }, 'completion_usage'],
] as const)('identifies unsafe native metadata without another ask (%j)', async (patch, failureReason) => {
  const f = fixture({ ask: completion(patch) });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason } });
  expect(f.runner.mock.calls.map(([, mode]) => mode)).toEqual(['model', 'wallet', 'ask']);
});
it('never trusts model-authored stdout billing/usage or missing IPC metadata', async () => {
  const ask = completion();
  ask.events = ask.events.filter(event => event.event !== 'completion');
  const f = fixture({ ask });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({
    code: 'refused', diagnostics: { failureReason: 'completion_attestation' }
  });
  expect(f.runner.mock.calls.map(([, mode]) => mode)).toEqual(['model', 'wallet', 'ask']);
});
it('refuses an external deposit seen in the postflight wallet', async () => {
  const f = fixture({ wallets: [wallet(), wallet({ balance: 200 })] }); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
});
it('validates external tool schemas, call correlation and unseen results with no native execution', async () => {
  const tool = { type: 'function', function: { name: 'nonce', parameters: { type: 'object', properties: { value: { type: 'string', const: 'test' } }, required: ['value'], additionalProperties: false } } };
  const f = fixture({ ask: completion({}, '{"version":1,"type":"calls","calls":[{"name":"nonce","arguments":{"value":"test"}}]}') });
  const out = await f.source.complete({ ...request(), tools: [tool] }, new AbortController().signal); expect(out.calls?.[0]?.function).toEqual({ name: 'nonce', arguments: '{"value":"test"}' });
  const invalid = fixture(); await expect(invalid.source.complete({ ...request(), tools: [tool], messages: [{ role: 'tool', content: 'invented', tool_call_id: 'invented' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(invalid.runner).not.toHaveBeenCalled();
  const badSchema = { ...tool, function: { ...tool.function, parameters: { type: 'invented' } } }; await expect(invalid.source.complete({ ...request(), tools: [badSchema] }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
});
it('coalesces Responses parallel function-call history before protocol validation', async () => {
  const f = fixture(), app = createLocalApp(new Sources([f.source]));
  const response = await app.request('http://localhost:8788/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'clixad', input: [
    { role: 'user', content: 'Use both actual results' }, { type: 'function_call', call_id: 'a', name: 'nonce', arguments: '{}' }, { type: 'function_call', call_id: 'b', name: 'nonce', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'actual-a' }, { type: 'function_call_output', call_id: 'b', output: 'actual-b' }
  ] }) }); expect(response.status).toBe(200); expect(f.asks()[0]![2].input).toContain('actual-b');
});
it('does not repair malformed/refused output and honors small caller output caps', async () => {
  const f = fixture({ ask: completion({}, 'I cannot do that.') });
  await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({
    code: 'upstream', diagnostics: { failureReason: 'completion_protocol' }
  });
  expect(f.asks()).toHaveLength(1);
  const over = fixture({ ask: completion({ outputTokens: 2 }) }); await expect(over.source.complete({ ...request(), maxTokens: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' });
  for (const maxTokens of [0, -1, NaN, 1.5]) await expect(over.source.complete({ ...request(), maxTokens }, new AbortController().signal)).rejects.toMatchObject({ code: 'refused' }); expect(over.asks()).toHaveLength(1);
});
it('rejects tampered install files, private modes, auth symlinks, and missing receipts', async () => {
  const paths = clixadPaths(directory), f = fixture();
  await writeFile(paths.entry, 'tampered'); expect(await f.source.available()).toBe(false); await expect(f.source.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'not_installed' });
  await writeFile(paths.entry, 'synthetic-clixad-core:clixad.mjs'); await chmod(join(state.nativeHome, '.clixad/config.json'), 0o644); expect(await f.source.available()).toBe(false);
  await rm(join(state.nativeHome, '.clixad/config.json')); await symlink(paths.entry, join(state.nativeHome, '.clixad/config.json')); expect(await f.source.available()).toBe(false);
  await chmod(paths.installation, 0o644); await expect(readClixadInstallReceipt(directory)).rejects.toMatchObject({ code: 'not_installed' }); expect(f.runner).not.toHaveBeenCalled();
});
it('scrubs inherited routing/module/key overrides without overriding the native token-origin binding', () => {
  vi.stubEnv('CLIXAD_GATEWAY_URL', 'https://untrusted.invalid'); vi.stubEnv('NODE_OPTIONS', '--import=untrusted'); vi.stubEnv('OTHER_API_KEY', 'synthetic-private');
  const env = clixadEnvironment(); expect(env.CLIXAD_GATEWAY_URL).toBeUndefined(); expect(env.CLIXAD_DASHBOARD_URL).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.OTHER_API_KEY).toBeUndefined();
});
it('cancels native commands and deadlines even if an injected runner ignores its signal', async () => {
  const runner = vi.fn<ClixadRunner>(async () => new Promise<ClixadRunResult>(() => {})), source = new Clixad({ directory, runner, fetcher: publicFetch() }); sources.push(source);
  const pending = source.complete(request(), new AbortController().signal), rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' }); await vi.waitFor(() => expect(runner).toHaveBeenCalled()); await source.close(); await rejected;
  const timed = new Clixad({ directory, runner, fetcher: publicFetch(), timeout: 5 }); sources.push(timed); await expect(timed.complete(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
});
it('explicit setup access verification uses only the native read-only model and wallet commands', async () => {
  const f = fixture(); await verifyClixadAccess({ directory, runner: f.runner, fetcher: f.fetcher }); expect(f.runner.mock.calls.map(([, mode]) => mode)).toEqual(['model', 'wallet']);
});

async function childFixture(kind: string, input = 'synthetic prompt', mode: 'ask' | 'wallet' = 'ask') {
  const work = join(directory, `child-${kind}`); await mkdir(work, { mode: 0o700 });
  const preload = join(work, 'preload.mjs'), native = join(work, 'native.mjs'), fakeFetch = join(work, 'fake-fetch.mjs'), calls = join(work, 'calls');
  const compiled = transpileModule(await readFile(new URL('./clixad-preload.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
  await writeFile(preload, compiled);
  await writeFile(fakeFetch, `import {appendFileSync} from 'node:fs';globalThis.fetch=async(input,init)=>{appendFileSync(process.env.FIXTURE_CALLS,'call\\n');const chunks=[{choices:[{delta:{content:'synthetic answer'}}]},{usage:{prompt_tokens:210123,completion_tokens:12},clixad:{free:true,credits_charged:0,balance:0,free_credits_left:90000}}];if(['native-tool','stream-tool'].includes(process.env.FIXTURE_KIND))chunks[0]={choices:[{delta:{tool_calls:[{id:'forbidden'}]}}]};if(process.env.FIXTURE_KIND==='paid')chunks[1].clixad.credits_charged=1;const text=chunks.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join('')+'data: [DONE]\\n\\n';const r=new Response(text);Object.defineProperty(r,'url',{value:'https://clixad.onrender.com/v1/chat/completions'});return r;};`);
  await writeFile(native, `import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';if(process.env.FIXTURE_KIND==='foreign-profile'){const config=JSON.parse(readFileSync(process.env.FIXTURE_NATIVE_CONFIG,'utf8'));const gateway=process.env.CLIXAD_GATEWAY_URL||config.gatewayUrl;await fetch(gateway+'/v1/wallet',{headers:{Authorization:'Bearer '+config.token}});process.exit(0);}const prompt=process.argv[3];const body={model:process.env.FIXTURE_KIND==='wrong-model'?'paid-model':'glm-5.3-flash',messages:[{role:'user',content:prompt}],stream:true};if(process.env.FIXTURE_KIND==='native-tool')body.tools=[];const url=process.env.FIXTURE_KIND==='wrong-host'?'https://untrusted.invalid/v1/chat/completions':'https://clixad.onrender.com/v1/chat/completions';const init={method:'POST',body:process.env.FIXTURE_KIND==='encoded'?new Uint8Array([1,2,3]):JSON.stringify(body)};const r=await fetch(url,init);await r.text();if(process.env.FIXTURE_KIND==='retry')await fetch(url,init);console.log('logical-length='+prompt.length);console.log('logical-sha='+createHash('sha256').update(prompt).digest('hex'));`);
  const nativeConfig = join(work, 'synthetic-native-config.json');await writeFile(nativeConfig,JSON.stringify({gatewayUrl:'https://foreign-profile.invalid',tokenGateway:'https://foreign-profile.invalid',token:'synthetic-foreign-profile-token'}),{mode:0o600});
  const events: Record<string, unknown>[] = [], nonce = 'a'.repeat(32);
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', fakeFetch, '--import', preload, native, mode], { cwd: work, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...clixadEnvironment(), GRUNT_CLIXAD_NONCE: nonce, FIXTURE_KIND: kind, FIXTURE_CALLS: calls, FIXTURE_NATIVE_CONFIG: nativeConfig } });
    let stdout = ''; child.stdout!.on('data', chunk => stdout += chunk); child.stderr!.resume(); child.on('message', value => events.push(value as Record<string, unknown>)); child.on('error', reject); child.stdin!.on('error', () => {}); child.stdin!.end(input); child.on('close', code => resolve({ code, stdout }));
  });
  const sent = await readFile(calls, 'utf8').catch(() => ''); return { ...result, events, providerCalls: sent.trim() ? sent.trim().split('\n').length : 0 };
}
it('preload transports a large exact stdin prompt into the untouched native logical argv and emits metadata only over IPC', async () => {
  const input = ' x'.repeat(250000), out = await childFixture('valid', input); expect(out.code).toBe(0); expect(out.stdout.trim()).toBe(`logical-length=${input.length}\nlogical-sha=${createHash('sha256').update(input).digest('hex')}`); expect(out.providerCalls).toBe(1);
  const event = out.events.find(event => event.event === 'completion'); expect(event).toMatchObject({ inputTokens: 210123, outputTokens: 12, free: true, creditsCharged: 0, balance: 0 });
  expect(JSON.stringify(out.events)).not.toContain(input.slice(0, 100)); expect(createHash('sha256').update(input).digest('hex')).toHaveLength(64);
});
it.each(['wrong-model', 'wrong-host', 'native-tool', 'encoded'])('preload blocks %s before any provider call', async kind => {
  const out = await childFixture(kind); expect(out.code).not.toBe(0); expect(out.providerCalls).toBe(0); expect(out.events.some(event => event.event === 'guard')).toBe(true);
});
it('preload rejects a second native POST rather than following a retry or encoded fallback', async () => {
  const out = await childFixture('retry'); expect(out.code).not.toBe(0); expect(out.providerCalls).toBe(1); expect(out.events.some(event => event.event === 'guard')).toBe(true);
});
it('preload refuses nonfree native cost metadata and never marks it a completion', async () => {
  const out = await childFixture('paid'); expect(out.code).not.toBe(0); expect(out.events.some(event => event.event === 'completion')).toBe(false);
});

it('preload rejects unexpected native SSE tool actions after the single provider response', async () => {
  const out = await childFixture('stream-tool'); expect(out.code).not.toBe(0); expect(out.providerCalls).toBe(1); expect(out.events.some(event => event.event === 'completion')).toBe(false);
});

it('preserves a foreign stored gateway/tokenGateway binding and blocks its wallet before any outbound fetch', async () => {
  vi.stubEnv('CLIXAD_GATEWAY_URL', CLIXAD_GATEWAY);
  const out = await childFixture('foreign-profile', '', 'wallet'); expect(out.code).not.toBe(0); expect(out.providerCalls).toBe(0); expect(out.events.some(event => event.event === 'guard')).toBe(true); expect(JSON.stringify(out.events)).not.toContain('synthetic-foreign-profile-token');
});
