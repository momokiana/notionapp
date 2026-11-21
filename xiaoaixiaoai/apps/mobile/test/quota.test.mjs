import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaChip, quotaWindowText } from "../src/lib/format.ts";

test("quotaChip formats available percentages with severity tones and honest unavailable state", () => {
  assert.equal(quotaChip(undefined), null);
  assert.deepEqual(
    quotaChip({ available: true, primary: { remainingPercent: 72, windowMinutes: 10080, label: "7天" } }),
    { text: "7天余 72%", tone: "ok" },
  );
  assert.deepEqual(
    quotaChip({ available: true, primary: { remainingPercent: 25, windowMinutes: 300, label: "5小时" } }),
    { text: "5小时余 25%", tone: "warn" },
  );
  assert.deepEqual(
    quotaChip({ available: true, primary: { remainingPercent: 10 } }),
    { text: "余 10%", tone: "low" },
  );
  assert.deepEqual(
    quotaChip({ available: true, balance: "25423" }),
    { text: "余额 25423", tone: "ok" },
  );
  assert.deepEqual(
    quotaChip({ available: false, note: "未开放" }),
    { text: "配额未公开", tone: "muted" },
  );
});

test("quotaWindowText formats remaining percent and reset time cleanly", () => {
  const now = new Date(2026, 10, 21, 9, 0, 0).getTime();
  const reset = new Date(2026, 10, 21, 14, 30, 0).getTime();
  assert.equal(
    quotaWindowText({ remainingPercent: 21, windowMinutes: 10080, resetsAt: reset, label: "7天" }, now),
    "7天窗口 剩余 21% · 今天 14:30 重置",
  );
  assert.equal(
    quotaWindowText({ remainingPercent: 85, label: "5小时" }, now),
    "5小时窗口 剩余 85%",
  );
});
