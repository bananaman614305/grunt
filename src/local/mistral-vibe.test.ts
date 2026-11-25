import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mistralVibeEnvironment, MistralVibe, MISTRAL_VIBE_MODEL, MISTRAL_VIBE_WIRE_MODEL, mistralVibePaths, readMistralVibeFreePlanReceipt, writeMistralVibeFreePlanReceipt } from './mistral-vibe.js';
import type { ModelRequest } from './source.js';
import { Sources } from './source.js';
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const receipt = () => ({ version: 1 as const, plan: 'Free' as const, payAsYouGo: false as const, paymentMethodPresent: false as const, purchasedCredits: 0 as const, checkedAt: new Date().toISOString() });
const request = (text = 'hello'): ModelRequest => ({ model: 'mistral-vibe', messages: [{ role: 'user', content: text }], tools: [], cwd: tmpdir(), stream: false });
async function fixture(mode = 'answer', nativeStop = '') {
  const directory = await mkdtemp(join(tmpdir(), 'mistral-vibe-test-')); directories.push(directory);
  const paths = mistralVibePaths(directory); await mkdir(join(paths.home, 'bin'), { recursive: true, mode: 0o700 }); await chmod(paths.home, 0o700);
  await writeFile(join(paths.home, '.env'), 'MISTRAL_API_KEY=synthetic-private-vibe-key\n', { mode: 0o600 }); await writeMistralVibeFreePlanReceipt(directory, receipt());
  const snapshot = join(directory, 'snapshot.json'); vi.stubEnv('MISTRAL_TEST_SNAPSHOT', snapshot); vi.stubEnv('MISTRAL_TEST_MODE', mode);
  vi.stubEnv('MISTRAL_TEST_NATIVE_STOP', nativeStop);
  await writeFile(paths.binary, `#!${process.execPath}\n${String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],prompt=fs.readFileSync(arg('--prompt-file'),'utf8'),mode=process.env.MISTRAL_TEST_MODE;
fs.writeFileSync(process.env.MISTRAL_TEST_SNAPSHOT,JSON.stringify({args,prompt,promptMode:fs.statSync(arg('--prompt-file')).mode&511,workdir:process.cwd(),hasShellApiKey:!!process.env.MISTRAL_API_KEY,outputCap:process.env.VIBE_AGENT_MAX_OUTPUT_TOKENS,allowed:JSON.parse(process.env.VIBE_ALLOWED_MODELS),models:process.env.VIBE_MODELS?JSON.parse(process.env.VIBE_MODELS):null,providers:JSON.parse(process.env.VIBE_PROVIDERS),enableMcp:process.env.VIBE_ENABLE_MCP,compaction:JSON.parse(process.env.VIBE_COMPACTION_MODEL)}),{mode:384});
if(mode==='hang'){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.env.MISTRAL_TEST_SNAPSHOT+'.pid',String(child.pid));setInterval(()=>{},1000);return;}
const alias='zai-glm-5-3-flash',wire='zai-glm-5-3-flash-vibe-free';
let text='hello from GLM';if(mode==='tools')text=JSON.stringify({version:1,type:'calls',calls:[{name:'read_file',arguments:{path:'src/example.ts'}}]});
if(mode==='repair')text=prompt.includes('only repair attempt')?JSON.stringify({version:1,type:'final',text:'repaired'}):'not valid JSON';
if(mode==='badtool')text=JSON.stringify({version:1,type:'calls',calls:[{name:'unavailable_tool',arguments:{}}]});
const history=[{type:'message',role:'user',generationStatus:'completed',content:[{type:'text',text:prompt}]},{type:'reasoning',text:'private deliberation must not become the answer'},{type:'message',role:'assistant',generationStatus:'completed',content:[{type:'text',text}]}];
if(mode==='native-tool')history.splice(1,0,{type:'effect',detail:{toolName:'bash'}});
const config={active_model:alias,models:{[alias]:{name:mode==='wrong-model'?'mistral-medium-latest':wire,provider:'mistral',max_context_length:262144,auto_compact_threshold:202144}},providers:[{name:'mistral',api_base:mode==='wrong-host'?'https://example.com/v1':'https://api.mistral.ai/v1'}]};
config.compaction_model={name:mode==='paid-compactor'?'mistral-medium-latest':wire,provider:'mistral'};
if(mode==='two-assistant-entries')history.splice(2,0,{type:'message',role:'assistant',generationStatus:'completed',content:[{type:'text',text:'preliminary'}]});
const nativeStop=process.env.MISTRAL_TEST_NATIVE_STOP||(mode==='two-assistant-entries'&&Number(arg('--max-turns'))<2?'turn_limit':'');
const exitCode=nativeStop?3:mode==='quota'?2:0;
const exported={exit_code:exitCode,outcome:nativeStop||(mode==='quota'?'infrastructure_failure':'finished'),config,usage:{input_tokens:200843,output_tokens:26},error:mode==='quota'?{code:'quota_exhausted',message:'private-secret-upstream-error'}:null};
fs.mkdirSync(arg('--output-dir'),{recursive:true,mode:448});fs.writeFileSync(path.join(arg('--output-dir'),'export.json'),JSON.stringify(exported),{mode:384});
process.stdout.write(mode==='malformed'?'not json':JSON.stringify(history),()=>process.exit(exitCode));
`}`, { mode: 0o700 });
  return { directory, paths, snapshot, source: new MistralVibe({ directory, timeout: 5000 }) };
}
it('uses only the fixed native Free model, private prompt files, and native usage for large prompts', async () => {
  const f = await fixture(); vi.stubEnv('MISTRAL_API_KEY', 'unrelated-paid-shell-key'); vi.stubEnv('VIBE_COMPACTION_MODEL', '{"name":"mistral-medium-latest","provider":"mistral"}');
  const prompt = ' x'.repeat(210000);
  try {
    expect(await f.source.available()).toBe(true);
    await expect(f.source.complete({ ...request(prompt), maxTokens: 10000 }, AbortSignal.timeout(5000))).resolves.toEqual({ text: 'hello from GLM', inputTokens: 200843, outputTokens: 26 });
    const sent = JSON.parse(await readFile(f.snapshot, 'utf8'));
    expect(sent.prompt).toBe(prompt); expect(sent.args).toContain('--prompt-file'); expect(sent.args).not.toContain(prompt); expect(sent.promptMode).toBe(0o600);
    expect(sent.args.slice(0, 4)).toEqual(['--model', MISTRAL_VIBE_MODEL, '--disabled-tools', '*']);
    expect(sent.compaction.name).toBe(MISTRAL_VIBE_WIRE_MODEL); expect(sent.hasShellApiKey).toBe(false); expect(sent.outputCap).toBe('10000'); expect(sent.allowed).toEqual([MISTRAL_VIBE_WIRE_MODEL]);
    expect(sent.models).toEqual([{ name: MISTRAL_VIBE_WIRE_MODEL, alias: MISTRAL_VIBE_MODEL, provider: 'mistral', max_context_length: 262144, auto_compact_threshold: 202144, thinking: 'high', thinking_levels: ['low', 'high', 'max'] }]);
    expect(sent.providers[0].api_base).toBe('https://api.mistral.ai/v1'); expect(sent.enableMcp).toBe('false'); expect(sent.workdir).toBe(f.paths.work);
    await expect(readFile(sent.args[sent.args.indexOf('--prompt-file') + 1])).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.source.close(); }
});
it('accepts a finished native answer after a second assistant entry with native tools disabled', async () => {
  const f = await fixture('two-assistant-entries');
  try {
    await expect(f.source.complete(request(), AbortSignal.timeout(5000))).resolves.toMatchObject({ text: 'hello from GLM', outputTokens: 26 });
    const sent = JSON.parse(await readFile(f.snapshot, 'utf8'));
    expect(sent.args[sent.args.indexOf('--max-turns') + 1]).toBe('2');
    expect(sent.args[sent.args.indexOf('--disabled-tools') + 1]).toBe('*');
  } finally { await f.source.close(); }
});

it('preserves the complete conversation in fresh native requests', async () => {
  const f = await fixture();
  try {
    const messages = [{ role: 'system', content: 'Answer concisely' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'followup' }];
    await f.source.complete({ ...request(), messages }, AbortSignal.timeout(5000));
    expect(JSON.parse(await readFile(f.snapshot, 'utf8')).prompt).toContain(JSON.stringify(messages));
  } finally { await f.source.close(); }
});
it('bridges only validated caller function tools and never returns native reasoning', async () => {
  const f = await fixture('tools');
  try {
    expect(f.source.supportsFunctionTools).toBe(true);
    const tools = [{ type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
    const completion = await f.source.complete({ ...request('read the file'), tools }, AbortSignal.timeout(5000));
    expect(completion.text).toBe(''); expect(completion.calls).toHaveLength(1); expect(completion.calls![0]!.function).toEqual({ name: 'read_file', arguments: '{"path":"src/example.ts"}' });
    const sent = JSON.parse(await readFile(f.snapshot, 'utf8')); expect(sent.prompt).toContain('native Mistral Vibe tools'); expect(sent.prompt).toContain(JSON.stringify(tools));
    // The model is told plainly that the listed tools can be called now, and is never shown another harness's name.
    expect(sent.prompt.split('\n').slice(0, -1).join('\n')).not.toMatch(/\bPi\b/); expect(sent.prompt).toContain('is available to you now'); expect(f.source.jsonToolBridge).toBe(true);
  } finally { await f.source.close(); }
});
it('allows one protocol repair and accounts for both native calls', async () => {
  const f = await fixture('repair');
  try {
    const tools = [{ type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object' } } }];
    await expect(f.source.complete({ ...request(), tools, maxTokens: 60 }, AbortSignal.timeout(5000))).resolves.toEqual({ text: 'repaired', inputTokens: 401686, outputTokens: 52 });
    expect(JSON.parse(await readFile(f.snapshot, 'utf8')).outputCap).toBe('34');
    await expect(f.source.complete({ ...request(), tools, maxTokens: 26 }, AbortSignal.timeout(5000)))
      .resolves.toMatchObject({ text: '', finishReason: 'length', outputTokens: 26 });
    expect(JSON.parse(await readFile(f.snapshot, 'utf8')).prompt).not.toContain('only repair attempt');
  } finally { await f.source.close(); }
});

it('falls back from a truncated bridge result without exposing its partial tool protocol', async () => {
  const f = await fixture('tools', 'length');
  const backup = { id: 'backup', supportsFunctionTools: true, available: async () => true,
    complete: vi.fn(async () => ({ text: 'usable answer' })) };
  const pool = new Sources([f.source, backup]);
  const tools = [{ type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object' } } }];
  const payload = { ...request(' word'.repeat(35_000)), model: 'grunt', tools, maxTokens: 4096 };
  try {
    await expect(pool.complete(payload, AbortSignal.timeout(5000))).resolves.toEqual({ text: 'usable answer' });
    expect(backup.complete).toHaveBeenCalledExactlyOnceWith(payload, expect.any(AbortSignal));
    await expect(pool.complete({ ...payload, model: f.source.id }, AbortSignal.timeout(5000)))
      .resolves.toMatchObject({ text: '', finishReason: 'length', outputTokens: 26 });
    expect(backup.complete).toHaveBeenCalledOnce();
  } finally { await pool.close(); }
});

it.each([
  ['wrong-model', 'completion_model'], ['malformed', 'response_json'], ['native-tool', 'response_tools'], ['badtool', 'completion_protocol']
])('identifies %s failure stages without retaining rejected native content', async (mode, failureReason) => {
  const f = await fixture(mode);
  try {
    const tools = mode === 'badtool' ? [{ type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object' } } }] : [];
    const failure = await f.source.complete({ ...request(), tools }, AbortSignal.timeout(5000)).catch(error => error);
    expect(failure.diagnostics).toEqual({ transport: 'cli', endpointLabel: 'cli', failureReason });
    expect(JSON.stringify(failure.diagnostics)).not.toContain('unavailable_tool');
    expect(failure.output).toBeUndefined();
  } finally { await f.source.close(); }
});

it('bridges completed historical ID reuse without changing tool results or native safety limits', async () => {
  const f = await fixture('tools');
  try {
    const tools = [{ type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object' } } }];
    const call = { id: 'call_0', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } };
    const messages = [{ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'first result' },
      { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'second result' }, { role: 'user', content: 'continue' }];
    const original = structuredClone(messages);
    const completion = await f.source.complete({ ...request(), messages, tools }, AbortSignal.timeout(5000));
    expect(completion.calls).toHaveLength(1);
    expect(messages).toEqual(original);
    const sent = JSON.parse(await readFile(f.snapshot, 'utf8'));
    expect(JSON.parse(sent.prompt.split('\n').at(-1)).messages).toEqual(original);
    expect(sent.args.slice(0, 4)).toEqual(['--model', MISTRAL_VIBE_MODEL, '--disabled-tools', '*']);
    expect(sent.hasShellApiKey).toBe(false);
  } finally { await f.source.close(); }
});
it.each(['wrong-model', 'wrong-host', 'paid-compactor', 'malformed', 'native-tool', 'badtool', 'quota'])('rejects %s without leaking raw native errors or accepting another model', async mode => {
  const f = await fixture(mode);
  try {
    const tools = mode === 'badtool' ? [{ type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object' } } }] : [];
    const error = await f.source.complete({ ...request(), tools }, AbortSignal.timeout(5000)).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('private-secret-upstream-error');
    expect(error.code).toBe(mode === 'quota' ? 'quota' : mode === 'native-tool' ? 'refused' : 'upstream');
  } finally { await f.source.close(); }
});
it.each([
  ['quota', 'turn_limit', 'quota', 'turn_limit'],
  ['answer', 'refusal', 'refused', 'refusal'],
  ['answer', 'private-secret-upstream-error', 'upstream', undefined],
])('records only known exit-3 outcomes for %s / %s', async (mode, stop, code, failureReason) => {
  const f = await fixture(mode, stop);
  try {
    const error = await f.source.complete(request(), AbortSignal.timeout(5000)).catch(error => error);
    expect(error.code).toBe(code);
    expect(error.diagnostics).toEqual({ transport: 'cli', endpointLabel: 'cli', exitCode: 3,
      ...(failureReason ? { failureReason } : {}) });
    expect(error.message).not.toContain('private-secret-upstream-error');
  } finally { await f.source.close(); }
});
it.each(['length', 'token_limit'])('returns the native %s cutoff', async reason => {
  const f = await fixture('answer', reason);
  try {
    await expect(f.source.complete(request(), AbortSignal.timeout(5000))).resolves.toMatchObject({ finishReason: 'length', outputTokens: 26 });
    expect(JSON.parse(await readFile(f.snapshot, 'utf8'))).not.toHaveProperty('outputCap');
  }
  finally { await f.source.close(); }
});
it('requires a fresh Free/no-overage/no-payment receipt and private native authentication', async () => {
  const f = await fixture();
  try {
    await writeFile(f.paths.receipt, JSON.stringify({ ...receipt(), checkedAt: new Date(Date.now() - 31 * 86400000).toISOString() }), { mode: 0o600 });
    expect(await f.source.available()).toBe(false); await expect(f.source.complete(request(), AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'logged_out' });
    await expect(writeMistralVibeFreePlanReceipt(f.directory, { ...receipt(), payAsYouGo: true } as never)).rejects.toMatchObject({ code: 'logged_out' });
    await writeMistralVibeFreePlanReceipt(f.directory, receipt()); await chmod(join(f.paths.home, '.env'), 0o644); expect(await f.source.available()).toBe(false);
    await chmod(join(f.paths.home, '.env'), 0o600); await chmod(f.paths.receipt, 0o644); await expect(readMistralVibeFreePlanReceipt(f.directory)).rejects.toMatchObject({ code: 'logged_out' });
  } finally { await f.source.close(); }
});
it('cancellation and shutdown stop only the owned CLI process group and remove temporary prompts', async () => {
  const f = await fixture('hang'); const controller = new AbortController();
  try {
    const pending = f.source.complete(request(), controller.signal);
    const watched = pending.catch(error => error);
    let pid: number | undefined;
    for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(f.snapshot + '.pid', 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    expect(pid).toBeGreaterThan(0); controller.abort(new Error('caller cancelled')); expect((await watched).message).toBe('caller cancelled');
    await f.source.close();
    if (process.platform === 'linux' && pid) {
      // The wrapper can exit before Linux finishes delivering the signal to its child.
      await expect.poll(async () => {
        const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return 'gone';
          throw error;
        });
        return status === 'gone' || /^\d+ \(.+\) Z /.test(status);
      }, { timeout: 2000 }).toBe(true);
    }
    const sent = JSON.parse(await readFile(f.snapshot, 'utf8')); await expect(readFile(sent.args[sent.args.indexOf('--prompt-file') + 1])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.source.available()).toBe(false);
  } finally { controller.abort(); await f.source.close(); }
});

it('scrubs case-insensitive native and nested environment overrides before setting private auth', () => {
  vi.stubEnv('vibe_models__zai-glm-5-3-flash__name', 'paid-model'); vi.stubEnv('ViBe_COMPACTION_MODEL__name', 'paid-compactor'); vi.stubEnv('mistral_api_key', 'other-key');
  const env = mistralVibeEnvironment('/private/config');
  expect(env['vibe_models__zai-glm-5-3-flash__name']).toBeUndefined(); expect(env.ViBe_COMPACTION_MODEL__name).toBeUndefined(); expect(env.mistral_api_key).toBeUndefined();
  expect(env.VIBE_HOME).toBe('/private/config/mistral-vibe');
});
it.each(['deadline', 'shutdown'])('classifies %s correctly during a bridged native call', async mode => {
  const f = await fixture('hang'), source = new MistralVibe({ directory: f.directory, timeout: mode === 'deadline' ? 150 : 5000 });
  const tools = [{ type: 'function' as const, function: { name: 'read_file', parameters: { type: 'object' } } }];
  try {
    const result = source.complete({ ...request(), tools }, AbortSignal.timeout(5000)).catch(error => error);
    if (mode === 'shutdown') {
      for (let i = 0; i < 100; i++) { try { await readFile(f.snapshot + '.pid'); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
      await source.close();
    }
    expect((await result).code).toBe(mode === 'deadline' ? 'timeout' : 'cancelled');
  } finally { await source.close(); await f.source.close(); }
});
