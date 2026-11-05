import test from 'node:test';
import assert from 'node:assert/strict';
import sqlite from 'node:sqlite';
import { spawn,spawnSync } from 'node:child_process';
import { chmodSync,existsSync,lstatSync,readFileSync,unlinkSync,writeFileSync,truncateSync,symlinkSync,renameSync,mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Spool,syncParent } from '../src/spool.mjs';
import { inspectSpool,MAX_FILE_BYTES,accounting,errorCode } from '../src/spool-capacity.mjs';
import { LARGE_FILE_BYTES,writeStorage } from '../src/spool-storage.mjs';
import { APP,DDL,ROW_FIELDS,DEFAULT_POLICY,POLICY_MAX,readPolicy,storagePolicy } from '../src/spool-format.mjs';
import { planArchive,archiveOptions } from '../src/spool-maintenance.mjs';
import { canonical,hash,spoolBinding,sourceBinding } from '../src/validation.mjs';
import { flush } from '../src/transport.mjs';
import { fixture,createInput,http,json,jsonBody,self } from './helpers.mjs';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),crash=fileURLToPath(new URL('./lifecycle-crash-child.mjs',import.meta.url));
const options={max_rows:100,include_blocked:false};
const ack=(id='synthetic_event',v=1)=>({event_id:id,event_version:v,saved_at:'2026-01-01T00:00:00Z'});
const input=(n,body='')=>({...createInput({request_id:`request_${n}`,body}),id:`operation_${n}`});
const table=(db,name)=>db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
const globalRows=db=>{const rows=table(db,'queue');if(db.prepare('PRAGMA user_version').get().user_version===2)rows.push(...db.prepare(`SELECT ${ROW_FIELDS.join(',')} FROM archive`).all());return rows.sort((a,b)=>a.seq-b.seq);};
const facts=db=>canonical(globalRows(db));
const originalMeta=db=>canonical(db.prepare("SELECT * FROM meta WHERE key!='storage_policy' ORDER BY key").all());
const saved=(s,n,body='')=>{s.enqueue(input(n,body));const row=s.prepare();s.saved(row,ack(`event_${n}`));return row;};
const command=(f,cmd,data)=>{let path;if(data){path=`${f.root}/request.json`;writeFileSync(path,JSON.stringify(data),{mode:0o600});}return spawnSync(process.execPath,[cli,cmd,f.save(),...(path?[path]:[])],{encoding:'utf8',timeout:15000});};
function deadFixtureLock(f,result){assert.equal(result.signal,'SIGKILL',result.stderr);assert.ok(existsSync(`${f.c.spool}.lock`));unlinkSync(`${f.c.spool}.lock`);syncParent(f.c.spool);}

test('init rejects absent-main orphan group before SQLite can reset actual unknown WAL facts',()=>{
  const f=fixture();let s=new Spool(f.c,{init:true});s.enqueue(input(1));s.close();
  const child=fileURLToPath(new URL('./crash-child.mjs',import.meta.url));
  deadFixtureLock(f,spawnSync(process.execPath,[child,f.save(),'prepare'],{encoding:'utf8',timeout:15000}));
  const wal=hash(readFileSync(`${f.c.spool}-wal`)),shm=hash(readFileSync(`${f.c.spool}-shm`));
  renameSync(f.c.spool,`${f.root}/exact-original-main`);const result=command(f,'init');
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/ORPHAN_SPOOL_FILES/);
  assert.equal(existsSync(f.c.spool),false);assert.equal(hash(readFileSync(`${f.c.spool}-wal`)),wal);assert.equal(hash(readFileSync(`${f.c.spool}-shm`)),shm);
  assert.equal(existsSync(`${f.c.spool}.lock`),false);
  // Parent reassembles the same current cold fixture, NOT a product restore/import operation.
  renameSync(`${f.root}/exact-original-main`,f.c.spool);s=new Spool(f.c);const row=s.prepare();assert.equal(row.id,'operation_1');assert.equal(row.state,'unknown');assert.ok(row.wire);s.close();
});

