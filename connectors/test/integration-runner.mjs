// Copies ONLY public backend source/package metadata into a new private scratch root.
// It never builds/writes the shared backend tree or reads data/config/deploy/evidence.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash, canonical } from '../src/validation.mjs';
const server = resolve(process.argv[2] ?? fileURLToPath(new URL('../../server', import.meta.url)));
const legacy = process.argv[3] === '--legacy';
const root = mkdtempSync(join(tmpdir(), 'connector-backend-integration-')), copy = join(root, 'server'); mkdirSync(join(copy, 'src'), { recursive: true, mode: 0o700 });
const paths = ['package.json', 'package-lock.json', ...readdirSync(join(server, 'src')).filter(p => p.endsWith('.ts')).map(p => `src/${p}`)];
const manifest = [];
for (const p of paths) { const b = readFileSync(join(server, p)); manifest.push({ path: p, sha256: hash(b) }); writeFileSync(join(copy, p), b); }
for (const p of manifest) if (hash(readFileSync(join(server, p.path))) !== p.sha256) throw new Error('BACKEND_CHANGED_DURING_SNAPSHOT');
writeFileSync(join(root, 'source-manifest.json'), canonical(manifest)); symlinkSync(join(server, 'node_modules'), join(copy, 'node_modules'), 'dir');
process.stdout.write(`SOURCE_SNAPSHOT ${root}\nSOURCE_MANIFEST_SHA256 ${hash(canonical(manifest))}\n`);
const run = spawnSync(process.execPath, ['--import', join(server, 'node_modules/tsx/dist/loader.mjs'), '--test', fileURLToPath(new URL('./integration.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, CONNECTOR_TEST_SOURCE: join(copy, 'src'), CONNECTOR_TEST_LEGACY: legacy ? '1' : '0' },
}); process.exitCode = run.status ?? 1;
