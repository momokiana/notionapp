import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,type Stats}from'node:fs';
import{basename,dirname,isAbsolute,join,resolve}from'node:path';
import{tmpdir}from'node:os';
import{randomUUID}from'node:crypto';
import{withReadOnlyBackupImage}from'notification-server/backup-validation';
import{freezeDerivedImageFile,assertFrozenLedger,assertFrozenAuthority,type RecoveryFence}from'notification-server/recovery-format';
import{recoveryPendingPath}from'notification-server/recovery-gate';
import{backupHash,MAX_BACKUP_RECORD_BYTES,type BackupMaterial}from'./backup-format.js';
import{readBackupFile,writeBackupFileExclusive}from'./backup-files.js';
import{assertBackupOutputSeparation}from'./backup-validate.js';
import{acquireOwnerLock}from'./native.js';
import{ensureRestoreDirectory,publishRestoreFile,verifyRestoreFile,verifyRestoreReservation,confirmRestoreControlFile,assertRestoreReservedParent,type RestoreRole}from'./restore-files.js';
import{resolveRestoreScope,parseRestoreScope,assertRestoreReferenceSeparation,type RestoreScope,type RestoreTarget}from'./restore-scope.js';
import{canonical,HostError,noSymlinks,record,requireHost}from'./private-files.js';

