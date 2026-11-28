import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SignupSession } from '@trusty-squire/mcp/signup';
import { BrowserSquire } from './setup.js';
import { signupIdentityEmail } from './signup-mcp.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'signup-recovery-')); vi.stubEnv('GRUNT_SQUIRE_AUTO_UPDATE', '0'); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

type Args = Record<string, unknown>;
const unsure = (options: Record<string, string>) => ({ status: 'low_confidence', session_id: 'tab', question: 'Choose one current target key, or DONE, BLOCKED, NONE_OF_THESE, or WAIT.', options });

it('fills a supplied email once when an unsure drive offers its field', async () => {
  const squire = new BrowserSquire({ directory });
  const drives: Args[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    drives.push(args);
    return drives.length === 1
      ? unsure({ kemail_use_an_address: 'Email Use an address that can receive mail.', klost_your_key: 'Lost your key? Get a new one by email.', WAIT: 'Wait' })
      : { status: 'complete', session_id: 'tab' };
  });
  await squire.signup('100milionseek', 'https://100milionseek.top/signup', 'Create a free key', { email: 'person@example.com' });
  expect(drives[0]!.facts).toMatchObject({ email: 'person@example.com' });
  expect(drives[1]!.answer).toBe('kemail_use_an_address');
  await squire.close();
});

it('presses a documented next control once, never while it is disabled', async () => {
  const squire = new BrowserSquire({ directory, background: true });
  const answers: unknown[] = [];
  let turn = 0;
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    answers.push(args.answer);
    turn++;
    if (turn === 1) return unsure({ kcreate_my_key_s_d_v_offscreen: 'Create my key', WAIT: 'Wait' });
    if (turn === 2) return unsure({ kcreate_my_key_v_offscreen: 'Create my key', WAIT: 'Wait' });
    if (turn === 3) return unsure({ kcreate_my_key_v_offscreen: 'Create my key', kcopy_key_b: 'Copy key' });
    return { status: 'complete', session_id: 'tab' };
  });
  await squire.signup('100milionseek', 'https://100milionseek.top/signup', 'Create a free key');
  // The disabled control waits; the enabled one is pressed once, then Copy key once.
  expect(answers).toEqual([undefined, undefined, 'kcreate_my_key_v_offscreen', 'kcopy_key_b']);
  await squire.close();
});

it('never presses an undocumented or paid control on an unsure drive', async () => {
  const squire = new BrowserSquire({ directory, background: true });
  const answers: unknown[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    answers.push(args.answer);
    return unsure({ kbuy_a_pass: 'Create my key with a paid pass', kget_30_days: 'Get 30 days for $69.99' });
  });
  await expect(squire.signup('perch', 'https://chat.perchai.app/', 'Check the free plan')).rejects.toThrow('recovery limit');
  expect(answers.filter(Boolean)).toEqual([]);
  await squire.close();
});

it('observes after an unfinished turn so Squire can solve a gated CAPTCHA, unless an operator drives', async () => {
  const squire = new BrowserSquire({ directory, background: true });
  const calls: string[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async name => {
    calls.push(name);
    if (name !== 'operate_drive') return {};
    return calls.filter(item => item === 'operate_drive').length === 1 ? unsure({ WAIT: 'Wait' }) : { status: 'complete', session_id: 'tab' };
  });
  await squire.signup('100milionseek', 'https://100milionseek.top/signup', 'Create a free key');
  expect(calls).toEqual(['operate_drive', 'operate_observe', 'operate_drive', 'operate_finish']);
  await squire.close();
  // An operator observes the page itself; Grunt adds no observation of its own.
  const driven = new BrowserSquire({ directory, background: true });
  const operatorCalls: string[] = [];
  vi.spyOn(driven, 'call').mockImplementation(async name => {
    operatorCalls.push(name);
    if (name !== 'operate_drive') return {};
    return operatorCalls.filter(item => item === 'operate_drive').length === 1 ? unsure({ WAIT: 'Wait' }) : { status: 'complete', session_id: 'tab' };
  });
  driven.useSignupAgent(async agent => { await agent.call('operate_drive', {}); });
  await driven.signup('100milionseek', 'https://100milionseek.top/signup', 'Create a free key');
  expect(operatorCalls).not.toContain('operate_observe');
  await driven.close();
});

