import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserSquire } from './setup.js';
import { OpenCode } from './opencode.js';
import { SourceError, Sources } from './source.js';
import type { Source } from './source.js';

const exec = promisify(execFile);
class FreebuffCompatibilityError extends Error {}
export type Signup = Pick<BrowserSquire, 'signup' | 'credentials'>;
// The CLI keeps the local login exchange alive while Squire completes its URL.
export async function loginFreebuff(squire: Signup) {
  const child = spawn('freebuff', ['login'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const { stdout } = await exec('freebuff', ['doctor'], { timeout: 10000, maxBuffer: 65536 });
  if (/not signed in|logged.?out|login required/i.test(stdout)) return false;
  if (!/Freebuff doctor/i.test(stdout)) throw new Error('Unrecognized Freebuff diagnostics; run freebuff doctor');
  return true;
}
export async function verifyOpenCode(source: Source = new OpenCode()) {
  const sources = new Sources([source]);
  try {
    await sources.complete({ model: 'opencode', cwd: process.cwd(), messages: [{ role: 'user', content: 'Reply only: Milo is ready. Do not use tools or change files.' }], tools: [], stream: false }, AbortSignal.timeout(120000));
  } finally { await sources.close(); }
}
export async function setupFallbacks(options: {
  directory: string;
  run(binary: string, args: string[], interactive?: boolean): Promise<void>;
  notify(line: string): void;
  squire?: Signup;
  signedIn?: () => Promise<boolean>;
  login?: (squire: Signup) => Promise<void>;
  verify?: () => Promise<void>;
}) {
  const squire = options.squire ?? new BrowserSquire();
  const owned = squire instanceof BrowserSquire && !options.squire;
  const unavailable: string[] = [];
  // Reuse a grant created by an earlier setup before probing the free model.
  const savedConfig = join(options.directory, 'opencode-free.json');
  try { await access(savedConfig); process.env.OPENCODE_CONFIG = savedConfig; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let connected = false;
  const connect = async () => { if (owned && !connected) { await (squire as BrowserSquire).connect(); connected = true; } };
  const install = async (binary: string, pkg: string) => {
    try { await options.run(binary, ['--version']); }
    catch { await options.run('npm', ['install', '--global', pkg], true); }
  };
  options.notify('Free routes run their own tools with your filesystem permissions in the working directory. Free model providers may retain prompts.');
  try {
    try {
      await install('freebuff', 'freebuff');
      // Older CLIs accept --version but cannot run the login diagnostic.
      try { await options.run('freebuff', ['doctor']); }
      catch {
        options.notify('Freebuff: repairing the installed CLI before checking sign-in');
        try {
          await options.run('npm', ['install', '--global', 'freebuff@latest'], true);
          await options.run('freebuff', ['doctor']);
        } catch {
          throw new FreebuffCompatibilityError('Freebuff CLI repair incomplete. The active freebuff on PATH must support doctor. Run npm install --global freebuff@latest, remove older Freebuff binaries earlier on PATH, then rerun milo setup. Continuing with OpenCode.');
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
      if (!await signedIn()) { await connect(); await (options.login ?? loginFreebuff)(squire); }
      if (!await signedIn()) throw new Error('Freebuff is still signed out; rerun setup to resume');
      options.notify('Freebuff: signed in; Milo will start its loopback bridge with the background service');
    } catch (error) {
      unavailable.push('freebuff');
      if (error instanceof FreebuffCompatibilityError) options.notify(error.message);
      else options.notify('Freebuff setup incomplete. Run freebuff doctor, install tmux if missing, then rerun milo setup. Continuing with OpenCode.');
    }
    try {
      await install('opencode', 'opencode-ai');
      const verify = options.verify ?? (() => verifyOpenCode());
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
      options.notify('OpenCode free model check failed or signup was refused. Rerun milo setup after repairing OpenCode; other routes remain available.');
    }
    return { unavailable };
  } finally { if (owned && connected) await (squire as BrowserSquire).close(); }
}
