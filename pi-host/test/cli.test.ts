import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { fixture, exited } from './helpers.js';
import { NativeSession } from '../src/native.js';

test('compiled optional CLI init/status/serve uses only its explicit private config; SIGTERM releases exact native owner', async t => {
  const f = fixture(false, { provider: 'openai', id: 'gpt-4o' });
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const address = reserve.address(); assert(address && typeof address === 'object'); const port = address.port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, listen: { host: '127.0.0.1', port } }), { mode: 0o600 });
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.root };
  const init = JSON.parse(execFileSync(process.execPath, [main, 'init', '--config', f.configFile], { env, encoding: 'utf8', timeout: 120000 }));
  assert.equal(init.state, 'initialized'); assert.equal(init.model_requested, false);
  const native = new NativeSession(f.config); const path = native.manager.getSessionFile()!; const id = native.manager.getSessionId(); const bytes = readFileSync(path); native.close();
  const status = JSON.parse(execFileSync(process.execPath, [main, 'status', '--config', f.configFile], { env, encoding: 'utf8', timeout: 120000 }));
  assert.equal(status.native_entries, 4); assert(!JSON.stringify(status).includes(id));
  const processHandle = spawn(process.execPath, [main, 'serve', '--config', f.configFile], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGTERM'); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Owned CLI did not prove its listener')), 120000);
    processHandle.stdout.on('data', value => { if (String(value).includes('app_service_listening')) { clearTimeout(timeout); resolve(); } });
    processHandle.once('exit', () => { clearTimeout(timeout); reject(new Error('Owned CLI exited before binding; never probe a possibly unrelated listener')); });
  });
  // The child's positive listener receipt, not a free-port guess, authorizes these fixture requests.
  const health = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(health.status, 200); assert.equal((await health.json()).storage, 'ready');
  const events = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { authorization: `Bearer ${f.userToken}` } });
  assert.equal(events.status, 200); assert.equal((await events.json()).items.length, 0);
  const stopped = exited(processHandle); processHandle.kill('SIGTERM'); assert.equal((await stopped).code, 0);
  const reopened = new NativeSession(f.config); assert.equal(reopened.manager.getSessionId(), id); assert.deepEqual(readFileSync(path), bytes); reopened.close();
});

test('compiled source-paused CLI serves the original ledger with bad model files and exits cleanly without changing native identity', async t => {
  const f = fixture(false, { provider: 'openai', id: 'gpt-4o' });
  const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done)); const addr = reserve.address(); assert(addr && typeof addr === 'object');
  const port = addr.port; await new Promise<void>(done => reserve.close(() => done()));
  writeFileSync(f.configFile, JSON.stringify({ ...f.value, listen: { host: '127.0.0.1', port } }), { mode: 0o600 }); f.init();
  const config = f.config; const native = new NativeSession(config); const file = native.manifest.session_file; const id = native.manifest.native_id; const bytes = readFileSync(file); native.close();
  const modelAuth = join(config.data_dir, 'agent/auth.json'); const badAuth = 'PRIVATE malformed synthetic model authorization';
  writeFileSync(modelAuth, badAuth, { mode: 0o600 }); writeFileSync(join(config.data_dir, 'agent/models.json'), '{invalid profile', { mode: 0o600 });
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url)); const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.root };
  const child = spawn(process.execPath, [main, 'serve', '--config', f.configFile, '--source-paused'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const receipt = await new Promise<{ source_paused: boolean }>((done, reject) => {
    let buffered = ''; const timer = setTimeout(() => reject(new Error('No owned paused listener receipt')), 120000);
    child.stdout.on('data', chunk => { buffered += String(chunk); for (const line of buffered.split('\n').slice(0, -1)) {
      if (line.includes('app_service_listening')) { clearTimeout(timer); done(JSON.parse(line)); return; }
    } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned paused CLI exited before listener; no network probe allowed')); });
  });
  assert.equal(receipt.source_paused, true);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  const publish = await fetch(base + '/v1/events', { method: 'POST', headers: { authorization: `Bearer ${f.sourceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({
    request_id: randomUUID(), title: 'Synthetic paused CLI', body: 'HTTP persistence only', session_ref: 'synthetic_paused_cli', target_revision: 'r1', expires_at: '2099-01-01T00:00:00Z',
  }) });
  assert.equal(publish.status, 200); const eventId = (await publish.json()).event_id;
  const observed = await fetch(`${base}/v1/source-runtime/${f.value.source.source_id}?event_id=${eventId}&event_version=1`, { headers: { authorization: `Bearer ${f.userToken}` } });
  assert.equal(observed.status, 200); assert.equal((await observed.json()).state, 'paused');
  const stopped = exited(child); child.kill('SIGTERM'); assert.equal((await stopped).code, 0);
  const reopened = new NativeSession(config); assert.equal(reopened.manifest.native_id, id); assert.deepEqual(readFileSync(file), bytes); reopened.close();
  assert.equal(readFileSync(modelAuth, 'utf8'), badAuth);
  const ordinary = spawnSync(process.execPath, [main, 'serve', '--config', f.configFile], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(ordinary.status, 1); assert(!ordinary.stderr.includes(badAuth));
});

test('source-paused flag is explicit, serve-only and never accepted twice or as an unknown flag', () => {
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url)); const path = '/never-read-for-invalid-cli-mode';
  for (const [command, flags] of [['init', ['--source-paused']], ['status', ['--source-paused']], ['preflight', ['--source-paused']],
    ['serve', ['--source-paused', '--source-paused']], ['serve', ['--unknown']]] as const) {
    const r = spawnSync(process.execPath, [main, command, '--config', path, ...flags], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 1); assert(r.stderr.includes('USAGE_INIT_SERVE_STATUS_PREFLIGHT_CONFIG_ABSOLUTE_PATH'));
  }
});
