import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { mkdtempSync, chmodSync, readFileSync, writeFileSync, lstatSync, symlinkSync, linkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readBackupKey, readBackupFile, writeBackupFileExclusive, createBackupStageRoot } from '../src/backup-files.js';
import { HostError } from '../src/private-files.js';

const root = () => { const path = mkdtempSync(join(tmpdir(),'notifier-backup-files-')); chmodSync(path,0o700); return path; };
const rejects = (fn: () => unknown, expected?: string) => assert.throws(fn,e => e instanceof HostError && (!expected || e.code===expected));

test('backup key is a separate existing private exact 32-byte non-symlink/non-hardlink file', () => {
  const dir = root(); const path = join(dir,'key'); const key = randomBytes(32); writeFileSync(path,key,{mode:0o600});
  assert.deepEqual(readBackupKey(path),key); assert.deepEqual(readBackupFile(path,32).bytes,key);
  chmodSync(path,0o400); rejects(() => readBackupKey(path),'BACKUP_KEY_INVALID'); chmodSync(path,0o600);
  const alias = join(dir,'key-alias'); symlinkSync(path,alias); rejects(() => readBackupKey(alias));
  const hard = join(dir,'key-hardlink'); linkSync(path,hard); rejects(() => readBackupKey(path),'BACKUP_KEY_INVALID');
  const short = join(dir,'short-key'); writeFileSync(short,randomBytes(31),{mode:0o600}); rejects(() => readBackupKey(short),'BACKUP_KEY_INVALID');
});

test('exclusive backup write completes only after full write, file and held original parent sync', () => {
  const dir = root(); const path = join(dir,'archive'); const body = Buffer.from('synthetic-encrypted-like-test-data'); const original = fs.fsyncSync; const steps: string[] = [];
  fs.fsyncSync = fd => { const stat=fs.fstatSync(fd); steps.push(stat.isDirectory() ? 'parent' : 'file'); if(stat.isDirectory()) assert.equal(stat.ino,lstatSync(dir).ino); original(fd); }; syncBuiltinESMExports();
  try { assert.equal(writeBackupFileExclusive(path,body).bytes,body.length); } finally { fs.fsyncSync=original; syncBuiltinESMExports(); }
  assert.deepEqual(steps,['file','parent']); assert.deepEqual(readFileSync(path),body); assert.equal(lstatSync(path).mode&0o777,0o600);
  rejects(() => writeBackupFileExclusive(path,Buffer.from('never replace')),'BACKUP_OUTPUT_EXISTS'); assert.deepEqual(readFileSync(path),body);
});

test('positive short writes are completed, zero progress retains a failed artifact without acknowledgement', () => {
  const dir=root(); const body=Buffer.from('short-write-body'); const original=fs.writeSync;
  fs.writeSync = ((fd:number,buffer:Buffer,offset:number,length:number,position:number|null) => original(fd,buffer,offset,Math.min(length,3),position)) as typeof fs.writeSync; syncBuiltinESMExports();
  try { writeBackupFileExclusive(join(dir,'complete'),body); } finally { fs.writeSync=original; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(join(dir,'complete')),body);
  fs.writeSync = (() => 0) as typeof fs.writeSync; syncBuiltinESMExports();
  try { rejects(() => writeBackupFileExclusive(join(dir,'zero'),body),'BACKUP_SHORT_WRITE'); } finally { fs.writeSync=original; syncBuiltinESMExports(); }
  assert.equal(lstatSync(join(dir,'zero')).size,0);
});

for (const directory of [false,true]) test(`backup ${directory?'original parent':'file'} EIO never turns a readable artifact into success`, () => {
  const dir=root(); const path=join(dir,'archive'); const body=Buffer.from('all bytes can be readable before durability is acknowledged'); const original=fs.fsyncSync;
  fs.fsyncSync = fd => { if(fs.fstatSync(fd).isDirectory()===directory) throw Object.assign(new Error('synthetic path/body must not escape'),{code:'EIO'}); original(fd); }; syncBuiltinESMExports();
  try { rejects(() => writeBackupFileExclusive(path,body),'BACKUP_WRITE_UNAVAILABLE'); } finally { fs.fsyncSync=original; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(path),body); rejects(() => writeBackupFileExclusive(path,body),'BACKUP_OUTPUT_EXISTS');
});

test('ENOSPC preserves original and partial new output, without forwarding private filesystem error text', () => {
  const dir=root(); const source=join(dir,'original'); writeFileSync(source,'original facts',{mode:0o600}); const original=fs.writeSync; let calls=0;
  fs.writeSync = ((fd:number,buffer:Buffer,offset:number,length:number,position:number|null) => { if(++calls===1)return original(fd,buffer,offset,2,position); throw Object.assign(new Error('PRIVATE_SYNTHETIC_DIRECTORY_AND_BODY'),{code:'ENOSPC'}); }) as typeof fs.writeSync; syncBuiltinESMExports();
  try { rejects(() => writeBackupFileExclusive(join(dir,'archive'),Buffer.from('ciphertext-shaped')),'BACKUP_WRITE_UNAVAILABLE'); } finally { fs.writeSync=original; syncBuiltinESMExports(); }
  assert.equal(readFileSync(source,'utf8'),'original facts'); assert.equal(lstatSync(join(dir,'archive')).size,2);
});

test('new stage owns exact private root and parent, never merges an existing directory', () => {
  const dir=root(); const path=join(dir,'stage'); const stage=createBackupStageRoot(path);
  try { writeBackupFileExclusive(join(path,'synthetic.material'),Buffer.from('inert-framed-like-data')); stage.finish(); } finally { stage.close(); }
  assert.equal(lstatSync(path).mode&0o777,0o700); rejects(() => stage.finish(),'BACKUP_OUTPUT_CHANGED'); rejects(() => createBackupStageRoot(path),'BACKUP_OUTPUT_EXISTS');
  assert.equal(readFileSync(join(path,'synthetic.material'),'utf8'),'inert-framed-like-data');
});

test('a file-close failure still attempts the later owned parent close; injected unreleased file is explicitly reclaimed',()=>{
  const dir=root();const close=fs.closeSync;let injected:number|undefined;let parentClosed=false;
  fs.closeSync=fd=>{const directory=fs.fstatSync(fd).isDirectory();if(!directory&&injected===undefined){injected=fd;throw new Error('synthetic close-before-release failure');}close(fd);if(directory)parentClosed=true;};syncBuiltinESMExports();
  try{assert.throws(()=>writeBackupFileExclusive(join(dir,'artifact'),Buffer.from('complete bytes, no acknowledgement')));assert.equal(parentClosed,true);}
  finally{fs.closeSync=close;syncBuiltinESMExports();if(injected!==undefined)close(injected);}
});

test('observed output-parent replacement refuses acknowledgement and retains the file in its original private directory',()=>{
  const outer=root();const dir=join(outer,'original-parent');mkdirSync(dir,{mode:0o700});const sync=fs.fsyncSync;let moved=false;
  fs.fsyncSync=fd=>{sync(fd);if(!fs.fstatSync(fd).isDirectory()&&!moved){moved=true;renameSync(dir,dir+'.retained');mkdirSync(dir,{mode:0o700});}};syncBuiltinESMExports();
  try{rejects(()=>writeBackupFileExclusive(join(dir,'artifact'),Buffer.from('retain original output')));}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}
  assert.equal(readFileSync(join(dir+'.retained','artifact'),'utf8'),'retain original output');
});
