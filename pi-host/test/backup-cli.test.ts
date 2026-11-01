import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, readFileSync, lstatSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
import { AppRuntime } from '../src/runtime.js';
import { unframeBackupMetadata, unframeBackupRecord, sealBackupArchive } from '../src/backup-format.js';
import { inspectBackupArchive } from '../src/backup-validate.js';

const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
function run(root:string,args:string[]){return spawnSync(process.execPath,[main,...args],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:root,TMPDIR:process.env.TMPDIR??'/tmp'}});}

test('actual compiled create/inspect/stage retain an old authenticated snapshot without starting a source or installing active material',async()=>{
  const f=fixture(false);f.init();writeFileSync(join(f.config.data_dir,'agent/auth.json'),'SYNTHETIC deliberately invalid unused authorization',{mode:0o600});
  const key=join(f.root,'backup.key');const keyBytes=randomBytes(32);writeFileSync(key,keyBytes,{mode:0o600});const archive=join(f.root,'snapshot.backup');
  const create=run(f.root,['backup-create','--config',f.configFile,'--out',archive,'--key-file',key,'--writers-quiesced']);assert.equal(create.status,0,create.stderr);const created=JSON.parse(create.stdout);assert.equal(created.state,'backup_created');assert.equal(created.inspection.events,0);assert.equal(created.inspection.model_request_intents,0);assert.equal(lstatSync(archive).mode&0o777,0o600);
  const originalArchive=readFileSync(archive);const runtime=await AppRuntime.open(f.config,{sourcePaused:true});
  try {const a=runtime.currentAuthority();runtime.core.create(a.principal,{request_id:randomUUID(),title:'Later original fact',body:'PRIVATE_LATER_FACT_NOT_IN_OLD_SNAPSHOT',session_ref:runtime.native.manifest.native_id,target_revision:'synthetic_later_revision',expires_at:'2099-01-01T00:00:00Z'});}
  finally {await runtime.close();}
  const inspect=run(f.root,['backup-inspect','--archive',archive,'--key-file',key]);assert.equal(inspect.status,0,inspect.stderr);const inspected=JSON.parse(inspect.stdout);assert.equal(inspected.inspection.events,0);assert.equal(inspected.original_create_durability_ack_verified,false);assert.equal(inspected.inspection.current_permissions_verified,false);
  const stagePath=join(f.root,'inert-material');const stage=run(f.root,['backup-stage','--archive',archive,'--key-file',key,'--out-dir',stagePath]);assert.equal(stage.status,0,stage.stderr);assert.equal(JSON.parse(stage.stdout).active_restore_supported,false);assert.equal(lstatSync(stagePath).mode&0o777,0o700);
  for(const name of readdirSync(stagePath))assert.equal(lstatSync(join(stagePath,name)).mode&0o777,0o600);
  assert.equal(JSON.parse(readFileSync(join(stagePath,'COMPLETE.json'),'utf8')).active_restore_supported,false);assert.throws(()=>JSON.parse(readFileSync(join(stagePath,'config.material'),'utf8')));
  const metadata=unframeBackupMetadata(readFileSync(join(stagePath,'SNAPSHOT-METADATA.material')));assert.equal(metadata.origin_config_file,f.configFile);
  const restored=metadata.records.map(r=>unframeBackupRecord(readFileSync(join(stagePath,r.name+'.material'))));
  assert.equal(inspectBackupArchive(sealBackupArchive(metadata,restored,keyBytes),keyBytes).inspection.events,0);
  const beforeNormalAttempt=readdirSync(stagePath).sort();for(const name of ['config.material','SNAPSHOT-METADATA.material']){const normal=run(f.root,['serve','--config',join(stagePath,name)]);assert.notEqual(normal.status,0);assert.equal(normal.stdout,'');assert.equal(normal.stderr.includes(f.root),false);}assert.deepEqual(readdirSync(stagePath).sort(),beforeNormalAttempt);
  for(const output of [create.stdout,create.stderr,inspect.stdout,inspect.stderr,stage.stdout,stage.stderr])for(const secret of [f.root,f.sourceToken,f.userToken,keyBytes.toString('hex'),'PRIVATE_LATER_FACT_NOT_IN_OLD_SNAPSHOT'])assert.equal(output.includes(secret),false);
  assert.deepEqual(readFileSync(archive),originalArchive);assert.deepEqual(readFileSync(key),keyBytes);
  const current=await AppRuntime.open(f.config,{sourcePaused:true});try {assert.equal((current.native.database.prepare('SELECT count(*) n FROM events').get()as{n:number}).n,1);assert.equal(current.native.metadata().length,0);}finally{await current.close();}
  const again=run(f.root,['backup-stage','--archive',archive,'--key-file',key,'--out-dir',stagePath]);assert.notEqual(again.status,0);assert.deepEqual(readFileSync(archive),originalArchive);
});

