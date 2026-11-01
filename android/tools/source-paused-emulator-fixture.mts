// Explicit owned-AVD fixture. Real compiled CLI and original SDK/SQLite binding, no model request, no fabricated Android action/receipt.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, closeSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import Database from '../../server/node_modules/better-sqlite3/lib/index.js';
import { DeviceStore } from '../../server/dist/device-store.js';
import { loadConfig } from '../../pi-host/dist/config.js';
import { AppRuntime } from '../../pi-host/dist/runtime.js';

process.umask(0o077);
if (process.env.NOTIONAPP_SOURCE_PAUSED_FIXTURE !== '1' || process.argv.length !== 2) throw new Error('Explicit source-paused local fixture required');
const root = mkdtempSync(join(tmpdir(), 'notifier-source-paused-'));
const registryPath = join(root, 'registry.json'); const configFile = join(root, 'config.json'); const main = resolve('pi-host/dist/main.js');
const source = { id: 'paused_fixture_actor', owner_id: 'paused_fixture_owner', kind: 'source', source_id: 'paused_fixture_source', source_epoch: 'paused_epoch_1',
  capabilities: ['publish', 'reply', 'deliver', 'read_responses'], token: randomBytes(32).toString('hex') };
writeFileSync(registryPath, JSON.stringify({ principals: [source] }), { mode: 0o600 });
writeFileSync(join(root, 'initial.txt'), 'Synthetic source-paused App fixture only, not Mio. No models or work sessions are used.', { mode: 0o600 });
const devicePath = join(root, 'authority.sqlite'); const storeId = DeviceStore.initialize(devicePath).store_id;
const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done)); const address = reserve.address();
if (!address || typeof address === 'string') throw new Error('No owned port reservation'); const port = address.port;
await new Promise<void>(done => reserve.close(() => done())); const base = `http://127.0.0.1:${port}`;
writeFileSync(configFile, JSON.stringify({ data_dir: join(root, 'runtime'), auth_file: registryPath, initial_prompt_file: join(root, 'initial.txt'),
  source: { owner_id: source.owner_id, principal_id: source.id, source_id: source.source_id, source_epoch: source.source_epoch },
  model: { provider: 'openai', id: 'gpt-4o', thinking: 'off' }, allow_model_calls: false, listen: { host: '127.0.0.1', port },
  device_auth: { path: devicePath, store_id: storeId } }), { mode: 0o600 });
execFileSync(process.execPath, [main, 'init', '--config', configFile], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }, stdio: 'pipe', timeout: 120000 });
const config = loadConfig(configFile); const prepared = await AppRuntime.open(config);
const target = prepared.host.target();
const sourceOperation = randomUUID(); writeFileSync(join(root, 'original-source-operation.json'), JSON.stringify({ id: sourceOperation, target }), { mode: 0o600 });
const event = prepared.core.create(prepared.currentAuthority().principal, { request_id: sourceOperation, title: 'Synthetic 来源暂停保活',
  body: '本机 SDK/账本测试，不是澪。来源暂停时，明确回应只先保存等待；运行观察不会替代原生收件回执。',
  session_ref: target.session_ref, target_revision: target.state_revision, expires_at: '2099-01-01T00:00:00Z',
  interaction: { id: 'paused_fixture_question', actions: [{ id: 'save', type: 'button', label: '保存并等待来源' }, { id: 'text', type: 'text', label: '测试文字回应' }] } });
const pkg = { notifier_pairing: 1, base, store_id: storeId, invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), expires_at: Date.now() + 15 * 60000,
  owner_id: source.owner_id, label: 'Owned source-paused AVD', manage_devices: false };
prepared.deviceAuthority!.store.createInvitation('operator', { request_id: pkg.invitation_id, invitation_id: pkg.invitation_id, secret: pkg.secret,
  owner_id: pkg.owner_id, label: pkg.label, manage_devices: false, expires_at: pkg.expires_at });
