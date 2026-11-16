#!/usr/bin/env node
// Trusted supervisor probe. Candidate code is loaded only after an independent
// code/free-access review; response labels alone do not attest model or pricing.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,realpath,readFile,writeFile,mkdtemp,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const execute=promisify(execFile);
const SHA=/^[a-f0-9]{40}$/;
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/+ -]{0,159}$/;
const CODES=new Set(['quota','not_installed','logged_out','timeout','upstream','refused','cancelled']);
const MAX_TOKENS=1024;
const STATUS_URL='http://127.0.0.1:8792/v1/status';
export class ProbeError extends Error {
  constructor(code,outcome='failed'){super(code);this.code=code;this.outcome=outcome;}
}
const fail=(code,outcome)=>{throw new ProbeError(code,outcome);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function git(checkout,args){
  try{return(await execute('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',checkout,...args],{timeout:10000,maxBuffer:1024*1024,env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1'}})).stdout.trim();}
  catch{fail('scope_changed');}
}
async function canonicalDirectory(path,privateMode=false){
  const selected=resolve(path),info=await lstat(selected);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||privateMode&&(info.mode&0o777)!==0o700||await realpath(selected)!==selected)fail('invalid_directory');
  return selected;
}
async function privateFile(path){
  const selected=resolve(path),info=await lstat(selected);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>131072||await realpath(selected)!==selected)fail('invalid_review');
  return JSON.parse(await readFile(selected,'utf8'));
}
export function verifyReview(review,head){
  if(!review||review.verdict!=='approve'||review.independent!==true||review.head_sha!==head||!SHA.test(review.base_sha??'')||review.base_sha===head
    ||!['model','free_access','code_scope','context','terms','signup','consent'].every(key=>review.checks?.[key]===true))fail('review_required');
  return review;
}
export function verifyRegistry(registry,known,disabled,sourceId,model){
  const matching=registry?.adapters?.filter(adapter=>adapter.id===sourceId);
  if(!known?.has(sourceId)||disabled?.has(sourceId)||matching?.length!==1)fail('source_unlisted');
  const adapter=matching[0];
  const models=adapter.models??(typeof adapter.model==='string'?[adapter.model]:[]);
  if(models.length!==1||models[0]!==model||!adapter.modalities?.includes('text'))fail('model_mismatch');
  return adapter;
}
async function inspect(options){
  if(!SHA.test(options.head??'')||!HASH.test(options.registrySha??'')||!ID.test(options.sourceId??'')||!MODEL.test(options.model??''))fail('invalid_candidate');
  const workspace=await canonicalDirectory(options.workspace,true),checkout=await canonicalDirectory(options.checkout),configDir=await canonicalDirectory(options.configDir,true);
  if(!checkout.startsWith(join(workspace,'candidates')+'/')||!configDir.startsWith(workspace+'/'))fail('workspace_scope');
  // Legacy directory is an explicit compatibility exclusion, never probe state.
  const productionConfigs=['.config/grunt','.config/milo'].map(path=>resolve(homedir(),path));
  if(productionConfigs.some(production=>configDir===production||configDir.startsWith(production+'/')))fail('production_config_forbidden');
  const output=resolve(options.output),outputParent=await canonicalDirectory(dirname(output),true);
  if(output===workspace||output.startsWith(workspace+'/'))fail('protected_output_required');
  const reviewPath=resolve(options.reviewReceipt);
  if(reviewPath===workspace||reviewPath.startsWith(workspace+'/'))fail('protected_review_required');
  await canonicalDirectory(dirname(reviewPath),true);
  const review=verifyReview(await privateFile(reviewPath),options.head);
  if(await git(checkout,['rev-parse','HEAD'])!==options.head||await git(checkout,['status','--porcelain','--untracked-files=no']))fail('scope_changed');
  await git(checkout,['merge-base','--is-ancestor',review.base_sha,options.head]);
  const registryBytes=await readFile(join(checkout,'registry/adapters.json'));
  if(hash(registryBytes)!==options.registrySha)fail('registry_changed');
  if(!registryBytes.equals(await readFile(join(checkout,'dist/registry/adapters.json'))))fail('build_registry_mismatch');
  return{workspace,checkout,configDir,output,outputParent,review,registry:JSON.parse(registryBytes.toString())};
}
/** Build argv using trusted Python code; never execute candidate code in this process. */
export async function sandboxCommand(scope,options){
  if(typeof options.sandboxState!=='string')fail('sandbox_unavailable');
  const state=await canonicalDirectory(options.sandboxState,true);
  if(state===scope.workspace||state.startsWith(scope.workspace+'/'))fail('protected_state_required');
  try{
    const args=['--checkout',scope.checkout,'--source-id',options.sourceId,'--model',options.model,'--config-dir',scope.configDir];
    const result=await execute('/usr/bin/python3',[join(import.meta.dirname,'sandbox.py'),'probe-command','--state-dir',state,'--workspace',scope.workspace,'--checkout',scope.checkout,'--config-dir',scope.configDir,'--child-script',join(import.meta.dirname,'probe-child.mjs'),'--',...args],{timeout:15000,maxBuffer:131072,env:{PATH:'/usr/bin:/bin'},cwd:'/'});
    const command=JSON.parse(result.stdout);
    if(!Array.isArray(command)||!command.length||command.some(item=>typeof item!=='string'||item.length>32768))fail('sandbox_unavailable');
    return command;
  }catch{fail('sandbox_unavailable');}
}

/** A bounded protocol channel, separate from discarded candidate stdout/stderr. */
export async function sandboxCandidate(scope,options,signal,dependencies={}){
  const command=await(dependencies.sandboxCommand??sandboxCommand)(scope,options);
  const child=(dependencies.spawn??spawn)(command[0],command.slice(1),{cwd:'/',env:{PATH:'/usr/bin:/bin'},detached:true,stdio:['pipe','ignore','ignore','pipe']});
  const pending=new Map();let buffer=Buffer.alloc(0),failure,closed=false,readyResolve,readyReject,exitResolve;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const exited=new Promise(resolve=>{exitResolve=resolve;});
  const rejectAll=code=>{failure??=new ProbeError(code);readyReject(failure);for(const waiter of pending.values())waiter.reject(failure);pending.clear();};
  const kill=()=>{if(!child.pid)return;try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw new ProbeError('cleanup_failed');}};
  child.once('error',()=>{rejectAll('sandbox_unavailable');exitResolve();});
  child.once('exit',()=>{closed=true;rejectAll('candidate_closed');exitResolve();});
  child.stdin.on('error',()=>rejectAll('candidate_closed'));
  child.stdio[3].on('error',()=>rejectAll('candidate_protocol'));
  child.stdio[3].on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>4*1024*1024){rejectAll('candidate_protocol');kill();return;}
    for(let end;(end=buffer.indexOf(10))!==-1;){
      const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);let message;
      try{message=JSON.parse(line.toString());}catch{rejectAll('candidate_protocol');kill();return;}
      if(message?.kind==='ready'&&message.source_id===options.sourceId&&message.model===options.model&&message.supports_function_tools===true){readyResolve();continue;}
      const waiter=pending.get(message?.id);
      if(!waiter){rejectAll('candidate_protocol');kill();return;}
      pending.delete(message.id);
      if(message.kind==='error')waiter.reject(new ProbeError(CODES.has(message.code)?message.code:'candidate_protocol'));
      else if(message.kind==='closed'||message.kind==='response')waiter.resolve(message);
      else{waiter.reject(new ProbeError('candidate_protocol'));rejectAll('candidate_protocol');kill();return;}
    }
  });
  const cancellation=()=>{rejectAll('cancelled');kill();};signal.addEventListener('abort',cancellation,{once:true});
  const send=(kind,body)=>{
    if(failure)throw failure;
    const id=randomUUID();return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({kind,id,...(body?{body}:{})})+'\n',error=>{if(error){pending.delete(id);reject(new ProbeError('candidate_closed'));}});
    });
  };
  const close=async()=>{
    signal.removeEventListener('abort',cancellation);
    try{if(!closed&&!failure)await abortable(send('close'),AbortSignal.timeout(5000));}
    catch{/* Killing this owned sandbox also closes all contained adapter processes. */}
    finally{kill();child.stdin.destroy();child.stdio[3].destroy();await abortable(exited,AbortSignal.timeout(5000));}
  };
  try{await abortable(ready,AbortSignal.any([signal,AbortSignal.timeout(15000)]));}
  catch(error){await close();throw error;}
  const sources={sources:[{id:options.sourceId,supportsFunctionTools:true}],close};
  return{registry:scope.registry,known:new Set([options.sourceId]),disabled:new Set(),configure:()=>sources,createLocalApp:()=>({fetch:async request=>{
    const message=await send('request',await request.json());
    if(message.kind!=='response'||!Number.isInteger(message.status)||message.status<200||message.status>599||!(message.source_id===null||typeof message.source_id==='string'))fail('candidate_protocol');
    return new Response(JSON.stringify(message.body),{status:message.status,headers:typeof message.source_id==='string'?{'X-Grunt-Source':message.source_id}:{}});
  }})};
}
async function productionIdle(fetcher,signal){
  const statusSignal=AbortSignal.any([signal,AbortSignal.timeout(3000)]);
  try{
    const response=await abortable(fetcher(STATUS_URL,{redirect:'error',signal:statusSignal}),statusSignal);
    if(!response.ok)fail('production_status_unavailable','deferred');
    const bytes=await boundedBody(response,131072,statusSignal),body=JSON.parse(bytes.toString());
    if(body.version!==1||!Number.isSafeInteger(body.activeRequests)||body.activeRequests<0)fail('production_status_unavailable','deferred');
    if(body.activeRequests!==0)fail('busy','deferred');
  }catch(error){if(error instanceof ProbeError&&error.outcome==='deferred')throw error;signal.throwIfAborted();fail('production_status_unavailable','deferred');}
}
async function boundedBody(response,max,signal){
  if(!response.body||Number(response.headers.get('content-length'))>max)fail('invalid_response');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){signal.throwIfAborted();const part=await abortable(reader.read(),signal);if(part.done)break;size+=part.value.length;if(size>max)fail('invalid_response');chunks.push(part.value);}return Buffer.concat(chunks);}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function abortable(promise,signal){
  signal.throwIfAborted();let abort;
  try{return await Promise.race([promise,new Promise((_resolve,reject)=>{abort=()=>reject(new ProbeError(signal.reason?.name==='TimeoutError'?'timeout':'cancelled'));signal.addEventListener('abort',abort,{once:true});})]);}
  finally{if(abort)signal.removeEventListener('abort',abort);}
}
export function verifyReply(response,body,sourceId){
  if(response.status!==200){const code=body?.error?.code;fail(CODES.has(code)?code:'upstream');}
  if(response.headers.get('X-Grunt-Source')!==sourceId)fail('wrong_source');
  if(!Array.isArray(body.choices)||body.choices.length!==1||!body.choices[0]?.message)fail('invalid_response');
  return body.choices[0].message;
}
export function verifyHello(message){
  if(typeof message.content!=='string'||!message.content.trim()||message.tool_calls?.length)fail('empty_reply');
  return hash(message.content);
}
export function verifyTool(message,nonce){
  if(!Array.isArray(message.tool_calls)||message.tool_calls.length!==1)fail('tool_protocol');
  const call=message.tool_calls[0];let args;
  try{args=JSON.parse(call.function?.arguments);}catch{fail('tool_protocol');}
  if(call.type!=='function'||typeof call.id!=='string'||!call.id||call.id.length>256||call.function?.name!=='scout_probe'
    ||!args||Array.isArray(args)||Object.keys(args).length!==1||args.nonce!==nonce)fail('tool_protocol');
  return true;
}
function safeEnv(directory,sourceId,base=process.env){
  const keep=['HOME','PATH','USER','LOGNAME','SHELL','LANG','LC_ALL','TERM','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'];
  return{...Object.fromEntries(keep.filter(key=>typeof base[key]==='string').map(key=>[key,base[key]])),GRUNT_CONFIG_DIR:directory,GRUNT_SOURCES:sourceId,GRUNT_DAEMON:'1'};
}
async function writeProof(output,proof){
  const temporary=output+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,output);}
  finally{await rm(temporary,{force:true});}
}

