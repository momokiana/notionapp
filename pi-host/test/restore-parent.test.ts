import assert from'node:assert/strict';
import test from'node:test';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{randomBytes}from'node:crypto';
import{fixture}from'./helpers.js';
import{captureBackupMaterial}from'../src/backup-capture.js';
import{sealBackupArchive,backupHash}from'../src/backup-format.js';
import{inspectBackupArchive}from'../src/backup-validate.js';
import{installFrozenBackup}from'../src/restore-install.js';
async function original(){const f=fixture(false);f.init();const raw=await captureBackupMaterial(f.configFile,true);const key=randomBytes(32);const archive=sealBackupArchive(raw.metadata,raw.records,key);const material=inspectBackupArchive(archive,key).material;const outer=mkdtempSync(join(tmpdir(),'notifier-restore-separate-intent-'));const intent=join(outer,'intent');mkdirSync(join(f.root,'keys'),{mode:0o700});const keyFile=join(f.root,'keys/backup.key');writeFileSync(keyFile,key,{mode:0o600});const archiveFile=join(f.root,'original.backup');writeFileSync(archiveFile,archive,{mode:0o600});const scope=Buffer.from(JSON.stringify({config:f.configFile,registry:f.authFile,initial_prompt:f.value.initial_prompt_file,data_dir:f.value.data_dir}));const scopeFile=join(f.root,'scope.json');writeFileSync(scopeFile,scope,{mode:0o600});renameSync(f.value.data_dir,f.value.data_dir+'.retained');return{f,material,scope,intent,archiveSha:backupHash(archive),inputs:{archive:archiveFile,keyFile,scopeFile,intent,writersQuiesced:true}};}

test('install detects replacement of its original intent directory after a checkpoint instead of returning an unverifiable completion',async()=>{
  const p=await original();let moved=false;await assert.rejects(installFrozenBackup(p.material,p.archiveSha,p.scope,p.inputs,async()=>{if(!moved){moved=true;const original=readFileSync(join(p.intent,'INTENT.json'));renameSync(p.intent,p.intent+'.retained-original');mkdirSync(p.intent,{mode:0o700});writeFileSync(join(p.intent,'INTENT.json'),original,{mode:0o600});}}));assert.equal(moved,true);
});
test('install does not silently publish into a replacement original target parent while the operator intent lives elsewhere',async()=>{
  const p=await original();for(const path of [p.f.configFile,p.f.authFile,p.f.value.initial_prompt_file])renameSync(path,path+'.retained-static');let moved=false;
  await assert.rejects(installFrozenBackup(p.material,p.archiveSha,p.scope,p.inputs,async()=>{if(!moved){moved=true;renameSync(p.f.root,p.f.root+'.retained-original-parent');mkdirSync(p.f.root,{mode:0o700});}}));assert.equal(moved,true);
});
