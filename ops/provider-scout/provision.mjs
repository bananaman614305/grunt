#!/usr/bin/env node
// Backend-only grant writer. Secret-bearing input arrives only on stdin; output
// describes the installed file, never the provider key or Squire proxy token.
import {constants} from 'node:fs';
import {open,mkdir,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

export class ProvisionError extends Error {
 constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new ProvisionError(code);};
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
async function directory(path){
 const handle=await open(path,directoryFlags);
 try{
  const info=await handle.stat();
  if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o777)!==0o700)fail('unsafe_config_directory');
  return handle;
 }catch(error){await handle.close();throw error;}
}
const anchored=(handle,name)=>join('/proc/self/fd',String(handle.fd),name);
async function childDirectory(parent,name){
 const path=anchored(parent,name);
 try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 return directory(path);
}

/** Fixed path and schema; does not assert free entitlements or data consent. */
export async function installGrant(request){
 if(process.platform!=='linux'||typeof process.getuid!=='function')fail('unsupported_provision_platform');
 if(!request||typeof request.workspace!=='string'||!isAbsolute(request.workspace)||!ID.test(request.source_id??''))fail('invalid_provision_request');
 const workspace=request.workspace;
 if(await realpath(workspace)!==workspace)fail('noncanonical_workspace');
 const grant=request.grant;
 if(!grant||typeof grant.base_url!=='string'||grant.base_url.length>2048||typeof grant.token!=='string'
    ||!grant.token.trim()||grant.token.length>8192||/[\u0000-\u001f\u007f]/.test(grant.token))fail('invalid_backend_grant');
 let url;
 try{url=new URL(grant.base_url);}catch{fail('invalid_backend_grant');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('invalid_backend_grant');
 const value={base_url:grant.base_url.replace(/\/$/,''),token:grant.token};
 let root,configs,source,temporary,file;
 try{
  root=await directory(workspace);
  configs=await childDirectory(root,'candidate-configs');
  source=await childDirectory(configs,request.source_id);
  const destination=anchored(source,request.source_id+'.json');
  try{
   const existing=await lstat(destination);
   if(!existing.isFile()||existing.isSymbolicLink()||existing.uid!==process.getuid()||(existing.mode&0o777)!==0o600)fail('unsafe_existing_grant');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  temporary=anchored(source,'.grant-'+randomUUID()+'.tmp');
  file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await file.writeFile(JSON.stringify(value));await file.sync();await file.close();file=undefined;
  await rename(temporary,destination);temporary=undefined;await source.sync();
  return{installed:true,source_id:request.source_id,config_file:join('candidate-configs',request.source_id,request.source_id+'.json')};
 }finally{
  if(file)await file.close().catch(()=>{});
  if(temporary)await unlink(temporary).catch(()=>{});
  for(const handle of [source,configs,root])if(handle)await handle.close().catch(()=>{});
 }
}

async function input(){
 const chunks=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>32768)fail('provision_request_too_large');chunks.push(chunk);}
 return JSON.parse(Buffer.concat(chunks).toString());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 process.umask(0o077);
 let timer;
 try{
  const request=await Promise.race([input(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new ProvisionError('provision_input_timeout')),10000);})]);
  console.log(JSON.stringify(await installGrant(request)));
 }catch(error){console.log(JSON.stringify({installed:false,error:error instanceof ProvisionError?error.code:'grant_install_failed'}));process.exitCode=1;}
 finally{clearTimeout(timer);process.stdin.destroy();}
}
