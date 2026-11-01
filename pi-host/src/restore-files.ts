import {constants,closeSync,fsyncSync,fstatSync,lstatSync,openSync,readSync,writeSync,linkSync,existsSync,mkdirSync,type Stats} from 'node:fs';
import {dirname,join} from 'node:path';
import {backupHash,MAX_BACKUP_RECORD_BYTES} from './backup-format.js';
import {readBackupFile,writeBackupFileExclusive} from './backup-files.js';
import {canonical,HostError,noSymlinks,record,requireHost} from './private-files.js';

export const restoreRoles=['ledger-pending','authority-pending','ledger','device-authority','config','registry','initial-prompt','system-prompt','manifest','native','source-pump','initializing','completion']as const;
export type RestoreRole=typeof restoreRoles[number];
interface Inode {dev:number;ino:number}
export interface RestoreReservation {format:1;restore_id:string;role:RestoreRole;target:string;prepared:string;bytes:number;sha256:string;parent:Inode;file:Inode}
const same=(a:Inode,b:Inode)=>a.dev===b.dev&&a.ino===b.ino;
const identity=(s:Stats):Inode=>({dev:s.dev,ino:s.ino});
function parent(path:string):Stats{noSymlinks(path);const s=lstatSync(path);requireHost(s.isDirectory()&&s.uid===process.getuid?.()&&(s.mode&0o777)===0o700,'RESTORE_PRIVATE_PARENT_REQUIRED');return s;}
function safeFile(s:Stats){requireHost(s.isFile()&&s.uid===process.getuid?.()&&(s.mode&0o777)===0o600&&!s.isSymbolicLink(),'RESTORE_PREPARED_INVALID');}
const pathFor=(target:string,id:string,role:RestoreRole)=>join(dirname(target),`.notifier-restore-${id}-${role}.prepared`);
function metadata(path:string):RestoreReservation{
  const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBackupFile(path,16384).bytes));
  requireHost(record(raw)&&Object.keys(raw).sort().join(',')==='bytes,file,format,parent,prepared,restore_id,role,sha256,target'&&raw.format===1
    &&record(raw.parent)&&record(raw.file)&&Object.keys(raw.parent).sort().join(',')==='dev,ino'&&Object.keys(raw.file).sort().join(',')==='dev,ino'
    &&[raw.parent.dev,raw.parent.ino,raw.file.dev,raw.file.ino].every(n=>Number.isSafeInteger(n)&&Number(n)>=0),'RESTORE_RESERVATION_INVALID');
  return raw as unknown as RestoreReservation;
}

export function confirmRestoreControlFile(path:string,expected:Buffer):void{
  let dirFd:number|undefined;let fd:number|undefined;
  try{const directory=dirname(path);const before=parent(directory);dirFd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);requireHost(same(before,fstatSync(dirFd)),'RESTORE_PARENT_CHANGED');
    const read=readBackupFile(path,Math.max(1,expected.length));requireHost(read.bytes.equals(expected),'RESTORE_RESERVATION_CHANGED');fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);requireHost(same(read,fstatSync(fd)),'RESTORE_RESERVATION_CHANGED');fsyncSync(fd);fsyncSync(dirFd);
    requireHost(same(before,parent(directory))&&same(read,lstatSync(path)),'RESTORE_RESERVATION_CHANGED');
  }finally{try{if(fd!==undefined)closeSync(fd);}finally{if(dirFd!==undefined)closeSync(dirFd);}}
}

/** Each prepared source lives on its target's filesystem; publication is an exclusive hard-link, never overwrite/rename.
 * The durable inode reservation precedes payload writes and publication. A create-before-reservation-ACK gap with no
 * readable reservation is conservatively refused, not guessed/recreated. Prepared aliases remain private and frozen;
 * they are NOT independent immutable backups, and a future enablement protocol must account for those aliases. */
