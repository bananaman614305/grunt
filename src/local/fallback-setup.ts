import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapKilo, BrowserSquire, setup } from './setup.js';
import type { SetupSquire } from './setup.js';
import type { SignupAgent } from './signup-mcp.js';
import { parallelMap, SETUP_CONCURRENCY } from './parallel.js';
import { disabledAdapters } from '../registry.js';
import type { Registry } from '../registry.js';
import { OpenCode } from './opencode.js';
import { DOCTOR_TIMEOUT_MS } from './freebuff.js';
import { SourceError, Sources } from './source.js';
import { DATA_SHARING_POLICIES, readDataSharingConsent, requiresDataSharing, requiresExplicitDataSharing } from './data-sharing.js';
import type { Source } from './source.js';
import { setupFailureReason } from './setup-failure.js';

const exec = promisify(execFile);
class FreebuffCompatibilityError extends Error {}
export type Signup = Pick<BrowserSquire, 'signup' | 'credentials'>;
// The CLI keeps the local login exchange alive while Squire completes its URL.
export async function loginFreebuff(squire: Signup, signal?: AbortSignal) {
  const child = spawn('freebuff', ['login'], { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
  let output = '', started = false;
  let browser: Promise<void> | undefined;
  let rejectLogin: (error: Error) => void = () => {};
  const exited = new Promise<void>((resolve, reject) => {
    rejectLogin = reject;
    child.once('error', () => reject(new Error('Freebuff login could not start')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Freebuff login did not complete')));
  });
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-16384);
    const url = output.match(/https:\/\/freebuff\.com\/login\?[^\s\x1b]+/)?.[0];
    if (started || !url) return;
    started = true;
    browser = squire.signup('freebuff', url, "Complete this Freebuff CLI login using the user's existing account, or sign up if none exists. This URL pairs the local CLI; finish that pairing. No paid plan, payment method, extra account or account switching. Stop on refusal; stop on captcha, passkey or email verification. Do not bypass verification.");
    void browser.catch(() => rejectLogin(new Error('Freebuff browser signup did not complete; rerun setup to resume')));
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => rejectLogin(new Error('Freebuff login timed out; rerun setup to resume')), 600000);
  try {
    await exited;
    if (!started) throw new Error('Freebuff did not provide a browser login URL');
    await browser;
  } finally { clearTimeout(timer); child.kill(); }
}
export async function freebuffSignedIn() {
  const { stdout } = await exec('freebuff', ['doctor'], { timeout: DOCTOR_TIMEOUT_MS, maxBuffer: 65536 });
  if (/not signed in|logged.?out|login required/i.test(stdout)) return false;
  if (!/Freebuff doctor/i.test(stdout)) throw new Error('Unrecognized Freebuff diagnostics; run freebuff doctor');
  return true;
}
export async function verifyOpenCode(source: Source = new OpenCode(), signal = AbortSignal.timeout(120000)) {
  const sources = new Sources([source]);
  try {
    await sources.complete({ model: 'opencode', cwd: process.cwd(), messages: [{ role: 'user', content: 'Reply only: grunt is ready. Do not use tools or change files.' }], tools: [], stream: false }, signal);
  } finally { await sources.close(); }
}
export async function setupFallbacks(options: {
  directory: string;
  run(binary: string, args: string[], interactive?: boolean): Promise<void>;
  notify(line: string): void;
  squire?: Signup & Partial<Pick<SetupSquire, 'runs'>>;
  setupProvider?: typeof setup;
  signedIn?: () => Promise<boolean>;
  login?: (squire: Signup) => Promise<void>;
  verify?: () => Promise<void>;
  adapters?: string[];
  connect?: () => Promise<void>;
  signal?: AbortSignal;
  background?: boolean;
  acquire?: boolean;
  kiloAccount?: boolean;
  dataSharingApproved?: readonly string[];
  // The synced registry; signup hints follow it.
  registry?: () => Registry;
  signedUp?: (id: string, ok: boolean) => void;
  onSettled?: (id: string, available: boolean, reason?: string) => void | Promise<void>;
  onStarted?: (id: string) => void;
  // Fallback operator for an owned background browser (the router's driver).
  agent?: SignupAgent;
}) {
  const squire = options.squire ?? new BrowserSquire({ ...(options.signedUp ? { signedUp: options.signedUp } : {}), ...(options.signal ? { signal: options.signal } : {}), background: options.background, dataSharingApproved: options.dataSharingApproved ?? [], ...(options.agent ? { agent: options.agent } : {}), ...(options.registry ? { registry: options.registry } : {}) });
  if (options.registry && options.squire instanceof BrowserSquire) options.squire.useRegistry(options.registry);
  const owned = squire instanceof BrowserSquire && !options.squire;
  const reuseOnly = options.background === true && options.acquire !== true;
  const requested = [...new Set(options.adapters ?? ['opencode'])];
  // A registry may list account-based providers first. Keep their shared
  // browser login from occupying every worker before anonymous routes start.
  const anonymous = ['kilo', 'opencode', 'reflection-beam'];
  const execution = [...anonymous.filter(id => requested.includes(id)), ...requested.filter(id => !anonymous.includes(id))];
  const unavailable = requested.filter(id => disabledAdapters.has(id));
  for (const id of unavailable) options.notify(`${id}: routing is disabled; other free services continue`);
  const approved = [...new Set([...(options.dataSharingApproved ?? []).filter(id => !requiresExplicitDataSharing(id)),
    ...await readDataSharingConsent(options.directory, DATA_SHARING_POLICIES.map(policy => policy.provider))])];
  if (squire instanceof BrowserSquire) squire.approveDataSharing(approved);
  // Reuse a grant created by an earlier setup before probing the free model.
  const savedConfig = join(options.directory, 'opencode-free.json');
  try { await access(savedConfig); process.env.OPENCODE_CONFIG = savedConfig; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let connection: Promise<void> | undefined;
  const connect = () => connection ??= (async () => { if (options.connect) await options.connect(); else if (owned) await (squire as BrowserSquire).connect(); })();
  const install = async (binary: string, pkg: string) => {
    try { await options.run(binary, ['--version']); }
    catch { await options.run('npm', ['install', '--global', pkg]); }
  };
  const settled = new Set<string>(), callbacks: Promise<void>[] = [], callbackFailures: unknown[] = [];
  const failures = new Map<string, string>();
  const failedSetup = (id: string, error: unknown) => {
    unavailable.push(id);
    const reason = (squire instanceof BrowserSquire ? squire.signupFailure(id) : undefined) ?? setupFailureReason(error);
    failures.set(id, reason);
    if (process.env.GRUNT_SETUP_DEBUG === '1') {
      const detail = squire instanceof BrowserSquire ? squire.signupFailureDetail(id) : undefined;
      console.error(`grunt setup: ${id}: ${reason}${detail ? ` (squire ${detail})` : ''}`);
    }
  };
  const onSettled = (id: string, available: boolean) => {
    if (!options.onSettled || settled.has(id)) return;
    settled.add(id);
    // Observers may verify the daemon or configure coding tools. Start that
    // work immediately without holding a provider worker or rejecting early.
    callbacks.push(Promise.resolve().then(() => options.onSettled!(id, available && !options.signal?.aborted, failures.get(id)))
      .catch(error => { callbackFailures.push(error); }));
  };
  options.notify('Free routes run their own tools with your filesystem permissions in the working directory. Free model providers may retain prompts.');
  try {
    const tasks: Record<string, () => Promise<void>> = {
      freebuff: async () => { try {
        await install('freebuff', 'freebuff');
        // Older CLIs accept --version but cannot run the login diagnostic.
        try { await options.run('freebuff', ['doctor']); }
        catch {
          options.notify('Freebuff: repairing the installed CLI before checking sign-in');
          try {
            await options.run('npm', ['install', '--global', 'freebuff@latest']);
            await options.run('freebuff', ['doctor']);
          } catch {
            throw new FreebuffCompatibilityError('Freebuff CLI repair incomplete. The active freebuff on PATH must support doctor. Run npm install --global freebuff@latest, remove older Freebuff binaries earlier on PATH, then rerun usegrunt setup. Continuing with OpenCode.');
          }
        }
        try { await options.run('tmux', ['-V']); }
        catch {
          if (process.platform === 'darwin') await options.run('brew', ['install', 'tmux'], true);
          else {
            let manager: string | undefined;
            for (const candidate of ['apt-get', 'dnf']) {
              try { await options.run(candidate, ['--version']); manager = candidate; break; } catch { /* Try the next supported OS package manager. */ }
            }
            if (!manager) throw new Error('Install tmux with your OS package manager');
            const args = ['install', '-y', 'tmux'];
            await options.run(process.getuid?.() === 0 ? manager : 'sudo', process.getuid?.() === 0 ? args : [manager, ...args], true);
          }
        }
        const signedIn = options.signedIn ?? freebuffSignedIn;
        if (!await signedIn()) { await connect(); if (options.login) await options.login(squire); else await loginFreebuff(squire, options.signal); }
        if (!await signedIn()) throw new Error('Freebuff is still signed out; rerun setup to resume');
        options.notify('Freebuff: signed in; grunt will start its loopback bridge with the background service');
      } catch (error) {
        failedSetup('freebuff', error);
        if (error instanceof FreebuffCompatibilityError) options.notify(error.message);
        else options.notify('Freebuff setup incomplete. Run freebuff doctor, install tmux if missing, then rerun usegrunt setup. Continuing with OpenCode.');
      } },
      opencode: async () => { try {
        await install('opencode', 'opencode-ai');
        const verify = options.verify ?? (() => verifyOpenCode(new OpenCode(), options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)));
        try { await verify(); }
        catch (error) {
          if (!(error instanceof SourceError) || error.code !== 'logged_out') throw error;
          await connect();
          const findCredential = async () => (await squire.credentials.list()).find(c => c.service?.trim().toLowerCase() === 'opencode'
            && c.auth_strategy !== 'username_password' && c.field_names.some(field => /^(?:api_?key|token|key)$/i.test(field)));
          let credential = await findCredential();
          if (!credential) {
            await squire.signup('opencode', 'https://opencode.ai/auth', "Use the user's existing OpenCode account or sign up for free access. Use operate_extract to store an OpenCode Zen API key directly in this user's Squire vault under service opencode. Never include its value in your answer. No payment, paid plans, extra accounts or account switching. Stop if free access requires payment. Report human verification for browser handoff; do not bypass it.");
            credential = await findCredential();
          }
          if (!credential) throw new Error('No OpenCode access was created');
          const grant = await squire.credentials.grant(credential.reference);
          const path = join(options.directory, 'opencode-free.json');
          await mkdir(options.directory, { recursive: true, mode: 0o700 });
          await writeFile(path, JSON.stringify({ provider: { opencode: { options: { baseURL: grant.base_url.replace(/\/$/, '') + '/zen/v1', apiKey: grant.token } } } }), { mode: 0o600 });
          process.env.OPENCODE_CONFIG = path;
          await verify();
        }
        options.notify('OpenCode: free model answered');
      } catch (error) {
        failedSetup('opencode', error);
        options.notify('OpenCode free model check failed or signup was refused. Rerun usegrunt setup after repairing OpenCode; other routes remain available.');
      } },
      'antseed-vikey': async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['antseed-vikey'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Antseed Vikey: private zero-price buyer connected; functional verification remains required');
      } catch (error) {
        failedSetup('antseed-vikey', error);
        options.notify('Antseed Vikey setup unavailable on this platform or buyer configuration; other routes remain available.');
      } },
      millionseek: async () => { try {
        if (!reuseOnly) await connect();
        await (options.setupProvider ?? setup)(options.notify, ['millionseek'], { squire: squire as SetupSquire, directory: options.directory,
          background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('100milionseek: recurring free DeepSeek access connected');
      } catch (error) {
        failedSetup('millionseek', error);
        options.notify('100milionseek setup needs attention; other free sources continue.');
      } },
      freepi: async () => { try {
        if (!reuseOnly) await connect();
        await (options.setupProvider ?? setup)(options.notify, ['freepi'], { squire: squire as SetupSquire, directory: options.directory,
          background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Free-Pi: public-project free access connected under the approved data terms');
      } catch (error) {
        failedSetup('freepi', error);
        options.notify('Free-Pi setup needs attention; other free sources continue.');
      } },
      'reflection-beam': async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['reflection-beam'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Reflection Beam: anonymous free access verified');
      } catch (error) {
        failedSetup('reflection-beam', error);
        options.notify('Reflection Beam free check failed; other routes remain available.');
      } },
      kilo: async () => { try {
        if (options.kiloAccount) {
          await connect();
          await bootstrapKilo(squire as SetupSquire, options.directory, options.notify);
          return;
        }
        await (options.setupProvider ?? setup)(options.notify, ['kilo'], { squire: squire as SetupSquire, directory: options.directory, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Kilo: free model access verified without signup');
      } catch (error) {
        failedSetup('kilo', error);
        options.notify('Kilo setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      zro: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['zro'], { squire: squire as SetupSquire, directory: options.directory, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Zro: daily free DeepSeek V4.1 Flash access connected through Squire');
      } catch (error) {
        failedSetup('zro', error);
        options.notify('Zro setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      'aperture-ai': async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['aperture-ai'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('aperture-ai', error);
        options.notify('Aperture Free setup is pending. Other routes remain available.');
      } },
      darus: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['darus'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('darus', error);
        options.notify('Darus protected free setup is pending. Other routes remain available.');
      } },
      fikra: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['fikra'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('fikra', error);
        options.notify('fikra: temporary free setup pending; other routes remain available.');
      } },
      openference: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['openference'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('openference', error);
        options.notify('openference: temporary free setup pending; other routes remain available.');
      } },
      crowllm: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['crowllm'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('crowllm', error);
        options.notify('CrowLLM free setup is pending. Other routes remain available.');
      } },
      goedel: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['goedel'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('goedel', error);
        options.notify('Gödel free setup is pending. Other routes remain available.');
      } },
      numes: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['numes'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('numes', error);
        options.notify('Numes free setup is pending. Other routes remain available.');
      } },
      kenari: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['kenari'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        failedSetup('kenari', error);
        options.notify('Kenari free setup is pending. Other routes remain available.');
      } },
      tokenharbor: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['tokenharbor'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Token Harbor: approved free DeepSeek V4.1 Flash access connected through Squire');
      } catch (error) {
        failedSetup('tokenharbor', error);
        options.notify('Token Harbor setup incomplete or data sharing not approved. Run usegrunt setup to finish; other routes remain available.');
      } },
      runcrate: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['runcrate'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Runcrate: GitHub-verified weekly free DeepSeek V4.1 Flash access connected through Squire');
      } catch (error) {
        failedSetup('runcrate', error);
        options.notify(`Runcrate free setup incomplete (${failures.get('runcrate')}); rerun usegrunt setup to resume. Other routes remain available.`);
      } },
      'mistral-vibe': async () => { try {
        await connect();
        await (options.setupProvider ?? setup)(options.notify, ['mistral-vibe'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Mistral Vibe: native free GLM 5.3 Flash access connected through Squire');
      } catch (error) {
        failedSetup('mistral-vibe', error);
        options.notify('Mistral Vibe native free setup incomplete. Install uv or Python 3.12+ if missing, then rerun usegrunt setup; other routes remain available.');
      } },
      livekit: async () => { try {
        await connect();
        await (options.setupProvider ?? setup)(options.notify, ['livekit'], { squire: squire as SetupSquire, directory: options.directory,
          ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('LiveKit: native free Build DeepSeek V4.1 Flash access connected through Squire');
      } catch (error) {
        failedSetup('livekit', error);
        options.notify('LiveKit free Build signup or native CLI pairing incomplete. Rerun usegrunt setup; other routes remain available.');
      } },
      pollinations: async () => { try {
        if (!reuseOnly) await connect();
        await (options.setupProvider ?? setup)(options.notify, ['pollinations'], { squire: squire as SetupSquire, directory: options.directory,
          background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Pollinations: community GLM 5.3 Flash access connected through Squire');
      } catch (error) {
        failedSetup('pollinations', error);
        options.notify('Pollinations free setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      beatapi: async () => { try {
        if (!reuseOnly) await connect();
        await (options.setupProvider ?? setup)(options.notify, ['beatapi'], { squire: squire as SetupSquire, directory: options.directory,
          background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('BeatAPI: verified free access connected through Squire');
      } catch (error) {
        failedSetup('beatapi', error);
        options.notify('BeatAPI free setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      perch: async () => { try {
        if (!reuseOnly) await connect();
        await (options.setupProvider ?? setup)(options.notify, ['perch'], { squire: squire as SetupSquire, directory: options.directory,
          background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Perch: Starter DeepSeek access connected with optional data sharing and account memory off');
      } catch (error) {
        failedSetup('perch', error);
        options.notify('Perch Starter setup needs attention. Rerun usegrunt setup; other free routes continue.');
      } },
      nous: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['nous'], { squire: squire as SetupSquire, directory: options.directory,
          connect, background: reuseOnly, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        unavailable.push('nous');
        // Prefer the Nous reason over Squire's browser reason: the table shows
        // that the person needs to finish the Nous login.
        failures.set('nous', setupFailureReason(error));
        options.notify('Nous setup needs Hermes device approval or an official Hermes installation; other free routes continue.');
      } },
      nvidia: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['nvidia'], { squire: squire as SetupSquire, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('NVIDIA: free DeepSeek V4.1 Flash API access connected through Squire');
      } catch (error) {
        failedSetup('nvidia', error);
        options.notify('NVIDIA setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } }
      };
    let failure: { error: unknown } | undefined;
    try {
      await parallelMap(execution, async id => {
        let available = false;
        try {
          if (disabledAdapters.has(id)) return;
          options.onStarted?.(id);
          if (requiresDataSharing(id) && !approved.includes(id)) {
            failures.set(id, 'approval required');
            unavailable.push(id);
            options.notify(`${id}: skipped until the grouped data-sharing approval is granted`);
            return;
          }
          const task = tasks[id];
          if (!task) throw new Error('Unsupported vetted adapter');
          await task();
          available = !unavailable.includes(id);
        } finally { onSettled(id, available); }
      }, SETUP_CONCURRENCY, options.signal);
    } catch (error) { failure = { error }; }
    finally {
      // Cancellation can leave queued providers unstarted. Settle those as
      // unavailable and keep the shared client alive until observers finish.
      for (const id of requested) onSettled(id, false);
      await Promise.all(callbacks);
    }
    if (failure) throw failure.error;
    options.signal?.throwIfAborted();
    if (callbackFailures.length) throw callbackFailures[0];
    return { unavailable: requested.filter(id => unavailable.includes(id)) };
  } finally { if (owned && connection) await (squire as BrowserSquire).close(); }
}
