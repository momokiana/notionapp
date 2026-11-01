// Opt-in, source-only real upstream test. No installer, discovery, backend/native addon or host daemon.
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, readlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ARTIFACT, verifyArtifact } from './real-uniflo-artifact.mjs';

try {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.argv.length !== 2) throw Error('UNSUPPORTED_REAL_CASE');
  verifyArtifact(process.env.UNIFLO_BIN);
  if (!statSync('/usr/bin/bwrap').isFile()) throw Error('BWRAP_REQUIRED');
  const root = mkdtempSync(join(tmpdir(), 'connector-real-uniflo-')); chmodSync(root, 0o700);
  for (const dir of ['work', 'case']) mkdirSync(join(root, dir), { mode: 0o700 });
  const canary = join(root, 'outside-canary'); writeFileSync(canary, 'SYNTHETIC_OUTSIDE_FD_CANARY', { mode: 0o600 });
  const s = statSync(canary), namespaces = {};
  for (const n of ['user', 'mnt', 'pid', 'net', 'ipc', 'uts']) namespaces[n] = readlinkSync(`/proc/self/ns/${n}`);
  writeFileSync(join(root, 'work', 'boundary.json'), JSON.stringify({ canary, dev: s.dev, ino: s.ino, namespaces }), { mode: 0o600 });
  const fd = openSync(canary, 'r');
  let result;
  try {
    // Deliberately supply ONLY our synthetic canary to the worker's stdin/fd3.
    // The worker must prove receipt, then revoke both before executing bwrap.
    result = spawnSync(process.execPath, [fileURLToPath(new URL('./real-uniflo-sandbox.mjs', import.meta.url)), root], {
      env: { UNIFLO_BIN: process.env.UNIFLO_BIN }, stdio: [fd, 'pipe', 'pipe', fd],
      timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
  } finally { closeSync(fd); }
  if (readFileSync(canary, 'utf8') !== 'SYNTHETIC_OUTSIDE_FD_CANARY') throw Error('OUTSIDE_CANARY_CHANGED');
  process.stdout.write(`REAL_UNIFLO_CASE ${root}\nARTIFACT ${ARTIFACT.version} ${ARTIFACT.binary_sha256}\n`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status !== 0) throw Error('REAL_UNIFLO_CASE_FAILED');
} catch {
  process.stderr.write('REAL_UNIFLO_REJECTED: fixed artifact/isolation/case did not pass; no host fallback\n');
  process.exitCode = 1;
}
