import assert from'node:assert/strict';
import test from'node:test';
import{mkdirSync,writeFileSync,readFileSync,renameSync,existsSync}from'node:fs';
import{join}from'node:path';
import{randomBytes}from'node:crypto';
import{spawnSync}from'node:child_process';
import{fileURLToPath}from'node:url';
import{fixture}from'./helpers.js';
import{captureBackupMaterial}from'../src/backup-capture.js';
import{sealBackupArchive,backupHash}from'../src/backup-format.js';
import{writeBackupFileExclusive}from'../src/backup-files.js';
import{acquireOwnerLock}from'../src/native.js';
import{recoveryPendingPath}from'notification-server/recovery-gate';
const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));
async function prepared(f=fixture(false)){f.init();const material=await captureBackupMaterial(f.configFile,true);const keys=join(f.root,'keys');mkdirSync(keys,{mode:0o700});const key=join(keys,'backup.key');const keyBytes=randomBytes(32);writeFileSync(key,keyBytes,{mode:0o600});const archive=join(f.root,'snapshot.backup');writeBackupFileExclusive(archive,sealBackupArchive(material.metadata,material.records,keyBytes));const scope=join(f.root,'scope.json');const value={config:f.configFile,registry:f.authFile,initial_prompt:f.value.initial_prompt_file,data_dir:f.value.data_dir};writeFileSync(scope,JSON.stringify(value,null,2)+'\n',{mode:0o600});const intent=join(f.root,'restore-intent');return{f,material,key,keyBytes,archive,scope,value,intent};}
function run(f:ReturnType<typeof fixture>,args:string[]){return spawnSync(process.execPath,[main,...args],{encoding:'utf8',timeout:60000,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root,TMPDIR:process.env.TMPDIR??'/tmp'}});}
const args=(p:Awaited<ReturnType<typeof prepared>>)=>['restore-install','--archive',p.archive,'--key-file',p.key,'--scope-file',p.scope,'--intent',p.intent,'--writers-quiesced'];

