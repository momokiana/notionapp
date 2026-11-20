/**
 * Optional WeChat bill & monthly savings-budget planning store and REST client.
 * Stays inactive (disabled on native & hidden in UI) unless explicitly enabled in /plugins.
 */
import { useEffect } from "react";
import { AppState } from "react-native";
import { create } from "zustand";
import {
  computeLedgerPlan,
  daysInYearMonth,
  formatBudgetAlert,
  type LedgerAlertSummary,
  type LedgerFixedExpense,
  type LedgerState,
  type LedgerTransaction,
  type LedgerTxDirection,
  type LedgerTxSource,
  type ServerFrame,
} from "@xiaoaixiaoai/protocol";
import { XiaoaiNative } from "../../modules/xiaoaixiaoai-native";
import { loadToken } from "./auth";
import { isMockServer } from "./mock";
import { useLive, useSettings } from "./store";

function localDateParts(ts = Date.now()) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const ymd = `${ym}-${String(day).padStart(2, "0")}`;
  return { ym, ymd, day, daysInMonth: daysInYearMonth(year, month) };
}

function emptyState(): LedgerState {
  const date = localDateParts();
  const config = { enabled: false, balanceCents: null, savingsGoalCents: 0, balanceUpdatedAt: null };
  return {
    config,
    fixedExpenses: [],
    plan: computeLedgerPlan(config, [], [], date),
    recentTransactions: [],
  };
}

let mockConfig = { enabled: false, balanceCents: 4500_00 as number | null, savingsGoalCents: 2000_00, balanceUpdatedAt: Date.now() as number | null };
let mockFixed: LedgerFixedExpense[] = [
  { id: "fx_demo_codex", name: "Codex 会员", amountCents: 145_00, paidYm: null, createdAt: Date.now() - 86_400_000 },
  { id: "fx_demo_gemini", name: "Gemini 会员", amountCents: 140_00, paidYm: null, createdAt: Date.now() - 86_400_000 },
];
let mockTxs: LedgerTransaction[] = [];

function buildMockState(): LedgerState {
  const date = localDateParts();
  return {
    config: { ...mockConfig },
    fixedExpenses: [...mockFixed],
    plan: computeLedgerPlan(mockConfig, mockFixed, mockTxs, date),
    recentTransactions: [...mockTxs].sort((a, b) => b.ts - a.ts),
  };
}

interface LedgerStore {
  loaded: boolean;
  state: LedgerState;
  notifAccess: boolean;
  error: string | null;
}

export const useLedger = create<LedgerStore>()(() => ({
  loaded: false,
  state: emptyState(),
  notifAccess: XiaoaiNative?.notificationAccessEnabled?.() ?? false,
  error: null,
}));

function applyState(state: LedgerState): void {
  useLedger.setState({ loaded: true, state, error: null });
  try {
    XiaoaiNative?.setLedgerPluginEnabled?.(state.config.enabled);
    XiaoaiNative?.syncLedgerCache?.(JSON.stringify(state));
  } catch {
    /* older native APKs ignore optional plugin bridge */
  }
}

export function refreshNotifAccess(): void {
  const ok = XiaoaiNative?.notificationAccessEnabled?.() ?? false;
  useLedger.setState({ notifAccess: ok });
}

XiaoaiNative?.addListener("onLedgerUpdated", () => {
  void loadLedger();
});

async function ledgerApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const server = useSettings.getState().server;
  if (!server) throw new Error("还没连上服务器");
  const token = await loadToken();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      signal: abort.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error("连不上服务器，稍后再试");
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw new Error(body.error?.message ?? `请求失败（${res.status}）`);
  return body;
}

export async function loadLedger(): Promise<void> {
  const server = useSettings.getState().server;
  refreshNotifAccess();
  if (!server) return;
  if (isMockServer(server)) {
    applyState(buildMockState());
    return;
  }
  try {
    const s = await ledgerApi<LedgerState>("/v1/ledger");
    applyState(s);
    if (s.config.enabled) XiaoaiNative?.flushPendingLedger?.();
  } catch (e) {
    useLedger.setState({ loaded: true, error: (e as Error).message });
  }
}

export async function setLedgerConfig(patch: {
  enabled?: boolean;
  balanceCents?: number | null;
  savingsGoalCents?: number;
}): Promise<LedgerState> {
  if (isMockServer(useSettings.getState().server)) {
    mockConfig = {
      ...mockConfig,
      ...patch,
      balanceUpdatedAt: patch.balanceCents !== undefined ? Date.now() : mockConfig.balanceUpdatedAt,
    };
    const next = buildMockState();
    applyState(next);
    return next;
  }
  const next = await ledgerApi<LedgerState>("/v1/ledger/config", { body: patch });
  applyState(next);
  return next;
}

export async function addFixedExpense(input: { name: string; amountCents: number; paidThisMonth?: boolean }): Promise<LedgerState> {
  if (isMockServer(useSettings.getState().server)) {
    const { ym } = localDateParts();
    mockFixed = [...mockFixed, { id: `fx_${Date.now()}`, name: input.name, amountCents: input.amountCents, paidYm: input.paidThisMonth ? ym : null, createdAt: Date.now() }];
    const next = buildMockState();
    applyState(next);
    return next;
  }
  const next = await ledgerApi<LedgerState>("/v1/ledger/fixed", { body: input });
  applyState(next);
  return next;
}

