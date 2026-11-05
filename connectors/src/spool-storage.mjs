import { openSync, closeSync, writeSync, fsyncSync, renameSync, unlinkSync, lstatSync, fstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonical, config, fail, hash, object, privateStat, readPrivate, spoolBinding } from './validation.mjs';

export const LARGE_FILE_BYTES = 256 * 1024 * 1024;
export const sameIdentity = (a,b) => a.dev === b.dev && a.ino === b.ino;
/** This bounded private envelope permits a bounded open, NOT SQL authenticity or execution. */
export function readStorage(input, mainStat) {
  const c=config(input), path=`${c.spool}.storage`;let stat;
  try { stat=lstatSync(path); } catch(e) { if(e.code==='ENOENT')return null;throw e; }
  privateStat(stat);let value;
  try { value=JSON.parse(readPrivate(path,4096));object(value,['format','state','device','inode','binding']); }
  catch { fail('INVALID_STORAGE_MARKER'); }
  if(value.format!==2 || !['upgrading','ready'].includes(value.state) || !Number.isSafeInteger(value.device) || !Number.isSafeInteger(value.inode) || typeof value.binding!=='string' || !/^[a-f0-9]{64}$/.test(value.binding))fail('INVALID_STORAGE_MARKER');
  if(value.binding!==hash(spoolBinding(c)))fail('SPOOL_BINDING_MISMATCH');
  if(value.device!==mainStat.dev || value.inode!==mainStat.ino)fail('SPOOL_PATH_CHANGED');
  const after=lstatSync(path);privateStat(after);if(!sameIdentity(stat,after))fail('SPOOL_PATH_CHANGED');
  return {value,stat:after};
}
export function verifyStorage(version, storage, {writing=false,maintenance=false}={}) {
  if((version===2&&!storage)||(storage?.value.state==='ready'&&version!==2))fail('INVALID_STORAGE_MARKER');
  if(writing&&storage?.value.state==='upgrading'&&!maintenance)fail('UPGRADE_REQUIRED');
}
export function writeStorage(spool,state) {
  const path=`${spool.path}.storage`,before=readStorage(spool.c,spool.fileStat);
  if(Boolean(before)!==Boolean(spool.storage) || (before&&!sameIdentity(before.stat,spool.storage.stat)))fail('SPOOL_PATH_CHANGED');
  const value={format:2,state,device:spool.fileStat.dev,inode:spool.fileStat.ino,binding:hash(spoolBinding(spool.c))};
  const temp=`${path}.${randomUUID()}.tmp`;let fd,owned,renamed=false,primary;
  try {
    fd=openSync(temp,'wx',0o600);owned=fstatSync(fd);writeSync(fd,canonical(value));fsyncSync(fd);
    spool.maintenanceHook?.(`${state}_synced`);
    const current=readStorage(spool.c,spool.fileStat);
    if(Boolean(current)!==Boolean(before)||(before&&!sameIdentity(current.stat,before.stat)))fail('SPOOL_PATH_CHANGED');
    renameSync(temp,path);renamed=true;spool.maintenanceHook?.(`${state}_renamed`);
    spool.syncDirectory(spool.path);
    spool.storage=readStorage(spool.c,spool.fileStat);spool.fileLimit=LARGE_FILE_BYTES;
    spool.maintenanceHook?.(`${state}_durable`);
  } catch(e) { primary=e;throw e; } finally {
    if(fd!==undefined){try{closeSync(fd);}catch(e){if(!primary)throw e;}}
    if(!renamed&&owned){try{if(sameIdentity(lstatSync(temp),owned))unlinkSync(temp);}catch{}}
  }
}
