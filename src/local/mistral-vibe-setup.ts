import { spawn } from 'node:child_process';
import { access, chmod, lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { executable } from './multiplexer.js';
import {
  MISTRAL_VIBE_VERSION, mistralVibeEnvironment, mistralVibePaths,
  readMistralVibeFreePlanReceipt, writeMistralVibeFreePlanReceipt
} from './mistral-vibe.js';

export interface MistralVibeSignup {
  signup(service: string, url: string, instructions: string): Promise<void>;
}
export interface MistralVibeSetupOptions {
  directory: string;
  squire: MistralVibeSignup;
  signal?: AbortSignal;
  notify?(line: string): void;
}

// Pinned Vibe owns the PKCE exchange, account lookup and credential persistence.
// Its key never crosses stdout or enters the Node process. Only a pairing URL
// and an allow-listed success event leave this subprocess.
const nativeAuthentication = String.raw`
import asyncio, contextlib, json, logging, os, sys
os.umask(0o077)
logging.disable(logging.CRITICAL)
from pathlib import Path
from vibe.core.config import DEFAULT_PROVIDERS, build_default_orchestrator
from vibe.core.config.harness_files import init_harness_files_manager
from vibe.core.platform_auth import ApiKeyPlatformCredentialProvider
from vibe.setup.auth.api_key_persistence import persist_api_key
from vibe.setup.auth.browser_sign_in import BrowserSignInService
from vibe.setup.auth.http_browser_sign_in_gateway import HttpBrowserSignInGateway
from vibe.setup.auth.whoami import HttpAccountGateway
from vibe.utils.api_keys import resolve_api_key
from dotenv import load_dotenv

step = "start"

def at(name):
    global step
    step = name

def emit(event, **data):
    sys.stdout.write(json.dumps(dict(event=event, **data)) + "\n")
    sys.stdout.flush()

async def verify(key):
    at("account_lookup")
    account = await HttpAccountGateway().read(
        base_url="https://console.mistral.ai",
        credentials=ApiKeyPlatformCredentialProvider.from_api_key(key), timeout=15)
    at("free_plan_check")
    if account.plan_name.strip().upper() != "FREE" or account.has_paid_vibe_entitlement:
        raise RuntimeError("free_plan_required")

async def main():
    with contextlib.redirect_stdout(sys.stderr):
        if (Path(os.environ["VIBE_HOME"]) / ".env").is_symlink():
            raise RuntimeError("unsafe_native_credential_file")
        if sys.argv[1] == "check":
            at("read_saved_key")
            load_dotenv(Path(os.environ["VIBE_HOME"]) / ".env", override=False)
            key = resolve_api_key("MISTRAL_API_KEY")
            if not key:
                raise RuntimeError("native_login_required")
            await verify(key)
        else:
            service = BrowserSignInService(HttpBrowserSignInGateway(
                browser_base_url="https://console.mistral.ai",
                api_base_url="https://console.mistral.ai/api"))
            try:
                at("start_pairing")
                attempt = await service.start_attempt()
                # stdout is temporarily restored only for this safe event.
                with contextlib.redirect_stdout(sys.__stdout__):
                    emit("authorize", url=attempt.sign_in_url)
                at("complete_pairing")
                key = await service.complete_attempt(attempt)
                await verify(key)
                at("load_config")
                # Vibe 3.1 builds its config only after the harness files are set up;
                # user files only, so nothing from the working directory is read.
                init_harness_files_manager("user")
                orchestrator = await build_default_orchestrator()
                provider = next(p for p in DEFAULT_PROVIDERS if p.name == "mistral")
                at("save_key")
                outcome = persist_api_key(provider, key, orchestrator=orchestrator)
                if outcome != "completed":
                    raise RuntimeError("native_persistence_failed")
            finally:
                await service.aclose()
    emit("ready", plan="Free", hasPaidVibeEntitlement=False)

try:
    asyncio.run(main())
except BaseException as error:
    # Only the fixed step name and the exception class leave the process,
    # never the exception text, which can echo upstream responses.
    emit("failed", step=step, error=type(error).__name__)
    sys.exit(1)
`;

const nativeSteps = new Set(['start', 'read_saved_key', 'start_pairing', 'complete_pairing', 'account_lookup', 'free_plan_check', 'load_config', 'save_key']);

/** Kill only a subprocess group created by this module, including its children. */
function stop(child: ReturnType<typeof spawn>, force = false) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM');
    else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch { /* The owned process group has already exited. */ }
}
async function command(binary: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, cwd?: string) {
  signal?.throwIfAborted();
  const child = spawn(binary, args, { env, ...(cwd ? { cwd } : {}), stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  let output = '', exceeded = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (output.length + chunk.length > 65536) { exceeded = true; abort(); }
    else output += chunk.toString();
  });
  let force: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { stop(child); force ??= setTimeout(() => stop(child, true), 1000); force.unref(); };
  signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, 600000);
  if (signal?.aborted) abort();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('Mistral Vibe command could not start')));
      child.once('close', resolve);
    });
    signal?.throwIfAborted();
    if (code !== 0 || exceeded) throw new Error('Mistral Vibe command did not complete');
    return output;
  } finally {
    clearTimeout(deadline); if (force) clearTimeout(force);
    signal?.removeEventListener('abort', abort); stop(child, true);
  }
}

