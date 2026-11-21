import { randomUUID } from "node:crypto";
import {
  computeLedgerPlan,
  daysInYearMonth,
  formatBudgetAlert,
  type LedgerAlertSummary,
  type LedgerDateParts,
  type LedgerFixedExpense,
  type LedgerState,
  type LedgerTransaction,
  type LedgerTxDirection,
  type LedgerTxSource,
} from "@xiaoaixiaoai/protocol";
import { timeZone } from "../assistant/timezone.ts";
import type { Store } from "../store.ts";

/** Current calendar date in the relay's active time zone (`Asia/Shanghai` by default). */
export function ledgerDateParts(ts: number, zone = timeZone()): LedgerDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ts);
  const get = (k: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === k)?.value ?? "";
  const year = Number.parseInt(get("year"), 10) || 2026;
  const month = Number.parseInt(get("month"), 10) || 1;
  const day = Number.parseInt(get("day"), 10) || 1;
  const ym = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  const ymd = `${ym}-${String(day).padStart(2, "0")}`;
  return { ym, ymd, day, daysInMonth: daysInYearMonth(year, month) };
}

function validCents(n: unknown, allowZero = false): number {
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) throw new Error("金额需要是以分为单位的整数");
  if (allowZero ? n < 0 : n <= 0) throw new Error(allowZero ? "金额不能是负数" : "金额必须大于 0");
  if (n > 10_000_000_00) throw new Error("金额超出上限");
  return n;
}

export class LedgerService {
  private store: Store;
  private onChanged: () => void;
  private now: () => number;

  constructor(store: Store, onChanged: () => void = () => undefined, now: () => number = () => Date.now()) {
    this.store = store;
    this.onChanged = onChanged;
    this.now = now;
  }

  isEnabled(): boolean {
    return this.store.getLedgerConfig().enabled;
  }

  state(ts = this.now()): LedgerState {
    const config = this.store.getLedgerConfig();
    const fixedExpenses = this.store.listLedgerFixed();
    const date = ledgerDateParts(ts);
    const monthTxs = this.store.listLedgerTransactionsByMonth(date.ym);
    const recentTransactions = this.store.listRecentLedgerTransactions(120);
    return {
      config,
      fixedExpenses,
      plan: computeLedgerPlan(config, fixedExpenses, monthTxs, date),
      recentTransactions,
    };
  }

  updateConfig(patch: { enabled?: boolean; balanceCents?: number | null; savingsGoalCents?: number }): LedgerState {
    const cur = this.store.getLedgerConfig();
    const t = this.now();
    const next = { ...cur };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (patch.balanceCents !== undefined) {
      if (patch.balanceCents === null) {
        next.balanceCents = null;
        next.balanceUpdatedAt = t;
      } else {
        if (typeof patch.balanceCents !== "number" || !Number.isFinite(patch.balanceCents) || !Number.isInteger(patch.balanceCents)) {
          throw new Error("余额需要是有效整数金额（分）");
        }
        if (Math.abs(patch.balanceCents) > 10_000_000_00) throw new Error("余额超出范围");
        next.balanceCents = patch.balanceCents;
        next.balanceUpdatedAt = t;
      }
    }
    if (patch.savingsGoalCents !== undefined) {
      next.savingsGoalCents = validCents(patch.savingsGoalCents, true);
    }
    this.store.putLedgerConfig(next);
    this.onChanged();
    return this.state(t);
  }

  addFixed(input: { name: string; amountCents: number; paidThisMonth?: boolean }): { item: LedgerFixedExpense; state: LedgerState } {
    const name = String(input.name ?? "").trim().slice(0, 60);
    if (!name) throw new Error("固定开支需要名称");
    const amountCents = validCents(input.amountCents, false);
    const t = this.now();
    const { ym } = ledgerDateParts(t);
    const item: LedgerFixedExpense = {
      id: `fx_${randomUUID().slice(0, 12)}`,
      name,
      amountCents,
      paidYm: input.paidThisMonth ? ym : null,
      createdAt: t,
    };
    this.store.putLedgerFixed(item);
    this.onChanged();
    return { item, state: this.state(t) };
  }

