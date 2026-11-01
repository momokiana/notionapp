import Database from 'better-sqlite3';
import {lstatSync}from'node:fs';
import {dirname,isAbsolute,resolve,parse,sep,join}from'node:path';
import {ApiError} from './auth.js';
import {APP_ID,ledgerDdl,commandDdl} from './schema.js';
import {notificationDdl} from './notifications.js';
import {deviceAuthorityDdl,assertDeviceBackupDatabase} from './device-store.js';
import {assertLedgerBackupDatabase,assertSnapshotCatalog} from './backup-validation.js';
import {serializeBackupDatabase} from './backup-snapshot.js';
import {FROZEN_LEDGER_VERSION,FROZEN_AUTHORITY_VERSION} from './recovery-gate.js';

export interface RecoveryFence {restore_id:string;snapshot_id:string;archive_sha256:string;scope_sha256:string}
export const recoveryFenceDdl="CREATE TABLE restore_fence (id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL CHECK(format=1), state TEXT NOT NULL CHECK(state='frozen'), restore_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, archive_sha256 TEXT NOT NULL, scope_sha256 TEXT NOT NULL)";
const legacyLedger=[...ledgerDdl,commandDdl,...notificationDdl];
const DEVICE_APP=0x4e444156;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const fail=():never=>{throw new ApiError(503,'RESTORE_FORMAT_INVALID','Frozen recovery material is invalid; no ordinary admission permitted');};
function validFence(value:RecoveryFence):void{
  if(!value||Object.keys(value).sort().join(',')!=='archive_sha256,restore_id,scope_sha256,snapshot_id'||!uuid.test(value.restore_id)||!uuid.test(value.snapshot_id)||!hash.test(value.archive_sha256)||!hash.test(value.scope_sha256))fail();
}
function fence(db:Database.Database,expected?:RecoveryFence):RecoveryFence{
  const rows=db.prepare('SELECT * FROM restore_fence').all()as({id:number;format:number;state:string}&RecoveryFence)[];
  const row=rows[0];if(rows.length!==1||!row||row.id!==1||row.format!==1||row.state!=='frozen')return fail();
  const result={restore_id:row.restore_id,snapshot_id:row.snapshot_id,archive_sha256:row.archive_sha256,scope_sha256:row.scope_sha256};validFence(result);
  if(expected){validFence(expected);for(const key of Object.keys(result)as(keyof RecoveryFence)[])if(result[key]!==expected[key])fail();}
  return result;
}
/** Historical/frozen read only: no initializer, constructor, IO path, writable pragma, SDK or authority acceptance. */
export function assertFrozenLedger(db:Database.Database,expected?:RecoveryFence):RecoveryFence{
  assertSnapshotCatalog(db,[...legacyLedger,recoveryFenceDdl],APP_ID,FROZEN_LEDGER_VERSION);return fence(db,expected);
}
export function assertFrozenAuthority(db:Database.Database,storeId:string,expected?:RecoveryFence):RecoveryFence{
  assertSnapshotCatalog(db,[...deviceAuthorityDdl,recoveryFenceDdl],DEVICE_APP,FROZEN_AUTHORITY_VERSION);
  const rows=db.prepare('SELECT id,version FROM authority').all()as{id:string;version:number}[];
  if(!uuid.test(storeId)||rows.length!==1||rows[0]?.id!==storeId||rows[0]?.version!==1)fail();return fence(db,expected);
}
function tableNames(ddl:readonly string[]):string[]{return ddl.map(sql=>{const name=/^CREATE TABLE ([a-z_]+) \(/.exec(sql)?.[1];if(!name)return fail();return name;});}
function originalRows(db:Database.Database,ddl:readonly string[]):string{
  const names=tableNames(ddl);if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get())names.push('sqlite_sequence');
  return JSON.stringify(names.map(name=>[name,db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]));
}
function convertDerived(db:Database.Database,ddl:readonly string[],version:number,value:RecoveryFence,validate:()=>void,validateFrozen:()=>void):Buffer{
  validFence(value);if(db.inTransaction)fail();validate();const before=originalRows(db,ddl);
  // Only a new private DERIVED handle may be supplied by the installer. Never operate on an original/live database.
  // A standalone DELETE-mode frozen image has no WAL dependency and its read-only status probe need not create SHM.
  if(db.pragma('journal_mode=DELETE',{simple:true})!=='delete'&&db.pragma('journal_mode',{simple:true})!=='memory')fail();
  db.pragma('synchronous=FULL');
  return db.transaction(()=>{
    db.exec(recoveryFenceDdl);db.prepare("INSERT INTO restore_fence VALUES(1,1,'frozen',?,?,?,?)").run(value.restore_id,value.snapshot_id,value.archive_sha256,value.scope_sha256);db.pragma(`user_version=${version}`);
    validateFrozen();if(originalRows(db,ddl)!==before)fail();const image=serializeBackupDatabase(db);if(image[18]!==1||image[19]!==1)fail();return image;
  }).immediate();
}
/** Trusted fixed DDL conversion of a caller-created private derived image only. Original business/internal-sequence rows stay exact. */
export function freezeDerivedLedger(db:Database.Database,value:RecoveryFence):Buffer{
  return convertDerived(db,legacyLedger,FROZEN_LEDGER_VERSION,value,()=>assertLedgerBackupDatabase(db),()=>{assertFrozenLedger(db,value);});
}
export function freezeDerivedAuthority(db:Database.Database,storeId:string,value:RecoveryFence):Buffer{
  return convertDerived(db,deviceAuthorityDdl,FROZEN_AUTHORITY_VERSION,value,()=>assertDeviceBackupDatabase(db,storeId),()=>{assertFrozenAuthority(db,storeId,value);});
}
/** Caller-created private scratch images only; not an alternate live openDatabase/ignore-fence interface. */
export function freezeDerivedImageFile(path:string,kind:'ledger'|'device-authority',value:RecoveryFence,storeId?:string):Buffer{
  if(!isAbsolute(path)||resolve(path)!==path)fail();let at=parse(path).root;for(const part of path.slice(at.length).split(sep)){at=join(at,part);if(lstatSync(at).isSymbolicLink())fail();}
  const parent=lstatSync(dirname(path)),before=lstatSync(path);if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o777)!==0o700||!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.nlink!==1)fail();
  const db=new Database(path,{fileMustExist:true});try{const bytes=kind==='ledger'?freezeDerivedLedger(db,value):freezeDerivedAuthority(db,storeId??'',value);const after=lstatSync(path);if(after.dev!==before.dev||after.ino!==before.ino)fail();return bytes;}finally{db.close();}
}