/** Install only under Grunt's private Mistral directory; never modify PATH or a global Python environment. */
export async function installMistralVibe(directory: string, signal?: AbortSignal) {
  const paths = mistralVibePaths(directory), env = mistralVibeEnvironment(directory);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await mkdir(paths.work, { recursive: true, mode: 0o700 });
  try {
    const version = await command(paths.binary, ['--version'], env, signal, paths.work);
    await access(paths.python, constants.X_OK);
    if (new RegExp(`(?:^|\\s)v?${MISTRAL_VIBE_VERSION.replaceAll('.', '\\.')}\\s*$`).test(version.trim())) return paths;
  } catch { signal?.throwIfAborted(); }
  let uv: string | undefined;
  try { uv = await executable('uv'); } catch { /* A managed venv is the fallback. */ }
  if (uv) {
    await command(uv, ['tool', 'install', '--no-config', '--force', `mistral-vibe==${MISTRAL_VIBE_VERSION}`], {
      ...env, UV_TOOL_DIR: join(paths.home, 'tools'), UV_TOOL_BIN_DIR: dirname(paths.binary),
      UV_CACHE_DIR: join(paths.home, 'cache'), UV_PYTHON_INSTALL_DIR: join(paths.home, 'python')
    }, signal, paths.work);
  } else {
    let python: string;
    try { python = await executable('python3'); }
    catch { throw new Error('Mistral Vibe needs uv or Python 3.12+. Install either, then rerun usegrunt setup.'); }
    const version = await command(python, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], env, signal, paths.work);
    const [major, minor] = version.trim().split('.').map(Number);
    if (major !== 3 || !minor || minor < 12) throw new Error('Mistral Vibe needs uv or Python 3.12+. Install either, then rerun usegrunt setup.');
    const environment = dirname(dirname(paths.python));
    await command(python, ['-I', '-m', 'venv', environment], env, signal, paths.work);
    await command(paths.python, ['-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', `mistral-vibe==${MISTRAL_VIBE_VERSION}`], env, signal, paths.work);
    await mkdir(dirname(paths.binary), { recursive: true, mode: 0o700 });
    try { await symlink(join(dirname(paths.python), 'vibe'), paths.binary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const version = await command(paths.binary, ['--version'], env, signal, paths.work);
  if (!new RegExp(`(?:^|\\s)v?${MISTRAL_VIBE_VERSION.replaceAll('.', '\\.')}\\s*$`).test(version.trim())) throw new Error('Mistral Vibe installation did not provide the pinned CLI version');
  await access(paths.python, constants.X_OK);
  return paths;
}

async function awaitBrowser<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await promise;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { signal.throwIfAborted(); return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function nativeLogin(options: MistralVibeSetupOptions, mode: 'check' | 'login') {
  const paths = mistralVibePaths(options.directory), env = mistralVibeEnvironment(options.directory);
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  signal.throwIfAborted();
  const child = spawn(paths.python, ['-I', '-c', nativeAuthentication, mode], {
    cwd: paths.work, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore']
  });
  let buffer = '', ready = false, paired = false, failure: Error | undefined;
  let pairing: Promise<void> | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { stop(child); force ??= setTimeout(() => stop(child, true), 1000); force.unref(); };
  signal.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => lifetime.abort(new Error('Mistral Vibe sign-in timed out; rerun usegrunt setup to resume')), 600000);
  const protocolFailure = () => { failure = new Error('Mistral Vibe native sign-in did not complete'); abort(); };
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    if (buffer.length > 32768) { protocolFailure(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { protocolFailure(); return; }
      if (event.event === 'authorize' && mode === 'login' && !paired) {
        let url: URL;
        try { url = new URL(String(event.url)); } catch { protocolFailure(); return; }
        if (url.origin !== 'https://console.mistral.ai' || url.pathname !== '/codestral/cli/authenticate' || url.username || url.password || url.hash) { protocolFailure(); return; }
        paired = true;
        pairing = options.squire.signup('mistral-vibe', url.href,
          'Finish the Mistral Vibe CLI browser pairing started by this setup process, using the same Free account. Authorize only this pairing. Do not create a general API key or enable API or Vibe Code pay-as-you-go. No paid plan, card, credits, account switching or extra account. Stop if the account is paid or signup is refused. Report human verification for browser handoff; do not bypass it. Never reveal, copy or store the native CLI key: the CLI owns its credential exchange.');
        void pairing.catch(() => { failure = new Error('Mistral Vibe browser pairing did not complete; rerun usegrunt setup to resume'); abort(); });
      } else if (event.event === 'ready' && event.plan === 'Free' && event.hasPaidVibeEntitlement === false) ready = true;
      else if (event.event === 'failed' && typeof event.step === 'string' && nativeSteps.has(event.step)) {
        const kind = typeof event.error === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(event.error) ? ` (${event.error})` : '';
        failure = new Error(`Mistral Vibe native ${mode === 'check' ? 'check' : 'sign-in'} failed at ${event.step}${kind}`);
        options.notify?.(`Mistral Vibe: native ${mode === 'check' ? 'check' : 'sign-in'} failed at ${event.step}${kind}`);
      } else { protocolFailure(); return; }
    }
  });
  if (signal.aborted) abort();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('Mistral Vibe native sign-in could not start')));
      child.once('close', resolve);
    });
    signal.throwIfAborted();
    if (failure || code !== 0 || !ready || (mode === 'login' && !paired)) throw failure ?? new Error('Mistral Vibe native Free account could not be verified');
    try { if (pairing) await awaitBrowser(pairing, signal); }
    catch { signal.throwIfAborted(); throw failure ?? new Error('Mistral Vibe browser pairing did not complete; rerun usegrunt setup to resume'); }
  } finally {
    clearTimeout(deadline); if (force) clearTimeout(force);
    signal.removeEventListener('abort', abort); stop(child, true);
  }
}

