// Test-only process: an independent SQLite connection. No HTTP bypass is shipped.
import { ApiError, parseRegistry } from '../../src/auth.js';
import { CoreStore } from '../../src/core.js';
import { openDatabase } from '../../src/database.js';
import type { SubmitResponse } from '../../src/contracts.js';
import { NOW, type credentials } from '../helpers.js';

const path = process.argv[2];
if (!path || !process.send) throw new Error('Fixture requires a database and IPC');
const db = openDatabase(path);
const store = new CoreStore(db, () => NOW);
process.once('disconnect', () => { if (db.open) db.close(); });
process.once('message', (message: { config: ReturnType<typeof credentials>; token: string; event: string; input: SubmitResponse }) => {
  try {
    const registry = parseRegistry(message.config);
    const saved = store.respond(registry.authenticate(`Bearer ${message.token}`), message.event, message.input, registry);
    process.send?.({ status: 200, saved });
  } catch (err) {
    process.send?.({ status: err instanceof ApiError ? err.status : 503, code: err instanceof ApiError ? err.code : 'STORAGE_FAILURE' });
  } finally { db.close(); process.disconnect(); }
});
process.send({ ready: true });
