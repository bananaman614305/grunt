import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm,readdir,cp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runProbe,parseArguments,verifyReview,verifyRegistry,verifyTool} from './probe.mjs';

const execute=promisify(execFile),sourceId='synthetic',model='synthetic-flash';
const json=value=>JSON.stringify(value,null,2)+'\n';
const checks=Object.fromEntries(['model','free_access','code_scope','context','terms','signup','consent'].map(key=>[key,true]));
async function fixture(t,{realApi=false}={}){
  const root=await mkdtemp(join(tmpdir(),'grunt-scout-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace'),checkout=join(workspace,'candidates','synthetic'),configDir=join(workspace,'private','synthetic'),control=join(root,'control');
  for(const path of [workspace,checkout,configDir,control,join(checkout,'registry'),join(checkout,'dist','registry')])await mkdir(path,{recursive:true,mode:0o700});
  const git=async args=>(await execute('git',['-C',checkout,...args],{env:{...process.env,GIT_AUTHOR_NAME:'Scout fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Scout fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}})).stdout.trim();
  await git(['init','--initial-branch=main']);
  await writeFile(join(checkout,'README.md'),'Synthetic fixture only.\n');
  await git(['add','.']);await git(['commit','-m','baseline']);const base=await git(['rev-parse','HEAD']);
  const registry={version:1,adapters:[{id:sourceId,model,modalities:['text']}]};
  const bytes=json(registry),registrySha=createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(checkout,'registry','adapters.json'),bytes);
  await writeFile(join(checkout,'dist','registry','adapters.json'),bytes);
  if(realApi){
    const repo=resolve(import.meta.dirname,'../..');
    await cp(join(repo,'dist'),join(checkout,'dist'),{recursive:true});
    await cp(await realpath(join(repo,'node_modules/hono')),join(checkout,'node_modules/hono'),{recursive:true});
    await writeFile(join(checkout,'package.json'),json({type:'module'}));
    await writeFile(join(checkout,'dist','registry.js'),`export const bundledRegistry=${JSON.stringify(registry)};export const knownAdapters=new Set(['${sourceId}']);export const disabledAdapters=new Set();`);
    await writeFile(join(checkout,'dist','local','main.js'),`
import {Sources} from './source.js';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
export function configure(env){
 if(env.MILO_SOURCES!=='${sourceId}'||!env.MILO_CONFIG_DIR)throw new Error('unsafe fixture config');
 if(existsSync(${JSON.stringify(join(control,'host-only.txt'))}))throw new Error('host protected state visible');
 try{writeFileSync(${JSON.stringify(join(control,'host-only.txt'))},'forged');throw new Error('host protected state writable');}catch(error){if(error.message==='host protected state writable')throw error;}
 try{writeFileSync(${JSON.stringify(join(checkout,'README.md'))},'forged');throw new Error('reviewed checkout writable');}catch(error){if(error.message==='reviewed checkout writable')throw error;}
 if(readFileSync(${JSON.stringify(join(checkout,'README.md'))},'utf8')!=='Synthetic fixture only.\\n')throw new Error('checkout changed');
 writeFileSync(env.MILO_CONFIG_DIR+'/sandbox-marker.json',JSON.stringify({home:process.env.HOME,hostStateVisible:false}));
 return new Sources([{id:'${sourceId}',supportsFunctionTools:true,available:async()=>true,close:async()=>{},complete:async(request)=>{
  if(request.model!=='${sourceId}'||request.maxTokens!==1024)throw new Error('unsafe fixture request');
  if(!request.tools.length)return {text:'Hello from the actual API fixture.'};
  return {text:'',calls:[{id:'probe_call',type:'function',function:{name:'scout_probe',arguments:JSON.stringify({nonce:request.tools[0].function.parameters.properties.nonce.const})}}]};
 }}]);
}`);
    // The fixture uses a descriptor for an inert package-manager tree; no
    // dependency installation, network access or account state is required.
    const sandboxState=join(control,'sandbox'),tools=join(sandboxState,'toolchain'),pnpm=join(tools,'node_modules/pnpm');
    await mkdir(join(pnpm,'bin'),{recursive:true,mode:0o700});
    await writeFile(join(pnpm,'package.json'),json({name:'pnpm',version:'10.34.5'}));
    await writeFile(join(pnpm,'bin/pnpm.cjs'),'process.exit(0);');
    const script="import sys,json,pathlib;sys.path.insert(0,sys.argv[1]);import sandbox;root=pathlib.Path(sys.argv[2]);receipt=root/'receipt.json';receipt.write_text(json.dumps(sandbox._descriptor(root,pathlib.Path(sys.argv[3]).resolve())));receipt.chmod(0o600)";
    await execute('/usr/bin/python3',['-c',script,import.meta.dirname,tools,process.execPath]);
    await writeFile(join(control,'host-only.txt'),'unmodified host authority\n',{mode:0o600});
    // Copying the actual runtime overwrites the synthetic bundled JSON copy.
    await writeFile(join(checkout,'dist/registry/adapters.json'),bytes);
  }
  await git(['add','.']);await git(['commit','-m','candidate']);const head=await git(['rev-parse','HEAD']);
  const reviewReceipt=join(control,'review.json'),output=join(control,'proof.json');
  await writeFile(reviewReceipt,json({verdict:'approve',independent:true,head_sha:head,base_sha:base,checks}),{mode:0o600});
  const options={workspace,checkout,configDir,reviewReceipt,output,sourceId,model,head,registrySha,sandboxState:join(control,'sandbox')};
  const calls=[],waits=[],environments=[];let closed=0,statusCalls=0;
  const candidate={registry,known:new Set([sourceId]),disabled:new Set(),configure:env=>{environments.push(env);return {sources:[{id:sourceId,supportsFunctionTools:true}],close:async()=>{closed++;}};},createLocalApp:()=>({fetch:async request=>{
    assert.equal(new URL(request.url).port,'0');assert.equal(request.method,'POST');
    const body=await request.json();calls.push(body);
    const message=body.tools.length?{content:null,tool_calls:[{id:'probe_call',type:'function',function:{name:'scout_probe',arguments:JSON.stringify({nonce:body.tools[0].function.parameters.properties.nonce.const})}}]}:{content:'Hello from a synthetic fixture.'};
    return new Response(json({choices:[{message}]}),{status:200,headers:{'X-Grunt-Source':sourceId}});
  }})};
  const dependencies={loadCandidate:async()=>candidate,fetcher:async url=>{assert.equal(url,'http://127.0.0.1:8792/v1/status');statusCalls++;return new Response(json({version:1,activeRequests:0}));},wait:async ms=>{waits.push(ms);},now:()=>1700000000000,random:()=>0.25,env:{HOME:'/synthetic/home',PATH:'/synthetic/path',MILO_SOURCES:'production',MILO_CONFIG_DIR:'/production/config',PROVIDER_KEY:'never-pass-me'}};
  return{options,dependencies,candidate,calls,waits,environments,registry,git,root,get closed(){return closed;},get statusCalls(){return statusCalls;}};
}

test('two attributed bounded probes produce a private hash-only receipt and close sources',async t=>{
  const f=await fixture(t),proof=await runProbe(f.options,f.dependencies);
  assert.equal(proof.outcome,'passed');assert.equal(proof.model_verification,'adapter_guard_reviewed');
  assert.equal(proof.free_guard_verified,true);assert.equal(proof.attribution_verified,true);assert.equal(proof.tool_call_verified,true);
  assert.equal(proof.head_sha,f.options.head);assert.equal(proof.registry_sha256,f.options.registrySha);
  assert.deepEqual(proof.observations.map(item=>item.kind),['hello','tool']);assert.match(proof.observations[0].reply_sha256,/^[a-f0-9]{64}$/);
  assert.equal(f.calls.length,2);assert.equal(f.statusCalls,2);assert.equal(f.closed,1);assert.deepEqual(f.waits,[67500]);
  for(const call of f.calls){assert.equal(call.max_tokens,1024);assert.equal(call.model,sourceId);assert.equal(call.stream,false);assert.ok(call.cwd.startsWith(f.options.configDir+'/.scout-probe-'));}
  assert.equal(f.environments[0].MILO_SOURCES,sourceId);assert.equal(f.environments[0].MILO_CONFIG_DIR,f.options.configDir);assert.equal(f.environments[0].PROVIDER_KEY,undefined);
  const encoded=await readFile(f.options.output,'utf8');assert.deepEqual(JSON.parse(encoded),proof);assert.ok(!encoded.includes('Hello from'));assert.ok(!encoded.includes('nonce'));assert.equal((await stat(f.options.output)).mode&0o777,0o600);
  assert.deepEqual(await readdir(f.options.configDir),[]);
});

test('cached busy production status defers without spending a probe',async t=>{
  const f=await fixture(t);f.dependencies.fetcher=async()=>new Response(json({version:1,activeRequests:1}));
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.outcome,'deferred');assert.equal(proof.code,'busy');assert.equal(f.calls.length,0);assert.equal(f.closed,1);
});

test('unavailable production status fails closed without inference',async t=>{
  const f=await fixture(t);f.dependencies.fetcher=async()=>{throw new Error('upstream secret');};
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.outcome,'deferred');assert.equal(proof.code,'production_status_unavailable');assert.equal(f.calls.length,0);assert.ok(!JSON.stringify(proof).includes('secret'));
});

test('wrong attribution cannot be mistaken for successful fallback',async t=>{
  const f=await fixture(t);f.candidate.createLocalApp=()=>({fetch:async()=>new Response(json({choices:[{message:{content:'Hello'}}]}),{headers:{'X-Grunt-Source':'fallback'}})});
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.code,'wrong_source');assert.equal(proof.outcome,'failed');assert.equal(proof.free_guard_verified,false);assert.equal(f.closed,1);
});

test('tool schema nonce and argument names must match exactly',()=>{
  const message=args=>({tool_calls:[{id:'call',type:'function',function:{name:'scout_probe',arguments:JSON.stringify(args)}}]});
  assert.equal(verifyTool(message({nonce:'expected'}),'expected'),true);
  for(const args of [{nonce:'wrong'},{nonce:'expected',extra:true},null,[],{}])assert.throws(()=>verifyTool(message(args),'expected'),{code:'tool_protocol'});
  assert.throws(()=>verifyTool({content:'I called scout_probe'},'expected'),{code:'tool_protocol'});
});

test('review must approve all guards and bind the exact head',()=>{
  const head='a'.repeat(40),review={verdict:'approve',independent:true,head_sha:head,base_sha:'b'.repeat(40),checks};
  assert.equal(verifyReview(review,head),review);
  for(const key of Object.keys(checks))assert.throws(()=>verifyReview({...review,checks:{...checks,[key]:false}},head),{code:'review_required'});
  assert.throws(()=>verifyReview({...review,independent:false},head),{code:'review_required'});
  assert.throws(()=>verifyReview(review,'c'.repeat(40)),{code:'review_required'});
});

test('registry rejects weaker model rotation, unknown and disabled sources',()=>{
  const registry={adapters:[{id:sourceId,model,modalities:['text']}]},known=new Set([sourceId]);
  assert.equal(verifyRegistry(registry,known,new Set(),sourceId,model).model,model);
  assert.throws(()=>verifyRegistry(registry,new Set(),new Set(),sourceId,model),{code:'source_unlisted'});
  assert.throws(()=>verifyRegistry(registry,known,known,sourceId,model),{code:'source_unlisted'});
  assert.throws(()=>verifyRegistry({adapters:[{...registry.adapters[0],models:[model,'weak-fallback']}]},known,new Set(),sourceId,model),{code:'model_mismatch'});
});

test('worker-writable review and proof paths are rejected before candidate import',async t=>{
  const f=await fixture(t);let imports=0;f.dependencies.loadCandidate=async()=>{imports++;return f.candidate;};
  let proof=await runProbe({...f.options,output:join(f.options.configDir,'spoof.json')},f.dependencies);assert.equal(proof.code,'protected_output_required');
  proof=await runProbe({...f.options,reviewReceipt:join(f.options.configDir,'review.json')},f.dependencies);assert.equal(proof.code,'protected_review_required');assert.equal(imports,0);assert.equal(f.calls.length,0);
});

test('built registry and tracked checkout must exactly match reviewed source',async t=>{
  const f=await fixture(t);let imports=0;f.dependencies.loadCandidate=async()=>{imports++;return f.candidate;};
  await writeFile(join(f.options.checkout,'dist/registry/adapters.json'),'{}');
  let proof=await runProbe(f.options,f.dependencies);assert.equal(proof.code,'scope_changed');assert.equal(imports,0);
  await f.git(['checkout','--','dist/registry/adapters.json']);
  proof=await runProbe({...f.options,registrySha:'0'.repeat(64)},f.dependencies);assert.equal(proof.code,'registry_changed');assert.equal(imports,0);
});

test('non tool capable source fails before inference',async t=>{
  const f=await fixture(t);f.candidate.configure=()=>({sources:[{id:sourceId}],close:async()=>{}});
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.code,'exact_tool_source_required');assert.equal(f.calls.length,0);
});

