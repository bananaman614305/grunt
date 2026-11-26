import { hasOwnerMode } from './private-file.js';
import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, lstat, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { configRoot, gruntEnv } from '../brand.js';
import { readDataSharingConsent } from './data-sharing.js';
import { diagnosticFetch } from './diagnostics.js';
import { FREE_API_PROVIDERS, FreeApi } from './free-api.js';
import { SourceError } from './source.js';
import type { FreeApiGrant } from './free-api.js';
import type { ModelRequest, Source } from './source.js';

const origin = 'https://inference-api.nousresearch.com';
export const NOUS_FREE_MODEL = FREE_API_PROVIDERS.nous.model;
const completionURL = `${origin}/v1/chat/completions`;
const authFilename = 'auth.json';
const bridgeLimit = 10 * 1024 * 1024;
export const nousFreeAccountPolicy = String.raw`
def zero(value):
    return type(value) in (int, float) and value == 0

def free_account(payload):
    access = payload.get("paid_service_access")
    if not isinstance(access, dict):
        return False
    if any(access.get(key) is not False for key in ("allowed", "paid_access", "active_subscription_is_paid")):
        return False
    if not zero(payload.get("purchased_credits_remaining")):
        return False
    if any(not zero(access.get(key)) for key in ("subscription_credits_remaining", "purchased_credits_remaining", "total_usable_credits")):
        return False
    if access.get("subscription_monthly_charge") is not None and not zero(access["subscription_monthly_charge"]):
        return False
    subscription = payload.get("subscription")
    if subscription is None:
        return access.get("has_active_subscription") is False
    return (isinstance(subscription, dict)
            and str(subscription.get("plan", "")).strip().lower() == "free"
            and all(subscription.get(key) is None or zero(subscription[key])
                    for key in ("monthly_charge", "monthly_credits", "credits_remaining", "rollover_credits")))
`;
const hermesBridge = String.raw`
import asyncio
import contextlib
import json
import logging
import os
import re
import sys

os.umask(0o077)
logging.disable(logging.CRITICAL)
real_stdout = sys.stdout
stream_started = False
body_limit = ${bridgeLimit}

${nousFreeAccountPolicy}

portal = "https://portal.nousresearch.com"
reset_headers = ("x-ratelimit-reset-requests-1h", "x-ratelimit-reset-requests")
reset_fields = ("resets_in_seconds", "resets_at", "reset_at", "retry_after")

def quota_fields(value):
    if not isinstance(value, dict):
        return {}
    def numeric_or_iso(val):
        return (type(val) in (int, float) and 0 <= val <= 1e12) or (isinstance(val, str) and re.fullmatch(r"[0-9.TZ:+-]{1,64}", val))
    return {key: value[key] for key in reset_fields if key in value and numeric_or_iso(value[key])}

async def read_quota(response):
    body = bytearray()
    async for chunk in response.content.iter_chunked(8192):
        body.extend(chunk)
        if len(body) > 8192:
            return {}
    try:
        value = json.loads(body)
        if isinstance(value, dict):
            return {**quota_fields(value), "error": quota_fields(value.get("error"))}
    except (ValueError, UnicodeError):
        pass
    return {}

def has_expected_portal():
    state = get_provider_auth_state("nous") or {}
    return str(state.get("portal_base_url", "")).rstrip("/") == portal

async def verify_account():
    if not has_expected_portal():
        return False
    bearer = resolve_nous_access_token(timeout_seconds=10)
    if not bearer or not has_expected_portal():
        return False
    async with ClientSession(timeout=ClientTimeout(total=8)) as client:
        async with client.get(portal + "/api/oauth/account",
                              headers={"Authorization": "Bearer " + bearer, "Accept": "application/json"},
                              allow_redirects=False) as response:
            return response.status == 200 and free_account(await response.json())

def write_result(result):
    print(json.dumps(result), file=real_stdout, flush=True)

async def write_stream(response, result):
    global stream_started
    stream_started = True
    write_result({**result, "stream": True})
    size = 0
    async for chunk in response.content.iter_chunked(65536):
        size += len(chunk)
        if size > body_limit:
            raise ValueError("Oversized SSE body")
        real_stdout.buffer.write(chunk)
        real_stdout.buffer.flush()

async def request():
    mode = sys.argv[1]
    if not await verify_account():
        return {"status": 403}
    if mode == "check":
        return {"status": 200}
    data = sys.stdin.buffer.read(body_limit + 1)
    if len(data) > body_limit:
        return {"status": 413}
    payload = json.loads(data)
    if payload.get("model") != ${JSON.stringify(NOUS_FREE_MODEL)} or type(payload.get("stream")) is not bool:
        return {"status": 403}
    path = sys.argv[2]
    runner = web.AppRunner(create_app(NousPortalAdapter()), access_log=None)
    await runner.setup()
    try:
        await web.UnixSite(runner, path).start()
        async with ClientSession(connector=UnixConnector(path=path), timeout=ClientTimeout(total=150)) as client:
            async with client.post("http://localhost/v1/chat/completions", data=data,
                                   headers={"Content-Type": "application/json"}, allow_redirects=False) as response:
                result = {"status": response.status}
                retry = response.headers.get("Retry-After")
                if retry:
                    result["retryAfter"] = retry
                if response.status == 429:
                    result["resets"] = {name: response.headers[name] for name in reset_headers
                                        if re.fullmatch(r"[0-9.]{1,32}", response.headers.get(name, ""))}
                    try:
                        result["body"] = await asyncio.wait_for(read_quota(response), timeout=1)
                    except asyncio.TimeoutError:
                        pass
                if response.ok and response.content_type == "text/event-stream":
                    await write_stream(response, result)
                    return
                if response.ok:
                    body = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        body.extend(chunk)
                        if len(body) > body_limit:
                            return {"status": 502}
                    result["body"] = json.loads(body)
                return result
    finally:
        await runner.cleanup()

try:
    with contextlib.redirect_stdout(sys.stderr):
        from aiohttp import ClientSession, ClientTimeout, UnixConnector, web
        from hermes_cli.auth import get_provider_auth_state, resolve_nous_access_token
        from hermes_cli.proxy.adapters.nous_portal import NousPortalAdapter
        from hermes_cli.proxy.server import create_app

        result = asyncio.run(request())
    if result is not None:
        write_result(result)
except Exception:
    if stream_started:
        sys.exit(1)
    write_result({"status": 502})
`;

