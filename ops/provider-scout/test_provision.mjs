import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installGrant} from './provision.mjs';

async function fixture(t){
 const workspace=await mkdtemp(join(tmpdir(),'grunt-provision-test-'));
 t.after(()=>rm(workspace,{recursive:true,force:true}));
 return{workspace,source_id:'synthetic',grant:{base_url:'https://proxy.example/grants/one/',token:'synthetic-never-print'}};
}
test('installs only a private native proxy grant and reports metadata',async t=>{
 const request=await fixture(t),result=await installGrant(request);
 assert.deepEqual(result,{installed:true,source_id:'synthetic',config_file:'candidate-configs/synthetic/synthetic.json'});
 assert(!JSON.stringify(result).includes(request.grant.token));
 const destination=join(request.workspace,result.config_file);
 assert.deepEqual(JSON.parse(await readFile(destination,'utf8')),{base_url:'https://proxy.example/grants/one',token:request.grant.token});
 assert.equal((await stat(destination)).mode&0o777,0o600);
 for(const path of ['candidate-configs','candidate-configs/synthetic'])assert.equal((await stat(join(request.workspace,path))).mode&0o777,0o700);
});
test('repeated installation atomically replaces only the owned source grant',async t=>{
 const request=await fixture(t),first=await installGrant(request);
 request.grant.token='synthetic-replacement';await installGrant(request);
 const stored=JSON.parse(await readFile(join(request.workspace,first.config_file),'utf8'));
 assert.equal(stored.token,'synthetic-replacement');
 assert.deepEqual(Object.keys(stored).sort(),['base_url','token']);
});
test('rejects traversal, insecure endpoint and control characters',async t=>{
 const request=await fixture(t);
 for(const source_id of ['../other','Synthetic','/tmp/other',''])await assert.rejects(installGrant({...request,source_id}));
 for(const base_url of ['http://proxy.example','https://user@proxy.example','https://proxy.example/?key=secret','https://proxy.example/#secret']){
  await assert.rejects(installGrant({...request,grant:{...request.grant,base_url}}));
 }
 await assert.rejects(installGrant({...request,grant:{...request.grant,token:'synthetic\nsecret'}}));
});
test('refuses symlinked config directories without writing through them',async t=>{
 const request=await fixture(t),other=await mkdtemp(join(tmpdir(),'grunt-provision-other-'));
 t.after(()=>rm(other,{recursive:true,force:true}));
 await symlink(other,join(request.workspace,'candidate-configs'));
 await assert.rejects(installGrant(request));
 await assert.rejects(stat(join(other,'synthetic')),{code:'ENOENT'});
});
test('refuses symlinked target and permissive existing grant files',async t=>{
 const request=await fixture(t),dir=join(request.workspace,'candidate-configs/synthetic');
 await mkdir(dir,{recursive:true,mode:0o700});
 const untouched=join(request.workspace,'untouched');await writeFile(untouched,'safe',{mode:0o600});
 await symlink(untouched,join(dir,'synthetic.json'));
 await assert.rejects(installGrant(request));assert.equal(await readFile(untouched,'utf8'),'safe');
 await rm(join(dir,'synthetic.json'));await writeFile(join(dir,'synthetic.json'),'{}',{mode:0o644});
 await assert.rejects(installGrant(request));
});
test('CLI accepts backend stdin and never prints the grant or an input error body',async t=>{
 const request=await fixture(t),helper=fileURLToPath(new URL('./provision.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[helper],{input:JSON.stringify(request),encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).installed,true);
 assert(!result.stdout.includes(request.grant.token));assert.equal(result.stderr,'');
 const invalid=spawnSync(process.execPath,[helper],{input:'synthetic-never-print invalid JSON',encoding:'utf8',timeout:15000});
 assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).installed,false);
 assert(!invalid.stdout.includes('synthetic-never-print'));assert.equal(invalid.stderr,'');
});