test('every residual storage name is conservative, no-follow; locks/unsafe parents are not cleaned',()=>{
  for(const suffix of ['-wal','-shm','-journal','.storage'])for(const kind of ['regular','dangling','directory']){
    const f=fixture(),path=f.c.spool+suffix;
    if(kind==='regular')writeFileSync(path,'SYNTHETIC_RESIDUAL_FACT',{mode:0o600});
    else if(kind==='directory')mkdirSync(path,{mode:0o700});else symlinkSync(`${f.root}/absent-target`,path);
    const before=lstatSync(path);assert.throws(()=>new Spool(f.c,{init:true}),/ORPHAN_SPOOL_FILES/);assert.equal(existsSync(f.c.spool),false);
    const after=lstatSync(path);assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);if(kind==='regular')assert.equal(readFileSync(path,'utf8'),'SYNTHETIC_RESIDUAL_FACT');
  }
  const lock=fixture();writeFileSync(`${lock.c.spool}.lock`,'SYNTHETIC_OLD_LOCK',{mode:0o600});assert.throws(()=>new Spool(lock.c,{init:true}),/EEXIST/);assert.equal(readFileSync(`${lock.c.spool}.lock`,'utf8'),'SYNTHETIC_OLD_LOCK');assert.equal(existsSync(lock.c.spool),false);
  const bad=fixture();chmodSync(bad.root,0o755);assert.throws(()=>new Spool(bad.c,{init:true}),/PRIVATE_PATH_REQUIRED/);assert.equal(existsSync(bad.c.spool),false);chmodSync(bad.root,0o700);
  const link=fixture();symlinkSync(`${link.root}/absent-main`,link.c.spool);assert.throws(()=>new Spool(link.c,{init:true}),/PRIVATE_FILE_REQUIRED/);assert.equal(lstatSync(link.c.spool).isSymbolicLink(),true);
  const empty=fixture(),fresh=new Spool(empty.c,{init:true});assert.equal(fresh.version,1);assert.equal(fresh.status().counts.length,0);fresh.close();
});

test('explicit upgrade preserves all original facts/maps/meta, is idempotent, and no ordinary open auto-upgrades',()=>{
  const f=fixture();let s=new Spool(f.c,{init:true});saved(s,1);s.enqueue(input(2));const old=facts(s.db),meta=originalMeta(s.db);
  assert.equal(s.version,1);assert.equal(existsSync(`${f.c.spool}.storage`),false);assert.equal(s.archivePlan(options).archive_plan.upgrade_required,true);
  assert.equal(s.upgrade().changed,true);assert.equal(s.version,2);assert.equal(facts(s.db),old);assert.equal(originalMeta(s.db),meta);
  assert.deepEqual(readPolicy(s.db),DEFAULT_POLICY);assert.equal(s.upgrade().changed,false);s.close();
  s=new Spool(f.c);assert.equal(s.version,2);assert.equal(facts(s.db),old);assert.equal(inspectSpool(f.c).storage_state,'ready');s.close();
});

test('terminal archive frees actual working slots/budget; global id conflicts, exact history and sequence remain',()=>{
  const f=fixture();let s=new Spool(f.c,{init:true,capacity:1});const old=saved(s,1,'中文😀');assert.throws(()=>s.enqueue(input(2)),/SPOOL_FULL/);
  s.upgrade();s.db.prepare("UPDATE meta SET value=? WHERE key='storage_policy'").run(canonical({...DEFAULT_POLICY,active_operations:1}));
  assert.throws(()=>s.enqueue(input(2)),/SPOOL_FULL/);const initial=facts(s.db),before=s.capacityStatus().usage.reserved_bytes;
  const plan=s.archivePlan(options).archive_plan;assert.equal(plan.selected,1);assert.equal(plan.can_apply,true);
  assert.equal(s.archive(options).moved,1);assert.equal(facts(s.db),initial);assert.ok(s.capacityStatus().usage.reserved_bytes<before);
  assert.equal(s.enqueue(input(1,'中文😀')).state,'saved');assert.throws(()=>s.enqueue(input(1,'changed')),/IDEMPOTENCY_CONFLICT/);
  assert.equal(s.enqueue(input(2)).state,'connector_persisted');assert.equal(s.prepare().seq,old.seq+1);s.close();
  s=new Spool(f.c);assert.equal(s.enqueue(input(1,'中文😀')).receipt.event_id,'event_1');assert.equal(s.status().counts.find(r=>r.state==='saved').count,1);s.close();
});

