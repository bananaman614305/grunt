import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserSquire, setup } from './setup.js';
import type { SetupSquire } from './setup.js';
import { parallelMap } from './parallel.js';
import { OpenCode } from './opencode.js';
import { DOCTOR_TIMEOUT_MS } from './freebuff.js';
import { SourceError, Sources } from './source.js';
import { DATA_SHARING_POLICIES, readDataSharingConsent, requiresDataSharing } from './data-sharing.js';
import type { Source } from './source.js';

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
    browser = squire.signup('freebuff', url, "Complete this Freebuff CLI login using the user's existing account, or sign up for the free plan if none exists. This URL pairs the local CLI; finish that pairing. No paid plan, payment method, extra account or account switching. Stop on refusal; report captcha, passkey or email verification for human handoff. Do not bypass verification.");
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
  dataSharingApproved?: readonly string[];
}) {
  const squire = options.squire ?? new BrowserSquire({ dataSharingApproved: options.dataSharingApproved ?? [] });
  const owned = squire instanceof BrowserSquire && !options.squire;
  const unavailable: string[] = [];
  const adapters = (options.adapters ?? ['freebuff', 'opencode']);
  const approved = [...new Set([...(options.dataSharingApproved ?? []), ...await readDataSharingConsent(options.directory, DATA_SHARING_POLICIES.map(policy => policy.provider))])];
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
        unavailable.push('freebuff');
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
      } catch {
        unavailable.push('opencode');
        options.notify('OpenCode free model check failed or signup was refused. Rerun usegrunt setup after repairing OpenCode; other routes remain available.');
      } },
      kilo: async () => { try {
        await (options.setupProvider ?? setup)(options.notify, ['kilo'], { squire: squire as SetupSquire, directory: options.directory, dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Kilo: free Particle-1 access verified without signup');
      } catch {
        unavailable.push('kilo');
        options.notify('Kilo setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      zro: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['zro'], { squire: squire as SetupSquire, directory: options.directory, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Zro: daily free DeepSeek V4.1 Flash access connected through Squire');
      } catch {
        unavailable.push('zro');
        options.notify('Zro setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      tokenharbor: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['tokenharbor'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Token Harbor: approved free DeepSeek V4.1 Flash access connected through Squire');
      } catch {
        unavailable.push('tokenharbor');
        options.notify('Token Harbor setup incomplete or data sharing not approved. Run usegrunt setup to finish; other routes remain available.');
      } },
      runcrate: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['runcrate'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Runcrate: GitHub-verified weekly free DeepSeek V4.1 Flash access connected through Squire');
      } catch {
        unavailable.push('runcrate');
        options.notify('Runcrate free setup incomplete. GitHub must be at least 30 days old; rerun usegrunt setup to resume. Other routes remain available.');
      } },
      apinex: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['apinex'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('APInex: daily check-in verified for free DeepSeek V4.1 Flash access through Squire');
      } catch {
        unavailable.push('apinex');
        options.notify('APInex free setup or daily check-in incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      'mistral-vibe': async () => { try {
        await connect();
        await (options.setupProvider ?? setup)(options.notify, ['mistral-vibe'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Mistral Vibe: native free GLM 5.3 Flash access connected through Squire');
      } catch {
        unavailable.push('mistral-vibe');
        options.notify('Mistral Vibe native free setup incomplete. Install uv or Python 3.12+ if missing, then rerun usegrunt setup; other routes remain available.');
      } },
      livekit: async () => { try {
        await connect();
        await (options.setupProvider ?? setup)(options.notify, ['livekit'], { squire: squire as SetupSquire, directory: options.directory,
          ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('LiveKit: native free Build DeepSeek V4.1 Flash access connected through Squire');
      } catch {
        unavailable.push('livekit');
        options.notify('LiveKit free Build signup or native CLI pairing incomplete. Rerun usegrunt setup; other routes remain available.');
      } },
      pollinations: async () => { try {
        await connect();
        await (options.setupProvider ?? setup)(options.notify, ['pollinations'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('Pollinations: community GLM 5.3 Flash access connected through Squire');
      } catch {
        unavailable.push('pollinations');
        options.notify('Pollinations free setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      beatapi: async () => { try {
        await connect();
        await (options.setupProvider ?? setup)(options.notify, ['beatapi'], { squire: squire as SetupSquire, directory: options.directory,
          dataSharingApproved: approved, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('BeatAPI: free DeepSeek V4.1 Flash access connected through Squire');
      } catch {
        unavailable.push('beatapi');
        options.notify('BeatAPI free setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } },
      nvidia: async () => { try {
        await connect();
        if (!squire.runs) throw new Error('Provider signup requires Squire');
        await (options.setupProvider ?? setup)(options.notify, ['nvidia'], { squire: squire as SetupSquire, ...(options.signal ? { signal: options.signal } : {}) });
        options.notify('NVIDIA: free DeepSeek V4.1 Flash API access connected through Squire');
      } catch {
        unavailable.push('nvidia');
        options.notify('NVIDIA setup incomplete. Rerun usegrunt setup to resume; other routes remain available.');
      } }
      };
    await parallelMap(adapters, async id => {
      if (requiresDataSharing(id) && !approved.includes(id)) {
        unavailable.push(id);
        options.notify(`${id}: skipped until the grouped data-sharing approval is granted`);
        return;
      }
      const task = tasks[id];
      if (!task) throw new Error('Unsupported vetted adapter');
      await task();
    }, 3, options.signal);
    options.signal?.throwIfAborted();
    return { unavailable: adapters.filter(id => unavailable.includes(id)) };
  } finally { if (owned && connection) await (squire as BrowserSquire).close(); }
}
