import { claudeCodeRequest } from './fixtures/claude-code-tools.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import type { PerchProcesses, PerchACPOptions } from './perch-process.js';
import type * as OSModule from 'node:os';
import type * as FSModule from 'node:fs/promises';
import type * as ProcessModule from './perch-process.js';

const state = vi.hoisted(() => ({ personalHome: '' }));
vi.mock('node:os', async original => { const m = await original<typeof OSModule>(); return { ...m, homedir: () => state.personalHome || m.homedir() }; });
vi.mock('node:fs/promises', async original => { const m = await original<typeof FSModule>(); return { ...m, open: vi.fn(m.open) }; });
vi.mock('./perch-process.js', async original => { const m = await original<typeof ProcessModule>(); return { ...m, verifyPerchCoreFiles: vi.fn(async () => {}) }; });
import { Perch, PERCH_VERSION, PERCH_MODEL_ID, PERCH_MODEL_LABEL, PERCH_NPM_INTEGRITY, PERCH_TARBALL_SHA256, PERCH_CORE_SHA256, PERCH_BUILTIN_SKILLS,
  perchPaths, perchEnvironment, preparePerchDirectories, readPerchFreePlanReceipt, writePerchFreePlanReceipt, writePerchInstallReceipt,
  verifyPerchIdentity, verifyPerchInstallation, verifyPerchStartupIsolation } from './perch.js';
import { openPerchACP, runPerchCommand, runPerchMemorySettings, verifyPerchCoreFiles } from './perch-process.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { decode, encode } from './api.js';
import { SourceError } from './source.js';

let directory: string;
const own: Perch[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'grunt-perch-test-'));
  state.personalHome = join(directory, 'personal'); await mkdir(state.personalHome, { mode: 0o700 });
  const p = await preparePerchDirectories(directory);
  await mkdir(join(p.package, 'bin'), { recursive: true, mode: 0o700 }); await mkdir(join(p.package, 'dist'), { mode: 0o700 });
  await writeFile(p.binary, 'synthetic public bin', { mode: 0o700 }); await writeFile(p.bundle, 'synthetic public bundle', { mode: 0o600 }); await writeFile(p.packageJSON, '{}', { mode: 0o600 });
  await writeFile(p.authFile, 'synthetic native opaque auth; never opened by Source', { mode: 0o600 });
  await writePerchInstallReceipt(directory);
  await writePerchFreePlanReceipt(directory, freeReceipt());
  await recordDataSharingConsent(directory, ['perch']);
});
afterEach(async () => { await Promise.all(own.splice(0).map(source => source.close())); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); state.personalHome = ''; });
function freeReceipt(extra = {}) { return { version: 1 as const, plan: 'Starter' as const, email: 'owner@example.test', monthlyAllowancePT: 20000 as const, dataProgramEnabled: false as const, memoryUseEnabled: false as const, memoryLearningEnabled: false as const, checkedAt: new Date().toISOString(), ...extra }; }
function request(extra = {}) { return { model: 'perch', messages: [{ role: 'user', content: 'Hello from the caller.' }], tools: [], cwd: directory, stream: false, maxTokens: 1024, ...extra }; }
function snapshot(extra = {}) { return { modelId: PERCH_MODEL_ID, modelLabel: PERCH_MODEL_LABEL, cliLocalTools: false, selectedSkills: [], toolCallsByType: [],
  compacted: false, truncated: false, contextLimitTokens: 1028576, sectionBreakdown: { project_memory: { chars: 0 }, permanent_memory: { chars: 0 } },
  turnApiUsage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 200, totalTokens: 310 }, ...extra }; }
