import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate, setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { beginSetupSession, readSetupSession } from './setup-session.js';
import type { SetupSession } from './setup-session.js';

const directories: string[] = [], sessions: SetupSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() { const path = await mkdtemp(join(tmpdir(), 'grunt-setup-session-')); directories.push(path); return path; }
async function begin(path: string, ids = ['kilo', 'perch']) { const session = await beginSetupSession(path, ids); sessions.push(session); return session; }
async function statePath(directory: string) { const names = (await readdir(directory)).filter(name => name.startsWith('.setup-session-')); return join(directory, names[0]!, 'state.json'); }
async function saved(directory: string) { return JSON.parse(await readFile(await statePath(directory), 'utf8')); }

it('owns the full batch while releasing providers independently without exposing any credentials', async () => {
  const path = await directory(), session = await begin(path);
  expect(await readSetupSession(path)).toEqual({ owned: new Set(['kilo', 'perch']), pending: new Set(['kilo', 'perch']), verifying: new Set() });
  await session.release('kilo');
  expect(await readSetupSession(path)).toEqual({ owned: new Set(['kilo', 'perch']), pending: new Set(['perch']), verifying: new Set() });
  const metadata = await lstat(await statePath(path)); expect(metadata.mode & 0o777).toBe(0o600);
  expect(Object.keys(await saved(path)).sort()).toEqual(['expires', 'id', 'owned', 'pending', 'pid', 'verifying', 'version']);
  await session.close(); expect(await readSetupSession(path)).toBeUndefined();
});

it('rejects a second installer without changing the active lease', async () => {
  const path = await directory(); await begin(path);
  const before = await readFile(await statePath(path));
  await expect(beginSetupSession(path, ['opencode'])).rejects.toThrow('finish the existing setup');
  expect(await readFile(await statePath(path))).toEqual(before);
  expect((await readdir(path)).filter(name => name.startsWith('.setup-session-'))).toHaveLength(1);
});

it('concurrent claims cannot both become active installers', async () => {
  const path = await directory();
  const result = await Promise.allSettled([beginSetupSession(path, ['kilo']), beginSetupSession(path, ['perch'])]);
  const successful = result.filter((item): item is PromiseFulfilledResult<SetupSession> => item.status === 'fulfilled');
  expect(successful.length).toBeLessThanOrEqual(1);
  sessions.push(...successful.map(item => item.value));
});

it('serializes simultaneous releases so neither provider is lost', async () => {
  const path = await directory(), session = await begin(path);
  await Promise.all([session.release('kilo'), session.release('perch')]);
  expect(await readSetupSession(path)).toEqual({ owned: new Set(['kilo', 'perch']), pending: new Set(), verifying: new Set() });
  await expect(session.release('unselected')).rejects.toThrow('coordinate provider setup');
});

it('keeps verification separate from admission and can hold a failed probe', async () => {
  const path = await directory(), session = await begin(path);
  await session.verify('perch');
  expect(await readSetupSession(path)).toEqual({ owned: new Set(['kilo', 'perch']), pending: new Set(['kilo', 'perch']), verifying: new Set(['perch']) });
  await session.hold('perch');
  expect((await readSetupSession(path))?.verifying.size).toBe(0);
  expect((await readSetupSession(path))?.pending.has('perch')).toBe(true);
  await session.verify('perch'); await session.release('perch');
  expect(await readSetupSession(path)).toEqual({ owned: new Set(['kilo', 'perch']), pending: new Set(['kilo']), verifying: new Set() });
});

it('shares approval IDs with a separate status reader without admitting the provider or storing browser links', async () => {
  const path = await directory(), session = await begin(path);
  await session.setApprovals(['perch']);
  const state = await readSetupSession(path);
  expect(state?.approvals).toEqual(new Set(['perch']));
  expect(state?.pending).toEqual(new Set(['kilo', 'perch']));
  await expect(session.setApprovals(['https://example.invalid/private-handoff'])).rejects.toThrow('coordinate provider setup');
  expect(JSON.stringify(await saved(path))).not.toContain('https:');
  await session.verify('perch');
  expect((await readSetupSession(path))?.approvals).toBeUndefined();
  await session.setApprovals(['perch']);
  expect((await readSetupSession(path))?.approvals).toBeUndefined();
  await session.release('perch');
  expect((await readSetupSession(path))?.pending.has('perch')).toBe(false);
});

it('ignores corrupt optional approval metadata while preserving a valid setup exclusion', async () => {
  const path = await directory(); await begin(path);
  const file = await statePath(path), state = await saved(path);
  state.approvals = ['https://example.invalid/private-handoff', 'unselected', 42, 'perch'];
  await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  const read = await readSetupSession(path);
  expect(read?.pending).toEqual(new Set(['kilo', 'perch']));
  expect(read?.approvals).toEqual(new Set(['perch']));
});

it('expires routing exclusions when the owner stops heartbeating', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const path = await directory(); await begin(path);
  vi.setSystemTime(Date.now() + 91000);
  expect(await readSetupSession(path)).toBeUndefined();
});

