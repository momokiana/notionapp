import { openDatabase } from '../../src/database.js';
import { CoreStore } from '../../src/core.js';
import { fileRegistry } from '../../src/auth.js';
import { NotificationStore, pushConfig } from '../../src/notifications.js';
const [path, auth] = process.argv.slice(2);
const db = openDatabase(path!);
try {
  new CoreStore(db);
  const store = new NotificationStore(db, fileRegistry(auth!), pushConfig('https://ntfy.fixture.invalid'), () => Date.parse('2026-01-01T00:00:00Z'));
  process.stdout.write(JSON.stringify({ id: store.claim()?.id ?? null }));
} finally { db.close(); }
