import { afterEach, expect, it, vi } from 'vitest';
import { guardedSignupChoice } from './signup-mcp.js';
import { BrowserSquire } from './setup.js';
import type * as Prompts from '@clack/prompts';
import { BROWSER_CONCURRENCY, parallelMap, SETUP_CONCURRENCY } from './parallel.js';

vi.mock('@clack/prompts', async importOriginal => ({ ...await importOriginal<typeof Prompts>(), confirm: vi.fn(async () => true) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const input = { service: 'kilo', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('shares one connection across six setup jobs and caps actual browser RPCs at three', async () => {
  const squire = new BrowserSquire();
  const internals = squire as unknown as { connectOnce(): Promise<void>; client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } };
  const connected = deferred<void>(), release = deferred<void>();
  const connect = vi.spyOn(internals, 'connectOnce').mockImplementation(() => connected.promise);
  const started: number[] = [];
  let active = 0, peak = 0;
  const rpc = vi.spyOn(internals.client, 'callTool').mockImplementation(async request => {
    const { name } = request as { name: string };
    if (name === 'operate_drive' || name === 'operate_start') {
      active++; peak = Math.max(peak, active);
      await release.promise; active--;
    }
    return { content: [], structuredContent: {} };
  });
  vi.spyOn(internals.client, 'close').mockResolvedValue();
  const pending = parallelMap(Array.from({ length: 12 }, (_, i) => i), async i => {
    started.push(i);
    await squire.connect();
    // Exercise the public RPC path used by provider helpers as well as drive.
    await squire.call(i % 2 ? 'operate_start' : 'operate_drive', { service: `provider-${i}` });
  }, SETUP_CONCURRENCY);
  expect(started).toEqual([0, 1, 2, 3, 4, 5]); expect(connect).toHaveBeenCalledOnce();
  connected.resolve();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(BROWSER_CONCURRENCY));
  expect(active).toBe(3); release.resolve(); await pending;
  expect(peak).toBe(3); expect(active).toBe(0); expect(connect).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledTimes(12);
  await squire.close();
});

it('removes a cancelled queued provider before dispatch and lets the next provider continue', async () => {
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } }).client;
  const release = deferred<void>();
  const urls: unknown[] = [];
  vi.spyOn(client, 'callTool').mockImplementation(async request => {
    const { name, arguments: args } = request as { name: string; arguments: Record<string, unknown> };
    if (name === 'operate_drive') {
      urls.push(args.url);
      await release.promise;
      return { content: [], structuredContent: { status: 'complete', session_id: `tab-${urls.indexOf(args.url)}` } };
    }
    return { content: [], structuredContent: {} };
  });
  vi.spyOn(client, 'close').mockResolvedValue();
  const first = Array.from({ length: 3 }, (_, i) => squire.signup(`first-${i}`, `https://first-${i}.test`, 'Sign in'));
  const cancelled = squire.signup('queued', 'https://queued.test', 'Sign in').catch(error => error);
  const other = squire.signup('other', 'https://other.test', 'Sign in');
  await vi.waitFor(() => expect(urls).toHaveLength(3));
  await squire.cancelSignup('queued');
  expect(await cancelled).toBeInstanceOf(Error);
  release.resolve(); await Promise.all([...first, other]);
  expect(urls).toEqual(['https://first-0.test', 'https://first-1.test', 'https://first-2.test', 'https://other.test']);
  await squire.close();
});

it('keeps a dispatched initial RPC in its browser slot until late session cleanup is possible', async () => {
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } }).client;
  const releases = Array.from({ length: 3 }, () => deferred<void>());
  const urls: unknown[] = [];
  const rpc = vi.spyOn(client, 'callTool').mockImplementation(async request => {
    const { name, arguments: args } = request as { name: string; arguments: Record<string, unknown> };
    if (name === 'operate_drive') {
      urls.push(args.url);
      const initial = /^https:\/\/initial-(\d)\.test$/.exec(String(args.url));
      if (initial) await releases[Number(initial[1])]!.promise;
      return { content: [], structuredContent: { status: 'complete', session_id: String(args.url) } };
    }
    return { content: [], structuredContent: {} };
  });
  vi.spyOn(client, 'close').mockResolvedValue();
  const initial = releases.map((_, i) => squire.signup(`initial-${i}`, `https://initial-${i}.test`, 'Sign in').catch(error => error));
  await vi.waitFor(() => expect(urls).toHaveLength(3));
  await squire.cancelSignup('initial-0'); expect(await initial[0]).toBeInstanceOf(Error);
  const other = squire.signup('other', 'https://other.test', 'Sign in');
  await new Promise(resolve => setImmediate(resolve));
  expect(urls).toHaveLength(3);
  releases[0]!.resolve(); await other;
  await vi.waitFor(() => expect(rpc.mock.calls.some(([request]) => {
    const value = request as { name: string; arguments: Record<string, unknown> };
    return value.name === 'operate_finish' && value.arguments.session_id === 'https://initial-0.test' && value.arguments.outcome === 'none';
  })).toBe(true));
  expect(urls).toHaveLength(4);
  releases[1]!.resolve(); releases[2]!.resolve();
  await Promise.all(initial); await squire.close();
});

