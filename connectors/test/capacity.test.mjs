import test from 'node:test';
import assert from 'node:assert/strict';
import sqlite from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Spool, syncParent } from '../src/spool.mjs';
import { accounting, errorCode, inspectSpool, limits, MAX_FILE_BYTES, MIN_RECORD_RESERVE, recordReserve } from '../src/spool-capacity.mjs';
import { APP, DDL } from '../src/spool-format.mjs';
import { canonical, hash, spoolBinding } from '../src/validation.mjs';
import { flush } from '../src/transport.mjs';
import { observeOnce } from '../src/uniflo.mjs';
import { createInput, fixture, http, json, jsonBody, self } from './helpers.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const ack = { event_id: 'synthetic_event', event_version: 1, saved_at: '2026-01-01T00:00:00Z' };
const facts = s => hash(canonical(['meta','queue','maps'].map(t => s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())));
const selected = f => { f.c.uniflo = { origin:'http://127.0.0.1:7311', sessions:[{key:'demo:capacity',alias:'Synthetic'}] }; return f; };
const op = (n, body = '') => ({ ...createInput({ body, request_id:`request_${n}` }), id:`operation_${n}` });
const status = f => spawnSync(process.execPath, [cli,'status',f.save()], { encoding:'utf8',timeout:10000 });

test('limits are finite bounded integers; reservation is UTF-8 including future wire/ACK and mapping bytes', () => {
  for (const n of [0,-1,NaN,Infinity,1.5,10001]) assert.throws(()=>limits(n),/INVALID_SPOOL_LIMIT/);
  for (const n of [0,NaN,Infinity,8*1024*1024+1]) assert.throws(()=>limits(1,n),/INVALID_SPOOL_LIMIT/);
  const p=canonical(createInput().payload), mapping='demo:中文😀';
  assert.equal(recordReserve(p,mapping),Buffer.byteLength(p)*2+256+1024+Buffer.byteLength(mapping)+1024);
  const f=fixture(),s=new Spool(f.c,{init:true}); const initial=accounting(s.db,s.c);
  s.enqueue(createInput());const charged=accounting(s.db,s.c);
  assert.equal(charged.reserved_bytes-initial.reserved_bytes,recordReserve(p));
  const row=s.prepare();s.saved(row,ack);
  assert.equal(accounting(s.db,s.c).reserved_bytes,charged.reserved_bytes);s.close();
});

test('exact byte limit admits once, then stable duplicate/conflict; older legal v1 over new budget is retained', () => {
  const f=fixture();let s=new Spool(f.c,{init:true});const bound=accounting(s.db,s.c).reserved_bytes+recordReserve(canonical(createInput().payload));s.close();
  s=new Spool(f.c,{byteBudget:bound});s.enqueue(createInput());const before=facts(s);
  assert.equal(s.capacityStatus().usage.reserved_bytes,bound);assert.equal(s.enqueue(createInput()).state,'pending');
  assert.throws(()=>s.enqueue(op(2)),/SPOOL_FULL/);assert.equal(facts(s),before);
  assert.throws(()=>s.enqueue(createInput({body:'different'})),/IDEMPOTENCY_CONFLICT/);assert.equal(facts(s),before);
  const row=s.prepare(),wire=row.wire;s.close();
  s=new Spool(f.c,{byteBudget:bound-1});assert.equal(s.capacityStatus().retained_over_limit,true);
  assert.equal(s.prepare().wire,wire);s.saved(s.prepare(),ack);assert.equal(s.enqueue(createInput()).state,'saved');
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(s.db.prepare('SELECT count(*) AS n FROM queue').get().n,1);s.close();
});

