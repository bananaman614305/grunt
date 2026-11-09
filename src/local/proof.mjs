import { mkdtemp, copyFile, chmod, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomInt } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.cwd();
const port = randomInt(20000, 50000);
const dir = await mkdtemp(join(tmpdir(), 'milo-built-proof-'));
const project = join(dir, basename(dir));
await mkdir(project);
await copyFile('src/local/fixtures/fake-freebuff.cjs', join(dir, 'freebuff'));
await chmod(join(dir, 'freebuff'), 0o755);
const child = spawn(process.execPath, [join(root, 'dist/local/main.js')], {cwd:project,env:{...process.env,PATH:`${dir}:${process.env.PATH}`,MILO_PORT:String(port),MILO_SOURCES:'freebuff',MILO_TEST_HOME:homedir(),MILO_APP_TIMEOUT_MS:'20000'},stdio:['ignore','pipe','pipe']});
let logs=''; child.stderr.on('data', b=>{logs+=b;});
try {
 for(let i=0;i<50;i++){try{const r=await fetch(`http://127.0.0.1:${port}/v1/models`);if(r.ok)break;}catch{}await delay(100);}
 for(const [path,body] of [['chat/completions',{messages:[{role:'user',content:'bridge works 42'}]}],['messages',{messages:[{role:'user',content:'bridge works 42'}],max_tokens:128}],['responses',{input:'bridge works 42'}]]) {
  for(const stream of [false,true]) {
   const started=Date.now();
   const response=await fetch(`http://127.0.0.1:${port}/v1/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,model:'milo',stream})});
   const text=await response.text();
   if(!response.ok || !text.includes('bridge works 42'))throw new Error(text);
   console.log(`${path} stream=${stream}: bridge works 42 (${Date.now()-started}ms)`);
  }
 }
 console.log('Built daemon -> real tmux -> offline Freebuff TUI -> persisted chat -> model API: PASS');
 console.log(logs);
} finally {
 if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve=>child.once('exit',resolve)); }
 await rm(join(homedir(),'.config/manicode/projects',basename(project)),{recursive:true,force:true});
 await rm(dir,{recursive:true,force:true});
}
