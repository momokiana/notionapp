import { existsSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DeviceStore } from '../../src/device-store.js';

interface Input { path: string; store_id: string; token: string; request_id: string; target: string; wait_for?: string; busy_proof?: string; committed?: string }
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
process.once('message', (input: Input) => {
  let store: DeviceStore | undefined;
  try {
    if (input.wait_for) {
      const deadline = Date.now() + 10000;
      while (!existsSync(input.wait_for)) { if (Date.now() > deadline) throw new Error('Fixture wait expired'); pause(10); }
    }
    store = new DeviceStore(input.path, input.store_id);
    if (input.busy_proof) {
      const probe = new Database(input.path, { fileMustExist: true }); probe.pragma('busy_timeout=0');
      let busy = false;
      try { probe.exec('BEGIN IMMEDIATE'); probe.exec('ROLLBACK'); }
      catch (error) { if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error; busy = true; }
      finally { probe.close(); }
      if (!busy) throw new Error('Expected real authority write reservation was not held');
      writeFileSync(input.busy_proof, 'SQLITE_BUSY', { mode: 0o600, flag: 'wx' });
    }
    const result = store.revoke(input.token, input.request_id, input.target);
    if (input.committed) writeFileSync(input.committed, 'committed', { mode: 0o600, flag: 'wx' });
    process.send?.({ phase: 'committed', result });
  } catch (error) { process.send?.({ phase: 'failed', code: (error as { code?: string }).code ?? 'FIXTURE_FAILURE' }); process.exitCode = 1; }
  finally { store?.close(); process.disconnect(); }
});
process.send?.({ phase: 'ready' });
