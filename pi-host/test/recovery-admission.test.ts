import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {recoveryPendingPath} from 'notification-server/recovery-gate';
import {fixture,fakeModels,manualEvent,respond} from './helpers.js';
import {initialize,status,NativeSession} from '../src/native.js';
import {AppRuntime} from '../src/runtime.js';
import {assertConfigNotRecovering} from '../src/recovery-admission.js';
const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
const code=(value:string)=>(error:unknown)=>typeof error==='object'&&error!==null&&'code'in error&&error.code===value;

test('pending with no ledger blocks original init/direct admission without creating a Native identity or owner lock',async()=>{
  const f=fixture(false);const cfg=f.config;mkdirSync(cfg.data_dir,{mode:0o700});writeFileSync(recoveryPendingPath(join(cfg.data_dir,'ledger.sqlite')),'partial recovery marker',{mode:0o600});
  assert.throws(()=>assertConfigNotRecovering(f.configFile),code('RESTORE_PENDING'));assert.throws(()=>initialize(cfg),code('RESTORE_PENDING'));assert.throws(()=>new NativeSession(cfg),code('RESTORE_PENDING'));assert.throws(()=>status(cfg),code('RESTORE_PENDING'));await assert.rejects(AppRuntime.open(cfg,{sourcePaused:true}),code('RESTORE_PENDING'));
  assert.equal(existsSync(join(cfg.data_dir,'native')),false);assert.equal(existsSync(join(cfg.data_dir,'ledger.sqlite')),false);assert.equal(existsSync(join(cfg.data_dir,'owner-lock.sqlite')),false);
});
test('compiled init/status/preflight/normal/paused serve reject pending before missing external identity references, with no success output',()=>{
  const f=fixture(false);f.init();const ledger=join(f.value.data_dir,'ledger.sqlite');writeFileSync(recoveryPendingPath(ledger),'pending',{mode:0o600});
  writeFileSync(f.configFile,JSON.stringify({...f.value,allow_model_calls:true,identity_reference:{name:'Synthetic missing persona',persona_file:join(f.root,'absent-persona'),settings_file:join(f.root,'absent-settings'),credentials_file:join(f.root,'absent-credentials')}}),{mode:0o600});
  const manifest=readFileSync(join(f.value.data_dir,'manifest.json'));const nativePath=(JSON.parse(manifest.toString())as{session_file:string}).session_file;const native=readFileSync(nativePath);const before=readFileSync(ledger);
  for(const args of [['init'],['status'],['preflight'],['serve'],['serve','--source-paused']]){const result=spawnSync(process.execPath,[main,args[0]!, '--config',f.configFile,...args.slice(1)],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root,TMPDIR:process.env.TMPDIR??'/tmp'}});assert.notEqual(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).error,'RESTORE_PENDING');}
  assert.deepEqual(readFileSync(ledger),before);assert.deepEqual(readFileSync(nativePath),native);assert.deepEqual(readFileSync(join(f.value.data_dir,'manifest.json')),manifest);
});
test('already-owned direct Native/model/report tick paths fail closed before SDK input/journal/receipt recovery even with an existing original command',async()=>{
  const f=fixture(false);f.init();const models=await fakeModels(f.root);const r=await AppRuntime.open(f.config,{modelRuntime:models.runtime});
  try{const event=manualEvent(r);respond(r,f,event.id);const a=r.currentAuthority();const command=r.delivery.claim(a.principal,randomUUID(),a.registry).command!;const before=readFileSync(r.native.manifest.session_file);r.native.database.exec('CREATE TABLE restore_fence (damaged TEXT)');
    for(const run of [()=>r.native.append({kind:'must-not-append'}),()=>r.host.target(),()=>r.host.getReceipt(command.id),()=>r.host.compareAndEnqueue(command,Date.now())])assert.throws(run,code('RESTORE_FROZEN'));
    await assert.rejects(r.runOnce(),code('RESTORE_FROZEN'));assert.deepEqual(readFileSync(r.native.manifest.session_file),before);assert.equal(models.calls.length,0);assert.equal((r.native.database.prepare('SELECT attempted FROM commands WHERE id=?').get(command.id)as{attempted:number}).attempted,0);
  }finally{await r.close();}
});
