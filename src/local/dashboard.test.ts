import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchStatus, parseStatus, renderDashboard, startDashboard, statusCommand } from './dashboard.js';
import type { PoolSnapshot } from './source-status.js';

const now = Date.now();
const snapshot = (): PoolSnapshot => ({ version: 1, updatedAt: now, activeRequests: 2, sources: [
  { id: 'kilo', state: 'answering', active: 2, model: 'particle-ai/particle-1:free', lastReplyMs: 1300, lastSuccessAt: now - 5000 },
  { id: 'opencode', state: 'ready', active: 0, model: 'DeepSeek Flash / GLM Flash', lastReplyMs: 1800 },
  { id: 'perch', state: 'connecting', active: 0 },
  { id: 'runcrate', state: 'limited', active: 0, retryAt: now + 60000 },
  { id: 'freebuff', state: 'disabled', active: 0 }
] });
class Output extends EventEmitter {
  isTTY = true; columns = 80; rows = 40;
  write = vi.fn((_chunk: string) => true);
}
class Input extends EventEmitter {
  isTTY = true; isRaw = false; paused = true; readableFlowing: boolean | null = null;
  ref = vi.fn(() => this); unref = vi.fn(() => this);
  setRawMode = vi.fn((value: boolean) => { this.isRaw = value; return this; });
  isPaused() { return this.paused; }
  resume = vi.fn(() => { this.paused = false; return this; });
  pause = vi.fn(() => { this.paused = true; return this; });
}
const fetcher = () => vi.fn(async () => new Response(JSON.stringify(snapshot()), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.each([20, 40, 80, 120])('keeps the complete plain dashboard within %s columns', columns => {
  const view = renderDashboard(snapshot(), { width: columns, now });
  expect(view).not.toContain('\u001b');
  expect(view.split('\n').every(line => [...line].length <= columns)).toBe(true);
  expect(view).toContain('2 ready');
  expect(view).toContain('2 requests active');
});
it('uses colors and text labels, collapses model columns, and preserves source details on selection', () => {
  expect(renderDashboard(snapshot(), { color: true, width: 100, now })).toContain('\u001b[');
  expect(renderDashboard(snapshot(), { width: 40, now })).not.toContain('MODEL');
  const detail = renderDashboard(snapshot(), { width: 100, selected: 0, details: true, now });
  expect(detail).toContain('particle-ai/particle-1:free');
  expect(detail).toContain('Last success:');
  expect(detail).toContain('Free quota · The free gateway limit is shared by IP.');
  expect(detail).not.toContain('Freebuff');
  expect(renderDashboard(snapshot(), { width: 80, showDisabled: true, now })).toContain('Freebuff');
});
it('keeps safe daily check evidence in JSON and shows last/next check in source details', async () => {
  const data = snapshot();
  data.sources[0]!.maintenance = { lastCheckedAt: now - 60000, lastAttemptAt: now - 60000,
    nextCheckAt: now + 3600000, outcome: 'passed', evidence: 'reply' };
  const parsed = parseStatus(data);
  expect(parsed.sources[0]!.maintenance).toEqual(data.sources[0]!.maintenance);
  const view = renderDashboard(parsed, { width: 100, height: 30, now, details: true });
  expect(view).toContain('Daily check: passed · reply');
  expect(view).toContain('Last check:');
  expect(view).toContain('Next check: in 1h');
  expect(renderDashboard(parsed, { width: 40, now, details: true }).split('\n').every(line => [...line].length <= 40)).toBe(true);
  expect(renderDashboard(parsed, { width: 100, now, details: true, offline: true })).toContain('Next check: status stale');
  const output = new Output(); output.isTTY = false;
  await statusCommand(['--json'], { env: {}, output, fetcher: async () => new Response(JSON.stringify(data)) });
  expect(JSON.parse(output.write.mock.calls[0]![0]).sources[0].maintenance).toMatchObject({ outcome: 'passed', evidence: 'reply' });
});
it('rejects unsafe maintenance fields and drops arbitrary payloads from status', () => {
  const data = snapshot();
  const maintenance = { nextCheckAt: now, outcome: 'deferred', code: 'busy', token: 'synthetic-must-not-pass', url: 'https://example.invalid/private' };
  const parsed = parseStatus({ ...data, sources: [{ ...data.sources[0], maintenance }] });
  expect(parsed.sources[0]!.maintenance).toEqual({ nextCheckAt: now, outcome: 'deferred', code: 'busy' });
  for (const invalid of [{ nextCheckAt: Infinity }, { nextCheckAt: now, lastCheckedAt: 1e20 },
    { nextCheckAt: now, outcome: 'https://example.invalid' }, { nextCheckAt: now, evidence: 'private-goal' },
    { nextCheckAt: now, code: '\u001b[2J' }]) {
    expect(() => parseStatus({ ...data, sources: [{ ...data.sources[0], maintenance: invalid }] })).toThrow('Invalid local maintenance status');
  }
});
it('does not claim a source is ready while status is disconnected or stale', () => {
  for (const options of [{ offline: true }, { now: now + 16000 }]) {
    const view = stripVTControlCharacters(renderDashboard(snapshot(), { width: 100, color: true, ...options }));
    expect(view).toContain('Daemon offline or status stale');
    expect(view).not.toContain('✓ Ready'); expect(view).not.toContain('→ Answering');
  }
});
it('gives passive views no fake keyboard controls', () => {
  const view = renderDashboard(snapshot(), { width: 100, now, interactive: false });
  expect(view).toContain('Live view: usegrunt status --watch'); expect(view).not.toContain('q close'); expect(view).not.toContain('d to show');
});
it('strips terminal control sequences in registry metadata and rejects unsafe identifiers', () => {
  const data = snapshot(); data.sources[0]!.model = '\u001b[2Jowned\n\u001b]0;bad title\u0007';
  const parsed = parseStatus(data), view = renderDashboard(parsed, { width: 100, now, details: true });
  expect(view).not.toContain('\u001b'); expect(view).not.toContain('bad title');
  expect(view).toContain('owned');
  expect(() => parseStatus({ ...data, sources: [{ id: '\u001b[2J', state: 'ready', active: 0 }] })).toThrow('Invalid local source status');
  expect(() => parseStatus({ ...data, sources: [...data.sources, data.sources[0]] })).toThrow('Invalid local source status');
});
it('fetches only the local status endpoint and refuses oversized or invalid snapshots', async () => {
  const stub = fetcher(); await fetchStatus({ port: 8792, fetcher: stub });
  expect(stub).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8792/v1/status', expect.objectContaining({ redirect: 'error' }));
  await expect(fetchStatus({ port: 0, fetcher: stub })).rejects.toThrow('Invalid Grunt port');
  await expect(fetchStatus({ port: 8792, fetcher: async () => new Response('x'.repeat(131073)) })).rejects.toThrow('too large');
  expect(() => parseStatus({ ...snapshot(), activeRequests: Infinity })).toThrow('Invalid local status');
});
it('prints one structured snapshot, honors explicit ports, and never starts watch when piped', async () => {
  const output = new Output(), input = new Input(), stub = fetcher(); output.isTTY = false;
  await statusCommand(['--json', '--port', '8792'], { env: {}, input, output, fetcher: stub });
  expect(JSON.parse(output.write.mock.calls[0]![0])).toMatchObject({ version: 1, activeRequests: 2 });
  expect(input.setRawMode).not.toHaveBeenCalled();
  output.write.mockClear();
  await statusCommand(['--watch'], { env: { GRUNT_PORT: '8792' }, input, output, fetcher: stub });
  expect(output.write).toHaveBeenCalledOnce(); expect(output.write.mock.calls[0]![0]).not.toContain('\u001b');
  await expect(statusCommand(['--port', '123abc'], { input, output, fetcher: stub })).rejects.toThrow('Invalid Grunt port');
  await expect(statusCommand(['--watch', '--json'], { input, output, fetcher: stub })).rejects.toThrow('one snapshot');
});
it('cleans up raw mode, screen, handlers and paused stdin when the user quits', async () => {
  const output = new Output(), input = new Input(), stub = fetcher();
  const before = process.listenerCount('SIGINT');
  const dashboard = startDashboard({ port: 8792, input, output, fetcher: stub, interactive: true, env: { NO_COLOR: '1' } });
  await vi.waitFor(() => expect(output.write).toHaveBeenCalled());
  input.emit('data', '\u001b'); input.emit('data', '[B'); input.emit('data', '\r');
  expect(output.write.mock.calls.some(([line]) => line.includes('OpenCode'))).toBe(true);
  input.emit('data', 'q'); await dashboard.done;
  expect(input.isRaw).toBe(false); expect(input.paused).toBe(true);
  expect(input.listenerCount('data')).toBe(0); expect(output.listenerCount('resize')).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(output.write.mock.calls.at(-1)![0]).toContain('\u001b[?1049l');
});
it('suspends passive rendering for terminal prompts without ever listening to stdin', async () => {
  const output = new Output(), input = new Input();
  const dashboard = startDashboard({ port: 8792, input, output, fetcher: fetcher(), setup: true, env: {} });
  await vi.waitFor(() => expect(output.write).toHaveBeenCalled());
  dashboard.pause(); const pausedWrites = output.write.mock.calls.length;
  output.emit('resize');
  expect(output.write.mock.calls).toHaveLength(pausedWrites);
  dashboard.resume(); expect(output.write.mock.calls.length).toBeGreaterThan(pausedWrites);
  await dashboard.stop();
  expect(input.setRawMode).not.toHaveBeenCalled(); expect(input.resume).not.toHaveBeenCalled();
  expect(input.listenerCount('data')).toBe(0);
});
it('aborts in-flight reads on stop and never fetches for a non-terminal setup view', async () => {
  const output = new Output(), input = new Input();
  const never = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))) as unknown as typeof fetch;
  const dashboard = startDashboard({ port: 8792, input, output, fetcher: never, env: {} });
  await dashboard.stop(); expect(never).toHaveBeenCalledOnce();
  output.isTTY = false; const stub = fetcher();
  await startDashboard({ port: 8792, input, output, fetcher: stub }).done;
  expect(stub).not.toHaveBeenCalled(); expect(input.listenerCount('data')).toBe(0);
});
it('marks watch as offline after a fetch fails instead of continuing to show healthy rows', async () => {
  const input = new Input(), output = new Output(), stub = vi.fn().mockImplementationOnce(async () => new Response(JSON.stringify(snapshot()))).mockRejectedValue(new Error('secret upstream failure')) as unknown as typeof fetch;
  const dashboard = startDashboard({ port: 8792, input, output, fetcher: stub, interval: 100, env: {} });
  try {
    await vi.waitFor(() => expect(output.write.mock.calls.some(([line]) => line.includes('Daemon offline or status stale'))).toBe(true));
    expect(output.write.mock.calls.map(([line]) => line).join('')).not.toContain('secret upstream failure');
  } finally { await dashboard.stop(); }
});