test('compiled backup flags are command-specific, duplicate-safe and never replace existing output or accept a wrong key',()=>{
  const f=fixture(false);f.init();const key=join(f.root,'key');writeFileSync(key,randomBytes(32),{mode:0o600});const out=join(f.root,'existing');writeFileSync(out,'retain original artifact',{mode:0o600});
  for(const args of [
    ['backup-create','--config',f.configFile,'--out',out,'--key-file',key],
    ['backup-create','--config',f.configFile,'--out',out,'--key-file',key,'--writers-quiesced','--out',out],
    ['backup-inspect','--archive',out,'--key-file',key,'--writers-quiesced'],
    ['backup-stage','--archive',out,'--key-file',key,'--out-dir',out,'--source-paused'],
    ['backup-create','--config',f.configFile,'--out',out,'--key-file',key,'--writers-quiesced'],
  ]){const result=run(f.root,args);assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr.includes(f.root),false);assert.equal(readFileSync(out,'utf8'),'retain original artifact');}
  const archive=join(f.root,'valid.backup');assert.equal(run(f.root,['backup-create','--config',f.configFile,'--out',archive,'--key-file',key,'--writers-quiesced']).status,0);
  const other=join(f.root,'other-key');writeFileSync(other,randomBytes(32),{mode:0o600});const bad=run(f.root,['backup-inspect','--archive',archive,'--key-file',other]);assert.notEqual(bad.status,0);assert.equal(JSON.parse(bad.stderr).error,'BACKUP_AUTHENTICATION_FAILED');assert.equal(bad.stdout,'');
});

test('compiled backup/stage and verification scratch cannot occupy original runtime roles',()=>{
  const f=fixture(false);f.init();const key=join(f.root,'separate.key');writeFileSync(key,randomBytes(32),{mode:0o600});
  const unsafe=join(f.config.data_dir,'source-pump.json');const create=run(f.root,['backup-create','--config',f.configFile,'--out',unsafe,'--key-file',key,'--writers-quiesced']);assert.notEqual(create.status,0);assert.equal(JSON.parse(create.stderr).error,'BACKUP_OUTPUT_OVERLAP');assert.equal(existsSync(unsafe),false);
  const archive=join(f.root,'safe.backup');assert.equal(run(f.root,['backup-create','--config',f.configFile,'--out',archive,'--key-file',key,'--writers-quiesced']).status,0);
  const stage=join(f.config.data_dir,'do-not-create-material');const staged=run(f.root,['backup-stage','--archive',archive,'--key-file',key,'--out-dir',stage]);assert.notEqual(staged.status,0);assert.equal(JSON.parse(staged.stderr).error,'BACKUP_OUTPUT_OVERLAP');assert.equal(existsSync(stage),false);
  const before=readdirSync(f.config.data_dir).sort();const scratch=spawnSync(process.execPath,[main,'backup-inspect','--archive',archive,'--key-file',key],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root,TMPDIR:f.config.data_dir}});assert.notEqual(scratch.status,0);assert.equal(JSON.parse(scratch.stderr).error,'BACKUP_OUTPUT_OVERLAP');assert.deepEqual(readdirSync(f.config.data_dir).sort(),before);
});
