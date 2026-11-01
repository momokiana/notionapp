import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CoreStore } from '../../src/core.js';
import { DeliveryStore, type NativeHost } from '../../src/delivery.js';
import { SourcePump } from '../../src/source-adapter.js';
import { openDatabase } from '../../src/database.js';
import { fileRegistry } from '../../src/auth.js';

const [mode, path, auth, journal, native, token] = process.argv.slice(2);
const db = openDatabase(path!);
const now = () => Date.parse('2026-01-01T00:00:00Z'); // Fixed isolated test clock, never a network parameter.
if (mode === 'contend') {
  db.pragma('busy_timeout=50');
  try { new CoreStore(db); process.stdout.write('UNEXPECTED_WRITE_ACCESS'); process.exitCode = 1; }
  catch (e) { if ((e as { code?: string }).code !== 'SQLITE_BUSY') throw e; process.stdout.write('SQLITE_BUSY'); }
  finally { db.close(); }
} else if (mode === 'claim') {
  const provider = fileRegistry(auth!); const registry = provider();
  const principal = registry.authenticate(`Bearer ${journal}`);
  const result = new DeliveryStore(db, now).claim(principal, native!, registry);
  process.stdout.write(JSON.stringify({ id: result.command?.id ?? null })); db.close();
} else {
  const provider = fileRegistry(auth!);
  const authority = () => { const registry = provider(); return { registry, principal: registry.authenticate(`Bearer ${token}`) }; };
  const host: NativeHost = {
    synchronousDurableGate: true,
    compareAndEnqueue(c) {
      const receipt = { command_id: c.id, session_ref: c.response.target.session_ref, state_revision: c.response.target.state_revision, message_id: 'durable_native_message' };
      const fd = openSync(native!, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
      const dir = openSync(dirname(native!), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      process.kill(process.pid, 'SIGKILL');
      throw new Error('unreachable');
    },
    getReceipt() { return null; },
  };
  new SourcePump(new DeliveryStore(db, now), authority, host, journal!).runOnce();
  throw new Error('expected SIGKILL');
}
