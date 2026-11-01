#!/usr/bin/env node
import { openSync, fstatSync, closeSync, constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, readPrivate, readBounded, fail, MAX_BODY } from './validation.mjs';
import { Spool } from './spool.mjs';
import { flush } from './transport.mjs';
import { observeOnce } from './uniflo.mjs';

export async function main(args) {
  const [command, configPath, inputPath, ...extra] = args;
  if (!['init', 'enqueue', 'flush', 'status', 'run', 'observe'].includes(command) || !configPath || extra.length || (command === 'enqueue' ? !inputPath : inputPath !== undefined)) fail('USAGE');
  const c = config(JSON.parse(readPrivate(configPath)));
  const spool = new Spool(c, { init: command === 'init' });
  const control = new AbortController(); const stop = () => control.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    if (command === 'enqueue') {
      // Explicit data file, not shell/stdin evaluation. O_NONBLOCK avoids FIFO/device hangs.
      const fd = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const s = fstatSync(fd); if (!s.isFile() || s.size > MAX_BODY) fail('INPUT_TOO_LARGE');
        const b = readBounded(fd, MAX_BODY);
        return spool.enqueue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)));
      } finally { closeSync(fd); }
    }
    if (command === 'flush') return await flush(spool, { signal: control.signal });
    if (command === 'init' || command === 'status') return spool.status();
    if (command === 'observe') {
      await observeOnce(spool, { signal: control.signal }); return spool.status();
    }
    while (!control.signal.aborted) {
      try {
        if (c.uniflo) {
          // Drain old transport before collecting again; an offline server must not disable local observation.
          await flush(spool, { signal: control.signal }).catch(() => {});
          await observeOnce(spool, { signal: control.signal, onObservation: () => flush(spool, { signal: control.signal }).catch(() => {}) });
        } else await flush(spool, { signal: control.signal });
      } catch { if (!control.signal.aborted) process.stderr.write('CONNECTOR_WAITING: retained original spool; inspect status\n'); }
      if (!control.signal.aborted) await sleep(2000, undefined, { signal: control.signal }).catch(() => {});
    }
    return { state: 'stopped', effects: 'original_pending_and_unknown_retained' };
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); spool.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch { process.stderr.write('CONNECTOR_REJECTED: no success acknowledgement; retain original input/spool\n'); process.exitCode = 1; }
}
