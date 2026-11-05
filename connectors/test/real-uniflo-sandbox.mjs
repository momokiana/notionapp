// Internal worker. Carries no arbitrary command/daemon arguments; all source mounts are fixed.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, fstatSync, statSync, realpathSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyArtifact } from './real-uniflo-artifact.mjs';

try {
  const root = process.argv[2], work = join(root, 'work'), stage = join(root, 'case');
  for (const dir of [root, work, stage]) { const s = lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('PRIVATE_CASE_REQUIRED'); }
  const boundary = JSON.parse(readFileSync(join(work, 'boundary.json')));
  const match = s => s.dev === boundary.dev && s.ino === boundary.ino;
  if (!match(fstatSync(0)) || !match(fstatSync(3))) throw Error('MISSING_INHERITED_CANARY_CONTROL');
  boundary.worker_received_stdin_canary = true; boundary.worker_received_fd3_canary = true;
  writeFileSync(join(work, 'boundary.json'), JSON.stringify(boundary));
  verifyArtifact(process.env.UNIFLO_BIN);
  copyFileSync(process.env.UNIFLO_BIN, join(stage, 'uniflo')); chmodSync(join(stage, 'uniflo'), 0o500); verifyArtifact(join(stage, 'uniflo'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const files = ['src/validation.mjs', 'src/spool.mjs', 'src/spool-format.mjs', 'src/spool-capacity.mjs', 'src/spool-storage.mjs', 'src/spool-maintenance.mjs', 'src/transport.mjs', 'src/uniflo.mjs', 'test/real-uniflo-case.mjs', 'test/real-uniflo-fixtures.mjs'];
  const manifest = [];
  for (const path of files) {
    const input = join(sourceRoot, path), target = join(stage, path), s = lstatSync(input);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 65536) throw Error('UNEXPECTED_SOURCE');
    const bytes = readFileSync(input); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, bytes, { mode: 0o400 });
    manifest.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  writeFileSync(join(work, 'source-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  for (const dir of ['home', 'cache', 'config', 'data', 'tmp', 'spool']) mkdirSync(join(work, dir), { mode: 0o700 });
  // Only the exact public Node executable and necessary public shared libraries, not /usr or host HOME.
  const args = ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--hostname', 'connector-uniflo-fixture', '--clearenv'];
  args.push('--ro-bind', realpathSync(process.execPath), '/tools/node');
  for (const name of ['libdl.so.2', 'libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libpthread.so.0', 'libc.so.6']) {
    const path = `/lib/x86_64-linux-gnu/${name}`; args.push('--ro-bind', realpathSync(path), path);
  }
  args.push('--ro-bind', realpathSync('/lib64/ld-linux-x86-64.so.2'), '/lib64/ld-linux-x86-64.so.2');
  args.push('--ro-bind', stage, '/case', '--bind', work, '/work', '--proc', '/proc', '--dev', '/dev', '--remount-ro', '/proc', '--remount-ro', '/dev');
  const env = { HOME: '/work/home', UNIFLO_HOME: '/work/home', UNIFLO_CACHE_DIR: '/work/cache', UNIFLO_DATA_DIR: '/work/data', UNIFLO_CONFIG_DIR: '/work/config', UNIFLO_LANG: 'en', UNIFLO_NO_UPDATE_CHECK: '1', PATH: '/tools', PWD: '/work', TMPDIR: '/work/tmp', TZ: 'UTC', LC_ALL: 'C', RUST_LOG: 'error' };
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  args.push('--chdir', '/work', '--remount-ro', '/', '/tools/node', '--test', '--test-concurrency=1', '/case/test/real-uniflo-case.mjs');
  const r = spawnSync('/usr/bin/bwrap', args, { stdio: ['ignore', 'pipe', 'pipe'], env: {}, timeout: 105000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr);
  if (r.error || r.signal || r.status !== 0) throw Error('ISOLATED_CASE_FAILED');
} catch {
  process.stderr.write('REAL_UNIFLO_SANDBOX_FAILED: retained synthetic case; no host fallback\n'); process.exitCode = 1;
}
