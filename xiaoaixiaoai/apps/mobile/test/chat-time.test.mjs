import assert from "node:assert/strict";
import { test } from "node:test";
import { formatChatGapLabel, shouldShowTimeDivider } from "../src/lib/chat-time.ts";

test("shouldShowTimeDivider triggers on first item, 30-min gap, or day boundary", () => {
  const base = new Date(2026, 10, 20, 14, 0, 0).getTime();
  assert.equal(shouldShowTimeDivider(undefined, base), true);
  assert.equal(shouldShowTimeDivider(base, base + 10 * 60_000), false);
  assert.equal(shouldShowTimeDivider(base, base + 30 * 60_000), true);
  const nextDay = new Date(2026, 10, 21, 0, 5, 0).getTime();
  assert.equal(shouldShowTimeDivider(base, nextDay), true);
});

test("formatChatGapLabel formats today, yesterday, and older dates cleanly", () => {
  const now = new Date(2026, 10, 20, 19, 30, 0).getTime();
  const todayMsg = new Date(2026, 10, 20, 9, 5, 0).getTime();
  const ydayMsg = new Date(2026, 10, 19, 22, 15, 0).getTime();
  const olderMsg = new Date(2026, 9, 3, 8, 0, 0).getTime();
  assert.equal(formatChatGapLabel(todayMsg, now), "今天 09:05");
  assert.equal(formatChatGapLabel(ydayMsg, now), "昨天 22:15");
  assert.equal(formatChatGapLabel(olderMsg, now), "10月3日 08:00");
});
