import {isAbsolute,join,resolve} from 'node:path';
import {lstatSync} from 'node:fs';
import {assertNoRecoveryFile} from 'notification-server/recovery-gate';
import {privateJson,record,requireHost} from './private-files.js';

/** Caller supplied config only, before loadConfig can follow identity/model references. Never follows a path read from a recovery marker. */
export function assertConfigNotRecovering(configFile:string):void{
  const raw=privateJson(configFile,65536);
  if(record(raw)&&typeof raw.data_dir==='string'&&isAbsolute(raw.data_dir)&&resolve(raw.data_dir)===raw.data_dir){
    const ledger=join(raw.data_dir,'ledger.sqlite');
    const stat=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
    const target=stat(ledger);const refs=record(raw.identity_reference)?raw.identity_reference:undefined;
    const protectedPaths=[join(raw.data_dir,'agent/auth.json'),join(raw.data_dir,'agent/models.json'),join(raw.data_dir,'agent/models-store.json'),refs?.persona_file,refs?.settings_file,refs?.credentials_file,record(raw.push)?raw.push.token_file:undefined];
    for(const path of protectedPaths)if(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path){const other=stat(path);requireHost(path!==ledger&&(!target||!other||target.dev!==other.dev||target.ino!==other.ino),'RECOVERY_EXTERNAL_REFERENCE_OVERLAP');}
    assertNoRecoveryFile(ledger);
  }
}
