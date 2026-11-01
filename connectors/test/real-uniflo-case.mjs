// Runs ONLY inside the validated Bubblewrap namespace. Upstream daemon is real;
// the publishing HTTP receiver is a synthetic protocol fixture, NOT the backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, readlinkSync, readdirSync, fstatSync, openSync, closeSync, existsSync } from 'node:fs';
import { networkInterfaces, hostname, release } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Spool } from '../src/spool.mjs';
import { observeOnce } from '../src/uniflo.mjs';
import { flush } from '../src/transport.mjs';
import { sourceBinding, canonical } from '../src/validation.mjs';
import { seed, appendLive, SELECTED, MARKER } from './real-uniflo-fixtures.mjs';
const boundary = JSON.parse(readFileSync('/work/boundary.json'));
const daemonOrigin = 'http://127.0.0.1:17311';
const allowedEnv = ['HOME','UNIFLO_HOME','UNIFLO_CACHE_DIR','UNIFLO_DATA_DIR','UNIFLO_CONFIG_DIR','UNIFLO_LANG','UNIFLO_NO_UPDATE_CHECK','PATH','PWD','TMPDIR','TZ','LC_ALL','RUST_LOG','NODE_TEST_CONTEXT','NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE'];
const daemonEnv = { HOME:'/work/home', UNIFLO_HOME:'/work/home', UNIFLO_CACHE_DIR:'/work/cache', UNIFLO_DATA_DIR:'/work/data', UNIFLO_CONFIG_DIR:'/work/config', UNIFLO_LANG:'en', UNIFLO_NO_UPDATE_CHECK:'1', PATH:'/tools', PWD:'/work', TMPDIR:'/work/tmp', TZ:'UTC', LC_ALL:'C', RUST_LOG:'error' };
const token = randomBytes(32).toString('hex');
let isolationVerified = false;
const json = (res, body, code = 200) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
async function api(path, options = {}) {
  const response = await fetch(`${daemonOrigin}${path}`, { ...options, headers:{ authorization:`Bearer ${token}`, ...options.headers }, signal:AbortSignal.timeout(1500) });
  const value = await response.json(); return { response, value };
}
async function until(predicate, code, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(50); }
  throw Error(code);
}
async function listen(server) { await new Promise(r => server.listen(0,'127.0.0.1',r)); return `http://127.0.0.1:${server.address().port}`; }
async function closeServer(server) { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
function startDaemon() {
  const child = spawn('/case/uniflo', ['daemon','--foreground','--bind','127.0.0.1:17311','--read-only','--no-cache','--no-update-check','--no-price-sync','--no-fts'], { env:{...daemonEnv,UNIFLO_TOKEN:token}, cwd:'/work', stdio:['ignore','pipe','pipe'] });
  let bytes = 0, overflow = false;
  const collect = b => { bytes += b.length; if (bytes > 65536) { overflow = true; child.kill('SIGKILL'); } };
  child.stdout.on('data',collect); child.stderr.on('data',collect);
  const closed = new Promise((resolve,reject) => { child.once('error',reject); child.once('close',(code,signal)=>resolve({code,signal})); });
  return {child,closed,overflow:()=>overflow};
}
async function stopDaemon(d, disconnectOwnStream) {
  if (!d) return;
  if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGINT');
  // Axum gracefully drains active NDJSON. Explicitly close OUR stream after signalling;
  // do not misreport a forced SIGKILL as successful graceful shutdown.
  await disconnectOwnStream?.();
  const timer = setTimeout(()=>d.child.kill('SIGKILL'),4000);
  try { const result = await d.closed; assert.equal(d.overflow(),false); assert.equal(result.code,0,'owned daemon must stop gracefully'); return result; }
  finally { clearTimeout(timer); }
}

test('C01 real runner isolation revokes outside stdin/fd capabilities before any upstream execution', () => {
  assert.equal(boundary.worker_received_stdin_canary,true); assert.equal(boundary.worker_received_fd3_canary,true);
  assert.equal(existsSync(boundary.canary),false);
  for (const fd of readdirSync('/proc/self/fd')) {
    try { const s = fstatSync(Number(fd)); assert.equal(s.dev === boundary.dev && s.ino === boundary.ino,false,'inherited outside canary FD'); }
    catch (e) { if (e.code !== 'EBADF') throw e; }
  }
  assert.equal(readlinkSync(`/proc/${process.ppid}/fd/0`),'/dev/null');
  assert.ok(Object.keys(process.env).every(k=>allowedEnv.includes(k)));
  for (const n of Object.keys(boundary.namespaces)) assert.notEqual(readlinkSync(`/proc/self/ns/${n}`),boundary.namespaces[n]);
  assert.deepEqual(Object.keys(networkInterfaces()),['lo']); assert.equal(hostname(),'connector-uniflo-fixture');
  assert.equal(existsSync('/home'),false); assert.equal(existsSync('/mnt'),false);
  for (const path of ['/not-allowed','/case/not-allowed','/tools/not-allowed','/proc/not-allowed','/dev/not-allowed']) assert.throws(()=>writeFileSync(path,'x'));
  writeFileSync('/work/case-write-probe','synthetic');
  const fd = openSync('/work/spool/probe.sqlite','w',0o600); closeSync(fd);
  const v = spawnSync('/case/uniflo',['--version'],{env:daemonEnv,stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:4096});
  assert.equal(v.status,0); assert.equal(v.stdout.toString().trim(),'uniflo 0.2.6');
  isolationVerified = true;
});

test('C02-C04 official daemon decodes two synthetic harnesses, live metadata and lower-seq restart retain original mappings', {timeout:80000}, async t => {
  assert.equal(isolationVerified,true,'ISOLATION_NOT_VERIFIED: never start daemon after a failed isolation test');
  const files = seed('/work/home'); let daemon, spool, observer, controller;
  const requests = [], snapshotWatermarks = [], remote = new Map(), operations = new Map(); let streamReady;
  let observationCallbacks = 0;
  const streamed = () => new Promise(r=>{streamReady=r;}); let connected = streamed();
  const proxy = createServer(async(req,res)=>{
    try {
      assert.equal(req.method,'GET'); requests.push(new URL(req.url,daemonOrigin).pathname);
      const response = await fetch(`${daemonOrigin}${req.url}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(65000)});
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if (req.url.startsWith('/v1/stream.ndjson')) streamReady();
      const reader = response.body.getReader(); res.on('close',()=>reader.cancel().catch(()=>{}));
      while(true){const {done,value}=await reader.read();if(done)break;res.write(value);} res.end();
    } catch {res.destroy();}
  });
  const proxyOrigin = await listen(proxy);
  const server = createServer(async(req,res)=>{
    try {
      if (req.url==='/v1/source/self') return json(res,{id:c.server.id,owner_id:c.server.owner_id,source_id:c.server.source_id,source_epoch:c.server.source_epoch,capabilities:['publish'],binding_protocol:1});
      const chunks=[];for await(const b of req)chunks.push(b);const p=JSON.parse(Buffer.concat(chunks));
      assert.equal(req.method,'POST');assert.equal(p.source_binding,sourceBinding(c));assert.equal(req.headers['x-notionapp-source-binding'],sourceBinding(c));
      const op=`${req.url}:${p.request_id??p.update_id}`, fingerprint=canonical(p), prior=operations.get(op);
      if(prior){assert.equal(prior.fingerprint,fingerprint);return json(res,prior.ack);}
      let id,version;
      if(req.url==='/v1/events'){id=`synthetic_event_${remote.size+1}`;version=1;remote.set(id,{payload:p,version,history:[p]});}
      else{ id=req.url.split('/')[3];const event=remote.get(id);assert.ok(event);assert.equal(p.expected_event_version,event.version);version=++event.version;event.payload=p;event.history.push(p);}
      const ack={event_id:id,event_version:version,saved_at:new Date().toISOString()};operations.set(op,{fingerprint,ack});json(res,ack);
    }catch{res.destroy();}
  });
  const base = await listen(server);
  const c={spool:'/work/spool/transport.sqlite',allow_loopback_http:true,server:{base,owner_id:'synthetic_owner',id:'synthetic_actor',source_id:'synthetic_source',source_epoch:'epoch_1',installation:'synthetic_real_install',token:randomBytes(32).toString('hex')},uniflo:{origin:proxyOrigin,token,sessions:SELECTED}};
  t.after(async()=>{
    controller?.abort();if(daemon){await stopDaemon(daemon);daemon=undefined;}
    await observer?.catch(()=>{});spool?.close();await closeServer(proxy);await closeServer(server);
  });
  daemon=startDaemon(); await until(async()=>{try{return(await api('/v1/health')).value.ok===true;}catch{return false;}},'DAEMON_NOT_READY');
  const health=(await api('/v1/health')).value;assert.equal(health.schema,1);assert.equal(health.read_only,true);
  const forbidden=await api('/v1/cleanup/plan',{method:'POST',headers:{'content-type':'application/json','x-uniflo-write':'1'},body:'{"sessions":[]}'});
  assert.equal(forbidden.response.status,403);assert.equal(JSON.stringify(forbidden.value).includes('read-only'),true);
  for(const selected of SELECTED){
    const path=`/v1/sessions/${encodeURIComponent(selected.key)}`;
    const snapshot=await api(path);assert.equal(snapshot.response.status,200);assert.equal(snapshot.value.key,selected.key);
    // Test-only read of our exact synthetic transcript proves actual decoder UTF-8;
    // the connector itself still never requests transcript/history endpoints.
    const transcript=await api(`${path}/events?limit=5&max_text=512`);
    assert.equal(transcript.response.status,200);assert.ok(transcript.value.events.some(e=>e.text?.includes(MARKER)));
  }
  spool=new Spool(c,{init:true}); controller=new AbortController();
  observer=observeOnce(spool,{signal:controller.signal,onObservation:async()=>{
    observationCallbacks++;
    if(observationCallbacks<=2)snapshotWatermarks.push(spool.db.prepare('SELECT MAX(watermark) AS n FROM maps').get().n);
    await flush(spool);
    if(observationCallbacks===1){
      // Real file mutation BETWEEN the two snapshots and before subscribe.
      // The actual daemon must replay the first source after hello without rolling back the second.
      appendLive(files,'snapshot_window');
      await until(async()=>{try{return(await api('/v1/health')).value.seq>15;}catch{return false;}},'SNAPSHOT_WINDOW_NOT_INDEXED');
    }
  }});observer.catch(()=>{});
  await connected;assert.equal(remote.size,2);assert.equal(spool.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE kind='create'").get().n,2);
  assert.ok(snapshotWatermarks[1]>snapshotWatermarks[0]);
  appendLive(files);
  await until(()=>[...remote.values()].every(e=>JSON.parse(e.payload.body).state==='idle'&&e.history.some(p=>JSON.parse(p.body).event_kind==='assistant_message'))&&spool.db.prepare('SELECT MAX(watermark) AS n FROM maps').get().n>15,'LIVE_DECODING_NOT_OBSERVED');
  const rows=spool.db.prepare('SELECT payload FROM queue').all();
  assert.ok(rows.some(r=>JSON.parse(JSON.parse(r.payload).body).event_kind==='assistant_message'));
  const oldWatermark=spool.db.prepare('SELECT MAX(watermark) AS n FROM maps').get().n;
  await stopDaemon(daemon,async()=>{controller.abort();await assert.rejects(observer);observer=undefined;});daemon=undefined;
  assert.equal(spool.status().observation.state,'disconnected');spool.close();spool=undefined;
  appendLive(files,'offline');daemon=startDaemon();
  await until(async()=>{try{return(await api('/v1/health')).value.ok===true;}catch{return false;}},'DAEMON_RESTART_NOT_READY');
  const restartedSeq=(await api('/v1/health')).value.seq;assert.ok(restartedSeq<oldWatermark,'actual daemon sequence must roll back');
  connected=streamed();spool=new Spool(c);controller=new AbortController();
  observer=observeOnce(spool,{signal:controller.signal,onObservation:()=>flush(spool)});observer.catch(()=>{});await connected;
  assert.equal(remote.size,2);assert.equal(spool.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE kind='create'").get().n,2);
  assert.ok([...remote.values()].every(e=>JSON.parse(e.payload.body).mode==='snapshot_after_gap'));
  appendLive(files,'second_live');
  await until(()=>spool.db.prepare('SELECT MAX(watermark) AS n FROM maps').get().n>15,'SECOND_LIVE_NOT_OBSERVED');
  // Controlled fault of the exact owned child, not a graceful-stop success claim.
  daemon.child.kill('SIGKILL');const abrupt=await daemon.closed;assert.equal(abrupt.signal,'SIGKILL');daemon=undefined;
  await assert.rejects(observer);observer=undefined;
  assert.equal(spool.status().observation.state,'disconnected');assert.notEqual(spool.status().observation.reason,'STOPPED');
  spool.close();spool=undefined;appendLive(files,'second_offline');daemon=startDaemon();
  await until(async()=>{try{return(await api('/v1/health')).value.ok===true;}catch{return false;}},'FAULT_RESTART_NOT_READY');
  connected=streamed();spool=new Spool(c);controller=new AbortController();
  observer=observeOnce(spool,{signal:controller.signal,onObservation:()=>flush(spool)});observer.catch(()=>{});await connected;
  assert.equal(remote.size,2);assert.equal(spool.db.prepare("SELECT COUNT(*) AS n FROM queue WHERE kind='create'").get().n,2);
  const uploaded=JSON.stringify([...remote.values()]);
  for(const forbiddenText of [MARKER,'FIXTURE_PRIVATE_TITLE','FIXTURE_PRIVATE_PATH',...SELECTED.map(s=>s.key),'synthetic_unselected'])assert.equal(uploaded.includes(forbiddenText),false);
  assert.ok([...remote.values()].every(e=>JSON.parse(e.payload.body).history_complete===false));
  assert.ok([...remote.values()].every(e=>e.history.every(p=>!Object.hasOwn(p,'interaction'))));
  assert.ok(requests.every(path=>path==='/v1/health'||path==='/v1/stream.ndjson'||path.startsWith('/v1/sessions/')));
  await stopDaemon(daemon,async()=>{controller.abort();await assert.rejects(observer);observer=undefined;});daemon=undefined;
  const result={upstream:'Uniflo 0.2.6 official Linux x64 musl',node:process.version,kernel:release(),harnesses:['claude synthetic JSONL','codex synthetic JSONL'],actual_daemon:true,publishing_receiver:'synthetic HTTP protocol fixture, NOT actual backend',selected:2,creates:2,snapshot_window_watermarks:snapshotWatermarks,old_watermark:oldWatermark,restarted_seq:restartedSeq,history_complete:false,private_markers_uploaded:false,source_received:false,stop_mode:'SIGINT then explicit cancellation of our NDJSON stream for graceful drain',fault_mode:'SIGKILL exact owned daemon; observed exit then unprompted stream gap and same-spool restart'};
  writeFileSync('/work/result.json',JSON.stringify(result,null,2),{mode:0o600});t.diagnostic(JSON.stringify(result));
});
