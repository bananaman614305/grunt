import { observeAttemptDispatch } from './diagnostics.js';
import { configRoot } from '../brand.js';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compileToolSchemas } from './tool-schema.js';
import { readDataSharingConsent } from './data-sharing.js';
import { FreebuffTools } from './freebuff-tools.js';
import { completionEnding, preventReplay, replayTimeout, SourceError, requestRefusal, withEnding } from './source.js';
import type { Completion, ModelRequest, Source } from './source.js';
import { openPerchACP, runPerchCommand, runPerchMemorySettings, verifyPerchCoreFiles } from './perch-process.js';
import type { PerchProcessOptions, PerchProcesses } from './perch-process.js';
export { openPerchACP, runPerchCommand, runPerchMemorySettings } from './perch-process.js';
export type { PerchACP, PerchProcessOptions, PerchProcesses } from './perch-process.js';

export const PERCH_VERSION = '2.4.132';
export const PERCH_MODEL_ALIAS = 'deepseek-flash-starter';
export const PERCH_MODEL_OPTION_ID = 'openrouter-deepseek-deepseek-v4-1-flash-crusoe';
export const PERCH_MODEL_ID = 'deepseek/deepseek-v4.1-flash';
export const PERCH_MODEL_LABEL = 'DeepSeek V4.1 Flash 1017 (Starter)';
export const PERCH_NPM_TARBALL_URL = 'https://registry.npmjs.org/perchai-cli/-/perchai-cli-2.4.132.tgz';
export const PERCH_NPM_INTEGRITY = 'sha512-eQJWzHXhlBGKho1yFwjBCLNi7ttl23NyCumRMCO5j/oT0oM7DkuJZeSVUxlKqyf5ntM9JeN9z5/Goe9vE+SLqw==';
export const PERCH_TARBALL_SHA256 = '01966bb687db6b2ac5a66540a41e2723291791b385f05cc06796e1c50f79f4cc';
export const PERCH_CORE_SHA256 = {
  'bin/perch': 'be23ce6d6bff5663a2fe005199e5090ce7fc0795cb1acf082cb42ac184471c8e',
  'dist/perch.mjs': '7802f39dd70cf1eace49a1bf0b44e632ed055be368f55dbde11c0866dffd1180',
  'package.json': 'a905a496431cd9c589b1c83a79a7fe00145e3e41466c84e73c15d3e863d02e34'
} as const;
export const PERCH_RECEIPT_MAX_AGE_MS = 30 * 86400000;
export const PERCH_TIMEOUT_MS = 175000;
// These public vendor prompts are inline rC in the pinned, hashed CLI bundle.
// They are NOT user SKILL.md files. Preflight guarantees gre(cwd).meta is null:
// mIe then passes no userSkills to zle, so user files cannot shadow these IDs.
export const PERCH_BUILTIN_SKILLS = ['about-perch', 'browser-operator', 'data-quality', 'diagrams', 'documents', 'github', 'pdf',
  'presentations', 'release', 'research', 'skill-creator', 'spreadsheets', 'wait-operator', 'workspace'] as const;