function fake(options: { email?: string; nativeSnapshot?: Record<string, unknown>; envelope?: string; stopReason?: string; version?: string; mode?: string; pause?: boolean; nativeTool?: boolean } = {}) {
  let sequence = 0;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const command = vi.fn(async () => ({ code: 0, stdout: `Perch CLI ${PERCH_VERSION} · Signed in as ${options.email ?? 'owner@example.test'} · https://app.perchai.app\nMemory: server memory\n` }));
  const acp = vi.fn(async (_binary: string, processOptions: PerchACPOptions) => {
    const id = `session_${++sequence}`, notifications: Record<string, unknown>[] = [];
    return { notifications, close: vi.fn(async () => {}), request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'initialize') return { protocolVersion: 1, agentInfo: { name: 'perch', version: options.version ?? PERCH_VERSION } };
      if (method === 'session/new') return { sessionId: id, modes: { currentModeId: options.mode ?? 'plan' } };
      if (method !== 'session/prompt') throw new Error('Unexpected method');
      if (options.pause) await new Promise<void>((_resolve, reject) => { const abort = () => reject(processOptions.signal.reason); processOptions.signal.addEventListener('abort', abort, { once: true }); if (processOptions.signal.aborted) abort(); });
      const nativeState = processOptions.env.PERCH_CLI_STATE_DIR!; await mkdir(join(nativeState, 'user-scope'), { mode: 0o700 });
      await writeFile(join(nativeState, 'user-scope', `${id}.json`), JSON.stringify({ threadId: id, contextSnapshot: snapshot(options.nativeSnapshot) }), { mode: 0o600 });
      notifications.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update: options.nativeTool ? { sessionUpdate: 'tool_call', toolCallId: 'bad' } : {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: options.envelope ?? '{"version":1,"type":"final","text":"Hello."}' } } } });
      return { stopReason: options.stopReason ?? 'end_turn' };
    }) };
  });
  const memory = vi.fn(async () => ({ email: options.email ?? 'owner@example.test' }));
  return { processes: { command, acp, memory } as PerchProcesses, command, acp, memory, requests };
}
function source(processes: PerchProcesses, timeout?: number) { const s = new Perch({ directory, processes, ...(timeout === undefined ? {} : { timeout }) }); own.push(s); return s; }

