import {
  formatBudgetAlert,
  formatYuan,
  parseYuanToCents,
  type LedgerFixedExpense,
  type LedgerState,
  type LedgerTransaction,
  type LedgerTxDirection,
} from "@xiaoaixiaoai/protocol";
import type { ToolDef } from "./llm.ts";
import type { LedgerService } from "../ledger/service.ts";

export const LEDGER_TOOL_NAMES = new Set([
  "ledger_status",
  "ledger_set_plan",
  "ledger_manage_fixed",
  "ledger_add_transaction",
  "ledger_edit_transaction",
]);

export const LEDGER_TOOLS: ToolDef[] = [
  {
    name: "ledger_status",
    description: "查看微信账单插件的当前统计：推算微信余额、本月收入/支出、想省出目标、每月固定开支（含本月是否已扣）、今日剩余额度/超支重算后的每日限额，以及最近流水明细。问“这个月花了多少”“今天还能用多少”“有哪些固定开支”“刚才记了什么账”时先查这个。",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "列出最近多少条流水，默认 12，最多 40" },
      },
    },
  },
  {
    name: "ledger_set_plan",
    description: "设置或校准当前微信余额，或设置本月月底至少保留（想省出）的目标金额。用户说“我现在微信余额是 4500”“帮我校准微信余额到 3820”“这个月我想省出 2000 块”时使用。",
    input_schema: {
      type: "object",
      properties: {
        balance_yuan: { type: "number", description: "当前微信余额（元），例如 4500 或 3820.5" },
        savings_goal_yuan: { type: "number", description: "本月想省出/月底至少保留的金额（元），例如 2000" },
      },
    },
  },
  {
    name: "ledger_manage_fixed",
    description: "管理每月固定必要开支（如 Codex 会员、Gemini 会员、话费房租）：添加、修改金额、删除，或标记某项固定开支本月已扣/待扣（未扣的会自动从微信余额中预留扣除后再算每日限额）。",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "delete", "mark_paid", "mark_unpaid"], description: "操作类型" },
        name: { type: "string", description: "固定开支名称，如 Codex 会员、Gemini 会员（添加时必填，更新/删除/标记时也可用于匹配）" },
        id: { type: "string", description: "已有固定开支 id（fx_...），可选" },
        amount_yuan: { type: "number", description: "每月金额（元），添加必填，更新时可选" },
        paid_this_month: { type: "boolean", description: "添加时是否已在本月扣过款（默认 false=本月待扣）" },
      },
      required: ["action"],
    },
  },
  {
    name: "ledger_add_transaction",
    description: "记一笔微信支出或收入（自动加减当前微信余额并返回今天还能花多少 / 是否超支重算）。如果这笔消费正好是某个每月固定开支（比如交了 Codex 会员费），填 fixed_name 可关联该固定开支并自动标为本月已扣，不会重复扣今天日常额度。",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["expense", "income"], description: "expense=支出，income=收入/收款" },
        amount_yuan: { type: "number", description: "金额（元），必须大于 0" },
        title: { type: "string", description: "商家或摘要，如 午饭、奶茶、收到转账、Codex 会员" },
        note: { type: "string", description: "备注，可选" },
        fixed_name: { type: "string", description: "若该支出对应某项每月固定开支，填其名称或 id" },
        adjust_balance: { type: "boolean", description: "是否同步增减当前微信余额，默认 true；如果用户说余额已单独校准则传 false" },
      },
      required: ["direction", "amount_yuan", "title"],
    },
  },
  {
    name: "ledger_edit_transaction",
    description: "修改或删除一笔已有账单记录（会自动修正推算的微信余额和每日限额）。用户说“刚才那笔 38 记错了改成 35”“删掉刚刚多记的一笔”时使用。",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["update", "delete"], description: "update=修改，delete=删除" },
        id: { type: "string", description: "账单流水 id（tx_...），或填 latest 表示最近一条" },
        direction: { type: "string", enum: ["expense", "income"], description: "改类型（仅 update）" },
        amount_yuan: { type: "number", description: "改金额（元，仅 update）" },
        title: { type: "string", description: "改摘要（仅 update）" },
        note: { type: "string", description: "改备注（仅 update）" },
        fixed_name: { type: "string", description: "关联固定开支名/id，传空字符串可取消关联" },
      },
      required: ["action"],
    },
  },
];