interface Inode{dev:number;ino:number}
interface TargetSpec{role:RestoreRole;path:string;bytes:number;sha256:string;static:boolean;parent?:Inode;reuse?:Inode}
interface Intent{format:1;restore_id:string;snapshot_id:string;archive_sha256:string;scope_sha256:string;archive_file:string;key_file:string;scope_file:string;scope_bytes:string;scope:RestoreScope;native_id:string;store_id:string|null;root:Inode;parent:Inode;runtime_parent:Inode;targets:TargetSpec[]}
export interface RestoreInputs{archive:string;keyFile:string;scopeFile:string;intent:string;writersQuiesced:boolean}
const absolute=(p:unknown):p is string=>typeof p==='string'&&isAbsolute(p)&&resolve(p)===p&&p.length<=4096&&!/[\u0000-\u001f\u007f]/u.test(p);
const uuid=(p:unknown)=>typeof p==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p);
const hash=(p:unknown)=>typeof p==='string'&&/^[a-f0-9]{64}$/.test(p);
const identify=(s:Stats):Inode=>({dev:s.dev,ino:s.ino});
const same=(a:Inode,b:Inode)=>a.dev===b.dev&&a.ino===b.ino;
const stat=(p:string)=>{try{return lstatSync(p);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
const privateDir=(p:string)=>{noSymlinks(p);const s=lstatSync(p);requireHost(s.isDirectory()&&s.uid===process.getuid?.()&&(s.mode&0o777)===0o700,'RESTORE_PRIVATE_PARENT_REQUIRED');return s;};
const inodeValue=(v:unknown):v is Inode=>record(v)&&Object.keys(v).sort().join(',')==='dev,ino'&&[v.dev,v.ino].every(n=>Number.isSafeInteger(n)&&Number(n)>=0);
const ordinaryRoles=['ledger','device-authority','config','registry','initial-prompt','system-prompt','manifest','native','source-pump','initializing'];
const staticRole=(role:string)=>['config','registry','initial-prompt','system-prompt'].includes(role);
const metaPath=(intent:string)=>join(intent,'INTENT.json');
const completePath=(intent:string)=>join(intent,'COMPLETE.json');
const flags={execution_enabled:false,current_permissions_verified:false,post_snapshot_effects_reconciled:false,model_budget_reconciled:false,original_install_durability_ack_reconstructed:false,prepared_payloads_are_private_frozen_aliases:true}as const;
const marker=(meta:Intent)=>Buffer.from(JSON.stringify({format:1,restore_id:meta.restore_id,snapshot_id:meta.snapshot_id,archive_sha256:meta.archive_sha256,scope_sha256:meta.scope_sha256})+'\n');
const complete=(meta:Intent)=>Buffer.from(JSON.stringify({format:1,restore_id:meta.restore_id,snapshot_id:meta.snapshot_id,intent_sha256:backupHash(Buffer.from(JSON.stringify(meta)+'\n')),...flags})+'\n');

function readIntent(path:string):Intent{
  const root=privateDir(path),parent=privateDir(dirname(path));const text=new TextDecoder('utf-8',{fatal:true}).decode(readBackupFile(metaPath(path),256*1024).bytes);const raw:unknown=JSON.parse(text);
  requireHost(record(raw)&&text===JSON.stringify(raw)+'\n'&&Object.keys(raw).sort().join(',')==='archive_file,archive_sha256,format,key_file,native_id,parent,restore_id,root,runtime_parent,scope,scope_bytes,scope_file,scope_sha256,snapshot_id,store_id,targets'
    &&raw.format===1&&uuid(raw.restore_id)&&uuid(raw.snapshot_id)&&uuid(raw.native_id)&&hash(raw.archive_sha256)&&hash(raw.scope_sha256)&&[raw.archive_file,raw.key_file,raw.scope_file].every(absolute)
    &&(raw.store_id===null||uuid(raw.store_id))&&inodeValue(raw.root)&&inodeValue(raw.parent)&&inodeValue(raw.runtime_parent)&&same(root,raw.root)&&same(parent,raw.parent)&&typeof raw.scope_bytes==='string'&&raw.scope_bytes.length<=90000&&Array.isArray(raw.targets)&&raw.targets.length>=6&&raw.targets.length<=10,'RESTORE_INTENT_INVALID');
  const scopeBytes=Buffer.from(raw.scope_bytes,'base64');requireHost(scopeBytes.toString('base64')===raw.scope_bytes&&backupHash(scopeBytes)===raw.scope_sha256,'RESTORE_INTENT_INVALID');const scope=parseRestoreScope(scopeBytes);requireHost(canonical(scope)===canonical(raw.scope),'RESTORE_INTENT_INVALID');
  const names=new Set<string>();for(const t of raw.targets){requireHost(record(t)&&Object.keys(t).every(k=>['role','path','bytes','sha256','static','parent','reuse'].includes(k))&&typeof t.role==='string'&&ordinaryRoles.includes(t.role)&&!names.has(t.role)&&absolute(t.path)&&Number.isSafeInteger(t.bytes)&&Number(t.bytes)>=1&&Number(t.bytes)<=MAX_BACKUP_RECORD_BYTES&&hash(t.sha256)&&t.static===staticRole(t.role)&&(t.parent===undefined||inodeValue(t.parent))&&(t.reuse===undefined||t.static===true&&inodeValue(t.reuse)),'RESTORE_INTENT_INVALID');names.add(t.role);}
  for(const name of ['config','registry','initial-prompt','ledger','manifest','native'])requireHost(names.has(name),'RESTORE_INTENT_INVALID');
  const expected:Record<string,string|undefined>={config:scope.config,registry:scope.registry,'initial-prompt':scope.initial_prompt,'system-prompt':scope.system_prompt,ledger:join(scope.data_dir,'ledger.sqlite'),manifest:join(scope.data_dir,'manifest.json'),'source-pump':join(scope.data_dir,'source-pump.json'),initializing:join(scope.data_dir,'initializing.json'),'device-authority':scope.device_authority};
  for(const t of raw.targets as unknown as TargetSpec[]){if(t.role==='native')requireHost(dirname(t.path)===join(scope.data_dir,'native')&&basename(t.path).endsWith(`_${raw.native_id}.jsonl`),'RESTORE_INTENT_INVALID');else requireHost(t.path===expected[t.role],'RESTORE_INTENT_INVALID');}
  requireHost(names.has('device-authority')===(scope.device_authority!==undefined)&&names.has('system-prompt')===(scope.system_prompt!==undefined)&&(raw.store_id!==null)===(scope.device_authority!==undefined),'RESTORE_INTENT_INVALID');
  const result=raw as unknown as Intent;verifyParents(result);return result;
}
function verifyParents(meta:Intent):void{
  requireHost(same(privateDir(dirname(meta.scope.data_dir)),meta.runtime_parent),'RESTORE_PARENT_CHANGED');
  for(const t of meta.targets)if(t.parent){noSymlinks(dirname(t.path));const p=lstatSync(dirname(t.path));requireHost(p.isDirectory()&&p.uid===process.getuid?.()&&(p.mode&0o022)===0&&same(p,t.parent),'RESTORE_PARENT_CHANGED');}
}
function verifyStatic(t:TargetSpec):void{
  const s=lstatSync(t.path);requireHost(t.reuse&&same(s,t.reuse)&&s.isFile()&&s.uid===process.getuid?.()&&(s.mode&0o777)===0o600&&s.nlink===1,'RESTORE_STATIC_CHANGED');requireHost(backupHash(readBackupFile(t.path,t.bytes).bytes)===t.sha256,'RESTORE_STATIC_CHANGED');
}
function spec(t:RestoreTarget):TargetSpec{
  const p=stat(dirname(t.path));if(p)requireHost(p.isDirectory()&&p.uid===process.getuid?.()&&(p.mode&0o022)===0,'RESTORE_PRIVATE_PARENT_REQUIRED');
  const base={role:t.role,path:t.path,bytes:t.bytes.length,sha256:backupHash(t.bytes),static:t.static,...(p?{parent:identify(p)}:{})};const s=stat(t.path);
  if(!s)return base;requireHost(t.static&&s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid?.()&&(s.mode&0o777)===0o600&&s.nlink===1,'RESTORE_TARGET_CONFLICT');requireHost(readBackupFile(t.path,t.bytes.length).bytes.equals(t.bytes),'RESTORE_STATIC_CHANGED');return{...base,reuse:identify(s)};
}
function noSidecars(meta:{scope:RestoreScope}):void{for(const path of [join(meta.scope.data_dir,'ledger.sqlite'),meta.scope.device_authority].filter((p):p is string=>p!==undefined))for(const suffix of ['-wal','-shm','-journal'])requireHost(!stat(path+suffix),'RESTORE_TARGET_SIDECAR_CONFLICT');}
function payloads(material:BackupMaterial,targets:RestoreTarget[],fence:RecoveryFence,storeId?:string):Map<RestoreRole,Buffer>{
  const scratch=mkdtempSync(join(tmpdir(),'notifier-restore-image-'));chmodSync(scratch,0o700);const map=new Map(targets.map(t=>[t.role,t.bytes]));
  for(const role of ['ledger','device-authority']as const){const bytes=map.get(role);if(!bytes)continue;const path=join(scratch,role+'.sqlite');writeBackupFileExclusive(path,bytes);map.set(role,freezeDerivedImageFile(path,role,fence,storeId));}
  requireHost([...map.values()].reduce((n,b)=>n+b.length,0)<=MAX_BACKUP_RECORD_BYTES,'RESTORE_MATERIAL_TOO_LARGE');return map;
}
function validateInputs(material:BackupMaterial,input:RestoreInputs,targets:RestoreTarget[]):void{
  requireHost(input.writersQuiesced===true&&process.platform!=='win32','RESTORE_WRITERS_MUST_BE_QUIESCED');for(const p of [input.archive,input.keyFile,input.scopeFile,input.intent])requireHost(absolute(p),'RESTORE_INPUT_INVALID');
  assertBackupOutputSeparation(material,input.intent);assertRestoreReferenceSeparation(material,[input.archive,input.keyFile,input.scopeFile,input.intent]);
  const incoming=[input.archive,input.keyFile,input.scopeFile,input.intent];for(let i=0;i<incoming.length;i++)for(let j=0;j<i;j++){const a=incoming[i]!,b=incoming[j]!;const as=stat(a),bs=stat(b);requireHost(a!==b&&(!as||!bs||as.dev!==bs.dev||as.ino!==bs.ino),'RESTORE_INPUT_OVERLAP');}
  for(const t of targets)for(const p of incoming)requireHost(p!==t.path&&!p.startsWith(t.path+'.')&&!p.startsWith(t.path+'-')&&!t.path.startsWith(input.intent+'/'),'RESTORE_INPUT_OVERLAP');
}
function verifyInstalled(path:string,meta:Intent):number{
  let count=0;for(const t of meta.targets){if(t.reuse)verifyStatic(t);else verifyRestoreReservation(path,meta.restore_id,t.role,t.path,t);count++;}
  const m=marker(meta);verifyRestoreFile(path,meta.restore_id,'ledger-pending',recoveryPendingPath(join(meta.scope.data_dir,'ledger.sqlite')),m);
  if(meta.scope.device_authority)verifyRestoreFile(path,meta.restore_id,'authority-pending',recoveryPendingPath(meta.scope.device_authority),m);
  const fence:RecoveryFence={restore_id:meta.restore_id,snapshot_id:meta.snapshot_id,archive_sha256:meta.archive_sha256,scope_sha256:meta.scope_sha256};
  withReadOnlyBackupImage(join(meta.scope.data_dir,'ledger.sqlite'),db=>assertFrozenLedger(db,fence));if(meta.scope.device_authority)withReadOnlyBackupImage(meta.scope.device_authority,db=>assertFrozenAuthority(db,meta.store_id!,fence));noSidecars(meta);return count;
}

/** Archive has already authenticated and passed T012/F1 semantics. No runtime/Agent/SDK open or external reference content. */
export async function installFrozenBackup(material:BackupMaterial,archiveSha256:string,scopeBytes:Buffer,input:RestoreInputs,checkpoint:()=>Promise<void>):Promise<object>{
  let release:(()=>void)|undefined;
  try{
    const resolved=resolveRestoreScope(material,scopeBytes);validateInputs(material,input,resolved.targets);assertBackupOutputSeparation(material,resolve(tmpdir()));
    let meta:Intent|undefined=stat(input.intent)?readIntent(input.intent):undefined;
    if(meta)requireHost(meta.archive_sha256===archiveSha256&&meta.snapshot_id===material.metadata.snapshot_id&&meta.native_id===material.metadata.native_id&&meta.scope_sha256===resolved.scope_sha256&&meta.archive_file===input.archive&&meta.key_file===input.keyFile&&meta.scope_file===input.scopeFile&&canonical(meta.scope)===canonical(resolved.scope),'RESTORE_INTENT_CHANGED');
    const fence:RecoveryFence={restore_id:meta?.restore_id??randomUUID(),snapshot_id:material.metadata.snapshot_id,archive_sha256:archiveSha256,scope_sha256:resolved.scope_sha256};
    const content=payloads(material,resolved.targets,fence,resolved.store_id);
    if(!meta){
      noSidecars({scope:resolved.scope});const specs=resolved.targets.map(t=>spec({...t,bytes:content.get(t.role)!}));for(const path of [recoveryPendingPath(join(resolved.scope.data_dir,'ledger.sqlite')),...(resolved.scope.device_authority?[recoveryPendingPath(resolved.scope.device_authority)]:[])])requireHost(!stat(path),'RESTORE_TARGET_CONFLICT');
      const p=privateDir(dirname(input.intent));mkdirSync(input.intent,{mode:0o700});const root=privateDir(input.intent);meta={format:1,restore_id:fence.restore_id,snapshot_id:fence.snapshot_id,archive_sha256:archiveSha256,scope_sha256:fence.scope_sha256,archive_file:input.archive,key_file:input.keyFile,scope_file:input.scopeFile,scope_bytes:scopeBytes.toString('base64'),scope:resolved.scope,native_id:material.metadata.native_id,store_id:resolved.store_id??null,root:identify(root),parent:identify(p),runtime_parent:identify(privateDir(dirname(resolved.scope.data_dir))),targets:specs};writeBackupFileExclusive(metaPath(input.intent),Buffer.from(JSON.stringify(meta)+'\n'));
      ensureRestoreDirectory(input.intent); // includes the exact parent barrier for its new directory entry
    }
    confirmRestoreControlFile(metaPath(input.intent),Buffer.from(JSON.stringify(meta)+'\n'));ensureRestoreDirectory(input.intent);
    for(const t of meta.targets){const bytes=content.get(t.role);requireHost(bytes&&bytes.length===t.bytes&&backupHash(bytes)===t.sha256,'RESTORE_INTENT_CHANGED');if(t.reuse)verifyStatic(t);}
    const active=meta;const step=async()=>{await checkpoint();requireHost(canonical(readIntent(input.intent))===canonical(active),'RESTORE_INTENT_CHANGED');
      const known:[RestoreRole,string][]=[...active.targets.map(t=>[t.role,t.path]as[RestoreRole,string]),['ledger-pending',recoveryPendingPath(join(active.scope.data_dir,'ledger.sqlite'))],...(active.scope.device_authority?[['authority-pending',recoveryPendingPath(active.scope.device_authority)]as[RestoreRole,string]]:[]),['completion',completePath(input.intent)]];
      for(const [role,path]of known)if(stat(join(input.intent,`FILE-${role}.json`)))assertRestoreReservedParent(input.intent,active.restore_id,role,path);
    };
    await step();noSidecars(meta);ensureRestoreDirectory(meta.scope.data_dir);release=acquireOwnerLock(meta.scope.data_dir);
    publishRestoreFile(input.intent,meta.restore_id,'ledger-pending',recoveryPendingPath(join(meta.scope.data_dir,'ledger.sqlite')),marker(meta));
    if(meta.scope.device_authority)publishRestoreFile(input.intent,meta.restore_id,'authority-pending',recoveryPendingPath(meta.scope.device_authority),marker(meta));await step();
    for(const role of ['ledger','device-authority']as const){const t=meta.targets.find(t=>t.role===role);if(t)publishRestoreFile(input.intent,meta.restore_id,role,t.path,content.get(role)!);await step();}
    for(const name of ['agent','work','native'])ensureRestoreDirectory(join(meta.scope.data_dir,name));
    const ordinary=meta.targets.filter(t=>t.role!=='ledger'&&t.role!=='device-authority').sort((a,b)=>(a.role==='native'?-1:b.role==='native'?1:0));
    for(const t of ordinary){if(!t.reuse)publishRestoreFile(input.intent,meta.restore_id,t.role,t.path,content.get(t.role)!);else verifyStatic(t);await step();}
    verifyInstalled(input.intent,meta);await step();publishRestoreFile(input.intent,meta.restore_id,'completion',completePath(input.intent),complete(meta));await step();
    // Final success is decided AFTER the last yield/publication barrier, not from the earlier pre-completion scan.
    const installed=verifyInstalled(input.intent,meta);verifyRestoreFile(input.intent,meta.restore_id,'completion',completePath(input.intent),complete(meta));
    return{state:'frozen_install_complete',restore_id:meta.restore_id,snapshot_id:meta.snapshot_id,installed_records:installed,...flags};
  }catch(error){if(error instanceof HostError)throw error;throw new HostError('RESTORE_INSTALL_UNAVAILABLE');}
  finally{release?.();}
}

/** Operator intent is the original explicit scope. Never opens its archive/key/model references or any SDK/runtime. */
export function frozenRestoreStatus(path:string):object{
  try{requireHost(absolute(path),'RESTORE_INPUT_INVALID');const meta=readIntent(path);let installed=0;const failures:string[]=[];
    for(const t of meta.targets)try{if(t.reuse)verifyStatic(t);else verifyRestoreReservation(path,meta.restore_id,t.role,t.path,t);installed++;}catch{failures.push(t.role);}
    let completeObserved=false;if(!failures.length)try{verifyInstalled(path,meta);verifyRestoreFile(path,meta.restore_id,'completion',completePath(path),complete(meta));completeObserved=true;}catch{failures.push('fence_or_completion');}
    return{state:completeObserved?'frozen_install_observed_complete':'frozen_install_incomplete',restore_id:meta.restore_id,snapshot_id:meta.snapshot_id,installed_records:installed,expected_records:meta.targets.length,incomplete_roles:failures,...flags};
  }catch(error){if(error instanceof HostError)throw error;throw new HostError('RESTORE_STATUS_UNAVAILABLE');}
}
