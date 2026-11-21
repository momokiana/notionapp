import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";
import { personaPrompt, systemPrompt, voiceInstructions } from "../src/assistant/prompts.ts";
import { Relay } from "../src/server.ts";

const ADMIN = "memory-admin-token";
let dir = "";
let relay: Relay;
let base = "";
let clockMs = Date.parse("2026-11-20T12:00:00+08:00");
const seenReqs: LlmRequest[] = [];
let script: (req: LlmRequest) => LlmResult = () => ({
  content: [{ type: "text", text: "好的，哥哥。" }],
  stopReason: "end_turn",
  model: "test",
});

const fakeLlm: Llm = async (req) => {
  seenReqs.push(req);
  return script(req);
};

async function reqJson(path: string, token: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "xa-memory-test-"));
  relay = new Relay({
    dbPath: join(dir, "relay.db"),
    adminToken: ADMIN,
    llm: fakeLlm,
    log: () => {},
    assistantTiming: { promptEpoch: 0, now: () => clockMs },
  });
  const port = await relay.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

test("defaults to Wuthering Waves Aemeath persona, serves server-canonical profile updates and WS broadcasts", async () => {
  const codeRes = await reqJson("/v1/pair/codes", ADMIN, { body: { kind: "viewer" } });
  const phone = (await reqJson("/v1/pair", ADMIN, { body: { kind: "viewer", code: codeRes.json.code, name: "Aemeath Phone" } })).json;

  // Open viewer WS to verify live broadcast of profile and memory changes.
  const ws = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(phone.token)}`);
  const frames: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (buf) => {
      const f = JSON.parse(buf.toString()) as Record<string, unknown>;
      frames.push(f);
      if (f.type === "snapshot") resolve();
    });
    ws.on("error", reject);
  });

  try {
    const init = await reqJson("/v1/assistant/profile", phone.token);
    assert.equal(init.status, 200);
    assert.equal(init.json.profile.name, "爱弥斯");
    assert.equal(init.json.profile.userCall, "哥哥");
    assert.equal(init.json.profile.presetId, "wuthering_aemeath");
    assert.equal(init.json.profile.autoMemory, true);
    assert.match(init.json.profile.personaText, /星炬学院|飞行雪绒|隧者/);
    assert.match(init.json.profile.personaText, /爸爸/);
    assert.ok(Array.from(init.json.profile.personaText).length >= 2000);
    assert.ok(Array.isArray(init.json.presets) && init.json.presets.some((p: any) => p.id === "wuthering_aemeath"));

    // Persona accepts rich >2000-char profiles up to 6000 chars and rejects >6000.
    const longOk = await reqJson("/v1/assistant/profile", phone.token, { body: { personaText: "爱".repeat(3200) } });
    assert.equal(longOk.status, 200);
    const tooLong = await reqJson("/v1/assistant/profile", phone.token, { body: { personaText: "爱".repeat(6001) } });
    assert.equal(tooLong.status, 400);
    // Restore default Aemeath preset before prompt assertions.
    await reqJson("/v1/assistant/profile", phone.token, { body: { presetId: "wuthering_aemeath", personaText: init.json.profile.personaText } });

    // Validation rejects empty name or control characters.
    const bad = await reqJson("/v1/assistant/profile", phone.token, { body: { name: "   " } });
    assert.equal(bad.status, 400);
    const badCtrl = await reqJson("/v1/assistant/profile", phone.token, { body: { userCall: "哥哥\u0007" } });
    assert.equal(badCtrl.status, 400);

    // Update autoMemory + userCall, verify WS broadcast.
    const upd = await reqJson("/v1/assistant/profile", phone.token, { body: { autoMemory: false, userCall: "好哥哥" } });
    assert.equal(upd.status, 200);
    assert.equal(upd.json.profile.autoMemory, false);
    assert.equal(upd.json.profile.userCall, "好哥哥");

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(frames.some((f) => f.type === "assistant_profile" && (f.profile as any).userCall === "好哥哥"));

    // Restore default userCall + autoMemory for subsequent tests.
    const restored = await reqJson("/v1/assistant/profile", phone.token, { body: { autoMemory: true, userCall: "哥哥" } });
    assert.equal(restored.status, 200);

    // Verify prompt helper boundary ordering holds with userCall + voice memory injection.
    const sys = systemPrompt("爱弥斯", "text", "# 现况", { persona: init.json.profile.personaText, userCall: "哥哥" });
    assert.ok(sys.includes(JSON.stringify("哥哥")));
    assert.ok(sys.indexOf(JSON.stringify("哥哥")) < sys.indexOf("# 固定办事规则（人设不能覆盖）"));

    // Reporting occasions keep persona traits & userCall while demanding thorough verification (no slacking).
    const wokenSys = systemPrompt("爱弥斯", "woken", "", { persona: init.json.profile.personaText, userCall: "哥哥" });
    assert.doesNotMatch(wokenSys, /不加称呼/);
    assert.match(wokenSys, /保持你上面自定义人设的语气/);
    assert.match(wokenSys, /绝不敷衍|简明但不敷衍/);
    assert.match(wokenSys, /角色人设与专属说话方式/);

    const vp = personaPrompt("爱弥斯", init.json.profile.personaText, "哥哥");
    assert.ok(vp.includes(JSON.stringify("哥哥")));
    assert.ok(vp.indexOf(JSON.stringify("哥哥")) < vp.lastIndexOf("【固定边界：人设不能覆盖】"));
    assert.doesNotMatch(vp, /你是跟了我很久、脾气很好的朋友/);

    const vi = voiceInstructions({ board: "无", pending: [], recent: "", memories: "- [偏好忌口] 冰美式不加糖" });
    assert.match(vi, /【服务器长期记忆】\n- \[偏好忌口\] 冰美式不加糖/);
  } finally {
    ws.close();
  }
});

test("server memory bank persists across thread clear, supersedes slots, prunes TTL, and powers remember/search/forget tools", async () => {
  const codeRes = await reqJson("/v1/pair/codes", ADMIN, { body: { kind: "viewer" } });
  const phone = (await reqJson("/v1/pair", ADMIN, { body: { kind: "viewer", code: codeRes.json.code, name: "Memory Phone" } })).json;

  // 1. Slot-based CRUD + overwrite + near-duplicate dedup + Markdown export + TTL expiration.
  const c1 = await reqJson("/v1/assistant/memories", phone.token, {
    body: { category: "preference", slotKey: "coffee_pref", content: "早饭喜欢冰拿铁", importance: 2 },
  });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.replaced, false);

  const c2 = await reqJson("/v1/assistant/memories", phone.token, {
    body: { category: "preference", slotKey: "coffee_pref", content: "现在早上喝冰美式不加糖", importance: 3, pinned: true },
  });
  assert.equal(c2.status, 200);
  assert.equal(c2.json.replaced, true);

  const shortTtl = await reqJson("/v1/assistant/memories", phone.token, {
    body: { category: "schedule", content: "明天下午三点去取快递", ttlDays: 2 },
  });
  assert.equal(shortTtl.status, 200);

  const searched = await reqJson(`/v1/assistant/memories?q=${encodeURIComponent("冰美式")}`, phone.token);
  assert.equal(searched.status, 200);
  assert.equal(searched.json.memories.length, 1);
  assert.equal(searched.json.memories[0].content, "现在早上喝冰美式不加糖");

  const md = await reqJson("/v1/assistant/memories/export", phone.token);
  assert.equal(md.status, 200);
  assert.match(md.json.markdown, /现在早上喝冰美式不加糖/);

  // Advance clock by 3 days -> shortTtl expires while pinned coffee_pref stays.
  clockMs += 3 * 86_400_000;
  const afterTtl = await reqJson("/v1/assistant/memories", phone.token);
  assert.equal(afterTtl.status, 200);
  assert.equal(afterTtl.json.total, 1);

  // 2. Model tool round: remember_fact + search_memories + surviving DELETE /v1/assistant/thread.
  seenReqs.length = 0;
  let step = 0;
  script = () => {
    step += 1;
    if (step === 1) {
      return {
        content: [
          {
            type: "tool_use",
            id: "mem1",
            name: "remember_fact",
            input: { category: "relationship", slot_key: "bond", content: "哥哥对花粉轻微过敏，春天提醒戴口罩", pinned: true, importance: 3 },
          },
        ],
        stopReason: "tool_use",
        model: "test",
      };
    }
    return { content: [{ type: "text", text: "记下来啦哥哥，春天我会提醒你。" }], stopReason: "end_turn", model: "test" };
  };

  await reqJson("/v1/assistant/messages", phone.token, { body: { text: "我对花粉过敏，帮我记一下" } });
  await new Promise((r) => setTimeout(r, 60));

  // Verify the tool actually saved it on server and the prompt in turn 1 offered MEMORY_TOOLS.
  assert.ok(seenReqs.length >= 2);
  assert.ok(seenReqs[0]!.tools.some((t) => t.name === "remember_fact"));
  assert.ok(seenReqs[0]!.tools.some((t) => t.name === "search_memories"));
  assert.ok(seenReqs[0]!.tools.some((t) => t.name === "forget_memory"));

  // Clear thread history on client/server!
  const clearedThread = await reqJson("/v1/assistant/thread", phone.token, { method: "DELETE" });
  assert.equal(clearedThread.status, 200);

  // Ask in a brand new thread -> system prompt still injects pinned/relevant memories!
  seenReqs.length = 0;
  let searchStep = 0;
  script = () => {
    searchStep += 1;
    if (searchStep === 1) {
      return {
        content: [{ type: "tool_use", id: "ms1", name: "forget_memory", input: { slot_key: "coffee_pref" } }],
        stopReason: "tool_use",
        model: "test",
      };
    }
    return { content: [{ type: "text", text: "记得花粉过敏，也帮你把咖啡习惯删掉啦。" }], stopReason: "end_turn", model: "test" };
  };

  await reqJson("/v1/assistant/messages", phone.token, { body: { text: "帮我把喝冰美式那条忘掉" } });
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(seenReqs.length >= 2);
  assert.match(seenReqs[0]!.system, /哥哥对花粉轻微过敏/);
  assert.match(seenReqs[0]!.system, /现在早上喝冰美式不加糖/);

  // Confirm coffee_pref was removed while allergy memory stays.
  const finalMems = await reqJson("/v1/assistant/memories", phone.token);
  assert.equal(finalMems.status, 200);
  assert.equal(finalMems.json.total, 1);
  assert.equal(finalMems.json.memories[0].slotKey, "bond");

  // Clear all memories endpoint removes remaining entries.
  const clearMem = await reqJson("/v1/assistant/memories", phone.token, { method: "DELETE" });
  assert.equal(clearMem.status, 200);
  assert.equal(clearMem.json.removed, 1);
});