const builtinSkills = new Set<string>(PERCH_BUILTIN_SKILLS);
const directoryDefault = () => configRoot();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function perchPaths(directory = directoryDefault()) {
  const home = resolve(directory, 'perch'), binRoot = join(home, 'bin'), versionHome = join(binRoot, PERCH_VERSION), packageDirectory = join(versionHome, 'package');
  return { home, binRoot, versionHome, package: packageDirectory, binary: join(packageDirectory, 'bin', 'perch'),
    bundle: join(packageDirectory, 'dist', 'perch.mjs'), packageJSON: join(packageDirectory, 'package.json'),
    auth: join(home, 'auth'), authFile: join(home, 'auth', 'cli-auth-session.json'), settings: join(home, 'settings'),
    state: join(home, 'state'), grants: join(home, 'grants'), telemetry: join(home, 'telemetry'),
    nativeHome: join(home, 'native-home'), consent: join(home, 'consent'), splash: join(home, 'splash'), background: join(home, 'background'),
    work: join(home, 'work'), receipt: join(home, 'free-plan.json'), installReceipt: join(home, 'installation.json') };
}
/** HOME stays unchanged. Only documented native configuration paths are isolated. */
export function perchEnvironment(directory = directoryDefault(), requestDirectory?: string): NodeJS.ProcessEnv {
  const p = perchPaths(directory), local = (name: 'settings' | 'state' | 'grants' | 'telemetry' | 'nativeHome' | 'consent' | 'splash' | 'background') => requestDirectory ? join(requestDirectory, name) : p[name];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:perch_|aws_|azure_|google_|gcp_|openai_|openrouter_|anthropic_|grok_|deepseek_|mistral_|qianfan_|cloudflare_|cf_|fireworks_|coreweave_|together_|crusoe_|gemini_|vertex_|wandb_|kimi_|moonshot_|zai_|zhipu_|minimax_|modal_|bedrock_|ai_gateway_|hf_|huggingface_)/i.test(key) && !/^node_(?:options|path|compile_cache)$/i.test(key)
    && !/^(?:SHELL|BASH_ENV|ENV|ZDOTDIR|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i.test(key)
    && !/(?:^|_)(?:api_key|auth_token|access_token|refresh_token|secret|secret_key|token)$/i.test(key)));
  return { ...env, PERCH_HOME: local('nativeHome'), PERCH_CLI_AUTH_DIR: p.auth, PERCH_CLI_SETTINGS_DIR: local('settings'),
    PERCH_CLI_STATE_DIR: local('state'), PERCH_CLI_GRANTS_DIR: local('grants'), PERCH_CLI_TELEMETRY_DIR: local('telemetry'),
    PERCH_CLI_CONSENT_DIR: local('consent'), PERCH_CLI_SPLASH_DIR: local('splash'), PERCH_BACKGROUND_TASK_DIR: local('background'),
    PERCH_CLI_HEAP_DIAG: 'off', PERCH_GIT_ATTRIBUTION: 'off' };
}
export interface PerchFreePlanReceipt {
  // The vetted recurring allowance floor, rather than a live balance or bonus.
  version: 1; plan: 'Starter'; email: string; monthlyAllowancePT: 20000; dataProgramEnabled: false; memoryUseEnabled: false; memoryLearningEnabled: false; checkedAt: string;
}
export interface PerchInstallReceipt {
  version: 1; packageVersion: typeof PERCH_VERSION; tarballSha256: typeof PERCH_TARBALL_SHA256;
  npmIntegrity: typeof PERCH_NPM_INTEGRITY;
}
const eligibilityError = () => new SourceError('logged_out', 'Perch Starter verification is missing or expired; rerun usegrunt setup');
function receipt(value: unknown): PerchFreePlanReceipt {
  const r = object(value), checked = typeof r.checkedAt === 'string' ? Date.parse(r.checkedAt) : NaN;
  if (r.version !== 1 || r.plan !== 'Starter' || r.monthlyAllowancePT !== 20000 || r.dataProgramEnabled !== false || r.memoryUseEnabled !== false || r.memoryLearningEnabled !== false
    || typeof r.email !== 'string' || r.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)
    || !Number.isFinite(checked) || checked > Date.now() + 60000 || Date.now() - checked > PERCH_RECEIPT_MAX_AGE_MS) throw eligibilityError();
  return { version: 1, plan: 'Starter', email: r.email.toLowerCase(), monthlyAllowancePT: 20000, dataProgramEnabled: false, memoryUseEnabled: false, memoryLearningEnabled: false, checkedAt: r.checkedAt as string };
}
function installation(value: unknown): PerchInstallReceipt {
  const r = object(value);
  if (r.version !== 1 || r.packageVersion !== PERCH_VERSION || r.tarballSha256 !== PERCH_TARBALL_SHA256 || r.npmIntegrity !== PERCH_NPM_INTEGRITY) throw new SourceError('not_installed', 'Perch pinned installation receipt is missing');
  return { version: 1, packageVersion: PERCH_VERSION, tarballSha256: PERCH_TARBALL_SHA256, npmIntegrity: PERCH_NPM_INTEGRITY };
}
export async function perchPrivateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw eligibilityError();
}
async function privateJSON(path: string, limit = 4096): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > limit) throw eligibilityError();
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
async function writeReceipt(directory: string, path: string, value: unknown) {
  const p = perchPaths(directory); await perchPrivateDirectory(p.home, true);
  const temporary = join(p.home, `.receipt-${randomUUID()}`);
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function preparePerchDirectories(directory: string) {
  const p = perchPaths(directory);
  await perchPrivateDirectory(resolve(directory), true);
  await perchPrivateDirectory(p.home, true);
  for (const path of [p.binRoot, p.versionHome, p.auth, p.settings, p.state, p.grants, p.telemetry, p.nativeHome, p.consent, p.splash, p.background, p.work]) await perchPrivateDirectory(path, true);
  return p;
}
export async function readPerchFreePlanReceipt(directory = directoryDefault()) { return receipt(await privateJSON(perchPaths(directory).receipt)); }
export async function writePerchFreePlanReceipt(directory: string, value: PerchFreePlanReceipt) { await writeReceipt(directory, perchPaths(directory).receipt, receipt(value)); }
export async function readPerchInstallReceipt(directory = directoryDefault()) { return installation(await privateJSON(perchPaths(directory).installReceipt)); }
export async function writePerchInstallReceipt(directory: string) {
  await verifyPerchCore(directory);
  await writeReceipt(directory, perchPaths(directory).installReceipt, installation({ version: 1, packageVersion: PERCH_VERSION, tarballSha256: PERCH_TARBALL_SHA256, npmIntegrity: PERCH_NPM_INTEGRITY }));
}
export async function verifyPerchCore(directory: string, signal = AbortSignal.timeout(10000)) {
  const p = perchPaths(directory);
  for (const path of [p.home, p.binRoot, p.versionHome]) await perchPrivateDirectory(path);
  const pkg = await lstat(p.package);
  if (!pkg.isDirectory() || pkg.isSymbolicLink() || pkg.uid !== process.getuid?.() || (pkg.mode & 0o022)) throw new SourceError('not_installed', 'Perch package directory is unsafe');
  await verifyPerchCoreFiles(p.package, PERCH_CORE_SHA256, signal);
  await access(p.binary, constants.X_OK);
}
export async function verifyPerchInstallation(directory: string, signal = AbortSignal.timeout(10000)) {
  await readPerchInstallReceipt(directory); await verifyPerchCore(directory, signal);
}
export async function assertPerchPrivateAuth(directory: string) {
  const p = perchPaths(directory); await perchPrivateDirectory(p.auth);
  const st = await lstat(p.authFile);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size < 1 || st.size > 65536) throw eligibilityError();
}

