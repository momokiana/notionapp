import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { DeviceStore, type ClaimInput } from '../src/device-store.js';

async function setup(t: TestContext) {
  const root = mkdtempSync('/tmp/notifier-claim-race-'); chmodSync(root, 0o700); const path = join(root,'authority.sqlite'); const id = DeviceStore.initialize(path).store_id;
  const store = new DeviceStore(path,id); t.after(() => store.close());
  const invitation = { request_id: randomUUID(), invitation_id: randomUUID(), secret: randomBytes(32).toString('hex'), owner_id: 'owner', label: 'Racing claim', manage_devices: false, expires_at: Date.now()+60000 }; store.createInvitation('operator',invitation);
  const input = (): ClaimInput => ({ claim_id: randomUUID(), invitation_id: invitation.invitation_id, secret: invitation.secret, token: randomBytes(32).toString('hex') });
  const child = async () => {
    const process = fork(fileURLToPath(new URL('./fixtures/device-claim-process.ts',import.meta.url)),[],{execArgv:['--import',new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url).href],stdio:['ignore','ignore','ignore','ipc']});
    t.after(() => { if (process.exitCode===null&&process.signalCode===null) process.kill('SIGTERM'); }); assert.equal((await once(process,'message'))[0].phase,'ready'); return process;
  };
  return { path,id,store,input,child };
}

test('two real competing claim processes on one invitation produce one immutable actor, not two devices', { timeout:20000 }, async t => {
  const f = await setup(t); const [a,b]=await Promise.all([f.child(),f.child()]);const inputs=[f.input(),f.input()];
  const done=[once(a,'message'),once(b,'message')];a.send({path:f.path,store_id:f.id,claim:inputs[0]});b.send({path:f.path,store_id:f.id,claim:inputs[1]});
  const results=(await Promise.all(done)).map(([message])=>message);assert.deepEqual(results.map(r=>r.phase).sort(),['claimed','refused']);assert.equal(results.find(r=>r.phase==='refused').code,'PAIRING_ALREADY_USED');assert.equal(f.store.list('owner').length,1);
});

test('two real processes replaying the same original claim body return the same one actor without issuing another credential', { timeout:20000 }, async t => {
  const f = await setup(t); const [a,b]=await Promise.all([f.child(),f.child()]);const input=f.input();const done=[once(a,'message'),once(b,'message')];
  for(const p of [a,b])p.send({path:f.path,store_id:f.id,claim:input});const results=(await Promise.all(done)).map(([message])=>message);
  assert.ok(results.every(r=>r.phase==='claimed'));assert.deepEqual(results[0].result,results[1].result);assert.equal(f.store.list('owner').length,1);assert.equal(f.store.authenticate(input.token).id,results[0].result.device_id);
});
