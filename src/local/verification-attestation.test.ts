import { afterEach, expect, it, vi } from 'vitest';
import type * as Prompts from '@clack/prompts';
import { BrowserSquire } from './setup.js';

vi.mock('@clack/prompts', async importOriginal => ({ ...await importOriginal<typeof Prompts>(), confirm: vi.fn(async () => true) }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const goal = 'Verify this existing account is Starter, has no overage, and both memory settings and the data program are Off. Do not change accounts or billing.';
const offered = { DONE: 'The goal is complete', BLOCKED: 'The goal cannot be completed' };
const input = { service: 'kilo', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' } as const;

it.each(['low_confidence', 'no_progress'])('resumes an offered DONE on the same session only after explicit full-goal attestation (%s)', async status => {
  const { confirm } = await import('@clack/prompts');
  let attested = false;
  vi.mocked(confirm).mockImplementationOnce(async options => {
    expect(options.initialValue).toBe(false);
    expect(options.message).toContain('I personally verified ALL conditions');
    expect(options.message).toContain('full requested goal');
    expect(options.message).toContain('perch');
    attested = true;
    return true;
  });
  const squire = new BrowserSquire();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/perch');
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    if (!args.session_id) return { status, session_id: 'owned-perch', reason: 'No clickable targets are available', options: offered };
    expect(attested).toBe(true);
    expect(args).toMatchObject({ session_id: 'owned-perch', answer: 'DONE' });
    return { status: 'complete', session_id: 'owned-perch' };
  });
  await squire.signup('perch', 'https://perch.test', goal);
  const first = call.mock.calls.find(([name]) => name === 'operate_drive')![1];
  expect(log.mock.calls.some(([line]) => String(line).includes(String(first.goal)) && String(line).includes(goal))).toBe(true);
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(2);
  expect(vi.mocked(confirm)).toHaveBeenCalledOnce();
  await squire.close();
});

it.each([
  { field: 'captcha', options: offered },
  { options: {} },
  { options: { DONE: 'Continue' } },
  { options: { FINISHED: 'The goal is complete' } },
  { reason: 'Blocked by the provider', options: offered },
  { reason: 'Provider policy requires review', options: offered },
  { field: 'Provider policy requires review', options: offered },
  { field: 'Account blocked', options: offered }
])('keeps generic verification separate from DONE attestation: %j', async detail => {
  const { confirm } = await import('@clack/prompts');
  const squire = new BrowserSquire();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/verify');
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name === 'operate_drive'
    ? args.session_id ? { status: 'complete', session_id: 'owned-tab' } : { status: 'low_confidence', session_id: 'owned-tab', ...detail } : {});
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'running' } });
  expect(vi.mocked(confirm).mock.calls[0]![0].message).toContain('Finished verification');
  await squire.runs.get('kilo');
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive').every(([, args]) => args.answer === undefined)).toBe(true);
  await squire.close();
});

it('fails closed if the user does not attest to all goal conditions', async () => {
  const { confirm } = await import('@clack/prompts');
  vi.mocked(confirm).mockResolvedValueOnce(false);
  const squire = new BrowserSquire();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/perch');
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'low_confidence', session_id: 'owned-tab', options: offered } : {});
  await expect(squire.signup('perch', 'https://perch.test', goal)).rejects.toThrow('verification cancelled');
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(1);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'owned-tab', outcome: 'none' });
  await squire.close();
});

it('groups simultaneous explicit attestations while displaying every provider goal', async () => {
  const { confirm } = await import('@clack/prompts');
  const squire = new BrowserSquire();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/verify');
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name === 'operate_drive'
    ? { status: args.answer === 'DONE' ? 'complete' : 'low_confidence', session_id: args.session_id ?? String(args.url), options: offered } : {});
  await Promise.all([
    squire.signup('first', 'https://first.test', 'Verify the first account has only the free plan.'),
    squire.signup('second', 'https://second.test', 'Verify the second account has data sharing Off.')
  ]);
  expect(confirm).toHaveBeenCalledOnce();
  const prompt = vi.mocked(confirm).mock.calls[0]![0];
  expect(prompt.message).toContain('first, second'); expect(prompt.initialValue).toBe(false);
  expect(log.mock.calls.some(([line]) => String(line).includes('Verify the first account has only the free plan.'))).toBe(true);
  expect(log.mock.calls.some(([line]) => String(line).includes('Verify the second account has data sharing Off.'))).toBe(true);
  expect(call.mock.calls.filter(([name, args]) => name === 'operate_drive' && args.answer === 'DONE').map(([, args]) => args.session_id)).toEqual(['https://first.test', 'https://second.test']);
  await squire.close();
});

it.each([
  { status: 'rejected', reason: 'Provider denied automated signup' },
  { status: 'low_confidence', field: 'Provider policy prohibits automated signup' },
  { status: 'low_confidence', field: 'Provider denied automated signup' }
])('never offers attestation after a provider refusal even when DONE is present: %j', async response => {
  const { confirm } = await import('@clack/prompts');
  const squire = new BrowserSquire();
  const handoff = vi.spyOn(squire, 'humanHandoff');
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { ...response, session_id: 'owned-tab', options: offered } : {});
  await expect(squire.signup('perch', 'https://perch.test', goal)).rejects.toThrow('Provider refused');
  expect(confirm).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(1);
  await squire.close();
});

it.each([
  { status: 'low_confidence', options: offered },
  { status: 'no_progress', options: offered },
  { status: 'low_confidence', options: { reject: 'Reject Optional' } },
  { status: 'needs_value', field: 'captcha', options: offered },
  { status: 'stuck' }
])('stops background handoffs before sharing, attesting, or retrying while other providers continue: %j', async response => {
  const { confirm } = await import('@clack/prompts');
  const squire = new BrowserSquire({ background: true });
  const handoff = vi.spyOn(squire, 'humanHandoff');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name === 'operate_drive'
    ? args.url === 'https://other.test' ? { status: 'complete', session_id: 'other-tab' } : { ...response, session_id: 'owned-tab' } : {});
  await expect(squire.runs.start(input)).rejects.toThrow('run usegrunt setup in the foreground');
  expect(confirm).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(1);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'owned-tab', outcome: 'none' });
  await expect(squire.signup('other', 'https://other.test', 'Sign in')).resolves.toBeUndefined();
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(2);
  expect(call.mock.calls.filter(([name]) => name === 'operate_share')).toHaveLength(0);
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive').every(([, args]) => args.answer === undefined)).toBe(true);
  await squire.close();
});
