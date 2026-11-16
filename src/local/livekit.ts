import { configRoot } from '../brand.js';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { FreeApi } from './free-api.js';
import { verifiedDeepSeekFetch } from './deepseek-response.js';
import { SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';

export const LIVEKIT_CLI_VERSION = '2.19.4';
export const LIVEKIT_DEEPSEEK = 'deepseek-ai/deepseek-v4.1-flash';
export const LIVEKIT_GATEWAY = 'https://agent-gateway.livekit.cloud';
export const LIVEKIT_RECEIPT_MAX_AGE_MS = 30 * 86400000;
export interface LiveKitFreeBuildReceipt {
  version: 1;
  plan: 'Build';
  payAsYouGo: false;
  paymentMethodPresent: false;
  purchasedCredits: 0;
  projectSelector: string;
  projectId: string;
  projectURL: string;
  checkedAt: string;
}
const configDirectory = () => configRoot();
export function livekitPaths(directory = configDirectory(), nativeDirectory = join(homedir(), '.livekit')) {
  const home = resolve(directory, 'livekit');
  return { home, binary: join(home, 'bin', process.platform === 'win32' ? 'lk.exe' : 'lk'),
    work: join(home, 'work'), receipt: join(home, 'free-build.json'), nativeHome: nativeDirectory, nativeConfig: join(nativeDirectory, 'cli-config.yaml') };
}
// A shell's LiveKit credentials or project must not override the native project
// chosen in the verified receipt. Keep HOME unchanged for standard CLI auth.
export function livekitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:livekit_|lk_)/i.test(key)));
}
export interface LiveKitProject { selector: string; id: string; url: string; default: boolean }
// The official CLI's normal table includes an API-key column. Project only
// public identity metadata and never use its secret-bearing JSON output.
export function parseLiveKitProjects(output: string): LiveKitProject[] {
  const result: LiveKitProject[] = [];
  const clean = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '');
  for (const line of clean.split('\n')) {
    const columns = line.split(/[│┃|]/).map(value => value.trim()).filter(Boolean);
    if (columns.length < 4) continue;
    const [label, id, url] = columns;
    if (!label || !id || !url || !/^wss:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.livekit\.cloud\/?$/i.test(url)) continue;
    const selector = label.replace(/^\*\s*/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(selector) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) continue;
    result.push({ selector, id, url: new URL(url).origin, default: label.startsWith('*') });
  }
  return result;
}
function validateReceipt(value: unknown): LiveKitFreeBuildReceipt {
  const receipt = value as Partial<LiveKitFreeBuildReceipt> | null;
  const checked = typeof receipt?.checkedAt === 'string' ? Date.parse(receipt.checkedAt) : NaN;
  let url: URL;
  try { url = new URL(typeof receipt?.projectURL === 'string' ? receipt.projectURL : ''); }
  catch { throw new SourceError('logged_out', 'LiveKit Free Build project verification is missing or expired; rerun usegrunt setup'); }
  if (!receipt || receipt.version !== 1 || receipt.plan !== 'Build' || receipt.payAsYouGo !== false || receipt.paymentMethodPresent !== false || receipt.purchasedCredits !== 0
      || typeof receipt.projectSelector !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(receipt.projectSelector)
      || typeof receipt.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(receipt.projectId)
      || url.protocol !== 'wss:' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.livekit\.cloud$/.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/'
      || !Number.isFinite(checked) || checked > Date.now() + 60000 || Date.now() - checked > LIVEKIT_RECEIPT_MAX_AGE_MS) {
    throw new SourceError('logged_out', 'LiveKit Free Build project verification is missing or expired; rerun usegrunt setup');
  }
  return { version: 1, plan: 'Build', payAsYouGo: false, paymentMethodPresent: false, purchasedCredits: 0,
    projectSelector: receipt.projectSelector, projectId: receipt.projectId, projectURL: url.origin, checkedAt: receipt.checkedAt! };
}
async function privateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new SourceError('logged_out', 'Unsafe LiveKit private directory; rerun usegrunt setup');
  }
}
export async function readLiveKitFreeBuildReceipt(directory = configDirectory()) {
  await privateDirectory(livekitPaths(directory).home);
  const file = await open(livekitPaths(directory).receipt, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new SourceError('logged_out', 'Unsafe LiveKit Free Build receipt; rerun usegrunt setup');
    return validateReceipt(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
// Setup supplies these public metadata and billing facts only after an actual
// browser check. The receipt never contains the CLI-owned API key or secret.
export async function writeLiveKitFreeBuildReceipt(directory: string, receipt: LiveKitFreeBuildReceipt) {
  const value = validateReceipt(receipt), paths = livekitPaths(directory), temporary = join(paths.home, `.free-build-${randomUUID()}.tmp`);
  await privateDirectory(paths.home, true);
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, paths.receipt); }
  finally { await rm(temporary, { force: true }); }
}
// Inspect metadata only. The official CLI remains the only code reading its
// native API keys and signing its short-lived inference token.
export async function validateLiveKitNativeConfig(nativeDirectory = join(homedir(), '.livekit')) {
  const home = await lstat(nativeDirectory), auth = await lstat(join(nativeDirectory, 'cli-config.yaml'));
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || (home.mode & 0o777) !== 0o700
      || !auth.isFile() || auth.isSymbolicLink() || auth.uid !== process.getuid?.() || (auth.mode & 0o777) !== 0o600 || auth.size === 0) {
    throw new SourceError('logged_out', 'Unsafe LiveKit native login; rerun usegrunt setup');
  }
}
async function cliOutput(binary: string, args: string[], cwd: string, signal: AbortSignal, maxBuffer: number): Promise<string> {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(10000), tokenSignal = AbortSignal.any([signal, deadline]);
  return await new Promise((resolveOutput, reject) => {
    const child = execFile(binary, args,
    { cwd, env: livekitEnvironment(), encoding: 'utf8', signal: tokenSignal, killSignal: 'SIGKILL', maxBuffer, windowsHide: true }, (error, stdout) => {
      if (error) { reject(new SourceError(signal.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'logged_out', 'LiveKit native CLI command failed; rerun usegrunt setup')); return; }
      resolveOutput(stdout);
    });
    child.stdin?.end();
  });
}
async function inferenceToken(binary: string, receipt: LiveKitFreeBuildReceipt, cwd: string, signal: AbortSignal): Promise<string> {
  const config = join(cwd, 'livekit.toml');
  const output = await cliOutput(binary, ['--config', config, 'project', 'list'], cwd, signal, 262144);
  const selected = parseLiveKitProjects(output).filter(project => project.selector === receipt.projectSelector);
  if (selected.length !== 1 || selected[0]!.id !== receipt.projectId || selected[0]!.url !== receipt.projectURL) {
    throw new SourceError('logged_out', 'LiveKit native project differs from its verified free Build project; rerun usegrunt setup');
  }
  const token = (await cliOutput(binary, ['--project', receipt.projectSelector, '--config', config, 'token', 'create',
    '--inference', '--token-only', '--valid-for', '10m', '--identity', 'agent'], cwd, signal, 32768)).trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 16384) {
    throw new SourceError('logged_out', 'LiveKit CLI returned no inference token; rerun usegrunt setup');
  }
  return token;
}
export class LiveKit implements Source {
  readonly id = 'livekit';
  readonly supportsFunctionTools = true;
  private shutdown = new AbortController();
  private pending = new Set<Promise<unknown>>();
  constructor(private options: { directory?: string; binary?: string; fetcher?: typeof fetch; timeout?: number; nativeDirectory?: string } = {}) {}
  private async ready() {
    const paths = livekitPaths(this.options.directory, this.options.nativeDirectory);
    try {
      const receipt = await readLiveKitFreeBuildReceipt(this.options.directory);
      await validateLiveKitNativeConfig(paths.nativeHome);
      await access(this.options.binary ?? paths.binary, constants.X_OK);
      return { paths, receipt };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError('logged_out', 'LiveKit native Free Build login is unavailable; rerun usegrunt setup');
    }
  }
  async available() { try { await this.ready(); return !this.shutdown.signal.aborted; } catch { return false; } }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, caller: AbortSignal) {
    caller.throwIfAborted();
    const task = this.completeOnce(request, caller); this.pending.add(task);
    try { return await task; }
    finally { this.pending.delete(task); }
  }
  private async completeOnce(request: ModelRequest, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    let temporary: string | undefined;
    try {
      signal.throwIfAborted();
      if (request.imageInput) throw new SourceError('upstream', 'LiveKit requires text input');
      if (request.tools.some(tool => tool.type !== 'function')) throw new SourceError('upstream', 'LiveKit requires function tools');
      const { paths, receipt } = await this.ready(); signal.throwIfAborted();
      await privateDirectory(paths.work, true);
      temporary = await mkdtemp(join(paths.work, '.token-'));
      await writeFile(join(temporary, 'livekit.toml'), '', { mode: 0o600, flag: 'wx' });
      const token = await inferenceToken(this.options.binary ?? paths.binary, receipt, temporary, signal);
      signal.throwIfAborted();
      const source = new FreeApi('livekit', { fetcher: verifiedDeepSeekFetch(this.options.fetcher), timeout: this.options.timeout ?? 180000,
        loadGrant: async () => ({ base_url: LIVEKIT_GATEWAY, token }) });
      try { return await source.complete({ ...request, model: this.id }, signal); }
      finally { await source.close(); }
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'LiveKit request cancelled during shutdown');
      if (signal.aborted) throw new SourceError('timeout', 'LiveKit request timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'LiveKit request failed; rerun usegrunt setup');
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