const manifestPath = join(config.data_dir, 'manifest.json'); const manifest = readFileSync(manifestPath); const nativePath = prepared.native.manifest.session_file;
const initialNative = readFileSync(nativePath); await prepared.close();
const badAuth = join(config.data_dir, 'agent/auth.json'); const retainedBadAuth = join(config.data_dir, 'agent/synthetic-bad-auth.retained');
writeFileSync(badAuth, 'PRIVATE SYNTHETIC malformed model authorization, deliberately unusable; no real credentials.', { mode: 0o600 });
writeFileSync(join(root, 'operator-private.json'), JSON.stringify({ base, packages: [pkg], event_id: event.event_id, config_file: configFile }), { mode: 0o600 });
let child: ChildProcess | undefined; let stopping = false; let phase = 'starting';
const log = openSync(join(root, 'private-cli.log'), 'a', 0o600);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function start(paused: boolean) {
  const args = [main, 'serve', '--config', configFile, ...(paused ? ['--source-paused'] : [])];
  const c = child = spawn(process.execPath, args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }, stdio: ['ignore', 'pipe', log] });
  writeFileSync(join(root, 'owned-cli-process.json'), JSON.stringify({ pid: c.pid, args, paused }), { mode: 0o600 });
  await new Promise<void>((done, reject) => {
    let text = ''; const timeout = setTimeout(() => reject(new Error('Owned CLI failed to prove listener; no health probe allowed')), 120000);
    c.stdout!.on('data', chunk => {
      text += String(chunk);
      for (const line of text.split('\n').slice(0, -1)) if (line.includes('app_service_listening')) {
        const receipt = JSON.parse(line); if (receipt.source_paused !== paused || receipt.model_calls_enabled !== false) { clearTimeout(timeout); reject(new Error('Unexpected owned CLI mode')); return; }
        clearTimeout(timeout); done(); return;
      }
    });
    c.once('exit', () => { clearTimeout(timeout); reject(new Error('Owned CLI exited before listener receipt')); });
  });
}
async function stop() {
  const c = child; if (!c) return;
  if (c.exitCode !== null || c.signalCode !== null) throw new Error('Unexpected owned CLI exit; retain originals, do not restart blindly');
  const exited = new Promise<number | null>(done => c.once('exit', code => done(code))); c.kill('SIGTERM');
  const timer = setTimeout(() => c.kill('SIGKILL'), 20000);
  try { if (await exited !== 0) throw new Error('Owned CLI did not close cleanly; no mode replacement'); } finally { clearTimeout(timer); }
  child = undefined;
}
function observation() {
  const db = new Database(join(config.data_dir, 'ledger.sqlite'), { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only=ON'); db.exec('BEGIN');
    const lines = readFileSync(nativePath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const inputs = lines.filter(e => e.type === 'custom_message' && e.customType === 'notifier_response');
    const metadata = lines.filter(e => e.type === 'custom' && e.customType === 'notifier_runtime').map(e => e.data?.value);
    const value = { phase, event_id: event.event_id, model_calls_enabled: false,
      events: (db.prepare('SELECT id,data FROM events ORDER BY seq').all() as { id: string; data: string }[]).map(e => ({ id: e.id, version: JSON.parse(e.data).event_version })),
      responses: db.prepare('SELECT id,event_id FROM responses ORDER BY seq').all(),
      commands: (db.prepare('SELECT id,response_id,event_id,receipt FROM commands ORDER BY rowid').all() as { id: string; response_id: string; event_id: string; receipt: string | null }[]).map(c => ({ ...c, receipt: c.receipt ? JSON.parse(c.receipt) : null })),
      history_count: (db.prepare('SELECT count(*) AS n FROM history').get() as { n: number }).n,
      native_inputs: inputs.map(e => ({ id: e.id, command_id: e.details.command_id, content_hash: hash(e.content) })),
      model_request_intents: metadata.filter(e => e?.kind === 'model_request_intent').length,
      native_hash: hash(readFileSync(nativePath)), initial_native_hash: hash(initialNative), manifest_hash: hash(readFileSync(manifestPath)), initial_manifest_hash: hash(manifest) };
    db.exec('ROLLBACK'); writeFileSync(join(root, 'observation-private.json'), JSON.stringify(value), { mode: 0o600 });
  } finally { db.close(); }
}
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
try {
  await start(true); phase = 'paused_initial'; console.log(JSON.stringify({ fixture: 'source-paused-compiled-cli', private_root: root, model_requests: false }));
  while (!stopping) {
    if (phase === 'paused_initial' && existsSync(join(root, 'resume-source.signal'))) {
      writeFileSync(join(root, 'resume-original-intent.json'), JSON.stringify({ base, config_hash: hash(readFileSync(configFile)), same_native_file: true }), { mode: 0o600 });
      await stop(); renameSync(badAuth, retainedBadAuth); await start(false); phase = 'normal_same_source';
      writeFileSync(join(root, 'resume-original-receipt.json'), JSON.stringify({ original_root_and_config_retained: true, model_calls_enabled: false }), { mode: 0o600 });
    }
    if (phase === 'normal_same_source' && existsSync(join(root, 'pause-source.signal'))) {
      writeFileSync(join(root, 'pause-original-intent.json'), JSON.stringify({ base, config_hash: hash(readFileSync(configFile)) }), { mode: 0o600 });
      await stop(); renameSync(retainedBadAuth, badAuth); await start(true); phase = 'paused_after_receipt';
    }
    observation(); await new Promise(done => setTimeout(done, 500));
  }
} finally { await stop(); closeSync(log); console.log(JSON.stringify({ stopped: true, original_data_retained: true })); }
