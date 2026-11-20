import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { captureVerificationState } from './verification.js';
import { parseVerificationBrokerRequest } from './verification-broker.js';
import type { VerificationBroker, VerificationBrokerStatus } from './verification-broker.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const name = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const within = (a: string, b: string) => a === b || relative(a, b) !== '..' && !relative(a, b).startsWith('..' + sep) && !isAbsolute(relative(a, b));
async function privateDirectory(path: string) {
  if (!isAbsolute(path) || path !== resolve(path)) throw new Error('Broker channels require canonical absolute private directories.');
  await mkdir(path, { recursive: true, mode: 0o700 }); const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) || await realpath(path) !== path) throw new Error('Unsafe verification broker channel.');
}
async function read(path: string, limit: number) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const st = await f.stat(); if (!st.isFile() || process.getuid && st.uid !== process.getuid() || (st.mode & 0o077) || st.size > limit) throw new Error('Unsafe verification broker message.'); const bytes = Buffer.alloc(limit + 1); const read = await f.read(bytes, 0, bytes.length, 0); const after = await f.stat();
    if (read.bytesRead > limit || read.bytesRead !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw new Error('Verification broker message changed while reading.');
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')) as unknown; }
  finally { await f.close(); }
}
async function atomic(path: string, value: unknown) {
  const temporary = join(dirname(path), `.verification-message-${randomUUID()}.tmp`);
  try { await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
const parseId = (v: unknown) => {
  const o = object(v);
  if (Object.keys(o).length !== 1 || typeof o.id !== 'string' || !uuid.test(o.id)) throw new Error('Provide the verification id returned by the host broker.');
  return o.id;
};
export interface VerificationBrokerChannels { projectRoot: string; inboxDirectory: string; resultDirectory: string }
export interface VerificationBrokerContext { cwd: string; sessionManager?: { getSessionId(): string } }

/** Worker-facing transport only. Results are useful progress data, never publication authority; the host independently loads and authenticates its receipt. */
export function createVerificationBrokerFileClient(options: VerificationBrokerChannels) {
  const channel = async (context: VerificationBrokerContext) => {
    if (await realpath(context.cwd) !== options.projectRoot || await realpath(options.projectRoot) !== options.projectRoot
      || within(options.projectRoot, options.inboxDirectory) || within(options.projectRoot, options.resultDirectory)) throw new Error('Verification broker policy does not match this project.');
    await privateDirectory(options.inboxDirectory); await privateDirectory(options.resultDirectory);
  };
  const result = async (input: unknown, context: VerificationBrokerContext, signal?: AbortSignal) => {
    signal?.throwIfAborted(); await channel(context); const id = parseId(input);
    try {
      const value = object(await read(join(options.resultDirectory, id + '.json'), 128 * 1024));
      if (value.version !== 1 || value.id !== id || !['queued', 'running', 'completed', 'failed'].includes(String(value.state))) throw new Error('Invalid broker result.');
      // Do not turn writable transport data into `verified:true` authority.
      return { ...value, verified: false, authority: 'Host publication independently authenticates its private receipt.' };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return { version: 1, id, state: 'queued', verified: false };
    }
  };
  return {
    async start(input: { planId: string; checkId: string }, context: VerificationBrokerContext, signal?: AbortSignal) {
      signal?.throwIfAborted(); await channel(context); const value = object(input);
      if (Object.keys(value).length !== 2 || typeof value.planId !== 'string' || !name.test(value.planId) || typeof value.checkId !== 'string' || !name.test(value.checkId)) throw new Error('Release verification accepts only a trusted plan id and check id.');
      const state = await captureVerificationState(options.projectRoot); signal?.throwIfAborted();
      if (!state.clean) throw new Error('Commit a clean project before requesting a release check.');
      const request = { version: 1, id: randomUUID(), planId: value.planId, checkId: value.checkId, expectedHead: state.head, expectedTreeDigest: state.treeDigest };
      await atomic(join(options.inboxDirectory, request.id + '.json'), request);
      return { version: 1, id: request.id, planId: request.planId, checkId: request.checkId, state: 'queued', verified: false };
    },
    status: result,
    result,
  };
}

/** Finite host-side tick. Run in a managed process independent of the main coding agent; no listener or detached shell is created. */
export async function tickVerificationBroker(options: VerificationBrokerChannels & { broker: VerificationBroker; maxRequests?: number; signal?: AbortSignal }) {
  await privateDirectory(options.inboxDirectory); await privateDirectory(options.resultDirectory);
  if (within(options.inboxDirectory, options.broker.authorityDirectory) || within(options.broker.authorityDirectory, options.inboxDirectory)
    || within(options.resultDirectory, options.broker.authorityDirectory) || within(options.broker.authorityDirectory, options.resultDirectory)
    || within(options.projectRoot, options.inboxDirectory) || within(options.projectRoot, options.resultDirectory)) throw new Error('Host verification authority must not be exposed through worker channels.');
  const max = options.maxRequests ?? 8;
  if (!Number.isSafeInteger(max) || max < 1 || max > 32) throw new Error('Verification ticks accept one to32 queued checks.');
  if (process.platform !== 'linux') throw new Error('Host file-queue transport requires Linux directory descriptors; use the in-process broker on other platforms.');
  const inbox = await open(options.inboxDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const resultsHandle = await open(options.resultDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(async error => { await inbox.close(); throw error; });
  const inboxPath = `/proc/self/fd/${inbox.fd}`, resultPath = `/proc/self/fd/${resultsHandle.fd}`;
  try {
  if (await realpath(inboxPath) !== options.inboxDirectory || await realpath(resultPath) !== options.resultDirectory) throw new Error('Verification channel changed while opening.');
  const results: VerificationBrokerStatus[] = [];
  const entries = (await readdir(inboxPath, { withFileTypes: true })).filter(e => (e.isFile() || e.isSymbolicLink()) && uuid.test(e.name.replace(/\.json$/, '')) && e.name.endsWith('.json')).slice(0, max);
  for (const entry of entries) {
    options.signal?.throwIfAborted(); const id = entry.name.slice(0, -5), path = join(inboxPath, entry.name);
    let value: unknown;
    try {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('Unsafe queued request.');
      value = parseVerificationBrokerRequest(await read(path, 8192));
      if (object(value).id !== id) throw new Error('Verification request id mismatch.');
    } catch {
      // Invalid transport is rejected without removing or following attacker-chosen paths.
      await atomic(join(resultPath, id + '.json'), { version: 1, id, state: 'failed', code: 'invalid_request' });
      await rm(path, { force: true });
      continue;
    }
    const request = parseVerificationBrokerRequest(value);
    let response: VerificationBrokerStatus;
    try { response = await options.broker.run(request, options.signal); }
    catch { response = { version: 1, id, planId: request.planId, checkId: request.checkId, state: 'failed', code: 'execution_failed' }; }
    results.push(response); await atomic(join(resultPath, id + '.json'), response);
    if (response.state === 'completed' || response.state === 'failed') await rm(path, { force: true });
  }
  return results;
  } finally { await inbox.close(); await resultsHandle.close(); }
}
