import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.js';
import { AppRuntime } from '../src/runtime.js';

const main=fileURLToPath(new URL('../dist/main.js',import.meta.url));const child=fileURLToPath(new URL('./fixtures/backup-io-crash.ts',import.meta.url));const loader=fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url));
const environment=(root:string)=>({PATH:process.env.PATH??'/usr/bin:/bin',HOME:root,TMPDIR:process.env.TMPDIR??'/tmp'});
function setup(){const f=fixture(false);f.init();const key=join(f.root,'key');writeFileSync(key,randomBytes(32),{mode:0o600});const manifest=readFileSync(join(f.config.data_dir,'manifest.json'));const nativePath=(JSON.parse(manifest.toString())as{session_file:string}).session_file;return{f,key,manifest,nativePath,native:readFileSync(nativePath)};}
function run(root:string,args:string[]){return spawnSync(process.execPath,[main,...args],{env:environment(root),encoding:'utf8',timeout:30000});}
function kill(root:string,mode:string,target:string,args:string[]){const value=spawnSync(process.execPath,['--import',loader,child,mode,target,...args],{env:environment(root),encoding:'utf8',timeout:30000});assert.equal(value.signal,'SIGKILL',value.stderr);assert.equal(value.status,null);assert.ok(value.stdout.includes(`fault:backup-${mode}`));assert.equal(value.stdout.includes('backup_created'),false);assert.equal(value.stdout.includes('backup_material_staged'),false);return value;}
async function originalUnchanged(s:ReturnType<typeof setup>){assert.deepEqual(readFileSync(join(s.f.config.data_dir,'manifest.json')),s.manifest);assert.deepEqual(readFileSync(s.nativePath),s.native);const r=await AppRuntime.open(s.f.config,{sourcePaused:true});try{assert.equal(r.native.metadata().length,0);assert.equal(r.native.entries().length,4);}finally{await r.close();}}

for(const mode of ['written','file-synced'])test(`compiled backup ${mode} SIGKILL keeps original IDs and readable ciphertext is not original durability acknowledgement`,async()=>{
  const s=setup();const out=join(s.f.root,'original-attempt.backup');const args=['backup-create','--config',s.f.configFile,'--out',out,'--key-file',s.key,'--writers-quiesced'];
  kill(s.f.root,mode,out,args);assert.equal(existsSync(out),true);const original=readFileSync(out);
  const inspect=run(s.f.root,['backup-inspect','--archive',out,'--key-file',s.key]);assert.equal(inspect.status,0,inspect.stderr);assert.equal(JSON.parse(inspect.stdout).original_create_durability_ack_verified,false);
  const replay=run(s.f.root,args);assert.notEqual(replay.status,0);assert.equal(JSON.parse(replay.stderr).error,'BACKUP_OUTPUT_EXISTS');assert.deepEqual(readFileSync(out),original);await originalUnchanged(s);
});

for(const mode of ['stage-record','stage-complete'])test(`compiled inert ${mode} SIGKILL preserves failed directory without merging or implying an active restore`,async()=>{
  const s=setup();const out=join(s.f.root,'original.backup');const create=run(s.f.root,['backup-create','--config',s.f.configFile,'--out',out,'--key-file',s.key,'--writers-quiesced']);assert.equal(create.status,0,create.stderr);const original=readFileSync(out);
  const stage=join(s.f.root,'original-inert-attempt');const args=['backup-stage','--archive',out,'--key-file',s.key,'--out-dir',stage];const target=join(stage,mode==='stage-record'?'native.material':'COMPLETE.json');
  kill(s.f.root,mode,target,args);assert.equal(existsSync(target),true);const retained=readFileSync(target);const again=run(s.f.root,args);assert.notEqual(again.status,0);assert.equal(JSON.parse(again.stderr).error,'BACKUP_OUTPUT_EXISTS');assert.deepEqual(readFileSync(target),retained);assert.deepEqual(readFileSync(out),original);await originalUnchanged(s);
});

test('compiled backup SIGTERM is observed before final stdout and does not remove the original completed or failed artifact',async()=>{
  const s=setup();const out=join(s.f.root,'interrupted.backup');const value=spawnSync(process.execPath,['--import',loader,child,'sigterm',out,'backup-create','--config',s.f.configFile,'--out',out,'--key-file',s.key,'--writers-quiesced'],{env:environment(s.f.root),encoding:'utf8',timeout:30000});
  assert.equal(value.signal,null);assert.equal(value.status,1,value.stderr);assert.ok(value.stdout.includes('fault:backup-sigterm'));assert.equal(value.stdout.includes('backup_created'),false);assert.equal(JSON.parse(value.stderr).error,'BACKUP_INTERRUPTED');assert.equal(existsSync(out),true);await originalUnchanged(s);
});