test('archiving blocked is explicit and never removes its global FIFO barrier or mapping facts',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1);s.enqueue(input(2));const block=s.prepare();s.blocked(block,'HTTP_409');s.enqueue(input(3));
  s.upgrade();const before=facts(s.db),meta=originalMeta(s.db);assert.equal(s.archive(options).moved,1);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM queue').get().n,2);assert.throws(()=>s.prepare(),/QUEUE_BLOCKED/);
  assert.equal(s.archive({...options,include_blocked:true}).blocked_moved,1);assert.equal(facts(s.db),before);assert.equal(originalMeta(s.db),meta);
  assert.equal(s.enqueue(input(2)).state,'blocked');assert.throws(()=>s.prepare(),/QUEUE_BLOCKED/);
  const view=inspectSpool(f.c);assert.equal(view.first_unsettled.location,'archive');assert.equal(view.first_unsettled.seq,2);assert.equal(view.counts.find(r=>r.state==='blocked').count,1);s.close();
});

test('pending/unknown are never archived, including original wire/target across reopen',()=>{
  for(const state of ['pending','unknown']){
    const f=fixture();let s=new Spool(f.c,{init:true});saved(s,1);s.enqueue(input(2));if(state==='unknown')s.prepare();s.upgrade();
    const row=s.db.prepare('SELECT * FROM queue WHERE seq=2').get(),all=facts(s.db);assert.equal(s.archive({...options,include_blocked:true}).moved,1);
    assert.equal(canonical(s.db.prepare('SELECT * FROM queue WHERE seq=2').get()),canonical(row));assert.equal(facts(s.db),all);s.close();
    s=new Spool(f.c);assert.equal(canonical(s.db.prepare('SELECT * FROM queue WHERE seq=2').get()),canonical(row));s.close();
  }
});

test('archived late duplicate ACK cannot roll back a newer observed map; max sequence never reuses archived tail',()=>{
  const f=fixture();f.c.uniflo={origin:'http://127.0.0.1:7311',sessions:[{key:'demo:archive',alias:'Synthetic'}]};const s=new Spool(f.c,{init:true});s.upgrade();const gen=s.beginObservation();
  s.observe('demo:archive',{state:'work'},10,gen,{snapshot:true});const first=s.prepare();s.saved(first,ack('mapped',1));s.archive(options);
  s.observe('demo:archive',{state:'idle'},11,gen);const next=s.prepare();assert.equal(next.seq,first.seq+1);s.saved(next,ack('mapped',2));s.archive(options);
  const map=canonical(table(s.db,'maps'));s.saved(first,ack('mapped',1));assert.equal(canonical(table(s.db,'maps')),map);
  assert.throws(()=>s.saved(first,ack('mapped',2)),/RECEIPT_CONFLICT/);s.enqueue(input(3));assert.equal(s.prepare().seq,next.seq+1);s.close();
});

