import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bundledRegistry } from '../registry.js';
import { createLocalApp } from './api.js';
import { idleEvents } from './fixtures/opencode-events.js';
import { OpenCode } from './opencode.js';
import { Sources, answeredBy, SourceError } from './source.js';
import type { ModelRequest } from './source.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-opencode-tools-test-'));
  const launchLog = join(directory, 'launches');
  await writeFile(join(directory, 'opencode'), '#!' + process.execPath + '\n' + `
    const { OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT, OPENCODE_AUTH_CONTENT, OPENCODE_DB,
      OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_DISABLE_DEFAULT_PLUGINS, XDG_CONFIG_HOME } = process.env;
    require('node:fs').appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2),
      OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT, OPENCODE_AUTH_CONTENT, OPENCODE_DB,
      OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_DISABLE_DEFAULT_PLUGINS, XDG_CONFIG_HOME }) + '\\n');
    console.log('http://127.0.0.1:19780');
    setInterval(() => {}, 1000);
  `, { mode: 0o700 });
  vi.stubEnv('PATH', directory);
  vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'config'));
  vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'));
  vi.stubEnv('OPENCODE_CONFIG', undefined);
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', undefined);
  vi.stubEnv('OPENCODE_AUTH_CONTENT', undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

const echo = { type: 'function', function: { name: 'echo', parameters: {
  type: 'object', properties: { value: { const: 'ping' } }, required: ['value'], additionalProperties: false
} } };
const request: ModelRequest = { model: 'opencode', cwd: '/tmp', messages: [
  { role: 'system', content: 'This is an echo test.' }, { role: 'user', content: 'Echo ping.' }
], tools: [echo], stream: false };
const calls = JSON.stringify({ version: 1, type: 'calls', calls: [{ name: 'echo', arguments: { value: 'ping' } }] });
const final = (text: string) => JSON.stringify({ version: 1, type: 'final', text });

function backend(response: (prompt: string) => Response, configFile?: string) {
  const prompts: { cwd: string | null; session: string; text: string }[] = [];
  const sessions: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.port).toBe('19780');
    if (url.pathname === '/event') return idleEvents();
    if (url.pathname === '/session') {
      sessions.push(JSON.parse(String(init?.body)));
      return Response.json({ id: `isolated_${sessions.length}` });
    }
    expect(url.pathname).toBe(`/session/isolated_${sessions.length}/message`);
    const { parts } = JSON.parse(String(init?.body));
    const text = parts[0].text;
    prompts.push({ cwd: new Headers(init?.headers).get('x-opencode-directory'), session: url.pathname, text });
    return response(text);
  };
  // Bridge requests own their worker even with an external coding server set.
  return { driver: new OpenCode({ fetcher, url: 'http://127.0.0.1:19781', configFile }), prompts, sessions };
}

function reply(text: string, finish = 'stop') {
  return Response.json({ info: { role: 'assistant', finish }, parts: [{ type: 'text', text }] });
}

