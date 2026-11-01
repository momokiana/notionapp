import assert from'node:assert/strict';
import fs from'node:fs';
import{syncBuiltinESMExports}from'node:module';
const [phase,role,intent,native,...args]=process.argv.slice(2);assert(['installer-final','cli-final'].includes(phase!)&&['native','completion'].includes(role!)&&intent&&native);
const target=role==='native'?native!:intent+'/COMPLETE.json';const complete=intent+'/COMPLETE.json';const sync=fs.fsyncSync;let scheduled=false;let changed=false;let stdoutWritten=false;const out=process.stdout.write.bind(process.stdout);
process.stdout.write=((chunk:unknown,...rest:unknown[])=>{if(String(chunk).includes('"state":"frozen_install_complete"'))stdoutWritten=true;return(out as(...args:unknown[])=>boolean)(chunk,...rest);})as typeof process.stdout.write;
const mutate=()=>{assert.equal(stdoutWritten,false,'Test injection must precede successful stdout, not corrupt data afterwards');const original=fs.readFileSync(target);fs.writeFileSync(target,Buffer.concat([original,Buffer.from('X')]),{mode:0o600});changed=true;fs.writeSync(2,`fault:completion-${phase}-${role}:before-success-stdout:true\n`);};
fs.fsyncSync=fd=>{sync(fd);let path='';try{path=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}
  if(!scheduled&&path===intent&&fs.existsSync(complete)){scheduled=true;if(phase==='installer-final')mutate();else setImmediate(()=>setImmediate(mutate));}
};syncBuiltinESMExports();const main=new URL('../../dist/main.js',import.meta.url);process.argv=[process.execPath,main.pathname,...args];await import(main.href);
assert(scheduled,'Completion boundary was not reached');await new Promise<void>(resolve=>setImmediate(resolve));assert(changed,'Expected pre-stdout mutation did not occur');