test('policy is strict, monotone and persistent; actual archive limit rejects atomically',()=>{
  for(const v of [0,-1,1.2,NaN,Infinity,'2'])assert.throws(()=>storagePolicy({...DEFAULT_POLICY,archive_bytes:v}));
  assert.throws(()=>storagePolicy({...DEFAULT_POLICY,archive_bytes:POLICY_MAX.archive_bytes+1}));assert.throws(()=>archiveOptions({max_rows:101,include_blocked:false}));
  const f=fixture();let s=new Spool(f.c,{init:true});saved(s,1);s.upgrade();const next={...DEFAULT_POLICY,active_operations:20000,archive_bytes:DEFAULT_POLICY.archive_bytes+1};
  assert.equal(s.resize(next).changed,true);assert.equal(s.resize(next).changed,false);assert.throws(()=>s.resize(DEFAULT_POLICY),/INVALID_STORAGE_POLICY/);s.close();
  s=new Spool(f.c);assert.equal(s.currentLimits().operations,20000);assert.equal(inspectSpool(f.c).capacity.limits.archive_bytes,next.archive_bytes);
  // A trusted fixture sets a small valid local policy, not a producer/CLI override.
  s.db.prepare("UPDATE meta SET value=? WHERE key='storage_policy'").run(canonical({...next,archive_bytes:1}));const before=facts(s.db);
  assert.equal(s.archivePlan(options).archive_plan.can_apply,false);assert.throws(()=>s.archive(options),/ARCHIVE_FULL/);assert.equal(facts(s.db),before);s.close();
});

test('real HTTP original-wire retry and saved history survive archive, without granting native input',async t=>{
  const f=fixture(),wires=[];let lost=true;const h=await http(t,async(req,res)=>{if(req.url==='/v1/source/self')return json(res,self(f.c));const wire=await jsonBody(req);wires.push(wire);if(lost){lost=false;res.destroy();}else json(res,ack());});f.c.server.base=h.origin;
  let s=new Spool(f.c,{init:true});s.enqueue(input(1));s.upgrade();await assert.rejects(flush(s),/PUBLISH_UNKNOWN/);const wire=s.prepare().wire;
  assert.equal(s.archive(options).moved,0);s.close();s=new Spool(f.c);assert.equal((await flush(s)).count,1);s.archive(options);
  assert.equal(s.enqueue(input(1)).state,'saved');assert.deepEqual(wires,[wire,wire]);assert.equal(JSON.parse(wire).source_binding,sourceBinding(f.c));
  s.enqueue(input(2,'new after archived history'));assert.equal((await flush(s)).count,1);assert.equal(wires.length,3);assert.notEqual(wires[2],wire);s.close();
});

test('copy/delete FULL and injected postcommit EIO retain all facts and never invent maintenance success',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1,'漢'.repeat(16000));s.upgrade();const before=facts(s.db),pages=s.db.prepare('PRAGMA page_count').get().page_count;
  s.db.exec(`PRAGMA max_page_count=${pages}`);let error;try{s.archive(options);}catch(e){error=e;}assert.equal(error.errcode&255,13);assert.equal(facts(s.db),before);
  s.db.exec(`PRAGMA max_page_count=${LARGE_FILE_BYTES/4096}`);
  s.maintenanceHook=point=>{if(point==='transaction_committed')s.syncDirectory=()=>{const e=Error('synthetic EIO');e.code='EIO';throw e;};};
  assert.throws(()=>s.archive(options),/EIO/);assert.equal(facts(s.db),before);assert.equal(inspectSpool(f.c).persistence_ack,false);
  s.maintenanceHook=undefined;s.syncDirectory=syncParent;assert.equal(s.archive(options).moved,0);assert.equal(s.enqueue(input(1,'漢'.repeat(16000))).state,'saved');s.close();
});

test('maintenance checkpoint busy preserves facts; a real held read snapshot is not forced away',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1);s.upgrade();
  const reader=new sqlite.DatabaseSync(f.c.spool,{readOnly:true});reader.exec('BEGIN');reader.prepare('SELECT count(*) AS n FROM queue').get();s.enqueue(input(2));
  const before=facts(s.db);assert.throws(()=>s.archive(options),/MAINTENANCE_BUSY/);assert.equal(facts(s.db),before);assert.equal(reader.prepare('SELECT count(*) AS n FROM queue').get().n,1);
  reader.exec('COMMIT');reader.close();assert.equal(s.archive(options).moved,1);s.close();
});