test('actual compiled frozen install/status/same intent replay preserves original Native bytes and blocks ordinary normal/paused/preflight entries',async()=>{
  const p=await prepared();const native=p.material.records.find(r=>r.name==='native')!.bytes;const originalArchive=readFileSync(p.archive);renameSync(p.f.value.data_dir,p.f.value.data_dir+'.retained-post-backup');
  const first=run(p.f,args(p));assert.equal(first.status,0,first.stderr);const installed=JSON.parse(first.stdout);assert.equal(installed.state,'frozen_install_complete');assert.equal(installed.execution_enabled,false);assert.equal(installed.current_permissions_verified,false);assert.equal(installed.post_snapshot_effects_reconciled,false);assert.equal(installed.model_budget_reconciled,false);
  const manifestPath=join(p.f.value.data_dir,'manifest.json');const manifest=JSON.parse(readFileSync(manifestPath,'utf8'))as{session_file:string};assert.deepEqual(readFileSync(manifest.session_file),native);assert.deepEqual(readFileSync(p.archive),originalArchive);
  const status=run(p.f,['restore-status','--intent',p.intent]);assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).state,'frozen_install_observed_complete');assert.equal(JSON.parse(status.stdout).original_install_durability_ack_reconstructed,false);
  const second=run(p.f,args(p));assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).restore_id,installed.restore_id);assert.deepEqual(readFileSync(manifest.session_file),native);
  for(const command of [['serve'],['serve','--source-paused'],['preflight'],['init']]){const out=run(p.f,[command[0]!,'--config',p.f.configFile,...command.slice(1)]);assert.notEqual(out.status,0);assert.equal(out.stdout,'');assert.equal(JSON.parse(out.stderr).error,'RESTORE_PENDING');}
  assert.equal(first.stdout.includes(p.f.userToken),false);assert.equal(first.stdout.includes(p.keyBytes.toString('hex')),false);
});
test('named restore and offline status need no original persona/settings/model credentials and never recreate those excluded references',async()=>{
  const f=fixture(false,{provider:'openai',id:'gpt-4o'});const persona=join(f.root,'external-persona.txt'),settings=join(f.root,'external-settings.json'),credentials=join(f.root,'missing-external-auth.json');const text='Synthetic external persona; never part of recovery records';writeFileSync(persona,text,{mode:0o600});writeFileSync(settings,JSON.stringify({defaultProvider:'openai',defaultModel:'gpt-4o',defaultThinkingLevel:'off'}),{mode:0o600});writeFileSync(f.configFile,JSON.stringify({...f.value,identity_reference:{name:'Synthetic missing references',persona_file:persona,persona_sha256:backupHash(Buffer.from(text)),settings_file:settings,credentials_file:credentials}}),{mode:0o600});writeFileSync(credentials,JSON.stringify({openai:{type:'api_key',key:'sk-synthetic-named-initialization-only'}}),{mode:0o600});const p=await prepared(f);renameSync(credentials,credentials+'.retained');
  renameSync(persona,persona+'.retained');renameSync(settings,settings+'.retained');renameSync(f.value.data_dir,f.value.data_dir+'.retained-post-backup');const result=run(f,args(p));assert.equal(result.status,0,result.stderr);const status=run(f,['restore-status','--intent',p.intent]);assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).state,'frozen_install_observed_complete');assert.equal(existsSync(persona),false);assert.equal(existsSync(settings),false);assert.equal(existsSync(credentials),false);
});
test('an occupied original mutable root is refused without replacing files or creating an installation intent',async()=>{
  const p=await prepared();const ledger=join(p.f.value.data_dir,'ledger.sqlite');const before=readFileSync(ledger);const manifest=readFileSync(join(p.f.value.data_dir,'manifest.json'));const result=run(p.f,args(p));assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).error,'RESTORE_TARGET_CONFLICT');assert.deepEqual(readFileSync(ledger),before);assert.deepEqual(readFileSync(join(p.f.value.data_dir,'manifest.json')),manifest);assert.equal(existsSync(p.intent),false);
});
test('an actual competing owner process blocks before pending publication; only the same original intent continues after release',async()=>{
  const p=await prepared();renameSync(p.f.value.data_dir,p.f.value.data_dir+'.retained-post-backup');mkdirSync(p.f.value.data_dir,{mode:0o700});const release=acquireOwnerLock(p.f.value.data_dir);let id='';
  try{const blocked=run(p.f,args(p));assert.notEqual(blocked.status,0);assert.equal(blocked.stdout,'');assert.equal(JSON.parse(blocked.stderr).error,'APP_DIRECTORY_ALREADY_OWNED');id=JSON.parse(readFileSync(join(p.intent,'INTENT.json'),'utf8')).restore_id;assert.equal(existsSync(recoveryPendingPath(join(p.f.value.data_dir,'ledger.sqlite'))),false);}finally{release();}
  const continued=run(p.f,args(p));assert.equal(continued.status,0,continued.stderr);assert.equal(JSON.parse(continued.stdout).restore_id,id);
});
test('wrong key/scope and unsupported thaw/duplicate flags never publish original target resources',async()=>{
  const p=await prepared();renameSync(p.f.value.data_dir,p.f.value.data_dir+'.retained-post-backup');const wrong=join(p.f.root,'keys/wrong.key');writeFileSync(wrong,randomBytes(32),{mode:0o600});const vector=args(p);vector[vector.indexOf('--key-file')+1]=wrong;const badKey=run(p.f,vector);assert.notEqual(badKey.status,0);assert.equal(JSON.parse(badKey.stderr).error,'BACKUP_AUTHENTICATION_FAILED');assert.equal(existsSync(p.intent),false);assert.equal(existsSync(p.f.value.data_dir),false);
  writeFileSync(p.scope,JSON.stringify({...p.value,data_dir:join(p.f.root,'not-original')}),{mode:0o600});const badScope=run(p.f,args(p));assert.notEqual(badScope.status,0);assert.equal(JSON.parse(badScope.stderr).error,'RESTORE_SCOPE_NOT_ORIGINAL');assert.equal(existsSync(p.intent),false);assert.equal(existsSync(p.f.value.data_dir),false);
  for(const vector of [['restore-status','--intent',p.intent,'--intent',p.intent],['restore-install','--thaw'],args(p).slice(0,-1)]){const out=run(p.f,vector);assert.notEqual(out.status,0);assert.equal(JSON.parse(out.stderr).error,'INVALID_RESTORE_ARGUMENTS');assert.equal(out.stdout,'');}
});
