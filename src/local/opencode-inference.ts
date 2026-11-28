import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { ManagedOpenCodeProcess } from './managed-opencode-process.js';
import { executable } from './multiplexer.js';
import { replayTimeout, SourceError } from './source.js';

export const denyOpenCodeTools = [{ permission: '*', pattern: '*', action: 'deny' }];

async function readOptional(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '{}';
  }
}

function zenOptions(content: string) {
  const options = parse(content)?.provider?.opencode?.options;
  return {
    ...(typeof options?.apiKey === 'string' ? { apiKey: options.apiKey } : {}),
    ...(typeof options?.baseURL === 'string' ? { baseURL: options.baseURL } : {}),
  };
}

export async function startOpenCodeInference(configFile: string | undefined, maxTokens: number | undefined, signal: AbortSignal) {
  const binary = await executable('opencode');
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'grunt-opencode-inference-'));
  let managed: ManagedOpenCodeProcess | undefined;
  const close = async () => {
    try { await managed?.stop(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  };
  try {
    // Carry over only the Zen login. Full OpenCode config can start MCP servers
    // or load project instructions and plugins before the first prompt.
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
    const configFiles = [join(configHome, 'opencode', 'config.json'), join(configHome, 'opencode', 'opencode.json'),
      join(configHome, 'opencode', 'opencode.jsonc'), configFile].filter(path => path !== undefined);
    const configs = await Promise.all(configFiles.map(readOptional));
    const options = Object.assign({}, ...configs.map(zenOptions), zenOptions(process.env.OPENCODE_CONFIG_CONTENT || '{}'));
    const auth = parse(process.env.OPENCODE_AUTH_CONTENT || await readOptional(join(dataHome, 'opencode', 'auth.json')))?.opencode;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: join(cwd, 'config'), XDG_DATA_HOME: join(cwd, 'data'),
      XDG_CACHE_HOME: join(cwd, 'cache'), XDG_STATE_HOME: join(cwd, 'state'),
      OPENCODE_CONFIG_DIR: join(cwd, 'config', 'opencode'),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: join(cwd, 'config', 'managed'),
      OPENCODE_AUTH_CONTENT: JSON.stringify(auth?.type === 'api' ? { opencode: auth } : {}),
      OPENCODE_DB: ':memory:',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOCOMPACT: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { opencode: { options } }, permission: { '*': 'deny' },
        mcp: {}, instructions: [], snapshot: false, share: 'disabled', agent: { title: { disable: true } },
      }),
    };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_PERMISSION;
    delete env.OPENCODE_WORKSPACE_ID;
    if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(maxTokens);
    signal.throwIfAborted();
    const grouped = process.platform !== 'win32';
    const child = spawn(binary, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: grouped,
    });
    managed = new ManagedOpenCodeProcess(child, grouped);
    const ready = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const base = await new Promise<string>((resolve, reject) => {
      let output = '';
      const stopped = () => reject(new SourceError('upstream', 'OpenCode inference server stopped during startup'));
      const aborted = () => reject(replayTimeout('OpenCode server startup timed out', true));
      child.once('error', stopped);
      child.once('exit', stopped);
      ready.addEventListener('abort', aborted, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
        const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) { ready.removeEventListener('abort', aborted); resolve(address); }
      });
      if (ready.aborted) aborted();
    });
    return { base, cwd, close };
  } catch (error) {
    await close();
    throw error;
  }
}
