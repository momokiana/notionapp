import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { fixture } from './helpers.js';
import { validateNativeBackupBytes, runtimeType, controlType } from '../src/native.js';
import { validateRuntimeBackupJournal } from '../src/runtime.js';

function syntheticUnknown() {
  const f=fixture(false);f.init();const config=f.config;
  const manifest=JSON.parse(readFileSync(join(config.data_dir,'manifest.json'),'utf8')) as {native_id:string;cwd:string;session_file:string};
  const entries=validateNativeBackupBytes(config,manifest,readFileSync(manifest.session_file)).entries;
  // Deliberately constructed unknown journal for pure-parser tests, NOT a real provider/SIGKILL receipt.
  let parent=entries.at(-1)!.id;
  const push=(value:Record<string,unknown>)=>{const e={...value,parentId:parent,timestamp:new Date().toISOString()};entries.push(e as unknown as SessionEntry);parent=value.id as string;};
  push({id:'control_original',type:'custom_message',customType:controlType,content:'Synthetic original input',details:{}});
  const values=[{kind:'run_started',run_id:'original_run',command_id:null,input_entry_id:'control_original'},{kind:'model_request_intent',run_id:'original_run'},{kind:'model_http_attempt',run_id:'original_run'}];
  values.forEach((value,index)=>push({id:`journal_${index}`,type:'custom',customType:runtimeType,data:{scope:config.bindingHash,value}}));
  return {config,manifest,entries};
}

test('pure original journal validation preserves HTTP-attempt unknown without path IO, model calls or settlement', () => {
  const f=syntheticUnknown();const before=JSON.stringify(f.entries);const open=fs.openSync;const read=fs.readFileSync;const fetch=globalThis.fetch;
  fs.openSync=(()=>{throw new Error('No archive/original path access');}) as typeof fs.openSync;fs.readFileSync=(()=>{throw new Error('No private reference access');}) as typeof fs.readFileSync;globalThis.fetch=async()=>{throw new Error('No model or external request');};syncBuiltinESMExports();
  try {const rows=validateRuntimeBackupJournal(f.entries,f.config.bindingHash,f.manifest.native_id,1);assert.deepEqual(rows.map(r=>r.kind),['run_started','model_request_intent','model_http_attempt']);assert.equal(JSON.stringify(f.entries),before);}
  finally {fs.openSync=open;fs.readFileSync=read;globalThis.fetch=fetch;syncBuiltinESMExports();}
});

test('pure journal rejects wrong scope, duplicate attempt, absent original input or exhausted allowance instead of repairing them', () => {
  const f=syntheticUnknown();const validate=(entries:SessionEntry[],limit=1)=>validateRuntimeBackupJournal(entries,f.config.bindingHash,f.manifest.native_id,limit);
  assert.throws(()=>validateRuntimeBackupJournal(f.entries,'wrong_scope',f.manifest.native_id,1));assert.throws(()=>validate(f.entries,0));
  assert.throws(()=>validate(f.entries.filter(e=>e.id!=='control_original')));
  const duplicate=structuredClone(f.entries.at(-1)!);duplicate.id='second_attempt';assert.throws(()=>validate([...f.entries,duplicate]));
});