it('aborts at the TTL even if a heartbeat never gets to finish', async () => {
  // Advance the watchdog clock without running the separate real interval.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const path = await directory(), session = await begin(path);
  await vi.advanceTimersByTimeAsync(91000);
  expect(session.signal.aborted).toBe(true);
  expect(await readSetupSession(path)).toBeUndefined();
  await expect(session.release('kilo')).rejects.toThrow('coordinate provider setup');
});

it('allows a new installer after expiry even if the stale PID is alive, and the old owner cannot renew', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const path = await directory(), old = await begin(path);
  vi.setSystemTime(Date.now() + 91000);
  const next = await begin(path, ['opencode']);
  await expect(old.release('kilo')).rejects.toThrow('coordinate provider setup');
  expect(old.signal.aborted).toBe(true);
  expect((await readSetupSession(path))?.owned).toEqual(new Set(['opencode']));
  await old.close(); expect((await readSetupSession(path))?.owned).toEqual(new Set(['opencode']));
  await next.close();
});

it('aborts the owning signup tasks when the heartbeat cannot safely persist', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const path = await directory(), session = await begin(path);
  const aborted = vi.fn();
  const heartbeatAborted = new Promise<void>(resolve => session.signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
  await chmod(await statePath(path), 0o644);
  await vi.advanceTimersByTimeAsync(15000);
  // The fake interval starts real filesystem work; wait for its abort event,
  // rather than assuming a number of event-loop turns completes that work.
  const deadline = new AbortController();
  try {
    await Promise.race([heartbeatAborted, realDelay(2000, undefined, { signal: deadline.signal }).then(() => { throw new Error('Heartbeat did not abort its signup tasks'); })]);
  } finally { deadline.abort(); }
  expect(session.signal.aborted).toBe(true); expect(aborted).toHaveBeenCalledOnce();
  await expect(session.verify('kilo')).rejects.toThrow('coordinate provider setup');
  // Until the owner cleans up, corrupt state cannot trigger duplicate setup.
  expect((await readSetupSession(path))?.owned.has('kilo')).toBe(true);
  await session.close(); expect(await readSetupSession(path)).toBeUndefined();
});

it('renews the pending snapshot while the foreground owner is alive', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const path = await directory(); await begin(path);
  const initial = await saved(path);
  await vi.advanceTimersByTimeAsync(15000);
  let current = initial;
  for (let i = 0; i < 100 && current.expires === initial.expires; i++) { await setImmediate(); current = await saved(path); }
  expect(current.expires).toBeGreaterThan(initial.expires);
  expect((await readSetupSession(path))?.pending).toEqual(new Set(['kilo', 'perch']));
});

it('ignores a crashed owner and allows a new installer without deleting unrelated state', async () => {
  const path = await directory(), session = await begin(path), original = await statePath(path);
  const state = await saved(path);
  await session.close();
  const deadPid = 2147483647, name = `.setup-session-${deadPid}-${state.id}`;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(path, name), { mode: 0o700 });
  await writeFile(join(path, name, 'state.json'), JSON.stringify({ ...state, pid: deadPid }), { mode: 0o600 });
  expect(await readSetupSession(path)).toBeUndefined();
  const next = await begin(path, ['opencode']);
  expect((await readSetupSession(path))?.owned).toEqual(new Set(['opencode']));
  await next.close();
  expect(await readFile(join(path, name, 'state.json'), 'utf8')).toContain(state.id);
  expect(original).not.toContain(name);
});

it.each(['malformed', 'wrong-owner', 'world-readable', 'symlink', 'unknown-pending'])('holds routes conservatively for an active unsafe %s snapshot', async kind => {
  const path = await directory(); await begin(path); const file = await statePath(path), state = await saved(path);
  if (kind === 'malformed') await writeFile(file, '{');
  if (kind === 'wrong-owner') await writeFile(file, JSON.stringify({ ...state, pid: state.pid + 1 }));
  if (kind === 'world-readable') await chmod(file, 0o644);
  if (kind === 'unknown-pending') await writeFile(file, JSON.stringify({ ...state, pending: ['not-owned'] }));
  if (kind === 'symlink') { const outside = join(path, 'outside.json'); await writeFile(outside, JSON.stringify(state), { mode: 0o600 }); await rm(file); await symlink(outside, file); }
  const blocked = await readSetupSession(path);
  expect(blocked?.pending.has('kilo')).toBe(true); expect(blocked?.owned.has('perch')).toBe(true);
  expect(blocked?.verifying.size).toBe(0);
});

it('closing an old session cannot remove a newer session', async () => {
  const path = await directory(), old = await begin(path); await old.close();
  const next = await begin(path, ['opencode']); await old.close();
  expect((await readSetupSession(path))?.owned).toEqual(new Set(['opencode']));
  await next.close(); await expect(next.release('opencode')).rejects.toThrow('coordinate provider setup');
});
