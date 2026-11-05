// Only a test parent supplies this synthetic config and observes this exact child exit.
import { Spool } from '../src/spool.mjs';
import { config, readPrivate } from '../src/validation.mjs';
import { DEFAULT_POLICY } from '../src/spool-format.mjs';
const [path,command,point]=process.argv.slice(2),c=config(JSON.parse(readPrivate(path)));
const spool=new Spool(c,{maintenance:command==='upgrade'});
spool.maintenanceHook=phase=>{if(phase===point)process.kill(process.pid,'SIGKILL');};
if(command==='upgrade')spool.upgrade();
else if(command==='archive')spool.archive({max_rows:100,include_blocked:true});
else if(command==='resize')spool.resize({...DEFAULT_POLICY,active_reserved_bytes:DEFAULT_POLICY.active_reserved_bytes+4096});
else throw Error('UNKNOWN_SYNTHETIC_COMMAND');
spool.close();throw Error('CRASH_POINT_NOT_REACHED');