it('pins the official artifacts and preserves HOME while stripping provider credentials and endpoint overrides', () => {
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic'); vi.stubEnv('OPENAI_BASE_URL', 'https://wrong.test'); vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic');
  vi.stubEnv('PERCH_MODEL_CALL_PROXY_URL', 'https://wrong.test'); vi.stubEnv('NODE_OPTIONS', '--require=/wrong');
  vi.stubEnv('BASH_ENV', '/wrong/hooks'); vi.stubEnv('SHELL', '/wrong/shell'); vi.stubEnv('ENV', '/wrong/env');
  const env = perchEnvironment(directory); expect(env.HOME).toBe(process.env.HOME);
  for (const key of ['OPENROUTER_API_KEY', 'OPENAI_BASE_URL', 'AWS_ACCESS_KEY_ID', 'PERCH_MODEL_CALL_PROXY_URL', 'NODE_OPTIONS', 'SHELL', 'BASH_ENV', 'ENV']) expect(env[key]).toBeUndefined();
  expect(env.PERCH_CLI_AUTH_DIR).toBe(perchPaths(directory).auth);
  expect(PERCH_NPM_INTEGRITY).toMatch(/^sha512-/); expect(PERCH_TARBALL_SHA256).toHaveLength(64);
  expect(Object.keys(PERCH_CORE_SHA256)).toEqual(['bin/perch', 'dist/perch.mjs', 'package.json']);
});
it.each([{ plan: 'Pro' }, { dataProgramEnabled: true }, { memoryUseEnabled: true }, { memoryLearningEnabled: true }, { memoryUseEnabled: undefined }, { memoryLearningEnabled: undefined }, { monthlyAllowancePT: 1 }, { email: 'invalid' }, { checkedAt: new Date(Date.now() - 31 * 86400000).toISOString() }, { checkedAt: new Date(Date.now() + 3600000).toISOString() }])('rejects unverifiable free receipts %j', async extra => {
  await expect(writePerchFreePlanReceipt(directory, freeReceipt(extra) as never)).rejects.toMatchObject({ code: 'logged_out' });
});
it('reads only private owner-only non-symlink receipt files and never opens raw native authentication', async () => {
  expect(await readPerchFreePlanReceipt(directory)).toMatchObject({ plan: 'Starter', email: 'owner@example.test' });
  const p = perchPaths(directory); await chmod(p.receipt, 0o644); await expect(readPerchFreePlanReceipt(directory)).rejects.toMatchObject({ code: 'logged_out' });
  await chmod(p.receipt, 0o600); await renameForTest(p.receipt, p.receipt + '.real'); await symlink(p.receipt + '.real', p.receipt);
  await expect(readPerchFreePlanReceipt(directory)).rejects.toThrow();
  expect(vi.mocked(open).mock.calls.map(c => c[0])).not.toContain(p.authFile);
});
it('rejects a FIFO receipt without blocking or reading it', async () => {
  const path = perchPaths(directory).receipt; await rm(path); execFileSync('mkfifo', ['-m', '600', path]);
  await expect(readPerchFreePlanReceipt(directory)).rejects.toMatchObject({ code: 'logged_out' });
});
async function renameForTest(from: string, to: string) { const bytes = await readFile(from); await writeFile(to, bytes, { mode: 0o600 }); await rm(from); }
it('requires stored current provider consent before any native process', async () => {
  await rm(join(directory, 'data-sharing-consent.json')); const f = fake(), s = source(f.processes);
  expect(await s.available()).toBe(false); await expect(s.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(f.acp).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled();
});
it('checks core installation hashes and refuses unsafe native-auth file metadata', async () => {
  await verifyPerchInstallation(directory); expect(verifyPerchCoreFiles).toHaveBeenCalledWith(perchPaths(directory).package, PERCH_CORE_SHA256, expect.any(AbortSignal));
  await chmod(perchPaths(directory).authFile, 0o644); const f = fake(); expect(await source(f.processes).available()).toBe(false); expect(f.acp).not.toHaveBeenCalled();
});
it('reports missing native login as incomplete setup and keeps the account receipt', async () => {
  await rm(perchPaths(directory).authFile);
  const f = fake();
  await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000)))
    .rejects.toMatchObject({ code: 'not_installed', message: 'Perch native login is missing; run usegrunt setup' });
  await expect(readPerchFreePlanReceipt(directory)).resolves.toMatchObject({ plan: 'Starter' });
  expect(f.acp).not.toHaveBeenCalled();
});
it('rejects global Perch memory, global native agents and ancestor instructions before ACP starts', async () => {
  const f = fake(), s = source(f.processes); const personal = join(state.personalHome, 'Documents', 'Perch'); await mkdir(personal, { recursive: true }); await writeFile(join(personal, 'PERCH.md'), 'private global instruction');
  await expect(s.complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' }); expect(f.acp).not.toHaveBeenCalled();
  await rm(join(personal, 'PERCH.md')); await writeFile(join(directory, 'AGENTS.md'), 'private ancestor instruction');
  await expect(verifyPerchStartupIsolation(perchPaths(directory).work)).rejects.toMatchObject({ code: 'refused' });
  await rm(join(directory, 'AGENTS.md')); await mkdir(join(state.personalHome, '.perch', 'agents'), { recursive: true }); await writeFile(join(state.personalHome, '.perch', 'agents', 'secret.md'), 'not sent');
  await expect(verifyPerchStartupIsolation(perchPaths(directory).work)).rejects.toMatchObject({ code: 'refused' });
});
it('checks Claude agents at the isolated project root without blocking home-folder Claude agents', async () => {
  const root = perchPaths(directory).work;
  const homeAgents = join(state.personalHome, '.claude', 'agents'), projectAgents = join(root, '.claude', 'agents');
  await mkdir(homeAgents, { recursive: true });
  await writeFile(join(homeAgents, 'private.md'), 'synthetic home agent');
  await expect(verifyPerchStartupIsolation(root)).resolves.toBeUndefined();
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, 'private.md'), 'synthetic project agent');
  await expect(verifyPerchStartupIsolation(root)).rejects.toMatchObject({ code: 'refused' });
});
it('discards personal skills, including colliding vendor names, while keeping workspace metadata absent', async () => {
  const content = 'SYNTHETIC_PRIVATE_SKILL_MUST_NOT_REACH_THE_CALLER';
  const folder = join(state.personalHome, '.agents', 'skills', 'spreadsheets'); await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'SKILL.md'), content);
  await expect(verifyPerchStartupIsolation(perchPaths(directory).work)).resolves.toBeUndefined();
  const f = fake({ nativeSnapshot: { selectedSkills: ['spreadsheets'] } }); await source(f.processes).complete(request(), AbortSignal.timeout(2000));
  expect(JSON.stringify(f.requests)).not.toContain(content);
});
it('rejects even empty project metadata and global colliding Perch skills before native startup', async () => {
  const p = perchPaths(directory); await mkdir(join(p.work, '.perch'));
  await expect(verifyPerchStartupIsolation(p.work)).rejects.toMatchObject({ code: 'refused' });
  await rm(join(p.work, '.perch'), { recursive: true });
  await mkdir(join(p.work, '.git')); await expect(verifyPerchStartupIsolation(p.work)).rejects.toMatchObject({ code: 'refused' });
  await rm(join(p.work, '.git'), { recursive: true });
  const collision = join(state.personalHome, '.perch', 'skills', 'spreadsheets'); await mkdir(collision, { recursive: true }); await writeFile(join(collision, 'SKILL.md'), 'private collision');
  const f = fake(); await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
  expect(f.memory).not.toHaveBeenCalled(); expect(f.acp).not.toHaveBeenCalled();
});
it('accepts only immutable public vendor builtin IDs from the pinned native bundle', async () => {
  const f = fake({ nativeSnapshot: { selectedSkills: [...PERCH_BUILTIN_SKILLS] } });
  await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'Hello.' });
});
it('refreshes through official ACP before binding CLI status identity, without generating', async () => {
  const f = fake(); expect(await verifyPerchIdentity(directory, AbortSignal.timeout(2000), f.processes)).toEqual({ email: 'owner@example.test' });
  expect(f.requests.map(r => r.method)).toEqual(['initialize', 'session/new']); expect(f.command).toHaveBeenCalledWith(process.execPath, [perchPaths(directory).binary, 'status'], expect.objectContaining({ timeoutMs: 10000 }));
  expect(await readdir(perchPaths(directory).work)).toEqual([]);
});
it('keeps availability metadata-only and validates exact pinned native identity before every inference', async () => {
  const f = fake(), s = source(f.processes); expect(await s.available()).toBe(true); expect(f.acp).not.toHaveBeenCalled(); expect(f.memory).not.toHaveBeenCalled();
  expect(await s.complete(request(), AbortSignal.timeout(2000))).toEqual({ text: 'Hello.', inputTokens: 300, outputTokens: 10 });
  expect(f.requests.map(r => r.method)).toEqual(['initialize', 'session/new', 'session/prompt']);
  expect(f.acp.mock.calls[0]![1].cwd).not.toBe(directory); expect(f.acp.mock.calls[0]![1].env.HOME).toBe(process.env.HOME);
  expect(vi.mocked(open).mock.calls.map(c => c[0])).not.toContain(perchPaths(directory).authFile);
  expect(await readdir(perchPaths(directory).work)).toEqual([]);
});
it('checks current account memory switches before native inference and never configures them in Source', async () => {
  const f = fake(), s = source(f.processes);
  await s.complete(request(), AbortSignal.timeout(1000));
  expect(f.memory).toHaveBeenCalledWith(perchPaths(directory).binary, expect.objectContaining({ timeoutMs: 30000 }), false);
  expect(f.memory.mock.invocationCallOrder[0]).toBeLessThan(f.acp.mock.invocationCallOrder[0]!);
  f.memory.mockRejectedValueOnce(new SourceError('refused', 'Memory is On'));
  const before = f.acp.mock.calls.length;
  await expect(s.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(f.acp).toHaveBeenCalledTimes(before);
});
it.each([{ email: 'another@example.test' }, { version: '9.9.9' }, { mode: 'take_the_wheel' }])('rejects wrong native identity/version/permissions before a model call %j', async options => {
  const f = fake(options); await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000))).rejects.toBeInstanceOf(Error);
  expect(f.requests.some(r => r.method === 'session/prompt')).toBe(false);
});
it('preserves the user payload verbatim while clearly identifying the Grunt caller', async () => {
  const content = 'Pi and Freebuff are literal user words.\nKeep them unchanged.'; const f = fake(); await source(f.processes).complete(request({ messages: [{ role: 'user', content }] }), AbortSignal.timeout(2000));
  const params = f.requests.find(r => r.method === 'session/prompt')!.params;
  const prompt = (params.prompt as { text: string }[])[0]!.text; expect(prompt).toContain('Grunt caller');
  const payload = JSON.parse(prompt.split('\n').at(-1)!); expect(payload.messages[0].content).toBe(content);
  // Our instructions never name Pi; only the caller's own payload does.
  expect(prompt.split('\n').slice(0, -1).join('\n')).not.toMatch(/\bPi\b/); expect(prompt).toContain('is available to you now');
});
it('surfaces native truncation and omits the budget instruction by default', async () => {
  const f = fake({ stopReason: 'max_tokens', envelope: '{"type":"calls",' });
  await expect(source(f.processes).complete(request({ maxTokens: undefined }), AbortSignal.timeout(2000))).resolves.toMatchObject({ text: '', finishReason: 'length' });
  expect(JSON.stringify(f.requests.find(r => r.method === 'session/prompt'))).not.toContain('Keep total output');
});
it('rejects unsupported images and oversized caller prompts before native startup', async () => {
  const f = fake(), s = source(f.processes);
  await expect(s.complete(request({ imageInput: true }), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  await expect(s.complete(request({ messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] }), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(f.acp).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, NaN])('rejects invalid output budgets before starting a process (%s)', async maxTokens => {
  const f = fake(); await expect(source(f.processes).complete(request({ maxTokens }), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(f.acp).not.toHaveBeenCalled();
});
it('does not raise a caller budget of one token or retry a rejected over-budget answer', async () => {
  const f = fake(); await expect(source(f.processes).complete(request({ maxTokens: 1 }), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'upstream' });
  expect(f.requests.filter(r => r.method === 'session/prompt')).toHaveLength(1); expect(JSON.stringify(f.requests.at(-1))).toContain('below 1 tokens');
});
it.each([{ modelId: 'different' }, { modelLabel: 'DeepSeek Pro' }, { cliLocalTools: true }, { selectedSkills: ['unexpected'] }, { selectedSkills: ['spreadsheets', 'spreadsheets'] }, { selectedSkills: ['personal:spreadsheets'] }, { selectedSkills: [{ id: 'spreadsheets' }] }, { sectionBreakdown: { project_memory: { chars: 1 }, permanent_memory: { chars: 0 } } }, { compacted: true }, { truncated: true }, { contextLimitTokens: 128000 }])('fails closed on unexpected native model/context %j', async nativeSnapshot => {
  const f = fake({ nativeSnapshot }); await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' });
});
it.each([{ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 200, totalTokens: 110 }, { inputTokens: 100, outputTokens: 1025, totalTokens: 1125 }, { inputTokens: -1, outputTokens: 10, totalTokens: 9 }, {}])('rejects missing, inconsistent or over-budget authoritative usage %j', async usage => {
  const f = fake({ nativeSnapshot: { turnApiUsage: usage } }); await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'upstream' });
});
it('rejects malformed envelopes without a second generation and preserves a valid free receipt', async () => {
  const f = fake({ envelope: 'plain invalid answer' }); await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'upstream' });
  expect(f.requests.filter(r => r.method === 'session/prompt')).toHaveLength(1); expect((await readPerchFreePlanReceipt(directory)).plan).toBe('Starter');
});
it('rejects uncorrelated input tool results before any native process', async () => {
  const f = fake(); await expect(source(f.processes).complete(request({ messages: [{ role: 'tool', tool_call_id: 'missing', content: 'invented' }] }), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' }); expect(f.acp).not.toHaveBeenCalled();
});
it('validates native-free caller tool arguments and coalesces parallel Responses call-only turns', async () => {
  const tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
  const f = fake({ envelope: '{"version":1,"type":"calls","calls":[{"name":"echo","arguments":{"value":"nonce"}}]}' });
  const out = await source(f.processes).complete(request({ tools }), AbortSignal.timeout(2000)); expect(out.calls?.[0]?.function).toEqual({ name: 'echo', arguments: '{"value":"nonce"}' });
  expect(encode(out, 'perch', 'responses').output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call', name: 'echo', arguments: '{"value":"nonce"}' })]));
  const good = fake();
  const decoded = decode({ model: 'perch', input: [{ role: 'user', content: 'Call twice.' },
    { type: 'function_call', call_id: 'a', name: 'echo', arguments: '{"value":"a"}' },
    { type: 'function_call', call_id: 'b', name: 'echo', arguments: '{"value":"b"}' },
    { type: 'function_call_output', call_id: 'a', output: 'a' }, { type: 'function_call_output', call_id: 'b', output: 'b' }],
    tools: tools.map(t => ({ type: 'function', ...t.function })), max_output_tokens: 1024 }, 'responses', directory);
  await source(good.processes).complete(decoded, AbortSignal.timeout(2000));
  const prompt = (good.requests.at(-1)!.params.prompt as { text: string }[])[0]!.text; expect(JSON.parse(prompt.split('\n').at(-1)!).messages.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(1);
});
it('rejects invalid tool schemas and wrong returned argument types without executing them', async () => {
  const f = fake(), s = source(f.processes);
  await expect(s.complete(request({ tools: [{ type: 'function', function: { name: 'bad', parameters: { $ref: 'https://untrusted.test/schema' } } }] }), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'refused' });
  expect(f.acp).not.toHaveBeenCalled();
  const bad = fake({ envelope: '{"version":1,"type":"calls","calls":[{"name":"echo","arguments":{"value":12}}]}' });
  await expect(source(bad.processes).complete(request({ tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }] }), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'upstream' });
});
it('denies unexpected native actions and invalidates their free verification', async () => {
  const f = fake({ nativeTool: true }); await expect(source(f.processes).complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'refused' }); await expect(readPerchFreePlanReceipt(directory)).rejects.toThrow();
});
it('cancels a running turn, preserves entitlement, cleans private state and rejects concurrent turns', async () => {
  const f = fake({ pause: true }), s = source(f.processes), controller = new AbortController(); const running = s.complete(request(), controller.signal); const rejected = expect(running).rejects.toMatchObject({ code: 'cancelled' });
  await vi.waitFor(() => expect(f.requests.some(r => r.method === 'session/prompt')).toBe(true));
  await expect(s.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'quota', retryAfter: 1 });
  controller.abort(); await rejected; expect((await readPerchFreePlanReceipt(directory)).plan).toBe('Starter'); expect(await readdir(perchPaths(directory).work)).toEqual([]);
});
it('shuts down in-flight native work without deleting valid account verification', async () => {
  const f = fake({ pause: true }), s = source(f.processes); const running = s.complete(request(), AbortSignal.timeout(2000)); const rejected = expect(running).rejects.toMatchObject({ code: 'cancelled' });
  await vi.waitFor(() => expect(f.requests.some(r => r.method === 'session/prompt')).toBe(true)); await s.close(); await rejected;
  expect((await readPerchFreePlanReceipt(directory)).plan).toBe('Starter'); expect(await s.available()).toBe(false);
});
it('times out a native turn while preserving account verification and cleaning its workspace', async () => {
  const f = fake({ pause: true }), s = source(f.processes, 100);
  await expect(s.complete(request(), AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'timeout' });
  expect((await readPerchFreePlanReceipt(directory)).plan).toBe('Starter'); expect(await readdir(perchPaths(directory).work)).toEqual([]);
});

it('executes commands without a shell, handles split UTF-8, and allows a distinct login deadline', async () => {
  const script = join(directory, 'command.cjs'); await writeFile(script, `const b=Buffer.from('hello é\\n');process.stdout.write(b.subarray(0,7));setTimeout(()=>process.stdout.write(b.subarray(7)),5)`);
  const lines: string[] = []; const result = await runPerchCommand(process.execPath, [script], { cwd: directory, env: { PATH: process.env.PATH }, signal: AbortSignal.timeout(1000), timeoutMs: 600000, onLine: line => lines.push(line) });
  expect(result).toEqual({ stdout: 'hello é\n', code: 0 }); expect(lines).toEqual(['hello é']);
});
it('rejects oversized raw command output without returning sensitive diagnostics', async () => {
  const script = join(directory, 'oversized.cjs'); await writeFile(script, `process.stderr.write('synthetic-sensitive'.repeat(1000));setInterval(()=>{},1000)`);
  await expect(runPerchCommand(process.execPath, [script], { cwd: directory, env: {}, signal: AbortSignal.timeout(1000), maxOutputBytes: 100 })).rejects.toMatchObject({ code: 'upstream', message: 'Perch output exceeded the supported size' });
});
it('bounds ACP messages, correlates replies and blocks server requests without exposing raw errors', async () => {
  const script = join(directory, 'acp.cjs'); await writeFile(script, `let p='';process.stdin.on('data',b=>{p+=b;let n;while((n=p.indexOf('\\n'))>=0){const j=JSON.parse(p.slice(0,n));p=p.slice(n+1);if(j.method==='danger')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:900,method:'session/request_permission',params:{}})+'\\n');else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{ok:true}})+'\\n')}});`);
  const client = await openPerchACP(script, { cwd: directory, env: {}, signal: AbortSignal.timeout(1000) });
  expect(await client.request('initialize', {})).toEqual({ ok: true }); await expect(client.request('danger', {})).rejects.toMatchObject({ code: 'refused' }); await client.close();
});
it('cancels only its owned ACP process group and leaves unrelated processes alive', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const script = join(directory, 'hang.cjs'); await writeFile(script, `process.stdin.on('data',()=>{});setInterval(()=>{},1000);`);
  const controller = new AbortController(), client = await openPerchACP(script, { cwd: directory, env: {}, signal: controller.signal });
  const pending = client.request('initialize', {}), rejected = expect(pending).rejects.toBeInstanceOf(Error); controller.abort(); await rejected; await client.close();
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow(); unrelated.kill('SIGKILL'); await new Promise(resolveExit => unrelated.once('close', resolveExit));
});
it('actually hashes public core files and refuses altered bytes and symlinked parent directories', async () => {
  const actual = await vi.importActual<typeof ProcessModule>('./perch-process.js');
  const pkg = join(directory, 'core'); await mkdir(join(pkg, 'bin'), { recursive: true, mode: 0o700 }); const text = 'public executable'; await writeFile(join(pkg, 'bin', 'perch'), text, { mode: 0o700 });
  const hashes = { 'bin/perch': createHash('sha256').update(text).digest('hex') };
  await expect(actual.verifyPerchCoreFiles(pkg, hashes, AbortSignal.timeout(1000))).resolves.toBeUndefined();
  await writeFile(join(pkg, 'bin', 'perch'), 'altered'); await expect(actual.verifyPerchCoreFiles(pkg, hashes, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'not_installed' });
  await rm(join(pkg, 'bin'), { recursive: true }); await symlink(perchPaths(directory).package, join(pkg, 'bin'));
  await expect(actual.verifyPerchCoreFiles(pkg, hashes, AbortSignal.timeout(1000))).rejects.toBeInstanceOf(Error);
});
async function memoryNative(rows = '  Use memory                Off                      memory\n  Learn new memories        Off                      learn-memories\n') {
  const path = join(directory, "native ' quoted.cjs"), seen = join(directory, 'settings-commands.json');
  await writeFile(path, `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});let lines=[];
process.stdout.write('perch · field terminal v2.4.132\\n signed in as owner@example.test · saffron · ask · plan\\n');process.stdout.write('you› ');
rl.on('line',line=>{lines.push(line);fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify(lines));if(line==='/exit'){process.exit(0);return;}if(line==='/settings memory')process.stdout.write(${JSON.stringify(rows)});else if(!['/settings memory off','/settings learn-memories off'].includes(line)){process.exit(9);return;}process.stdout.write('you› ');});`);
  return { path, seen };
}
it('reads actual native settings in an owned PTY with fixed commands and safe quoted paths', async () => {
  const native = await memoryNative(), trap = join(directory, 'startup-trap');
  const env = { ...process.env, SHELL: '/missing/malicious-shell', BASH_ENV: trap, ENV: trap, ZDOTDIR: trap };
  await expect(runPerchMemorySettings(native.path, { cwd: directory, env, signal: AbortSignal.timeout(2000) })).resolves.toEqual({ email: 'owner@example.test' });
  expect(JSON.parse(await readFile(native.seen, 'utf8'))).toEqual(['/settings memory', '/exit']);
  await expect(runPerchMemorySettings(native.path, { cwd: directory, env, signal: AbortSignal.timeout(2000) }, true)).resolves.toEqual({ email: 'owner@example.test' });
  expect(JSON.parse(await readFile(native.seen, 'utf8'))).toEqual(['/settings memory off', '/settings learn-memories off', '/settings memory', '/exit']);
});
it.each([
  ' Use memory On memory\n Learn new memories Off learn-memories\n',
  ' Use memory Off memory\n Use memory On memory\n Learn new memories Off learn-memories\n',
  ' Use memory Off memory\n Learn new memories Off learn-memories\n Learn new memories On learn-memories\n',
  '/settings Use memory Off memory\n Learn new memories Off learn-memories\n'
])('rejects On, ambiguous, or echoed memory claims before any model invocation', async rows => {
  const native = await memoryNative(rows);
  await expect(runPerchMemorySettings(native.path, { cwd: directory, env: process.env, signal: AbortSignal.timeout(2000) })).rejects.toMatchObject({ code: 'refused' });
  expect(JSON.parse(await readFile(native.seen, 'utf8'))).toEqual(['/settings memory']);
});
it('cancels the owned PTY native group even when its child ignores terminal hangup', async () => {
  const path = join(directory, 'native-hang.cjs'), pidFile = join(directory, 'native.pid');
  await writeFile(path, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const controller = new AbortController(), pending = runPerchMemorySettings(path, { cwd: directory, env: process.env, signal: controller.signal });
  const rejected = expect(pending).rejects.toBeInstanceOf(Error); let pid: number | undefined;
  try {
    for (let n = 0; n < 50; n++) { try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)); } }
    expect(pid).toBeGreaterThan(1); controller.abort(); await rejected;
    for (let n = 0; n < 20; n++) { try { process.kill(pid!, 0); } catch { break; } await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
    expect(() => process.kill(pid!, 0)).toThrow(); expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  } finally {
    controller.abort(); await pending.catch(() => {}); if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* Already cleaned. */ }
    unrelated.kill('SIGKILL'); await new Promise(resolveExit => unrelated.once('close', resolveExit));
  }
});
it('accepts every tool of a recorded Claude Code request', async () => {
  for (const index of [0, 1, 2] as const) {
    const f = fake(); await expect(source(f.processes).complete({ ...claudeCodeRequest(index, 'perch'), cwd: directory, maxTokens: 1024 }, AbortSignal.timeout(2000))).resolves.toMatchObject({ text: 'Hello.' });
    const prompt = (f.requests.at(-1)!.params.prompt as { text: string }[])[0]!.text;
    expect(JSON.parse(prompt.split('\n').at(-1)!).tools).toEqual(claudeCodeRequest(0).tools);
  }
});