test('real CLI status/plan beside writer, lock refusal, private scope and no-network maintenance',async t=>{
  const f=fixture();let requests=0;const h=await http(t,(_req,res)=>{requests++;json(res,{});});f.c.server.base=h.origin;
  let s=new Spool(f.c,{init:true});saved(s,1);s.close();assert.equal(command(f,'upgrade').status,0);
  s=new Spool(f.c);const before=facts(s.db),plan=command(f,'archive-plan',options);assert.equal(plan.status,0,plan.stderr);assert.equal(JSON.parse(plan.stdout).archive_plan.selected,1);
  assert.equal(command(f,'archive',options).status,1);assert.equal(facts(s.db),before);s.close();
  const archived=command(f,'archive',options);assert.equal(archived.status,0,archived.stderr);assert.equal(JSON.parse(archived.stdout).moved,1);
  assert.equal(command(f,'resize',{...DEFAULT_POLICY,active_reserved_bytes:DEFAULT_POLICY.active_reserved_bytes+1}).status,0);
  const view=command(f,'status');assert.equal(view.status,0);assert.ok(Buffer.byteLength(view.stdout)<=8192);for(const secret of [f.c.server.token,hash(f.c.server.token),f.root,h.origin])assert.equal(view.stdout.includes(secret),false);
  assert.equal(requests,0);const missing=fixture();assert.equal(command(missing,'archive-plan',options).status,1);assert.equal(existsSync(missing.c.spool),false);
});

test('storage marker combinations fail closed; marker/schema is not a replacement for the exact binding',()=>{
  const f=fixture();let s=new Spool(f.c,{init:true});s.upgrade();s.close();const path=`${f.c.spool}.storage`,original=readFileSync(path),marker=JSON.parse(original);
  const bad=structuredClone(f.c);bad.server.token='a'.repeat(64);assert.throws(()=>inspectSpool(bad),/SPOOL_BINDING_MISMATCH/);
  for(const delta of [{inode:marker.inode+1},{state:'not_ready'},{binding:'0'.repeat(64)},{format:3}]){writeFileSync(path,canonical({...marker,...delta}));assert.throws(()=>inspectSpool(f.c));}writeFileSync(path,original);
  chmodSync(path,0o644);assert.throws(()=>inspectSpool(f.c),/PRIVATE_FILE_REQUIRED/);chmodSync(path,0o600);
  writeFileSync(path,canonical({...marker,state:'upgrading'}));assert.equal(inspectSpool(f.c).storage_state,'upgrading');assert.throws(()=>new Spool(f.c),/UPGRADE_REQUIRED/);
  s=new Spool(f.c,{maintenance:true});
  for(const action of [()=>s.enqueue(input(2)),()=>s.prepare(),()=>s.archive(options),()=>s.resize(DEFAULT_POLICY)])assert.throws(action,/UPGRADE_REQUIRED/);
  assert.equal(s.archivePlan(options).archive_plan.can_apply,false);const pendingPlan=command(f,'archive-plan',options);assert.equal(pendingPlan.status,0,pendingPlan.stderr);assert.equal(JSON.parse(pendingPlan.stdout).archive_plan.upgrade_required,true);
  s.upgrade();s.close();unlinkSync(path);assert.throws(()=>inspectSpool(f.c),/INVALID_STORAGE_MARKER/);
  const v1=fixture();s=new Spool(v1.c,{init:true});s.close();const stat=lstatSync(v1.c.spool);writeFileSync(`${v1.c.spool}.storage`,canonical({format:2,state:'ready',device:stat.dev,inode:stat.ino,binding:hash(spoolBinding(v1.c))}),{mode:0o600});assert.throws(()=>inspectSpool(v1.c),/INVALID_STORAGE_MARKER/);
});

