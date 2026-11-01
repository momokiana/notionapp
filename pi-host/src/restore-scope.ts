import {lstatSync}from'node:fs';
import {basename,isAbsolute,join,resolve}from'node:path';
import{backupHash,type BackupMaterial}from'./backup-format.js';
import{canonical,HostError,noSymlinks,record,requireHost}from'./private-files.js';
import type{RestoreRole}from'./restore-files.js';

export interface RestoreScope {config:string;registry:string;initial_prompt:string;data_dir:string;device_authority?:string;system_prompt?:string}
export interface RestoreTarget {role:RestoreRole;path:string;bytes:Buffer;static:boolean}
const absolute=(v:unknown):v is string=>typeof v==='string'&&isAbsolute(v)&&resolve(v)===v&&v.length<=4096&&!/[\u0000-\u001f\u007f]/u.test(v);
const inside=(path:string,dir:string)=>path===dir||path.startsWith(dir+'/');
const invalid=():never=>{throw new HostError('RESTORE_SCOPE_INVALID');};
/** Small flat-string JSON grammar: accepts ordinary whitespace but rejects duplicate keys before JSON.parse can discard them. */
export function parseRestoreScope(bytes:Buffer):RestoreScope{
  requireHost(bytes.length>=2&&bytes.length<=65536,'RESTORE_SCOPE_INVALID');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return invalid();}let i=0;const out:Record<string,string>=Object.create(null)as Record<string,string>;
  const ws=()=>{while(i<text.length&&/[\t\n\r ]/.test(text[i]!))i++;};
  const string=()=>{ws();if(text[i]!== '"')return invalid();const start=i++;let escaped=false;while(i<text.length){const c=text[i++]!;if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){const value:unknown=JSON.parse(text.slice(start,i));if(typeof value!=='string')return invalid();return value;}}return invalid();};
  try{ws();if(text[i++]!=='{')return invalid();ws();if(text[i]!=='}')while(true){const key=string();if(Object.hasOwn(out,key))return invalid();ws();if(text[i++]!==':')return invalid();out[key]=string();ws();if(text[i]===','){i++;continue;}break;}if(text[i++]!=='}')return invalid();ws();if(i!==text.length)return invalid();
    if(!['config','registry','initial_prompt','data_dir'].every(k=>Object.hasOwn(out,k))||!Object.keys(out).every(k=>['config','registry','initial_prompt','data_dir','device_authority','system_prompt'].includes(k))||!Object.values(out).every(absolute))return invalid();return out as unknown as RestoreScope;
  }catch(error){if(error instanceof HostError)throw error;return invalid();}
}
function cfgOf(material:BackupMaterial){const raw:unknown=JSON.parse(material.records.find(r=>r.name==='config')!.bytes.toString('utf8'));requireHost(record(raw),'RESTORE_SCOPE_INVALID');return raw;}
export function protectedRestoreReferences(material:BackupMaterial):string[]{
  const cfg=cfgOf(material);requireHost(absolute(cfg.data_dir),'RESTORE_SCOPE_INVALID');const ref=record(cfg.identity_reference)?cfg.identity_reference:undefined;
  return [join(cfg.data_dir,'agent/auth.json'),join(cfg.data_dir,'agent/models.json'),join(cfg.data_dir,'agent/models-store.json'),ref?.persona_file,ref?.settings_file,ref?.credentials_file,record(cfg.push)?cfg.push.token_file:undefined].filter((p):p is string=>typeof p==='string');
}
const inode=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
/** Caller-supplied operation paths are never allowed to turn an excluded external reference into an input or target. Metadata only. */
export function assertRestoreReferenceSeparation(material:BackupMaterial,paths:string[]):void{
  const refs=protectedRestoreReferences(material).map(path=>({path,stat:inode(path)}));
  for(const path of paths){requireHost(absolute(path),'RESTORE_SCOPE_INVALID');noSymlinks(path);const current=inode(path);for(const ref of refs)requireHost(path!==ref.path&&(!current||!ref.stat||current.dev!==ref.stat.dev||current.ino!==ref.stat.ino),'RESTORE_EXTERNAL_REFERENCE_OVERLAP');}
}
/** Only already-authenticated/semantically-inspected material. Archived paths are compared to explicit scope BEFORE target IO. */
export function resolveRestoreScope(material:BackupMaterial,scopeBytes:Buffer):{scope:RestoreScope;scope_sha256:string;targets:RestoreTarget[];store_id?:string}{
  const scope=parseRestoreScope(scopeBytes);const cfg=cfgOf(material);const expected={config:material.metadata.origin_config_file,registry:cfg.auth_file,initial_prompt:cfg.initial_prompt_file,data_dir:cfg.data_dir,...(cfg.device_auth!==undefined?{device_authority:(cfg.device_auth as{path:string}).path}:{}),...(cfg.system_prompt_file!==undefined?{system_prompt:cfg.system_prompt_file}:{})};
  requireHost(canonical(scope)===canonical(expected),'RESTORE_SCOPE_NOT_ORIGINAL');
  const manifest=JSON.parse(material.records.find(r=>r.name==='manifest')!.bytes.toString('utf8'))as{session_file:string};const native=join(scope.data_dir,'native',basename(manifest.session_file));requireHost(native===manifest.session_file,'RESTORE_SCOPE_NOT_ORIGINAL');
  const paths:Partial<Record<string,string>>={config:scope.config,registry:scope.registry,'initial-prompt':scope.initial_prompt,...(scope.system_prompt?{'system-prompt':scope.system_prompt}:{}),manifest:join(scope.data_dir,'manifest.json'),native,ledger:join(scope.data_dir,'ledger.sqlite'),'device-authority':scope.device_authority,'source-pump':join(scope.data_dir,'source-pump.json'),initializing:join(scope.data_dir,'initializing.json')};
  const targets=material.records.map(r=>{const path=paths[r.name];requireHost(path&&absolute(path),'RESTORE_SCOPE_INVALID');return{role:r.name as RestoreRole,path,bytes:r.bytes,static:['config','registry','initial-prompt','system-prompt'].includes(r.name)};});
  for(let i=0;i<targets.length;i++)for(let j=0;j<i;j++){const a=targets[i]!.path,b=targets[j]!.path;requireHost(!inside(a,b)&&!inside(b,a),'RESTORE_TARGET_ROLE_OVERLAP');const as=inode(a),bs=inode(b);requireHost(!as||!bs||as.dev!==bs.dev||as.ino!==bs.ino,'RESTORE_TARGET_ROLE_OVERLAP');}
  assertRestoreReferenceSeparation(material,[scope.data_dir,...targets.map(t=>t.path)]);return{scope,scope_sha256:backupHash(scopeBytes),targets,...(cfg.device_auth?{store_id:(cfg.device_auth as{store_id:string}).store_id}:{})};
}
