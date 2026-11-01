import {isAbsolute,resolve,join}from'node:path';
import {setImmediate}from'node:timers/promises';
import{backupHash,MAX_BACKUP_ARCHIVE_BYTES}from'./backup-format.js';
import{readBackupFile,readBackupKey}from'./backup-files.js';
import{inspectBackupArchive}from'./backup-validate.js';
import{assertRestoreReferenceSeparation}from'./restore-scope.js';
import{installFrozenBackup,frozenRestoreStatus}from'./restore-install.js';
import{HostError,requireHost,record}from'./private-files.js';
export const restoreCommands=['restore-install','restore-status']as const;
const invalid=():never=>{throw new HostError('INVALID_RESTORE_ARGUMENTS');};
export async function runRestoreCommand(args:string[]):Promise<void>{
  const command=args[0];if(!restoreCommands.includes(command as typeof restoreCommands[number]))return invalid();const allowed=command==='restore-install'?['--archive','--key-file','--scope-file','--intent','--writers-quiesced']:['--intent'];const flags=new Map<string,string|true>();
  for(let i=1;i<args.length;i++){const flag=args[i]!;if(!allowed.includes(flag)||flags.has(flag))return invalid();if(flag==='--writers-quiesced')flags.set(flag,true);else{const value=args[++i];if(!value||!isAbsolute(value)||resolve(value)!==value||/[\u0000-\u001f\u007f]/u.test(value))return invalid();flags.set(flag,value);}}
  if(flags.size!==allowed.length||!allowed.every(f=>flags.has(f)))return invalid();
  let interrupted=false;const signal=()=>{interrupted=true;};const checkpoint=async()=>{await setImmediate();requireHost(!interrupted,'RESTORE_INTERRUPTED');};let key:Buffer|undefined;
  process.once('SIGINT',signal);process.once('SIGTERM',signal);
  try{
    let result:object;if(command==='restore-status'){await checkpoint();result=frozenRestoreStatus(flags.get('--intent')as string);}
    else{const archivePath=flags.get('--archive')as string,keyFile=flags.get('--key-file')as string,scopeFile=flags.get('--scope-file')as string,intent=flags.get('--intent')as string;
      key=readBackupKey(keyFile);const archive=readBackupFile(archivePath,MAX_BACKUP_ARCHIVE_BYTES).bytes;const {material}=inspectBackupArchive(archive,key);
      assertRestoreReferenceSeparation(material,[archivePath,keyFile,scopeFile,intent]);const scope=readBackupFile(scopeFile,65536).bytes;await checkpoint();
      result=await installFrozenBackup(material,backupHash(archive),scope,{archive:archivePath,keyFile,scopeFile,intent,writersQuiesced:flags.get('--writers-quiesced')===true},checkpoint);
      const intentProof=readBackupFile(join(intent,'INTENT.json'),256*1024).bytes;
      await checkpoint();requireHost(readBackupFile(join(intent,'INTENT.json'),256*1024).bytes.equals(intentProof),'RESTORE_INTENT_CHANGED');const current=frozenRestoreStatus(intent);
      requireHost(record(result)&&record(current)&&current.state==='frozen_install_observed_complete'&&current.restore_id===result.restore_id&&current.snapshot_id===result.snapshot_id,'RESTORE_COMPLETION_CHANGED');
    }
    // No further asynchronous boundary between the final bounded observation and stdout.
    console.log(JSON.stringify(result));
  }finally{key?.fill(0);process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
}
