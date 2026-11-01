import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {openDatabase} from '../src/database.js';
import {CoreStore} from '../src/core.js';
import {DeliveryStore} from '../src/delivery.js';
import {SourcePump} from '../src/source-adapter.js';
import {NotificationStore,pushConfig,notificationConsumer} from '../src/notifications.js';
import {randomUUID} from 'node:crypto';
import {initializeSchema} from '../src/schema.js';
import {parseRegistry} from '../src/auth.js';
import {DeviceStore} from '../src/device-store.js';
import {assertNoRecovery,recoveryPendingPath} from '../src/recovery-gate.js';
import {credentials,eventInput,responseInput,NOW,snapshot} from './helpers.js';
const root=()=>mkdtempSync(join(tmpdir(),'notifier-recovery-gate-'));
const isCode=(code:string)=>(e:unknown)=>typeof e==='object'&&e!==null&&'code'in e&&e.code===code;

test('healthy v3 remains idempotent, but direct existing Core gate refuses the same cached write after recovery fencing',()=>{
  const db=openDatabase(':memory:');try{const core=new CoreStore(db,()=>NOW);const registry=parseRegistry(credentials());const source=registry.source('owner','source','epoch_1')!;const input=eventInput();const first=core.create(source,input);assert.deepEqual(core.create(source,input),first);
    const before=db.prepare('SELECT * FROM operations').all();db.exec('CREATE TABLE restore_fence (damaged TEXT)');assert.throws(()=>core.create(source,input),isCode('RESTORE_FROZEN'));assert.throws(()=>core.create(registry.source('owner','neighbor','epoch_1')!,eventInput()),isCode('RESTORE_FROZEN'));assert.deepEqual(db.prepare('SELECT * FROM operations').all(),before);
  }finally{db.close();}
});
test('missing ledger with deterministic pending refuses before creating SQLite or parent resources',()=>{
  const path=join(root(),'ledger.sqlite');writeFileSync(recoveryPendingPath(path),'{bad pending',{mode:0o600});assert.throws(()=>openDatabase(path),isCode('RESTORE_PENDING'));assert.equal(existsSync(path),false);
});
test('existing frozen ledger version is refused read-only before changing DELETE mode or creating WAL sidecars even without a fence row',()=>{
  const path=join(root(),'ledger.sqlite');const db=new Database(path);db.exec('CREATE TABLE retained(value TEXT)');db.pragma('application_id=1313821769');db.pragma('user_version=4');db.close();const before=readFileSync(path);
  assert.throws(()=>openDatabase(path),isCode('RESTORE_FROZEN'));assert.deepEqual(readFileSync(path),before);assert.equal(existsSync(path+'-wal'),false);assert.equal(existsSync(path+'-shm'),false);
});
test('a malformed marker closes an existing healthy file without following marker contents or changing the original image',()=>{
  const path=join(root(),'ledger.sqlite');const db=new Database(path);initializeSchema(db);db.close();const before=readFileSync(path);writeFileSync(recoveryPendingPath(path),'not JSON; /never-follow-this-path',{mode:0o600});
  assert.throws(()=>openDatabase(path),isCode('RESTORE_PENDING'));assert.deepEqual(readFileSync(path),before);
});
test('schema initialization refuses a damaged fence even on a zero-version memory database rather than creating live tables',()=>{
  const db=new Database(':memory:');try{db.exec('CREATE TABLE restore_fence (damaged TEXT)');assert.throws(()=>initializeSchema(db),isCode('RESTORE_FROZEN'));assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='events'").get(),undefined);assert.throws(()=>assertNoRecovery(db),isCode('RESTORE_FROZEN'));}finally{db.close();}
});
test('direct Delivery cached claim/receipt/native early returns and SourcePump journal are gated before any callback or mutation',()=>{
  const db=openDatabase(':memory:');try{const raw=credentials();raw.principals.filter(p=>p.kind==='source').find(p=>p.id==='source')!.capabilities.push('deliver');const registry=parseRegistry(raw);const source=registry.source('owner','source','epoch_1')!;const user=registry.authenticate(`Bearer ${raw.principals[0]!.token}`);const core=new CoreStore(db,()=>NOW);const delivery=new DeliveryStore(db,()=>NOW);const event=core.create(source,eventInput());core.respond(user,event.event_id,responseInput(),registry);const claimId=randomUUID();const c=delivery.claim(source,claimId,registry).command!;const receipt={command_id:c.id,session_ref:c.response.target.session_ref,state_revision:c.response.target.state_revision,message_id:'explicit-source-reported-test-entry'};delivery.receipt(source,c.id,c.id,receipt);const before=snapshot(db);
    let called=0;const authority=()=>{called++;return{principal:source,registry};};const host={synchronousDurableGate:true as const,compareAndEnqueue:()=>{called++;return receipt;},getReceipt:()=>{called++;return receipt;}};const path=join(root(),'pump.json');const pump=new SourcePump(delivery,authority,host,path);db.exec('CREATE TABLE restore_fence (damaged TEXT)');
    for(const run of [()=>delivery.claim(source,claimId,registry),()=>delivery.receipt(source,c.id,c.id,receipt),()=>delivery.submitAtGate(authority,c.id,host),()=>pump.runOnce()])assert.throws(run,isCode('RESTORE_FROZEN'));
    assert.equal(called,0);assert.equal(existsSync(path),false);assert.deepEqual(snapshot(db),before);
  }finally{db.close();}
});
test('direct notification cached registration/claim/platform/device ACK and consumer retain original unknown without fetch',async()=>{
  const db=openDatabase(':memory:');const originalFetch=globalThis.fetch;let fetched=0;globalThis.fetch=async()=>{fetched++;throw new Error('No publication while frozen');};
  try{const raw=credentials();const registry=()=>parseRegistry(raw);const source=registry().source('owner','source','epoch_1')!;const user=registry().authenticate(`Bearer ${raw.principals[0]!.token}`);const core=new CoreStore(db,()=>NOW);const cfg=pushConfig('http://127.0.0.1:18521',undefined,true);const n=new NotificationStore(db,registry,cfg,()=>NOW);const registration={registration_id:randomUUID(),expected_generation:0,endpoint:'http://127.0.0.1:18521/synthetic_topic'};n.register(user,registration);core.create(source,eventInput());const notice=n.claim()!;assert.equal(notice.platform_state,'effect_unknown');n.receipt(user,notice.id,{nonce:notice.nonce,state:'device_received'});const before=snapshot(db);db.exec('CREATE TABLE restore_fence (damaged TEXT)');
    for(const run of [()=>n.register(user,registration),()=>n.claim(),()=>n.platform(notice.id,'platform_accepted'),()=>n.receipt(user,notice.id,{nonce:notice.nonce,state:'device_received'})])assert.throws(run,isCode('RESTORE_FROZEN'));
    const stop=notificationConsumer(n,cfg);await new Promise(r=>setTimeout(r,20));await stop();assert.equal(fetched,0);assert.deepEqual(snapshot(db),before);
  }finally{globalThis.fetch=originalFetch;db.close();}
});
test('managed store missing/init, reopening and direct already-owned guard are closed by its exact per-file pending marker',()=>{
  const path=join(root(),'authority.sqlite');const pending=recoveryPendingPath(path);writeFileSync(pending,'pending',{mode:0o600});assert.throws(()=>DeviceStore.initialize(path),isCode('RESTORE_PENDING'));assert.equal(existsSync(path),false);
  const other=join(root(),'authority.sqlite');const initialized=DeviceStore.initialize(other);const store=new DeviceStore(other,initialized.store_id);try{writeFileSync(recoveryPendingPath(other),'pending',{mode:0o600});let entered=false;assert.throws(()=>store.guard(()=>{entered=true;}),isCode('RESTORE_PENDING'));assert.equal(entered,false);assert.throws(()=>new DeviceStore(other,initialized.store_id),isCode('RESTORE_PENDING'));}finally{store.close();}
});
