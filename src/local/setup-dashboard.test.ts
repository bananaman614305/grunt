import { afterEach, expect, it, vi } from 'vitest';
import { observeTerminal, terminalBusy, withTerminal } from './terminal.js';
import { startSetupDashboard, watchSetupDashboard } from './setup-dashboard.js';
import { startDashboard, statusCommand } from './dashboard.js';
import { VerificationQueue } from './verification-queue.js';

vi.mock('./dashboard.js', () => ({ startDashboard: vi.fn(), statusCommand: vi.fn(async () => {}) }));
const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
  if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY); else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY); else Reflect.deleteProperty(process.stdout, 'isTTY');
});
function tty() {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  vi.stubEnv('TERM', 'xterm'); vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '0');
}

it('suspends the passive dashboard before a queued confirmation owns the terminal and resumes after failure', async () => {
  tty();
  const stopped = deferred(), hold = deferred(), entered = deferred(), order: string[] = [];
  const display = { done: stopped.promise, stop: vi.fn(async () => { stopped.resolve(); }),
    pause: vi.fn(() => { order.push('pause'); }), resume: vi.fn(() => { order.push('resume'); }) };
  vi.mocked(startDashboard).mockReturnValue(display);
  const dashboard = startSetupDashboard({ port: 8792, signal: new AbortController().signal, approvals: () => ['perch'] })!;
  expect(startDashboard).toHaveBeenCalledWith(expect.objectContaining({ interactive: false, setup: true, port: 8792 }));
  const owning = withTerminal(async () => { order.push('prompt'); entered.resolve(); await hold.promise; throw new Error('cancelled'); });
  const expected = expect(owning).rejects.toThrow('cancelled');
  await entered.promise;
  expect(order.slice(-2)).toEqual(['pause', 'prompt']);
  expect(terminalBusy()).toBe(true);
  hold.resolve(); await expected;
  expect(order.at(-1)).toBe('resume');
  expect(terminalBusy()).toBe(false);
  await dashboard.stop();
  const changes = order.length;
  await withTerminal(async () => {});
  expect(order).toHaveLength(changes);
  expect(display.stop).toHaveBeenCalledOnce();
});

it('starts hidden when a confirmation already owns stdin and never reattaches after its display ends', async () => {
  tty();
  const stopped = deferred(), hold = deferred(), entered = deferred();
  const display = { done: stopped.promise, stop: vi.fn(async () => {}), pause: vi.fn(), resume: vi.fn() };
  vi.mocked(startDashboard).mockReturnValue(display);
  const owning = withTerminal(async () => { entered.resolve(); await hold.promise; });
  await entered.promise;
  const dashboard = startSetupDashboard({ port: 8792, signal: new AbortController().signal, approvals: () => [] })!;
  expect(display.pause).toHaveBeenCalledOnce();
  expect(display.resume).not.toHaveBeenCalled();
  stopped.resolve(); await stopped.promise;
  hold.resolve(); await owning;
  expect(display.resume).not.toHaveBeenCalled();
  await dashboard.stop();
});

it('keeps noninteractive setup finite without polling or installing any display', async () => {
  tty(); Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  expect(startSetupDashboard({ port: 8792, signal: new AbortController().signal, approvals: () => [] })).toBeUndefined();
  await watchSetupDashboard(8792);
  expect(startDashboard).not.toHaveBeenCalled(); expect(statusCommand).not.toHaveBeenCalled();
});

it('opens the interactive view on the actual service port only after setup asks for it', async () => {
  tty(); await watchSetupDashboard(8792);
  expect(statusCommand).toHaveBeenCalledExactlyOnceWith(['--watch', '--port', '8792']);
});

it('isolates broken status observers from terminal ownership and cleans them up', async () => {
  const observer = vi.fn(() => { throw new Error('display failed'); });
  const unsubscribe = observeTerminal(observer);
  await expect(withTerminal(async () => 'confirmed')).resolves.toBe('confirmed');
  expect(terminalBusy()).toBe(false); expect(observer).toHaveBeenCalledTimes(3);
  unsubscribe();
});

it('projects only distinct safe service IDs while active and queued verifications settle', async () => {
  const hold = deferred(), entered = deferred();
  const queue = new VerificationQueue(async () => { entered.resolve(); await hold.promise; });
  const seen: string[][] = [];
  const unsubscribe = queue.subscribe(services => { seen.push([...services]); });
  const first = queue.wait({ service: 'perch', url: 'https://secret.test/capability-token', goal: 'private requested goal' });
  await entered.promise;
  const next = queue.wait({ service: 'clixad', url: 'https://secret.test/other-token' });
  const duplicate = queue.wait({ service: 'perch', url: 'https://secret.test/third-token' });
  expect(queue.services()).toEqual(['perch', 'clixad']);
  expect(JSON.stringify(seen)).not.toMatch(/secret|token|private|goal|https/);
  hold.resolve(); await Promise.all([first, next, duplicate]);
  expect(queue.services()).toEqual([]); expect(seen.at(-1)).toEqual([]);
  unsubscribe();
});

it('clears approval IDs after cancellation without emitting URL-shaped or terminal-control IDs', async () => {
  const hold = deferred(), entered = deferred();
  const queue = new VerificationQueue(async () => { entered.resolve(); await hold.promise; throw new Error('cancelled'); });
  const first = queue.wait({ service: 'perch', url: 'https://one.test' });
  await entered.promise;
  const bad = queue.wait({ service: '\u001b[31mhttps://secret.test', url: 'https://two.test' });
  expect(queue.services()).toEqual(['perch']);
  const finished = Promise.allSettled([first, bad]);
  hold.resolve(); expect((await finished).every(item => item.status === 'rejected')).toBe(true);
  expect(queue.services()).toEqual([]);
});