  updateFixed(id: string, patch: { name?: string; amountCents?: number; paid?: boolean }): { item: LedgerFixedExpense; state: LedgerState } {
    const existing = this.store.getLedgerFixed(id);
    if (!existing) throw new Error("找不到这项固定开支");
    const t = this.now();
    const { ym } = ledgerDateParts(t);
    const item: LedgerFixedExpense = {
      ...existing,
      name: patch.name !== undefined ? String(patch.name).trim().slice(0, 60) || existing.name : existing.name,
      amountCents: patch.amountCents !== undefined ? validCents(patch.amountCents, false) : existing.amountCents,
      paidYm: patch.paid === undefined ? existing.paidYm : patch.paid ? ym : null,
    };
    this.store.putLedgerFixed(item);
    this.onChanged();
    return { item, state: this.state(t) };
  }

  deleteFixed(id: string): LedgerState {
    if (!this.store.deleteLedgerFixed(id)) throw new Error("找不到这项固定开支");
    this.onChanged();
    return this.state();
  }

  recordTransaction(input: {
    direction: LedgerTxDirection;
    amountCents: number;
    title: string;
    note?: string;
    source?: LedgerTxSource;
    externalId?: string;
    fixedId?: string;
    ts?: number;
    adjustBalance?: boolean;
  }): { duplicate: boolean; transaction: LedgerTransaction; state: LedgerState; alert: LedgerAlertSummary } {
    if (input.direction !== "expense" && input.direction !== "income") throw new Error("类型只能是 expense 或 income");
    const amountCents = validCents(input.amountCents, false);
    const title = String(input.title ?? "").trim().slice(0, 80) || (input.direction === "income" ? "微信收款" : "微信消费");
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) || undefined : undefined;
    const source: LedgerTxSource = input.source === "wechat_notify" || input.source === "assistant" ? input.source : "manual";
    const ts = typeof input.ts === "number" && Number.isFinite(input.ts) && input.ts > 0 ? input.ts : this.now();
    const date = ledgerDateParts(ts);
    const externalId = typeof input.externalId === "string" ? input.externalId.trim().slice(0, 128) || undefined : undefined;
    const fixedId =
      input.direction === "expense" && typeof input.fixedId === "string" && this.store.getLedgerFixed(input.fixedId)
        ? input.fixedId
        : undefined;
    const tx: LedgerTransaction = {
      id: `tx_${randomUUID().slice(0, 12)}`,
      ts,
      ym: date.ym,
      ymd: date.ymd,
      direction: input.direction,
      amountCents,
      title,
      note,
      source,
      externalId,
      fixedId,
    };
    const res = this.store.insertLedgerTransactionAtomic(tx, input.adjustBalance !== false);
    const liveNow = this.now();
    if (res.duplicate && res.existing) {
      const s = this.state(liveNow);
      return { duplicate: true, transaction: res.existing, state: s, alert: formatBudgetAlert(res.existing, s.plan) };
    }
    this.onChanged();
    const s = this.state(liveNow);
    return { duplicate: false, transaction: tx, state: s, alert: formatBudgetAlert(tx, s.plan) };
  }

  updateTransaction(
    id: string,
    patch: { direction?: LedgerTxDirection; amountCents?: number; title?: string; note?: string; fixedId?: string | null },
  ): LedgerState {
    const prev = this.store.getLedgerTransaction(id);
    if (!prev) throw new Error("找不到这条账单记录");
    const nextDirection = patch.direction ?? prev.direction;
    if (nextDirection !== "expense" && nextDirection !== "income") throw new Error("类型只能是 expense 或 income");
    const next: LedgerTransaction = {
      ...prev,
      direction: nextDirection,
      amountCents: patch.amountCents !== undefined ? validCents(patch.amountCents, false) : prev.amountCents,
      title: patch.title !== undefined ? String(patch.title).trim().slice(0, 80) || prev.title : prev.title,
      note: patch.note !== undefined ? String(patch.note).trim().slice(0, 200) || undefined : prev.note,
      fixedId:
        nextDirection !== "expense"
          ? undefined
          : patch.fixedId === null
            ? undefined
            : patch.fixedId !== undefined
              ? this.store.getLedgerFixed(patch.fixedId)?.id
              : prev.fixedId,
    };
    this.store.updateLedgerTransactionAtomic(prev, next, this.now());
    this.onChanged();
    return this.state();
  }

  deleteTransaction(id: string, adjustBalance = true): { deleted: boolean; state: LedgerState } {
    const deleted = this.store.deleteLedgerTransactionAtomic(id, adjustBalance, this.now());
    if (deleted) this.onChanged();
    return { deleted: !!deleted, state: this.state() };
  }

  clearData(): LedgerState {
    this.store.clearLedgerData();
    this.onChanged();
    return this.state();
  }
}