/** Verify a card-free Free account in Squire, then let the native CLI own login. */
export async function setupMistralVibe(options: MistralVibeSetupOptions) {
  const paths = await installMistralVibe(options.directory, options.signal);
  try {
    await readMistralVibeFreePlanReceipt(options.directory);
    const credential = await lstat(join(paths.home, '.env'));
    if (!credential.isFile() || (credential.mode & 0o077) !== 0) throw new Error('Native login needs repair');
    await nativeLogin(options, 'check');
    return;
  } catch {
    // A failed native identity check revokes the saved eligibility immediately.
    // A later browser refusal must not leave an old Free receipt usable.
    await rm(paths.receipt, { force: true });
    options.signal?.throwIfAborted();
  }
  options.notify?.('Mistral Vibe: signing in and pairing the native CLI');
  try {
    await awaitBrowser(options.squire.signup('mistral-vibe', 'https://console.mistral.ai',
      "Sign in to the user's existing Mistral account, or use normal Google sign-up for a Free account. Finish as soon as you are signed in; do not open subscription or billing pages to audit the plan. Never enable API or Vibe Code pay-as-you-go. Do not downgrade, remove a card, switch account, create another identity, subscribe, top up or enable billing. Optional marketing remains off. Required unrelated consent, refusal, CAPTCHA, phone, email or passkey verification needs human handoff; do not bypass it. Do not create or reveal a general API key. A separate native CLI pairing will follow."), options.signal);
  } catch { options.signal?.throwIfAborted(); throw new Error('Mistral Vibe Free account verification did not complete; rerun usegrunt setup to resume'); }
  await nativeLogin(options, 'login');
  await writeMistralVibeFreePlanReceipt(options.directory, {
    version: 1, plan: 'Free', payAsYouGo: false, paymentMethodPresent: false,
    purchasedCredits: 0, checkedAt: new Date().toISOString()
  });
  options.notify?.('Mistral Vibe: Free native CLI login connected; GLM-5.3 Flash is ready');
}
