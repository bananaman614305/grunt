import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createLocalApp, decode, encode } from './api.js';
import { Freebuff, parseChat } from './freebuff.js';
import { Gateway, Sources, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { configure, HOST } from './main.js';
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const fake = (id = 'second-app'): Source => ({ id, available: async () => true, complete: async r => ({ text: r.messages.at(-1)!.content }) });
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
  expect((await (await app.request('http://localhost:8788/v1/models')).json()).data.map((m: { id: string }) => m.id)).toEqual(['milo', 'bad', 'second-app']);
  const body = JSON.stringify({ model: 'milo', messages: [{ role: 'user', content: 'hello' }] });
  expect((await (await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: {'Content-Type':'application/json'}, body })).json()).choices[0].message.content).toBe('hello');
  for (const path of paths) {
    const response = await createLocalApp(new Sources([bad])).request(`http://localhost:8788/v1/${path}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ input: 'hello', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(response.status).toBe(429); expect((await response.json()).error.code).toBe('quota');
  }
  const server = serve({ fetch: app.fetch, hostname: HOST, port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  expect(server.address()).toMatchObject({ address: '127.0.0.1' });
  await new Promise<void>(resolve => server.close(() => resolve()));
  expect(() => configure({ MILO_SOURCES: 'unknown' })).toThrow('Unknown');
});
it('gateway only calls configured origin, preserves tools, rejects redirects and fails over availability errors', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'gateway reply' } }] }));
  const gateway = new Gateway('https://configured.invalid/v1', 'synthetic', fetcher);
  const request = decode(await fixture('pi'), 'chat', '/tmp');
  expect(await gateway.complete(request, new AbortController().signal)).toMatchObject({ text: 'gateway reply' });
  expect(fetcher.mock.calls[0]![0]).toBe('https://configured.invalid/v1/chat/completions');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic' } });
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).tools).toEqual(request.tools);
  const bad = new Gateway('https://configured.invalid/v1', '', async () => { throw new Error('offline'); });
  expect(await new Sources([bad, fake()]).complete(request, new AbortController().signal)).toMatchObject({ text: request.messages.at(-1)!.content });
});
it('cwd inference and changed Freebuff format fail clearly', async () => {
  const sample = await fixture('freebuff');
  expect(parseChat(sample, sample[1].content)).toBe('bridge works 42');
  expect(() => parseChat({}, '')).toThrow('format changed');
  expect(decode(await fixture('claude'), 'messages', '/fallback').cwd).toBe('/tmp/milo-harness-cwd');
  expect(decode({ input: 'hi', instructions: '<cwd>/tmp/codex</cwd>' }, 'responses', '/fallback').cwd).toBe('/tmp/codex');
  expect(decode({ messages: [{ role: 'user', content: 'hi' }] }, 'chat', '/fallback').cwd).toBe('/fallback');
  expect(() => decode({ input: 'hi', cwd: 'relative' }, 'responses', '/fallback')).toThrow('absolute');
});
it('fake Freebuff on real tmux isolates concurrent identical requests, queues, cleans up, times out and makes no fetch calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'milo-app-'));
  const originalPath = process.env.PATH;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('local path must not fetch'));
  const driver = new Freebuff({ home: dir, pool: 2, timeout: 8000, startup: 200, poll: 20 });
  try {
    await copyFile(new URL('./fixtures/fake-freebuff.cjs', import.meta.url), join(dir, 'freebuff')); await chmod(join(dir, 'freebuff'), 0o755);
    vi.stubEnv('PATH', `${dir}:${originalPath}`); vi.stubEnv('MILO_TEST_HOME', dir);
    expect(await driver.available()).toBe(true);
    const request: ModelRequest = { model: 'freebuff', messages: [{ role: 'user', content: 'same prompt' }], tools: [], stream: false, cwd: dir };
    const app = createLocalApp(new Sources([driver]));
    vi.stubEnv('MILO_TEST_UNIQUE','1');
    for (let batch = 0; batch < 8; batch++) {
      const results = await Promise.all(Array.from({ length: 3 }, async () => {
        const response = await app.request('http://localhost:8788/v1/chat/completions', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ ...request, messages: [{role:'user',content:`same prompt ${batch}`}] }) });
        return {status:response.status,body:await response.json()};
      }));
      for (const result of results) expect(result).toMatchObject({status:200,body:{choices:[{message:{role:'assistant',content:expect.any(String)}}]}});
      expect(new Set(results.map(r => r.body.choices[0].message.content)).size).toBe(3);
    }
    vi.stubEnv('MILO_TEST_UNIQUE','');
    expect(fetcher).not.toHaveBeenCalled();
    const timeout = new Freebuff({ home: dir, timeout: 500, startup: 100, poll: 20 });
    await expect(timeout.complete({ ...request, messages: [{ role: 'user', content: 'NEVER_COMPLETE' }] }, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
    await timeout.close();
    vi.stubEnv('PATH', dir);
    await expect(driver.complete(request, new AbortController().signal)).rejects.toMatchObject({ code: 'not_installed' });
    vi.stubEnv('PATH', '/nonexistent');
    expect(await driver.available()).toBe(false);
  } finally { vi.stubEnv('PATH', originalPath ?? ''); await driver.close(); fetcher.mockRestore(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
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
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
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
it('answers through Freebuff when freebuff doctor takes longer than 5 seconds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'milo-slow-doctor-'));
  const driver = new Freebuff({home:dir, startup:200, poll:20, timeout:15000});
  try {
    await copyFile(new URL('./fixtures/fake-freebuff.cjs', import.meta.url), join(dir,'freebuff')); await chmod(join(dir,'freebuff'),0o755);
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`); vi.stubEnv('MILO_TEST_HOME',dir); vi.stubEnv('MILO_TEST_DOCTOR_DELAY','5500');
    const response = await createLocalApp(new Sources([driver])).request('http://localhost:8788/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'freebuff',cwd:dir,messages:[{role:'user',content:'slow doctor'}]})});
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Grunt-Source')).toBe('freebuff');
    expect((await response.json()).choices[0].message.content).toBe('slow doctor');
  } finally { vi.stubEnv('MILO_TEST_DOCTOR_DELAY',''); await driver.close(); await rm(dir,{recursive:true,force:true}); }
}, 30000);
it.each(['missing','unreadable'])('recovers a %s continuation, matches CR turns, resumes chats and stops on refusal', async state => {
  const dir = await mkdtemp(join(tmpdir(), 'milo-resume-'));
  const { readdir } = await import('node:fs/promises');
  const driver = new Freebuff({home:dir, startup:200, poll:20, timeout:5000});
  try {
    await copyFile(new URL('./fixtures/fake-freebuff.cjs', import.meta.url), join(dir,'freebuff')); await chmod(join(dir,'freebuff'),0o755);
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`); vi.stubEnv('MILO_TEST_HOME',dir);
    const req: ModelRequest = {model:'milo',messages:[{role:'user',content:'first\nline'}], tools:[], stream:false,cwd:dir};
    expect(await driver.complete(req,new AbortController().signal)).toEqual({text:'first\nline'});
    req.messages.push({role:'assistant',content:'first\nline'},{role:'user',content:'second'});
    expect(await driver.complete(req,new AbortController().signal)).toEqual({text:'second'});
    const chats = join(dir,'.config/manicode/projects',dir.split('/').at(-1)!,'chats');
    const files = await readdir(chats); expect(files).toHaveLength(1);
    const messages = JSON.parse(await readFile(join(chats,files[0]!,'chat-messages.json'),'utf8'));
    expect(messages.filter((m: {variant:string})=>m.variant==='user').map((m: {textAttachments:{content:string}[]})=>m.textAttachments[0]!.content)).toEqual(['first\nline','second']);
    const saved=join(chats,files[0]!,'chat-messages.json');
    await rm(saved);
    if(state==='unreadable') {const {mkdir}=await import('node:fs/promises');await mkdir(saved);}
    req.messages.push({role:'user',content:' recovered\rturn '});
    expect(await driver.complete(req,new AbortController().signal)).toEqual({text:' recovered\nturn '});
    for (const [name, api] of [['claude','messages'],['codex','responses'],['pi','chat'],['opencode','chat']]) {
      const harness = decode(await fixture(name!),api!,dir); harness.cwd=dir;
      const expected = name === 'opencode' ? '"Reply with exactly: bridge works 42. Do not use tools."' : 'Reply with exactly: bridge works 42. Do not use tools.';
      expect(await driver.complete(harness,new AbortController().signal)).toEqual({text:expected});
    }
    req.messages.push({role:'assistant',content:'second'},{role:'user',content:'REFUSE'});
    const start=Date.now();
    await expect(driver.complete(req,new AbortController().signal)).rejects.toMatchObject({code:'refused',message:expect.stringContaining('Freebuff is not a worker for other agents.')});
    expect(Date.now()-start).toBeLessThan(3000);
    for (const [prompt,code] of [['STARTUP_LOGIN','logged_out'],['STARTUP_QUOTA','quota']]) {
      const started = Date.now();
      await expect(driver.complete({...req,messages:[{role:'user',content:prompt!}]},new AbortController().signal)).rejects.toMatchObject({code});
      expect(Date.now()-started).toBeLessThan(3000);
    }
    const mux = {start:vi.fn(),send:vi.fn(),stop:vi.fn()};
    const diagnosed = new Freebuff({mux,home:dir});
    for (const [message,code] of [['Not signed in','logged_out'],['Free hours exhausted','quota']]) {
      vi.stubEnv('MILO_TEST_DOCTOR_ERROR',message!);
      await expect(diagnosed.complete(req,new AbortController().signal)).rejects.toMatchObject({code});
    }
    vi.stubEnv('MILO_TEST_DOCTOR_ERROR','');
    expect(mux.start).not.toHaveBeenCalled();
    expect(mux.send).not.toHaveBeenCalled();
    await diagnosed.close();
    const refused: Source = {...fake('refused'),complete:async()=>{throw new SourceError('refused','policy');}};
    expect(await new Sources([refused,fake()]).complete(req,new AbortController().signal)).toEqual({text:'REFUSE'});
  } finally {await driver.close(); await rm(dir,{recursive:true,force:true});}
},10000);

it.each([false, true])('attributes shared-basename chats and follow-ups to their originating process (quota=%s)', async quota => {
  const { mkdir } = await import('node:fs/promises');
  const { OwnershipMux } = await import('./fixtures/ownership-mux.js');
  const home = await mkdtemp(join(tmpdir(),'milo-owner-'));
  const a = join(home,'A','project'), b = join(home,'B','project');
  await mkdir(a,{recursive:true}); await mkdir(b,{recursive:true});
  await copyFile(new URL('./fixtures/fake-freebuff.cjs',import.meta.url),join(home,'freebuff')); await chmod(join(home,'freebuff'),0o755);
  vi.stubEnv('PATH',`${home}:${process.env.PATH}`);
  const driver = new Freebuff({home,mux:new OwnershipMux(home),startup:1,poll:5,timeout:3000});
  const app=createLocalApp(new Sources([driver]));
  const send=async(cwd:string,messages:{role:string;content:string}[])=>{
    const response=await app.request('http://localhost:8788/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'freebuff',cwd,messages})});
    return {status:response.status,body:await response.json()};
  };
  try {
    const first=quota ? 'quota please' : 'same user text';
    const [ra,rb]=await Promise.all([send(a,[{role:'user',content:first}]),send(b,[{role:'user',content:quota ? 'different user text' : first}])]);
    if(quota) expect(ra).toMatchObject({status:429,body:{error:{code:'quota'}}});
    else expect(JSON.parse(ra.body.choices[0].message.content)).toEqual({cwd:a,chat:'A-chat'});
    expect(rb.status).toBe(200);
    expect(JSON.parse(rb.body.choices[0].message.content)).toEqual({cwd:b,chat:'B-chat'});
    for(const cwd of quota ? [b] : [a,b]) {
      const follow=await send(cwd,[{role:'user',content:quota ? 'different user text' : first},{role:'assistant',content:'previous reply'},{role:'user',content:'follow up'}]);
      expect(follow.status).toBe(200);
      expect(JSON.parse(follow.body.choices[0].message.content)).toEqual({cwd,chat:cwd===a ? 'A-chat' : 'B-chat'});
    }
  } finally {await driver.close();await rm(home,{recursive:true,force:true});}
},10000);

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
  try {expect(await new Sources([fake()]).complete(decode({input:'hi',model:'claude-haiku-new'},'responses','/tmp'),new AbortController().signal)).toEqual({text:'hi'});expect(log).toHaveBeenCalledWith(expect.stringContaining('claude-haiku-new'));}finally{log.mockRestore();}
});
it('logs which source answered each request and which ones failed before it',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  const down:Source={...fake('first-app'),complete:async()=>{throw new SourceError('quota','out');}};
  try {expect(await new Sources([down,fake()]).complete(decode({input:'hi',model:'milo'},'responses','/tmp'),new AbortController().signal)).toEqual({text:'hi'});
    expect(log.mock.calls.map(c=>c[0])).toEqual(['grunt source: first-app failed (quota) for model milo','grunt source: second-app answered model milo']);}finally{log.mockRestore();}
});
it.each([['',{}],['broken','broken']])('encodes tool arguments safely: %s',(arguments_,input)=>{
  expect(encode({text:'',calls:[{id:'c',type:'function',function:{name:'read',arguments:arguments_ as string}}]},'milo','messages')).toMatchObject({content:[{input}]});
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
  for(const maxTokens of [undefined,123]) {await gateway.complete({...decode({input:'hi'},'responses','/tmp'),maxTokens},new AbortController().signal);expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body)).max_tokens).toBe(maxTokens ?? 4096);}
});
it('matches saved user turns with normalized newlines and surrounding whitespace',()=>{
  expect(parseChat([{variant:'user',textAttachments:[{content:'  first\nsecond\nthird  '}]},{variant:'ai',isComplete:true,blocks:[{type:'text',content:'ok'}]}],'first\r\nsecond\rthird')).toBe('ok');
});
it('starts the daemon through the milo-local bin symlink',async()=>{
  const {symlink}=await import('node:fs/promises');
  const {spawn}=await import('node:child_process');
  const dir=await mkdtemp(join(tmpdir(),'milo-bin-'));
  await symlink(new URL('./main.ts',import.meta.url).pathname,join(dir,'milo-local'));
  const child=spawn(process.execPath,['--import','tsx',join(dir,'milo-local'),'serve'],{env:{...process.env,MILO_PORT:'18789',MILO_SOURCES:'dots',MILO_CONFIG_DIR:dir},stdio:['ignore','ignore','pipe']});
  try {await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('daemon did not listen')),3000);child.stderr.on('data',chunk=>{if(String(chunk).includes('grunt model API:')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error(`daemon exited ${code}`));});});expect((await fetch('http://127.0.0.1:18789/v1/models')).status).toBe(200);}finally{child.kill();await rm(dir,{recursive:true,force:true});}
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
    expect(result.output).toContain('Sign in to Google once');
    expect(result.output).toContain('npm install --global @mariozechner/pi-coding-agent');
    expect(result.output).not.toContain('grunt model API:');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
