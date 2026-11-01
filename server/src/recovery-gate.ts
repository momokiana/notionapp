import {lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import Database from 'better-sqlite3';
import {ApiError} from './auth.js';

export const FROZEN_LEDGER_VERSION=4;
export const FROZEN_AUTHORITY_VERSION=2;
export const recoveryPendingPath=(path:string)=>resolve(path)+'.restore-pending';
const fail=(code:string):never=>{throw new ApiError(503,code,'Recovery data is not executable; preserve the original installation intent');};

/** Deterministic per-database marker. Its contents/paths never authorize IO; even a damaged marker closes admission. */
export function assertNoRecoveryPending(path:string):void{
  if(path===':memory:'||path==='')return;
  try{lstatSync(recoveryPendingPath(path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;fail('RESTORE_GATE_UNAVAILABLE');}
  fail('RESTORE_PENDING');
}

/** Call before mutation, idempotent early return, or external/native effects. No initializer, writable pragma or repair. */
export function assertNoRecovery(db:Database.Database):void{
  assertNoRecoveryPending(db.name);
  const app=db.pragma('application_id',{simple:true});const version=db.pragma('user_version',{simple:true});
  if((app===0x4e4f5449&&version===FROZEN_LEDGER_VERSION)||(app===0x4e444156&&version===FROZEN_AUTHORITY_VERSION)
    ||db.prepare("SELECT 1 FROM sqlite_schema WHERE name='restore_fence'").get())fail('RESTORE_FROZEN');
}

/** Original caller-designated path only. Probe before mkdir/openDatabase could establish WAL or a new empty store. */
export function assertNoRecoveryFile(path:string):void{
  assertNoRecoveryPending(path);if(path===':memory:'||path==='')return;
  try{const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink())fail('RESTORE_GATE_UNAVAILABLE');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;if(error instanceof ApiError)throw error;fail('RESTORE_GATE_UNAVAILABLE');}
  let probe:Database.Database|undefined;
  try{probe=new Database(path,{readonly:true,fileMustExist:true});assertNoRecovery(probe);}
  finally{probe?.close();} // Preserve original SQLite failure semantics without a writable probe or repair.
}