it('cancels queued browser work on close while retaining late owned session cleanup', async () => {
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } }).client;
  const release = deferred<void>();
  const rpc = vi.spyOn(client, 'callTool').mockImplementation(async request => {
    const { name, arguments: args } = request as { name: string; arguments: Record<string, unknown> };
    if (name === 'operate_drive') {
      await release.promise;
      return { content: [], structuredContent: { status: 'complete', session_id: String(args.url) } };
    }
    return { content: [], structuredContent: {} };
  });
  const closed = vi.spyOn(client, 'close').mockResolvedValue();
  const jobs = Array.from({ length: 6 }, (_, i) => squire.signup(`provider-${i}`, `https://provider-${i}.test`, 'Sign in').catch(error => error));
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
  const closing = squire.close();
  expect(closed).not.toHaveBeenCalled();
  release.resolve(); await closing; await Promise.all(jobs);
  expect(rpc.mock.calls.filter(([request]) => (request as { name: string }).name === 'operate_drive')).toHaveLength(3);
  expect(rpc.mock.calls.filter(([request]) => (request as { name: string }).name === 'operate_finish')).toHaveLength(3);
  expect(closed).toHaveBeenCalledOnce();
});

it('dismisses the observed cookie overlay without treating echoed instructions as a refusal', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    return args.answer ? { status: 'complete', session_id: 'cookie-tab' }
      : { status: 'low_confidence', session_id: 'cookie-tab', reason: 'model confidence is below the drive threshold', remaining: args.goal, field: args.goal,
        options: { cookie_reject: 'Reject Optional', cookie_accept: 'Accept All' } };
  });
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'completed' } });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'cookie-tab', answer: 'cookie_reject' }));
  expect(call).toHaveBeenCalledWith('operate_finish', expect.objectContaining({ session_id: 'cookie-tab', outcome: 'result' }));
  expect(call.mock.calls.some(([name]) => name === 'operate_share')).toBe(false);
  await squire.close();
  expect(call.mock.calls.filter(([name]) => name === 'operate_finish')).toHaveLength(1);
});

it('does not loop when the same cookie choice fails to advance the page', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name === 'operate_drive'
    ? { status: 'low_confidence', session_id: 'stuck-tab', remaining: args.goal, options: { reject: 'Reject Optional' } } : {});
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'dropped' } });
  expect(call.mock.calls.filter(([name]) => name === 'operate_drive')).toHaveLength(2);
  expect(call).toHaveBeenCalledWith('operate_finish', { session_id: 'stuck-tab', outcome: 'none' });
});

it('closes a refused browser without obscuring the refusal reason', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'rejected', session_id: 'refused-tab', reason: 'Provider denied automated signup.' } : {});
  // A refusal drops only this provider; setup goes on to the next one.
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'dropped' }, reason: 'provider refused; the page says: Provider denied automated signup.' });
  expect(squire.signupFailureDetail('kilo')).toContain('Provider denied automated signup.');
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

it('retains a bounded initial MCP response for cleanup after scoped cancellation while another service continues', async () => {
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } }).client;
  const late = deferred<unknown>();
  let initialSignal: AbortSignal | undefined;
  const rpc = vi.spyOn(client, 'callTool').mockImplementation(async (request, _schema, options) => {
    const { name, arguments: args } = request as { name: string; arguments: Record<string, unknown> };
    const signal = (options as { signal?: AbortSignal }).signal;
    if (name === 'operate_drive' && args.url === 'https://cancelled.test') {
      initialSignal = signal;
      // Model actual MCP cancellation: an aborted request loses its response.
      return await Promise.race([late.promise, new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('MCP cancelled')), { once: true }))]);
    }
    return { content: [], structuredContent: name === 'operate_drive' ? { status: 'complete', session_id: 'other-tab' } : {} };
  });
  const closed = vi.spyOn(client, 'close').mockResolvedValue();
  const signup = squire.signup('cancelled', 'https://cancelled.test', 'Sign in').catch(error => error);
  await vi.waitFor(() => expect(initialSignal).toBeDefined());
  await squire.cancelSignup('cancelled');
  expect(await signup).toBeInstanceOf(Error);
  expect(initialSignal!.aborted).toBe(false);
  await expect(squire.signup('other', 'https://other.test', 'Sign in')).resolves.toBeUndefined();
  expect(closed).not.toHaveBeenCalled();
  late.resolve({ content: [], structuredContent: { status: 'needs_value', field: 'captcha', session_id: 'late-owned-tab' } });
  await vi.waitFor(() => expect(rpc.mock.calls.some(([request]) => {
    const value = request as { name: string; arguments: { session_id?: string; outcome?: string } };
    return value.name === 'operate_finish' && value.arguments.session_id === 'late-owned-tab' && value.arguments.outcome === 'none';
  })).toBe(true));
  expect(rpc.mock.calls.filter(([request]) => (request as { name: string }).name === 'operate_share')).toHaveLength(0);
  await expect(squire.signup('cancelled', 'https://cancelled.test', 'Sign in again')).rejects.toThrow('cancelled');
  expect(rpc.mock.calls.filter(([request]) => (request as { arguments: { url?: string } }).arguments.url === 'https://cancelled.test')).toHaveLength(1);
  await squire.close();
});

