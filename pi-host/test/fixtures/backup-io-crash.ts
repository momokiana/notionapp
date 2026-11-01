import fs, { readlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// Test-only owned subprocess interception, never a production flag/hook or an actual source/model request.
const [mode,target,...args]=process.argv.slice(2);
if(!mode||!target||!['written','file-synced','stage-record','stage-complete','sigterm'].includes(mode))throw new Error('Explicit owned backup IO fault fixture required');
const write=fs.writeSync;const sync=fs.fsyncSync;const open=fs.openSync;let fired=false;
function pathOf(fd:number){try{return readlinkSync(`/proc/self/fd/${fd}`);}catch{return '';}}
function fault(){if(fired)return;fired=true;write(1,Buffer.from(`fault:backup-${mode}\n`));process.kill(process.pid,mode==='sigterm'?'SIGTERM':'SIGKILL');}
fs.writeSync=((...values:unknown[])=>{const n=(write as(...v:unknown[])=>number)(...values);if(mode==='written'&&pathOf(values[0]as number)===target)fault();return n;})as typeof fs.writeSync;
fs.fsyncSync=fd=>{sync(fd);if(['file-synced','stage-record','stage-complete'].includes(mode!)&&pathOf(fd)===target)fault();};
fs.openSync=((...values:unknown[])=>{const fd=(open as(...v:unknown[])=>number)(...values);if(mode==='sigterm'&&values[0]===target)fault();return fd;})as typeof fs.openSync;
syncBuiltinESMExports();
process.argv=[process.execPath,fileURLToPath(new URL('../../dist/main.js',import.meta.url)),...args];
await import('../../dist/main.js');
if(!fired)throw new Error('Expected explicit owned backup fault boundary not reached');
