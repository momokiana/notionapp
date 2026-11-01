import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { AppRuntime } from '../src/runtime.js';
import { validateNativeBackupBytes } from '../src/native.js';
import { captureBackupMaterial } from '../src/backup-capture.js';
import { inspectBackupArchive } from '../src/backup-validate.js';
import { sealBackupArchive, frameBackupRecord, type BackupMaterial } from '../src/backup-format.js';
import { fixture, fakeModels, manualEvent, respond, ask } from './helpers.js';

const Database=createRequire(new URL('../../server/package.json',import.meta.url))('better-sqlite3');
const marker='PRIVATE_SYNTHETIC_EVENT_BODY_BACKUP_VALIDATOR_58d2ef62';
async function populated() {
  const f=fixture(false);f.init();const model=await fakeModels(f.root);const r=await AppRuntime.open(f.config,{modelRuntime:model.runtime});
  try {const e=manualEvent(r,marker);respond(r,f,e.id);await r.runOnce();}
  finally {await r.close();}
  assert.equal(model.calls.length,0);const material=await captureBackupMaterial(f.configFile,true);return {f,material,key:randomBytes(32)};
}
function sealed(material:BackupMaterial,key:Buffer){return sealBackupArchive(material.metadata,material.records,key);}
function changedLedger(material:BackupMaterial, mutate:(db:any)=>void):BackupMaterial {
  const root=mkdtempSync(join(tmpdir(),'notifier-backup-tamper-test-'));chmodSync(root,0o700);const path=join(root,'derived.sqlite');
  writeFileSync(path,material.records.find(r=>r.name==='ledger')!.bytes,{mode:0o600});const db=new Database(path);
  try {const bytes=db.transaction(()=>{mutate(db);return db.serialize();}).immediate() as Buffer;return {...material,records:material.records.map(r=>r.name==='ledger'?{...r,bytes}:r)};}
  finally {db.close();}
}

test('authenticated complex material verifies old events/responses/command/Native without original path IO or current permission claims',async()=>{
  const {f,material,key}=await populated();const native=material.records.find(r=>r.name==='native')!;const original=Buffer.from(native.bytes);const archive=sealed(material,key);
  const open=fs.openSync;const read=fs.readFileSync;const runtimeOpen=AppRuntime.open;
  fs.openSync=((path:fs.PathLike,...args:unknown[])=>{if(typeof path==='string'&&path.startsWith(f.root+'/'))throw new Error('Archive paths are not IO targets');return(open as(...v:unknown[])=>number)(path,...args);})as typeof fs.openSync;
  fs.readFileSync=((path:fs.PathOrFileDescriptor,...args:unknown[])=>{if(typeof path==='string'&&path.startsWith(f.root+'/'))throw new Error('No original reference read');return(read as(...v:unknown[])=>unknown)(path,...args);})as typeof fs.readFileSync;
  AppRuntime.open=async()=>{throw new Error('Inspection must not open a runtime/SDK');};syncBuiltinESMExports();
  try {const result=inspectBackupArchive(archive,key);assert.equal(result.inspection.events,1);assert.equal(result.inspection.responses,1);assert.equal(result.inspection.commands,1);assert.equal(result.inspection.native_inputs,1);assert.equal(result.inspection.historical_receipts,1);assert.equal(result.inspection.model_request_intents,0);assert.equal(result.inspection.active_restore_supported,false);assert.equal(result.inspection.current_permissions_verified,false);assert.equal(JSON.stringify(result.inspection).includes(marker),false);assert.deepEqual(result.material.records,material.records);}
  finally {fs.openSync=open;fs.readFileSync=read;AppRuntime.open=runtimeOpen;syncBuiltinESMExports();}
  assert.deepEqual(readFileSync((JSON.parse(material.records.find(r=>r.name==='manifest')!.bytes.toString()) as {session_file:string}).session_file),original);
});

test('authenticated SQLite with mismatched event or command data is rejected rather than migrated/repaired',async()=>{
  const {material,key}=await populated();
  const wrongEvent=changedLedger(material,db=>{const row=db.prepare('SELECT id,data FROM events').get();const data=JSON.parse(row.data);data.id='another_event';db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),row.id);});
  assert.throws(()=>inspectBackupArchive(sealed(wrongEvent,key),key));
  const wrongCommand=changedLedger(material,db=>{const row=db.prepare('SELECT id,data FROM commands').get();const data=JSON.parse(row.data);data.response.text='NOT_THE_ORIGINAL_RESPONSE';db.prepare('UPDATE commands SET data=? WHERE id=?').run(JSON.stringify(data),row.id);});
  assert.throws(()=>inspectBackupArchive(sealed(wrongCommand,key),key));
});

test('authenticated Native response mismatch is rejected, while inert frames cannot be opened as normal SQLite images',async()=>{
  const {f,material,key}=await populated();
  const changed={...material,records:material.records.map(r=>{if(r.name!=='native')return r;const lines=r.bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));const input=lines.find(e=>e.type==='custom_message'&&e.customType==='notifier_response');const content=JSON.parse(input.content);content.response.text='CORRUPT';input.content=JSON.stringify(content);return {...r,bytes:Buffer.from(lines.map(e=>JSON.stringify(e)+'\n').join(''))};})};
  assert.throws(()=>inspectBackupArchive(sealed(changed,key),key));
  const root=mkdtempSync(join(tmpdir(),'notifier-backup-inert-test-'));chmodSync(root,0o700);const path=join(root,'ledger.material');writeFileSync(path,frameBackupRecord(material.records.find(r=>r.name==='ledger')!),{mode:0o600});
  const db=new Database(path,{readonly:true,fileMustExist:true});try {assert.throws(()=>db.prepare('SELECT * FROM sqlite_schema').all());}finally {db.close();}
  const manifest=JSON.parse(material.records.find(r=>r.name==='manifest')!.bytes.toString())as{native_id:string;cwd:string};
  assert.throws(()=>validateNativeBackupBytes(f.config,manifest,frameBackupRecord(material.records.find(r=>r.name==='native')!)));
});

test('authenticated source report ACK must match the original durable operation/result, not just point to an existing entry',async()=>{
  const f=fixture();f.init();const models=await fakeModels(f.root,[ask()]);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});try{await r.runOnce();}finally{await r.close();}
  const material=await captureBackupMaterial(f.configFile,true);const key=randomBytes(32);inspectBackupArchive(sealed(material,key),key);
  const changed={...material,records:material.records.map(r=>{if(r.name!=='native')return r;const lines=r.bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));const ack=lines.find(e=>e.type==='custom'&&e.customType==='notifier_runtime'&&e.data.value.kind==='report_saved');ack.data.value.event_version++;return{...r,bytes:Buffer.from(lines.map(e=>JSON.stringify(e)+'\n').join(''))};})};
  assert.throws(()=>inspectBackupArchive(sealed(changed,key),key));
});

test('authenticated response history must identify the actual immutable saved response, not only its event',async()=>{
  const {material,key}=await populated();const changed=changedLedger(material,db=>{const row=db.prepare("SELECT seq,data FROM history WHERE kind='response_saved'").get();const value=JSON.parse(row.data);value.id='other_response';db.prepare('UPDATE history SET data=? WHERE seq=?').run(JSON.stringify(value),row.seq);});
  assert.throws(()=>inspectBackupArchive(sealed(changed,key),key));
});
