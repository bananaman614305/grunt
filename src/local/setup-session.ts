import { hasOwnerMode, openPrivateFile } from './private-file.js';
import { constants } from 'node:fs';
import { mkdir, lstat, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { knownAdapters } from '../registry.js';

const prefix = '.setup-session-';
const ttl = 90000;
const heartbeat = 15000;
const claimName = /^\.setup-session-(\d+)-([a-f0-9-]{36})$/;
const sourceId = /^[a-z][a-z0-9-]{0,63}$/;
interface Claim { path: string; id: string; pid: number }
interface State { version: 1; id: string; pid: number; expires: number; owned: string[]; pending: string[]; verifying: string[]; anonymousKilo?: true }
export interface SetupSessionState { owned: ReadonlySet<string>; pending: ReadonlySet<string>; verifying: ReadonlySet<string>; anonymousKilo?: true }
export interface SetupSession {
  readonly signal: AbortSignal;
  verify(id: string): Promise<void>;
  hold(id: string): Promise<void>;
  release(id: string): Promise<void>;
  useKiloAccount(): Promise<void>;
  close(): Promise<void>;
}
const unavailable = () => new Error('Cannot coordinate provider setup safely; finish the existing setup or rerun usegrunt setup');
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  return stat.isDirectory() && !stat.isSymbolicLink() && hasOwnerMode(stat, 0o700);
}
async function claims(directory: string) {
  if (!await privateDirectory(directory)) throw unavailable();
  const result: Claim[] = [];
  for (const name of await readdir(directory)) {
    const match = claimName.exec(name);
    if (!match) continue;
    const pid = Number(match[1]), path = join(directory, name);
    if (!Number.isSafeInteger(pid) || pid < 1 || !alive(pid)) continue;
    try { if (await privateDirectory(path)) result.push({ path, id: match[2]!, pid }); }
    catch { /* A completed setup may remove its own directory concurrently. */ }
  }
  return result;
}
async function readState(claim: Claim, allowExpired = false): Promise<State | undefined> {
  let file;
  try {
    file = await openPrivateFile(join(claim.path, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0o600) || stat.size > 32768) return;
    const state = JSON.parse(await file.readFile('utf8')) as Partial<State>;
    if (state.version !== 1 || state.id !== claim.id || state.pid !== claim.pid || typeof state.expires !== 'number'
      || !Number.isFinite(state.expires) || (!allowExpired && state.expires <= Date.now()) || state.expires > Date.now() + ttl + 60000
      || !Array.isArray(state.owned) || state.owned.length > 100 || state.owned.some(id => typeof id !== 'string' || !sourceId.test(id))
      || new Set(state.owned).size !== state.owned.length || !Array.isArray(state.pending)
      || state.pending.some(id => typeof id !== 'string' || !state.owned!.includes(id)) || new Set(state.pending).size !== state.pending.length
      || !Array.isArray(state.verifying) || state.verifying.some(id => typeof id !== 'string' || !state.pending!.includes(id))
      || new Set(state.verifying).size !== state.verifying.length) return;
    return state as State;
  } catch { return; }
  finally { await file?.close(); }
}
async function blockingClaim(claim: Claim) {
  const state = await readState(claim, true);
  if (state) return state.expires > Date.now();
  // Protect the atomic mkdir -> initial snapshot handshake. Old partial claims
  // cannot block a new installer indefinitely, including after PID reuse.
  try { return Date.now() - (await lstat(claim.path)).mtimeMs < ttl; }
  catch { return false; }
}

