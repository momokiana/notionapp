import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import Database from 'better-sqlite3';
import {openDatabase} from '../src/database.js';
import {CoreStore} from '../src/core.js';
import {DeviceStore} from '../src/device-store.js';
import {assertLedgerBackupDatabase,withReadOnlyBackupImage} from '../src/backup-validation.js';
import {freezeDerivedLedger,freezeDerivedAuthority,assertFrozenLedger,assertFrozenAuthority,type RecoveryFence} from '../src/recovery-format.js';
import {credentials,eventInput,NOW} from './helpers.js';
import {parseRegistry} from '../src/auth.js';
const directory=()=>mkdtempSync(join(tmpdir(),'notifier-recovery-format-'));
const metadata=():RecoveryFence=>({restore_id:randomUUID(),snapshot_id:randomUUID(),archive_sha256:randomBytes(32).toString('hex'),scope_sha256:randomBytes(32).toString('hex')});

test('derived ledger conversion preserves original rows/sequence/binding, returns a strict standalone frozen image, and leaves the original WAL source unchanged',()=>{
  const root=directory();const source=join(root,'source.sqlite');const db=openDatabase(source);let original:Buffer;
  try{const core=new CoreStore(db,()=>NOW);const r=parseRegistry(credentials());core.create(r.source('owner','source','epoch_1')!,eventInput());db.prepare("INSERT INTO operations VALUES('original-binding','native-id','original-digest','original-result')").run();db.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='events'").run();original=db.serialize();}finally{db.close();}
  assert.equal(original![18],2);const sourceBefore=readFileSync(source);const derived=join(root,'derived.sqlite');writeFileSync(derived,original!,{mode:0o600});const handle=new Database(derived);const fence=metadata();let image:Buffer;
  try{image=freezeDerivedLedger(handle,fence);assert.equal(handle.pragma('user_version',{simple:true}),4);}finally{handle.close();}
  assert.deepEqual(readFileSync(source),sourceBefore);assert.equal(image![18],1);assert.equal(image![19],1);const out=join(root,'frozen.sqlite');writeFileSync(out,image!,{mode:0o600});const before=readFileSync(out);
  withReadOnlyBackupImage(out,read=>{assert.deepEqual(assertFrozenLedger(read,fence),fence);assert.deepEqual(read.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get(),{seq:100});assert.deepEqual(read.prepare("SELECT result FROM operations WHERE scope='original-binding'").get(),{result:'original-result'});assert.throws(()=>assertLedgerBackupDatabase(read));});
  assert.throws(()=>openDatabase(out));assert.deepEqual(readFileSync(out),before);assert.equal(existsSync(out+'-wal'),false);assert.equal(existsSync(out+'-shm'),false);
});
test('derived authority v2 keeps original store UUID/logical version/operations and is not adopted by ordinary DeviceStore',()=>{
  const root=directory();const path=join(root,'source-authority.sqlite');const initial=DeviceStore.initialize(path);const store=new DeviceStore(path,initial.store_id,()=>NOW);try{store.createInvitation('operator',{request_id:randomUUID(),invitation_id:randomUUID(),secret:randomBytes(32).toString('hex'),owner_id:'format-fixture',label:'Historical invitation',manage_devices:false,expires_at:NOW+60000});}finally{store.close();}const original=readFileSync(path);const derived=join(root,'derived.sqlite');writeFileSync(derived,original,{mode:0o600});const db=new Database(derived);const fence=metadata();let image:Buffer;
  try{image=freezeDerivedAuthority(db,initial.store_id,fence);assert.equal(db.pragma('user_version',{simple:true}),2);assert.deepEqual(db.prepare('SELECT * FROM authority').get(),{id:initial.store_id,version:1});}finally{db.close();}
  assert.deepEqual(readFileSync(path),original);const out=join(root,'frozen-authority.sqlite');writeFileSync(out,image!,{mode:0o600});const before=readFileSync(out);withReadOnlyBackupImage(out,read=>{assert.deepEqual(assertFrozenAuthority(read,initial.store_id,fence),fence);assert.deepEqual(read.prepare('SELECT count(*) n FROM invitations').get(),{n:1});assert.deepEqual(read.prepare('SELECT count(*) n FROM device_operations').get(),{n:1});});assert.throws(()=>new DeviceStore(out,initial.store_id));assert.deepEqual(readFileSync(out),before);assert.equal(existsSync(out+'-wal'),false);
});
test('unknown source schema/fence metadata refuses conversion rather than initializing, laundering or activating it',()=>{
  const db=new Database(':memory:');try{db.exec('CREATE TABLE foreign_data(value TEXT)');const before=db.serialize();assert.throws(()=>freezeDerivedLedger(db,metadata()));assert.deepEqual(db.serialize(),before);}finally{db.close();}
  const good=openDatabase(':memory:');try{new CoreStore(good);assert.throws(()=>freezeDerivedLedger(good,{...metadata(),restore_id:'not-an-id'}));assert.equal(good.pragma('user_version',{simple:true}),3);assert.equal(good.prepare("SELECT 1 FROM sqlite_schema WHERE name='restore_fence'").get(),undefined);}finally{good.close();}
});
test('frozen reader refuses a different original intent, missing fence and an altered frozen layout without repairing bytes',()=>{
  const db=openDatabase(':memory:');try{new CoreStore(db);const fence=metadata();freezeDerivedLedger(db,fence);assert.throws(()=>assertFrozenLedger(db,metadata()));db.exec('DELETE FROM restore_fence');assert.throws(()=>assertFrozenLedger(db,fence));assert.deepEqual(db.prepare('SELECT count(*) n FROM restore_fence').get(),{n:0});db.exec('DROP TABLE restore_fence');assert.throws(()=>assertFrozenLedger(db));assert.equal(db.pragma('user_version',{simple:true}),4);}finally{db.close();}
});