/** No global instructions may make the native empty-workspace metadata nonempty. Never modify those files. */
export async function verifyPerchStartupIsolation(work: string, personalHome = homedir()) {
  const projectMetadata = join(resolve(work), '.perch');
  // The pinned CLI reads Claude agents only at the project root. A .git
  // ancestor that could change the root is already refused below.
  const forbidden = [projectMetadata, join(resolve(work), '.claude', 'agents'), join(personalHome, 'Documents', 'Perch', 'PERCH.md'), join(personalHome, '.perch', 'PERCH.md'),
    join(personalHome, '.perch', 'agents'), join(personalHome, '.perch', 'skills'), join(personalHome, '.perch', 'plugins')];
  let current = resolve(work);
  while (current !== dirname(current)) {
    forbidden.push(...['.git', 'AGENTS.md', 'CLAUDE.md', 'PERCH.md', '.perch/PERCH.md', '.perch/agents'].map(name => join(current, name)));
    if (current === resolve(personalHome)) break;
    current = dirname(current);
  }
  for (const path of new Set(forbidden)) {
    try {
      const st = await lstat(path);
      if (path !== projectMetadata && !path.endsWith('/.git') && st.isDirectory() && !st.isSymbolicLink() && !(await readdir(path)).length) continue;
      throw new SourceError('refused', 'Perch has external startup instructions or configuration; this isolated route is unavailable');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

const defaultProcesses: PerchProcesses = { command: runPerchCommand, acp: openPerchACP, memory: runPerchMemorySettings };
async function requestWorkspace(directory: string) {
  const p = perchPaths(directory); await perchPrivateDirectory(p.work);
  const request = await mkdtemp(join(p.work, 'request-'));
  try {
    for (const name of ['workspace', 'settings', 'state', 'grants', 'telemetry', 'nativeHome', 'consent', 'splash', 'background']) await perchPrivateDirectory(join(request, name), true);
    await writeFile(join(request, 'settings', 'cli-settings.json'), JSON.stringify({ version: 1, language: 'en', chatMode: 'ask',
      personaId: 'saffron', permissionMode: 'plan', manualModelOptionId: PERCH_MODEL_OPTION_ID, cliLocalTools: false, roostChoice: 'standard' }), { flag: 'wx', mode: 0o600 });
    return { request, workspace: join(request, 'workspace'), env: perchEnvironment(directory, request) };
  } catch (error) { await rm(request, { recursive: true, force: true }); throw error; }
}
function parseIdentity(result: { stdout: string; code: number | null }): { email: string } | null {
  const lines = result.stdout.replaceAll('\r', '').trim().split('\n');
  if (result.code === 2 && lines.some(line => line === `Perch CLI ${PERCH_VERSION} · Not signed in`)) return null;
  const match = lines[0]?.match(/^Perch CLI ([0-9.]+) · Signed in as ([^\s@]+@[^\s@]+\.[^\s@]+) · (https:\/\/[^\s]+)$/);
  if (result.code !== 0 || !match || match[1] !== PERCH_VERSION) throw eligibilityError();
  let url: URL;
  try { url = new URL(match[3]!); } catch { throw eligibilityError(); }
  if (url.protocol !== 'https:' || !['app.perchai.app', 'chat.perchai.app'].includes(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw eligibilityError();
  return { email: match[2]!.toLowerCase() };
}
async function openSession(directory: string, request: Awaited<ReturnType<typeof requestWorkspace>>, signal: AbortSignal, processes: PerchProcesses) {
  await verifyPerchStartupIsolation(request.workspace);
  const p = perchPaths(directory), options: PerchProcessOptions = { cwd: request.workspace, env: request.env, signal, maxOutputBytes: 2 * 1024 * 1024, timeoutMs: PERCH_TIMEOUT_MS };
  const acp = await processes.acp(p.binary, options);
  try {
    const initialized = object(await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'grunt', version: 'perch-adapter-v1' } }));
    const agent = object(initialized.agentInfo);
    if (initialized.protocolVersion !== 1 || agent.name !== 'perch' || agent.version !== PERCH_VERSION) throw new SourceError('refused', 'Perch did not acknowledge the pinned native client');
    const session = object(await acp.request('session/new', { cwd: request.workspace, mcpServers: [] }));
    if (typeof session.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session.sessionId) || object(session.modes).currentModeId !== 'plan') throw new SourceError('refused', 'Perch did not acknowledge isolated native permissions');
    // ACP's official authentication check refreshes an expired native access token.
    // `status` alone does not refresh it, so identity must be read after session/new.
    const identity = parseIdentity(await processes.command(process.execPath, [p.binary, 'status'], { ...options, maxOutputBytes: 65536, timeoutMs: 10000 }));
    signal.throwIfAborted();
    return { acp, sessionId: session.sessionId, identity };
  } catch (error) { await acp.close(); throw error; }
}
/** Nonbillable official native interfaces; the authentication file remains entirely CLI-owned. */
export async function verifyPerchIdentity(directory: string, signal = AbortSignal.timeout(30000), processes: PerchProcesses = defaultProcesses): Promise<{ email: string } | null> {
  await verifyPerchInstallation(directory, signal);
  try { await assertPerchPrivateAuth(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const request = await requestWorkspace(directory);
  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  try { session = await openSession(directory, request, signal, processes); return session.identity; }
  catch (error) { if (error instanceof SourceError && error.code === 'logged_out') return null; throw error; }
  finally { try { await session?.acp.close().catch(() => {}); } finally { await rm(request.request, { recursive: true, force: true }).catch(() => {}); } }
}
async function memorySettings(directory: string, signal: AbortSignal, processes: PerchProcesses, configure: boolean) {
  await verifyPerchInstallation(directory, signal); await assertPerchPrivateAuth(directory);
  const request = await requestWorkspace(directory);
  try {
    await verifyPerchStartupIsolation(request.workspace);
    return await (processes.memory ?? runPerchMemorySettings)(perchPaths(directory).binary, { cwd: request.workspace, env: request.env, signal, timeoutMs: 30000, maxOutputBytes: 65536 }, configure);
  } finally { await rm(request.request, { recursive: true, force: true }).catch(() => {}); }
}
/** Read current native account memory switches without generating or modifying account preferences. */
export async function verifyPerchMemory(directory: string, signal = AbortSignal.timeout(30000), processes: PerchProcesses = defaultProcesses) {
  return memorySettings(directory, signal, processes, false);
}
/** Setup-only: save both supported account memory switches Off, then read them back. */
export async function configurePerchMemory(directory: string, signal = AbortSignal.timeout(30000), processes: PerchProcesses = defaultProcesses) {
  return memorySettings(directory, signal, processes, true);
}
async function readSnapshot(request: string, sessionId: string, signal: AbortSignal) {
  const state = join(request, 'state');
  for (let attempt = 0; attempt < 25; attempt++) {
    signal.throwIfAborted();
    for (const item of await readdir(state, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) throw new SourceError('upstream', 'Perch private state is unsafe');
      const folder = join(state, item.name); await perchPrivateDirectory(folder);
      try {
        const saved = object(await privateJSON(join(folder, `${sessionId}.json`), 8 * 1024 * 1024)), snapshot = object(saved.contextSnapshot);
        if (saved.threadId !== sessionId) throw new SourceError('upstream', 'Perch returned uncorrelated private state');
        if (snapshot.turnApiUsage) return snapshot;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await new Promise<void>((resolveWait, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveWait(); }, 100);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  throw new SourceError('upstream', 'Perch returned no authoritative native usage');
}
function snapshotUsage(snapshot: Record<string, unknown>, limit: number | undefined) {
  const sections = object(snapshot.sectionBreakdown), tools = snapshot.toolCallsByType;
  if (snapshot.modelId !== PERCH_MODEL_ID || snapshot.modelLabel !== PERCH_MODEL_LABEL || snapshot.cliLocalTools !== false
    || !Array.isArray(snapshot.selectedSkills) || snapshot.selectedSkills.some(skill => typeof skill !== 'string' || !builtinSkills.has(skill))
    || new Set(snapshot.selectedSkills).size !== snapshot.selectedSkills.length || !Array.isArray(tools) || tools.length
    || object(sections.project_memory).chars !== 0 || object(sections.permanent_memory).chars !== 0
    || snapshot.compacted !== false || snapshot.truncated !== false || !Number.isSafeInteger(snapshot.contextLimitTokens) || Number(snapshot.contextLimitTokens) < 200000) {
    throw new SourceError('refused', 'Perch returned an unverified model, native action, or external context');
  }
  const usage = object(snapshot.turnApiUsage), keys = ['inputTokens', 'outputTokens', 'totalTokens'];
  if (keys.some(key => !Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0)
    || (usage.cacheReadInputTokens !== undefined && (!Number.isSafeInteger(usage.cacheReadInputTokens) || Number(usage.cacheReadInputTokens) < 0))) throw new SourceError('upstream', 'Perch returned invalid native usage');
  const inputTokens = Number(usage.inputTokens) + Number(usage.cacheReadInputTokens ?? 0), outputTokens = Number(usage.outputTokens);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || outputTokens < 1 || limit !== undefined && outputTokens > limit || usage.totalTokens !== inputTokens + outputTokens) throw new SourceError('upstream', 'Perch returned invalid or over-budget native usage');
  return { inputTokens, outputTokens };
}
function validatedBridge(request: ModelRequest) {
  try {
    const messages: ModelRequest['messages'] = [];
    for (const message of request.messages) {
      const previous = messages.at(-1);
      if (message.role === 'assistant' && message.content === '' && message.tool_calls?.length && !message.tool_call_id && previous?.role === 'assistant' && previous.content === '' && previous.tool_calls?.length && !previous.tool_call_id) {
        previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      } else messages.push({ ...message });
    }
    const bridge = new FreebuffTools({ ...request, messages });
    compileToolSchemas(request.tools, 'Perch rejected a function tool schema');
    return bridge;
  } catch (error) { throw error instanceof SourceError ? error : requestRefusal('Perch rejected unsupported function definitions or an invalid tool conversation'); }
}
function outputBudget(value: number | undefined) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) throw new SourceError('refused', 'Perch requires a positive integer output budget');
  return value;
}
export class Perch implements Source {
  readonly id = 'perch'; readonly supportsFunctionTools = true; readonly jsonToolBridge = true;
  private shutdown = new AbortController(); private pending = new Set<Promise<unknown>>(); private busy = false;
  constructor(private options: { directory?: string; timeout?: number; processes?: PerchProcesses } = {}) {}
  private get directory() { return this.options.directory ?? directoryDefault(); }
  private get processes() { return this.options.processes ?? defaultProcesses; }
  private async track<T>(task: Promise<T>) { this.pending.add(task); try { return await task; } finally { this.pending.delete(task); } }
  private async ready(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!['linux', 'darwin'].includes(process.platform)) throw new SourceError('not_installed', 'Perch requires the vetted Linux or macOS CLI');
    if (!(await readDataSharingConsent(this.directory, ['perch'])).includes('perch')) throw new SourceError('refused', 'Perch data sharing is not approved; rerun usegrunt setup');
    await verifyPerchInstallation(this.directory, signal); await assertPerchPrivateAuth(this.directory);
    await verifyPerchStartupIsolation(perchPaths(this.directory).work);
    return readPerchFreePlanReceipt(this.directory);
  }
  async available() { return this.track((async () => { try { await this.ready(AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15000)])); return !this.shutdown.signal.aborted && !this.busy; } catch { return false; } })()); }
  async healthCheck() {
    return this.track((async () => { try {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30000)]), r = await this.ready(signal);
      return (await verifyPerchIdentity(this.directory, signal, this.processes))?.email === r.email
        && (await verifyPerchMemory(this.directory, signal, this.processes)).email === r.email;
    } catch { return false; } })());
  }
  async complete(request: ModelRequest, caller: AbortSignal): Promise<Completion> { return this.track(this.completeOnce(request, caller)); }
  private async completeOnce(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    if (this.busy) throw new SourceError('quota', 'Perch is serving another request; use another free source', 1);
    this.busy = true;
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(Math.min(this.options.timeout ?? PERCH_TIMEOUT_MS, PERCH_TIMEOUT_MS))]);
    let workspace: Awaited<ReturnType<typeof requestWorkspace>> | undefined, session: Awaited<ReturnType<typeof openSession>> | undefined, inferenceStarted = false;
    try {
      signal.throwIfAborted();
      if (request.imageInput) throw new SourceError('refused', 'Perch supports text through this isolated route');
      const limit = outputBudget(request.maxTokens), bridge = validatedBridge(request);
      const lines = bridge.prompt().split('\n'), payload = lines.pop();
      // Change only our adapter instructions. The caller's JSON payload stays byte-for-byte intact.
      const prompt = `This is a Grunt caller request using the account owner's official Perch CLI.${limit === undefined ? '' : ` Keep total output, including the JSON envelope, below ${limit} tokens.`}\n`
        + lines.map(line => line.replaceAll('Freebuff', 'Perch')).join('\n') + '\n' + payload;
      if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw new SourceError('refused', 'Perch prompt exceeds the supported size');
      const r = await this.ready(signal);
      if ((await verifyPerchMemory(this.directory, signal, this.processes)).email !== r.email) throw eligibilityError();
      workspace = await requestWorkspace(this.directory);
      session = await openSession(this.directory, workspace, signal, this.processes);
      if (!session.identity || session.identity.email !== r.email) throw eligibilityError();
      inferenceStarted = true;
      observeAttemptDispatch({ account: 'local_session' });
      const result = object(await session.acp.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] }));
      signal.throwIfAborted();
      if (result.stopReason !== 'end_turn' && result.stopReason !== 'max_tokens') throw new SourceError('upstream', 'Perch did not return a complete response');
      let text = '';
      for (const notification of session.acp.notifications) {
        const params = object(notification.params), update = object(params.update), content = object(update.content);
        if (params.sessionId !== session.sessionId) throw new SourceError('upstream', 'Perch returned an uncorrelated session update');
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          throw preventReplay(new SourceError('refused', 'Perch attempted an unexpected native action'), 'Perch native action');
        }
        if (update.sessionUpdate === 'agent_message_chunk') {
          if (content.type !== 'text' || typeof content.text !== 'string') throw new SourceError('refused', 'Perch returned unsupported content');
          text += content.text;
          if (Buffer.byteLength(text) > 65536) throw new SourceError('upstream', 'Perch completion exceeded the supported size');
        }
      }
      const usage = snapshotUsage(await readSnapshot(workspace.request, session.sessionId, signal), limit);
      if (result.stopReason === 'max_tokens') return withEnding({ text: '', finishReason: 'length', ...usage }, completionEnding(result.stopReason, undefined, false));
      // The CLI has no hard upstream output-token option. This validates returned
      // usage after generation; monthly allowance can already have been consumed.
      // No repair generation is attempted, so the caller budget is cumulative.
      try {
        const completion = bridge.parse(text);
        if (!completion.text.trim() && !completion.calls?.length) throw new Error('Empty answer');
        return withEnding({ ...completion, ...usage }, completionEnding(result.stopReason, undefined, !!completion.calls?.length));
      } catch { throw new SourceError('upstream', 'Perch returned an invalid caller tool envelope'); }
    } catch (error) {
      if (!caller.aborted && !this.shutdown.signal.aborted && !signal.aborted && error instanceof SourceError && (error.code === 'logged_out' || (inferenceStarted && error.code === 'refused'))) await rm(perchPaths(this.directory).receipt, { force: true }).catch(() => {});
      if (caller.aborted) throw new SourceError('cancelled', 'Perch request cancelled');
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Perch stopped during shutdown');
      if (signal.aborted) throw replayTimeout('Perch request timed out', !inferenceStarted);
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Perch request failed; rerun usegrunt setup if native access needs repair');
    } finally {
      try { await session?.acp.close().catch(() => {}); }
      finally { if (workspace) await rm(workspace.request, { recursive: true, force: true }).catch(() => {}); this.busy = false; }
    }
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
