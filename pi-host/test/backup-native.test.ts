import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fixture } from './helpers.js';
import { validateNativeBackupBytes } from '../src/native.js';
import { HostError } from '../src/private-files.js';

function prepared() {
  const f=fixture(false); f.init(); const config=f.config;
  const manifest=JSON.parse(readFileSync(join(config.data_dir,'manifest.json'),'utf8')) as {native_id:string;cwd:string;session_file:string};
  return {config,manifest,bytes:readFileSync(manifest.session_file)};
}

test('pure backup Native validation opens no path or SDK session and keeps the exact original bytes', () => {
  const f=prepared(); const before=Buffer.from(f.bytes); const open=fs.openSync; const read=fs.readFileSync; const sdkOpen=SessionManager.open;
  fs.openSync=(() => {throw new Error('No original or archive path IO allowed');}) as typeof fs.openSync;
  fs.readFileSync=(() => {throw new Error('No path read allowed');}) as typeof fs.readFileSync;
  SessionManager.open=() => {throw new Error('No SDK open allowed');}; syncBuiltinESMExports();
  try { const result=validateNativeBackupBytes(f.config,f.manifest,f.bytes); assert.equal(result.header.id,f.manifest.native_id); assert.equal(result.entries.length,4); assert.equal(result.text,Buffer.from(before).toString('utf8')); }
  finally {fs.openSync=open;fs.readFileSync=read;SessionManager.open=sdkOpen;syncBuiltinESMExports();}
  assert.deepEqual(f.bytes,before);
});

test('pure backup Native validation still rejects wrong binding/seed, truncation and noncanonical JSONL without repairing it', () => {
  const f=prepared(); const before=Buffer.from(f.bytes);
  const reject=(config:typeof f.config,bytes:Buffer) => assert.throws(() => validateNativeBackupBytes(config,f.manifest,bytes),e => e instanceof HostError);
  reject({...f.config,bindingHash:'0'.repeat(64)},f.bytes); reject({...f.config,initialPrompt:'not the original instruction'},f.bytes);
  reject(f.config,f.bytes.subarray(0,-1)); reject(f.config,Buffer.from(f.bytes.toString('utf8').replace('\n','\r\n')));
  assert.deepEqual(f.bytes,before);
});
