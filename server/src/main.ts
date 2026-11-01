import { createApp } from './app.js';
import { readConfig } from './config.js';
import { openDatabase } from './database.js';
import { openDeviceRegistry } from './device-config.js';

async function main(): Promise<void> {
  const config = readConfig();
  const authority = openDeviceRegistry(config.authFile, config.deviceAuth);
  let database: ReturnType<typeof openDatabase>;
  try { database = openDatabase(config.databasePath); } catch (error) { authority.close(); throw error; }
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp(database, true, { registry: authority.registry, ...(authority.deviceAuthority === undefined ? {} : { deviceAuthority: authority.deviceAuthority }), ...(config.push === undefined ? {} : { push: config.push }) });
  } catch (error) {
    database.close(); authority.close();
    throw error;
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
    } catch {
      app.log.error({ code: 'SHUTDOWN_FAILED' }, 'Shutdown failed');
      process.exitCode = 1;
    } finally {
      try { authority.close(); } catch { app.log.error({ code: 'DEVICE_AUTHORITY_CLOSE_FAILED' }, 'Shutdown failed'); process.exitCode = 1; }
    }
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  try {
    await app.listen({ host: config.host, port: config.port, listenTextResolver: () => 'Notification service listening' });
  } catch (error) {
    try { await app.close(); } finally { authority.close(); }
    throw error;
  }
}

main().catch(() => {
  console.error('STARTUP_FAILED: check local configuration, database and port availability');
  process.exitCode = 1;
});
