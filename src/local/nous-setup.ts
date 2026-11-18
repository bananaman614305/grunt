import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { gruntEnv } from '../brand.js';
import { executable } from './multiplexer.js';
import { checkNousProfile, nousHermesPaths } from './nous.js';
import { withTerminal } from './terminal.js';

const hermesRevision = 'd2184961137dce23c92dc587040ce652be6dcb61';
const exec = promisify(execFile);

interface NousSetupOptions {
  directory: string;
  background?: boolean;
  signal?: AbortSignal;
  notify: (line: string) => void;
}

export function nousApprovalURL(line: string): URL | undefined {
  const match = /^\s*1\. Open:\s*(https:\/\/\S+)\s*$/.exec(line);
  if (!match?.[1]) return;
  const url = new URL(match[1]);
  const code = url.searchParams.get('user_code');
  if (url.origin === 'https://portal.nousresearch.com'
    && url.pathname === '/manage-subscription' && !url.username && !url.password && !url.hash
    && url.searchParams.size === 1 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code ?? '')) return url;
}

async function ensureHermes(directory: string, signal: AbortSignal) {
  let paths = nousHermesPaths(directory);
  const checkRuntime = async () => {
    await access(paths.python, constants.X_OK);
    await access(paths.entry, constants.R_OK);
    await exec(paths.python, ['-c', 'import aiohttp; from hermes_cli.proxy.server import create_app'], {
      cwd: paths.root, env: paths.env, signal, timeout: 10_000, maxBuffer: 65536
    });
  };
  try {
    await checkRuntime();
    return paths;
  } catch {
    signal.throwIfAborted();
    if (gruntEnv('HERMES_ROOT')) throw new Error('The configured official Hermes Agent is missing its proxy dependencies');
    paths = nousHermesPaths(directory, { ...process.env, GRUNT_HERMES_ROOT: join(directory, 'nous-client') });
  }
  let git: string, uv: string;
  try { [git, uv] = await Promise.all([executable('git'), executable('uv')]); }
  catch { throw new Error('Install uv and Git, or install the official Hermes Agent, then rerun usegrunt setup'); }
  await mkdir(directory, { mode: 0o700, recursive: true });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) {
    throw new Error('Nous installation needs a private Grunt configuration directory');
  }
  const stage = await mkdtemp(join(directory, '.nous-client-'));
  try {
    const run = (command: string, args: string[], env: NodeJS.ProcessEnv = {}) => exec(command, args, {
      cwd: stage, signal, timeout: 420_000, maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...env
      }
    });
    await run(git, ['init', '--quiet']);
    await run(git, ['fetch', '--quiet', '--no-tags', '--depth=1', 'https://github.com/NousResearch/hermes-agent.git', hermesRevision]);
    await run(git, ['checkout', '--quiet', '--detach', hermesRevision]);
    // This Hermes extra adds only aiohttp, which the official proxy requires.
    await run(uv, ['sync', '--no-config', '--frozen', '--no-dev', '--no-install-project', '--extra', 'homeassistant', '--python', '3.11'], {
      UV_PROJECT_ENVIRONMENT: join(stage, 'venv'),
      UV_CACHE_DIR: join(directory, 'nous-dependency-cache'),
      UV_PYTHON_INSTALL_DIR: join(directory, 'nous-python')
    });
    await run(join(stage, 'venv', 'bin', 'python'), ['-c', 'import aiohttp; from hermes_cli.proxy.server import create_app']);
    await rename(stage, paths.root);
  } catch {
    signal.throwIfAborted();
    // Another foreground setup may have finished the same installation.
    try { await checkRuntime(); }
    catch { throw new Error('Could not install the pinned official Hermes Agent'); }
  } finally { await rm(stage, { recursive: true, force: true }); }
  await access(paths.python, constants.X_OK);
  await access(paths.entry, constants.R_OK);
  return paths;
}

export async function setupNous({ directory, background, signal: caller, notify }: NousSetupOptions) {
  caller?.throwIfAborted();
  const signal = AbortSignal.any([...(caller ? [caller] : []), AbortSignal.timeout(1_080_000)]);
  if (!await checkNousProfile(directory, signal)) {
    if (background || gruntEnv('SETUP_NO_HUMAN') === '1') throw new Error('Nous needs foreground Hermes device approval');
    const paths = await ensureHermes(directory, signal);
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    const info = await lstat(paths.home);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
      throw new Error('Nous needs a private Hermes profile');
    }
    signal.throwIfAborted();
    const login = spawn(paths.python, [paths.entry, 'auth', 'add', 'nous', '--type', 'oauth', '--no-browser', '--scope', 'inference:invoke'], {
      cwd: paths.root, env: paths.env, signal, stdio: ['ignore', 'pipe', 'ignore']
    });
    const lines = createInterface({ input: login.stdout });
    let linkShown = false;
    lines.on('line', line => {
      if (linkShown) return;
      let link: URL | undefined;
      try { link = nousApprovalURL(line); } catch { return; }
      if (!link) return;
      linkShown = true;
      void withTerminal(async () => {
        if (signal.aborted) return;
        console.log(`Nous Portal: sign in and approve Hermes on the Free plan at ${link.href}`);
      });
    });
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        login.once('error', () => reject(new Error('Hermes device approval could not complete')));
        login.once('close', resolve);
      });
      if (exit !== 0 || !await checkNousProfile(directory, signal)) throw new Error('Nous Free plan could not be verified after device approval');
    } finally { lines.close(); }
  }
  notify('Nous: Free plan connected through the official Hermes client');
}
