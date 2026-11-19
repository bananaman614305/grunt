import { diagnosticFetch, recordTransport } from './diagnostics.js';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { Ajv } from 'ajv';
import type { AnySchema } from 'ajv';
import { readDataSharingConsent } from './data-sharing.js';
import { providerGrantDirectory } from './provider-grant.js';
import { FreebuffTools } from './freebuff-tools.js';
import { SourceError } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';

export const CLIXAD_VERSION = '0.0.1-beta.51';
export const CLIXAD_MODEL = 'glm-5.3-flash';
export const CLIXAD_GATEWAY = 'https://clixad.onrender.com';
export const CLIXAD_DASHBOARD = 'https://app.clixad.io';
export const CLIXAD_INTEGRITY = 'sha512-dZMQxSglUJe/8ZKfw4BXvsD05CbhuTNlTb2IN9eQrZU58K4qdzijrGfTO0SY37MJcr9Yb3XBWb7xBdD1wVVgNQ==';
export const CLIXAD_TARBALL = `https://registry.npmjs.org/clixad/-/clixad-${CLIXAD_VERSION}.tgz`;
export const CLIXAD_CORE_SHA256 = {
  'clixad.mjs': '68ceee5bd62f7afd2f2850e5e38462b985d0798d6a5ce70c917be77506dc4929',
  'chunk-OPJ5LW6R.mjs': '8f80ef76188e72c2bb8400ed4897045eb6c68e81c49fc7376acdde84f061b401',
  'tui-NCLZGRMH.mjs': '92b69b5f79a73203b29a57c936ab1d6e257e5433e90b19fff6ce2fb0fa981c41'
} as const;
export const CLIXAD_TIMEOUT_MS = 175000;
export function clixadPaths(directory = providerGrantDirectory()) {
  const home = resolve(directory, 'clixad'), runtime = join(home, 'runtime'), pkg = join(runtime, 'node_modules', 'clixad');
  return { home, runtime, package: pkg, entry: join(pkg, 'dist', 'clixad.mjs'), work: join(home, 'work'), installation: join(home, 'installation.json') };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const missing = () => new SourceError('not_installed', 'Clixad private pinned CLI installation is missing or unsafe; rerun usegrunt setup');
async function privateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw missing();
}
export async function prepareClixadDirectories(directory = providerGrantDirectory()) {
  const paths = clixadPaths(directory);
  for (const path of [paths.home, paths.runtime, paths.work]) await privateDirectory(path, true);
  return paths;
}
function installation(value: unknown) {
  const receipt = object(value);
  if (receipt.version !== 1 || receipt.cliVersion !== CLIXAD_VERSION || receipt.integrity !== CLIXAD_INTEGRITY
    || JSON.stringify(receipt.coreSha256) !== JSON.stringify(CLIXAD_CORE_SHA256)) throw missing();
  return { version: 1 as const, cliVersion: CLIXAD_VERSION, integrity: CLIXAD_INTEGRITY, coreSha256: CLIXAD_CORE_SHA256 };
}
export async function writeClixadInstallReceipt(directory = providerGrantDirectory()) {
  const paths = await prepareClixadDirectories(directory), temporary = join(paths.home, `.installation-${randomUUID()}`);
  try { await writeFile(temporary, JSON.stringify(installation({ version: 1, cliVersion: CLIXAD_VERSION, integrity: CLIXAD_INTEGRITY, coreSha256: CLIXAD_CORE_SHA256 })), { flag: 'wx', mode: 0o600 }); await rename(temporary, paths.installation); }
  finally { await rm(temporary, { force: true }); }
}
export async function readClixadInstallReceipt(directory = providerGrantDirectory()) {
  let file;
  try {
    file = await open(clixadPaths(directory).installation, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw missing();
    return installation(JSON.parse(await file.readFile('utf8')));
  } catch { throw missing(); } finally { await file?.close(); }
}
async function ready(directory: string) {
  const paths = clixadPaths(directory);
  for (const path of [paths.home, paths.runtime, paths.work]) await privateDirectory(path);
  for (const path of [join(paths.runtime, 'node_modules'), paths.package, dirname(paths.entry)]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw missing();
  }
  await readClixadInstallReceipt(directory);
  for (const [name, digest] of Object.entries(CLIXAD_CORE_SHA256)) {
    let file;
    try {
      file = await open(join(dirname(paths.entry), name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || stat.size > 1024 * 1024) throw missing();
      if (createHash('sha256').update(await file.readFile()).digest('hex') !== digest) throw missing();
    } catch { throw missing(); } finally { await file?.close(); }
  }
  // Native auth remains CLI-owned: only metadata is inspected by Grunt.
  const native = join(homedir(), '.clixad');
  try {
    await privateDirectory(native);
    const stat = await lstat(join(native, 'config.json'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 65536) throw new Error();
  } catch { throw new SourceError('logged_out', 'Clixad native login is missing or unsafe; rerun usegrunt setup'); }
  return paths;
}
export function clixadEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:node_|node$|clixad_|grunt_clixad_|agent_cli_|cursor_|grok_)/i.test(key)
    && !/(?:^|_)(?:api_key|auth_token|access_token|refresh_token|secret|secret_key|token)$/i.test(key)));
  // Do not inject a gateway override: the native CLI then preserves its stored
  // token-origin binding. The child preload rejects nonofficial destinations
  // before fetch, rather than redirecting another profile's credentials.
  return { ...env, CLIXAD_SPONSOR: '0', NO_COLOR: '1', FORCE_COLOR: '0' };
}
export interface ClixadEvent { event: string; [key: string]: unknown }
export interface ClixadRunOptions { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; input?: string }
export interface ClixadRunResult { code: number | null; stdout: string; events: ClixadEvent[] }
export type ClixadRunner = (entry: string, mode: 'model' | 'wallet' | 'ask', options: ClixadRunOptions) => Promise<ClixadRunResult>;
export const runClixadProcess: ClixadRunner = async (entry, mode, options) => {
  options.signal.throwIfAborted();
  if (!['linux', 'darwin'].includes(process.platform) || !isAbsolute(entry)) throw missing();
  const started = performance.now();
  const nonce = randomBytes(16).toString('hex'), preload = fileURLToPath(new URL('./clixad-preload.js', import.meta.url));
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', preload, entry, mode], { cwd: options.cwd,
      env: { ...options.env, GRUNT_CLIXAD_NONCE: nonce }, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', bytes = 0, failure: unknown; const events: ClixadEvent[] = [], decoder = new StringDecoder('utf8');
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Our owned process group only. */ } } };
    const fail = (error: unknown) => { failure ??= error; stop(); };
    const deadline = setTimeout(() => fail(new SourceError('timeout', 'Clixad native command timed out')), CLIXAD_TIMEOUT_MS);
    child.on('message', value => {
      const item = object(value);
      if (item.type !== 'grunt-clixad' || item.version !== 1 || item.nonce !== nonce || !['guard', 'http', 'wallet', 'dispatch', 'completion'].includes(String(item.event))
        || JSON.stringify(item).length > 32768 || events.length >= 32) { fail(new SourceError('refused', 'Clixad returned invalid native metadata')); return; }
      const { type: _type, version: _version, nonce: _nonce, ...metadata } = item;
      events.push(metadata as ClixadEvent);
      if (item.event === 'guard') fail(new SourceError('refused', 'Clixad attempted an unsupported native action or response'));
    });
    const consume = (chunk: Buffer, capture: boolean) => {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { fail(new SourceError('upstream', 'Clixad native output exceeded the supported size')); return; }
      if (capture) stdout += decoder.write(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => consume(chunk, mode !== 'wallet'));
    child.stderr!.on('data', (chunk: Buffer) => consume(chunk, false));
    const abort = () => stop(); options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) stop();
    child.stdin!.on('error', () => {}); child.stdin!.end(mode === 'ask' ? options.input : undefined);
    child.once('error', () => fail(missing()));
    child.once('close', code => {
      clearTimeout(deadline); options.signal.removeEventListener('abort', abort); stop();
      stdout += decoder.end();
      recordTransport({ source: 'clixad', transport: 'cli', endpointLabel: 'cli', durationMs: Math.max(0, performance.now() - started),
        outcome: options.signal.aborted ? 'cancelled' : failure || code !== 0 ? 'failed' : 'passed',
        ...(Number.isInteger(code) ? { exitCode: code! } : {}) });
      if (options.signal.aborted) reject(options.signal.reason); else if (failure) reject(failure); else resolveResult({ code, stdout, events });
    });
  });
};
async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort: (() => void) | undefined;
  try { return await Promise.race([task, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function boundedJSON(response: Response, signal: AbortSignal) {
  if (!response.body || Number(response.headers.get('content-length')) > 1048576) { void response.body?.cancel().catch(() => {}); throw new Error(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await abortable(reader.read(), signal); signal.throwIfAborted(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1048576) throw new Error(); chunks.push(part.value); } return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  finally { void reader.cancel().catch(() => {}); }
}
export async function verifyClixadPublicModel(options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(5000)]);
  try {
    signal.throwIfAborted();
    const response = await abortable(diagnosticFetch(options.fetcher ?? fetch, 'clixad', 'models')(`${CLIXAD_GATEWAY}/v1/models`, { redirect: 'error', signal }), signal);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(); }
    const body = await boundedJSON(response, signal), rows = Array.isArray(body.data) ? body.data.filter(row => object(row).id === CLIXAD_MODEL) : [];
    const model = object(rows.length === 1 ? rows[0] : undefined);
    if (model.free !== true || model.auto_mode !== false || !Number.isSafeInteger(model.context_window) || Number(model.context_window) < 200000) throw new SourceError('refused', 'Clixad GLM 5.3 Flash is not currently a fixed free model with at least 200K context');
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (signal.aborted) throw new SourceError('timeout', 'Clixad public catalog timed out');
    if (error instanceof SourceError) throw error;
    throw new SourceError('upstream', 'Clixad public model metadata is unavailable');
  }
}
function nativeErrors(result: ClixadRunResult) {
  for (const event of result.events) if (event.event === 'http' && Number.isInteger(event.status) && Number(event.status) >= 100 && Number(event.status) <= 599) {
    recordTransport({ source: 'clixad', transport: 'http', endpointLabel: 'cli', httpStatus: Number(event.status),
      outcome: Number(event.status) >= 200 && Number(event.status) < 300 ? 'passed' : 'failed' });
  }
  if (result.events.some(event => event.event === 'guard')) throw new SourceError('refused', 'Clixad attempted an unsupported native action or response');
  const failed = result.events.find(event => event.event === 'http' && (typeof event.status !== 'number' || event.status < 200 || event.status >= 300));
  if (failed) throw new SourceError(failed.status === 401 ? 'logged_out' : [402, 429].includes(Number(failed.status)) ? 'quota' : failed.status === 403 ? 'refused' : 'upstream', 'Clixad native access is unavailable', failed.status === 429 ? 60 : undefined, undefined, { transport: 'cli', endpointLabel: 'cli',
      ...(Number.isInteger(failed.status) && Number(failed.status) >= 100 && Number(failed.status) <= 599 ? { httpStatus: Number(failed.status) } : {}),
      ...(Number.isInteger(result.code) ? { exitCode: result.code! } : {}) });
  if (result.code !== 0) throw new SourceError('upstream', 'Clixad native command did not complete', undefined, undefined, { transport: 'cli', endpointLabel: 'cli', ...(Number.isInteger(result.code) ? { exitCode: result.code! } : {}) });
}
function wallet(result: ClixadRunResult, allowExhausted = false) {
  nativeErrors(result); const rows = result.events.filter(event => event.event === 'wallet'), state = object(rows.length === 1 ? rows[0] : undefined);
  if (result.events.filter(event => event.event === 'http' && event.operation === 'wallet').length !== 1
    || result.events.some(event => !['wallet', 'http'].includes(event.event) || event.event === 'http' && !['wallet', 'streak'].includes(String(event.operation)))
    || state.balance !== 0 || state.modelEligible !== true || typeof state.dailyCredits !== 'number' || !Number.isFinite(state.dailyCredits) || state.dailyCredits <= 0
    || typeof state.creditsLeft !== 'number' || !Number.isFinite(state.creditsLeft) || state.creditsLeft < 0) throw new SourceError('refused', 'Clixad requires zero account balance and verified free GLM allowance');
  if (!allowExhausted && state.creditsLeft === 0) {
    const now = Date.now();
    // Clixad replenishes the daily free allowance at 00:00 UTC.
    const reset = new Date(now).setUTCHours(24, 0, 0, 0);
    throw new SourceError('quota', 'Clixad daily free allowance is exhausted', Math.ceil((reset - now) / 1000));
  }
}
async function nativeAccess(paths: ReturnType<typeof clixadPaths>, runner: ClixadRunner, signal: AbortSignal) {
  const options = { cwd: paths.work, env: clixadEnvironment(), signal };
  const pin = await abortable(runner(paths.entry, 'model', options), signal); nativeErrors(pin);
  if (pin.events.length || pin.stdout.trim() !== `current model: ${CLIXAD_MODEL}`) throw new SourceError('refused', 'Clixad native model changed; select GLM 5.3 Flash explicitly in setup');
  wallet(await abortable(runner(paths.entry, 'wallet', options), signal));
}
/** Called by explicit setup/user requests only: native wallet may claim its ordinary daily streak bonus. */
export async function verifyClixadAccess(options: { directory: string; runner?: ClixadRunner; fetcher?: typeof fetch; signal?: AbortSignal }) {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(60000)]);
  signal.throwIfAborted();
  const paths = await ready(options.directory);
  await verifyClixadPublicModel({ ...(options.fetcher ? { fetcher: options.fetcher } : {}), signal });
  await nativeAccess(paths, options.runner ?? runClixadProcess, signal);
}
function bridgeFor(request: ModelRequest) {
  try {
    const messages: ModelRequest['messages'] = [];
    for (const message of request.messages) {
      const previous = messages.at(-1);
      if (message.role === 'assistant' && !message.content && message.tool_calls?.length && !message.tool_call_id
        && previous?.role === 'assistant' && !previous.content && previous.tool_calls?.length && !previous.tool_call_id) previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      else messages.push({ ...message });
    }
    const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, addUsedSchema: false });
    for (const tool of request.tools) ajv.compile(object(tool.function).parameters as AnySchema);
    return new FreebuffTools({ ...request, messages });
  } catch { throw new SourceError('refused', 'Clixad rejected invalid function tools or an uncorrelated tool conversation'); }
}
export class Clixad implements Source {
  readonly id = 'clixad'; readonly supportsFunctionTools = true;
  private shutdown = new AbortController(); private pending = new Set<Promise<unknown>>();
  constructor(private options: { directory?: string; runner?: ClixadRunner; fetcher?: typeof fetch; timeout?: number } = {}) {}
  private get directory() { return this.options.directory ?? providerGrantDirectory(); }
  private get runner() { return this.options.runner ?? runClixadProcess; }
  private async approved() { return (await readDataSharingConsent(this.directory, [this.id])).includes(this.id); }
  private async track<T>(task: Promise<T>) { this.pending.add(task); try { return await task; } finally { this.pending.delete(task); } }
  async available() {
    return this.track((async () => { try {
      if (this.shutdown.signal.aborted || !await this.approved()) return false;
      await ready(this.directory); await verifyClixadPublicModel({ ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal: this.shutdown.signal });
      return !this.shutdown.signal.aborted;
    } catch { return false; } })());
  }
  async healthCheck() { return this.available(); }
  complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> { return this.track(this.once(request, caller)); }
  private async once(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const timeout = this.options.timeout, signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.min(CLIXAD_TIMEOUT_MS, Math.ceil(timeout)) : CLIXAD_TIMEOUT_MS)]);
    let temporary: string | undefined;
    try {
      signal.throwIfAborted();
      if (request.imageInput) throw new SourceError('refused', 'Clixad supports text inputs through this route');
      if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1)) throw new SourceError('refused', 'Clixad requires a positive integer output-token budget');
      const limit = Math.min(4096, request.maxTokens ?? 4096), bridge = bridgeFor(request);
      if (!await this.approved()) throw new SourceError('refused', 'Clixad data sharing is not approved; rerun usegrunt setup');
      // This bounds returned output and observed usage only. The native CLI has
      // no hard upstream generation cap and can consume allowance before rejection.
      const prompt = `Your total output budget, including reasoning and the JSON envelope, is ${limit} tokens. Use no native tools, commands, files, web, MCP or subagents.\n`
        + bridge.prompt() + '\nThis request is transparently routed by Grunt using Clixad ask. Only the external caller executes the advertised functions.';
      if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw new SourceError('refused', 'Clixad prompt exceeds the supported input size');
      const paths = await ready(this.directory); signal.throwIfAborted();
      await verifyClixadPublicModel({ ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}), signal });
      await nativeAccess(paths, this.runner, signal);
      temporary = await mkdtemp(join(paths.work, 'request-')); await chmod(temporary, 0o700);
      const native = await abortable(this.runner(paths.entry, 'ask', { cwd: temporary, env: clixadEnvironment(), signal, input: prompt }), signal); nativeErrors(native);
      const dispatch = native.events.filter(event => event.event === 'dispatch'), metadata = native.events.filter(event => event.event === 'completion');
      if (native.events.filter(event => event.event === 'http' && event.operation === 'chat').length !== 1
        || native.events.some(event => !['dispatch', 'http', 'completion'].includes(event.event) || event.event === 'http' && event.operation !== 'chat')
        || dispatch.length !== 1 || metadata.length !== 1) {
        throw new SourceError('refused', 'Clixad returned incomplete native dispatch or completion metadata', undefined, undefined, { failureReason: 'completion_attestation' });
      }
      const observed = metadata[0]!;
      if (dispatch[0]!.model !== CLIXAD_MODEL || (observed.returnedModel !== undefined && observed.returnedModel !== CLIXAD_MODEL)) {
        throw new SourceError('refused', 'Clixad reported an unexpected model', undefined, undefined, { failureReason: 'completion_model' });
      }
      if (observed.free !== true || observed.creditsCharged !== 0 || observed.balance !== 0) {
        throw new SourceError('refused', 'Clixad could not verify a free completion with zero charge and balance', undefined, undefined, { failureReason: 'completion_billing' });
      }
      if (!Number.isSafeInteger(observed.inputTokens) || Number(observed.inputTokens) < 1 || !Number.isSafeInteger(observed.outputTokens)
        || Number(observed.outputTokens) < 1 || Number(observed.outputTokens) > limit) {
        throw new SourceError('refused', 'Clixad reported invalid or over-budget completion usage', undefined, undefined, { failureReason: 'completion_usage' });
      }
      wallet(await abortable(this.runner(paths.entry, 'wallet', { cwd: paths.work, env: clixadEnvironment(), signal }), signal), true);
      const match = native.stdout.match(/^assistant ([\s\S]*?)\n\s*\[0 credits · balance 0\]\s*$/);
      if (!match || Buffer.byteLength(match[1]!) > 65536) throw new SourceError('upstream', 'Clixad returned invalid native answer framing', undefined, undefined, { failureReason: 'completion_protocol' });
      try { return { ...bridge.parse(match[1]!), inputTokens: observed.inputTokens as number, outputTokens: observed.outputTokens as number }; }
      catch { throw new SourceError('upstream', 'Clixad JSON function protocol failed validation', undefined, undefined, { failureReason: 'completion_protocol' }); }
    } catch (error) {
      if (caller.aborted || this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Clixad request cancelled');
      if (signal.aborted) throw new SourceError('timeout', 'Clixad request timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Clixad request failed; rerun setup if native access needs repair');
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
