import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { SourcePump } from 'notification-server/source-adapter';
import { AppRuntime } from '../src/runtime.js';
import { responseType } from '../src/native.js';
import { fixture, fakeModels, manualEvent, respond } from './helpers.js';

for (const failure of ['file', 'directory'] as const) for (const recovery of ['runtime', 'pump'] as const) {
  test(`native ${failure} fsync EIO stays unknown on every receipt path; ${recovery} recovery syncs original entry without append`, async () => {
    const f = fixture(false); f.init(); const model = await fakeModels(f.root);
    const r = await AppRuntime.open(f.config, { modelRuntime: model.runtime });
    const path = r.native.manager.getSessionFile()!;
    const identities = { file: fs.statSync(path), directory: fs.statSync(dirname(path)) };
    const original = fs.fsyncSync;
    const counts = { file: { attempts: 0, successes: 0 }, directory: { attempts: 0, successes: 0 } };
    let failing = true;
    try {
      const event = manualEvent(r); const responseId = respond(r, f, event.id, '持久化屏障失败后的原始回应 🧪', 'reply');
      fs.fsyncSync = fd => {
        const stat = fs.fstatSync(fd);
        const kind = (['file', 'directory'] as const).find(k => stat.dev === identities[k].dev && stat.ino === identities[k].ino);
        if (kind) {
          counts[kind].attempts++;
          if (failing && kind === failure) throw Object.assign(new Error(`fixture-native-${failure}-fsync-EIO`), { code: 'EIO' });
        }
        original(fd); if (kind) counts[kind].successes++;
      };
      syncBuiltinESMExports();
      const injected = new RegExp(`fixture-native-${failure}-fsync-EIO`);
      await assert.rejects(r.runOnce(), injected);
      const before = r.core.getResponse(f.user(), responseId, f.registry());
      assert.equal(before.source_delivery?.state, 'effect_unknown');
      const commandId = before.source_delivery!.command_id!;
      const c = r.delivery.get(r.currentAuthority().principal, commandId);
      const input = r.native.entries().find(e => e.type === 'custom_message' && e.customType === responseType)!;
      assert(input?.type === 'custom_message'); const bytes = fs.readFileSync(path);
      assert.equal(counts[failure].attempts, 1); assert.equal(counts[failure].successes, 0);
      assert(!JSON.stringify(r.session.messages).includes(responseId), 'failed durability must not refresh the Agent replica');
      // Each of these previously trusted cache-readable JSONL without a successful barrier.
      assert.throws(() => r.host.getReceipt(commandId), injected);
      assert.throws(() => r.host.compareAndEnqueue(c, Date.now()), injected);
      const pump = new SourcePump(r.delivery, r.currentAuthority, r.host, join(f.value.data_dir, 'source-pump.json'));
      assert.throws(() => pump.runOnce(), injected);
      await assert.rejects(r.runOnce(), injected);
      assert.equal(counts[failure].successes, 0);
      assert.equal(r.core.getResponse(f.user(), responseId, f.registry()).source_delivery?.state, 'effect_unknown');
      assert.equal(r.core.listHistory(f.user(), event.id, { after: 0, limit: 100 }).items.filter(h => h.kind === 'source_received').length, 0);
      assert.deepEqual(fs.readFileSync(path), bytes); assert.equal(model.calls.length, 0);
      failing = false;
      if (recovery === 'runtime') assert.equal((await r.runOnce() as { state: string }).state, 'source_received_model_disabled');
      else assert.equal(pump.runOnce().state, 'source_received');
      const received = r.core.getResponse(f.user(), responseId, f.registry());
      assert.equal(received.source_delivery?.state, 'source_received');
      assert.deepEqual(received.source_delivery?.receipt, { command_id: commandId, session_ref: c.response.target.session_ref, state_revision: c.response.target.state_revision, message_id: input.id });
      assert(counts.file.successes > 0 && counts.directory.successes > 0, 'file AND parent directory barriers must succeed before signing');
      assert(JSON.stringify(r.session.messages).includes(responseId), 'recovery refreshes only the now-durable native context');
      assert.deepEqual(r.host.getReceipt(commandId), received.source_delivery?.receipt);
      assert.deepEqual(r.host.compareAndEnqueue(c, Date.now()), received.source_delivery?.receipt);
      pump.runOnce(); await r.runOnce();
      assert.equal(r.native.entries().filter(e => e.type === 'custom_message' && e.customType === responseType).length, 1);
      assert.deepEqual(fs.readFileSync(path), bytes);
      assert.equal(r.core.listHistory(f.user(), event.id, { after: 0, limit: 100 }).items.filter(h => h.kind === 'source_received').length, 1);
      assert.equal(model.calls.length, 0);
      failing = true;
      assert.throws(() => r.host.getReceipt(commandId), injected);
      await assert.rejects(r.runOnce(), injected);
      assert.equal(r.core.getResponse(f.user(), responseId, f.registry()).source_delivery?.state, 'source_received', 'a later storage failure must not erase a previously confirmed receipt');
      assert.deepEqual(fs.readFileSync(path), bytes);
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); await r.close(); }
  });
}
