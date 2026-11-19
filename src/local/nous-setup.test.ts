import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { NOUS_LOGIN_NEEDED, nousApprovalURL, setupNous } from './nous-setup.js';
import { setupAttention, setupFailureReason } from './setup-failure.js';
import { planSteps } from './fixtures/key-only-goal.js';

const profile = vi.hoisted(() => ({ ready: false }));
vi.mock('./nous.js', () => ({
  checkNousProfile: vi.fn(async () => profile.ready),
  nousHermesPaths: vi.fn(() => { throw new Error('tests do not install Hermes'); })
}));

afterEach(() => { profile.ready = false; vi.restoreAllMocks(); });

it('accepts the official Hermes device approval link', () => {
  const url = 'https://portal.nousresearch.com/manage-subscription?user_code=TEST-1234';
  expect(nousApprovalURL(`  1. Open: ${url}`)?.href).toBe(url);
});

it.each([
  'https://example.test/manage-subscription?user_code=TEST-1234',
  'https://portal.nousresearch.com/anything?user_code=TEST-1234',
  'https://portal.nousresearch.com/manage-subscription?user_code=TEST-1234&paid=true',
  'https://portal.nousresearch.com/manage-subscription?user_code=WRONG'
])('rejects a different approval target', url => {
  expect(nousApprovalURL(`  1. Open: ${url}`)).toBeUndefined();
});

const link = 'https://portal.nousresearch.com/manage-subscription?user_code=ABCD-1234';
function fakeLogin() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null as number | null, signalCode: null, kill: vi.fn(() => {
    child.exitCode = 1; child.emit('close', 1); return true;
  }) });
  setImmediate(() => child.stdout.write(`Nous device login\n  1. Open: ${link}\n  2. Enter code ABCD-1234\n`));
  return child;
}
function captureOutput() {
  const written: string[] = [];
  const keep = (value: unknown) => { written.push(String(value)); return true; };
  vi.spyOn(process.stdout, 'write').mockImplementation(keep);
  vi.spyOn(process.stderr, 'write').mockImplementation(keep);
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(keep);
  return written;
}

it('sends the device login to Squire and prints nothing', async () => {
  const written = captureOutput();
  const child = fakeLogin();
  const signup = vi.fn(async (_service: string, url: string) => {
    expect(url).toBe(link);
    profile.ready = true;
    child.exitCode = 0; child.emit('close', 0);
  });
  const connect = vi.fn(async () => {});
  const notify = vi.fn();
  await setupNous({ directory: '/nonexistent', notify, squire: { signup }, connect, spawnLogin: () => child as never });
  expect(connect).toHaveBeenCalledOnce();
  expect(signup).toHaveBeenCalledWith('nous', link, expect.stringContaining(link));
  expect(planSteps(String(signup.mock.calls[0]![2]))).toEqual([]);
  expect(written.join('')).not.toMatch(/user_code|portal\.nousresearch\.com|ABCD-1234/);
  expect(notify.mock.calls.flat().join('')).not.toMatch(/user_code|portal\.nousresearch\.com/);
});

it('ends with needs you (Nous login) when Squire cannot approve, without printing the link', async () => {
  const written = captureOutput();
  const child = fakeLogin();
  const signup = vi.fn(async () => { throw new Error('browser could not continue'); });
  const error = await setupNous({ directory: '/nonexistent', notify: () => {}, squire: { signup }, spawnLogin: () => child as never }).catch(failure => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(NOUS_LOGIN_NEEDED);
  expect(setupAttention(setupFailureReason(error))).toBe('Nous login');
  expect(child.kill).toHaveBeenCalled();
  expect(written.join('')).not.toMatch(/user_code|portal\.nousresearch\.com|ABCD-1234/);
});

it('ends with needs you when no Squire browser is available', async () => {
  const child = fakeLogin();
  await expect(setupNous({ directory: '/nonexistent', notify: () => {}, spawnLogin: () => child as never })).rejects.toThrow(NOUS_LOGIN_NEEDED);
});
