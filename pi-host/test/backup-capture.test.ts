import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { DeviceStore } from 'notification-server/device-store';
import { SourcePump } from 'notification-server/source-adapter';
import { AppRuntime } from '../src/runtime.js';
import { inspectBackupArchive } from '../src/backup-validate.js';
import { captureBackupMaterial } from '../src/backup-capture.js';
import { backupHash, sealBackupArchive, openBackupArchive } from '../src/backup-format.js';
import { fixture } from './helpers.js';

const backend = createRequire(new URL('../../server/package.json', import.meta.url)).resolve('better-sqlite3');

function prepared(managed = false) {
  const f=fixture(false); f.init();
  let storeId: string | undefined; const path=join(f.root,'authority.sqlite');
  if(managed) {
    storeId=DeviceStore.initialize(path).store_id; const store=new DeviceStore(path,storeId);
    try { const id=randomUUID(); const secret=randomBytes(32).toString('hex'); store.createInvitation('operator',{request_id:id,invitation_id:id,secret,owner_id:'fixture-owner',label:'Synthetic archive device',manage_devices:false,expires_at:Date.now()+60000}); store.claim({invitation_id:id,secret,token:randomBytes(32).toString('hex'),claim_id:randomUUID()},()=>{}); }
    finally {store.close();}
    writeFileSync(f.configFile,JSON.stringify({...f.value,device_auth:{path,store_id:storeId}}));
  }
  writeFileSync(join(f.config.data_dir,'agent/auth.json'),'SYNTHETIC malformed model auth, deliberately unused',{mode:0o600});
  return {f,path,storeId};
}

test('capture requires explicit writer quiescence before reading any config or opening a runtime', async () => {
  await assert.rejects(captureBackupMaterial('/not-an-authorized-config-path',false),/BACKUP_WRITERS_MUST_BE_QUIESCED/);
});

test('original backup capture stays on strict paused admission and never reads unused model content or executes a source branch', async () => {
  const {f}=prepared(); const config=f.config; const manifest=readFileSync(join(config.data_dir,'manifest.json')); const nativeFile=(JSON.parse(manifest.toString()) as {session_file:string}).session_file; const native=readFileSync(nativeFile);
  const open=fs.openSync; const create=ModelRuntime.create; const tick=AppRuntime.prototype.runOnce; const pump=SourcePump.prototype.runOnce; const fetchBefore=globalThis.fetch;
  const forbidden=new Set(['auth.json','models.json','models-store.json'].map(name=>join(config.data_dir,'agent',name)));
  fs.openSync=((path:fs.PathLike,...args:unknown[])=>{if(typeof path==='string'&&forbidden.has(path))throw new Error('Unused model content must not be opened');return (open as (...v:unknown[])=>number)(path,...args);}) as typeof fs.openSync;
  ModelRuntime.create=async()=>{throw new Error('No model runtime');}; AppRuntime.prototype.runOnce=()=>{throw new Error('No tick');}; SourcePump.prototype.runOnce=()=>{throw new Error('No pump');}; globalThis.fetch=async()=>{throw new Error('No network');}; syncBuiltinESMExports();
  try {
    const material=await captureBackupMaterial(f.configFile,true); const key=randomBytes(32); const roundtrip=openBackupArchive(sealBackupArchive(material.metadata,material.records,key),key);
    assert.deepEqual(roundtrip.records,material.records); assert.deepEqual(material.records.find(r=>r.name==='native')!.bytes,native); assert.deepEqual(material.records.find(r=>r.name==='manifest')!.bytes,manifest);
    assert.equal(material.records.some(r=>r.name==='device-authority'),false); assert.equal(material.records.some(r=>r.bytes.includes(Buffer.from('deliberately unused'))),false);
  } finally {fs.openSync=open;ModelRuntime.create=create;AppRuntime.prototype.runOnce=tick;SourcePump.prototype.runOnce=pump;globalThis.fetch=fetchBefore;syncBuiltinESMExports();}
  assert.deepEqual(readFileSync(nativeFile),native); const reopened=await AppRuntime.open(config,{sourcePaused:true}); await reopened.close();
});

test('actual capture serializes managed authority and ledger in one held window against independent competing writers', async () => {
  const {f,path}=prepared(true); const open=AppRuntime.open; let checked=0;
  AppRuntime.open=async(config,options)=>{
    const r=await open(config,options); const serialize=r.native.database.serialize;
    r.native.database.serialize=(...args)=>{
      const child=spawnSync(process.execPath,['--input-type=commonjs','-e',`const D=require(${JSON.stringify(backend)});const out=[];for(const p of process.argv.slice(1)){const d=new D(p);d.pragma('busy_timeout=0');try{d.exec('BEGIN IMMEDIATE');out.push('unexpected_writer');d.exec('ROLLBACK')}catch(e){out.push(e.code)}finally{d.close()}}console.log(JSON.stringify(out))`,path,join(config.data_dir,'ledger.sqlite')],{encoding:'utf8',timeout:10000});
      assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),['SQLITE_BUSY','SQLITE_BUSY']);checked++;
      return serialize.apply(r.native.database,args);
    };
    return r;
  };
  try {const material=await captureBackupMaterial(f.configFile,true);assert.ok(material.records.find(r=>r.name==='device-authority'));assert.ok(material.records.find(r=>r.name==='ledger'));assert.equal(checked,1);}
  finally {AppRuntime.open=open;}
});