export function nousHermesPaths(directory: string, env = process.env) {
  const local = join(directory, 'nous-client');
  const installed = join(homedir(), '.hermes', 'hermes-agent');
  const root = gruntEnv('HERMES_ROOT', env) ?? (existsSync(local) || !existsSync(join(installed, 'hermes')) ? local : installed);
  if (!isAbsolute(root)) throw new Error('Hermes installation path must be absolute');
  const home = join(directory, 'nous-hermes');
  return {
    root, home, entry: join(root, 'hermes'), python: join(root, 'venv', 'bin', 'python'),
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONUNBUFFERED: '1',
      HERMES_HOME: home, HERMES_SHARED_AUTH_DIR: join(home, 'shared'),
      HERMES_PORTAL_BASE_URL: 'https://portal.nousresearch.com', NOUS_INFERENCE_BASE_URL: `${origin}/v1`
    }
  };
}

export async function hasNousProfile(directory: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const paths = nousHermesPaths(directory, env);
    await access(paths.python, constants.X_OK);
    const home = await lstat(paths.home);
    const auth = await lstat(join(paths.home, authFilename));
    return home.isDirectory() && hasOwnerMode(home, 0o700)
      && auth.isFile() && hasOwnerMode(auth, 0o600);
  } catch { return false; }
}

async function makeHermesSocketDirectory() {
  const prefix = '/tmp/grunt-nous-';
  try { return await mkdtemp(prefix); }
  catch (error) {
    const fallback = join(tmpdir(), 'grunt-nous-');
    // macOS allows 103 bytes before the terminating NUL, including the generated suffix and socket name.
    if (fallback === prefix || !isAbsolute(fallback) || Buffer.byteLength(join(`${fallback}XXXXXX`, 'proxy')) > 103) throw error;
    return mkdtemp(fallback);
  }
}