it('aborts known-session MCP work and finishes that session without closing the shared client', async () => {
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } }).client;
  let continuationSignal: AbortSignal | undefined;
  const rpc = vi.spyOn(client, 'callTool').mockImplementation(async (request, _schema, options) => {
    const { name, arguments: args } = request as { name: string; arguments: Record<string, unknown> };
    if (name === 'operate_drive' && args.session_id === 'known-tab') {
      continuationSignal = (options as { signal: AbortSignal }).signal;
      return await new Promise((_resolve, reject) => continuationSignal!.addEventListener('abort', () => reject(new Error('MCP cancelled')), { once: true }));
    }
    return { content: [], structuredContent: name === 'operate_drive' ? { status: 'budget', session_id: 'known-tab' } : {} };
  });
  const closed = vi.spyOn(client, 'close').mockResolvedValue();
  await squire.runs.start(input);
  const continuation = squire.runs.get('kilo').catch(error => error);
  await vi.waitFor(() => expect(continuationSignal).toBeDefined());
  await squire.cancelSignup('kilo');
  expect(await continuation).toBeInstanceOf(Error);
  expect(continuationSignal!.aborted).toBe(true);
  expect(closed).not.toHaveBeenCalled();
  expect(rpc.mock.calls.filter(([request]) => (request as { name: string }).name === 'operate_finish')).toHaveLength(1);
  await squire.close();
});

it('prevents a cancelled service from starting later without affecting a different service', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: 'other-tab' } : {});
  await squire.cancelSignup('cancelled');
  await expect(squire.signup('cancelled', 'https://cancelled.test', 'Sign in')).rejects.toThrow('cancelled');
  expect(call).not.toHaveBeenCalled();
  await expect(squire.signup('other', 'https://other.test', 'Sign in')).resolves.toBeUndefined();
  expect(call).toHaveBeenCalledWith('operate_finish', expect.objectContaining({ session_id: 'other-tab', outcome: 'result' }));
  await squire.close();
});

it.each([true, false])('Reproduction zro: lets a harness recover Jev and requires a vaulted key (key captured: %s)', async captured => {
  const { setupProviders } = await import('./setup.js');
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { listTools(): Promise<unknown> } }).client;
  vi.spyOn(client, 'listTools').mockResolvedValue({ tools: [
    { name: 'operate_drive', inputSchema: { type: 'object' } },
    { name: 'operate_observe', inputSchema: { type: 'object' } },
    { name: 'fetch_credential', inputSchema: { type: 'object' } }
  ] });
  let done = false;
  const calls = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    if (args.answer === 'github') { done = true; return { status: 'complete', session_id: 'zro-tab' }; }
    return { status: 'low_confidence', session_id: 'zro-tab', options: { billing: 'Enable billing', mixed: 'Accept Terms of Service and upgrade to a paid plan', github: 'I agree to the Terms of Service' } };
  });
  const agent = vi.fn(async (input: Parameters<Parameters<BrowserSquire['useSignupAgent']>[0]>[0]) => {
    expect(input.tools.map(tool => tool.name)).not.toContain('fetch_credential');
    expect(await input.call('operate_drive', {})).toMatchObject({ status: 'low_confidence' });
    // A refusal names what is allowed, so the operator does not spend turns guessing.
    expect(await input.call('operate_drive', { answer: 'billing' })).toMatchObject({ status: 'invalid_answer', allowed_answers: ['github', 'WAIT'] });
    expect(await input.call('operate_drive', { answer: 'mixed' })).toMatchObject({ status: 'invalid_answer' });
    expect(await input.call('operate_type', { ref: 'name', text: 'grunt-squire' })).toMatchObject({ status: 'stopped', reason: expect.stringContaining('latest operate_observe') });
    expect(await input.call('operate_click', { ref: 'unobserved' })).toMatchObject({ status: 'stopped', reason: expect.stringContaining('latest operate_observe') });
    expect(await input.call('operate_drive', { answer: 'github' })).toMatchObject({ status: 'complete' });
  });
  squire.useSignupAgent(agent);
  vi.spyOn(squire.credentials, 'list').mockImplementation(async () => done && captured
    ? [{ service: 'zro', reference: 'synthetic', field_names: ['api_key'] }] : []);
  const grant = vi.spyOn(squire.credentials, 'grant').mockResolvedValue({ base_url: 'https://squire.test', token: 'synthetic' });
  const addGrant = vi.fn(async () => {});
  const result = await setupProviders(squire, { addGrant }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  expect(agent).toHaveBeenCalledOnce();
  expect(result.dropped).toEqual(captured ? [] : ['zro']);
  expect(grant).toHaveBeenCalledTimes(Number(captured));
  expect(addGrant).toHaveBeenCalledTimes(Number(captured));
  expect(calls).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'zro-tab', answer: 'github' }));
  await squire.close();
});