test('observed static registry conflict rejects capture and releases original owner instead of blessing a mixed archive', async () => {
  const {f}=prepared(); const open=AppRuntime.open; const original=readFileSync(f.authFile);
  AppRuntime.open=async(config,options)=>{const r=await open(config,options);const serialize=r.native.database.serialize;r.native.database.serialize=(...args)=>{writeFileSync(f.authFile,Buffer.concat([original,Buffer.from('\n')]));return serialize.apply(r.native.database,args);};return r;};
  try {await assert.rejects(captureBackupMaterial(f.configFile,true),/BACKUP_INPUT_CHANGED/);} finally {AppRuntime.open=open;}
  assert.deepEqual(readFileSync(f.authFile),Buffer.concat([original,Buffer.from('\n')])); const r=await AppRuntime.open(f.config,{sourcePaused:true});await r.close();
});

test('capture rejects a foreign DELETE-mode ledger read-only without changing its bytes, mode or original Native identity',async()=>{
  const {f}=prepared();const path=join(f.config.data_dir,'ledger.sqlite');renameSync(path,path+'.retained-original');
  const Database=createRequire(new URL('../../server/package.json',import.meta.url))('better-sqlite3');const db=new Database(path);db.exec("CREATE TABLE foreign_fact(value TEXT);INSERT INTO foreign_fact VALUES('retain')");db.close();chmodSync(path,0o600);
  const before=readFileSync(path);const manifest=readFileSync(join(f.config.data_dir,'manifest.json'));
  await assert.rejects(captureBackupMaterial(f.configFile,true));assert.deepEqual(readFileSync(path),before);assert.deepEqual(readFileSync(join(f.config.data_dir,'manifest.json')),manifest);
  const probe=new Database(path,{readonly:true,fileMustExist:true});try{assert.equal(probe.pragma('journal_mode',{simple:true}),'delete');assert.equal(probe.pragma('application_id',{simple:true}),0);}finally{probe.close();}
});

test('capture rejects a selected credential aliased as another config read before that authorization body can be opened',async()=>{
  const {f}=prepared();const auth=join(f.value.data_dir,'agent/auth.json');writeFileSync(f.configFile,JSON.stringify({...f.value,push:{origin:'http://127.0.0.1:18089',allow_local_http:true,token_file:auth}}));
  const original=fs.openSync;let attempted=0;fs.openSync=((path:fs.PathLike,...args:unknown[])=>{if(path===auth){attempted++;throw new Error('Selected auth content forbidden');}return(original as(...v:unknown[])=>number)(path,...args);})as typeof fs.openSync;syncBuiltinESMExports();
  try{await assert.rejects(captureBackupMaterial(f.configFile,true),/BACKUP_EXTERNAL_REFERENCE_OVERLAP/);assert.equal(attempted,0);}finally{fs.openSync=original;syncBuiltinESMExports();}
});

test('named capture tolerates missing selected credentials without copying external persona/settings/auth and inspect never follows those references',async()=>{
  const f=fixture(false,{provider:'openai',id:'gpt-4o'});const persona=join(f.root,'external-persona.txt');const settings=join(f.root,'external-settings.json');const auth=join(f.root,'external-model-auth.json');const privatePersona='PRIVATE_SYNTHETIC_EXTERNAL_PERSONA_MARKER_NOT_ARCHIVED_023c';const privateAuth='sk-synthetic-external-model-auth-must-not-copy';
  writeFileSync(persona,privatePersona,{mode:0o600});writeFileSync(settings,JSON.stringify({defaultProvider:'openai',defaultModel:'gpt-4o',defaultThinkingLevel:'off'}),{mode:0o600});writeFileSync(auth,JSON.stringify({openai:{type:'api_key',key:privateAuth}}),{mode:0o600});
  writeFileSync(f.configFile,JSON.stringify({...f.value,identity_reference:{name:'Synthetic archive identity',persona_file:persona,persona_sha256:backupHash(Buffer.from(privatePersona)),settings_file:settings,credentials_file:auth}}));f.init();renameSync(auth,auth+'.retained-original');
  const material=await captureBackupMaterial(f.configFile,true);for(const r of material.records){assert.equal(r.bytes.includes(Buffer.from(privatePersona)),false);assert.equal(r.bytes.includes(Buffer.from(privateAuth)),false);}
  const key=randomBytes(32);const archive=sealBackupArchive(material.metadata,material.records,key);renameSync(persona,persona+'.retained-original');renameSync(settings,settings+'.retained-original');
  const verified=inspectBackupArchive(archive,key);assert.equal(verified.inspection.external_references_checked,false);assert.equal(verified.inspection.current_permissions_verified,false);
  await assert.rejects(captureBackupMaterial(f.configFile,true));
});
