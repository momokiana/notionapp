import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const binary = process.env.NTFY_TEST_BINARY;
for (const profile of [false, true]) test(`explicit Android ${profile ? 'named-profile Responses' : 'basic'} fixture starts without synthetic device/user writes; SIGTERM preserves original empty ledger`, { skip: !binary }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(profile ? './profile-emulator-fixture.ts' : './emulator-fixture.ts', import.meta.url)), binary!], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NOTIONAPP_EMULATOR_FIXTURE: '1', ...(profile ? { NOTIONAPP_EMULATOR_PROFILE_FIXTURE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; let failed = false; let root: string | undefined;
  const done = once(child, 'exit');
  const timeout = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 120000);
  child.stdout.on('data', chunk => { output += String(chunk); });
  // Drain private startup errors without including them or credentials in public assertions.
  child.stderr.resume();
  try {
    for (let attempt = 0; attempt < 1200; attempt++) {
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.fixture_ready === true) root = value.private_root; } catch { /* partial line */ }
      }
      if (root || child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(root, 'Fixture must prove readiness before termination; timeout is not startup evidence');
    if (profile) assert(output.includes('"synthetic_profile_not_mio":true'));
    const ntfyChildren = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    assert(ntfyChildren.length > 0);
    assert.equal(statSync(join(root, 'operator-private.json')).mode & 0o077, 0);
    const observed = JSON.parse(readFileSync(join(root, 'observed-ledger-private.json'), 'utf8'));
    assert.deepEqual(observed.events, []); assert.deepEqual(observed.responses, []); assert.equal(observed.model_requests, 0);
    child.kill('SIGTERM');
    const [code, signal] = await done;
    assert.equal(failed, false); assert.equal(signal, null); assert.equal(code, 0);
    assert(output.includes('"fixture_stopped":true'));
    for (const pid of ntfyChildren) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); try { await done; } finally { clearTimeout(timer); } }
  }
});