it('resumes the same session when the Squire OAuth action was not dispatched', async () => {
  const squire = new BrowserSquire();
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name !== 'operate_drive' ? {}
    : args.answer === 'WAIT' ? { status: 'complete', session_id: 'oauth-tab' }
      : { status: 'not_attempted', session_id: 'oauth-tab', reason: 'Retry oauth_login' });
  await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'completed' } });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'oauth-tab', answer: 'WAIT' }));
  await squire.close();
});

it.each([false, true])('uses the observed Zro Google button and resumes a terms page without a person (terms required: %s)', async termsRequired => {
  const squire = new BrowserSquire();
  squire.useBatchSignup();
  let clicked = false;
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'operate_click') { clicked = true; expect(args.ref).toBe('google'); return {}; }
    if (name !== 'operate_drive') return {};
    if (clicked) return termsRequired
      ? { status: 'budget', session_id: 'zro-tab', observation: { dom: 'Please read and accept the terms to continue' } }
      : { status: 'complete', session_id: 'zro-tab' };
    expect(args.url).toBe('https://zro.moonmath.ai/overview');
    return { status: 'needs_value', session_id: 'zro-tab', field: 'Email address', options: {}, observation: {
      url: 'https://zro.moonmath.ai/sign-up', safe_table: [
        ['git', 'b', '@sign-in-with-git|a=submit'],
        ['google-footer-link', 'l', '@google|u=https://google.com'],
        ['google', 'b', '@google|a=login|q=2/2'],
        ['email', 'b', '@continue-with-email|f=email|a=submit']
      ]
    } };
  });
  await expect(squire.runs.start({ ...input, service: 'zro' })).resolves.toMatchObject(termsRequired
    ? { run: { state: 'running' } }
    : { run: { state: 'completed' } });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'zro-tab' }));
  await squire.close();
});

it.each([
  ['Accept Terms of Service', true],
  ['I agree to the Terms and Conditions', true],
  ['Accept Terms of Service and upgrade to a paid plan', false],
  ['Accept Terms of Service and enable billing', false],
  ['Accept Terms of Service and switch account', true],
  ['Accept Terms of Service and marketing consent', true],
  ['Accept optional Terms of Service', true],
  ['Agree to data sharing', true],
  ['Accept all cookies', true]
])('allows signup terms and consent unless they pay: %s', (label, allowed) => {
  expect(guardedSignupChoice('terms', label)).toBe(allowed);
});

// Provider key pages call API keys "secret keys" (Pollinations) and sign-up
// pages show a captcha; neither pays nor changes an existing key.
it.each([
  ['Secret', true],
  ['Edit secret key', true],
  ['Complete the captcha', true],
  ['Delete secret key', false],
  ['Regenerate secret key', false],
  ['Roll API key', false],
  ['Grant permission', true],
  ['Enter password', true],
  ['Done', true]
])('lets the operator choose provider key and captcha controls: %s', (label, allowed) => {
  expect(guardedSignupChoice('control', label)).toBe(allowed);
});