it('shows all ten sources in a normal 80 by 24 setup terminal', () => {
  const data = snapshot();
  data.sources = ['opencode', 'kilo', 'zro', 'tokenharbor', 'runcrate', 'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'perch'].map(id => ({ id, state: 'ready', active: 0 }));
  data.sources.push({ id: 'freebuff', state: 'disabled', active: 0 });
  const view = renderDashboard(data, { width: 80, height: 24, now, interactive: false, setup: true });
  expect(view).toContain('Perch'); expect(view).toContain('OpenCode');
  expect(view).not.toContain('to scroll'); expect(view.split('\n').length).toBeLessThanOrEqual(24);
});
it('finds the installed port safely and lets explicit configuration override a broken hint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grunt-dashboard-port-')); directories.push(directory);
  const hint = join(directory, 'installed-port.json');
  await writeFile(hint, '8792\n', { mode: 0o600 });
  const output = new Output(); output.isTTY = false;
  const stub = fetcher(); const env = { GRUNT_CONFIG_DIR: directory };
  await statusCommand([], { env, output, fetcher: stub });
  expect(stub).toHaveBeenLastCalledWith('http://127.0.0.1:8792/v1/status', expect.anything());
  await writeFile(hint, '{bad}');
  await expect(statusCommand([], { env, output, fetcher: stub })).rejects.toThrow('Invalid saved Grunt port');
  await statusCommand(['--port', '8793'], { env, output, fetcher: stub });
  expect(stub).toHaveBeenLastCalledWith('http://127.0.0.1:8793/v1/status', expect.anything());
  await statusCommand([], { env: { ...env, GRUNT_PORT: '8794' }, output, fetcher: stub });
  expect(stub).toHaveBeenLastCalledWith('http://127.0.0.1:8794/v1/status', expect.anything());
  await statusCommand([], { env: { MILO_CONFIG_DIR: directory, MILO_PORT: '8792' }, output, fetcher: stub });
  expect(stub).toHaveBeenLastCalledWith('http://127.0.0.1:8792/v1/status', expect.anything());
  await statusCommand([], { env: { ...env, GRUNT_PORT: '8792', MILO_PORT: '8794' }, output, fetcher: stub });
  expect(stub).toHaveBeenLastCalledWith('http://127.0.0.1:8792/v1/status', expect.anything());
  await writeFile(hint, '8792'); await chmod(hint, 0o644);
  await expect(statusCommand([], { env, output, fetcher: stub })).rejects.toThrow('Invalid saved Grunt port');
  await rm(hint); await symlink('/dev/null', hint);
  await expect(statusCommand([], { env, output, fetcher: stub })).rejects.toThrow('Cannot read installed Grunt port');
});
it('derives pending approvals from daemon snapshots and rejects out-of-range timestamps', () => {
  const data = snapshot(); data.sources[2]!.state = 'approval';
  const view = renderDashboard(data, { width: 80, now });
  expect(view).toContain('1 action needed'); expect(view).toContain('Run usegrunt setup');
  data.sources[0]!.lastSuccessAt = Number.MAX_VALUE;
  expect(() => parseStatus(data)).toThrow('Invalid local source status');
});