test('UTF-8 accounting also handles existing UTF-16 v1 and nondefault SQLite page geometry without migration', () => {
  const f=fixture(),d=new sqlite.DatabaseSync(f.c.spool);d.exec("PRAGMA encoding='UTF-16le'; PRAGMA page_size=8192");
  for(const sql of DDL)d.exec(sql);d.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=1`);
  d.prepare('INSERT INTO meta VALUES (?,?)').run('binding',spoolBinding(f.c));d.prepare('INSERT INTO meta VALUES (?,?)').run('observer',canonical({generation:0,state:'disconnected',reason:'not_started'}));d.close();chmodSync(f.c.spool,0o600);
  const s=new Spool(f.c),before=accounting(s.db,s.c).reserved_bytes;s.enqueue(createInput());
  assert.equal(accounting(s.db,s.c).reserved_bytes-before,recordReserve(canonical(createInput().payload)));
  assert.equal(s.db.prepare('PRAGMA max_page_count').get().max_page_count,MAX_FILE_BYTES/8192);s.close();
});

test('full/over-limit pending and unknown drain via original HTTP fixture; ACK-before-local-failure reopens unchanged', async t => {
  const f=fixture(),wires=[];const h=await http(t,async(req,res)=>{if(req.url==='/v1/source/self')return json(res,self(f.c));wires.push(await jsonBody(req));json(res,ack);});f.c.server.base=h.origin;
  let s=new Spool(f.c,{init:true,capacity:1});s.enqueue(createInput());const retained=accounting(s.db,s.c).reserved_bytes;s.close();
  s=new Spool(f.c,{capacity:1,byteBudget:retained-1});assert.equal(s.capacityStatus().admission,'backpressure');
  await assert.rejects(flush(s,{afterResponse:()=>{throw Error('synthetic local failure');}}),/PUBLISH_UNKNOWN/);
  const wire=s.prepare().wire;s.close();s=new Spool(f.c,{capacity:1,byteBudget:retained-1});
  assert.equal((await flush(s)).count,1);assert.deepEqual(wires,[wire,wire]);assert.equal(s.enqueue(createInput()).state,'saved');s.close();
});

test('real SQLite FULL preserves first errcode 13 and facts; postcommit EIO SQL visibility gives no new ACK', () => {
  const f=fixture(),s=new Spool(f.c,{init:true});const before=facts(s),pages=s.db.prepare('PRAGMA page_count').get().page_count;
  s.db.exec(`PRAGMA max_page_count=${pages}`);let failure;try{s.enqueue(createInput({body:'漢'.repeat(16000)}));}catch(e){failure=e;}
  assert.equal(failure.errcode&255,13);assert.equal(errorCode(failure),'SQLITE_FULL');assert.equal(facts(s),before);
  s.db.exec('PRAGMA max_page_count=8192');s.enqueue(createInput());const row=s.prepare();
  s.syncDirectory=()=>{const e=Error('synthetic secret EIO');e.code='EIO';throw e;};assert.throws(()=>s.saved(row,ack),/EIO/);
  assert.throws(()=>s.status(),/EIO/);const read=inspectSpool(f.c);assert.equal(read.counts[0].state,'saved');assert.equal(read.persistence_ack,false);
  s.syncDirectory=syncParent;assert.equal(s.enqueue(createInput()).state,'saved');s.close();
});

test('failed full resnapshot preserves saved mapping/watermark; only successful first snapshot may rebase', () => {
  const f=selected(fixture());let s=new Spool(f.c,{init:true,capacity:3});const gen=s.beginObservation();s.observe('demo:capacity',{state:'work',upstream_seq:55},55,gen,{snapshot:true});s.saved(s.prepare(),ack);
  const next=s.beginObservation();s.enqueue(op(2));s.enqueue(op(3));const before=facts(s),map=canonical(s.db.prepare('SELECT * FROM maps').get());
  assert.throws(()=>s.observe('demo:capacity',{state:'idle',upstream_seq:0},0,next,{snapshot:true}),/SPOOL_FULL/);
  assert.equal(facts(s),before);assert.equal(canonical(s.db.prepare('SELECT * FROM maps').get()),map);
  assert.throws(()=>s.beginObservation(),/SPOOL_FULL/);assert.equal(facts(s),before);s.close();
  s=new Spool(f.c);const g=s.beginObservation();assert.equal(s.db.prepare('SELECT watermark FROM maps').get().watermark,55);
  s.observe('demo:capacity',{state:'idle',upstream_seq:0},0,g,{snapshot:true});assert.equal(s.db.prepare('SELECT watermark FROM maps').get().watermark,0);
  s.observe('demo:capacity',{state:'work',upstream_seq:5},5,g);
  assert.throws(()=>s.observe('demo:capacity',{state:'idle'},0,g,{snapshot:true}),/SEQUENCE_ROLLBACK/);
  assert.throws(()=>s.observe('demo:capacity',{state:'idle'},0,g),/SEQUENCE_ROLLBACK/);
  assert.throws(()=>s.disconnected('OBSERVATION_GAP',gen),/STALE_OBSERVER/);assert.equal(s.observer().generation,g);s.close();
});

test('same-instance observer reentry is rejected, stale async cleanup does not clobber newer generation', async t => {
  const f=selected(fixture());let entered;const arrived=new Promise(r=>{entered=r;});
  const h=await http(t,(req,res)=>{entered(res);});f.c.uniflo.origin=h.origin;const s=new Spool(f.c,{init:true});t.after(()=>s.close());
  const ctrl=new AbortController(),first=observeOnce(s,{signal:ctrl.signal});await arrived;
  await assert.rejects(observeOnce(s),/OBSERVER_BUSY/);const newer=s.beginObservation();ctrl.abort();await assert.rejects(first);
  assert.equal(s.observer().generation,newer);assert.equal(s.observer().state,'snapshot');
});

test('actual status beside active writer and synthetic stale lock is bounded, redacted, no business changes or new ACK', () => {
  const f=selected(fixture()),s=new Spool(f.c,{init:true,capacity:1});s.enqueue(createInput({body:'PRIVATE_BODY_MARKER'}));
  const before=facts(s),lock=readFileSync(s.lock),r=status(f);assert.equal(r.status,0,r.stderr);assert.equal(facts(s),before);assert.deepEqual(readFileSync(s.lock),lock);
  const v=JSON.parse(r.stdout);assert.equal(v.lock,'present');assert.equal(v.persistence_ack,false);assert.ok(Buffer.byteLength(r.stdout)<=8192);
  for(const secret of [f.c.server.token,hash(f.c.server.token),f.root,f.c.server.base,'demo:capacity','PRIVATE_BODY_MARKER'])assert.equal(r.stdout.includes(secret),false,secret);
  const current=s.prepare();s.blocked(current,'PRIVATE_REASON_MARKER');assert.equal(inspectSpool(f.c).first_unsettled.reason,'other');s.close();
  writeFileSync(`${f.c.spool}.lock`,'synthetic stale lock; no liveness claim',{mode:0o600});const stale=readFileSync(`${f.c.spool}.lock`);assert.equal(status(f).status,0);assert.deepEqual(readFileSync(`${f.c.spool}.lock`),stale);
});

test('read-only diagnostics reject missing/bad scope/unknown schema/permissions/symlinks without initializing or fixing', () => {
  const missing=fixture();assert.notEqual(status(missing).status,0);assert.equal(existsSync(missing.c.spool),false);assert.equal(existsSync(`${missing.c.spool}.lock`),false);
  const f=fixture(),s=new Spool(f.c,{init:true});s.enqueue(createInput());const before=facts(s);const bad=structuredClone(f.c);bad.server.token='f'.repeat(64);assert.throws(()=>inspectSpool(bad),/SPOOL_BINDING_MISMATCH/);assert.equal(facts(s),before);
  chmodSync(f.c.spool,0o644);assert.throws(()=>inspectSpool(f.c),/PRIVATE_FILE_REQUIRED/);chmodSync(f.c.spool,0o600);s.close();
  const link=fixture();symlinkSync(f.c.spool,link.c.spool);assert.throws(()=>inspectSpool(link.c),/PRIVATE_FILE_REQUIRED/);
  const unknown=new sqlite.DatabaseSync(f.c.spool);unknown.exec('CREATE TABLE unexpected(x)');unknown.close();assert.throws(()=>inspectSpool(f.c),/UNKNOWN_SPOOL/);
  const dangling=fixture();symlinkSync(`${dangling.root}/absent`,`${dangling.c.spool}-wal`);assert.throws(()=>new Spool(dangling.c,{init:true}),/ORPHAN_SPOOL_FILES/);assert.equal(existsSync(dangling.c.spool),false);
});

test('oversize stat-only diagnostics never construct/query SQLite and explicitly leave scope/counts unknown', () => {
  const f=fixture(),s=new Spool(f.c,{init:true});s.close();truncateSync(f.c.spool,MAX_FILE_BYTES);
  const original=sqlite.DatabaseSync;let opens=0;sqlite.DatabaseSync=class{constructor(){opens++;throw Error('boundary constructor spy');}};
  try{assert.throws(()=>inspectSpool(f.c),/boundary constructor spy/);assert.equal(opens,1);opens=0;truncateSync(f.c.spool,MAX_FILE_BYTES+1);
    const v=inspectSpool(f.c);assert.equal(opens,0);assert.equal(v.scope_validation,'not_checked');assert.equal(v.counts,null);assert.equal(v.capacity.reason,'PHYSICAL_FILE_LIMIT');}finally{sqlite.DatabaseSync=original;}
  assert.equal(lstatSync(f.c.spool).size,MAX_FILE_BYTES+1);
});

for (const mode of ['identity503','post503','recovery']) test(`actual run log stages: ${mode} keeps stable publisher failure quiet but re-arms after real recovery`, {timeout:15000}, async t => {
  const f=selected(fixture());let phase=0,gets=0,posts=0,stream;const wires=[];
  const session={key:'demo:capacity',harness:'demo',id:'capacity',status:'work'};
  const h=await http(t,async(req,res)=>{
    if(req.url==='/v1/source/self') {gets++;return mode==='identity503'||(mode==='recovery'&&phase!==1)?json(res,{},503):json(res,self(f.c));}
    if(req.method==='POST'){posts++;const wire=await jsonBody(req);wires.push(wire);const p=JSON.parse(wire);
      return mode==='post503'?json(res,{},503):json(res,{...ack,event_version:p.request_id?1:p.expected_event_version+1});}
    if(req.url==='/v1/health')return json(res,{ok:true,schema:1,seq:0});
    if(req.url.startsWith('/v1/sessions/'))return json(res,session,200,{'x-uniflo-seq':'0'});
    stream=res;res.writeHead(200,{'content-type':'application/x-ndjson'});res.write(JSON.stringify({type:'hello',seq:0})+'\n');
  });f.c.uniflo.origin=h.origin;f.c.server.base=h.origin;const s=new Spool(f.c,{init:true});s.close();
  const child=spawn(process.execPath,[cli,'run',f.save()],{stdio:['ignore','pipe','pipe']});let err='';child.stderr.on('data',b=>{err+=b;});child.stdout.resume();
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  const until=async predicate=>{for(let i=0;i<300&&!predicate();i++)await sleep(10);assert.ok(predicate(),err);};
  const emit=(seq,state)=>stream.write(JSON.stringify({type:'session',seq,session:{...session,status:state}})+'\n');
  const warnings=()=>err.split('\n').filter(line=>line.startsWith('CONNECTOR_WAITING')&&line.includes(': publish;')).length;
  await until(()=>stream&&warnings()===1);
  if(mode==='recovery'){phase=1;emit(1,'idle');await until(()=>posts===2);phase=0;emit(2,'work');await until(()=>warnings()===2);}
  else{emit(1,'idle');emit(2,'work');await until(()=>gets===3);await sleep(100);assert.equal(warnings(),1,err);}
  const view=inspectSpool(f.c);assert.equal(view.observation.generation,1);assert.equal(view.capacity.usage.operations,3);
  if(mode==='identity503'){assert.equal(posts,0);assert.equal(view.counts.find(r=>r.state==='pending').count,3);}
  if(mode==='post503'){assert.equal(posts,3);assert.equal(new Set(wires).size,1);assert.equal(view.counts.find(r=>r.state==='unknown').count,1);assert.equal(view.counts.find(r=>r.state==='pending').count,2);}
  if(mode==='recovery'){assert.equal(warnings(),2);assert.equal(posts,2);assert.equal(view.counts.find(r=>r.state==='saved').count,2);}
  child.kill('SIGTERM');assert.equal((await done).code,0,err);
});

test('injected WAL headroom stat blocks writes without dropping unknown and reports a fixed cause', () => {
  const f=fixture(),s=new Spool(f.c,{init:true});s.enqueue(createInput());const row=s.prepare(),before=facts(s),original=fs.lstatSync;
  fs.lstatSync=(path,...args)=>{const value=original(path,...args);if(path===`${f.c.spool}-wal`)value.size=MAX_FILE_BYTES-1024*1024+1;return value;};syncBuiltinESMExports();
  try{assert.equal(s.capacityStatus().reason,'STORAGE_HEADROOM');assert.throws(()=>s.saved(row,ack),/SPOOL_FULL/);assert.equal(facts(s),before);assert.equal(inspectSpool(f.c).capacity.reason,'STORAGE_HEADROOM');}
  finally{fs.lstatSync=original;syncBuiltinESMExports();}
  assert.equal(s.prepare().wire,row.wire);s.saved(row,ack);s.close();
});

test('all business aggregates use one SQL read snapshot even if writer commits between queries', () => {
  const f=fixture(),s=new Spool(f.c,{init:true});s.enqueue(op(1));
  const Original=sqlite.DatabaseSync;let injected=false;
  sqlite.DatabaseSync=class extends Original{prepare(sql){const statement=super.prepare(sql);
    if(sql==='SELECT state,COUNT(*) AS count FROM queue GROUP BY state')return{all(){const rows=statement.all();s.enqueue(op(2));injected=true;return rows;}};
    return statement;}};
  try{const v=inspectSpool(f.c);assert.equal(injected,true);assert.equal(v.counts[0].count,1);assert.equal(v.capacity.usage.operations,1);assert.equal(s.db.prepare('SELECT count(*) AS n FROM queue').get().n,2);}finally{sqlite.DatabaseSync=Original;s.close();}
});

test('product read-only diagnostic reads retained WAL after exact owned child SIGKILL and recreates private SHM', () => {
  const f=fixture(),s=new Spool(f.c,{init:true});s.enqueue(createInput());s.close();
  const child=fileURLToPath(new URL('./crash-child.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[child,f.save(),'prepare'],{encoding:'utf8',timeout:10000});assert.equal(result.signal,'SIGKILL');
  const main=hash(readFileSync(f.c.spool)),wal=hash(readFileSync(`${f.c.spool}-wal`)),lock=readFileSync(`${f.c.spool}.lock`);
  // Exact synthetic child exit positively observed above. No WAL deletion or live-copy recovery.
  renameSync(`${f.c.spool}-shm`,`${f.root}/original-shm`);
  const v=inspectSpool(f.c);assert.equal(v.counts[0].state,'unknown');assert.equal(v.persistence_ack,false);
  assert.equal(hash(readFileSync(f.c.spool)),main);assert.equal(hash(readFileSync(`${f.c.spool}-wal`)),wal);
  assert.deepEqual(readFileSync(`${f.c.spool}.lock`),lock);assert.equal(lstatSync(`${f.c.spool}-shm`).mode&0o777,0o600);
});

test('actual run near byte limit pauses before any GET/generation; two cycles log once; active-writer status works', {timeout:30000}, async t => {
  const f=selected(fixture());let requests=0;const h=await http(t,(_req,res)=>{requests++;json(res,{});});f.c.uniflo.origin=h.origin;f.c.server.base=h.origin;
  const s=new Spool(f.c,{init:true});let n=1;
  while(s.capacityStatus().available_reserved_bytes>recordReserve(canonical(op(n,'漢'.repeat(16000)).payload))+70000){s.enqueue(op(n++,'漢'.repeat(16000)));s.saved(s.prepare(),ack);}
  while(true){const available=s.capacityStatus().available_reserved_bytes,min=recordReserve(canonical(op(n).payload));if(available-min<MIN_RECORD_RESERVE*2)break;
    const length=Math.min(16000,Math.floor((available-min-MIN_RECORD_RESERVE*2)/2));s.enqueue(op(n++,'a'.repeat(length)));s.saved(s.prepare(),ack);}
  const capacity=s.capacityStatus();assert.equal(capacity.admission,'accepting');assert.equal(capacity.observation_reason,'OBSERVATION_HEADROOM');
  const before=facts(s),generation=s.observer().generation;s.close();
  const child=spawn(process.execPath,[cli,'run',f.save()],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  for(let i=0;i<100&&!err.includes('OBSERVATION_HEADROOM');i++)await sleep(20);
  assert.match(err,/OBSERVATION_HEADROOM/);await sleep(2200);const r=status(f);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).lock,'present');
  child.kill('SIGTERM');assert.equal((await done).code,0,err);assert.equal(JSON.parse(out).state,'stopped');assert.equal(requests,0);
  assert.equal(err.split('CONNECTOR_WAITING').length-1,1);const reopened=new Spool(f.c);assert.equal(reopened.observer().generation,generation);assert.equal(facts(reopened),before);
  const remaining=reopened.capacityStatus().available_reserved_bytes,min=recordReserve(canonical(op(n).payload));
  reopened.enqueue(op(n,'a'.repeat(Math.floor((remaining-min)/2))));assert.equal(reopened.capacityStatus().reason,'RESERVED_BYTES');
  const fullFacts=facts(reopened),full=status(f);assert.equal(full.status,0,full.stderr);assert.equal(JSON.parse(full.stdout).capacity.admission,'backpressure');assert.equal(facts(reopened),fullFacts);reopened.close();
});
