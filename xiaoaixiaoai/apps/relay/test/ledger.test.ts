import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";
import { Relay } from "../src/server.ts";

const ADMIN = "ledger-admin-token";
let dir = "";
let relay: Relay;
let base = "";
let script: (req: LlmRequest) => LlmResult = () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn", model: "test" });
const lastRequest: { req?: LlmRequest } = {};

const fakeLlm: Llm = async (req) => {
  lastRequest.req = req;
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
  dir = mkdtempSync(join(tmpdir(), "xa-ledger-test-"));
  relay = new Relay({ dbPath: join(dir, "relay.db"), adminToken: ADMIN, llm: fakeLlm, assistantConfirm: "always", log: () => {} });
  const port = await relay.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

test("ledger plugin stays gated when disabled and powers WeChat capture, fixed expenses, dedup, rollback, and assistant tools when enabled", async () => {
  const pairCode = await reqJson("/v1/pair/codes", ADMIN, { body: { kind: "viewer" } });
  const phone = (await reqJson("/v1/pair", ADMIN, { body: { kind: "viewer", code: pairCode.json.code, name: "Ledger Phone" } })).json;

  // 1. Disabled by default: wechat_notify upload rejected, assistant has no ledger tools.
  const init = await reqJson("/v1/ledger", phone.token);
  assert.equal(init.status, 200);
  assert.equal(init.json.config.enabled, false);
  const rejected = await reqJson("/v1/ledger/transactions", phone.token, {
    body: { direction: "expense", amountCents: 1500, title: "奶茶", source: "wechat_notify", externalId: "wc-blocked" },
  });
  assert.equal(rejected.status, 409);

  await reqJson("/v1/assistant/messages", phone.token, { body: { text: "你好" } });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(lastRequest.req && !lastRequest.req.tools.some((t) => t.name.startsWith("ledger_")));

  // 2. Enable plugin, set balance & savings goal, add monthly fixed bills (Codex & Gemini).
  const enabled = await reqJson("/v1/ledger/config", phone.token, {
    body: { enabled: true, balanceCents: 4500_00, savingsGoalCents: 2000_00 },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.config.enabled, true);

  const f1 = await reqJson("/v1/ledger/fixed", phone.token, { body: { name: "Codex 会员", amountCents: 145_00 } });
  assert.equal(f1.status, 200);
  assert.equal(f1.json.plan.unpaidFixedCents, 145_00);
  const fixedId = f1.json.fixedExpenses[0].id as string;

  // 3. Capture WeChat expense + verify idempotent externalId dedup.
  const payload = { direction: "expense", amountCents: 50_00, title: "瑞幸咖啡", source: "wechat_notify", externalId: "wc-dedup-1" };
  const first = await reqJson("/v1/ledger/transactions", phone.token, { body: payload });
  assert.equal(first.status, 200);
  assert.equal(first.json.duplicate, false);
  assert.equal(first.json.state.config.balanceCents, 4450_00);
  assert.match(first.json.alert.title, /微信支出 50 元/);

  const dup = await reqJson("/v1/ledger/transactions", phone.token, { body: payload });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.duplicate, true);
  assert.equal(dup.json.state.config.balanceCents, 4450_00);

  // 4. Paying fixed item links fixedId, marks paid this month, and does not count as discretionary spend.
  const paidFixed = await reqJson("/v1/ledger/transactions", phone.token, {
    body: { direction: "expense", amountCents: 145_00, title: "Codex 订阅", fixedId, source: "manual" },
  });
  assert.equal(paidFixed.status, 200);
  assert.equal(paidFixed.json.state.config.balanceCents, 4305_00);
  assert.equal(paidFixed.json.state.plan.unpaidFixedCents, 0);
  assert.equal(paidFixed.json.state.plan.paidFixedCents, 145_00);
  assert.equal(paidFixed.json.state.plan.todayDiscretionaryExpenseCents, 50_00);

  // Deleting fixed payment restores balance & marks fixed unpaid again.
  const del = await reqJson(`/v1/ledger/transactions/${paidFixed.json.transaction.id}`, phone.token, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(del.json.config.balanceCents, 4450_00);
  assert.equal(del.json.plan.unpaidFixedCents, 145_00);

  // 5. Assistant gains ledger tools when enabled and executes direct ledger tool cleanly.
  script = (req) => {
    const hasResult = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    if (!hasResult) {
      return {
        content: [{ type: "tool_use", id: "call_1", name: "ledger_manage_fixed", input: { action: "add", name: "Gemini 会员", amount_yuan: 140 } }],
        stopReason: "tool_use",
        model: "test",
      };
    }
    return { content: [{ type: "text", text: "已经帮你把 Gemini 会员 140 元加入每月固定开支了。" }], stopReason: "end_turn", model: "test" };
  };
  await reqJson("/v1/assistant/messages", phone.token, { body: { text: "把 Gemini 会员 140 元也加进每月固定开支" } });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(lastRequest.req?.tools.some((t) => t.name === "ledger_manage_fixed"));
  const finalState = await reqJson("/v1/ledger", phone.token);
  assert.equal(finalState.json.fixedExpenses.length, 2);
  assert.equal(finalState.json.plan.unpaidFixedCents, 285_00);
});

test("wechat_notify capture proactively announces transaction in assistant thread without duplicating retries or manual entries", async () => {
  const pairCode = await reqJson("/v1/pair/codes", ADMIN, { body: { kind: "viewer" } });
  const phone = (await reqJson("/v1/pair", ADMIN, { body: { kind: "viewer", code: pairCode.json.code, name: "Announce Phone" } })).json;

  // Enable and calibrate balance so daily remaining is computed.
  await reqJson("/v1/ledger/config", phone.token, { body: { enabled: true, balanceCents: 1000_00, savingsGoalCents: 200_00 } });
  const before = (await reqJson("/v1/assistant", phone.token)).json.items as Array<{ id: string; text: string }>;
  const beforeIds = new Set(before.map((x) => x.id));

  // Manual transaction does not trigger assistant proactive chat bubble.
  await reqJson("/v1/ledger/transactions", phone.token, {
    body: { direction: "expense", amountCents: 10_00, title: "手动早饭", source: "manual" },
  });
  let items = (await reqJson("/v1/assistant", phone.token)).json.items as Array<{ id: string; text: string }>;
  assert.equal(items.length, before.length);

  // First wechat_notify capture generates one warm Aemeath-toned announcement with amount, balance, and collapsed note.
  const wc = {
    direction: "expense",
    amountCents: 23_00,
    title: "瑞幸咖啡",
    note: "已支付¥23.00 （微信折叠了2条消息中的最新一笔）",
    source: "wechat_notify",
    externalId: "wc-announce-1",
  };
  const first = await reqJson("/v1/ledger/transactions", phone.token, { body: wc });
  assert.equal(first.status, 200);
  items = (await reqJson("/v1/assistant", phone.token)).json.items as Array<{ id: string; role: string; text: string }>;
  const added = items.filter((it) => it.id.startsWith("ledger-") && !beforeIds.has(it.id));
  assert.equal(added.length, 1);
  assert.match(added[0]!.text, /哥哥，刚捕捉到一笔微信消费 23 元（瑞幸咖啡）/);
  assert.match(added[0]!.text, /当前余额约 967 元/);
  assert.match(added[0]!.text, /微信把多条消息折在一起了/);

  // Idempotent duplicate upload must not repeat the assistant bubble.
  const dup = await reqJson("/v1/ledger/transactions", phone.token, { body: wc });
  assert.equal(dup.json.duplicate, true);
  items = (await reqJson("/v1/assistant", phone.token)).json.items as Array<{ id: string; role: string; text: string }>;
  assert.equal(items.filter((it) => it.id.startsWith("ledger-") && !beforeIds.has(it.id)).length, 1);

  // Also verify wechat_notify emits a phone push notice stored for /v1/notify replay.
  const notices = relay.assistant.noticesSince(Date.now() - 60_000);
  assert.ok(notices.some((n) => n.kind === "reminder" && /微信消费 23 元/.test(n.body)));

  // Offline-synced transaction from an earlier month must still return live current-month budget and not clobber current paidYm.
  const fixedNow = await reqJson("/v1/ledger/fixed", phone.token, { body: { name: "宽带", amountCents: 100_00 } });
  const fxId = fixedNow.json.fixedExpenses.find((x: any) => x.name === "宽带").id as string;
  const curPaid = await reqJson("/v1/ledger/transactions", phone.token, {
    body: { direction: "expense", amountCents: 100_00, title: "本月宽带", fixedId: fxId, source: "manual" },
  });
  const currentYm = curPaid.json.state.plan.ym as string;
  const oldTs = Date.now() - 45 * 86_400_000;
  const backdated = await reqJson("/v1/ledger/transactions", phone.token, {
    body: { direction: "expense", amountCents: 100_00, title: "上月宽带补录", fixedId: fxId, source: "manual", ts: oldTs },
  });
  assert.equal(backdated.status, 200);
  assert.equal(backdated.json.state.plan.ym, currentYm);
  const fxAfter = backdated.json.state.fixedExpenses.find((x: any) => x.id === fxId);
  assert.equal(fxAfter.paidYm, currentYm);
});