it.each([
  ['tokenharbor', 'click'],
  ['tokenharbor', 'alias']
] as const)('accepts required terms for %s by %s and does not choose payment or an upgrade', async (provider, mode) => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '1');
  const squire = new BrowserSquire();
  let accepted = false;
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'operate_click') {
      expect(args.ref).toBe('accept-terms');
      accepted = true;
      return {};
    }
    if (name !== 'operate_drive') return {};
    if (args.answer === 'terms' || accepted) return { status: 'complete', session_id: 'terms-tab' };
    return {
      status: mode !== 'answer' ? 'budget' : 'low_confidence',
      session_id: 'terms-tab',
      options: mode !== 'answer'
        ? { paid: 'I agree to the Terms of Service and upgrade to Pro', upgrade: 'Upgrade plan', billing: 'Add a payment method', account: 'Switch account' }
        : { paid: 'I agree to the Terms of Service and upgrade to Pro', terms: 'I agree to the Terms of Service', upgrade: 'Upgrade plan', billing: 'Add a payment method', account: 'Switch account' },
      observation: {
        dom: 'Please read and accept the terms to continue',
        safe_table: [
          ['paid-terms', 'b', 'I agree to the Terms of Service and upgrade to Pro'],
          ['tos-link', 'l', 'Terms of Service'],
          ['accept-terms', 'b', mode === 'alias' ? '@i-agree-to-the-terms-of-service|a=submit' : 'I agree to the Terms of Service'],
          ['upgrade', 'b', 'Upgrade plan'],
          ['billing', 'b', 'Add a payment method'],
          ['account', 'b', 'Switch account']
        ]
      }
    };
  });
  await expect(squire.runs.start({ ...input, service: provider })).resolves.toMatchObject({ run: { state: 'completed' } });
  expect(call.mock.calls.some(([name, args]) => name === 'operate_drive' && String(args.goal).includes("Accept required provider Terms of Service for this free signup"))).toBe(true);
  if (mode === 'answer') expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'terms-tab', answer: 'terms' }));
  else expect(call).toHaveBeenCalledWith('operate_click', expect.objectContaining({ session_id: 'terms-tab', ref: 'accept-terms' }));
  expect(call.mock.calls.some(([, args]) => {
    const value = args as { answer?: string; ref?: string };
    return ['paid', 'upgrade', 'billing', 'account'].includes(value.answer ?? '') || ['paid-terms', 'tos-link', 'upgrade', 'billing', 'account'].includes(value.ref ?? '');
  })).toBe(false);
  expect(call.mock.calls.some(([name]) => name === 'operate_share')).toBe(false);
  await squire.close();
});

function harnessSquire() {
  const squire = new BrowserSquire();
  squire.useBatchSignup();
  const client = (squire as unknown as { client: { listTools(): Promise<unknown> } }).client;
  vi.spyOn(client, 'listTools').mockResolvedValue({ tools: ['operate_drive', 'operate_extract'].map(name => ({ name, inputSchema: { type: 'object' } })) });
  return squire;
}
function terminal(tty: boolean) {
  const previous = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  return () => { if (previous) Object.defineProperty(process.stdin, 'isTTY', previous); else delete (process.stdin as { isTTY?: boolean }).isTTY; };
}

it('never hands a blocked batch signup to the person, even on a terminal', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '0');
  const restore = terminal(true);
  try {
    const { setupProviders } = await import('./setup.js');
    const squire = harnessSquire();
    const call = vi.spyOn(squire, 'call').mockImplementation(async name => name !== 'operate_drive' ? {}
      : { status: 'low_confidence', session_id: 'zro-tab', options: {} });
    squire.useSignupAgent(async agent => {
      await agent.call('operate_drive', {});
      expect(await agent.call('operate_share', {})).toMatchObject({ status: 'stopped', reason: 'Tool unavailable for this signup' });
    });
    vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
    const result = await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
    expect(result.dropped).toEqual(['zro']);
    expect(call.mock.calls.some(([name]) => name === 'operate_share')).toBe(false);
    await squire.close();
  } finally { restore(); }
});

it('drops a Jev-only signup that needs the person instead of sharing its browser', async () => {
  vi.stubEnv('GRUNT_SETUP_NO_HUMAN', '0');
  const restore = terminal(true);
  try {
    const squire = new BrowserSquire();
    squire.useBatchSignup();
    const call = vi.spyOn(squire, 'call').mockImplementation(async name => name !== 'operate_drive' ? {}
      : { status: 'stuck', session_id: 'kilo-tab', needs_user: { wall: 'sms verification' } });
    await expect(squire.runs.start(input)).resolves.toMatchObject({ run: { state: 'dropped' } });
    expect(call.mock.calls.some(([name]) => name === 'operate_share')).toBe(false);
    await squire.close();
  } finally { restore(); }
});

