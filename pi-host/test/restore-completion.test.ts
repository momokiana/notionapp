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
import{inspectBackupArchive}from'../src/backup-validate.js';
import{installFrozenBackup,frozenRestoreStatus}from'../src/restore-install.js';
const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));const child=fileURLToPath(new URL('./fixtures/restore-completion-window.ts',import.meta.url));const loader=fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url));
async function prepared(){const f=fixture(false);f.init();const raw=await captureBackupMaterial(f.configFile,true);const key=randomBytes(32);const archive=sealBackupArchive(raw.metadata,raw.records,key);const material=inspectBackupArchive(archive,key).material;mkdirSync(join(f.root,'keys'),{mode:0o700});const keyFile=join(f.root,'keys/key');writeFileSync(keyFile,key,{mode:0o600});const archiveFile=join(f.root,'original.backup');writeFileSync(archiveFile,archive,{mode:0o600});const scope=Buffer.from(JSON.stringify({config:f.configFile,registry:f.authFile,initial_prompt:f.value.initial_prompt_file,data_dir:f.value.data_dir}));const scopeFile=join(f.root,'scope.json');writeFileSync(scopeFile,scope,{mode:0o600});renameSync(f.value.data_dir,f.value.data_dir+'.retained-original');const intent=join(f.root,'restore-intent');return{f,material,scope,intent,archiveSha:backupHash(archive),inputs:{archive:archiveFile,keyFile,scopeFile,intent,writersQuiesced:true}};}

test('F1 control: exact final payload/completion with disabled execution still returns complete',async()=>{const p=await prepared();const result=await installFrozenBackup(p.material,p.archiveSha,p.scope,p.inputs,async()=>{})as{state:string;execution_enabled:boolean};assert.equal(result.state,'frozen_install_complete');assert.equal(result.execution_enabled,false);assert.equal((frozenRestoreStatus(p.intent)as{state:string}).state,'frozen_install_observed_complete');});
for(const role of ['native','completion']as const)test(`F1 rejects ${role} mutation at the last owned checkpoint without reverting corrupted bytes or replacing the original intent`,async()=>{
  const p=await prepared();const native=JSON.parse(p.material.records.find(r=>r.name==='manifest')!.bytes.toString()).session_file;const target=role==='native'?native:join(p.intent,'COMPLETE.json');let changed=false;let altered:Buffer|undefined;let metadata:Buffer|undefined;
  await assert.rejects(installFrozenBackup(p.material,p.archiveSha,p.scope,p.inputs,async()=>{if(!changed&&existsSync(join(p.intent,'COMPLETE.json'))){metadata=readFileSync(join(p.intent,'INTENT.json'));altered=Buffer.concat([readFileSync(target),Buffer.from('X')]);writeFileSync(target,altered,{mode:0o600});changed=true;}}));
  assert.equal(changed,true);assert.deepEqual(readFileSync(target),altered);assert.deepEqual(readFileSync(join(p.intent,'INTENT.json')),metadata);assert.equal((frozenRestoreStatus(p.intent)as{state:string}).state,'frozen_install_incomplete');
});
test('F1 compiled CLI rejects both payload/completion changes at installer-final and later CLI-final boundaries before successful stdout',async()=>{
  const observations:object[]=[];let refused=0;
  for(const phase of ['installer-final','cli-final'])for(const role of ['native','completion']){
    const p=await prepared();const native=JSON.parse(p.material.records.find(r=>r.name==='manifest')!.bytes.toString()).session_file;const args=['restore-install','--archive',p.inputs.archive,'--key-file',p.inputs.keyFile,'--scope-file',p.inputs.scopeFile,'--intent',p.intent,'--writers-quiesced'];const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:p.f.root,TMPDIR:process.env.TMPDIR??'/tmp'};
    const result=spawnSync(process.execPath,['--import',loader,child,phase,role,p.intent,native,...args],{encoding:'utf8',timeout:60000,env});assert.equal(result.signal,null,result.stderr);assert.ok(result.stderr.includes(`fault:completion-${phase}-${role}:before-success-stdout:true`),result.stderr);const rejected=result.status!==0&&result.stdout==='';if(rejected)refused++;
    const status=spawnSync(process.execPath,[main,'restore-status','--intent',p.intent],{encoding:'utf8',timeout:30000,env});assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).state,'frozen_install_incomplete');observations.push({phase,role,exit:result.status,rejected_before_stdout:rejected,returned_state:result.stdout.trim()?JSON.parse(result.stdout).state:null});
  }
  console.log(JSON.stringify({purpose:'Exact pre-success boundaries; unchanged original request/intent retained',observations}));assert.equal(refused,4);
});
