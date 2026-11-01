import { writeFileSync } from 'node:fs';
import { DeviceStore } from '../../src/device-store.js';
import { handoverStaticUser, type HandoverPhase, type HandoverRequest } from '../../src/device-handover.js';

process.once('message', (input: { path: string; store_id: string; request: HandoverRequest; intent: string; fault: HandoverPhase; signal: string }) => {
  let store: DeviceStore | undefined;
  try {
    store = new DeviceStore(input.path, input.store_id);
    handoverStaticUser(store, input.request, input.intent, true, phase => {
      if (phase === input.fault) {
        writeFileSync(input.signal, phase, { mode: 0o600, flag: 'wx' });
        process.send?.({ phase: 'fault', at: phase });
        // Let the actual parent deliver SIGKILL, without closing or repairing original SQLite/file state.
        const block = new Int32Array(new SharedArrayBuffer(4)); while (true) Atomics.wait(block, 0, 0, 1000);
      }
    });
    process.send?.({ phase: 'unexpected_completion' });
  } catch (error) { process.send?.({ phase: 'failed', code: (error as { code?: string }).code ?? 'FIXTURE_FAILURE' }); }
  finally { store?.close(); process.disconnect(); }
});
process.send?.({ phase: 'ready' });