it('forwards an explicit Squire capture for this provider and keeps its write_id visible', async () => {
  const { setupProviders } = await import('./setup.js');
  const squire = harnessSquire();
  const extracts: Record<string, unknown>[] = [];
  let stored = false;
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'operate_extract') {
      extracts.push(args);
      if (object(args.capture).write_id === '3f2b8c1e-9d4a-4e6f-a1b2-c3d4e5f60718') { stored = true; return { status: 'stored', storage: 'stored' }; }
      return { status: 'capture_unresolved', storage: 'unknown', write_id: '3f2b8c1e-9d4a-4e6f-a1b2-c3d4e5f60718' };
    }
    return name === 'operate_drive' ? { status: stored ? 'complete' : 'low_confidence', session_id: 'zro-tab', options: {} } : {};
  });
  const source = { role: 'textbox', name: 'API key' };
  squire.useSignupAgent(async agent => {
    await agent.call('operate_drive', {});
    expect(await agent.call('operate_extract', { capture: { store: { service: 'groq' }, source } })).toMatchObject({ status: 'stopped' });
    expect(await agent.call('operate_extract', { capture: { store: { service: 'zro' }, source: { clipboard: true } } })).toMatchObject({ status: 'stopped' });
    const first = await agent.call('operate_extract', { capture: { store: { service: 'zro', label: 'grunt-free-zro' }, source } });
    expect(first).toMatchObject({ write_id: '3f2b8c1e-9d4a-4e6f-a1b2-c3d4e5f60718' });
    await agent.call('operate_extract', { capture: { store: { service: 'zro', label: 'grunt-free-zro' }, source, write_id: first.write_id } });
  });
  vi.spyOn(squire.credentials, 'list').mockImplementation(async () => stored ? [{ service: 'zro', reference: 'synthetic', field_names: ['api_key'] }] : []);
  vi.spyOn(squire.credentials, 'grant').mockResolvedValue({ base_url: 'https://squire.test', token: 'synthetic' });
  await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  expect(extracts).toEqual([
    { capture: { store: { service: 'zro', label: 'grunt-free-zro' }, source }, session_id: 'zro-tab' },
    { capture: { store: { service: 'zro', label: 'grunt-free-zro' }, source, write_id: '3f2b8c1e-9d4a-4e6f-a1b2-c3d4e5f60718' }, session_id: 'zro-tab' }
  ]);
  await squire.close();
});
const object = (value: unknown) => (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

it('keeps a UUID write_id visible while still hiding secret-shaped values', async () => {
  const { signupAgentResult } = await import('./signup-mcp.js');
  const id = '3f2b8c1e-9d4a-4e6f-a1b2-c3d4e5f60718';
  expect(signupAgentResult({ write_id: id, nested: { write_id: 'sk-abcdefghijklmnop' }, note: `token ${'a'.repeat(40)}` }))
    .toEqual({ write_id: id, nested: {}, note: 'token [omitted]' });
});

it('lets the operator type into observed fields except passwords', async () => {
  const { setupProviders } = await import('./setup.js');
  const squire = harnessSquire();
  const typed: Record<string, unknown>[] = [];
  let filled = false;
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'operate_type') { typed.push(args); return {}; }
    if (name === 'operate_observe') return { user_email: 'person@example.test', safe_table: [['key-name', 't', 'Key Name'], ['email', 't', 'Email address'], ['secret', 't', '@password|f=password']] };
    return name === 'operate_drive' ? { status: filled ? 'complete' : 'low_confidence', session_id: 'zro-tab', options: {} } : {};
  });
  squire.useSignupAgent(async agent => {
    await agent.call('operate_drive', {});
    await agent.call('operate_observe', {});
    expect(await agent.call('operate_type', { ref: 'key-name', text: 'grunt' })).not.toMatchObject({ status: 'stopped' });
    expect(await agent.call('operate_type', { ref: 'email', text: 'person@example.test' })).not.toMatchObject({ status: 'stopped' });
    expect(await agent.call('operate_type', { ref: 'key-name', text: 'grunt-squire' })).not.toMatchObject({ status: 'stopped' });
    expect(await agent.call('operate_type', { ref: 'secret', text: 'Synthetic!Pass42' })).toMatchObject({ status: 'stopped', reason: expect.stringContaining('password') });
    expect(await agent.call('operate_type', { ref: 'unobserved', text: 'grunt' })).toMatchObject({ status: 'stopped' });
    filled = true;
  });
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  expect(typed).toEqual([
    { ref: 'key-name', text: 'grunt', session_id: 'zro-tab' },
    { ref: 'email', text: 'person@example.test', session_id: 'zro-tab' },
    { ref: 'key-name', text: 'grunt-squire', session_id: 'zro-tab' }
  ]);
  await squire.close();
});

