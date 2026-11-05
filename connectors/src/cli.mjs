#!/usr/bin/env node
import { openSync, fstatSync, closeSync, constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, readPrivate, readBounded, fail, MAX_BODY } from './validation.mjs';
import { Spool } from './spool.mjs';
import { flush } from './transport.mjs';
import { observeOnce } from './uniflo.mjs';
import { inspectSpool, errorCode } from './spool-capacity.mjs';
import { planArchive } from './spool-maintenance.mjs';

function inputJson(path) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>MAX_BODY)fail('INPUT_TOO_LARGE');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBounded(fd,MAX_BODY)));
  }finally{closeSync(fd);}
}

export async function main(args) {
  const [command, configPath, inputPath, ...extra] = args;
  const needsInput=['enqueue','resize','archive-plan','archive'].includes(command);
  if (!['init','enqueue','flush','status','run','observe','upgrade','resize','archive-plan','archive'].includes(command) || !configPath || extra.length || (needsInput ? !inputPath : inputPath !== undefined)) fail('USAGE');
  const c = config(JSON.parse(readPrivate(configPath)));
  if (command === 'status') return inspectSpool(c); // never acquire/remove the writer lock or acknowledge durability
  if(command==='archive-plan'){const options=inputJson(inputPath);return inspectSpool(c,(db,c,bound,state)=>planArchive(db,c,bound,options,{ready:state.storage_state==='ready'}));}
  const spool = new Spool(c, { init: command === 'init', maintenance:command==='upgrade' });
  const control = new AbortController(); const stop = () => control.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    if (command === 'enqueue') {
      return spool.enqueue(inputJson(inputPath)); // data only; never evaluated
    }
    if(command==='upgrade')return spool.upgrade();
    if(command==='resize')return spool.resize(inputJson(inputPath));
    if(command==='archive')return spool.archive(inputJson(inputPath));
    if (command === 'flush') return await flush(spool, { signal: control.signal });
    if (command === 'init') return spool.status();
    if (command === 'observe') {
      await observeOnce(spool, { signal: control.signal }); return spool.status();
    }
    // Independent observations, publishing and capacity do not prove each other's recovery.
    const lastReasons = new Map();
    const waiting = (stage, reason) => {
      if (!control.signal.aborted && reason !== lastReasons.get(stage)) process.stderr.write(`CONNECTOR_WAITING ${reason}: ${stage}; original facts retained; inspect status\n`);
      lastReasons.set(stage, reason);
    };
    const publish = async () => {
      try { const result = await flush(spool, { signal: control.signal }); lastReasons.delete('publish'); return result; }
      catch (e) { waiting('publish', errorCode(e)); }
    };
    while (!control.signal.aborted) {
      try {
        if (c.uniflo) {
          // Drain old transport before collecting again; an offline server must not disable local observation.
          if (spool.status().first_unsettled) await publish();
          const capacity = spool.capacityStatus();
          if (capacity.observation_admission !== 'accepting') waiting('capacity', capacity.observation_reason);
          else {
            lastReasons.delete('capacity');
            await observeOnce(spool, { signal: control.signal, onObservation: () => { lastReasons.delete('observation'); return publish(); } });
          }
        } else await publish();
      } catch (e) { waiting(c.uniflo ? 'observation' : 'publish', errorCode(e)); }
      if (!control.signal.aborted) await sleep(2000, undefined, { signal: control.signal }).catch(() => {});
    }
    return { state: 'stopped', effects: 'original_pending_and_unknown_retained' };
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); spool.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (e) { process.stderr.write(`CONNECTOR_REJECTED ${errorCode(e)}: no success acknowledgement; retain original input/spool\n`); process.exitCode = 1; }
}
