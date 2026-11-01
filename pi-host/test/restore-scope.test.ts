import assert from'node:assert/strict';
import test from'node:test';
import{writeFileSync,linkSync}from'node:fs';
import{join}from'node:path';
import{fixture}from'./helpers.js';
import{captureBackupMaterial}from'../src/backup-capture.js';
import{parseRestoreScope,resolveRestoreScope,assertRestoreReferenceSeparation}from'../src/restore-scope.js';
import{HostError}from'../src/private-files.js';
const scope={config:'/private/config',registry:'/private/registry',initial_prompt:'/private/prompt',data_dir:'/private/runtime'};
const encoded=(v:unknown)=>Buffer.from(JSON.stringify(v));
const refuses=(run:()=>unknown)=>assert.throws(run,e=>e instanceof HostError);

test('strict operator flat scope accepts whitespace/escaped paths but rejects duplicate/unknown/prototype keys, nested values, bad UTF-8 and relative roles',()=>{
  assert.deepEqual({...parseRestoreScope(Buffer.from(JSON.stringify(scope,null,2)+'\n'))},scope);const escaped={...scope,config:'/private/quote"and:comma,path'};assert.deepEqual({...parseRestoreScope(encoded(escaped))},escaped);
  for(const value of [Buffer.from('{"config":"/a","config":"/b","registry":"/r","initial_prompt":"/p","data_dir":"/d"}'),Buffer.from('{"__proto__":"ignored","config":"/a","registry":"/r","initial_prompt":"/p","data_dir":"/d"}'),encoded({...scope,unexpected:'x'}),encoded({...scope,data_dir:{path:'/x'}}),encoded({...scope,registry:'relative'}),Buffer.from([0xff,0xff]),encoded({...scope,config:'/x\nprivate'})])refuses(()=>parseRestoreScope(value));
});
test('authenticated original role paths must exactly match independent scope; mappings only derive fixed original Native/runtime files',async()=>{
  const f=fixture(false);f.init();const material=await captureBackupMaterial(f.configFile,true);const own={config:f.configFile,registry:f.authFile,initial_prompt:f.value.initial_prompt_file,data_dir:f.value.data_dir};const bytes=Buffer.from(JSON.stringify(own,null,2));const resolved=resolveRestoreScope(material,bytes);
  assert.deepEqual({...resolved.scope},own);assert.equal(resolved.targets.find(t=>t.role==='native')!.path,JSON.parse(material.records.find(r=>r.name==='manifest')!.bytes.toString()).session_file);assert.equal(resolved.targets.find(t=>t.role==='ledger')!.static,false);assert.equal(resolved.targets.find(t=>t.role==='registry')!.static,true);
  refuses(()=>resolveRestoreScope(material,encoded({...own,data_dir:join(f.root,'different-runtime')})));refuses(()=>resolveRestoreScope(material,encoded({...own,device_authority:join(f.root,'extra.sqlite')})));
});
test('excluded external references cannot be relabeled operation inputs/targets, including inode aliases; no content reads are needed',async()=>{
  const f=fixture(false);f.init();const material=await captureBackupMaterial(f.configFile,true);const credential=join(f.value.data_dir,'agent/auth.json');writeFileSync(credential,'Synthetic excluded content: not a real provider authorization',{mode:0o600});const alias=join(f.root,'unrelated-looking-name');linkSync(credential,alias);
  refuses(()=>assertRestoreReferenceSeparation(material,[credential]));refuses(()=>assertRestoreReferenceSeparation(material,[alias]));
});