it('preserves safe model provenance and failure codes in JSON without forwarding arbitrary fields', async () => {
  const data = snapshot(); data.sources[0]!.modelKind = 'registry'; data.sources[3]!.errorCode = 'quota';
  const parsed = parseStatus({ ...data, credentials: 'must not pass', sources: data.sources.map(source => ({ ...source, prompt: 'must not pass' })) });
  expect(parsed.sources[0]!.modelKind).toBe('registry'); expect(parsed.sources[3]!.errorCode).toBe('quota');
  expect(JSON.stringify(parsed)).not.toContain('must not pass');
  expect(() => parseStatus({ ...data, sources: [{ ...data.sources[0], modelKind: 'response-attested' }] })).toThrow('Invalid local source status');
  expect(() => parseStatus({ ...data, sources: [{ ...data.sources[0], errorCode: 'raw upstream secret' }] })).toThrow('Invalid local source status');
  const output = new Output(); output.isTTY = false;
  await statusCommand(['--json', '--port', '8792'], { output, fetcher: async () => new Response(JSON.stringify(data)) });
  expect(JSON.parse(output.write.mock.calls[0]![0]).sources[0].modelKind).toBe('registry');
});

it('does not count an in-flight first verification as a ready source', () => {
  const data = snapshot(); data.sources = [{ id: 'kilo', state: 'answering', active: 1 }]; data.activeRequests = 1;
  const view = renderDashboard(data, { width: 80, now });
  expect(view).toContain('0 ready'); expect(view).toContain('→ Answering');
  data.sources[0]!.lastSuccessAt = now - 1000;
  expect(renderDashboard(data, { width: 80, now })).toContain('1 ready');
});
it.each(['SIGINT', 'SIGTERM'] as const)('restores the passive terminal before preserving the default %s action', async signal => {
  await passiveSignal(signal, false);
});
it.each(['SIGINT', 'SIGTERM'] as const)('restores the passive terminal while preserving an existing %s cancellation owner', async signal => {
  await passiveSignal(signal, true);
});
it('preserves default termination when an injected terminal writer ignores callbacks', async () => {
  await passiveSignal('SIGINT', false, false);
});
async function passiveSignal(signal: 'SIGINT' | 'SIGTERM', owned: boolean, callbacks = true) {
  const program = `import {EventEmitter} from 'node:events';
    import {startDashboard} from './src/local/dashboard.ts';
    ${owned ? `process.once('${signal}',()=>{process.stdout.write('OWNER-SIGNAL');setTimeout(()=>process.exit(42),20)});` : ''}
    const output=new EventEmitter();
    Object.assign(output,{isTTY:true,columns:80,rows:24,write:${callbacks ? '(...args)=>process.stdout.write(...args)' : 's=>process.stdout.write(s)'}});
    startDashboard({port:8792,output,input:process.stdin,env:{},interactive:false,fetcher:async()=>new Response(JSON.stringify({version:1,updatedAt:Date.now(),activeRequests:0,sources:[]}))});
    setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', sent = false;
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (!sent && output.includes('\u001b[?1049h')) { sent = true; child.kill(signal); }
    });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    const exit = await completed;
    expect(errors).toBe(''); expect(sent).toBe(true);
    expect(output).toContain('\u001b[?25h\u001b[?1049l');
    expect(exit).toEqual(owned ? { code: 42, signal: null } : { code: null, signal });
    if (owned) expect(output).toContain('OWNER-SIGNAL');
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

it('pauses a fresh previously untouched TTY on close but preserves an existing flowing consumer', async () => {
  for (const flowing of [null, true]) {
    const input = new Input(), output = new Output(); input.paused = false; input.readableFlowing = flowing;
    const dashboard = startDashboard({ port: 8792, input, output, fetcher: fetcher(), interactive: true, env: {} });
    await vi.waitFor(() => expect(output.write).toHaveBeenCalled());
    input.emit('data', 'q'); await dashboard.done;
    expect(input.pause).toHaveBeenCalledTimes(flowing === true ? 0 : 1);
    expect(input.unref).toHaveBeenCalledTimes(flowing === true ? 0 : 1);
  }
});
it('exits a real child after q without leaving initially idle stdin resumed', async () => {
  const program = `import {EventEmitter} from 'node:events';
    import {startDashboard} from './src/local/dashboard.ts';
    Object.defineProperty(process.stdin,'isTTY',{value:true});
    process.stdin.setRawMode=()=>process.stdin;
    const output=new EventEmitter();
    Object.assign(output,{isTTY:true,columns:80,rows:24,write:(...args)=>process.stdout.write(...args)});
    startDashboard({port:8792,output,input:process.stdin,env:{},interactive:true,fetcher:async()=>new Response(JSON.stringify({version:1,updatedAt:Date.now(),activeRequests:0,sources:[]}))}).done.then(()=>process.stdout.write('WATCH-CLOSED'));`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', quit = false;
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (!quit && output.includes('\u001b[?1049h')) { quit = true; child.stdin.write('q'); }
    });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    expect(await completed).toEqual({ code: 0, signal: null });
    expect(errors).toBe(''); expect(quit).toBe(true);
    expect(output).toContain('WATCH-CLOSED');
    expect(output).toContain('\u001b[?25h\u001b[?1049l');
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
