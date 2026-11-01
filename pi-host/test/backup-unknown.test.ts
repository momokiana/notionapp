import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { DeviceStore, credentialHash } from 'notification-server/device-store';
import { AppRuntime } from '../src/runtime.js';
import { captureBackupMaterial } from '../src/backup-capture.js';
import { inspectBackupArchive } from '../src/backup-validate.js';
import { backupHash, sealBackupArchive } from '../src/backup-format.js';
import { fixture, fakeModels, manualEvent, respond, child, exited, ask } from './helpers.js';

async function captured(f:ReturnType<typeof fixture>){const material=await captureBackupMaterial(f.configFile,true);const key=randomBytes(32);return{material,verified:inspectBackupArchive(sealBackupArchive(material.metadata,material.records,key),key)};}
const loader=fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url));

test('backup keeps a real pre-fetch HTTP-attempt SIGKILL unknown and its consumed request slot, with zero underlying fetch',async()=>{
  const f=fixture(true,{provider:'openai',id:'gpt-6-sol'});f.init();writeFileSync(join(f.config.data_dir,'agent/auth.json'),JSON.stringify({openai:{type:'api_key',key:'sk-synthetic-no-network-backup'}}),{mode:0o600});
  const path=fileURLToPath(new URL('./fixtures/source-paused-http-intent.ts',import.meta.url));const c=spawn(process.execPath,['--import',loader,path,f.configFile],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root,NOTIONAPP_SOURCE_PAUSE_CRASH:'1'},stdio:['pipe','pipe','pipe']});
  const killed=await exited(c);assert.equal(killed.signal,'SIGKILL',killed.error);assert.ok(killed.out.includes('fault:source-paused-http-intent'));
  const {material,verified}=await captured(f);assert.equal(verified.inspection.model_request_intents,1);assert.equal(verified.inspection.model_http_attempts,1);assert.equal(verified.inspection.report_intents,0);assert.equal(material.metadata.selection.model_budget.request_limit,3);
  const manifest=JSON.parse(material.records.find(r=>r.name==='manifest')!.bytes.toString())as{session_file:string};assert.deepEqual(readFileSync(manifest.session_file),material.records.find(r=>r.name==='native')!.bytes);
});

test('backup preserves a real durable Native-before-public-receipt SIGKILL without promoting source_received',async()=>{
  const f=fixture(false);f.init();const models=await fakeModels(f.root);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});let response='';
  try{const event=manualEvent(r);response=respond(r,f,event.id);}finally{await r.close();}
  const killed=await exited(child('native-before-public-receipt',f));assert.equal(killed.signal,'SIGKILL',killed.error);
  const {verified}=await captured(f);assert.equal(verified.inspection.native_inputs,1);assert.equal(verified.inspection.native_inputs_without_public_receipt,1);assert.equal(verified.inspection.historical_receipts,0);
  const check=await AppRuntime.open(f.config,{sourcePaused:true});try{assert.equal(check.core.getResponse(f.user(),response,f.registry()).source_delivery?.state,'effect_unknown');}finally{await check.close();}
});

for(const mode of ['report-before-db','report-after-db-before-ack'])test(`backup preserves real ${mode} SIGKILL with exact original report journal and no replay`,async()=>{
  const f=fixture();f.init();const models=await fakeModels(f.root,[ask()]);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});
  try{const event=await r.runOnce()as{event_id:string};respond(r,f,event.event_id);}finally{await r.close();}
  const killed=await exited(child(mode,f));assert.equal(killed.signal,'SIGKILL',killed.error);
  const {material,verified}=await captured(f);assert.equal(verified.inspection.model_request_intents,2);assert.equal(verified.inspection.report_intents,2);assert.equal(verified.inspection.native_inputs,1);assert.equal(verified.inspection.historical_receipts,1);
  const manifest=JSON.parse(material.records.find(r=>r.name==='manifest')!.bytes.toString())as{session_file:string};assert.deepEqual(readFileSync(manifest.session_file),material.records.find(r=>r.name==='native')!.bytes);
  const check=await AppRuntime.open(f.config,{sourcePaused:true});try{assert.equal(check.native.metadata().filter(v=>v.kind==='report_saved').length,1);}finally{await check.close();}
});

test('three exhausted synthetic request intents and the final original waiting response survive archive inspection without allowance reset',async()=>{
  const f=fixture();f.init();const models=await fakeModels(f.root,[ask(),ask('second'),ask('third')]);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});let waiting='';
  try{const first=await r.runOnce()as{event_id:string};respond(r,f,first.event_id);await r.runOnce();respond(r,f,first.event_id);await r.runOnce();waiting=respond(r,f,first.event_id);}finally{await r.close();}
  const {material,verified}=await captured(f);assert.equal(models.calls.length,3);assert.equal(verified.inspection.model_request_intents,3);assert.equal(material.metadata.selection.model_budget.request_limit,3);assert.equal(verified.inspection.responses,3);assert.equal(verified.inspection.native_inputs,2);
  const check=await AppRuntime.open(f.config,{sourcePaused:true});try{assert.equal(check.core.getResponse(f.user(),waiting,f.registry()).eligibility_state,'waiting_source');}finally{await check.close();}
});

test('actual prepared-handover SIGKILL remains pending in backup while external operator intent/prepared files stay separate and untouched',{timeout:30000},async t=>{
  const f=fixture(false);const path=join(f.root,'authority.sqlite');const storeId=DeviceStore.initialize(path).store_id;writeFileSync(f.configFile,JSON.stringify({...f.value,device_auth:{path,store_id:storeId}}));f.init();
  const intent=join(f.root,'external-original-handover-intent.json');const requestId=randomUUID();const script=fileURLToPath(new URL('../../server/test/fixtures/device-handover-process.ts',import.meta.url));
  const c=fork(script,[],{execArgv:['--import',loader],env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root},stdio:['ignore','ignore','ignore','ipc']});
  t.after(()=>{if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');});
  const [ready]=await once(c,'message');assert.equal((ready as{phase:string}).phase,'ready');
  c.send({path,store_id:storeId,request:{request_id:requestId,device_id:'phone-user',owner_id:'fixture-owner',label:'Synthetic pending handover',manage_devices:false,old_hash:credentialHash(f.userToken),registry_path:f.authFile,original_digest:backupHash(readFileSync(f.authFile))},intent,fault:'prepared',signal:join(f.root,'handover-stage-signal')});
  const [message]=await once(c,'message');assert.equal((message as{phase:string}).phase,'fault');c.kill('SIGKILL');const [,signal]=await once(c,'exit');assert.equal(signal,'SIGKILL');
  const originalIntent=readFileSync(intent);const replacement=f.authFile+`.handover-${requestId}.replacement`;const prepared=readFileSync(replacement);
  const {verified}=await captured(f);assert.equal(verified.inspection.authority_present,true);assert.equal(verified.inspection.current_permissions_verified,false);
  const store=new DeviceStore(path,storeId);try{assert.equal(store.handover(requestId)?.phase,'prepared');assert.equal(store.device('phone-user')?.state,'handover_pending');}finally{store.close();}
  assert.deepEqual(readFileSync(intent),originalIntent);assert.deepEqual(readFileSync(replacement),prepared);
});