it('passes the operator facts through operate_drive except passwords, and Grunt facts win', async () => {
  const { setupProviders } = await import('./setup.js');
  const squire = harnessSquire();
  const drives: Record<string, unknown>[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'operate_drive') { drives.push(args); return { status: object(args.facts)['Key Name'] ? 'complete' : 'low_confidence', session_id: 'zro-tab', options: {} }; }
    return {};
  });
  squire.useSignupAgent(async agent => {
    await agent.call('operate_drive', {});
    await agent.call('operate_drive', { facts: { 'Key Name': 'grunt-squire', 'Card Number': '4242424242424242', Password: 'Synthetic!Pass42', plan: 'pro' } });
  });
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  expect(object(drives.at(-1)).facts).toEqual({ 'Key Name': 'grunt-squire', 'Card Number': '4242424242424242', key_name: expect.stringMatching(/^grunt-\d{8}-\d{4}$/), plan: 'free', project_name: 'grunt' });
  await squire.close();
});

it('runs parallel operator calls in turn without a call cap and widens tools without vault, payment, upload, dialog or inbox access', async () => {
  const { setupProviders } = await import('./setup.js');
  const squire = new BrowserSquire();
  squire.useBatchSignup();
  const client = (squire as unknown as { client: { listTools(): Promise<unknown> } }).client;
  const offered = ['operate_drive', 'operate_observe', 'operate_click', 'operate_login', 'operate_navigate', 'operate_press', 'operate_solve_captcha'];
  vi.spyOn(client, 'listTools').mockResolvedValue({ tools: [...offered, 'operate_upload', 'operate_dialog', 'operate_read_inbox', 'fetch_credential', 'inject_card']
    .map(name => ({ name, inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' } } } })) });
  let active = 0, peak = 0;
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (name === 'operate_observe') return { safe_table: [['late', 'b', 'Continue'], ['pay', 'b', 'Enable billing']] };
    return name === 'operate_drive' ? { status: 'low_confidence', session_id: 'zro-tab', options: { billing: 'Enable billing' } } : {};
  });
  squire.useSignupAgent(async agent => {
    expect(agent.tools.map(tool => tool.name)).toEqual(offered);
    await agent.call('operate_drive', {});
    // A ref the cached page lacks is looked up on a fresh observation, then clicked.
    expect(await agent.call('operate_click', { ref: 'late' })).not.toMatchObject({ status: 'stopped' });
    const results = await Promise.all(Array.from({ length: 30 }, () => agent.call('operate_observe', {})));
    expect(results.filter(result => result.status === 'stopped')).toEqual([]);
    expect(await agent.call('operate_drive', { answer: 'DONE' })).toMatchObject({ status: 'low_confidence' });
    expect(await agent.call('operate_drive', { answer: 'billing' })).toMatchObject({ status: 'invalid_answer' });
    // Squire also resolves an answer that names a current page control, so its observed label is checked too.
    expect(await agent.call('operate_drive', { answer: 'pay' })).toMatchObject({ status: 'invalid_answer' });
    expect(await agent.call('operate_drive', { answer: 'late' })).toMatchObject({ status: 'low_confidence' });
    await agent.call('operate_login', { action: 'store_signup', provider: 'google', ref: 'google', service: 'zro' });
    expect(await agent.call('operate_navigate', { url: 'file:///etc/hosts' })).toMatchObject({ status: 'stopped' });
    expect(await agent.call('operate_upload', { target: 'file', path: '/etc/hosts' })).toMatchObject({ status: 'stopped', reason: 'Tool unavailable for this signup' });
  });
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  expect(peak).toBe(1);
  expect(call).toHaveBeenCalledWith('operate_click', { ref: 'late', session_id: 'zro-tab' });
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'zro-tab', answer: 'DONE' }));
  expect(call).toHaveBeenCalledWith('operate_login', { action: 'oauth', provider: 'google', ref: 'google', session_id: 'zro-tab' });
  expect(call.mock.calls.map(([name]) => name)).not.toContain('operate_navigate');
  expect(call.mock.calls.map(([name]) => name)).not.toContain('operate_upload');
  expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'zro-tab', answer: 'late' }));
  expect(call.mock.calls.filter(([name, args]) => name === 'operate_drive' && ['billing', 'pay'].includes(String(object(args).answer)))).toEqual([]);
  await squire.close();
});

it('keeps a background signup driving through a phone mention and Zro terms instead of dropping it', async () => {
  const squire = new BrowserSquire({ background: true });
  let drives = 0;
  const clicks: unknown[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'operate_click') { clicks.push(args.ref); return {}; }
    if (name !== 'operate_drive') return {};
    drives++;
    if (drives === 1) return { status: 'needs_user', session_id: 'zro-tab', needs_user: { wall: 'phone', message: 'Add a phone number or continue with email' } };
    if (drives === 2) return { status: 'stuck', session_id: 'zro-tab', observation: { dom: 'Please read and accept the terms to continue', safe_table: [['accept', 'b', 'I agree to the Terms of Service']] } };
    return { status: 'complete', session_id: 'zro-tab' };
  });
  await expect(squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Create a free key')).resolves.toBeUndefined();
  expect(clicks).toEqual(['accept']);
  expect(drives).toBe(3);
  await squire.close();
});

