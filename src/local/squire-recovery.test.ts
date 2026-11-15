import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';
import type * as Prompts from '@clack/prompts';
import { withTerminal } from './terminal.js';
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

it('releases browser slots before waiting for grouped human verification', async () => {
  const { confirm } = await import('@clack/prompts');
  const prompted = deferred<void>();
  vi.mocked(confirm).mockImplementationOnce(options => new Promise(resolve => {
    prompted.resolve();
    options.signal!.addEventListener('abort', () => resolve(false), { once: true });
  }));
  const squire = new BrowserSquire();
  const client = (squire as unknown as { client: { callTool(...args: unknown[]): Promise<unknown>; close(): Promise<void> } }).client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/verify');
  const rpc = vi.spyOn(client, 'callTool').mockImplementation(async request => {
    const { name, arguments: args } = request as { name: string; arguments: Record<string, unknown> };
    return { content: [], structuredContent: name === 'operate_drive'
      ? { status: args.url === 'https://other.test' ? 'complete' : 'needs_value', field: 'captcha', session_id: String(args.url) } : {} };
  });
  vi.spyOn(client, 'close').mockResolvedValue();
  const waiting = Array.from({ length: 3 }, (_, i) => squire.signup(`waiting-${i}`, `https://waiting-${i}.test`, 'Sign in').catch(error => error));
  await prompted.promise;
  await expect(squire.signup('other', 'https://other.test', 'Sign in')).resolves.toBeUndefined();
  expect(rpc.mock.calls.filter(([request]) => (request as { name: string }).name === 'operate_drive')).toHaveLength(4);
  await squire.close(); await Promise.all(waiting);
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

it('removes cancelled handoffs waiting for the terminal while another service can still prompt', async () => {
  const { confirm } = await import('@clack/prompts');
  vi.mocked(confirm).mockClear();
  const started = deferred<void>(), hold = deferred<void>();
  const terminal = withTerminal(async () => { started.resolve(); await hold.promise; });
  await started.promise;
  const squire = new BrowserSquire();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const handoff = vi.spyOn(squire, 'humanHandoff').mockImplementation(async session => `https://handoff.test/${session}`);
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name === 'operate_drive'
    ? { status: 'needs_value', field: 'captcha', session_id: String(args.url).includes('cancelled') ? 'cancelled-tab' : 'other-tab' } : {});
  const cancelled = squire.signup('cancelled', 'https://cancelled.test', 'Sign in').catch(error => error);
  const other = squire.runs.start(input);
  await vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(2));
  await squire.cancelSignup('cancelled');
  hold.resolve(); await terminal;
  expect(await cancelled).toBeInstanceOf(Error);
  await expect(other).resolves.toMatchObject({ run: { state: 'running' } });
  expect(vi.mocked(confirm).mock.calls.every(([options]) => !options.message.includes('cancelled'))).toBe(true);
  expect(log.mock.calls.every(([line]) => !String(line).includes('cancelled-tab'))).toBe(true);
  await squire.close();
});

it('cancels one active grouped handoff prompt and lets the remaining service resume', async () => {
  const { confirm } = await import('@clack/prompts');
  vi.mocked(confirm).mockClear();
  const prompted = deferred<void>();
  vi.mocked(confirm).mockImplementationOnce(options => new Promise(resolve => {
    prompted.resolve();
    options.signal!.addEventListener('abort', () => resolve(false), { once: true });
  }));
  const squire = new BrowserSquire();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(squire, 'humanHandoff').mockResolvedValue('https://handoff.test/verify');
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => name === 'operate_drive'
    ? { status: 'needs_value', field: 'captcha', session_id: String(args.url).includes('cancelled') ? 'cancelled-tab' : 'other-tab' } : {});
  const cancelled = squire.signup('cancelled', 'https://cancelled.test', 'Sign in').catch(error => error);
  const other = squire.runs.start(input);
  await prompted.promise;
  await squire.cancelSignup('cancelled');
  expect(await cancelled).toBeInstanceOf(Error);
  await expect(other).resolves.toMatchObject({ run: { state: 'running' } });
  expect(vi.mocked(confirm).mock.calls).toHaveLength(2);
  expect(vi.mocked(confirm).mock.calls[1]![0].message).toContain('kilo');
  expect(vi.mocked(confirm).mock.calls[1]![0].message).not.toContain('cancelled');
  await squire.close();
});
