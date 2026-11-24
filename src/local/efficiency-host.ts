import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { privateProjectPath } from './project-paths.js';
import { VerificationBroker } from './verification-broker.js';
import type { VerificationBrokerRunner } from './verification-broker.js';
import { createVerificationBrokerFileClient, tickVerificationBroker } from './verification-broker-client.js';
import { assertVerificationArtifactContents, captureVerificationState, verificationEnvironmentDigest, verificationPlanDigest } from './verification.js';
import type { VerificationPlan } from './verification.js';
import { PublicationQueue, publicationPolicy } from './publication.js';
import type { PublicationPolicy, PublicationRecord, PublicationRequest } from './publication.js';
import { GithubPublicationTransport, readPublicationArtifacts } from './publication-github.js';
import type { PublicationGithubExec } from './publication-github.js';
import { parseReviewRecord } from './publication-review.js';
import { runtimeWorkTiming } from './work-timing-store.js';
import type { WorkTimingObserver } from './work-timing.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{40}$/;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const inside = (root: string, path: string) => root === path || relative(root, path) !== '..' && !relative(root, path).startsWith('..' + sep) && !isAbsolute(relative(root, path));
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canonical = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && path === resolve(path);
const failure = () => new Error('Invalid trusted execution host policy or unsafe private channel.');
async function directory(path: string) {
  if (!canonical(path)) throw failure();
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid() || st.mode & 0o077 || await realpath(path) !== path) throw failure();
}
async function read(path: string, limit = 128 * 1024): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat(); if (!st.isFile() || st.nlink !== 1 || st.size > limit || process.getuid && st.uid !== process.getuid() || st.mode & 0o077) throw failure();
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    for (;;) { const part = await file.read(buffer, size, buffer.length - size, null); size += part.bytesRead; if (size > limit) throw failure(); if (!part.bytesRead) break; }
    const after = await file.stat();
    if (after.size !== st.size || size !== st.size || after.ctimeMs !== st.ctimeMs || after.mtimeMs !== st.mtimeMs || after.nlink !== 1) throw failure();
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  }
  finally { await file.close(); }
}
async function atomic(path: string, value: unknown) {
  const temporary = join(dirname(path), '.host-' + randomUUID());
  try { await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export interface ExecutionHostPolicy {
  version: 1; projectRoot: string; stateDirectory: string; channelDirectory: string; /** Legacy subworker port: still required in existing policy files, otherwise unused. */ workerPort: number; gitConfigSha256: string; holdFiles?: string[];
  plans: VerificationPlan[];
  /** Host-owned bwrap argv. Only whole-argument substitutions are supported. */
  sandboxArgv: string[];
  publication: PublicationPolicy;
}
/** Deliberately separate from the private host policy: safe to mount read-only into Pi. */
export interface ExecutionHostChannels { version: 1; projectRoot: string; channelDirectory: string }
export function executionHostPolicy(input: unknown): ExecutionHostPolicy {
  const p = object(input);
  if (Object.keys(p).filter(key => key !== 'holdFiles').sort().join(',') !== 'channelDirectory,gitConfigSha256,plans,projectRoot,publication,sandboxArgv,stateDirectory,version,workerPort'
    || p.version !== 1 || !canonical(p.projectRoot) || !canonical(p.stateDirectory) || !canonical(p.channelDirectory)
    || typeof p.gitConfigSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.gitConfigSha256)
    || !Number.isSafeInteger(p.workerPort) || Number(p.workerPort) < 1024 || Number(p.workerPort) > 65535
    || !Array.isArray(p.plans) || !p.plans.length || p.plans.length > 16 || !Array.isArray(p.sandboxArgv)
    || p.sandboxArgv.length < 8 || p.sandboxArgv.length > 256 || p.sandboxArgv.some(x => typeof x !== 'string' || !x || x.includes('\0'))) throw failure();
  if (p.holdFiles !== undefined && (!Array.isArray(p.holdFiles) || p.holdFiles.length > 16 || p.holdFiles.some(path => !canonical(path)))) throw failure();
  const policy = p as unknown as ExecutionHostPolicy;
  for (const a of [policy.projectRoot, policy.stateDirectory, policy.channelDirectory]) for (const b of [policy.projectRoot, policy.stateDirectory, policy.channelDirectory]) if (a !== b && inside(a, b)) throw failure();
  if (new Set([policy.projectRoot, policy.stateDirectory, policy.channelDirectory]).size !== 3) throw failure();
  const publication = publicationPolicy(policy.publication);
  if (publication.projectRoot !== policy.projectRoot) throw failure();
  const seen = new Set<string>(), checkIds = new Set<string>();
  for (const plan of policy.plans) {
    verificationPlanDigest(plan); if (seen.has(plan.id)) throw failure(); seen.add(plan.id);
    for (const check of plan.checks) {
      if (checkIds.has(check.id)) throw new Error('Host check IDs must be unique across all trusted plans.'); checkIds.add(check.id);
      if (JSON.stringify(check.artifactPaths) !== JSON.stringify([publication.artifactDirectory])) throw new Error('Every host release check must capture the configured deployment artifact directory.');
    }
  }
  for (const check of publication.requiredChecks) if (!policy.plans.some(plan => plan.checks.some(row => row.id === check))) throw failure();
  const argv = policy.sandboxArgv;
  if (argv[0] !== '/usr/bin/bwrap' || !['--unshare-all', '--die-with-parent', '--new-session', '--clearenv'].every(x => argv.includes(x))
    || !['$WORKSPACE', '$PROJECT', '$COMMAND'].every(x => argv.includes(x)) || argv.some(x => x.includes('$') && !['$WORKSPACE', '$PROJECT', '$COMMAND'].includes(x))) throw new Error('Host checks require the fixed isolated bwrap template and whole-argument workspace/project/command substitutions.');
  // Forbid mounting authority, credentials, original checkout, or an ancestor of them.
  let workspaceBindings = 0;
  for (let i = 1; i < argv.length; i++) {
    if (['--bind', '--ro-bind', '--bind-try', '--ro-bind-try', '--dev-bind', '--dev-bind-try'].includes(argv[i]!)) {
      const kind = argv[i], source = argv[++i], destination = argv[++i];
      if (source === '$WORKSPACE') { if (kind !== '--bind' || destination !== '$PROJECT') throw failure(); workspaceBindings++; continue; }
      const dependencies = source === join(policy.projectRoot, 'node_modules') && kind === '--ro-bind';
      const secrets = [policy.stateDirectory, policy.channelDirectory, ...(process.env.HOME ? ['.ssh', '.config', '.aws', '.codex', '.gnupg', '.local/state'].map(name => join(process.env.HOME!, name)) : [])];
      if (!canonical(source) || !canonical(destination) || !dependencies && (inside(source, policy.projectRoot) || inside(policy.projectRoot, source))
        || secrets.some(secret => inside(source, secret) || inside(secret, source)) || kind !== '--ro-bind') throw failure();
    }
    if (['--share-net', '--bind-fd', '--ro-bind-fd', '--args', '--file', '--bind-data', '--ro-bind-data', '--userns', '--userns2', '--pidns', '--block-fd', '--seccomp', '--add-seccomp-fd'].includes(argv[i]!)) throw failure();
  }
  if (workspaceBindings !== 1) throw failure();
  return structuredClone({ ...policy, publication });
}
export async function loadExecutionHostPolicy(path: string) {
  if (!canonical(path) || await realpath(path) !== path) throw failure();
  const policy = executionHostPolicy(await read(path));
  if (inside(policy.projectRoot, path) || inside(policy.channelDirectory, path)) throw failure();
  return policy;
}

type Operation = 'prepare' | 'advance' | 'status' | 'review-record';
interface Envelope { version: 1; id: string; operation: Operation; input: unknown }
function envelope(value: unknown): Envelope {
  const e = object(value);
  if (Object.keys(e).sort().join(',') !== 'id,input,operation,version' || e.version !== 1 || typeof e.id !== 'string' || !uuid.test(e.id) || !['prepare', 'advance', 'status', 'review-record'].includes(String(e.operation))) throw failure();
  if (e.operation === 'review-record') { try { parseReviewRecord(e.input); } catch { throw failure(); } if (!uuid.test(String(object(e.input).id))) throw failure(); }
  else if (e.operation !== 'prepare') { const input = object(e.input); if (Object.keys(input).length !== 1 || typeof input.id !== 'string' || !uuid.test(input.id)) throw failure(); }
  return e as unknown as Envelope;
}
const paths = (channelDirectory: string) => ({ verificationInbox: join(channelDirectory, 'verification-inbox'), verificationResults: join(channelDirectory, 'verification-results'), publicationInbox: join(channelDirectory, 'publication-inbox'), publicationResults: join(channelDirectory, 'publication-results'), releases: join(channelDirectory, 'releases') });
async function channelDirectories(root: string) { await directory(root); const p = paths(root); for (const path of Object.values(p)) await directory(path); return p; }
export function createPublicationFileChannel(options: ExecutionHostChannels) {
  return { async request(operation: Operation, input: unknown, context: { cwd: string }, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (await realpath(context.cwd) !== options.projectRoot || inside(options.projectRoot, options.channelDirectory)) throw failure();
    const p = await channelDirectories(options.channelDirectory), e = envelope({ version: 1, id: randomUUID(), operation, input });
    if (operation === 'status') {
      const id = String(object(input).id);
      try { return { ...object(await read(join(p.releases, id + '.json'))), trusted: false, authority: 'Host independently verifies all private release evidence.' }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { id, phase: 'queued', trusted: false }; }
    }
    await atomic(join(p.publicationInbox, e.id + '.json'), e);
    return { id: operation === 'prepare' ? e.id : object(input).id, requestId: e.id, phase: 'queued', trusted: false };
  } };
}
export async function loadExecutionHostChannels(path: string) {
  if (!canonical(path) || await realpath(path) !== path) throw failure();
  const m = object(await read(path));
  if (Object.keys(m).sort().join(',') !== 'channelDirectory,projectRoot,version' || m.version !== 1 || !canonical(m.projectRoot) || !canonical(m.channelDirectory) || inside(m.projectRoot, m.channelDirectory)) throw failure();
  const manifest = m as unknown as ExecutionHostChannels, p = paths(manifest.channelDirectory);
  return { verificationBroker: createVerificationBrokerFileClient({ projectRoot: manifest.projectRoot, inboxDirectory: p.verificationInbox, resultDirectory: p.verificationResults }), publicationChannel: createPublicationFileChannel(manifest) };
}

export interface HostExecResult { code: number; stdout: string }
export interface HostExec {
  (argv: readonly string[], options: { cwd?: string; input?: string; signal?: AbortSignal; environment?: NodeJS.ProcessEnv; timeoutMs?: number; descriptors?: number[] }): Promise<HostExecResult>;
}
/** All child process groups belong to this invocation; cancellation waits for exit and never kills the coding worker. */
export const executionHostExec: HostExec = async (argv, options) => new Promise((resolveResult, reject) => {
  options.signal?.throwIfAborted();
  const child = spawn(argv[0]!, argv.slice(1), { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.environment ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', ...(options.descriptors ?? [])] });
  let output = '', bytes = 0, exceeded = false, cancellation: Promise<void> | undefined;
  const kill = () => {
    if (cancellation) return;
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* parent may have exited while descendants remain */ }
    cancellation = new Promise<void>(done => { setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* entire owned group already exited */ }
      // Do not resolve on parent close: redirected descendants may still be alive until escalation.
      setTimeout(done, 40);
    }, 1500); });
  };
  const timer = setTimeout(kill, options.timeoutMs ?? 120000);
  options.signal?.addEventListener('abort', kill, { once: true });
  child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { exceeded = true; kill(); } else output += chunk.toString('utf8'); });
  // Do not echo credential-bearing host errors into writable worker channels.
  child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { exceeded = true; kill(); } });
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', kill); };
  child.on('error', error => { cleanup(); reject(error); });
  child.on('close', async code => {
    cleanup();
    // A command cannot leave untracked background descendants running after its receipt.
    if (!cancellation && child.pid) { try { process.kill(-child.pid, 0); kill(); } catch { /* group fully exited */ } }
    if (cancellation) await cancellation;
    if (exceeded) reject(new Error('Trusted host command output budget exceeded.'));
    else resolveResult({ code: options.signal?.aborted ? 130 : code ?? 1, stdout: output });
  });
  child.stdin!.on('error', () => {}); child.stdin!.end(options.input);
});
export interface ExecutionHostDependencies {
  timing?: WorkTimingObserver;
  exec?: HostExec;
  /** Dependency seams are programmatic, never accepted in JSON policy or worker intent. */
  runner?: VerificationBrokerRunner;
}
export async function openExecutionHost(input: ExecutionHostPolicy, dependencies: ExecutionHostDependencies = {}) {
  const policy = executionHostPolicy(input);
  if (await realpath(policy.projectRoot) !== policy.projectRoot) throw failure();
  await directory(policy.stateDirectory); const channel = await channelDirectories(policy.channelDirectory);
  const exec = dependencies.exec ?? executionHostExec;
  const minimalEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const hostEnvironment: NodeJS.ProcessEnv = { ...minimalEnvironment, HOME: process.env.HOME, GH_HOST: 'github.com' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']) if (process.env[key]) hostEnvironment[key] = process.env[key];
  const gitEnvironment: NodeJS.ProcessEnv = { ...hostEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
  let configParsed = false;
  const guardedConfig = async () => {
    const path = join(policy.projectRoot, '.git', 'config');
    if (await realpath(path) !== path) throw new Error('Protect the original project Git configuration before host execution.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await file.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > 65536) throw failure();
      const content = await file.readFile();
      if (content.length !== st.size || createHash('sha256').update(content).digest('hex') !== policy.gitConfigSha256) throw new Error('Original Git configuration changed; host execution is held.');
      if (!configParsed) {
        // Parse only pinned bytes through stdin, outside the project. Includes are never expanded.
        const parsed = await exec(['/usr/bin/git', 'config', '--no-includes', '--file', '-', '--null', '--list'], { input: content.toString('utf8'), cwd: policy.stateDirectory, environment: { ...minimalEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
        const allowed = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|user\.(?:name|email)|remote\.[^.]+\.(?:url|fetch)|branch\..+\.(?:remote|merge)|init\.defaultbranch)$/;
        if (parsed.code || parsed.stdout.split('\0').filter(Boolean).some(row => {
          const boundary = row.indexOf('\n'), key = boundary < 0 ? row : row.slice(0, boundary), value = boundary < 0 ? '' : row.slice(boundary + 1);
          return key === 'core.hookspath' ? value !== '/dev/null' : !allowed.test(key);
        })) throw new Error('Execution host refuses included or execution-sensitive Git configuration.');
        configParsed = true;
      }
    }
    finally { await file.close(); }
  };
  const git = async (args: string[], signal?: AbortSignal) => { await guardedConfig(); return exec(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: policy.projectRoot, environment: gitEnvironment, ...(signal ? { signal } : {}) }); };
  const runner: VerificationBrokerRunner = dependencies.runner ?? (async request => {
    const argv = policy.sandboxArgv.map(arg => arg === '$WORKSPACE' ? request.workspaceRoot : arg === '$PROJECT' ? request.projectRoot : arg === '$COMMAND' ? request.command : arg);
    const handles = [];
    try {
      for (let i = 1; i < argv.length; i++) if (argv[i] === '--ro-bind') {
        const source = argv[i + 1]!, canonicalSource = await realpath(source);
        if (source === join(policy.projectRoot, 'node_modules') && canonicalSource !== source) throw failure();
        const handle = await open(canonicalSource, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(handle);
        const pinned = await realpath('/proc/self/fd/' + handle.fd);
        if (pinned !== canonicalSource || [policy.stateDirectory, policy.channelDirectory, ...(process.env.HOME ? ['.ssh', '.config', '.aws', '.codex', '.gnupg', '.local/state'].map(name => join(process.env.HOME!, name)) : [])].some(secret => inside(pinned, secret) || inside(secret, pinned))) throw failure();
        // bwrap consumes inherited descriptors before entering its private namespaces.
        argv[i] = '--ro-bind-fd'; argv[i + 1] = String(handles.length + 2); i += 2;
      }
      const result = await exec(argv, { cwd: request.workspaceRoot, environment: minimalEnvironment, signal: request.signal, timeoutMs: request.timeoutMs, descriptors: handles.map(handle => handle.fd) });
      return { exitCode: result.code };
    } finally { await Promise.all(handles.map(handle => handle.close())); }
  });
  const broker = await VerificationBroker.open({ projectRoot: policy.projectRoot, authorityDirectory: join(policy.stateDirectory, 'verification'), plans: policy.plans, runner,
    ...(dependencies.timing ? { timing: dependencies.timing } : {}),
    environmentDigest: verificationEnvironmentDigest({ ...minimalEnvironment, GRUNT_EXECUTION_POLICY: digest(policy) }) });
  const github: PublicationGithubExec = (args, input, signal) => exec(['/usr/bin/gh', ...args], { environment: hostEnvironment, ...(input !== undefined ? { input } : {}), ...(signal ? { signal } : {}), timeoutMs: 120000 });
  const screenedCommits = new Set<string>(), screenedRanges = new Set<string>();
  const publicSource = async (head: string, baseHead?: string) => {
    const commits = [head], range = baseHead ? baseHead + ':' + head : undefined;
    if (baseHead && !screenedRanges.has(range!)) {
      const history = await git(['rev-list', '--max-count=257', head, '^' + baseHead]);
      const reachable = history.stdout.trim().split('\n').filter(Boolean);
      if (history.code || reachable.length > 256 || reachable.some(commit => !sha.test(commit))) throw new Error('Newly published history exceeds the bounded private-file inspection.');
      commits.push(...reachable);
    }
    for (const commit of new Set(commits)) if (!screenedCommits.has(commit)) {
      const listing = await git(['ls-tree', '-r', '--name-only', '-z', commit]);
      if (listing.code || listing.stdout.split('\0').filter(Boolean).some(path => /[\x00-\x1f\x7f]/.test(path) || privateProjectPath(path) || path === '.gitmodules')) throw new Error('Private-looking committed files cannot be reviewed or published.');
      screenedCommits.add(commit);
    }
    if (range) screenedRanges.add(range);
  };
  const capture = async () => {
    await guardedConfig();
    const state = await captureVerificationState(policy.projectRoot, [policy.publication.artifactDirectory]);
    await publicSource(state.head);
    const [branch, tree, remote] = await Promise.all([
      git(['symbolic-ref', '--short', 'HEAD']), git(['rev-parse', 'HEAD^{tree}']),
      github(['api', '--method', 'GET', `repos/${policy.publication.repository}/git/ref/heads/${policy.publication.base}`]),
    ]);
    const baseHead = object(object(JSON.parse(remote.stdout)).object).sha;
    if (branch.code || tree.code || remote.code || typeof baseHead !== 'string' || !sha.test(baseHead)) throw new Error('Cannot capture the policy-pinned publication base.');
    // The candidate is still local and unpushed. A clean release must already contain this pinned base.
    // A missing base object fails closed during preparation; after our recorded merge it may be remote-only.
    const ancestry = await git(['merge-base', '--is-ancestor', baseHead, state.head]);
    if (ancestry.code === 0) await publicSource(state.head, baseHead);
    return { ...state, branch: branch.stdout.trim(), gitTree: tree.stdout.trim(), baseHead, baseIsAncestor: ancestry.code === 0 };
  };
  // The builder records its own review over the channel. The host still refuses private-looking commits and changed paths first.
  const screen = async (record: PublicationRecord) => {
    await publicSource(record.snapshot.head, record.snapshot.baseHead);
    const changed = await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', record.snapshot.baseHead, record.snapshot.head, '--']);
    if (changed.code || changed.stdout.split('\0').filter(Boolean).some(privateProjectPath)) throw new Error('Private-looking changed paths cannot be reviewed or published.');
  };
  const transport = new GithubPublicationTransport({ exec: github,
    pushHead: async (record, publication, signal) => {
      await guardedConfig();
      await publicSource(record.snapshot.head, record.snapshot.baseHead);
      // Credential-bearing Git never reads worker-owned repository configuration.
      const pushDirectory = join(policy.stateDirectory, 'push-' + record.id); await directory(pushDirectory);
      const init = await exec(['/usr/bin/git', 'init', '--bare', '--template=', pushDirectory], { cwd: policy.stateDirectory, environment: { ...minimalEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, ...(signal ? { signal } : {}) });
      if (init.code || await realpath(join(publication.projectRoot, '.git', 'objects')) !== join(publication.projectRoot, '.git', 'objects')) throw new Error('Cannot prepare protected publication Git metadata.');
      const environment = { ...gitEnvironment, GIT_OBJECT_DIRECTORY: join(publication.projectRoot, '.git', 'objects') };
      const result = await exec(['/usr/bin/git', '--git-dir=' + pushDirectory, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'credential.helper=!/usr/bin/gh auth git-credential', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', 'push', '--no-verify', '--no-follow-tags', '--no-recurse-submodules', `https://github.com/${publication.repository}.git`, `${record.snapshot.head}:refs/heads/${record.request.branch}`], { cwd: policy.stateDirectory, environment, ...(signal ? { signal } : {}) });
      if (result.code) throw new Error('Reviewed head push failed.');
    },
    artifacts: async (record, publication) => {
      const files = await readPublicationArtifacts(publication);
      for (const id of record.verificationIds) {
        const evidence = await broker.verifiedReceipt(id);
        if (!evidence?.receipt || evidence.head !== record.snapshot.head || evidence.artifactDigest !== record.snapshot.artifactDigest) throw new Error('Deployment requires current authenticated artifact evidence.');
        assertVerificationArtifactContents(evidence.receipt.after, files.map(file => ({ path: publication.artifactDirectory + '/' + file.path, content: file.content })));
      }
      return files;
    } });
  const queue = await PublicationQueue.open({ directory: join(policy.stateDirectory, 'publication'), policy: policy.publication, capture,
    verification: async id => { try { return await broker.verifiedReceipt(id); } catch { return undefined; } }, screen, transport });
  const ledger = join(policy.stateDirectory, 'publication-requests'); await directory(ledger);
  const publicationTick = async (signal?: AbortSignal) => {
    if (process.platform !== 'linux') throw new Error('Host publication channels require Linux directory descriptors.');
    const handles = [];
    const pinned: Record<string, string> = {};
    try {
      for (const key of ['publicationInbox', 'publicationResults', 'releases'] as const) {
        const handle = await open(channel[key], constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(handle);
        const descriptor = '/proc/self/fd/' + handle.fd;
        if (await realpath(descriptor) !== channel[key]) throw failure();
        pinned[key] = descriptor;
      }
    const entries = (await readdir(pinned.publicationInbox!)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 16);
    for (const name of entries) {
      signal?.throwIfAborted(); const path = join(pinned.publicationInbox!, name), requestId = name.slice(0, -5);
      let request: Envelope;
      try { request = envelope(await read(path, 65536)); if (request.id !== requestId) throw failure(); }
      catch { await atomic(join(pinned.publicationResults!, name), { requestId, state: 'failed', code: 'invalid_request' }); continue; }
      const saved = join(ledger, name), intentDigest = digest(request);
      let prior: Record<string, unknown> | undefined;
      try { prior = object(await read(saved)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (prior) {
        const response = prior.intentDigest === intentDigest && prior.state === 'completed' ? prior.response : { requestId, state: 'failed', code: 'operation_interrupted_or_reused' };
        await atomic(join(pinned.publicationResults!, name), response); await rm(path); continue;
      }
      await atomic(saved, { version: 1, requestId, intentDigest, state: 'running' });
      let response: Record<string, unknown>;
      try {
        const releaseId = request.operation === 'prepare' ? request.id : String(object(request.input).id);
        const result = request.operation === 'prepare' ? await queue.prepare(request.input, request.id) : request.operation === 'advance' ? await queue.advance(releaseId, signal)
          : request.operation === 'review-record' ? await queue.recordReview(releaseId, request.input) : await queue.status(releaseId);
        await atomic(join(pinned.releases!, releaseId + '.json'), result);
        response = { requestId, state: 'completed', release: result };
      } catch {
        const releaseId = request.operation === 'prepare' ? request.id : String(object(request.input).id);
        const code = request.operation === 'review-record' ? 'review_not_recorded' : 'release_not_advanced';
        response = { requestId, state: 'failed', code, releaseId };
        const current = await queue.status(releaseId).catch(() => ({ id: releaseId, phase: 'blocked', reason: 'release_not_advanced' }));
        await atomic(join(pinned.releases!, releaseId + '.json'), { ...current, lastRequestError: code, requestId });
      }
      await atomic(saved, { version: 1, requestId, intentDigest, state: 'completed', response });
      await atomic(join(pinned.publicationResults!, name), response); await rm(path);
    }
    } finally { await Promise.all(handles.map(handle => handle.close())); }
  };
  let verificationRunning: Promise<unknown> | undefined, publicationRunning: Promise<unknown> | undefined;
  const queued = async (path: string) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { const pinned = '/proc/self/fd/' + handle.fd; if (await realpath(pinned) !== path) throw failure(); return (await readdir(pinned)).some(name => /^[a-f0-9-]{36}\.json$/.test(name)); }
    finally { await handle.close(); }
  };
  const launch = async (signal?: AbortSignal) => {
    if (!verificationRunning && await queued(channel.verificationInbox)) verificationRunning ??= tickVerificationBroker({ broker, projectRoot: policy.projectRoot, inboxDirectory: channel.verificationInbox, resultDirectory: channel.verificationResults, maxRequests: 4, ...(signal ? { signal } : {}) }).finally(() => { verificationRunning = undefined; });
    if (!publicationRunning && await queued(channel.publicationInbox)) publicationRunning ??= publicationTick(signal).finally(() => { publicationRunning = undefined; });
    return [verificationRunning, publicationRunning].filter((p): p is Promise<unknown> => !!p);
  };
  const held = async () => {
    for (const path of policy.holdFiles ?? []) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return false;
  };
  let healthAt = 0;
  const health = async (state: string, force = false) => {
    if (!force && Date.now() - healthAt < 5000) return;
    healthAt = Date.now();
    await atomic(join(policy.stateDirectory, 'health.json'), { version: 1, pid: process.pid, updatedAt: healthAt, state, policyDigest: digest(policy), activeVerification: !!verificationRunning, activePublication: !!publicationRunning });
  };
  await health(await held() ? 'held' : 'idle', true);
  return { broker, queue, policy,
    async tick(signal?: AbortSignal) {
      const holding = await held(); await health(holding ? 'held' : 'working', true);
      const running = holding ? [verificationRunning, publicationRunning].filter((p): p is Promise<unknown> => !!p) : await launch(signal);
      const results = await Promise.allSettled(running);
      await health(await held() ? 'held' : 'idle', true);
      if (results.some(result => result.status === 'rejected')) throw new Error('Execution host tick failed; inspect private evidence.');
    },
    async serve(signal: AbortSignal) {
      // Track failures and all in-flight work. No detached Promise survives shutdown.
      const stop = new AbortController(), managed = AbortSignal.any([signal, stop.signal]);
      let failed = false;
      try { while (!managed.aborted) {
        const holding = await held();
        const running = holding ? [verificationRunning, publicationRunning].filter((p): p is Promise<unknown> => !!p) : await launch(managed);
        await health(holding ? 'held' : verificationRunning || publicationRunning ? 'working' : 'idle');
        for (const pending of running) void pending.catch(() => { if (!managed.aborted) { failed = true; stop.abort(); } });
        await new Promise<void>(done => { const timer = setTimeout(finish, 300); function finish() { clearTimeout(timer); managed.removeEventListener('abort', finish); done(); } managed.addEventListener('abort', finish, { once: true }); });
      } } finally { stop.abort(); await health('stopping', true); await Promise.allSettled([verificationRunning, publicationRunning].filter((v): v is Promise<unknown> => !!v)); await health('stopped', true); }
      if (failed) throw new Error('Execution host held after infrastructure failure; inspect private evidence.');
    },
  };
}

interface HostLease { ownerPid: number; token: string; startTicks?: string }
function parseLease(value: unknown): HostLease {
  const v = object(value);
  if (!Number.isSafeInteger(v.ownerPid) || Number(v.ownerPid) <= 0 || typeof v.token !== 'string' || !uuid.test(v.token)
    || v.startTicks !== undefined && (typeof v.startTicks !== 'string' || !/^\d+$/.test(v.startTicks))) throw failure();
  return v as unknown as HostLease;
}
async function processTicks(pid: number) { try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)?.split(' ')[19]; } catch { return undefined; } }
async function leaseAlive(owner: HostLease) {
  try { process.kill(owner.ownerPid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  const ticks = owner.startTicks ? await processTicks(owner.ownerPid) : undefined;
  return !owner.startTicks || ticks === undefined || ticks === owner.startTicks;
}
async function exclusive(path: string, value: unknown) {
  const staged = join(dirname(path), '.lease-' + randomUUID());
  try { await writeFile(staged, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await link(staged, path); }
  finally { await rm(staged, { force: true }); }
}
/** A stale process lease is recoverable; interrupted request/evidence records are never rerun or discarded. */
export async function acquireExecutionHostLease(stateDirectory: string) {
  await directory(stateDirectory);
  const path = join(stateDirectory, 'host.lock'), ticks = await processTicks(process.pid);
  const next: HostLease = { ownerPid: process.pid, token: randomUUID(), ...(ticks ? { startTicks: ticks } : {}) };
  try { await exclusive(path, next); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = parseLease(await read(path));
    if (await leaseAlive(previous)) throw new Error('Execution host already has a live owner.');
    const claims = join(stateDirectory, 'host-lock-claims'); await directory(claims);
    let observed = previous;
    for (let depth = 0; depth < 128; depth++) {
      const claim = join(claims, digest(observed) + '.json');
      try { await exclusive(claim, next); break; }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        observed = parseLease(await read(claim));
        if (await leaseAlive(observed)) throw new Error('Another execution host is recovering the process lease.');
        if (depth === 127) throw new Error('Execution host owner recovery limit exceeded.');
      }
    }
    const current = parseLease(await read(path));
    if (current.token !== previous.token || await leaseAlive(current)) throw new Error('Execution host owner changed during recovery.');
    await rm(path); await exclusive(path, next);
  }
  return async () => { const current = parseLease(await read(path)); if (current.token !== next.token) throw new Error('Execution host lease ownership changed.'); await rm(path); };
}

/** CLI hook: main.ts dispatches executionHostCommand(argv.slice(1)); root owns that entrypoint edit. */
export async function executionHostCommand(args: string[]) {
  const mode = args[0] === 'serve' || args[0] === 'tick' || args[0] === 'status' ? args[0] : undefined;
  const remaining = mode ? args.slice(1) : args;
  const once = mode === 'tick' || remaining.includes('--once');
  const filtered = remaining.filter(arg => arg !== '--once');
  if (filtered.length !== 2 || filtered[0] !== '--config' || !filtered[1]) throw new Error('Usage: usegrunt execution-host <serve|tick|status> --config /trusted/private/policy.json');
  const policy = await loadExecutionHostPolicy(filtered[1]);
  if (mode === 'status') {
    let status: unknown = { version: 1, state: 'not_started', alive: false };
    try {
      const current = object(await read(join(policy.stateDirectory, 'health.json')));
      const owner = parseLease(await read(join(policy.stateDirectory, 'host.lock')));
      status = { ...current, alive: current.pid === owner.ownerPid && await leaseAlive(owner), policyMatches: current.policyDigest === digest(policy) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    process.stdout.write(JSON.stringify(status) + '\n'); return;
  }
  const release = await acquireExecutionHostLease(policy.stateDirectory);
  const measurements = runtimeWorkTiming(join(policy.stateDirectory, 'efficiency'));
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { const host = await openExecutionHost(policy, { timing: measurements.timing }); if (once) await host.tick(controller.signal); else await host.serve(controller.signal); }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); await measurements.close(); await release(); }
}

export type { PublicationRequest, PublicationRecord };