export function publishRestoreFile(intentDir:string,restoreId:string,role:RestoreRole,target:string,bytes:Buffer):RestoreReservation{
  let parentFd:number|undefined;let fileFd:number|undefined;
  try{
    requireHost(process.platform!=='win32'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(restoreId)&&restoreRoles.includes(role)
      &&Buffer.isBuffer(bytes)&&bytes.length>=1&&bytes.length<=MAX_BACKUP_RECORD_BYTES,'RESTORE_INPUT_INVALID');
    parent(intentDir);noSymlinks(target);const directory=dirname(target);const before=parent(directory);parentFd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);requireHost(same(before,fstatSync(parentFd)),'RESTORE_PARENT_CHANGED');
    const prepared=pathFor(target,restoreId,role);const reservation=join(intentDir,`FILE-${role}.json`);const expected={format:1 as const,restore_id:restoreId,role,target,prepared,bytes:bytes.length,sha256:backupHash(bytes),parent:identity(before)};
    let owned:RestoreReservation;
    if(existsSync(reservation)){
      owned=metadata(reservation);const {file:oldFile,...prior}=owned;requireHost(canonical(prior)===canonical(expected),'RESTORE_RESERVATION_CHANGED');
      fileFd=openSync(prepared,constants.O_RDWR|constants.O_NOFOLLOW);requireHost(same(owned.file,fstatSync(fileFd)),'RESTORE_PREPARED_CHANGED');
    }else{
      try{fileFd=openSync(prepared,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);}
      catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new HostError('RESTORE_UNPROVEN_PREPARED_FILE');throw error;}
      const s=fstatSync(fileFd);safeFile(s);requireHost(s.nlink===1&&s.size===0,'RESTORE_PREPARED_INVALID');
      owned={...expected,file:identity(s)};writeBackupFileExclusive(reservation,Buffer.from(JSON.stringify(owned)+'\n'));
    }
    confirmRestoreControlFile(reservation,Buffer.from(JSON.stringify(owned)+'\n')); // Readable proof from a lost ACK must first regain its own file + held-parent barrier.
    const opened=fstatSync(fileFd);safeFile(opened);requireHost(opened.nlink>=1&&opened.nlink<=2&&opened.size<=bytes.length&&same(opened,lstatSync(prepared)),'RESTORE_PREPARED_CHANGED');
    const prefix=Buffer.alloc(opened.size);let read=0;
    while(read<prefix.length){const n=readSync(fileFd,prefix,read,prefix.length-read,read);requireHost(n>0,'RESTORE_PREPARED_CHANGED');read+=n;}
    requireHost(prefix.equals(bytes.subarray(0,prefix.length))&&(opened.nlink===1||opened.size===bytes.length),'RESTORE_PREPARED_CHANGED');
    let offset=opened.size;while(offset<bytes.length){const n=writeSync(fileFd,bytes,offset,bytes.length-offset,offset);requireHost(Number.isSafeInteger(n)&&n>0&&n<=bytes.length-offset,'RESTORE_SHORT_WRITE');offset+=n;}
    fsyncSync(fileFd);requireHost(same(before,parent(directory))&&same(opened,lstatSync(prepared))&&fstatSync(fileFd).size===bytes.length,'RESTORE_PREPARED_CHANGED');fsyncSync(parentFd);requireHost(readBackupFile(prepared,bytes.length).bytes.equals(bytes),'RESTORE_PREPARED_CHANGED');
    try{linkSync(prepared,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const installed=lstatSync(target);safeFile(installed);requireHost(same(installed,owned.file)&&installed.nlink===2&&installed.size===bytes.length,'RESTORE_TARGET_CONFLICT');
    fsyncSync(fileFd);fsyncSync(parentFd);requireHost(same(before,parent(directory))&&same(installed,lstatSync(target)),'RESTORE_PARENT_CHANGED');return owned;
  }catch(error){if(error instanceof HostError)throw error;throw new HostError('RESTORE_WRITE_UNAVAILABLE');}
  finally{try{if(fileFd!==undefined)closeSync(fileFd);}finally{if(parentFd!==undefined)closeSync(parentFd);}}
}

/** Read/verify only. Paths and expected hashes come from the original operator intent, never archive IO authority. */
export function verifyRestoreReservation(intentDir:string,restoreId:string,role:RestoreRole,target:string,expected:{bytes:number;sha256:string}):RestoreReservation{
  try{
    parent(intentDir);const owned=metadata(join(intentDir,`FILE-${role}.json`));const prepared=pathFor(target,restoreId,role);const directory=parent(dirname(target));const source=lstatSync(prepared);const installed=lstatSync(target);safeFile(source);safeFile(installed);
    requireHost(owned.restore_id===restoreId&&owned.role===role&&owned.target===target&&owned.prepared===prepared&&owned.bytes===expected.bytes&&owned.sha256===expected.sha256
      &&same(directory,owned.parent)&&same(source,owned.file)&&same(installed,owned.file)&&source.nlink===2&&installed.nlink===2,'RESTORE_TARGET_CONFLICT');
    requireHost(backupHash(readBackupFile(target,Math.max(1,expected.bytes)).bytes)===expected.sha256,'RESTORE_TARGET_CHANGED');return owned;
  }catch(error){if(error instanceof HostError)throw error;throw new HostError('RESTORE_VERIFY_UNAVAILABLE');}
}
export function verifyRestoreFile(intentDir:string,restoreId:string,role:RestoreRole,target:string,bytes:Buffer):RestoreReservation{
  return verifyRestoreReservation(intentDir,restoreId,role,target,{bytes:bytes.length,sha256:backupHash(bytes)});
}
/** Verify an already reserved parent before advancing another installation stage; no payload repair or blind metadata path IO. */
export function assertRestoreReservedParent(intentDir:string,restoreId:string,role:RestoreRole,target:string):void{
  const owned=metadata(join(intentDir,`FILE-${role}.json`));requireHost(owned.restore_id===restoreId&&owned.role===role&&owned.target===target&&owned.prepared===pathFor(target,restoreId,role)&&same(parent(dirname(target)),owned.parent),'RESTORE_PARENT_CHANGED');
}
/** Exact approved directory only, no recursive arbitrary extraction and no replacement of an existing resource. */
export function ensureRestoreDirectory(path:string):void{
  let fd:number|undefined;let dirFd:number|undefined;
  try{noSymlinks(path);const original=parent(dirname(path));fd=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);requireHost(same(original,fstatSync(fd)),'RESTORE_PARENT_CHANGED');
    try{mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const owned=parent(path);dirFd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);requireHost(same(owned,fstatSync(dirFd)),'RESTORE_PARENT_CHANGED');fsyncSync(dirFd);fsyncSync(fd);requireHost(same(original,parent(dirname(path)))&&same(owned,parent(path)),'RESTORE_PARENT_CHANGED');
  }catch(error){if(error instanceof HostError)throw error;throw new HostError('RESTORE_DIRECTORY_UNAVAILABLE');}
  finally{try{if(dirFd!==undefined)closeSync(dirFd);}finally{if(fd!==undefined)closeSync(fd);}}
}
