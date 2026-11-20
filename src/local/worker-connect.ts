import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { configRoot } from '../brand.js';
import { resolveWorkerPort } from './worker-client.js';

const usage = 'Usage: usegrunt workers connect <pi | opencode | codex | claude> [--port <1-65535>] [--agentic --project <absolute-directory>]';
const serverName = 'grunt-workers';
const toolTimeoutSeconds = 330;
const installedOpenCode = (env: NodeJS.ProcessEnv) => promisify(execFile)('opencode', ['--version'], { env, timeout: 5000 }).then(result => result.stdout);
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function installedWorkerFile(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) throw new Error();
  } catch {
    throw new Error('A current managed Grunt runtime is required. Run usegrunt update, or npx usegrunt setup for a new installation.');
  }
}

interface WorkerConnectOptions {
  env?: NodeJS.ProcessEnv;
  node?: string;
  notify?: (message: string) => void;
  openCodeVersion?: (env: NodeJS.ProcessEnv) => Promise<string>;
}

export async function workerConnectCommand(args: string[], options: WorkerConnectOptions = {}) {
  const [harness, ...remaining] = args;
  const flags: string[] = []; let agentic = false, projectRoot: string | undefined;
  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i];
    if (arg === '--agentic' && !agentic) agentic = true;
    else if (arg === '--project' && remaining[i + 1] && !projectRoot) projectRoot = remaining[++i];
    else if (arg === '--port' && remaining[i + 1] && !flags.length) flags.push(arg, remaining[++i]!);
    else throw new Error(usage);
  }
  if (!['pi', 'opencode', 'codex', 'claude'].includes(harness ?? '') || agentic && harness !== 'pi' && (!projectRoot || !isAbsolute(projectRoot)) || projectRoot && (!agentic || !isAbsolute(projectRoot))) throw new Error(usage);
  const { env = process.env, node = process.execPath, notify = console.log, openCodeVersion = installedOpenCode } = options;
  const port = String(await resolveWorkerPort(flags, env));
  const entry = resolve(configRoot(env), 'runtime', 'dist', 'local', 'main.js');
  const runtime = dirname(entry);
  await installedWorkerFile(entry);
  await installedWorkerFile(join(runtime, 'worker-client.js'));
  const command = [node, entry, 'workers', 'mcp', '--port', port, ...(agentic ? ['--agentic', '--project', projectRoot!] : [])];

  if (harness === 'pi') {
    const extension = join(runtime, 'worker-pi.js');
    await installedWorkerFile(extension);
    notify(`Launch Pi with Grunt subworkers enabled:\npi --provider grunt --model grunt --extension ${shellQuote(extension)} --grunt-worker-port ${port}${agentic ? ' --grunt-agent-workers --grunt-background-jobs' : ''}`);
    return;
  }
  if (harness === 'codex') {
    const [executable, ...arguments_] = command;
    notify(`Add this entry to your Codex config.toml, then restart Codex:\n\n[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(executable)}\nargs = ${JSON.stringify(arguments_)}\ntool_timeout_sec = ${toolTimeoutSeconds}`);
    return;
  }
  if (harness === 'claude') {
    notify(`Register Grunt subworkers${agentic ? ' for this project' : ' across your Claude Code projects'}:\nclaude mcp add --scope ${agentic ? 'project' : 'user'} --transport stdio ${serverName} -- ${command.map(shellQuote).join(' ')}`);
    return;
  }
  const version = await openCodeVersion(env).catch(() => '');
  const major = /^(\d+)\./.exec(version.trim())?.[1];
  if (major !== '1' && major !== '2') throw new Error('Could not identify OpenCode v1 or v2. Install OpenCode and try again.');
  const settings = { type: 'local', command, timeout: toolTimeoutSeconds * 1000 };
  const mcp = major === '1'
    ? { [serverName]: { ...settings, enabled: true } }
    : { servers: { [serverName]: { ...settings, codemode: false } } };
  notify(`Merge this entry into your existing OpenCode configuration, then restart OpenCode:\n\n${JSON.stringify({ mcp }, null, 2)}`);
}
