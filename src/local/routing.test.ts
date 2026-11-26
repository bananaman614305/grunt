import { idleEvents } from './fixtures/opencode-events.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RequestError, Sources, replayTimeout, requestRefusal, SourceError } from './source.js';
import { StickyRouter } from './routing.js';
import type { ModelRequest, Source } from './source.js';
import { bundledRegistry } from '../registry.js';
import { OpenCode } from './opencode.js';
import { createLocalApp } from './api.js';
// Router behavior is tested independently of the changing published pool and weights.
const launchRegistry = { ...bundledRegistry, adapters: ['opencode', 'kilo'].map(id => ({
  ...bundledRegistry.adapters.find(adapter => adapter.id === id)!, weight: 0.5
})) };

const request: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'Finish the task' }], cwd: '/tmp', tools: [], stream: false };
const source = (id: string): Source => ({ id, available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: `${id} done` })) });
function routed(random = () => 0) { const a = source('opencode'), b = source('kilo'); return { a, b, sources: new Sources([a, b], { registry: () => launchRegistry, random }) }; }
const piTools = [{ type: 'function' as const, function: { name: 'read', parameters: {} } }];

it.each(['explicit', 'ambiguous', 'concurrent', 'concurrent-fallback', 'exhausted'] as const)('only an exhausted automatic routed pool tries the legacy fallback (%s)', async mode => {
  const primary = source('opencode'), legacy = source('legacy');
  const pool = new Sources([primary, legacy], { registry: () => launchRegistry, unrouted: new Set([legacy.id]) });
  const controller = new AbortController();
  try {
    if (mode === 'concurrent' || mode === 'concurrent-fallback') {
      const running = mode === 'concurrent' ? primary : legacy;
      if (running === legacy) vi.mocked(primary.complete).mockRejectedValueOnce(new SourceError('quota', 'reset later', 60));
      let finish!: () => void;
      vi.mocked(running.complete).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ text: 'first' }); }));
      const first = pool.complete(request, controller.signal);
      await vi.waitFor(() => expect(running.complete).toHaveBeenCalledOnce());
      try {
        await expect(pool.complete(request, controller.signal)).rejects.toThrow('already running');
      } finally { finish(); await first; }
    } else {
      vi.mocked(primary.complete).mockRejectedValueOnce(mode === 'ambiguous' ? replayTimeout('ambiguous', false) : new SourceError('quota', 'reset later', 60));
      const input = mode === 'explicit' ? { ...request, model: primary.id } : request;
      if (mode === 'exhausted') await expect(pool.complete(input, controller.signal)).resolves.toEqual({ text: 'legacy done' });
      else await expect(pool.complete(input, controller.signal)).rejects.toMatchObject({ code: mode === 'explicit' ? 'quota' : 'timeout' });
    }
    expect(legacy.complete).toHaveBeenCalledTimes(mode === 'exhausted' || mode === 'concurrent-fallback' ? 1 : 0);
  } finally { await pool.close(); }
});

