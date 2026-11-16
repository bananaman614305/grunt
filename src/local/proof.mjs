import { mkdtemp, copyFile, chmod, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomInt } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.cwd();
const port = randomInt(20000, 50000);
const dir = await mkdtemp(join(tmpdir(), 'grunt-built-proof-'));
const project = join(dir, basename(dir));
await mkdir(project);
await copyFile('src/local/fixtures/fake-freebuff.cjs', join(dir, 'freebuff'));
await chmod(join(dir, 'freebuff'), 0o755);
const child = spawn(process.execPath, [join(root, 'dist/local/main.js')], {cwd:project,env:{...process.env,PATH:`${dir}:${process.env.PATH}`,GRUNT_PORT:String(port),GRUNT_SOURCES:'freebuff',GRUNT_TEST_HOME:homedir(),GRUNT_APP_TIMEOUT_MS:'20000'},stdio:['ignore','pipe','pipe']});
let logs=''; child.stderr.on('data', b=>{logs+=b;});
try {
 for(let i=0;i<50;i++){try{const r=await fetch(`http://127.0.0.1:${port}/v1/models`);if(r.ok)break;}catch{}await delay(100);}
 for(const [path,body] of [['chat/completions',{messages:[{role:'user',content:'bridge works 42'}]}],['messages',{messages:[{role:'user',content:'bridge works 42'}],max_tokens:128}],['responses',{input:'bridge works 42'}]]) {
  for(const stream of [false,true]) {
   const started=Date.now();
   const response=await fetch(`http://127.0.0.1:${port}/v1/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,model:'grunt',stream})});
   const text=await response.text();
   if(!response.ok || !text.includes('bridge works 42'))throw new Error(text);
   console.log(`${path} stream=${stream}: bridge works 42 (${Date.now()-started}ms)`);
  }
 }
 const send = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,model:'grunt',stream:false})});
  return {status:response.status, body:await response.json()};
 };
 const chats = join(homedir(),'.config/manicode/projects',basename(project),'chats');
 const before = (await readdir(chats)).length;
 const title = await send('messages', JSON.parse(await readFile('src/local/fixtures/claude-title.json','utf8')));
 if (title.status !== 200 || JSON.parse(title.body.content[0].text).title !== 'What is 2 + 2?' || (await readdir(chats)).length !== before) throw new Error('Recorded title reached Freebuff or returned an invalid title');
 console.log('Recorded Claude Code title: local JSON title, zero new Freebuff chats');
 const summary = await send('messages',{messages:[{role:'user',content:'Write a summary of my notes.'}]});
 if (summary.body.content?.[0]?.text !== 'Write a summary of my notes.' || (await readdir(chats)).length !== before+1) throw new Error('Ordinary summary request did not reach Freebuff');
 console.log('Ordinary summary request: forwarded to Freebuff');
 const concurrent = await Promise.all([0,1].map(()=>send('messages',{messages:[{role:'user',content:'UNIQUE_REPLY'}]})));
 if (new Set(concurrent.map(r=>r.body.content?.[0]?.text)).size !== 2 || concurrent.some(r=>r.status!==200)) throw new Error('Concurrent replies shared a chat');
 console.log('Concurrent identical prompts: distinct persisted chat replies');
 for (const [prompt,code] of [['STARTUP_LOGIN','logged_out'],['STARTUP_QUOTA','quota']]) {
  const started=Date.now();
  const result=await send('messages',{messages:[{role:'user',content:prompt}]});
  if (result.status!==503 || result.body.error.code!==code || Date.now()-started>5000) throw new Error('Startup error was not surfaced promptly');
  console.log(`${code}: typed model error before any saved user turn (${Date.now()-started}ms)`);
 }
 console.log('Built daemon -> real tmux -> offline Freebuff TUI -> persisted chat -> model API: PASS');
 console.log(logs);
} finally {
 if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve)); }
 await rm(join(homedir(),'.config/manicode/projects',basename(project)),{recursive:true,force:true});
 await rm(dir,{recursive:true,force:true});
}
