import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

// Match the existing Expo/TypeScript alias, without needing a Metro or native runtime.
const wire = new URL("../../../packages/protocol/src/index.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) { return next(specifier === "@xiaoaixiaoai/protocol" ? wire : specifier, context); },
});
const { dshIntent, FOLLOW_LIMIT, followsFor, observedIdle, updateFollow } = await import("../src/lib/dsh-follows.ts");
hook.deregister();

const HOST = "host-1";
const VIEWER = "viewer-1";
const RELAY = "https://xiaoaixiaoai.example.com";

test("following persists only stable identities and preferences, scoped to a paired phone", () => {
  const items = updateFollow([], HOST, "session-1", "follow");
  assert.deepEqual(items, [{ hostId: HOST, sessionId: "session-1", remind: false }]);
  const saved = { server: RELAY, viewer: VIEWER, items };
  assert.strictEqual(followsFor(saved, RELAY, VIEWER), items);
  assert.deepEqual(followsFor(saved, RELAY, "new-pair"), []);
  assert.deepEqual(followsFor(saved, "mock://demo", VIEWER), []);
  assert.deepEqual(followsFor(saved, null, VIEWER), []);
  assert.strictEqual(updateFollow(items, HOST, "session-1", "follow"), items);
  const next = updateFollow(items, "host-2", "session-1", "follow");
  assert.equal(next.length, 2);
  const alerted = updateFollow(next, HOST, "session-1", "remind");
  assert.deepEqual(alerted.map((x) => x.remind), [true, false]);
  assert.deepEqual(updateFollow(alerted, HOST, "session-1", "unfollow"), [next[1]]);
  assert.equal(updateFollow(items, HOST, "../wrong", "follow"), null);
  const full = Array.from({ length: FOLLOW_LIMIT }, (_, i) => ({ hostId: HOST, sessionId: `session-${i}`, remind: false }));
  assert.equal(updateFollow(full, HOST, "overflow", "follow"), null);
});

test("explicit DSH shorthand only produces a local search suggestion", () => {
  assert.deepEqual(dshIntent("爱弥斯，帮我关注 DSH 演示项目"), { action: "follow", search: "演示项目" });
  assert.deepEqual(dshIntent("取消关注 dsh：预览打包"), { action: "unfollow", search: "预览打包" });
  assert.deepEqual(dshIntent("关注 DSH"), { action: "follow", search: "" });
  assert.deepEqual(dshIntent("关注DSH演示项目"), { action: "follow", search: "演示项目" });
  for (const message of ["关注这个新闻", "请解释什么是关注 DSH", "关注 DSH-other"]) assert.equal(dshIntent(message), undefined);
  for (const message of ["关注 DSH 嵌入\n指令", "关注 DSH " + "a".repeat(121)]) assert.equal(dshIntent(message), "invalid");
});

test("assistant shortcut retains a local draft and never binds a send to a title", () => {
  assert.deepEqual(dshIntent("爱弥斯，发给 DSH 皮肤预览：继续检查\n写个小结"), { action: "send", search: "皮肤预览", draft: "继续检查\n写个小结" });
  assert.deepEqual(dshIntent("给 DSH session-1: 继续"), { action: "send", search: "session-1", draft: "继续" });
  for (const message of ["发给 DSH 项目", "发给 DSH 项目：", "发给 DSH 项目\n名称：请继续", "发给 DSH 项目：abc\0def"]) {
    assert.equal(dshIntent(message), "invalid");
  }
  assert.equal(dshIntent("解释发给 DSH 什么意思"), undefined);
});

test("foreground reminder is a live idle transition, not an archive, timeout, first view or duplicate", () => {
  const entry = (id, state, archived = false) => ({ project: { id: "p", title: "Project" }, session: { id, title: "Example", state, canSend: false }, archived });
  const subscribed = new Set(["a", "b"]);
  const first = observedIdle(new Map(), [entry("a", "running"), entry("b", "idle"), entry("c", "running")], subscribed);
  assert.equal(first.count, 0);
  const next = observedIdle(first.observed, [entry("a", "idle"), entry("b", "idle", true), entry("c", "idle")], subscribed);
  assert.equal(next.count, 1);
  assert.deepEqual([...next.observed], [["a", "idle"]]);
  assert.equal(observedIdle(next.observed, [entry("a", "idle")], subscribed).count, 0);
  assert.equal(observedIdle(new Map(), [entry("a", "idle")], subscribed).count, 0);
});