it('answers every call after a complete drive with a final stop, not the stale page', async () => {
  const { setupProviders } = await import('./setup.js');
  const squire = harnessSquire();
  let drives = 0;
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name !== 'operate_drive' ? {}
    : ++drives === 1 ? { status: 'low_confidence', session_id: 'zro-tab', options: {} }
      : { status: 'complete', session_id: 'zro-tab', observation: { safe_table: [['@e:1', 'b', '@copy-key']] } });
  const after: unknown[] = [];
  squire.useSignupAgent(async agent => {
    await agent.call('operate_drive', {});
    expect(await agent.call('operate_drive', {})).toMatchObject({ status: 'complete' });
    after.push(await agent.call('operate_extract', { store: { service: 'zro' } }), await agent.call('operate_observe', {}));
  });
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  expect(after).toEqual([0, 1].map(() => expect.objectContaining({ status: 'complete', reason: expect.stringMatching(/stored any requested key.*stop calling tools/) })));
  expect(after[0]).not.toHaveProperty('observation');
  expect(call.mock.calls.filter(([name]) => name !== 'operate_drive' && name !== 'operate_finish').map(([name]) => name)).not.toContain('operate_extract');
  await squire.close();
});

it.each(['acted', 'timeout'] as const)('a failed driver hands its Squire session on, or a timeout leaves the session to the drive loop: %s', async kind => {
  const { setupProviders } = await import('./setup.js');
  const { nextDriver } = await import('./harnesses.js');
  const squire = harnessSquire();
  let drives = 0;
  const call = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    drives++;
    return args.answer === 'WAIT' ? { status: 'complete', session_id: 'zro-tab' } : { status: 'low_confidence', session_id: 'zro-tab', options: {} };
  });
  const goals: string[] = [];
  const next = vi.fn(async (agent: Parameters<Parameters<BrowserSquire['useSignupAgent']>[0]>[0]) => {
    goals.push(agent.goal);
    await agent.call('operate_drive', { answer: 'WAIT' });
  });
  squire.useSignupAgent(nextDriver(async agent => {
    goals.push(agent.goal);
    await agent.call('operate_drive', {});
    await agent.call('operate_drive', {});
    throw new Error(kind === 'acted' ? 'quota exhausted: free usage limit reached' : 'opencode did not answer within 240 seconds');
  }, next));
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  const result = await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: () => {} });
  const startedDrives = drives;
  if (kind === 'acted') {
    // The next driver continues the same browser session; it is told not to start over.
    expect(goals).toHaveLength(2);
    expect(goals[1]).toContain('never start the signup over');
    expect(call).toHaveBeenCalledWith('operate_drive', expect.objectContaining({ session_id: 'zro-tab', answer: 'WAIT' }));
    expect(call.mock.calls.filter(([name, args]) => name === 'operate_drive' && object(args).session_id !== 'zro-tab')).toHaveLength(1);
  } else {
    expect(next).not.toHaveBeenCalled();
    // The timeout alone no longer drops the signup; the drive loop keeps going until its own limit.
    expect(squire.signupFailure('zro')).not.toBe('timed out');
    expect(result.dropped).toEqual(['zro']);
  }
  expect(startedDrives).toBeGreaterThan(1);
  await squire.close();
});

it.each(['return', 'timeout'] as const)('drains in-flight and queued operator calls before resuming after %s', async outcome => {
  const squire = harnessSquire();
  const entered = deferred<void>(), release = deferred<void>(), ended = deferred<void>();
  let drives = 0;
  const events: string[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async name => {
    if (name === 'operate_drive') {
      events.push('drive');
      return ++drives === 1
        ? { status: 'low_confidence', session_id: 'zro-tab', options: {} }
        : { status: 'complete', session_id: 'zro-tab' };
    }
    if (name === 'operate_observe') {
      events.push('observe started');
      entered.resolve();
      await release.promise;
      events.push('observe finished');
    }
    return {};
  });
  const pending: Promise<unknown>[] = [];
  squire.useSignupAgent(async agent => {
    await agent.call('operate_drive', {});
    pending.push(agent.call('operate_observe', {}), agent.call('operate_observe', {}));
    await entered.promise;
    ended.resolve();
    if (outcome === 'timeout') throw new Error('opencode did not answer within 240 seconds');
  });
  const operation = squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Create a free key');
  try {
    await ended.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(events).toEqual(['drive', 'observe started']);
  } finally { release.resolve(); }
  try {
    await operation;
    await Promise.all(pending);
    expect(events).toEqual(['drive', 'observe started', 'observe finished', 'observe started', 'observe finished', 'drive']);
  } finally { await squire.close(); }
});
