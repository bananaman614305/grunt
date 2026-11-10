// Run after pnpm build. Both callers use different folders named "project".
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,chmod,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve} from '@hono/node-server';
import {createLocalApp} from '../../dist/local/api.js';
import {Freebuff} from '../../dist/local/freebuff.js';
import {Sources} from '../../dist/local/source.js';
import {OwnershipMux} from '../../dist/local/fixtures/ownership-mux.js';
const dir=await mkdtemp(join(tmpdir(),'milo-ownership-proof-'));
const oldPath=process.env.PATH;
await copyFile(new URL('./fixtures/fake-freebuff.cjs',import.meta.url),join(dir,'freebuff'));await chmod(join(dir,'freebuff'),0o755);
process.env.PATH=`${dir}:${oldPath}`;
try {
 for(const quota of (process.argv.includes('--mixed-only') ? [true] : [false,true])) {
  const home=join(dir,quota?'mixed':'identical');
  const a=join(home,'A','project'),b=join(home,'B','project');
  await mkdir(a,{recursive:true});await mkdir(b,{recursive:true});
  const source=new Freebuff({home,mux:new OwnershipMux(home),startup:1,poll:5,timeout:3000});
  const app=createLocalApp(new Sources([source]));
  const server=serve({hostname:'127.0.0.1',port:0,fetch:app.fetch});
  await new Promise(resolve=>server.once('listening',resolve));
  const send=async(cwd,messages)=>{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'freebuff',cwd,messages})});
   return {status:response.status,body:await response.json()};
  };
  try {
   const promptA=quota?'quota please':'same user text',promptB=quota?'different user text':promptA;
   const [ra,rb]=await Promise.all([send(a,[{role:'user',content:promptA}]),send(b,[{role:'user',content:promptB}])]);
   if(quota){assert.equal(ra.status,503);assert.equal(ra.body.error.code,'quota');}
   else {assert.equal(ra.status,200);assert.deepEqual(JSON.parse(ra.body.choices[0].message.content),{cwd:a,chat:'A-chat'});}
   assert.equal(rb.status,200);assert.deepEqual(JSON.parse(rb.body.choices[0].message.content),{cwd:b,chat:'B-chat'});
   for(const cwd of quota?[b]:[a,b]) {
    const first=cwd===a?promptA:promptB;
    const follow=await send(cwd,[{role:'user',content:first},{role:'assistant',content:'previous reply'},{role:'user',content:'follow up'}]);
    const chat=cwd===a?'A-chat':'B-chat';
    assert.equal(follow.status,200);assert.deepEqual(JSON.parse(follow.body.choices[0].message.content),{cwd,chat});
    const saved=JSON.parse(await readFile(join(home,'.config/manicode/projects/project/chats',chat,'chat-messages.json'),'utf8'));
    assert.deepEqual(saved.filter(m=>m.variant==='user').map(m=>m.content),[first,'follow up']);
   }
   console.log(quota?'PASS: A gets its quota error, B gets its own reply and resumes B-chat':'PASS: identical prompts in A/project and B/project get their own labeled replies and resume their own chats');
  } finally {await source.close();await new Promise(resolve=>server.close(resolve));}
 }
} finally {process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});}