it('returns one client call and sends its correlated result in a fresh tools-off session', async () => {
  const configFile = join(directory, 'opencode-free.json');
  await writeFile(configFile, JSON.stringify({ provider: { opencode: { options: { apiKey: 'fixture-zen-key' } } },
    mcp: { example: { type: 'local', command: ['false'] } }, instructions: ['secret.md'], plugin: ['example-plugin'] }), { mode: 0o600 });
  vi.stubEnv('OPENCODE_AUTH_CONTENT', JSON.stringify({ opencode: { type: 'api', key: 'fixture-login' }, other: { type: 'wellknown', token: 'fixture-other' } }));
  const { driver, prompts, sessions } = backend(prompt => reply(prompt.includes('client result') ? final('Confirmed.') : calls), configFile);
  const pool = new Sources([driver]);
  const app = createLocalApp(pool);
  const send = (body: ModelRequest) => app.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await send(request);
    expect(first.status).toBe(200);
    const callChoice = (await first.json()).choices[0];
    expect(callChoice).toMatchObject({ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{
      id: expect.any(String), type: 'function', function: { name: 'echo', arguments: '{"value":"ping"}' }
    }] } });
    const [call] = callChoice.message.tool_calls;
    const followUp = [...request.messages, { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: 'client result' }];
    const next = await send({ ...request, messages: followUp, tools: [] });
    expect(next.status).toBe(200);
    expect((await next.json()).choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'Confirmed.' } });
    expect(JSON.parse(prompts[0].text.split('\n').at(-1)!)).toMatchObject({ messages: request.messages, tools: [echo] });
    expect(JSON.parse(prompts[1].text.split('\n').at(-1)!)).toMatchObject({ messages: followUp, tools: [] });
    expect(prompts[0].cwd).not.toBe(request.cwd);
    expect(prompts[0].cwd).not.toBe(prompts[1].cwd);
    expect(prompts[0].session).not.toBe(prompts[1].session);
    expect(sessions).toEqual(Array(2).fill({ title: 'grunt', permission: [{ permission: '*', pattern: '*', action: 'deny' }] }));
    const launched = (await readFile(join(directory, 'launches'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const [i, worker] of launched.entries()) {
      expect(worker).toMatchObject({ cwd: prompts[i].cwd, args: ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'],
        XDG_CONFIG_HOME: join(prompts[i].cwd!, 'config'), OPENCODE_DB: ':memory:', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' });
      expect(worker.OPENCODE_CONFIG).toBeUndefined();
      expect(JSON.parse(worker.OPENCODE_AUTH_CONTENT)).toEqual({ opencode: { type: 'api', key: 'fixture-login' } });
      expect(JSON.parse(worker.OPENCODE_CONFIG_CONTENT)).toEqual({ provider: { opencode: { options: { apiKey: 'fixture-zen-key' } } },
        permission: { '*': 'deny' }, mcp: {}, instructions: [], snapshot: false, share: 'disabled', agent: { title: { disable: true } } });
      await expect(access(worker.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { await pool.close(); }
});

it.each([
  '{"version":1,"type":"calls"', '', final('   '),
  JSON.stringify({ version: 1, type: 'calls', calls: [{ name: 'echo', arguments: { value: 'wrong' } }] })
])('rejects a malformed or empty envelope as a route failure (%j)', async text => {
  const { driver } = backend(() => reply(text));
  await expect(driver.complete(request, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'upstream', replay: undefined });
});

it('returns a length result without leaking a partial envelope', async () => {
  const { driver } = backend(() => reply(calls.slice(0, -5), 'length'));
  await expect(driver.complete(request, AbortSignal.timeout(3000))).resolves.toEqual({ text: '', finishReason: 'length' });
});

it('allows an ordinary reply when tools are offered without a required choice', async () => {
  const { driver } = backend(() => reply(final('No call needed.')));
  await expect(driver.complete(request, AbortSignal.timeout(3000))).resolves.toEqual({ text: 'No call needed.' });
});

it.each([{}, { name: 'echo' }])('prompts for and enforces required and named choice (%j)', async expectedFunctionCall => {
  const { driver } = backend(prompt => {
    expect(prompt).toContain(expectedFunctionCall.name ? 'Every call must be to "echo".' : 'at least one available tool call.');
    return reply(calls);
  });
  await expect(driver.complete({ ...request, expectedFunctionCall }, AbortSignal.timeout(3000))).resolves.toMatchObject({ calls: [{ function: { name: 'echo' } }] });
  const wrong = backend(() => reply(expectedFunctionCall.name ? calls.replace('"echo"', '"other"') : final('No call.')));
  const tools = [...request.tools, { ...echo, function: { ...echo.function, name: 'other' } }];
  await expect(wrong.driver.complete({ ...request, tools, expectedFunctionCall }, AbortSignal.timeout(3000))).rejects.toMatchObject({
    code: 'upstream', message: expect.stringContaining('did not satisfy tool choice')
  });
});

it('preflights invalid schemas without starting the OpenCode worker', async () => {
  const { driver, prompts } = backend(() => reply(calls));
  const tools = [{ ...echo, function: { ...echo.function, parameters: { type: 'invalid-type' } } }];
  await expect(driver.complete({ ...request, tools }, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'refused', diagnostics: { failureReason: 'request_tool_schema' } });
  expect(prompts).toHaveLength(0);
  await expect(readFile(join(directory, 'launches'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a completed reply containing a native tool part with a replay barrier', async () => {
  const { driver } = backend(() => Response.json({ info: { finish: 'stop' }, parts: [{ type: 'tool' }, { type: 'text', text: calls }] }));
  await expect(driver.complete(request, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'upstream', replay: 'unsafe' });
});

it('tries a native function route first and falls back to OpenCode when it is out of quota', async () => {
  const { driver, prompts } = backend(() => reply(calls));
  const native = { id: 'kilo', supportsFunctionTools: true, available: async () => true,
    complete: vi.fn(async () => { throw new SourceError('quota', 'Synthetic quota', 60); }) };
  const pool = new Sources([driver, native], { registry: () => bundledRegistry, random: () => 0 });
  try {
    const result = await pool.complete({ ...request, model: 'grunt' }, AbortSignal.timeout(3000));
    expect(native.complete).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(1);
    expect(answeredBy.get(result)).toBe('opencode');
    expect(result.calls?.[0].function).toEqual({ name: 'echo', arguments: '{"value":"ping"}' });
  } finally { await pool.close(); }
});
