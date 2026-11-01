import assert from 'node:assert/strict';
import test from 'node:test';
import fs,{mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,readlinkSync,renameSync}from'node:fs';
import {join}from'node:path';
import{tmpdir}from'node:os';
import{randomUUID}from'node:crypto';
import{syncBuiltinESMExports}from'node:module';
import{publishRestoreFile,verifyRestoreFile}from'../src/restore-files.js';
import{HostError}from'../src/private-files.js';
function fixture(){const root=mkdtempSync(join(tmpdir(),'notifier-restore-files-'));const intent=join(root,'intent');const parent=join(root,'destination');mkdirSync(intent,{mode:0o700});mkdirSync(parent,{mode:0o700});return{root,intent,parent,id:randomUUID(),target:join(parent,'record'),body:Buffer.from('exact original payload; this is not active Native input')};}
const rejected=(run:()=>unknown,code?:string)=>assert.throws(run,e=>e instanceof HostError&&(!code||e.code===code));

test('restore publication has an original durable inode reservation, exclusive same-filesystem link and same-intent replay without replacing either inode',()=>{
  const f=fixture();const owned=publishRestoreFile(f.intent,f.id,'native',f.target,f.body);assert.deepEqual(readFileSync(f.target),f.body);assert.equal(lstatSync(f.target).ino,owned.file.ino);assert.equal(lstatSync(owned.prepared).nlink,2);assert.deepEqual(verifyRestoreFile(f.intent,f.id,'native',f.target,f.body),owned);assert.deepEqual(publishRestoreFile(f.intent,f.id,'native',f.target,f.body),owned);assert.deepEqual(readFileSync(f.target),f.body);
  rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,Buffer.from('replacement')),'RESTORE_RESERVATION_CHANGED');assert.deepEqual(readFileSync(f.target),f.body);
});
test('an unrelated existing target is never adopted by matching bytes or overwritten',()=>{
  for(const equal of [false,true]){const f=fixture();const original=equal?f.body:Buffer.from('unrelated original bytes');writeFileSync(f.target,original,{mode:0o600});const inode=lstatSync(f.target).ino;rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body),'RESTORE_TARGET_CONFLICT');assert.deepEqual(readFileSync(f.target),original);assert.equal(lstatSync(f.target).ino,inode);}
});
test('a create-before-reservation-proof gap refuses the retained prepared artifact instead of guessing ownership or choosing another restore ID',()=>{
  const f=fixture();const prepared=join(f.parent,`.notifier-restore-${f.id}-native.prepared`);writeFileSync(prepared,f.body,{mode:0o600});rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body),'RESTORE_UNPROVEN_PREPARED_FILE');assert.deepEqual(readFileSync(prepared),f.body);assert.equal(existsSync(f.target),false);assert.equal(existsSync(join(f.intent,'FILE-native.json')),false);
});
for(const zero of [false,true])test(`owned ${zero?'zero':'positive partial then ENOSPC'} write retains proof and resumes only the exact remaining prefix`,()=>{
  const f=fixture();const prepared=join(f.parent,`.notifier-restore-${f.id}-native.prepared`);const write=fs.writeSync;let calls=0;
  fs.writeSync=((fd:number,bytes:Buffer,offset:number,length:number,position:number|null)=>{if(readlinkSync(`/proc/self/fd/${fd}`)!==prepared)return write(fd,bytes,offset,length,position);if(zero)return 0;if(++calls===1)return write(fd,bytes,offset,3,position);throw Object.assign(new Error('synthetic no space'),{code:'ENOSPC'});})as typeof fs.writeSync;syncBuiltinESMExports();
  try{rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body),zero?'RESTORE_SHORT_WRITE':'RESTORE_WRITE_UNAVAILABLE');}finally{fs.writeSync=write;syncBuiltinESMExports();}
  assert.equal(existsSync(f.target),false);assert.equal(lstatSync(prepared).size,zero?0:3);const record=readFileSync(join(f.intent,'FILE-native.json'));const result=publishRestoreFile(f.intent,f.id,'native',f.target,f.body);assert.deepEqual(readFileSync(f.target),f.body);assert.deepEqual(readFileSync(join(f.intent,'FILE-native.json')),record);assert.equal(lstatSync(f.target).ino,result.file.ino);
});
test('published bytes after parent EIO are not a success ACK; exact original reservation can reestablish the current installation barriers',()=>{
  const f=fixture();const sync=fs.fsyncSync;let parents=0;
  fs.fsyncSync=fd=>{sync(fd);if(readlinkSync(`/proc/self/fd/${fd}`)===f.parent&&++parents===2)throw Object.assign(new Error('synthetic original parent EIO'),{code:'EIO'});};syncBuiltinESMExports();
  try{rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body),'RESTORE_WRITE_UNAVAILABLE');}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}
  assert.deepEqual(readFileSync(f.target),f.body);const inode=lstatSync(f.target).ino;const result=publishRestoreFile(f.intent,f.id,'native',f.target,f.body);assert.equal(result.file.ino,inode);assert.deepEqual(verifyRestoreFile(f.intent,f.id,'native',f.target,f.body),result);
});
test('readable reservation after its parent sync failed cannot publish until that exact proof barrier succeeds',()=>{
  const f=fixture();const sync=fs.fsyncSync;
  fs.fsyncSync=fd=>{if(readlinkSync(`/proc/self/fd/${fd}`)===f.intent)throw Object.assign(new Error('synthetic proof parent EIO'),{code:'EIO'});sync(fd);};syncBuiltinESMExports();
  try{rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body));assert.equal(existsSync(join(f.intent,'FILE-native.json')),true);rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body));assert.equal(existsSync(f.target),false);}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}
  const owned=publishRestoreFile(f.intent,f.id,'native',f.target,f.body);assert.deepEqual(readFileSync(f.target),f.body);assert.equal(lstatSync(f.target).ino,owned.file.ino);
});
test('a prepared FD close failure still releases the later owned parent; injected unreleased FD is explicitly reclaimed',()=>{
  const f=fixture();const prepared=join(f.parent,`.notifier-restore-${f.id}-native.prepared`);const open=fs.openSync,close=fs.closeSync;let mainFd:number|undefined;let injected:number|undefined;let parentClosed=false;
  fs.openSync=((path:fs.PathLike,flags:fs.OpenMode,mode?:fs.Mode)=>{const fd=open(path,flags,mode);if(path===prepared&&typeof flags==='number'&&(flags&fs.constants.O_RDWR)!==0&&mainFd===undefined)mainFd=fd;return fd;})as typeof fs.openSync;
  fs.closeSync=fd=>{const name=readlinkSync(`/proc/self/fd/${fd}`);if(fd===mainFd&&injected===undefined){injected=fd;throw new Error('synthetic close before release');}close(fd);if(name===f.parent)parentClosed=true;};syncBuiltinESMExports();
  try{assert.throws(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body));assert.equal(parentClosed,true);}finally{fs.openSync=open;fs.closeSync=close;syncBuiltinESMExports();if(injected!==undefined)close(injected);}
});
test('observed original-parent replacement refuses completion and retains its original private artifact without retargeting',()=>{
  const f=fixture();const sync=fs.fsyncSync;let moved=false;
  fs.fsyncSync=fd=>{sync(fd);if(readlinkSync(`/proc/self/fd/${fd}`)===f.parent&&!moved){moved=true;renameSync(f.parent,f.parent+'.retained');mkdirSync(f.parent,{mode:0o700});}};syncBuiltinESMExports();
  try{rejected(()=>publishRestoreFile(f.intent,f.id,'native',f.target,f.body));}finally{fs.fsyncSync=sync;syncBuiltinESMExports();}
  assert.equal(existsSync(f.target),false);const original=join(f.parent+'.retained',`.notifier-restore-${f.id}-native.prepared`);assert.deepEqual(readFileSync(original),f.body);
});