function matchFixed(list: LedgerFixedExpense[], ref: unknown): LedgerFixedExpense | undefined {
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  const q = ref.trim().toLowerCase();
  return list.find((f) => f.id === ref.trim()) ?? list.find((f) => f.name.toLowerCase() === q) ?? list.find((f) => f.name.toLowerCase().includes(q));
}

function matchTx(list: LedgerTransaction[], id: unknown): LedgerTransaction | undefined {
  if (typeof id === "string" && id.trim()) {
    const t = id.trim();
    if (t === "latest") return list[0];
    return list.find((x) => x.id === t);
  }
  return list[0];
}

export function formatLedgerSummary(state: LedgerState, limit = 12): string {
  const { config, fixedExpenses, plan, recentTransactions } = state;
  const lines = [
    `# 微信账单与攒钱规划（${plan.ymd}，本月共 ${plan.daysInMonth} 天，含今天剩 ${plan.daysLeftInclusive} 天）`,
    `推算微信余额：${plan.balanceCents !== null ? `${formatYuan(plan.balanceCents)} 元` : "未设置（需要用户先报一次当前余额）"}`,
    `月底保底想省：${formatYuan(config.savingsGoalCents)} 元`,
    `本月累计收入：${formatYuan(plan.monthIncomeCents)} 元｜本月累计支出：${formatYuan(plan.monthExpenseCents)} 元（其中今日支出 ${formatYuan(plan.todayExpenseCents)} 元）`,
    `固定必要开支：本月待扣 ${formatYuan(plan.unpaidFixedCents)} 元，本月已扣 ${formatYuan(plan.paidFixedCents)} 元`,
  ];
  if (fixedExpenses.length) {
    lines.push(
      `固定开支清单：${fixedExpenses
        .map((f) => `${f.name} ${formatYuan(f.amountCents)}元(${f.paidYm === plan.ym ? "本月已扣" : "本月待扣"}, id=${f.id})`)
        .join("；")}`,
    );
  }
  if (plan.todayRemainingCents !== null) {
    lines.push(
      `日常可支配余钱（扣掉待扣固定开支与保底目标）：${formatYuan(plan.spendableNowCents ?? 0)} 元`,
      plan.overspentTodayCents > 0
        ? `今日限额 ${formatYuan(plan.todayLimitCents ?? 0)} 元｜今日已超支 ${formatYuan(plan.overspentTodayCents)} 元${
            plan.daysLeftAfterToday > 0 ? `｜已重算：明天起剩余 ${plan.daysLeftAfterToday} 天每天最多用 ${formatYuan(plan.nextDailyLimitCents ?? 0)} 元` : "｜今日是本月最后一天"
          }`
        : `今日最初限额 ${formatYuan(plan.todayLimitCents ?? 0)} 元｜今日还能用 ${formatYuan(plan.todayRemainingCents)} 元`,
    );
  }
  const show = recentTransactions.slice(0, Math.max(1, Math.min(limit, 40)));
  if (show.length) {
    lines.push("最近流水：");
    for (const tx of show) {
      const sign = tx.direction === "income" ? "+" : "-";
      lines.push(
        `- [${tx.id}] ${tx.ymd} ${sign}${formatYuan(tx.amountCents)}元 | ${tx.title}${tx.note ? `（${tx.note}）` : ""} | 来源=${tx.source}${tx.fixedId ? " | 关联固定开支" : ""}`,
      );
    }
  } else {
    lines.push("最近流水：暂无");
  }
  return lines.join("\n");
}