test('32/256MiB bounded pre-open rules distinguish unmarked v1 and marked v2, with constructor spies',()=>{
  const legacy=fixture();let s=new Spool(legacy.c,{init:true});s.close();truncateSync(legacy.c.spool,MAX_FILE_BYTES+1);
  assert.equal(command(legacy,'upgrade').status,1);assert.equal(existsSync(`${legacy.c.spool}.storage`),false);
  const v2=fixture();s=new Spool(v2.c,{init:true});s.upgrade();s.close();const Original=sqlite.DatabaseSync;let opens=0;
  sqlite.DatabaseSync=class{constructor(){opens++;throw Error('bounded constructor spy');}};
  try{assert.equal(inspectSpool(legacy.c).counts,null);assert.equal(opens,0);
    truncateSync(v2.c.spool,MAX_FILE_BYTES+1);assert.throws(()=>inspectSpool(v2.c),/bounded constructor spy/);assert.equal(opens,1);
    truncateSync(v2.c.spool,LARGE_FILE_BYTES);assert.throws(()=>inspectSpool(v2.c),/bounded constructor spy/);assert.equal(opens,2);
    truncateSync(v2.c.spool,LARGE_FILE_BYTES+1);assert.equal(inspectSpool(v2.c).counts,null);assert.equal(opens,2);
  }finally{sqlite.DatabaseSync=Original;}
});

test('actual multi-MiB batch WAL growth has preflight allowance, not the old single-operation MiB margin',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});s.upgrade();for(let n=1;n<=100;n++)saved(s,n,'a'.repeat(16000));
  const before=facts(s.db),planned=s.archivePlan(options).archive_plan;assert.ok(planned.physical_transaction_allowance>1024*1024);
  let reader;s.maintenanceHook=point=>{if(point==='checkpoint_complete'&&!reader){reader=new sqlite.DatabaseSync(f.c.spool,{readOnly:true});reader.exec('BEGIN');reader.prepare('SELECT count(*) AS n FROM queue').get();}};
  const result=s.archive(options);assert.equal(result.moved,100);const actual=lstatSync(`${f.c.spool}-wal`).size;
  assert.ok(actual>1024*1024);assert.ok(actual<=planned.physical_transaction_allowance);assert.equal(facts(s.db),before);assert.equal(reader.prepare('SELECT count(*) AS n FROM queue').get().n,100);
  s.maintenanceHook=undefined;reader.exec('COMMIT');reader.close();s.close();
});

