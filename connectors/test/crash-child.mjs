// Synthetic process fixture: intentionally kill ONLY this child after durable local/remote boundaries.
import { config, readPrivate } from '../src/validation.mjs';
import { Spool } from '../src/spool.mjs';
import { flush } from '../src/transport.mjs';
const s = new Spool(config(JSON.parse(readPrivate(process.argv[2]))));
if (process.argv[3] === 'prepare') {
  s.prepare(); process.kill(process.pid, 'SIGKILL');
} else {
  await flush(s, { afterResponse: () => process.kill(process.pid, 'SIGKILL') });
}
