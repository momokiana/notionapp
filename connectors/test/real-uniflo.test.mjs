import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARTIFACT, verifyArtifact } from './real-uniflo-artifact.mjs';

test('real upstream entry requires an explicit regular pinned artifact; no installer or discovery fallback', () => {
  assert.throws(()=>verifyArtifact(undefined),/EXPLICIT_UNIFLO_BINARY_REQUIRED/);
  assert.throws(()=>verifyArtifact('uniflo'),/EXPLICIT_UNIFLO_BINARY_REQUIRED/);
  const dir=mkdtempSync(join(tmpdir(),'connector-artifact-test-')), bad=join(dir,'bad');writeFileSync(bad,'not the official binary');
  assert.throws(()=>verifyArtifact(bad),/UNIFLO_ARTIFACT_SIZE/);
  const fd=openSync(bad,'r+');try{ftruncateSync(fd,ARTIFACT.bytes);}finally{closeSync(fd);}
  assert.throws(()=>verifyArtifact(bad),/UNIFLO_ARTIFACT_HASH/);
  const link=join(dir,'link');symlinkSync(bad,link);assert.throws(()=>verifyArtifact(link));
  assert.equal(ARTIFACT.commit,'4dbda948068e2f8ce288dc2c2e56777ca88274e0');assert.equal(ARTIFACT.version,'0.2.6');
});

test('missing or wrong real-tool setup exits failed, never skips or executes a host daemon', () => {
  for(const bin of [undefined,'/not-an-installed-uniflo']) {
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('./real-uniflo-runner.mjs',import.meta.url))],{env:bin?{UNIFLO_BIN:bin}:{},encoding:'utf8',timeout:10000});
    assert.equal(r.status,1);assert.match(r.stderr,/REAL_UNIFLO_REJECTED/);assert.equal(r.stdout,'');
  }
});
