import { ApiError } from 'notification-server/auth';
import { openDeviceRegistry } from 'notification-server/device-config';
import { createApp } from 'notification-server/app';
import { authority, loadConfig } from './config.js';
import { initialize, status } from './native.js';
import { HostError, requireHost } from './private-files.js';
import { AppRuntime } from './runtime.js';
import { backupCommands, runBackupCommand } from './backup-cli.js';
import {assertConfigNotRecovering} from './recovery-admission.js';
import {restoreCommands,runRestoreCommand}from'./restore-cli.js';

// This entry owns a dedicated process; newly created SQLite/SDK artifacts must remain private.
process.umask(0o077);
let runtime: AppRuntime | undefined;
let app: ReturnType<typeof createApp> | undefined;
let stopping = false;
let wake: (() => void) | undefined;
let shutdown: Promise<void> | undefined;
async function close() {
  if (shutdown) return shutdown;
  stopping = true; wake?.();
  shutdown = (async () => {
    try { await runtime?.stop(); }
    finally { try { await app?.close(); } finally { await runtime?.close(); } }
  })();
  return shutdown;
}
const safeCode = (error: unknown) => error instanceof HostError || error instanceof ApiError ? error.code : 'APP_RUNTIME_UNAVAILABLE';
try {
  if(restoreCommands.includes(process.argv[2]as typeof restoreCommands[number])){
    await runRestoreCommand(process.argv.slice(2));
  }else if (backupCommands.includes(process.argv[2] as typeof backupCommands[number])) {
    await runBackupCommand(process.argv.slice(2));
  } else {
  const [command, flag, path, ...rest] = process.argv.slice(2);
  const sourcePaused = command === 'serve' && rest.length === 1 && rest[0] === '--source-paused';
  requireHost(['init', 'serve', 'status', 'preflight'].includes(command ?? '') && flag === '--config' && path && (!rest.length || sourcePaused), 'USAGE_INIT_SERVE_STATUS_PREFLIGHT_CONFIG_ABSOLUTE_PATH');
  assertConfigNotRecovering(path);
  const config = loadConfig(path);
  if (command === 'status') console.log(JSON.stringify(status(config)));
  else if (command === 'preflight') {
    // open() resolves explicit read-only auth and rejects unsupported budgets, but never requests a model.
    // The enable bit is not persisted or a grant: runOnce()/sendCustomMessage are deliberately not called.
    runtime = await AppRuntime.open({ ...config, allow_model_calls: true });
    console.log(JSON.stringify({ state: 'preflight_passed', model_requested: false, identity_fingerprint: config.identity?.fingerprint ?? null,
      model: config.model, model_budget: config.model_budget, configured_model_calls_enabled: config.allow_model_calls }));
    await close();
  } else if (command === 'init') {
    const permissions = openDeviceRegistry(config.auth_file, config.device_auth);
    try { authority(config, permissions.registry)(); console.log(JSON.stringify(initialize(config))); }
    finally { permissions.close(); }
  } else {
    runtime = await AppRuntime.open(config, { sourcePaused });
    app = createApp(runtime.native.database, false, { sourceRuntime: runtime.sourceRuntime, registry: runtime.registry, ...(runtime.deviceAuthority ? { deviceAuthority: runtime.deviceAuthority } : {}), ...(config.push ? { push: config.push } : {}) });
    process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
    await app.listen(config.listen);
    console.log(JSON.stringify({ state: 'app_service_listening', source_paused: runtime.sourcePaused, model_calls_enabled: config.allow_model_calls, push_configured: !!config.push,
      identity_fingerprint: config.identity?.fingerprint ?? null, model: config.model, model_budget: config.model_budget }));
    let previous = '';
    while (!stopping) {
      let state: string;
      try {
        const result = await runtime.runOnce() as { state?: string };
        state = result.state ?? 'runtime_status_unavailable';
      } catch (error) { state = safeCode(error); }
      if (state !== previous && !stopping) { console.log(JSON.stringify({ state })); previous = state; }
      if (!stopping) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, 1000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    await close();
  }
  }
} catch (error) {
  console.error(JSON.stringify({ error: safeCode(error) })); process.exitCode = 1;
  await close();
}
