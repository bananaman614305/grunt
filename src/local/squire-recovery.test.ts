import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import type * as Prompts from '@clack/prompts';

vi.mock('@clack/prompts', async importOriginal => ({ ...await importOriginal<typeof Prompts>(), confirm: vi.fn(async () => true) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const input = { service: 'kilo', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' } as const;

it('dismisses the observed cookie overlay without treating echoed instructions as a refusal', async () => {
  const squire = new BrowserSquire();
  const handoff = vi.spyOn(squire, 'humanHandoff');
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    return args.answer ? { status: 'complete', session_id: 'cookie-tab' }
      : { status: 'low_confidence', session_id: 'cookie-tab', reason: 'model confidence is below the drive threshold', remaining: args.goal,
        options: { cookie_reject: 'Reject Optional', cookie_accept: 'Accept All' } };
  });
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'completed' } });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'cookie-tab', answer: 'cookie_reject' }));
  expect(call).toHaveBeenCalledWith('operate_finish', expect.objectContaining({ session_id: 'cookie-tab', outcome: 'result' }));
  expect(handoff).not.toHaveBeenCalled();
  await squire.close();
  expect(call.mock.calls.filter(([name]) => name === 'operate_finish')).toHaveLength(1);
});

it('does not loop when the same cookie choice fails to advance the page', async () => {
  vi.stubEnv('MILO_SETUP_NO_HUMAN', '1');
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name === 'operate_drive'
    ? { status: 'low_confidence', session_id: 'stuck-tab', remaining: args.goal, options: { reject: 'Reject Optional' } } : {});
  await expect(squire.runs.start(input)).rejects.toThrow('needs human verification');
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(2);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'stuck-tab', outcome: 'none' });
});

it('shares an unresolved page and resumes that session instead of guessing a Continue action', async () => {
  const squire = new BrowserSquire();
  const handoff = vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/tab');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let drives = 0;
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => {
    if (name !== 'operate_drive') return {};
    return ++drives === 1 ? { status: 'no_progress', session_id: 'unknown-tab', options: { next: 'Continue' } }
      : { status: 'complete', session_id: 'unknown-tab' };
  });
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'running' } });
  expect(handoff).toHaveBeenCalledWith('unknown-tab');
  await expect(squire.runs.get('kilo')).resolves.toMatchObject({ state: 'completed' });
  const requests = call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => args);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ session_id: 'unknown-tab' });
  expect(requests.every(args => args.answer === undefined)).toBe(true);
});

it('closes a refused browser without obscuring the refusal reason', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'rejected', session_id: 'refused-tab', reason: 'Provider denied automated signup.' } : {});
  await expect(squire.runs.start(input)).rejects.toThrow('Provider denied automated signup.');
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'refused-tab', outcome: 'none' });
});

it('cleans up a resumable browser when a later driver call fails', async () => {
  const squire = new BrowserSquire();
  let drives = 0;
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => {
    if (name !== 'operate_drive') return {};
    if (++drives === 1) return { status: 'budget', session_id: 'budget-tab' };
    throw new Error('Driver disconnected');
  });
  await squire.runs.start(input);
  await expect(squire.runs.get('kilo')).rejects.toThrow('Driver disconnected');
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'budget-tab', outcome: 'none' });
});

it('closes outstanding browser sessions when setup stops between resumable calls', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'budget', session_id: 'abandoned-tab' } : {});
  await squire.runs.start(input);
  await squire.close();
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'abandoned-tab', outcome: 'none' });
  await expect(squire.runs.get('kilo')).rejects.toThrow('setup is closed');
});

it('keeps a custom signup goal when recovering a cookie overlay', async () => {
  const squire = new BrowserSquire();
  const goal = 'Pair this existing Freebuff CLI session. Do not create API credentials.';
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    return args.answer ? { status: 'complete', session_id: 'pairing-tab' }
      : { status: 'low_confidence', session_id: 'pairing-tab', remaining: goal, options: { reject: 'Reject Optional' } };
  });
  await squire.signup('freebuff', 'https://freebuff.test/login', goal);
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive').every(([, args]) => String(args.goal).startsWith(goal) && String(args.goal).includes('Do not opt in to optional prompt/response retention'))).toBe(true);
});

it('cancels an outstanding human prompt before closing its browser', async () => {
  const { confirm } = await import('@clack/prompts');
  let started!: () => void;
  const prompted = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(confirm).mockImplementationOnce(options => new Promise(resolve => {
    started();
    options.signal!.addEventListener('abort', () => resolve(false), { once: true });
  }));
  const squire = new BrowserSquire();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/captcha');
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'needs_value', field: 'captcha', session_id: 'captcha-tab' } : {});
  const signup = squire.runs.start(input).catch(error => error);
  await prompted;
  await squire.close();
  expect(await signup).toBeInstanceOf(Error);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'captcha-tab', outcome: 'none' });
});
