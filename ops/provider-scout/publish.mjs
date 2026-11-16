// Trusted supervisor helper. Vault secrets and proxy tokens stay in this process.
import {readFile,writeFile,lstat,rename,unlink,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,isAbsolute,join,basename,relative} from 'node:path';
import {pathToFileURL} from 'node:url';

process.umask(0o077);
const args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const requestPath=option('--request'),outputPath=option('--output');
const preflight=args.includes('--preflight'),dryRun=args.includes('--dry-run');
const report={status:'blocked',authenticated:false,requestSent:false,grantRevoked:false};
let client,grant;
const shutdown=new AbortController();
for(const name of ['SIGTERM','SIGINT'])process.once(name,()=>shutdown.abort(new Error('publisher_interrupted')));
function fail(code){throw Object.assign(new Error(code),{safeCode:code});}
async function privateFile(path,privateRequired=false){
 if(typeof path!=='string'||!isAbsolute(path))fail('invalid_private_path');
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&(privateRequired?0o077:0o022))!==0||info.size>20*1024*1024)fail('unsafe_private_file');
 return readFile(path);
}
async function bounded(response,maximum=32768){
 if(!response.body)return Buffer.alloc(0);
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximum)fail('response_too_large');chunks.push(part.value);}
  return Buffer.concat(chunks);
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const sha=/^[a-f0-9]{40}$/,digest=/^[a-f0-9]{64}$/;
const inside=(path,root)=>{const part=relative(root,path);return part===''||(!part.startsWith('..')&&!isAbsolute(part));};
async function authorize(request){
 const file=request.authorization_file;
 const authority=JSON.parse((await privateFile(file,true)).toString());
 const root=dirname(file),receipt=authority.receipt,artifact=authority.artifact;
 if(authority.version!==1||!receipt||!artifact||authority.release_root!==root||await realpath(root)!==root
    ||!sha.test(receipt.head_sha)||!sha.test(receipt.base_sha)||!sha.test(authority.merge_sha)
    ||basename(root)!=='release-'+receipt.head_sha||requestPath!==join(root,'publish-request.json'))fail('invalid_release_authorization');
 for(const directory of [root,dirname(root)]){
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))fail('unsafe_authorization_directory');
 }
 const workspace=authority.workspace;
 if(typeof workspace!=='string'||!isAbsolute(workspace)||inside(root,workspace)
    ||typeof receipt.checkout!=='string'||!inside(receipt.checkout,join(workspace,'candidates'))
    ||receipt.version!==1||receipt.qualified!==true||receipt.probe_verified_by_supervisor!==true
    ||!digest.test(receipt.registry_sha256)||!digest.test(receipt.trusted_evidence_sha256))fail('invalid_supervisor_authority');
 if(typeof authority.trusted_evidence_raw!=='string'||createHash('sha256').update(authority.trusted_evidence_raw).digest('hex')!==receipt.trusted_evidence_sha256)fail('trusted_probe_hash_mismatch');
 const proof=JSON.parse(authority.trusted_evidence_raw);
 for(const key of ['head_sha','registry_sha256','source_id','model'])if(proof[key]!==receipt[key])fail('trusted_probe_binding_mismatch');
 if(proof.http_status!==200||!['reply_received','attribution_verified','tool_call_verified','free_guard_verified'].every(key=>proof[key]===true)
    ||receipt.checks?.passed!==true||receipt.checks.head_sha!==receipt.head_sha)fail('incomplete_supervisor_authority');
 const identifiers=new Set(),phases=new Set();
 if(!Array.isArray(receipt.reviews))fail('independent_reviews_required');
 for(const review of receipt.reviews){
  if(review.verdict!=='approve'||review.independent!==true||review.head_sha!==receipt.head_sha||review.base_sha!==receipt.base_sha
     ||typeof review.review_id!=='string'||!review.review_id||identifiers.has(review.review_id)
     ||!['model','context','free_access','terms','signup','consent','code_scope'].every(key=>review.checks?.[key]===true))fail('independent_review_invalid');
  identifiers.add(review.review_id);phases.add(review.phase);
 }
 if(identifiers.size<2||!phases.has('pre_execution')||!phases.has('post_validation'))fail('independent_reviews_required');
 for(const key of ['version','tarball','sha256','integrity','bytes'])if(request[key]!==artifact[key])fail('artifact_authorization_mismatch');
 if(request.tarball!==join(root,'usegrunt-'+request.version+'.tgz')||request.package_file!==join(root,'checkout/package.json')
    ||request.readme_file!==join(root,'checkout/README.md'))fail('artifact_path_not_authorized');
}
async function save(){
 if(typeof outputPath!=='string'||!isAbsolute(outputPath))return;
 const temporary=join(dirname(outputPath),'.publisher-'+randomUUID()+'.tmp');
 try{await writeFile(temporary,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});await rename(temporary,outputPath);}
 finally{await unlink(temporary).catch(()=>{});}
}
try{
 if(!requestPath||!outputPath)fail('request_and_output_required');
 const request=JSON.parse((await privateFile(requestPath,true)).toString());
 let body;
 if(!preflight){
  await authorize(request);
  const pkg=JSON.parse((await privateFile(request.package_file)).toString());
  if(pkg.name!=='usegrunt'||pkg.type!=='module'||typeof pkg.version!=='string'||!/^\d+\.\d+\.\d+$/.test(pkg.version)||pkg.version!==request.version||pkg.private===true)fail('unexpected_package_identity');
  const tarball=await privateFile(request.tarball);
  const sha256=createHash('sha256').update(tarball).digest('hex');
  const integrity='sha512-'+createHash('sha512').update(tarball).digest('base64');
  if(sha256!==request.sha256||integrity!==request.integrity||tarball.length!==request.bytes||!request.tarball.endsWith('/usegrunt-'+pkg.version+'.tgz'))fail('artifact_verification_failed');
  const readme=(await privateFile(request.readme_file)).toString();
  const filename='usegrunt-'+pkg.version+'.tgz';
  const manifest={...pkg,_id:'usegrunt@'+pkg.version,readme,readmeFilename:'README.md',_nodeVersion:process.versions.node,
   dist:{integrity,shasum:createHash('sha1').update(tarball).digest('hex'),tarball:'https://registry.npmjs.org/usegrunt/-/'+filename}};
  body=JSON.stringify({_id:'usegrunt',name:'usegrunt',description:pkg.description,'dist-tags':{latest:pkg.version},versions:{[pkg.version]:manifest},access:'public',
   _attachments:{[filename]:{content_type:'application/octet-stream',data:tarball.toString('base64'),length:tarball.length}}});
  Object.assign(report,{version:pkg.version,sha256,integrity,bytes:tarball.length});
  if(dryRun){report.status='dry_run';report.grantRevoked=true;await save();console.log(JSON.stringify(report));process.exit(0);}
 }
 if(typeof request.credential_reference!=='string'||!/^vault:\/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+$/.test(request.credential_reference))fail('npm_credential_not_configured');
 if(typeof request.squire_module!=='string'||!isAbsolute(request.squire_module))fail('trusted_squire_module_required');
 const moduleInfo=await lstat(request.squire_module);
 if(!moduleInfo.isFile()||moduleInfo.isSymbolicLink()||moduleInfo.uid!==process.getuid()||(moduleInfo.mode&0o022))fail('unsafe_squire_module');
 const {BrowserSquire}=await import(pathToFileURL(request.squire_module).href);
 if(typeof BrowserSquire!=='function')fail('trusted_squire_runtime_unavailable');
 client=new BrowserSquire();await client.connect();
 grant=await client.call('grant_app_access',{reference:request.credential_reference});
 if(typeof grant.base_url!=='string'||typeof grant.token!=='string'||typeof grant.grant_id!=='string')fail('publisher_grant_approval_required');
 const url=new URL(grant.base_url);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('invalid_publication_proxy');
 const endpoint=grant.base_url.replace(/\/$/,'')+(preflight?'/-/whoami':'/usegrunt');
 if(!preflight){
   const latest=await fetch('https://registry.npmjs.org/usegrunt/latest',{redirect:'error',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(15000)])});
  if(latest.status!==404){
   if(!latest.ok)fail('npm_latest_unavailable');
   let metadata;try{metadata=JSON.parse((await bounded(latest,1024*1024)).toString());}catch{fail('npm_latest_unavailable');}
   if(metadata.name!=='usegrunt'||typeof metadata.version!=='string'||metadata.version!==request.expected_latest_version)fail('npm_latest_changed_before_publication');
   const current=metadata.version.split('.').map(Number),wanted=request.version.split('.').map(Number);
   if(current.length!==3||current.some(v=>!Number.isSafeInteger(v))||wanted[0]!==current[0]||wanted[1]!==current[1]||wanted[2]!==current[2]+1)fail('npm_version_conflict');
  }else{await latest.body?.cancel();if(request.expected_latest_version!==null)fail('npm_latest_changed_before_publication');}
 }
 if(!preflight)report.requestSent=true;
 const response=await fetch(endpoint,{method:preflight?'GET':'PUT',redirect:'error',
  headers:{Authorization:'Bearer '+grant.token,...(preflight?{}:{'Content-Type':'application/json'})},
  ...(preflight?{}:{body}),signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(60000)])});
 report.httpStatus=response.status;
 if(preflight){
  const content=await bounded(response);let account;
  try{account=JSON.parse(content.toString());}catch{fail('npm_authentication_failed');}
  if(!response.ok||typeof account.username!=='string'||!account.username)fail('npm_authentication_failed');
  report.status='authenticated';report.authenticated=true;
 }else{
  // Upstream bodies can contain sensitive error details. Never retain them.
  await response.body?.cancel().catch(()=>{});
  if(![200,201,202].includes(response.status))fail(response.status===409?'version_conflict':'npm_publication_failed');
  report.status=response.status===202?'accepted':'published';
 }
}catch(error){report.reason=typeof error?.safeCode==='string'?error.safeCode:'publisher_operation_failed';process.exitCode=1;}
finally{
 if(grant?.grant_id&&client){
  try{await client.call('revoke_app_access',{grant_id:grant.grant_id});report.grantRevoked=true;}
  catch{report.status='blocked';report.reason='publisher_grant_cleanup_required';process.exitCode=1;}
 }
 if(client)await client.close().catch(()=>{report.status='blocked';report.reason='publisher_client_cleanup_failed';process.exitCode=1;});
 try{await save();}catch{process.exitCode=1;}
 console.log(JSON.stringify(report));
}