/** Exactly two bounded inference calls, one source, no account provisioning. */
export async function runProbe(options,dependencies={}){
  const signal=options.signal??new AbortController().signal,now=dependencies.now??Date.now;
  const fetcher=dependencies.fetcher??fetch,wait=dependencies.wait??((ms,signal)=>delay(ms,undefined,{signal}));
  const proof={version:1,head_sha:options.head,registry_sha256:options.registrySha,model:options.model,source_id:options.sourceId,
    http_status:0,reply_received:false,attribution_verified:false,tool_call_verified:false,free_guard_verified:false,
    outcome:'failed',observed_at:new Date(now()).toISOString(),observations:[],model_verification:'adapter_guard_reviewed'};
  let scope,sources,cwd;
  try{
    signal.throwIfAborted();scope=await inspect(options);
    const candidate=dependencies.loadCandidate?await dependencies.loadCandidate(scope.checkout):await sandboxCandidate(scope,options,signal,dependencies);
    verifyRegistry(scope.registry,candidate.known,candidate.disabled,options.sourceId,options.model);
    verifyRegistry(candidate.registry,candidate.known,candidate.disabled,options.sourceId,options.model);
    sources=candidate.configure(safeEnv(scope.configDir,options.sourceId,dependencies.env));
    if(sources.sources?.length!==1||sources.sources[0].id!==options.sourceId||sources.sources[0].supportsFunctionTools!==true)fail('exact_tool_source_required');
    cwd=await mkdtemp(join(scope.configDir,'.scout-probe-'));
    const app=candidate.createLocalApp(sources,{port:0,cwd});
    const request=async body=>{
      await productionIdle(fetcher,signal);signal.throwIfAborted();
      const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.min(180000,dependencies.requestTimeoutMs??180000))]);
      const response=await abortable(app.fetch(new Request('http://127.0.0.1:0/v1/chat/completions',{method:'POST',signal:requestSignal,headers:{'Content-Type':'application/json'},body:JSON.stringify({model:options.sourceId,cwd,stream:false,max_tokens:MAX_TOKENS,...body})})),requestSignal);
      let result;
      try{result=JSON.parse((await boundedBody(response,2*1024*1024,requestSignal)).toString());}
      catch(error){if(error instanceof ProbeError)throw error;fail(requestSignal.aborted?'timeout':'invalid_response');}
      return verifyReply(response,result,options.sourceId);
    };
    const hello=await request({messages:[{role:'user',content:'Say hello in one short sentence. Do not use tools or edit files.'}],tools:[]});
    const replyHash=verifyHello(hello);
    proof.observations.push({kind:'hello',source_id:options.sourceId,model:options.model,http_status:200,reply_received:true,reply_sha256:replyHash,max_tokens:MAX_TOKENS});
    proof.reply_received=true;
    const random=(dependencies.random??Math.random)(),gap=60000+Math.floor(Math.max(0,Math.min(1,Number.isFinite(random)?random:0))*30000);
    await wait(gap,signal);signal.throwIfAborted();
    const nonce=randomUUID();
    const tool=await request({messages:[{role:'user',content:`Call scout_probe exactly once with nonce ${nonce}. Do not execute code, use another tool, or edit files.`}],tools:[{type:'function',function:{name:'scout_probe',description:'Return the supplied test nonce; this inert probe is never executed.',parameters:{type:'object',properties:{nonce:{type:'string',const:nonce}},required:['nonce'],additionalProperties:false}}}]});
    verifyTool(tool,nonce);
    proof.observations.push({kind:'tool',source_id:options.sourceId,model:options.model,http_status:200,tool_name:'scout_probe',arguments_verified:true,max_tokens:MAX_TOKENS});
    if(await git(scope.checkout,['rev-parse','HEAD'])!==options.head||await git(scope.checkout,['status','--porcelain','--untracked-files=no'])||hash(await readFile(join(scope.checkout,'registry/adapters.json')))!==options.registrySha)fail('scope_changed');
    Object.assign(proof,{http_status:200,attribution_verified:true,tool_call_verified:true,free_guard_verified:true,outcome:'passed',observed_at:new Date(now()).toISOString()});
  }catch(error){
    const failure=error instanceof ProbeError?error:new ProbeError(signal.aborted?'cancelled':'probe_failed');
    proof.outcome=failure.outcome;proof.code=failure.code;proof.observed_at=new Date(now()).toISOString();
  }finally{
    if(sources)try{await sources.close();}catch{proof.outcome='failed';proof.code='cleanup_failed';proof.free_guard_verified=false;}
    if(cwd)await rm(cwd,{recursive:true,force:true});
  }
  // Invalid paths never become permission to write an arbitrary output file.
  if(scope)await writeProof(scope.output,proof);
  return proof;
}

export function parseArguments(args){
  const map={'--workspace':'workspace','--sandbox-state':'sandboxState','--checkout':'checkout','--source-id':'sourceId','--model':'model','--config-dir':'configDir','--head':'head','--registry-sha':'registrySha','--review-receipt':'reviewReceipt','--output':'output'};
  const result={};for(let index=0;index<args.length;index+=2){const key=map[args[index]];if(!key||!args[index+1]||result[key]!==undefined)fail('invalid_arguments');result[key]=args[index+1];}
  if(Object.values(map).some(key=>typeof result[key]!=='string'))fail('invalid_arguments');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const cancellation=new AbortController(),cancel=()=>cancellation.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{const proof=await runProbe({...parseArguments(process.argv.slice(2)),signal:cancellation.signal});console.log(JSON.stringify({outcome:proof.outcome,code:proof.code??null,source_id:proof.source_id,observations:proof.observations.length}));process.exitCode=proof.outcome==='passed'?0:proof.outcome==='deferred'?2:1;}
  catch{console.log(JSON.stringify({outcome:'failed',code:'invalid_arguments_or_output'}));process.exitCode=1;}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