// The Kilo route that passed setup verification. It outlives the setup session
// so routing keeps using the verified anonymous route instead of an older grant.
const kiloRouteFile = (directory: string) => join(directory, 'kilo-route.json');
export async function readKiloRoute(directory: string): Promise<'anonymous' | 'account'> {
  let file;
  try {
    file = await openPrivateFile(kiloRouteFile(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || !hasOwnerMode(stat, 0, 0) || stat.size > 1024) return 'account';
    return (JSON.parse(await file.readFile('utf8')) as { route?: unknown }).route === 'anonymous' ? 'anonymous' : 'account';
  } catch { return 'account'; }
  finally { await file?.close(); }
}
async function writeKiloRoute(directory: string, anonymous: boolean) {
  if (!anonymous) { await rm(kiloRouteFile(directory), { force: true }); return; }
  const temporary = join(directory, `.kilo-route.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ route: 'anonymous' }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, kiloRouteFile(directory));
  } finally { await rm(temporary, { force: true }); }
}

/** No credentials are stored here. Dead or expired owners never block routing. */
export async function readSetupSession(directory: string): Promise<SetupSessionState | undefined> {
  try {
    const active = await claims(directory);
    const states = await Promise.all(active.map(claim => readState(claim, true)));
    // An active initializing/corrupt claim has no trustworthy provider subset.
    // Hold provisioning and dispatch conservatively until its owner repairs or
    // aborts, rather than treating unsafe IO as permission to duplicate signup.
    for (let i = 0; i < active.length; i++) if (!states[i] && await blockingClaim(active[i]!)) {
      const all = new Set(knownAdapters);
      return { owned: all, pending: all, verifying: new Set() };
    }
    const valid = states.filter((state): state is State => state !== undefined && state.expires > Date.now());
    if (!valid.length) return;
    return {
      owned: new Set(valid.flatMap(state => state.owned)), pending: new Set(valid.flatMap(state => state.pending)),
      verifying: new Set(valid.flatMap(state => state.verifying)),
      ...(valid.some(state => state.anonymousKilo === true && state.owned.includes('kilo')) ? { anonymousKilo: true as const } : {})
    };
  } catch { return; }
}

/** Claim before starting the daemon. Keep this owner alive while later signups run. */
export async function beginSetupSession(directory: string, ids: readonly string[], options: { anonymousKilo?: boolean } = {}): Promise<SetupSession> {
  if (ids.length > 100 || ids.some(id => !sourceId.test(id)) || new Set(ids).size !== ids.length) throw unavailable();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!await privateDirectory(directory)) throw unavailable();
  const id = randomUUID(), pid = process.pid, path = join(directory, `${prefix}${pid}-${id}`), claim = { id, pid, path };
  await mkdir(path, { mode: 0o700 });
  // Every contender creates its unique claim before scanning. At most one can
  // observe no other live claim; rejected contenders remove only their own.
  try {
    for (const peer of await claims(directory)) if (peer.id !== id && await blockingClaim(peer)) throw unavailable();
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  const pending = new Set(ids), verifying = new Set<string>(), controller = new AbortController();
  let anonymousKilo = options.anonymousKilo === true && ids.includes('kilo');
  let closed = false, initialized = false, failure: Error | undefined, tail: Promise<void> = Promise.resolve();
  let expires = Date.now() + ttl;
  let timer: ReturnType<typeof setInterval> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const fail = () => {
    failure ??= unavailable();
    controller.abort(failure);
    if (timer) clearInterval(timer);
    timer = undefined;
    if (expiryTimer) clearTimeout(expiryTimer);
  };
  const armExpiry = () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(fail, Math.max(0, expires - Date.now())); expiryTimer.unref();
  };
  armExpiry();
  const assertOwner = async () => {
    if (closed || controller.signal.aborted || expires <= Date.now() || !await privateDirectory(path)) throw unavailable();
    if (initialized) {
      const state = await readState(claim, true);
      if (!state || state.expires !== expires) throw unavailable();
    }
    // A committed newer owner means this one has lost authority. Initializing
    // peers will reject our current valid claim, so they cannot evict us.
    for (const peer of await claims(directory)) if (peer.id !== id && await readState(peer)) throw unavailable();
    if (controller.signal.aborted || expires <= Date.now()) throw unavailable();
  };
  const persist = () => {
    const work = tail.then(async () => {
      if (closed) return;
      await assertOwner();
      const temporary = join(path, `state.${randomUUID()}.tmp`), nextExpiry = Date.now() + ttl;
      try {
        const state: State = { version: 1, id, pid, expires: nextExpiry, owned: [...ids], pending: [...pending], verifying: [...verifying],
          ...(anonymousKilo ? { anonymousKilo: true } : {}) };
        await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
        // Slow IO must not resurrect a lease after its TTL or watchdog abort.
        await assertOwner();
        await rename(temporary, join(path, 'state.json'));
        if (controller.signal.aborted || expires <= Date.now()) throw unavailable();
        expires = nextExpiry; initialized = true; armExpiry();
      } finally { await rm(temporary, { force: true }); }
    }).catch(() => { fail(); throw failure!; });
    tail = work.catch(() => {});
    return work;
  };
  try { await persist(); }
  catch (error) { closed = true; fail(); await rm(path, { recursive: true, force: true }); throw error; }
  timer = setInterval(() => { void persist().catch(() => {}); }, heartbeat); timer.unref();
  const update = async (source: string, state: 'verify' | 'hold' | 'release') => {
    if (closed || controller.signal.aborted || !ids.includes(source)) throw unavailable();
    if (state === 'release') { pending.delete(source); verifying.delete(source); }
    else { pending.add(source); if (state === 'verify') verifying.add(source); else verifying.delete(source); }
    await persist();
    // Kilo passed verification on the session's current route; keep that route.
    if (state === 'release' && source === 'kilo') await writeKiloRoute(directory, anonymousKilo);
  };
  return {
    signal: controller.signal,
    verify: source => update(source, 'verify'),
    hold: source => update(source, 'hold'),
    release: source => update(source, 'release'),
    async useKiloAccount() {
      if (anonymousKilo) { anonymousKilo = false; await persist(); }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (expiryTimer) clearTimeout(expiryTimer);
      controller.abort(new Error('Provider setup session ended'));
      await tail;
      await rm(path, { recursive: true, force: true });
    }
  };
}