/** Compact context snippet injected into system prompt only while plugin is enabled. */
export function ledgerPromptSnippet(ledger: LedgerService): string {
  const s = ledger.state();
  const { plan } = s;
  const bal = plan.balanceCents !== null ? `${formatYuan(plan.balanceCents)}元` : "未设余额";
  const quota =
    plan.todayRemainingCents === null
      ? "等待设余额后规划每日额度"
      : plan.overspentTodayCents > 0
        ? `今日已超支${formatYuan(plan.overspentTodayCents)}元，明天起每日限额${formatYuan(plan.nextDailyLimitCents ?? 0)}元`
        : `今天还能用${formatYuan(plan.todayRemainingCents)}元`;
  return `\n# 已开启插件：微信账单与攒钱规划\n当前推算微信余额 ${bal}，本月想省 ${formatYuan(plan.savingsGoalCents)}元，待扣固定开支 ${formatYuan(plan.unpaidFixedCents)}元，${quota}。涉及查账、设置余额/想省金额、固定开支（如 Codex/Gemini 会员）、补记/修改/删账单时，必须调用 ledger_* 工具后再照真实返回答复。`;
}

function centsArg(val: unknown, label: string, allowZero = false): number {
  const c = parseYuanToCents(val as string | number);
  if (c === null || (allowZero ? c < 0 : c <= 0)) throw new Error(`${label}格式不对或不能为${allowZero ? "负" : "0 或负"}`);
  return c;
}