it('hands provider capture sources to the embedded drive', async () => {
  await mkdir(join(directory, 'browser-profile'), { recursive: true });
  const session: SignupSession = { apiBaseUrl: 'https://api.example.test', registryBaseUrl: 'https://registry.example.test', accountId: 'a', agentSessionToken: 't', machineToken: 'm', savedAt: new Date().toISOString() };
  const drive = vi.fn(async () => ({ status: 'completed' as const, service: '100milionseek', url: 'https://100milionseek.top/signup', captured: false, credentials: [] }));
  const createSignupSession = vi.fn(async () => ({ service: '100milionseek', sessionId: 's', currentUrl: null, closed: false, credentials: [], drive, click: vi.fn(), observe: vi.fn(), close: vi.fn(async () => {}) }));
  const squire = new BrowserSquire({ directory, embeddedRuntime: { createSignupSession: createSignupSession as never } });
  (squire as unknown as { signupSession: SignupSession }).signupSession = session;
  const drove = async (service: string, url: string) => {
    const result = await squire.call('operate_drive', { service, url, goal: 'Create a free key' });
    // One embedded session holds the profile lease; finish it before the next provider.
    await squire.call('operate_finish', { session_id: result.session_id });
  };
  await drove('100milionseek', 'https://100milionseek.top/signup');
  expect(drive).toHaveBeenLastCalledWith(expect.objectContaining({ captureSource: [{ selector: '#done [data-p="key"]' }, { selector: '#reissued [data-p="key"]' }] }));
  await drove('pollinations', 'https://enter.pollinations.ai/keys');
  expect(drive).toHaveBeenLastCalledWith(expect.objectContaining({ captureSource: [{ selector: 'button[aria-label="Copy secret key"] > span:first-child' }] }));
  await drove('zro', 'https://zro.moonmath.ai/overview');
  expect(drive).toHaveBeenLastCalledWith(expect.not.objectContaining({ captureSource: expect.anything() }));
  await squire.close();
});

it('reads the single Google identity signed in to the Grunt profile', async () => {
  const preferences = join(directory, 'browser-profile', 'Default', 'Preferences');
  await mkdir(join(directory, 'browser-profile', 'Default'), { recursive: true });
  expect(await signupIdentityEmail(directory)).toBeUndefined();
  await writeFile(preferences, JSON.stringify({ account_info: [{ email: ' Person@Example.com ' }] }));
  expect(await signupIdentityEmail(directory)).toBe('person@example.com');
  await writeFile(preferences, JSON.stringify({ account_info: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }));
  expect(await signupIdentityEmail(directory)).toBeUndefined();
  await writeFile(preferences, JSON.stringify({ account_info: [{ email: 'not an email' }] }));
  expect(await signupIdentityEmail(directory)).toBeUndefined();
});

it('stops at once when Squire waits on verification mail this session may not read', async () => {
  const waiting = { status: 'budget', session_id: 'tab', reason: 'drive budget ended while waiting for verification mail' };
  for (const consent of [false, true]) {
    const squire = new BrowserSquire({ directory, background: true });
    (squire as unknown as { signupSession: Partial<SignupSession> }).signupSession = { consentOperatorInboxOtp: consent };
    let drives = 0;
    vi.spyOn(squire, 'call').mockImplementation(async name => {
      if (name !== 'operate_drive') return {};
      return ++drives < 3 ? waiting : { status: 'complete', session_id: 'tab' };
    });
    const run = squire.signup('openference', 'https://openference.com/register', 'Create a free key');
    if (consent) await run;
    else await expect(run).rejects.toThrow('verification email needs inbox consent');
    // With consent the drive resumes polling; without it there is nothing to wait for.
    expect(drives).toBe(consent ? 3 : 1);
    await squire.close();
  }
});

it('offers a supplied device code under the page code field label once', async () => {
  const squire = new BrowserSquire({ directory, background: true });
  const drives: Args[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    drives.push(structuredClone(args));
    return drives.length < 3
      ? { ...unsure({ WAIT: 'Wait' }), observation: { url: 'https://cli.example.test/device', safe_table: [['e1', 't', '@code-shown-in-your-terminal|w=9|ph=ABCD-EFGH'], ['e2', 'b', '@approve']] } }
      : { status: 'complete', session_id: 'tab' };
  });
  await squire.signup('omi', 'https://cli.example.test/device', 'Approve the CLI sign-in', { user_code: 'ABCD-EFGH' });
  expect(drives[0]!.facts).not.toHaveProperty('code-shown-in-your-terminal');
  expect(drives[1]!.facts).toMatchObject({ 'code-shown-in-your-terminal': 'ABCD-EFGH', user_code: 'ABCD-EFGH' });
  await squire.close();
});