it.each(['healthy', 'ineligible', 'refused', 'not-installed', 'explicit'] as const)('handles a pool-local tool refusal with a legacy backup (%s, LIV-2)', async mode => {
  const primary = { ...source('kilo'), supportsFunctionTools: true };
  const legacy = { ...source('legacy'), supportsFunctionTools: mode !== 'ineligible' };
  vi.mocked(primary.complete).mockRejectedValue(requestRefusal('primary rejected schema locally', 'request_tool_schema'));
  if (mode === 'refused') vi.mocked(legacy.complete).mockRejectedValue(requestRefusal('legacy rejected schema locally'));
  if (mode === 'not-installed') vi.mocked(legacy.complete).mockRejectedValue(new SourceError('not_installed', 'legacy missing'));
  const sources = new Sources([primary, legacy], { registry: () => launchRegistry, unrouted: new Set([legacy.id]) });
  const input = { ...request, model: mode === 'explicit' ? primary.id : 'grunt', tools: piTools };
  try {
    const completion = sources.complete(input, AbortSignal.timeout(1000));
    if (mode === 'healthy') await expect(completion).resolves.toEqual({ text: 'legacy done' });
    else {
      await expect(completion).rejects.toBeInstanceOf(RequestError);
      await expect(completion).rejects.toThrow(/refused this conversation's tool definitions/);
    }
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(legacy.complete).toHaveBeenCalledTimes(['healthy', 'refused', 'not-installed'].includes(mode) ? 1 : 0);
  } finally { await sources.close(); }
});

it.each(['quota-first', 'refusal-first', 'routed-quota'] as const)('preserves the earliest quota hint through mixed exhaustion (%s)', async order => {
  const primary = { ...source('kilo'), supportsFunctionTools: true };
  const quota = { ...source('legacy-quota'), supportsFunctionTools: true };
  const refusal = { ...source('legacy-refusal'), supportsFunctionTools: true };
  vi.mocked(primary.complete).mockRejectedValue(order === 'routed-quota'
    ? new SourceError('quota', 'Routed quota', 30)
    : requestRefusal('Primary rejected tool schema locally', 'request_tool_schema'));
  vi.mocked(quota.complete).mockRejectedValue(new SourceError('quota', 'Legacy quota', 60));
  vi.mocked(refusal.complete).mockRejectedValue(requestRefusal('Legacy rejected tool schema locally', 'request_tool_schema'));
  const legacy = order === 'refusal-first' ? [refusal, quota] : [quota, refusal];
  const sources = new Sources([primary, ...legacy], { registry: () => launchRegistry, unrouted: new Set(legacy.map(item => item.id)), now: () => 1000 });
  try {
    const response = await createLocalApp(sources).request('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, tools: piTools })
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe(order === 'routed-quota' ? '30' : '60');
    expect((await response.json()).error.code).toBe('quota');
    for (const item of [primary, ...legacy]) expect(item.complete).toHaveBeenCalledOnce();
  } finally { await sources.close(); }
});
// An explicitly named source keeps Pi tools, even one that runs its own tools.
it.each([false, true])('honors an explicitly named native-tool agent with Pi tools (sticky=%s)', async sticky => {
  const nativeAgent = { ...source('opencode'), supportsFunctionTools: false };
  const fallback = { ...source('kilo'), supportsFunctionTools: true };
  const sources = new Sources([fallback, nativeAgent], sticky ? { registry: () => launchRegistry, random: () => 0 } : undefined);
  const input = { ...request, model: 'opencode', tools: piTools };
  expect(await sources.complete(input, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
  expect(nativeAgent.complete).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  expect(fallback.complete).not.toHaveBeenCalled();
});
// Automatic selection with Pi tools only picks sources that return Pi's tool calls.
it.each([false, true])('skips native-tool agents for automatic requests with Pi tools (sticky=%s)', async sticky => {
  const nativeAgent = { ...source('opencode'), supportsFunctionTools: false };
  const fallback = { ...source('kilo'), supportsFunctionTools: true };
  const sources = new Sources([nativeAgent, fallback], sticky ? { registry: () => launchRegistry, random: () => 0 } : undefined);
  const input = { ...request, tools: piTools };
  expect(await sources.complete(input, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(nativeAgent.complete).not.toHaveBeenCalled();
  // Requests without tools still reach the native-tool agent.
  expect(await new Sources([nativeAgent], sticky ? { registry: () => launchRegistry } : undefined).complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
});
it.each([false, true])('reports a clear error when no tool-capable source exists (sticky=%s)', async sticky => {
  const nativeAgent = { ...source('opencode'), supportsFunctionTools: false };
  const unmarked = source('kilo');
  const sources = new Sources([nativeAgent, unmarked], sticky ? { registry: () => launchRegistry, random: () => 0 } : undefined);
  await expect(sources.complete({ ...request, tools: piTools }, AbortSignal.timeout(1000))).rejects.toThrow(/tool-capable/);
  expect(nativeAgent.complete).not.toHaveBeenCalled();
  expect(unmarked.complete).not.toHaveBeenCalled();
});
it('moves a task bound to a native-tool agent once Pi attaches tools', async () => {
  const nativeAgent = { ...source('opencode'), supportsFunctionTools: false };
  const fallback = { ...source('kilo'), supportsFunctionTools: true };
  const sources = new Sources([nativeAgent, fallback], { registry: () => launchRegistry, random: () => 0 });
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
  expect(await sources.complete({ ...request, tools: piTools }, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  // The switch carries a handoff so the tool-capable source continues the task.
  expect(vi.mocked(fallback.complete).mock.calls[0][0].handoffPrompt).toContain('Finish the task');
});
afterEach(() => vi.restoreAllMocks());
it('sticky within task, tool results and retries; draws again for the next user turn', async () => {
  const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(0.99);
  const { a, b, sources } = routed(random);
  await sources.complete(request, AbortSignal.timeout(1000));
  await sources.complete({ ...request, messages: [...request.messages, { role: 'tool', content: 'result' }] }, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledTimes(2); expect(b.complete).not.toHaveBeenCalled(); expect(random).toHaveBeenCalledOnce();
  await sources.complete({ ...request, messages: [...request.messages, { role: 'user', content: 'Next task' }] }, AbortSignal.timeout(1000));
  expect(b.complete).toHaveBeenCalledOnce();
});
it.each([[0.49, 'opencode'], [0.5, 'kilo']] as const)('renormalizes equal launch weights at draw %s', async (draw, id) => {
  const { sources } = routed(() => draw);
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: `${id} done` });
});
it.each(['logged_out', 'not_installed'] as const)('keeps %s barred until a successful health check', async code => {
  const { a, sources } = routed();
  vi.mocked(a.complete).mockRejectedValueOnce(new SourceError(code, 'needs setup')).mockResolvedValue({ text: 'recovered' });
  await sources.complete(request, AbortSignal.timeout(1000));
  await sources.complete({ ...request, userMessages: ['next'] }, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledOnce();
  a.healthCheck = () => a.available();
  vi.mocked(a.available).mockResolvedValue(false);
  await sources.models();
  vi.mocked(a.available).mockResolvedValue(true);
  await sources.models();
  expect(await sources.complete({ ...request, userMessages: ['after check'] }, AbortSignal.timeout(1000))).toEqual({ text: 'recovered' });
});
it('does not replace a bound adapter when a later availability probe would fail', async () => {
  const { a, b, sources } = routed();
  await sources.complete(request, AbortSignal.timeout(1000));
  vi.mocked(a.available).mockResolvedValue(false);
  await sources.complete(request, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledTimes(2); expect(b.complete).not.toHaveBeenCalled();
});
it('disables an unlisted adapter without removing its installation', async () => {
  let registry = launchRegistry;
  const a = source('opencode'), b = source('kilo');
  const sources = new Sources([a, b], { registry: () => registry, random: () => 0 });
  await sources.complete(request, AbortSignal.timeout(1000));
  registry = { ...launchRegistry, adapters: [launchRegistry.adapters[1]!] };
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(await sources.models()).not.toContain('opencode');
  expect(sources.sources).toContain(a);
});
it('switches only after 429, carries task and previous output, and bars until Retry-After', async () => {
  let now = 1000;
  const a = source('opencode'), b = source('kilo');
  vi.mocked(a.complete).mockResolvedValueOnce({ text: 'Made progress' }).mockRejectedValue(new SourceError('quota', 'quota', 120));
  const sources = new Sources([a, b], { registry: () => launchRegistry, random: () => 0, now: () => now });
  await sources.complete(request, AbortSignal.timeout(1000));
  await sources.complete(request, AbortSignal.timeout(1000));
  expect(vi.mocked(b.complete).mock.calls[0]![0].messages.at(-1)!.content).toContain('Made progress');
  expect(vi.mocked(b.complete).mock.calls[0]![0].messages.at(-1)!.content).toContain('Continue this task from the current state. Do not restart.');
  const next = { ...request, userMessages: ['another task'] };
  await sources.complete(next, AbortSignal.timeout(1000)); expect(a.complete).toHaveBeenCalledTimes(2);
  now += 120001;
  vi.mocked(a.complete).mockResolvedValue({ text: 'back' });
  await sources.complete({ ...request, userMessages: ['third task'] }, AbortSignal.timeout(1000)); expect(a.complete).toHaveBeenCalledTimes(3);
});
it.each(['upstream', 'timeout'] as const)('switches on the first %s failure and returns after the bar expires', async code => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const { a, b, sources } = routed();
  vi.mocked(a.complete).mockRejectedValue(code === 'timeout' ? replayTimeout('failed', true) : new SourceError(code, 'failed'));
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(b.complete).toHaveBeenCalledTimes(1);
  vi.mocked(a.complete).mockResolvedValue({ text: 'restored' });
  expect(await sources.complete({ ...request, userMessages: ['before recovery'] }, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  clock.mockReturnValue(1000 + 15 * 60 * 1000 + 1);
  expect(await sources.complete({ ...request, userMessages: ['after recovery'] }, AbortSignal.timeout(1000))).toEqual({ text: 'restored' });
});
it('fails over from a RunCrate 529 and honors its four-second retry hint on later requests', async () => {
  let now = 1000;
  const runcrate = source('runcrate'), kilo = source('kilo');
  vi.mocked(runcrate.complete).mockRejectedValueOnce(new SourceError('upstream', 'Unavailable', 4, undefined, { httpStatus: 529 }));
  const sources = new Sources([runcrate, kilo], { registry: () => bundledRegistry, random: () => 0, now: () => now });
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(sources.status().sources[0]).toMatchObject({ id: 'runcrate', errorCode: 'upstream', state: 'error', retryAt: 5000 });
  now = 4999;
  expect(await sources.complete({ ...request, userMessages: ['before retry'] }, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(runcrate.complete).toHaveBeenCalledOnce();
  now = 5000;
  expect(await sources.complete({ ...request, userMessages: ['after retry'] }, AbortSignal.timeout(1000))).toEqual({ text: 'runcrate done' });
});
it('never returns to a failed source in the same request after its short cooldown expires', async () => {
  let now = 1000;
  const runcrate = source('runcrate'), kilo = source('kilo'), livekit = source('livekit');
  vi.mocked(runcrate.complete).mockRejectedValueOnce(new SourceError('upstream', 'Unavailable', 4, undefined, { httpStatus: 529 }));
  vi.mocked(kilo.complete).mockImplementationOnce(async () => {
    now += 5000;
    throw new SourceError('upstream', 'Fallback failed');
  });
  const sources = new Sources([runcrate, kilo, livekit], { registry: () => bundledRegistry, random: () => 0, now: () => now });
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'livekit done' });
  expect(runcrate.complete).toHaveBeenCalledOnce();
  expect(kilo.complete).toHaveBeenCalledOnce();
  expect(await sources.complete({ ...request, userMessages: ['new task'] }, AbortSignal.timeout(1000))).toEqual({ text: 'runcrate done' });
});
it.each([
  [503, 0, 1],
  [503, 7200, 7200],
  [503, 172800, 86400],
  [503, Infinity, 900],
  [503, -1, 900],
  [undefined, 4, 900],
  [400, 4, 900],
])('uses a bounded upstream retry delay for HTTP %s and hint %s', async (httpStatus, hint, expectedSeconds) => {
  const now = 1000;
  const runcrate = source('runcrate'), kilo = source('kilo');
  vi.mocked(runcrate.complete).mockRejectedValueOnce(new SourceError('upstream', 'Unavailable', hint, undefined, { httpStatus }));
  const sources = new Sources([runcrate, kilo], { registry: () => bundledRegistry, random: () => 0, now: () => now });
  await sources.complete(request, AbortSignal.timeout(1000));
  expect(sources.status().sources[0]).toMatchObject({ id: 'runcrate', state: 'error', retryAt: now + expectedSeconds * 1000 });
});
it('benches a source only briefly when its reply held an invalid function call', async () => {
  const now = 1000;
  const runcrate = source('runcrate'), kilo = source('kilo');
  vi.mocked(runcrate.complete).mockRejectedValueOnce(new SourceError('upstream', 'Invalid function calls', undefined, undefined, { httpStatus: 200, failureReason: 'response_tools' }));
  const sources = new Sources([runcrate, kilo], { registry: () => bundledRegistry, random: () => 0, now: () => now });
  await sources.complete(request, AbortSignal.timeout(1000));
  expect(sources.status().sources[0]).toMatchObject({ id: 'runcrate', state: 'error', retryAt: now + 30 * 1000 });
});
it('does not report another source cooldown when an explicitly named source is unavailable', async () => {
  const runcrate = source('runcrate'), kilo = source('kilo'), opencode = source('opencode');
  vi.mocked(runcrate.complete).mockRejectedValueOnce(new SourceError('upstream', 'Unavailable', 4, undefined, { httpStatus: 529 }));
  vi.mocked(opencode.available).mockResolvedValue(false);
  const sources = new Sources([runcrate, kilo, opencode], { registry: () => bundledRegistry, random: () => 0, now: () => 1000 });
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  await expect(sources.complete({ ...request, model: 'opencode', userMessages: ['explicit task'] }, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ code: 'quota', retryAfter: undefined });
});
it.each([[false, '4'], [true, null]] as const)('reports the actionable retry after a RunCrate 529, slow fallback=%s', async (slowFallback, retryAfter) => {
  let now = 1000;
  const runcrate = source('runcrate'), kilo = source('kilo');
  vi.mocked(runcrate.complete).mockRejectedValueOnce(new SourceError('upstream', 'Unavailable', 4, undefined, { httpStatus: 529 }));
  vi.mocked(kilo.complete).mockImplementationOnce(async () => {
    now += 5000;
    throw new SourceError('upstream', 'Fallback failed');
  });
  const sources = new Sources(slowFallback ? [runcrate, kilo] : [runcrate],
    { registry: () => bundledRegistry, random: () => 0, now: () => now });
  const response = await createLocalApp(sources).request('http://localhost:8788/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
  });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe(retryAfter);
  expect(runcrate.complete).toHaveBeenCalledOnce();
});
it('a refusal moves the request to the next source', async () => {
  const { a, b, sources } = routed();
  vi.mocked(a.complete).mockRejectedValue(new SourceError('refused', 'policy'));
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(b.complete).toHaveBeenCalledTimes(1);
});
it('cancellation never switches', async () => {
  const { a, b, sources } = routed();
  vi.mocked(a.complete).mockRejectedValue(new SourceError('cancelled', 'stop'));
  await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'cancelled' });
  expect(b.complete).not.toHaveBeenCalled();
});
it.each([false, true])('returns HTTP 429 with earliest retry when all candidates run out (stream: %s)', async stream => {
  const { a, b, sources } = routed();
  vi.mocked(a.complete).mockRejectedValue(new SourceError('quota', 'quota', 30));
  vi.mocked(b.complete).mockRejectedValue(new SourceError('quota', 'quota', 90));
  const app = createLocalApp(sources);
  const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, stream }) });
  expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0); expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(30);
});
it('filters disabled, unavailable and unsupported image adapters before drawing', async () => {
  const { a, b, sources } = routed();
  vi.mocked(a.available).mockResolvedValue(false);
  expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(a.complete).not.toHaveBeenCalled();
  const app = createLocalApp(sources);
  const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }) });
  // No registry adapter lists images, so the image becomes a text note and the conversation is served instead of failing.
  expect(response.status).toBe(200); expect(b.complete).toHaveBeenCalledTimes(2);
  expect(vi.mocked(b.complete).mock.calls.at(-1)![0]).toMatchObject({ messages: [{ content: expect.stringContaining('[image omitted (image/png, 1 bytes)') }] });
  expect(vi.mocked(b.complete).mock.calls.at(-1)![0].imageInput).toBeUndefined();
});
it('hands off the live working tree against a dirty task-start checkpoint', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'grunt-handoff-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
    git('init'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
    await writeFile(join(cwd, 'task.txt'), 'baseline\n'); git('add', '.'); git('commit', '-m', 'baseline');
    await writeFile(join(cwd, 'task.txt'), 'user edits\n');
    const before = git('status', '--porcelain'); const head = git('rev-parse', 'HEAD');
    const { a, b, sources } = routed();
    vi.mocked(a.complete).mockImplementation(async () => { await writeFile(join(cwd, 'task.txt'), 'user edits\nagent progress\n'); throw new SourceError('quota', 'quota'); });
    await sources.complete({ ...request, cwd }, AbortSignal.timeout(10000));
    const packet = vi.mocked(b.complete).mock.calls[0]![0].messages.at(-1)!.content;
    expect(packet).toContain('+agent progress'); expect(packet).not.toContain('+user edits');
    expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('stash', 'list')).toBe(''); expect(before).toContain('task.txt');
    expect(await readFile(join(cwd, 'task.txt'), 'utf8')).toContain('user edits');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it('passes OpenCode quota reply partial text to the next adapter', async () => {
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: async url => String(url).endsWith('/event') ? idleEvents() : Response.json(String(url).endsWith('/message')
    ? { info: { error: { data: { statusCode: 429 } } }, parts: [{ type: 'text', text: 'partial work survives' }] }
    : { id: 'quota_session' }) });
  const next = source('kilo');
  const sources = new Sources([driver, next], { registry: () => launchRegistry, random: () => 0 });
  await sources.complete(request, AbortSignal.timeout(1000));
  expect(vi.mocked(next.complete).mock.calls[0]![0].handoffPrompt).toContain('partial work survives');
});