async function hermesRequest(directory: string, mode: 'check' | 'complete', signal: AbortSignal, env?: NodeJS.ProcessEnv, body?: string): Promise<Response> {
  signal.throwIfAborted();
  const paths = nousHermesPaths(directory, env);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(mode === 'check' ? 20_000 : 165_000)]);
  const socketDirectory = mode === 'complete' ? await makeHermesSocketDirectory() : undefined;
  // The parent owns the socket directory so it can remove it even after killing Hermes.
  const release = async () => { if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true }).catch(() => {}); };
  let stop = release;
  const invalid = () => new Error('Hermes subscription proxy returned an invalid response');
  try {
    deadline.throwIfAborted();
    const args = ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(paths.root)})\n${hermesBridge}`, mode];
    if (socketDirectory) args.push(join(socketDirectory, 'proxy'));
    const child = spawn(paths.python, args, {
      cwd: paths.root, env: paths.env, signal: deadline, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore']
    });
    // Spawn reports cancellation through 'error' and still emits 'close'.
    child.on('error', () => {});
    const closed = new Promise<number | null>(resolve => { child.once('close', resolve); }).finally(release);
    stop = async () => { child.kill('SIGKILL'); child.stdout.destroy(); await closed; };
    child.stdin.on('error', () => { /* The child may exit before consuming the request. */ });
    child.stdin.end(body);

    const stdout: AsyncIterator<Buffer> = child.stdout[Symbol.asyncIterator]();
    const read = async () => {
      deadline.throwIfAborted();
      const next = await stdout.next();
      deadline.throwIfAborted();
      if (!next.done) return next.value;
      if (await closed !== 0) throw new Error('Hermes subscription proxy failed');
    };
    const header: Buffer[] = [];
    let headerBytes = 0;
    for (let chunk; (chunk = await read());) {
      const boundary = chunk.indexOf(10);
      const part = boundary === -1 ? chunk : chunk.subarray(0, boundary);
      headerBytes += part.length;
      if (headerBytes > bridgeLimit) throw invalid();
      header.push(part);
      if (boundary === -1) continue;
      const result: { status: number; body?: unknown; retryAfter?: string; resets?: Record<string, string>; stream?: boolean } =
        JSON.parse(Buffer.concat(header, headerBytes).toString('utf8'));
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw invalid();
      const headers = new Headers(result.resets);
      if (result.retryAfter) headers.set('Retry-After', result.retryAfter);
      const response = { status: result.status, headers };
      const rest = chunk.subarray(boundary + 1);
      if (result.stream !== true) {
        if (rest.length || await read()) throw invalid();
        return result.body === undefined ? new Response(null, response) : Response.json(result.body, response);
      }
      if (mode !== 'complete' || result.status >= 300) throw invalid();
      headers.set('content-type', 'text/event-stream');
      let pending = rest.length ? rest : undefined;
      let bodyBytes = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            deadline.throwIfAborted();
            const bytes = pending ?? await read();
            pending = undefined;
            if (!bytes) { controller.close(); return; }
            bodyBytes += bytes.length;
            if (bodyBytes > bridgeLimit) throw invalid();
            controller.enqueue(bytes);
          } catch (error) { controller.error(error); await stop(); }
        },
        cancel: stop
      });
      return new Response(stream, response);
    }
    throw invalid();
  } catch (error) { await stop(); throw error; }
}

export async function checkNousProfile(directory: string, signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (!await hasNousProfile(directory, env)) return false;
  try { return (await hermesRequest(directory, 'check', signal, env)).ok; }
  catch { signal.throwIfAborted(); return false; }
}

type CatalogModel = {
  id?: unknown;
  context_length?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
};

function isZero(value: unknown): boolean {
  return value === 0 || (typeof value === 'string' && /^0(?:\.0+)?$/.test(value));
}

function isFreeModel(model: CatalogModel): boolean {
  const pricing = model.pricing;
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return false;
  const fields = pricing as Record<string, unknown>;
  return isZero(fields.prompt) && isZero(fields.completion) && Object.values(fields).every(isZero)
    && typeof model.context_length === 'number' && Number.isSafeInteger(model.context_length) && model.context_length >= 200_000
    && Array.isArray(model.supported_parameters) && model.supported_parameters.includes('tools');
}

export class Nous implements Source {
  readonly inferenceOnly = true;
  readonly reportsOutput = true;
  readonly reportsProgress = true;
  readonly id = 'nous';
  readonly supportsFunctionTools = true;
  private readonly shutdown = new AbortController();
  private readonly source: FreeApi;

  private readonly directory: string;
  constructor(private readonly options: { directory?: string; env?: NodeJS.ProcessEnv; loadGrant?: () => Promise<FreeApiGrant>; fetcher?: typeof fetch } = {}) {
    this.directory = options.directory ?? configRoot(options.env);
    this.source = new FreeApi('nous', {
      loadGrant: () => this.grant(),
      fetcher: options.fetcher ?? (async (input, init) => {
        if (String(input) !== completionURL || init?.method !== 'POST' || typeof init.body !== 'string' || !init.signal) {
          throw new Error('Unexpected Nous completion transport request');
        }
        return hermesRequest(this.directory, 'complete', init.signal, this.options.env, init.body);
      })
    });
    if (options.loadGrant && !options.fetcher) throw new Error('A test grant requires an injected transport');
  }

  private async approved(): Promise<boolean> {
    return (await readDataSharingConsent(this.directory, [this.id])).includes(this.id);
  }

  private async grant(): Promise<FreeApiGrant> {
    if (this.options.loadGrant) {
      const grant = await this.options.loadGrant();
      if (grant.base_url !== origin || !grant.token.trim()) throw new Error('Nous Portal access unavailable');
      return grant;
    }
    if (!await hasNousProfile(this.directory, this.options.env)) throw new Error('Nous Portal access unavailable');
    // Only FreeApi's request envelope requires a token. The local transport
    // discards Node's headers; Hermes owns and refreshes the real OAuth bearer.
    return { base_url: origin, token: 'hermes-managed' };
  }

  private async checkCatalog(caller: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(5000)]);
    try {
      const read = diagnosticFetch(this.options.fetcher ?? fetch, this.id, 'models');
      const response = await read(`${origin}/v1/models`, { redirect: 'error', cache: 'no-store', signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Nous catalog unavailable');
      }
      const catalog: { data?: CatalogModel[] } | null = await response.json();
      signal.throwIfAborted();
      const candidates = Array.isArray(catalog?.data) ? catalog.data.filter(model => model?.id === NOUS_FREE_MODEL) : [];
      const [candidate] = candidates;
      if (candidates.length !== 1 || !candidate || !isFreeModel(candidate)) {
        throw new SourceError('refused', 'Nous no longer lists the required model with free pricing, context and tool support');
      }
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Nous catalog check closed');
      if (error instanceof SourceError) throw error;
      throw new SourceError(signal.aborted ? 'timeout' : 'upstream', 'Nous could not verify current free model pricing');
    }
  }

  async available(): Promise<boolean> {
    return await this.approved() && await this.source.available();
  }

  async healthCheck(signal = this.shutdown.signal): Promise<boolean> {
    if (!await this.available()) return false;
    try {
      await this.checkCatalog(signal);
      return this.options.loadGrant ? true : await checkNousProfile(this.directory, signal, this.options.env);
    } catch { return false; }
  }

  async complete(request: ModelRequest, signal: AbortSignal, output?: () => void) {
    signal.throwIfAborted();
    if (!await this.approved()) throw new SourceError('refused', 'Nous data sharing is not approved');
    await this.checkCatalog(signal);
    return this.source.complete({ ...request, model: this.id }, signal, output);
  }

  async close() {
    this.shutdown.abort();
    await this.source.close();
  }
}
