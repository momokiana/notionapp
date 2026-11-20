import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

const wire = new URL("../../../packages/protocol/src/index.ts", import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === "@xiaoaixiaoai/protocol" ? wire : specifier, context);
  },
});
const { computeLedgerPlan, computeRecentDaysBars, formatBudgetAlert, formatYuan, parseYuanToCents } = await import("@xiaoaixiaoai/protocol");
hook.deregister();

test("parseYuanToCents and formatYuan avoid floating-point rounding drift", () => {
  assert.equal(parseYuanToCents("19.99"), 1999);
  assert.equal(parseYuanToCents("￥4,500.5 元"), 450050);
  assert.equal(parseYuanToCents("100"), 10000);
  assert.equal(parseYuanToCents("-12.3"), -1230);
  assert.equal(parseYuanToCents("abc"), null);
  assert.equal(formatYuan(1999), "19.99");
  assert.equal(formatYuan(450000), "4500");
  assert.equal(formatYuan(1250), "12.50");
});

test("computeLedgerPlan reserves unpaid fixed bills and savings goal, and re-plans tomorrow after overspending", () => {
  const date = { ym: "2026-11", ymd: "2026-11-20", day: 20, daysInMonth: 30 }; // 11 days left inclusive, 10 days after today
  const config = { enabled: true, balanceCents: 4500_00, savingsGoalCents: 2000_00, balanceUpdatedAt: 1 };
  const fixed = [
    { id: "fx1", name: "Codex 会员", amountCents: 145_00, paidYm: null, createdAt: 1 },
    { id: "fx2", name: "Gemini 会员", amountCents: 155_00, paidYm: "2026-11", createdAt: 1 }, // already paid this month
  ];

  // Start of day: 4500 - 145 - 2000 = 2355 -> / 11 = 214.09 (21409 cents)
  const initial = computeLedgerPlan(config, fixed, [], date);
  assert.equal(initial.unpaidFixedCents, 145_00);
  assert.equal(initial.paidFixedCents, 155_00);
  assert.equal(initial.spendableNowCents, 2355_00);
  assert.equal(initial.todayLimitCents, 21409);
  assert.equal(initial.todayRemainingCents, 21409);
  assert.equal(initial.overspentTodayCents, 0);

  // Spend 100 yuan: balance 4400, todayLimit stays 214.09, todayRemaining becomes 114.09
  const afterLunch = computeLedgerPlan(
    { ...config, balanceCents: 4400_00 },
    fixed,
    [{ id: "t1", ts: 2, ym: "2026-11", ymd: "2026-11-20", direction: "expense", amountCents: 100_00, title: "午饭", source: "wechat_notify" }],
    date,
  );
  assert.equal(afterLunch.todayLimitCents, 21409);
  assert.equal(afterLunch.todayRemainingCents, 11409);
  const normalAlert = formatBudgetAlert({ direction: "expense", amountCents: 100_00, title: "午饭" }, afterLunch);
  assert.equal(normalAlert.overspent, false);
  assert.match(normalAlert.body, /今天还能用 114\.09 元/);

  // Overspend with +200 yuan -> total today 300 > 214.09 -> overspent 85.91 -> remaining 10 days = (2355 - 300)/10 = 205.50/day
  const overspent = computeLedgerPlan(
    { ...config, balanceCents: 4200_00 },
    fixed,
    [
      { id: "t1", ts: 2, ym: "2026-11", ymd: "2026-11-20", direction: "expense", amountCents: 100_00, title: "午饭", source: "wechat_notify" },
      { id: "t2", ts: 3, ym: "2026-11", ymd: "2026-11-20", direction: "expense", amountCents: 200_00, title: "聚餐", source: "wechat_notify" },
    ],
    date,
  );
  assert.equal(overspent.overspentTodayCents, 8591);
  assert.equal(overspent.nextDailyLimitCents, 205_50);
  const overAlert = formatBudgetAlert({ direction: "expense", amountCents: 200_00, title: "聚餐" }, overspent);
  assert.equal(overAlert.overspent, true);
  assert.match(overAlert.title, /今日超支 85\.91 元/);
  assert.match(overAlert.body, /接下来每天最多用 205\.50 元/);
});

test("computeRecentDaysBars builds 7 chronological daily totals excluding fixed-linked payments", () => {
  const bars = computeRecentDaysBars(
    [
      { id: "1", ts: 1, ym: "2026-11", ymd: "2026-11-18", direction: "expense", amountCents: 42_00, title: "咖啡", source: "manual" },
      { id: "2", ts: 2, ym: "2026-11", ymd: "2026-11-20", direction: "expense", amountCents: 145_00, title: "Codex", source: "manual", fixedId: "fx1" },
      { id: "3", ts: 3, ym: "2026-11", ymd: "2026-11-20", direction: "expense", amountCents: 68_00, title: "晚餐", source: "wechat_notify" },
      { id: "4", ts: 4, ym: "2026-11", ymd: "2026-11-20", direction: "income", amountCents: 500_00, title: "转账", source: "wechat_notify" },
    ],
    "2026-11-20",
    7,
  );
  assert.equal(bars.length, 7);
  assert.equal(bars[0].ymd, "2026-11-14");
  assert.equal(bars[4].expenseCents, 42_00);
  assert.equal(bars[6].ymd, "2026-11-20");
  assert.equal(bars[6].expenseCents, 68_00);
});