test('UTF-16 and nondefault page geometry keep exact full values and use UTF-8 archive charging',()=>{
  const f=fixture(),db=new sqlite.DatabaseSync(f.c.spool);db.exec("PRAGMA encoding='UTF-16le'; PRAGMA page_size=8192");for(const sql of DDL)db.exec(sql);
  db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=1`);db.prepare('INSERT INTO meta VALUES (?,?)').run('binding',spoolBinding(f.c));db.prepare('INSERT INTO meta VALUES (?,?)').run('observer',canonical({generation:0,state:'disconnected',reason:'not_started'}));db.close();chmodSync(f.c.spool,0o600);
  const s=new Spool(f.c);saved(s,1,'中文😀');s.upgrade();const before=facts(s.db),plan=s.archivePlan(options).archive_plan;s.archive(options);
  assert.equal(facts(s.db),before);assert.equal(s.capacityStatus().usage.archive_bytes,plan.archive_bytes_required);assert.equal(s.db.prepare('PRAGMA max_page_count').get().max_page_count,LARGE_FILE_BYTES/8192);s.close();
});

test('read-only preview is not a reservation; write rechecks current archive policy atomically',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1);s.upgrade();const plan=inspectSpool(f.c,(db,c,bound)=>planArchive(db,c,bound,options));assert.equal(plan.archive_plan.can_apply,true);
  s.db.prepare("UPDATE meta SET value=? WHERE key='storage_policy'").run(canonical({...DEFAULT_POLICY,archive_operations:1,archive_bytes:1}));const before=facts(s.db);
  assert.throws(()=>s.archive(options),/ARCHIVE_FULL/);assert.equal(facts(s.db),before);s.close();
});

for(const phase of ['resize_before_commit','transaction_committed'])test(`resize exact-child SIGKILL at ${phase} preserves data and monotone policy`,()=>{
  const f=fixture();let s=new Spool(f.c,{init:true});saved(s,1);s.upgrade();const before=facts(s.db);s.close();
  deadFixtureLock(f,spawnSync(process.execPath,[crash,f.save(),'resize',phase],{encoding:'utf8',timeout:15000}));s=new Spool(f.c);assert.equal(facts(s.db),before);
  const target={...DEFAULT_POLICY,active_reserved_bytes:DEFAULT_POLICY.active_reserved_bytes+4096};s.resize(target);assert.deepEqual(readPolicy(s.db),target);assert.equal(facts(s.db),before);s.close();
});

test('same-instance upgrade retry rechecks committed SQL after a postcommit acknowledgement error',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1);const before=facts(s.db);let once=true;
  s.maintenanceHook=point=>{if(point==='transaction_committed'&&once){once=false;throw Error('synthetic postcommit acknowledgement error');}};
  assert.throws(()=>s.upgrade(),/acknowledgement/);assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(facts(s.db),before);
  assert.equal(s.upgrade().state,'storage_ready');assert.equal(facts(s.db),before);assert.equal(s.version,2);s.close();
});

test('v2 read-only policy/counts are one snapshot and marker ready transitions cannot be mixed into it',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true,maintenance:true});saved(s,1);s.upgrade();const Original=sqlite.DatabaseSync;
  const next={...DEFAULT_POLICY,active_operations:20000};let injected=false;
  sqlite.DatabaseSync=class extends Original{prepare(sql){const statement=super.prepare(sql);if(sql.startsWith('SELECT state,COUNT(*) AS count FROM ('))return{all(){const result=statement.all();s.tx(()=>s.db.prepare("UPDATE meta SET value=? WHERE key='storage_policy'").run(canonical(next)));injected=true;return result;}};return statement;}};
  try{const view=inspectSpool(f.c);assert.equal(injected,true);assert.equal(view.capacity.limits.operations,10000);assert.equal(readPolicy(s.db).active_operations,20000);}finally{sqlite.DatabaseSync=Original;}
  writeStorage(s,'upgrading');
  sqlite.DatabaseSync=class extends Original{prepare(sql){const statement=super.prepare(sql);if(sql.startsWith('SELECT state,COUNT(*) AS count FROM ('))return{all(){const result=statement.all();writeStorage(s,'ready');return result;}};return statement;}};
  try{assert.throws(()=>inspectSpool(f.c),/STORAGE_TRANSITION/);}finally{sqlite.DatabaseSync=Original;s.close();}
});

test('archive exact quota fits once and rejected next batch does not mutate global or active facts',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1);s.upgrade();const cost=s.archivePlan(options).archive_plan.archive_bytes_required;
  s.db.prepare("UPDATE meta SET value=? WHERE key='storage_policy'").run(canonical({...DEFAULT_POLICY,archive_bytes:cost,archive_operations:1}));
  assert.equal(s.archive(options).moved,1);assert.equal(s.capacityStatus().usage.archive_bytes,cost);saved(s,2);const before=facts(s.db),live=canonical(table(s.db,'queue'));
  assert.throws(()=>s.archive(options),/ARCHIVE_FULL/);assert.equal(facts(s.db),before);assert.equal(canonical(table(s.db,'queue')),live);s.close();
});

test('copy-stage local failure rolls back both location changes and every original field',()=>{
  const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1);s.upgrade();const before=facts(s.db);
  s.maintenanceHook=phase=>{if(phase==='archive_copied')throw Error('synthetic copy-stage EIO');};
  assert.throws(()=>s.archive(options),/copy-stage EIO/);assert.equal(facts(s.db),before);assert.equal(s.db.prepare('SELECT count(*) AS n FROM archive').get().n,0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM queue').get().n,1);s.maintenanceHook=undefined;s.close();
});

test('bad policy and symbolic format marker are rejected rather than repaired or used as permission',()=>{
  const f=fixture();let s=new Spool(f.c,{init:true});s.upgrade();s.db.prepare("UPDATE meta SET value=? WHERE key='storage_policy'").run(canonical({...DEFAULT_POLICY,active_operations:'10000'}));s.close();
  assert.throws(()=>inspectSpool(f.c),/INVALID_STORAGE_POLICY/);assert.throws(()=>new Spool(f.c,{maintenance:true}),/INVALID_STORAGE_POLICY/);
  const other=fixture();s=new Spool(other.c,{init:true});s.upgrade();s.close();const path=`${other.c.spool}.storage`,back=`${other.root}/marker-backup`;
  writeFileSync(back,readFileSync(path),{mode:0o600});unlinkSync(path);symlinkSync(back,path);assert.throws(()=>inspectSpool(other.c),/PRIVATE_FILE_REQUIRED/);
});

test('actual v2 run cannot publish past an archived blocked head', {timeout:15000},async t=>{
  const f=fixture();let posts=0;const h=await http(t,(req,res)=>{if(req.url==='/v1/source/self')return json(res,self(f.c));posts++;json(res,ack());});f.c.server.base=h.origin;
  const s=new Spool(f.c,{init:true});s.enqueue(input(1));s.blocked(s.prepare(),'HTTP_409');s.upgrade();s.archive({...options,include_blocked:true});s.enqueue(input(2));const before=facts(s.db);s.close();
  const child=spawn(process.execPath,[cli,'run',f.save()],{stdio:['ignore','pipe','pipe']});let err='';child.stdout.resume();child.stderr.on('data',b=>{err+=b;});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  for(let i=0;i<100&&!err.includes('QUEUE_BLOCKED');i++)await sleep(20);assert.match(err,/QUEUE_BLOCKED/);await sleep(2200);assert.equal(posts,0);
  child.kill('SIGTERM');assert.equal(await done,0,err);const reopened=new Spool(f.c);assert.equal(facts(reopened.db),before);assert.equal(reopened.status().first_unsettled.location,'archive');reopened.close();
});

test('global duplicate ID/sequence across archive and queue is rejected, not resolved by taking the first',()=>{
  for(const by of ['id','seq']){const f=fixture(),s=new Spool(f.c,{init:true});saved(s,1);s.upgrade();s.archive(options);s.enqueue(input(2));s.close();
    const d=new sqlite.DatabaseSync(f.c.spool);if(by==='id')d.exec("UPDATE queue SET id='operation_1'");else d.exec('UPDATE queue SET seq=1');d.close();assert.throws(()=>inspectSpool(f.c),/UNKNOWN_SPOOL/);}
});

for(const phase of ['upgrading_synced','upgrading_renamed','upgrading_durable','schema_before_commit','transaction_committed','schema_committed','ready_synced','ready_renamed','ready_durable'])test(`upgrade exact-child SIGKILL at ${phase} preserves current facts and resumes explicitly`,()=>{
  const f=fixture();let s=new Spool(f.c,{init:true});saved(s,1);s.enqueue(input(2));const before=facts(s.db),meta=originalMeta(s.db);s.close();
  const result=spawnSync(process.execPath,[crash,f.save(),'upgrade',phase],{encoding:'utf8',timeout:15000});deadFixtureLock(f,result);
  s=new Spool(f.c,{maintenance:true});assert.equal(facts(s.db),before);assert.equal(originalMeta(s.db),meta);s.upgrade();assert.equal(facts(s.db),before);assert.equal(s.version,2);s.close();
});
for(const phase of ['archive_copied','archive_before_commit','transaction_committed','archive_committed'])test(`archive exact-child SIGKILL at ${phase} conserves global records and dedup`,()=>{
  const f=fixture();let s=new Spool(f.c,{init:true});saved(s,1);s.enqueue(input(2));s.prepare();s.upgrade();const before=facts(s.db);s.close();
  deadFixtureLock(f,spawnSync(process.execPath,[crash,f.save(),'archive',phase],{encoding:'utf8',timeout:15000}));
  s=new Spool(f.c);assert.equal(facts(s.db),before);s.archive(options);assert.equal(s.enqueue(input(1)).state,'saved');assert.equal(s.prepare().seq,2);s.close();
});