export function runLedgerTool(
  ledger: LedgerService,
  name: string,
  input: Record<string, unknown>,
): { out: string; step: string } {
  if (!ledger.isEnabled()) throw new Error("微信账单与攒钱规划插件当前未启用，请用户先在「设置 → 功能插件」中打开。");

  switch (name) {
    case "ledger_status": {
      const limit = Number(input.limit ?? 12) || 12;
      return { out: formatLedgerSummary(ledger.state(), limit), step: "看了微信账单与预算" };
    }
    case "ledger_set_plan": {
      const patch: { balanceCents?: number; savingsGoalCents?: number } = {};
      if (input.balance_yuan !== undefined && input.balance_yuan !== null && input.balance_yuan !== "") {
        const c = parseYuanToCents(input.balance_yuan as string | number);
        if (c === null) throw new Error("微信余额格式不对");
        patch.balanceCents = c;
      }
      if (input.savings_goal_yuan !== undefined && input.savings_goal_yuan !== null && input.savings_goal_yuan !== "") {
        patch.savingsGoalCents = centsArg(input.savings_goal_yuan, "想省金额", true);
      }
      if (patch.balanceCents === undefined && patch.savingsGoalCents === undefined) {
        throw new Error("需要提供 balance_yuan（当前微信余额）或 savings_goal_yuan（本月想省金额）");
      }
      const next = ledger.updateConfig(patch);
      return { out: formatLedgerSummary(next, 6), step: "更新了微信余额和攒钱规划" };
    }
    case "ledger_manage_fixed": {
      const action = String(input.action ?? "");
      const cur = ledger.state();
      if (action === "add") {
        const label = typeof input.name === "string" ? input.name.trim() : "";
        if (!label) throw new Error("添加固定开支需要名称");
        const amountCents = centsArg(input.amount_yuan, "固定开支金额");
        const { state } = ledger.addFixed({ name: label, amountCents, paidThisMonth: input.paid_this_month === true });
        return { out: `已添加每月固定开支「${label}」${formatYuan(amountCents)} 元。\n${formatLedgerSummary(state, 5)}`, step: `添加了固定开支「${label}」` };
      }
      const target = matchFixed(cur.fixedExpenses, input.id) ?? matchFixed(cur.fixedExpenses, input.name);
      if (!target) throw new Error(`找不到对应的固定开支。现有：${cur.fixedExpenses.map((f) => f.name).join("、") || "无"}`);
      if (action === "delete") {
        const state = ledger.deleteFixed(target.id);
        return { out: `已删除固定开支「${target.name}」。\n${formatLedgerSummary(state, 5)}`, step: `删了固定开支「${target.name}」` };
      }
      if (action === "mark_paid" || action === "mark_unpaid") {
        const { state } = ledger.updateFixed(target.id, { paid: action === "mark_paid" });
        return {
          out: `已将「${target.name}」标为${action === "mark_paid" ? "本月已扣" : "本月待扣"}。\n${formatLedgerSummary(state, 5)}`,
          step: `更新了「${target.name}」状态`,
        };
      }
      if (action === "update") {
        const patch: { name?: string; amountCents?: number; paid?: boolean } = {};
        if (typeof input.name === "string" && input.name.trim() && input.id) patch.name = input.name.trim();
        if (input.amount_yuan !== undefined) patch.amountCents = centsArg(input.amount_yuan, "固定开支金额");
        if (typeof input.paid_this_month === "boolean") patch.paid = input.paid_this_month;
        const { item, state } = ledger.updateFixed(target.id, patch);
        return { out: `已更新固定开支「${item.name}」为 ${formatYuan(item.amountCents)} 元。\n${formatLedgerSummary(state, 5)}`, step: `修改了固定开支「${item.name}」` };
      }
      throw new Error(`未知固定开支操作：${action}`);
    }
    case "ledger_add_transaction": {
      const direction = input.direction === "income" || input.direction === "expense" ? (input.direction as LedgerTxDirection) : null;
      if (!direction) throw new Error("direction 需要是 expense 或 income");
      const amountCents = centsArg(input.amount_yuan, "账单金额");
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title) throw new Error("需要账单标题/摘要");
      const cur = ledger.state();
      const fixed = input.fixed_name ? matchFixed(cur.fixedExpenses, input.fixed_name) : undefined;
      const res = ledger.recordTransaction({
        direction,
        amountCents,
        title,
        note: typeof input.note === "string" ? input.note : undefined,
        source: "assistant",
        fixedId: fixed?.id,
        adjustBalance: input.adjust_balance !== false,
      });
      const alert = formatBudgetAlert(res.transaction, res.state.plan);
      return { out: `${alert.title}：${alert.body}\n${formatLedgerSummary(res.state, 6)}`, step: `记了一笔${direction === "income" ? "收入" : "支出"} ${formatYuan(amountCents)}元` };
    }
    case "ledger_edit_transaction": {
      const action = String(input.action ?? "");
      const cur = ledger.state();
      const tx = matchTx(cur.recentTransactions, input.id);
      if (!tx) throw new Error("找不到要修改的账单记录");
      if (action === "delete") {
        const { state } = ledger.deleteTransaction(tx.id, true);
        return { out: `已删除流水「${tx.title} ${formatYuan(tx.amountCents)} 元」并修正余额。\n${formatLedgerSummary(state, 5)}`, step: "删了一条账单记录" };
      }
      if (action === "update") {
        const patch: { direction?: LedgerTxDirection; amountCents?: number; title?: string; note?: string; fixedId?: string | null } = {};
        if (input.direction === "income" || input.direction === "expense") patch.direction = input.direction;
        if (input.amount_yuan !== undefined) patch.amountCents = centsArg(input.amount_yuan, "新金额");
        if (typeof input.title === "string" && input.title.trim()) patch.title = input.title.trim();
        if (typeof input.note === "string") patch.note = input.note;
        if (typeof input.fixed_name === "string") {
          patch.fixedId = input.fixed_name.trim() ? (matchFixed(cur.fixedExpenses, input.fixed_name)?.id ?? null) : null;
        }
        const state = ledger.updateTransaction(tx.id, patch);
        return { out: `已修改流水 [${tx.id}]。\n${formatLedgerSummary(state, 5)}`, step: "改了一条账单记录" };
      }
      throw new Error(`未知流水操作：${action}`);
    }
    default:
      throw new Error(`未知账单工具：${name}`);
  }
}