it('keeps actual OpenCode login bars through an unhealthy models check', async () => {
  let signedIn = false;
  const messages: string[] = [];
  const driver = new OpenCode({ url: 'http://127.0.0.1:4096', fetcher: async (url, init) => {
    if (String(url).endsWith('/event')) return idleEvents();
    if (!String(url).endsWith('/message')) return Response.json({ id: 'health_session' });
    messages.push(JSON.parse(String(init?.body)).parts[0].text);
    return signedIn ? Response.json({ parts: [{ type: 'text', text: 'ready' }] }) : new Response('', { status: 401 });
  } });
  const sources = new Sources([driver, source('kilo')], { registry: () => launchRegistry, random: () => 0 });
  const run = (text: string) => sources.complete({ ...request, userMessages: [text] }, AbortSignal.timeout(2000));
  await run('first'); await run('second');
  expect(messages.filter(m => m === 'first' || m === 'second')).toEqual(['first']);
  await sources.models(); await run('third');
  expect(messages).not.toContain('third');
  signedIn = true;
  await sources.models();
  expect(await run('fourth')).toEqual({ text: 'ready' });
});
it('does not hand off a turn with partial output and an unsafe-replay quota failure', async () => {
  const failing: Source = {
    id: 'opencode',
    available: async () => true,
    complete: async () => {
      const error = new SourceError('quota', 'quota exhausted', undefined, 'CURRENT PARTIAL WORK');
      error.replay = 'unsafe';
      throw error;
    }
  };
  const next = source('kilo');
  const sources = new Sources([failing, next], { registry: () => launchRegistry, random: () => 0 });
  await sources.models();
  await expect(sources.complete(request, AbortSignal.timeout(2000)))
    .rejects.toMatchObject({ code: 'quota', output: 'CURRENT PARTIAL WORK', replay: 'unsafe' });
  expect(next.complete).not.toHaveBeenCalled();
});