export async function updateFixedExpense(
  id: string,
  patch: { name?: string; amountCents?: number; paid?: boolean },
): Promise<LedgerState> {
  if (isMockServer(useSettings.getState().server)) {
    const { ym } = localDateParts();
    mockFixed = mockFixed.map((f) =>
      f.id === id
        ? {
            ...f,
            name: patch.name ?? f.name,
            amountCents: patch.amountCents ?? f.amountCents,
            paidYm: patch.paid === undefined ? f.paidYm : patch.paid ? ym : null,
          }
        : f,
    );
    const next = buildMockState();
    applyState(next);
    return next;
  }
  const next = await ledgerApi<LedgerState>(`/v1/ledger/fixed/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  applyState(next);
  return next;
}

export async function deleteFixedExpense(id: string): Promise<LedgerState> {
  if (isMockServer(useSettings.getState().server)) {
    mockFixed = mockFixed.filter((f) => f.id !== id);
    const next = buildMockState();
    applyState(next);
    return next;
  }
  const next = await ledgerApi<LedgerState>(`/v1/ledger/fixed/${encodeURIComponent(id)}`, { method: "DELETE" });
  applyState(next);
  return next;
}

export async function addLedgerTx(input: {
  direction: LedgerTxDirection;
  amountCents: number;
  title: string;
  note?: string;
  source?: LedgerTxSource;
  fixedId?: string;
  adjustBalance?: boolean;
}): Promise<{ state: LedgerState; alert: LedgerAlertSummary }> {
  if (isMockServer(useSettings.getState().server)) {
    const ts = Date.now();
    const date = localDateParts(ts);
    const tx: LedgerTransaction = {
      id: `tx_${ts}`,
      ts,
      ym: date.ym,
      ymd: date.ymd,
      direction: input.direction,
      amountCents: input.amountCents,
      title: input.title,
      note: input.note,
      source: input.source ?? "manual",
      fixedId: input.fixedId,
    };
    mockTxs = [tx, ...mockTxs];
    if (input.adjustBalance !== false && mockConfig.balanceCents !== null) {
      mockConfig = {
        ...mockConfig,
        balanceCents: mockConfig.balanceCents + (tx.direction === "income" ? tx.amountCents : -tx.amountCents),
        balanceUpdatedAt: ts,
      };
    }
    if (tx.fixedId && tx.direction === "expense") {
      mockFixed = mockFixed.map((f) => (f.id === tx.fixedId ? { ...f, paidYm: date.ym } : f));
    }
    const next = buildMockState();
    applyState(next);
    return { state: next, alert: formatBudgetAlert(tx, next.plan) };
  }
  const res = await ledgerApi<{ state: LedgerState; alert: LedgerAlertSummary }>("/v1/ledger/transactions", { body: input });
  applyState(res.state);
  return res;
}

export async function updateLedgerTx(
  id: string,
  patch: { direction?: LedgerTxDirection; amountCents?: number; title?: string; note?: string; fixedId?: string | null },
): Promise<LedgerState> {
  if (isMockServer(useSettings.getState().server)) {
    mockTxs = mockTxs.map((t) => {
      if (t.id !== id) return t;
      const prevDelta = t.direction === "income" ? t.amountCents : -t.amountCents;
      const nextDir = patch.direction ?? t.direction;
      const nextAmt = patch.amountCents ?? t.amountCents;
      const nextDelta = nextDir === "income" ? nextAmt : -nextAmt;
      if (mockConfig.balanceCents !== null) {
        mockConfig = { ...mockConfig, balanceCents: mockConfig.balanceCents + (nextDelta - prevDelta), balanceUpdatedAt: Date.now() };
      }
      return {
        ...t,
        direction: nextDir,
        amountCents: nextAmt,
        title: patch.title ?? t.title,
        note: patch.note ?? t.note,
        fixedId: patch.fixedId === null ? undefined : (patch.fixedId ?? t.fixedId),
      };
    });
    const next = buildMockState();
    applyState(next);
    return next;
  }
  const next = await ledgerApi<LedgerState>(`/v1/ledger/transactions/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  applyState(next);
  return next;
}

export async function deleteLedgerTx(id: string): Promise<LedgerState> {
  if (isMockServer(useSettings.getState().server)) {
    const existing = mockTxs.find((t) => t.id === id);
    if (existing && mockConfig.balanceCents !== null) {
      mockConfig = {
        ...mockConfig,
        balanceCents: mockConfig.balanceCents + (existing.direction === "income" ? -existing.amountCents : existing.amountCents),
        balanceUpdatedAt: Date.now(),
      };
    }
    mockTxs = mockTxs.filter((t) => t.id !== id);
    const next = buildMockState();
    applyState(next);
    return next;
  }
  const next = await ledgerApi<LedgerState>(`/v1/ledger/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
  applyState(next);
  return next;
}

export async function clearLedgerData(): Promise<LedgerState> {
  if (isMockServer(useSettings.getState().server)) {
    mockTxs = [];
    mockFixed = [];
    mockConfig = { enabled: mockConfig.enabled, balanceCents: null, savingsGoalCents: 0, balanceUpdatedAt: null };
    const next = buildMockState();
    applyState(next);
    return next;
  }
  const next = await ledgerApi<LedgerState>("/v1/ledger", { method: "DELETE" });
  applyState(next);
  return next;
}

export function onLedgerFrame(f: ServerFrame): boolean {
  if (f.type === "ledger_updated") {
    void loadLedger();
    return true;
  }
  return false;
}

/** Keeps ledger plugin config/cache synced across foreground switches and server connects. */
export function useLedgerSync(): void {
  const hydrated = useSettings((s) => s.hydrated);
  const server = useSettings((s) => s.server);
  const link = useLive((s) => s.link);
  useEffect(() => {
    if (!hydrated || !server) return;
    if (link === "online" || isMockServer(server)) void loadLedger();
  }, [hydrated, server, link]);

  useEffect(() => {
    if (!hydrated) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        refreshNotifAccess();
        if (server && (link === "online" || isMockServer(server))) void loadLedger();
      }
    });
    return () => sub.remove();
  }, [hydrated, server, link]);
}