test('imported registry cannot substitute a different model for the hashed registry',async t=>{
  const f=await fixture(t);f.candidate.registry={adapters:[{id:sourceId,model:'different-model',modalities:['text']}]};
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.code,'model_mismatch');assert.equal(f.calls.length,0);assert.equal(f.environments.length,0);
});

test('scope modification during a probe invalidates otherwise successful replies',async t=>{
  const f=await fixture(t);f.dependencies.wait=async()=>writeFile(join(f.options.checkout,'README.md'),'modified after review');
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.code,'scope_changed');assert.equal(proof.outcome,'failed');assert.equal(f.calls.length,2);assert.equal(proof.free_guard_verified,false);
});

test('upstream payloads and unexpected exception strings are never persisted',async t=>{
  const f=await fixture(t);f.candidate.createLocalApp=()=>({fetch:async()=>new Response(json({error:{code:'untrusted-secret-code',message:'private-key-do-not-persist'}}),{status:503})});
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.code,'upstream');assert.ok(!JSON.stringify(proof).includes('private-key'));assert.ok(!JSON.stringify(proof).includes('untrusted-secret'));
});

test('aborting between calls prevents the second inference and closes sources',async t=>{
  const f=await fixture(t),controller=new AbortController();f.dependencies.wait=async()=>controller.abort();
  const proof=await runProbe({...f.options,signal:controller.signal},f.dependencies);assert.equal(proof.code,'cancelled');assert.equal(f.calls.length,1);assert.equal(f.closed,1);
});

