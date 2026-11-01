import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture,fakeModels,manualEvent,respond} from './helpers.js';
import {AppRuntime} from '../src/runtime.js';
import {captureBackupMaterial} from '../src/backup-capture.js';
import {inspectBackupArchive} from '../src/backup-validate.js';
import {sealBackupArchive,type BackupMaterial} from '../src/backup-format.js';

const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
async function prepared(accepted:boolean){
  const f=fixture(false);f.init();const models=await fakeModels(f.root);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});
  try{const e=manualEvent(r);respond(r,f,e.id);if(accepted)await r.runOnce();else{const a=r.currentAuthority();assert.ok(r.delivery.claim(a.principal,randomUUID(),a.registry).command);}}finally{await r.close();}
  assert.equal(models.calls.length,0);const material=await captureBackupMaterial(f.configFile,true);return{f,material};
}
function inspected(material:BackupMaterial){const key=randomBytes(32);return inspectBackupArchive(sealBackupArchive(material.metadata,material.records,key),key).inspection;}
function lostInput(material:BackupMaterial):BackupMaterial{return{...material,records:material.records.map(r=>{
  if(r.name!=='native')return r;const lines=r.bytes.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));assert.equal(lines.length,6);assert.equal(lines[5].customType,'notifier_response');return{...r,bytes:Buffer.from(lines.slice(0,5).map(e=>JSON.stringify(e)+'\n').join(''))};
})};}

test('F1 control: exact original own-session public receipt and Native input remain accepted material',async()=>{const {material}=await prepared(true);const value=inspected(material);assert.equal(value.native_inputs,1);assert.equal(value.historical_receipts,1);});
test('F1 control: claimed but not accepted command remains legal unknown without Native input or public receipt',async()=>{const {material}=await prepared(false);const value=inspected(material);assert.equal(value.commands,1);assert.equal(value.native_inputs,0);assert.equal(value.historical_receipts,0);});
test('F1: authenticated material with original own-session receipt but missing exact Native input is refused without rewriting either fact',async()=>{
  const {material}=await prepared(true);const changed=lostInput(material);const receiptBefore=Buffer.from(changed.records.find(r=>r.name==='ledger')!.bytes);const nativeBefore=Buffer.from(changed.records.find(r=>r.name==='native')!.bytes);
  assert.throws(()=>inspected(changed));assert.deepEqual(changed.records.find(r=>r.name==='ledger')!.bytes,receiptBefore);assert.deepEqual(changed.records.find(r=>r.name==='native')!.bytes,nativeBefore);
});

test('F1 compiled create/inspect/stage all refuse the same orphan own-session receipt and never produce completion artifacts',async()=>{
  const {f,material}=await prepared(true);const changed=lostInput(material);const keyBytes=randomBytes(32);const key=join(f.root,'key');writeFileSync(key,keyBytes,{mode:0o600});
  const authenticated=join(f.root,'orphan-original.backup');writeFileSync(authenticated,sealBackupArchive(changed.metadata,changed.records,keyBytes),{mode:0o600});const originalArchive=readFileSync(authenticated);
  const nativePath=(JSON.parse(material.records.find(r=>r.name==='manifest')!.bytes.toString())as{session_file:string}).session_file;const native=changed.records.find(r=>r.name==='native')!.bytes;
  writeFileSync(nativePath+'.retained-full-original',material.records.find(r=>r.name==='native')!.bytes,{mode:0o600,flag:'wx'});writeFileSync(nativePath,native);
  const out=join(f.root,'must-not-complete.backup');const stage=join(f.root,'must-not-stage');
  for(const args of [
    ['backup-create','--config',f.configFile,'--out',out,'--key-file',key,'--writers-quiesced'],
    ['backup-inspect','--archive',authenticated,'--key-file',key],
    ['backup-stage','--archive',authenticated,'--key-file',key,'--out-dir',stage],
  ]){const result=spawnSync(process.execPath,[main,...args],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root,TMPDIR:process.env.TMPDIR??'/tmp'}});assert.notEqual(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).error,'BACKUP_MATERIAL_INVALID');}
  assert.equal(existsSync(out),false);assert.equal(existsSync(stage),false);assert.deepEqual(readFileSync(nativePath),native);assert.deepEqual(readFileSync(authenticated),originalArchive);
});

test('F1 scope control: an unrelated source/session historical self-reported receipt is not required to appear in this Native file',async()=>{
  const f=fixture(false);f.principals.push({id:'other-source-actor',owner_id:'fixture-owner',kind:'source',source_id:'other-source',source_epoch:'other-epoch',token:randomBytes(32).toString('hex'),capabilities:['publish','reply','deliver','read_responses']});f.saveGrants();f.init();
  const models=await fakeModels(f.root);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});
  try{const registry=r.registry();const source=registry.source('fixture-owner','other-source','other-epoch')!;
    const event=r.core.create(source,{request_id:randomUUID(),title:'Other source historical record',body:'Source-reported only, not this SDK session',session_ref:'other-native-session',target_revision:'other-revision',expires_at:'2099-01-01T00:00:00Z',interaction:{id:'other_question',actions:[{id:'confirm',type:'button',label:'Other source button'}]}});
    respond(r,f,event.event_id);const c=r.delivery.claim(source,randomUUID(),registry).command!;r.delivery.receipt(source,c.id,c.id,{command_id:c.id,session_ref:'other-native-session',state_revision:'other-revision',message_id:'other-source-reported-entry'});
  }finally{await r.close();}
  const value=inspected(await captureBackupMaterial(f.configFile,true));assert.equal(value.historical_receipts,1);assert.equal(value.native_inputs,0);assert.equal(value.model_request_intents,0);
});
