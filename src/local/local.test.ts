import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createLocalApp, decode, encode } from './api.js';
import { Gateway, Sources, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { configure, HOST } from './main.js';
import { DiagnosticsStore } from './diagnostics.js';
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const fake = (id = 'second-app'): Source => ({ id, supportsFunctionTools: true, available: async () => true, complete: async r => ({ text: r.messages.at(-1)!.content }) });
const paths = ['chat/completions', 'messages', 'responses'];
afterEach(() => vi.unstubAllEnvs());
describe('harness wire contracts', () => {
  for (const [name, path, api] of [['pi', paths[0], 'chat'], ['opencode', paths[0], 'chat'], ['claude', paths[1], 'messages'], ['codex', paths[2], 'responses']] as const) {
    for (const stream of [false, true]) it(`${name} ${stream ? 'SSE' : 'JSON'} through an independently registered app`, async () => {
      const body = await fixture(name); body.stream = stream;
      expect(body.tools.length).toBeGreaterThan(0);
      body.model = 'second-app';
      const app = createLocalApp(new Sources([fake()]));
      const response = await app.request(`http://localhost:8788/v1/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      expect(response.status).toBe(200);
      if (!stream) {
        const result = await response.json();
        if (api === 'chat') { expect(result.object).toBe('chat.completion'); expect(result.choices[0]).toMatchObject({ index: 0, finish_reason: 'stop', message: { role: 'assistant' } }); expect(typeof result.choices[0].message.content).toBe('string'); }
        if (api === 'messages') expect(result).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: expect.any(String) }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } });
        if (api === 'responses') expect(result).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: expect.any(String), annotations: [] }] }] });
      } else {
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const frames = (await response.text()).trim().split('\n\n').filter(f => f.includes('data:'));
        const data = frames.map(f => f.split('\n').find(l => l.startsWith('data:'))!.slice(5).trim());
        if (api === 'chat') {
          expect(data.pop()).toBe('[DONE]');
          const chunks = data.map(d => JSON.parse(d));
          if (body.stream_options?.include_usage === true) {
            // This fixture source has no measured counts. Requested usage is
            // represented honestly as unknown in the terminal usage chunk.
            expect(chunks.pop()).toMatchObject({ choices: [], usage: null });
            expect(chunks.every(c => c.usage === null)).toBe(true);
          }
          for (const c of chunks) expect(c).toMatchObject({ id: expect.any(String), object: 'chat.completion.chunk', created: expect.any(Number), choices: [{ index: 0, delta: expect.any(Object) }] });
          expect(chunks[0].choices[0].delta.role).toBe('assistant');
          expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
        } else {
          const items = data.map(d => JSON.parse(d));
          const expected = api === 'messages' ? ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'] : ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed'];
          expect(items.map(i => i.type)).toEqual(expected);
          items.forEach((item, index) => { expect(frames[index]).toContain(`event: ${item.type}`); if (api === 'responses') expect(item.sequence_number).toBe(index); });
          if (api === 'messages') { expect(items[0].message.content).toEqual([]); expect(items[2].delta).toMatchObject({ type: 'text_delta', text: expect.any(String) }); }
          else { expect(items[4]).toMatchObject({ output_index: 0, content_index: 0, item_id: expect.any(String), delta: expect.any(String) }); expect(items.at(-1).response.status).toBe('completed'); }
        }
      }
    });
  }
});
it('models, failover, last typed error and loopback binding', async () => {
  const bad: Source = { ...fake('bad'), complete: async () => { throw new SourceError('quota', 'Free hours exhausted'); } };
  const app = createLocalApp(new Sources([bad, fake()]));
  expect((await (await app.request('http://localhost:8788/v1/models')).json()).data.map((m: { id: string }) => m.id)).toEqual(['grunt', 'bad', 'second-app']);
  const body = JSON.stringify({ model: 'grunt', messages: [{ role: 'user', content: 'hello' }] });
  expect((await (await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: {'Content-Type':'application/json'}, body })).json()).choices[0].message.content).toBe('hello');
  for (const path of paths) {
    const response = await createLocalApp(new Sources([bad])).request(`http://localhost:8788/v1/${path}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ input: 'hello', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(response.status).toBe(429); expect((await response.json()).error.code).toBe('quota');
  }
  const server = serve({ fetch: app.fetch, hostname: HOST, port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  expect(server.address()).toMatchObject({ address: '127.0.0.1' });
  await new Promise<void>(resolve => server.close(() => resolve()));
  expect(() => configure({ GRUNT_SOURCES: 'unknown' })).toThrow('Unknown');
});
it('advertises the grunt model while preserving legacy requests and source configuration', async () => {
  const source = fake('custom-app'), sources = new Sources([source]);
  const app = createLocalApp(sources);
  const models = await (await app.request('http://localhost:8788/v1/models')).json();
  expect(models.data).toEqual(['grunt', 'custom-app'].map(id => ({ id, object: 'model', created: 0, owned_by: 'grunt' })));
  expect(decode({ input: 'hello' }, 'responses', '/tmp').model).toBe('grunt');
  expect(decode({ input: 'hello', model: 'milo' }, 'responses', '/tmp').model).toBe('grunt');
  for (const model of ['grunt', 'milo', 'custom-app']) {
    expect(await sources.complete(decode({ input: 'hello', model }, 'responses', '/tmp'), new AbortController().signal)).toEqual({ text: 'hello' });
  }
  for (const env of [{ MILO_SOURCES: 'dots' }, { GRUNT_SOURCES: 'dots', MILO_SOURCES: 'unknown' }]) {
    const configured = configure(env);
    expect(configured.sources.map(source => source.id)).toEqual(['dots']);
    await configured.close();
  }
});
it('gateway only calls configured origin, preserves tools, rejects redirects and fails over availability errors', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'gateway reply' } }] }));
  const gateway = new Gateway('https://configured.invalid/v1', 'synthetic', fetcher);
  const request = decode(await fixture('pi'), 'chat', '/tmp');
  expect(await gateway.complete(request, new AbortController().signal)).toMatchObject({ text: 'gateway reply' });
  expect(fetcher.mock.calls[0]![0]).toBe('https://configured.invalid/v1/chat/completions');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic' } });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).model).toBe('grunt');
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).tools).toEqual(request.tools);
  const bad = new Gateway('https://configured.invalid/v1', '', async () => { throw new Error('offline'); });
  expect(await new Sources([bad, fake()]).complete(request, new AbortController().signal)).toMatchObject({ text: request.messages.at(-1)!.content });
});
it('cwd inference validates absolute paths and falls back cleanly', async () => {
  expect(decode(await fixture('claude'), 'messages', '/fallback').cwd).toBe('/tmp/grunt-harness-cwd');
  expect(decode({ input: 'hi', instructions: '<cwd>/tmp/codex</cwd>' }, 'responses', '/fallback').cwd).toBe('/tmp/codex');
  expect(decode({ messages: [{ role: 'user', content: 'hi' }] }, 'chat', '/fallback').cwd).toBe('/fallback');
  expect(() => decode({ input: 'hi', cwd: 'relative' }, 'responses', '/fallback')).toThrow('absolute');
});
it('fails over to the next source when the first refuses a request', async () => {
  const req: ModelRequest = { model: 'grunt', messages: [{ role: 'user', content: 'REFUSE' }], tools: [], stream: false, cwd: '/tmp' };
  const refused: Source = { ...fake('refused'), complete: async () => { throw new SourceError('refused', 'policy'); } };
  expect(await new Sources([refused, fake()]).complete(req, new AbortController().signal)).toEqual({ text: 'REFUSE' });
});
it('gateway tool replies retain their wire shapes and tool results survive translation', async () => {
  const tool = { id: 'call_1', type: 'function' as const, function: { name: 'read', arguments: '{"path":"a.txt"}' } };
  const source: Source = { ...fake(), complete: async () => ({ text: '', calls: [tool] }) };
  const app = createLocalApp(new Sources([source]));
  for (const path of paths) {
    const response = await app.request(`http://localhost:8788/v1/${path}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ input: 'read', messages: [{ role: 'user', content: 'read' }] }) });
    const result = await response.json();
    if (path === 'messages') expect(result).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } }] });
    if (path === 'responses') expect(result.output).toMatchObject([{ type: 'function_call', call_id: 'call_1', arguments: tool.function.arguments }]);
    if (path === 'chat/completions') expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [tool] } });
  }
  const turn = decode({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'file contents' }] }] }] }, 'messages', '/tmp');
  expect(turn.messages).toEqual([{ role: 'assistant', content: '', tool_calls: [tool] }, { role: 'tool', content: 'file contents', tool_call_id: 'call_1' }]);
});
it('README includes copyable config for each harness', async () => {
  const readme = await readFile(new URL('../../docs/reference.md', import.meta.url), 'utf8');
  for (const name of ['opencode', 'pi', 'Claude Code', 'Codex']) expect(readme).toContain(name);
  for (const key of ['baseURL', 'openai-completions', 'ANTHROPIC_BASE_URL', 'wire_api = "responses"']) expect(readme).toContain(key);
});

it('types only the user text from each harness and removes injected context', async () => {
  const { userTurns } = await import('./harness.js');
  for (const [name, api] of [['claude', 'messages'], ['codex', 'responses'], ['pi', 'chat'], ['opencode', 'chat']]) {
    const request = decode(await fixture(name!), api!, '/tmp');
    const expected = name === 'opencode' ? '"Reply with exactly: bridge works 42. Do not use tools."' : 'Reply with exactly: bridge works 42. Do not use tools.';
    expect(userTurns(request).at(-1)).toBe(expected);
  }
  const request = decode({ input: '<environment_context><cwd>/tmp</cwd></environment_context>\n<system-reminder>secret harness context</system-reminder>\n  Keep my spaces.\n' }, 'responses', '/tmp');
  expect(userTurns(request)).toEqual(['  Keep my spaces.\n']);
  expect(userTurns(decode({messages:[{role:'user',content:[{type:'text',text:'<system-reminder>metadata</system-reminder>\n'},{type:'text',text:'What is 2 + 2?'}]}]},'messages','/tmp'))).toEqual(['What is 2 + 2?']);
});
it('answers housekeeping locally before starting any source', async () => {
  const complete = vi.fn(async () => ({ text: 'unexpected' }));
  const app = createLocalApp(new Sources([{ ...fake(), complete }]));
  for (const path of paths) {
    const response = await app.request(`http://localhost:8788/v1/${path}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({system:'Generate a concise title for this conversation.', instructions:'Generate a concise title for this conversation.', input:'Help me plant tomatoes', messages:[{role:'system',content:'Generate a concise title for this conversation.'},{role:'user',content:'Help me plant tomatoes'}]})});
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Help me plant tomatoes');
  }
  const title = await fixture('claude-title');
  const titleResponse = await app.request('http://localhost:8788/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(title)});
  expect(await titleResponse.text()).toContain('What is 2 + 2?');
  expect(complete).not.toHaveBeenCalled();
  for (const content of ['Write a summary of my notes.', 'Generate a concise title for my essay.', 'Create a topic list for my talk.']) {
    await app.request('http://localhost:8788/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content}]})});
  }
  expect(complete).toHaveBeenCalledTimes(3);
});

// Reproduction local-hardening: exercise public wire translation and process startup.
it.each([{Host:'evil.invalid:8788'}, {Host:'localhost:8788',Origin:''}, {Host:'localhost:8788','Content-Type':'text/plain'}])('rejects unsafe loopback requests without starting a session: %j', async headers => {
  const complete=vi.fn(async()=>({text:'unexpected'}));
  const app=createLocalApp(new Sources([{...fake(),complete}]));
  const response=await app.request('http://localhost:8788/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({messages:[{role:'user',content:'hi'}]})});
  expect([403,415]).toContain(response.status); expect(complete).not.toHaveBeenCalled();
});
it('skips unknown content blocks while retaining text',()=>{
  expect(decode({messages:[{role:'user',content:[{type:'thinking'},{type:'redacted_thinking'},{type:'image'},{type:'input_image'},{type:'text',text:'hi'}]}]},'messages','/tmp').messages).toEqual([{role:'user',content:'hi'}]);
});
it('skips unknown Responses items and serializes structured tool outputs',()=>{
  expect(decode({input:[{type:'reasoning'},{type:'custom_tool_call'},{type:'local_shell_call'},{type:'message',role:'user',content:'hi'},{type:'function_call_output',call_id:'c',output:{ok:true}}]},'responses','/tmp').messages).toEqual([{role:'user',content:'hi'},{role:'tool',tool_call_id:'c',content:'{"ok":true}'}]);
});
it('maps unknown background model ids to the default chain and logs the mapping',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    expect(await new Sources([fake()]).complete(decode({input:'hi',model:'claude-haiku-new'},'responses','/tmp'),new AbortController().signal)).toEqual({text:'hi'});
    expect(log).toHaveBeenCalledWith('grunt model mapping: unrecognized model -> grunt');
    expect(log.mock.calls.flat().join('\n')).not.toContain('claude-haiku-new');
  }finally{log.mockRestore();}
});
it.each(['sk-synthetic-unknown-model-credential', '/private/synthetic-project', 'https://example.invalid/private?token=synthetic'])('routes an unknown model through the default chain without logging credential or path input: %s', async model => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = vi.fn<Source['complete']>(async () => { throw new SourceError('quota', 'Synthetic quota'); });
  const second = vi.fn<Source['complete']>(async request => ({ text: request.messages.at(-1)!.content }));
  const request = decode({ input: 'hi', model }, 'responses', '/tmp');
  try {
    const sources = new Sources([{ ...fake('first-app'), complete: first }, { ...fake('second-app'), complete: second }]);
    await expect(sources.complete(request, new AbortController().signal)).resolves.toEqual({ text: 'hi' });
    expect(first).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
    expect(second).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
    expect(log.mock.calls.map(call => call[0])).toEqual(['grunt model mapping: unrecognized model -> grunt', 'grunt source: first-app failed (quota) for model grunt', 'grunt source: second-app answered model grunt']);
    expect(log.mock.calls.flat().join('\n')).not.toContain(model);
  } finally { log.mockRestore(); }
});
it('logs which source answered each request and which ones failed before it',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  const down:Source={...fake('first-app'),complete:async()=>{throw new SourceError('quota','out');}};
  try {expect(await new Sources([down,fake()]).complete(decode({input:'hi',model:'grunt'},'responses','/tmp'),new AbortController().signal)).toEqual({text:'hi'});
    expect(log.mock.calls.map(c=>c[0])).toEqual(['grunt source: first-app failed (quota) for model grunt','grunt source: second-app answered model grunt']);}finally{log.mockRestore();}
});
it.each([['',{}],['broken','broken']])('encodes tool arguments safely: %s',(arguments_,input)=>{
  expect(encode({text:'',calls:[{id:'c',type:'function',function:{name:'read',arguments:arguments_ as string}}]},'grunt','messages')).toMatchObject({content:[{input}]});
});
it('prefers first absolute Primary working directory and ignores relative hints',()=>{
  const request=(instructions:string)=>decode({input:'hi',instructions},'responses','/fallback').cwd;
  expect(request('Working directory: /other\nPrimary working directory: /first\nPrimary working directory: /last')).toBe('/first');
  expect(request('Working directory: relative')).toBe('/fallback');
  expect(request('Working directory: /first\nWorking directory: /last')).toBe('/first');
});
it('caps gateway completions when max tokens are omitted and preserves explicit limits',async()=>{
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({choices:[{message:{content:'ok'}}]}));
  const gateway=new Gateway('https://configured.invalid/v1','synthetic',fetcher);
  for(const maxTokens of [undefined,123]) {await gateway.complete({...decode({input:'hi'},'responses','/tmp'),maxTokens},new AbortController().signal);expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body)).max_tokens).toBe(maxTokens);}
});
it.each(['grunt-local', 'milo-local'])('starts the daemon through the compatible %s bin symlink',async bin=>{
  const {symlink}=await import('node:fs/promises');
  const {spawn}=await import('node:child_process');
  const {createServer}=await import('node:net');
  const reservation=createServer();
  await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
  const address=reservation.address();
  if(!address || typeof address==='string') throw new Error('No isolated daemon fixture port');
  const port=String(address.port);
  await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
  const dir=await mkdtemp(join(tmpdir(),'grunt-bin-'));
  await symlink(new URL('./main.ts',import.meta.url).pathname,join(dir,bin));
  const env = bin === 'grunt-local' ? { ...process.env, GRUNT_PORT:port,GRUNT_SOURCES:'dots',GRUNT_CONFIG_DIR:dir }
    : { ...process.env, GRUNT_PORT:undefined,GRUNT_SOURCES:undefined,GRUNT_CONFIG_DIR:undefined,MILO_PORT:port,MILO_SOURCES:'dots',MILO_CONFIG_DIR:dir };
  const child=spawn(process.execPath,['--import','tsx',join(dir,bin),'serve'],{env,stdio:['ignore','ignore','pipe']});
  try {await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('daemon did not listen')),3000);child.stderr.on('data',chunk=>{if(String(chunk).includes('grunt model API:')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`daemon exited ${code}`));});});expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(200);}finally{const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } await rm(dir,{recursive:true,force:true});}
});
it('starts setup from the usegrunt bin without arguments', async () => {
  const { symlink, writeFile } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'grunt-bin-'));
  try {
    const bin = join(directory, 'usegrunt');
    await symlink(new URL('./main.ts', import.meta.url).pathname, bin);
    await writeFile(join(directory, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const result = await new Promise<{ output: string; code: number | string | undefined }>(resolve => {
      execFile(process.execPath, ['--import', 'tsx', bin], { env: { ...process.env, PATH: directory, GRUNT_DAEMON: '' }, timeout: 5000 }, (error, stdout, stderr) => resolve({ output: stdout + stderr, code: error?.code }));
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('grunt — free AI inference, pooled on your machine');
    expect(result.output).toContain('Install tar using your system package manager.');
    expect(result.output).not.toContain('grunt model API:');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('translates Codex MCP namespaces through the completion and tool-result turns', async () => {
  const name = 'mcp__squire__operate_drive';
  const tool = { type: 'function', name: 'operate_drive', parameters: { type: 'object' } };
  const body = { input: 'Resume signup', tools: [{ type: 'namespace', name: 'mcp__squire', tools: [tool] }] };
  const source: Source = { ...fake(), complete: async request => {
    expect(request.tools).toEqual([{ type: 'function', function: { name, parameters: tool.parameters } }]);
    return { text: '', calls: [{ id: 'browser', type: 'function', function: { name, arguments: '{}' } }] };
  } };
  const response = await createLocalApp(new Sources([source])).request('http://localhost:8788/v1/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  expect(result.output).toMatchObject([{ type: 'function_call', namespace: 'mcp__squire', name: tool.name, call_id: 'browser' }]);
  expect(decode({ ...body, input: [...result.output, { type: 'function_call_output', call_id: 'browser', output: 'needs_value' }] }, 'responses').messages)
    .toMatchObject([{ tool_calls: [{ function: { name } }] }, { role: 'tool', tool_call_id: 'browser', content: 'needs_value' }]);
});
it('never reads, forwards, stores or logs Authorization or x-api-key on /v1/messages', async () => {
  // Claude Code sends an exported ANTHROPIC_API_KEY as x-api-key beside its Bearer token.
  const secrets = ['sk-ant-test-0000', 'Bearer sk-ant-test-1111'];
  const directory = await mkdtemp(join(tmpdir(), 'grunt-credential-headers-'));
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}));
  const seen: ModelRequest[] = [];
  const sources = new Sources([{ ...fake(), complete: async request => { seen.push(request); return { text: 'ok' }; } }]);
  const store = await DiagnosticsStore.open({ directory });
  sources.setDiagnostics(store);
  try {
    const app = createLocalApp(sources);
    for (const stream of [false, true]) {
      const response = await app.request('http://localhost:8788/v1/messages', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': secrets[0]!, Authorization: secrets[1]! },
        body: JSON.stringify({ model: 'grunt', stream, messages: [{ role: 'user', content: 'hello' }] }) });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect([...response.headers.values(), text].join('\n')).not.toMatch(/sk-ant-test/);
    }
    await store.flush();
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen)).not.toMatch(/sk-ant-test/);
    expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toMatch(/sk-ant-test/);
    const files = await readdir(directory, { recursive: true });
    for (const file of files) { const info = await stat(join(directory, file)); if (info.isFile()) expect(await readFile(join(directory, file), 'utf8')).not.toMatch(/sk-ant-test/); }
  } finally { spies.forEach(spy => spy.mockRestore()); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
