#!/usr/bin/env node
// Candidate-only runtime. This file is mounted into a minimal filesystem by the
// supervisor; host reviews, release authority, home and proofs are not mounted.
import {writeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const send=value=>writeSync(3,JSON.stringify(value)+'\n');
const rejected=()=>{throw new Error('candidate_rejected');};
function argumentsFrom(args){
  const names={'--checkout':'checkout','--source-id':'sourceId','--model':'model','--config-dir':'configDir'},result={};
  for(let index=0;index<args.length;index+=2){const name=names[args[index]];if(!name||!args[index+1]||result[name])rejected();result[name]=args[index+1];}
  if(Object.values(names).some(name=>!result[name]))rejected();return result;
}
async function boundedBody(response,signal){
  if(!response.body||Number(response.headers.get('content-length'))>2*1024*1024)rejected();
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2*1024*1024)rejected();chunks.push(part.value);}return JSON.parse(Buffer.concat(chunks).toString());}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
let sources;
try{
  const options=argumentsFrom(process.argv.slice(2));
  process.env.GRUNT_CONFIG_DIR=options.configDir;process.env.GRUNT_SOURCES=options.sourceId;process.env.GRUNT_DAEMON='1';
  const [main,api,registry]=await Promise.all(['local/main.js','local/api.js','registry.js'].map(file=>import(pathToFileURL(join(options.checkout,'dist',file)).href)));
  const entries=registry.bundledRegistry?.adapters?.filter(item=>item.id===options.sourceId);
  const entry=entries?.[0],models=entry?.models??(typeof entry?.model==='string'?[entry.model]:[]);
  if(!registry.knownAdapters?.has(options.sourceId)||registry.disabledAdapters?.has(options.sourceId)||entries?.length!==1||models.length!==1||models[0]!==options.model||!entry.modalities?.includes('text'))rejected();
  sources=main.configure(process.env);
  if(sources.sources?.length!==1||sources.sources[0].id!==options.sourceId||sources.sources[0].supportsFunctionTools!==true)rejected();
  const app=api.createLocalApp(sources,{port:0});
  send({kind:'ready',source_id:options.sourceId,model:options.model,supports_function_tools:true});
  let count=0;
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){
    if(Buffer.byteLength(line)>65536)rejected();
    const command=JSON.parse(line);
    if(typeof command.id!=='string'||command.id.length>64)rejected();
    if(command.kind==='close'){
      await sources.close();sources=undefined;send({kind:'closed',id:command.id});lines.close();process.stdin.destroy();break;
    }
    if(command.kind!=='request'||++count>2)rejected();
    const body=command.body;
    if(body?.model!==options.sourceId||body.max_tokens!==1024||body.stream!==false||typeof body.cwd!=='string'||!resolve(body.cwd).startsWith(resolve(options.configDir)+'/.scout-probe-'))rejected();
    const signal=AbortSignal.timeout(180000);
    try{
      const response=await app.fetch(new Request('http://127.0.0.1:0/v1/chat/completions',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
      send({kind:'response',id:command.id,status:response.status,source_id:response.headers.get('X-Grunt-Source'),body:await boundedBody(response,signal)});
    }catch{send({kind:'error',id:command.id,code:signal.aborted?'timeout':'upstream'});}
  }
}catch{try{send({kind:'error',code:'candidate_rejected'});}catch{}process.exitCode=1;}
finally{if(sources)try{await sources.close();}catch{} }