it('includes vetted Kilo in weighted default routing and falls through after its quota', async () => {
  const kilo = source('kilo'), opencode = source('opencode');
  const sources = new Sources([opencode, kilo], { registry: () => bundledRegistry, random: () => 0.99 });
  const input = { ...request, model: 'grunt' };
  expect(await sources.complete(input, AbortSignal.timeout(1000))).toEqual({ text: 'kilo done' });
  expect(await sources.models()).toContain('kilo');
  vi.mocked(kilo.complete).mockRejectedValue(new SourceError('quota', 'quota', 60));
  expect(await sources.complete(input, AbortSignal.timeout(1000))).toEqual({ text: 'opencode done' });
});
it('labels a first draw weighted and a later turn sticky', async () => {
  const decisions: { reason: string; skipped: boolean }[] = [];
  const a = source('opencode'), b = source('kilo');
  const router = new StickyRouter([a, b], { registry: () => launchRegistry, random: () => 0, observe: (_id, reason, skipped = false) => { decisions.push({ reason, skipped }); } });
  await router.complete(request, AbortSignal.timeout(1000));
  await router.complete({ ...request, messages: [...request.messages, { role: 'assistant', content: 'ok' }] }, AbortSignal.timeout(1000));
  expect(decisions).toEqual([
    { reason: 'weighted_draw', skipped: true }, { reason: 'weighted', skipped: false },
    { reason: 'sticky_binding', skipped: true }, { reason: 'sticky', skipped: false }
  ]);
});
// Harness subagent notifications arrive as new user-role messages. They report
// on the same task, so the orchestrator keeps its task, source and checkpoint.
const codexNote = '<subagent_notification>\n{"agent_path":"a1","status":{"completed":"done"}}\n</subagent_notification>';
const claudeNote = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>';
it.each([['codex', codexNote], ['claude', claudeNote]])('keeps the task and source when a %s subagent notification arrives as a user turn', async (_name, note) => {
  const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(0.99);
  const { a, b, sources } = routed(random);
  const first = { ...request, messages: [{ role: 'user', content: 'Orchestrate' }] };
  await sources.complete(first, AbortSignal.timeout(1000));
  const withNote = { ...first, messages: [...first.messages, { role: 'assistant', content: 'spawned' }, { role: 'user', content: note }] };
  await sources.complete(withNote, AbortSignal.timeout(1000));
  // A decoded request that lists the notification as user turns behaves alike.
  await sources.complete({ ...withNote, userMessages: ['Orchestrate', note, note] }, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledTimes(3); expect(b.complete).not.toHaveBeenCalled(); expect(random).toHaveBeenCalledOnce();
  // The model still sees the notification.
  expect(vi.mocked(a.complete).mock.calls[1][0].messages.at(-1)!.content).toBe(note);
  // A real new user turn still starts a new task and draws again.
  await sources.complete({ ...withNote, messages: [...withNote.messages, { role: 'user', content: 'Next task' }] }, AbortSignal.timeout(1000));
  expect(b.complete).toHaveBeenCalledOnce();
});
it('keeps real user text mixed with a notification as a new turn', async () => {
  const { taskTurns } = await import('./harness.js');
  const base = { ...request, messages: [] as ModelRequest['messages'] };
  expect(taskTurns({ ...base, userMessages: ['Orchestrate', `${codexNote}\n`, `${claudeNote}\nNow also fix the tests`, `<system-reminder>x</system-reminder>\n${codexNote}`] }))
    .toEqual(['Orchestrate', 'Now also fix the tests']);
  expect(taskTurns({ ...base, messages: [{ role: 'user', content: 'Orchestrate' }, { role: 'user', content: codexNote }] })).toEqual(['Orchestrate']);
  const { a, b, sources } = routed(vi.fn().mockReturnValueOnce(0).mockReturnValue(0.99));
  await sources.complete({ ...request, userMessages: ['Orchestrate'] }, AbortSignal.timeout(1000));
  await sources.complete({ ...request, userMessages: ['Orchestrate', `${claudeNote}\nNow also fix the tests`] }, AbortSignal.timeout(1000));
  expect(a.complete).toHaveBeenCalledOnce(); expect(b.complete).toHaveBeenCalledOnce();
});
// A client's unsupported tool type is a request problem, never source quota.
it.each([false, true])('rejects an unsupported tool type with 400 and records no source failure (sticky=%s)', async sticky => {
  const picky = (id: string) => {
    const complete = vi.fn(async (input: ModelRequest) => {
      if (input.tools.some(tool => tool.type !== 'function')) throw new SourceError('upstream', 'requires function tools');
      return { text: `${id} done` };
    });
    return { ...source(id), supportsFunctionTools: true, complete };
  };
  const a = picky('opencode'), b = picky('kilo');
  const sources = new Sources([a, b], sticky ? { registry: () => launchRegistry, random: () => 0 } : undefined);
  const app = createLocalApp(sources);
  const post = (tools: unknown[]) => app.request('http://localhost:8788/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grunt', input: 'Do work', cwd: '/tmp', tools }) });
  const fn = { type: 'function', name: 'exec_command', parameters: { type: 'object' } };
  const response = await post([fn, { type: 'web_search', external_web_access: true }, { type: 'custom', name: 'apply_patch' }]);
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { type: string; message: string } };
  expect(body.error.type).toBe('invalid_request_error');
  expect(body.error.message).toContain('web_search'); expect(body.error.message).toContain('custom');
  expect(response.headers.get('retry-after')).toBeNull();
  expect(a.complete).not.toHaveBeenCalled(); expect(b.complete).not.toHaveBeenCalled();
  // Nothing was put in cooldown: the next ordinary request is answered at once.
  expect((await post([fn])).status).toBe(200);
  expect(a.complete).toHaveBeenCalledOnce();
});
