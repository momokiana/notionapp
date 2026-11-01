import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';

const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const render = fileURLToPath(new URL('../deploy/render-units.mjs', import.meta.url));
const run = (script: string, args: string[], home: string) => spawnSync(process.execPath, [script, ...args], {
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 120000,
});

for (const oauth of [false, true]) test(`compiled no-model preflight ${oauth ? 'rejects unsupported OAuth hard token cap' : 'validates explicit API key while configured calls remain disabled'}`, () => {
  const f = fixture(false, { provider: 'openai', id: 'gpt-6-sol' }); f.init();
  writeFileSync(join(f.value.data_dir, 'agent', 'auth.json'), JSON.stringify({ openai: oauth
    ? { type: 'oauth', access: 'synthetic-not-a-real-oauth-access', refresh: 'synthetic-must-not-refresh', expires: Date.now() + 3600000 }
    : { type: 'api_key', key: 'sk-synthetic-no-model-preflight' } }), { mode: 0o600 });
  const manifest = JSON.parse(readFileSync(join(f.value.data_dir, 'manifest.json'), 'utf8')) as { session_file: string };
  const paths = [join(f.value.data_dir, 'manifest.json'), manifest.session_file, join(f.value.data_dir, 'ledger.sqlite')];
  const before = paths.map(p => hash(readFileSync(p)));
  const result = run(main, ['preflight', '--config', f.configFile], f.root);
  assert.equal(result.error, undefined); assert.equal(result.status, oauth ? 1 : 0, result.stderr);
  if (oauth) assert(result.stderr.includes('MODEL_OUTPUT_BUDGET_UNSUPPORTED'));
  else { const out = JSON.parse(result.stdout); assert.equal(out.state, 'preflight_passed'); assert.equal(out.model_requested, false); assert.equal(out.configured_model_calls_enabled, false); }
  assert.deepEqual(paths.map(p => hash(readFileSync(p))), before);
  assert(!readFileSync(manifest.session_file, 'utf8').includes('model_request_intent'));
});

test('deployment renderer emits only two new disabled-loopback units, narrows home/write/profile surfaces and refuses overwrite', () => {
  const f = fixture(false, { provider: 'openai', id: 'gpt-6-sol' }); const operator = join(f.root, 'operator'); mkdirSync(operator, { mode: 0o700 });
  const profile = mkdtempSync('/tmp/notionapp-deploy-profile-');
  const persona = 'SYNTHETIC DEPLOYMENT FIXTURE, NOT MIO.';
  writeFileSync(join(profile, 'persona.txt'), persona, { mode: 0o600 });
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'xhigh' }), { mode: 0o600 });
  writeFileSync(join(profile, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-synthetic-do-not-request' } }), { mode: 0o600 });
  writeFileSync(join(operator, 'registry.json'), JSON.stringify({ principals: f.principals }), { mode: 0o600 });
  writeFileSync(join(operator, 'initial.txt'), 'Synthetic deployment fixture. Do not request a model.', { mode: 0o600 });
  const config = join(operator, 'app.json');
  writeFileSync(config, JSON.stringify({ ...f.value, data_dir: join(f.root, 'runtime'), auth_file: join(operator, 'registry.json'), initial_prompt_file: join(operator, 'initial.txt'),
    model: { ...f.value.model, thinking: 'xhigh' }, listen: { host: '127.0.0.1', port: 18441 },
    identity_reference: { name: 'Synthetic deploy fixture', persona_file: join(profile, 'persona.txt'), persona_sha256: hash(persona), settings_file: join(profile, 'settings.json'), credentials_file: join(profile, 'auth.json') } }), { mode: 0o600 });
  const out = join(f.root, 'rendered');
  const args = ['--config', config, '--code-root', '/opt/synthetic-not-installed', '--runtime-root', f.root, '--node', '/usr/bin/node', '--ntfy-binary', '/opt/synthetic-not-installed/tools/ntfy',
    '--user', 'synthetic-app', '--existing-workdir', '/opt/synthetic-existing-not-read', '--output-dir', out];
  const result = run(render, args, f.root); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { rendered_new_units: 2, installed: false, started: false, model_requested: false });
  const app = readFileSync(join(out, 'notifier-app-test.service'), 'utf8'); const ntfy = readFileSync(join(out, 'notifier-app-test-ntfy.service'), 'utf8');
  assert(app.includes('ProtectHome=tmpfs')); assert(app.includes(`BindReadOnlyPaths=${operator} ${profile}`));
  assert(app.includes(`ReadWritePaths=${f.root}/runtime`)); assert(app.includes(`${profile}/sessions`)); assert(app.includes('Restart=no'));
  assert(!ntfy.includes(profile)); assert(ntfy.includes(`ReadWritePaths=${f.root}/push`));
  assert(!app.includes(persona)); assert(!app.includes('sk-synthetic')); assert(!ntfy.includes('sk-synthetic'));
  const before = hash(app); const retry = run(render, args, f.root); assert.equal(retry.status, 1); assert(retry.stderr.includes('OUTPUT_ALREADY_EXISTS'));
  assert.equal(hash(readFileSync(join(out, 'notifier-app-test.service'))), before);
  const invalid = [...args]; invalid[invalid.indexOf('--node') + 1] = '/home/synthetic/node';
  const refused = run(render, invalid, f.root); assert.equal(refused.status, 1); assert(refused.stderr.includes('EXECUTABLE_HIDDEN_BY_PROTECT_HOME'));
});
