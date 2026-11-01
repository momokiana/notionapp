import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setImmediate } from 'node:timers/promises';
import { captureBackupMaterial } from './backup-capture.js';
import { backupHash, frameBackupMetadata, frameBackupRecord, MAX_BACKUP_ARCHIVE_BYTES, sealBackupArchive } from './backup-format.js';
import { createBackupStageRoot, readBackupFile, readBackupKey, writeBackupFileExclusive } from './backup-files.js';
import { assertBackupOutputSeparation, inspectBackupArchive } from './backup-validate.js';
import { HostError, noSymlinks, requireHost } from './private-files.js';

export const backupCommands = ['backup-create','backup-inspect','backup-stage'] as const;
const invalid = (): never => { throw new HostError('INVALID_BACKUP_ARGUMENTS'); };
const stageReadme = `INERT RECOVERY MATERIAL ONLY — NOT A RUNNABLE APP DIRECTORY.\nAll captured records use a non-JSON/non-SQLite/non-SDK frame. Do not strip it to bypass recovery gates.\nA verified old backup does not prove present credentials, permission, request allowance or absence of later external effects.\nNo active restore/thaw is implemented here. Retain original unknown IDs/bodies/targets; do not login with old credentials or replay actions to test recovery.\nExternal persona/settings/model authorization, agent profile/models files, transport token files, Android Keystore, operator invitation/handover intent files and arbitrary directory contents are NOT included.\nThose external materials must be separately preserved under their original authorization.\nA readable COMPLETE marker is not proof that an interrupted stage command acknowledged durable completion.\nPrivate verification scratch is retained separately; this tool never deletes original or failed material.\n`;

function newTarget(path: string) {
  noSymlinks(path);
  try { lstatSync(path); throw new HostError('BACKUP_OUTPUT_EXISTS'); }
  catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function stageMaterial(verified: ReturnType<typeof inspectBackupArchive>, archive: Buffer, path: string) {
  assertBackupOutputSeparation(verified.material,path);
  const root=createBackupStageRoot(path);
  try {
    const frames=verified.material.records.map(r=>({name:`${r.name}.material`,bytes:frameBackupRecord(r)}));
    frames.push({name:'SNAPSHOT-METADATA.material',bytes:frameBackupMetadata(verified.material.metadata)});
    const index=Buffer.from(JSON.stringify({format:1,state:'inert_material',archive_sha256:backupHash(archive),snapshot_id:verified.material.metadata.snapshot_id,
      records:frames.map(r=>({name:r.name,bytes:r.bytes.length,sha256:backupHash(r.bytes)})),active_restore_supported:false,current_permissions_verified:false})+'\n');
    writeBackupFileExclusive(join(path,'MATERIAL-INDEX.json'),index);
    writeBackupFileExclusive(join(path,'READ-BEFORE-USE.txt'),Buffer.from(stageReadme));
    for(const r of frames)writeBackupFileExclusive(join(path,r.name),r.bytes);
    writeBackupFileExclusive(join(path,'COMPLETE.json'),Buffer.from(JSON.stringify({format:1,index_sha256:backupHash(index),archive_sha256:backupHash(archive),active_restore_supported:false})+'\n'));
    root.finish();
    return {state:'backup_material_staged',archive_sha256:backupHash(archive),inspection:verified.inspection,active_restore_supported:false};
  } finally {root.close();}
}

/** Dedicated local operator CLI only. No endpoint, service control, automatic model grant or active restore. */
export async function runBackupCommand(args: string[]) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    const seen=new Set<string>();for(const value of args.slice(1))if(value.startsWith('--')){const flag=value.split('=',1)[0]!;if(seen.has(flag))invalid();seen.add(flag);}
    parsed=parseArgs({args,allowPositionals:true,options:{config:{type:'string'},out:{type:'string'},archive:{type:'string'},'out-dir':{type:'string'},'key-file':{type:'string'},'writers-quiesced':{type:'boolean'}}});
  } catch {return invalid();}
  const command=parsed.positionals[0];if(parsed.positionals.length!==1||!backupCommands.includes(command as typeof backupCommands[number]))invalid();
  const allowed=command==='backup-create'?['config','out','key-file','writers-quiesced']:command==='backup-inspect'?['archive','key-file']:['archive','key-file','out-dir'];
  if(Object.keys(parsed.values).some(k=>!allowed.includes(k)))invalid();
  const required=(name:string):string=>{const value=parsed.values[name];if(typeof value!=='string'||!value)invalid();return value as string;};
  if(command==='backup-create'&&parsed.values['writers-quiesced']!==true)invalid();
  const target=command==='backup-create'?required('out'):command==='backup-stage'?required('out-dir'):undefined;
  if(target)newTarget(target);
  const key=readBackupKey(required('key-file'));let interrupted=false;
  const stop=()=>{interrupted=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const checkpoint=async()=>{await setImmediate();requireHost(!interrupted,'BACKUP_INTERRUPTED');};
  try {
    await checkpoint();let result:unknown;
    if(command==='backup-create'){
      const material=await captureBackupMaterial(required('config'),true); assertBackupOutputSeparation(material,target!); await checkpoint();
      const archive=sealBackupArchive(material.metadata,material.records,key);
      const verified=inspectBackupArchive(archive,key);await checkpoint();
      const receipt=writeBackupFileExclusive(target!,archive);
      result={state:'backup_created',archive_sha256:receipt.sha256,bytes:receipt.bytes,inspection:verified.inspection,active_restore_supported:false};
    } else {
      const archive=readBackupFile(required('archive'),MAX_BACKUP_ARCHIVE_BYTES).bytes;
      const verified=inspectBackupArchive(archive,key);await checkpoint();
      result=command==='backup-stage'?stageMaterial(verified,archive,target!):{state:'backup_authenticated',archive_sha256:backupHash(archive),inspection:verified.inspection,original_create_durability_ack_verified:false};
    }
    await checkpoint();console.log(JSON.stringify(result));
  } finally {key.fill(0);process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