test('hung handler times out and closes owned sources',async t=>{
  const f=await fixture(t);f.candidate.createLocalApp=()=>({fetch:()=>new Promise(()=>{})});f.dependencies.requestTimeoutMs=5;
  const keepAlive=setTimeout(()=>{},1000);t.after(()=>clearTimeout(keepAlive));
  const proof=await runProbe(f.options,f.dependencies);assert.equal(proof.code,'timeout');assert.equal(f.closed,1);
});

test('CLI requires every scope flag and rejects duplicate or unknown flags',()=>{
  const args=['--workspace','/workspace','--sandbox-state','/state','--checkout','/checkout','--source-id',sourceId,'--model',model,'--config-dir','/config','--head','a'.repeat(40),'--registry-sha','b'.repeat(64),'--review-receipt','/review','--output','/output'];
  assert.equal(parseArguments(args).sourceId,sourceId);
  for(const invalid of [[],args.slice(0,-2),[...args,'--output','/another'],[...args,'--unknown','yes']])assert.throws(()=>parseArguments(invalid),{code:'invalid_arguments'});
});

test('sandbox child exercises actual Grunt API without access to host authority or writable checkout',async t=>{
  const f=await fixture(t,{realApi:true});delete f.dependencies.loadCandidate;
  const proof=await runProbe(f.options,f.dependencies);
  assert.equal(proof.outcome,'passed',JSON.stringify(proof));assert.equal(proof.tool_call_verified,true);assert.equal(proof.observations.length,2);
  assert.equal(await readFile(join(f.root,'control/host-only.txt'),'utf8'),'unmodified host authority\n');
  assert.deepEqual(JSON.parse(await readFile(join(f.options.configDir,'sandbox-marker.json'),'utf8')),{home:'/tmp/scout-home',hostStateVisible:false});
});
