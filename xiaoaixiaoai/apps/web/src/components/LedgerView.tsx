import React, { useMemo, useState } from "react";
import { computeRecentDaysBars, formatYuan, parseYuanToCents, type LedgerState, type LedgerTxDirection } from "@xiaoaixiaoai/protocol";
import { Check, Plus, RefreshCw, Trash2, Wallet } from "lucide-react";

interface Props {
  ledger: LedgerState | null;
  onRefresh: () => Promise<void>;
  onUpdateConfig: (patch: { enabled?: boolean; balanceCents?: number | null; savingsGoalCents?: number }) => Promise<void>;
  onAddFixed: (input: { name: string; amountCents: number }) => Promise<void>;
  onToggleFixed: (id: string, paid: boolean) => Promise<void>;
  onDeleteFixed: (id: string) => Promise<void>;
  onAddTx: (input: { direction: LedgerTxDirection; amountCents: number; title: string; note?: string }) => Promise<void>;
  onDeleteTx: (id: string) => Promise<void>;
  onToast: (msg: string) => void;
}

export function LedgerView({
  ledger,
  onRefresh,
  onUpdateConfig,
  onAddFixed,
  onToggleFixed,
  onDeleteFixed,
  onAddTx,
  onDeleteTx,
  onToast,
}: Props) {
  const [balanceInput, setBalanceInput] = useState("");
  const [savingsInput, setSavingsInput] = useState("");
  const [fixedName, setFixedName] = useState("");
  const [fixedYuan, setFixedYuan] = useState("");
  const [txDir, setTxDir] = useState<LedgerTxDirection>("expense");
  const [txTitle, setTxTitle] = useState("");
  const [txYuan, setTxYuan] = useState("");
  const [busy, setBusy] = useState(false);

  const bars = useMemo(() => {
    if (!ledger) return [];
    return computeRecentDaysBars(ledger.recentTransactions, ledger.plan.ymd, 7);
  }, [ledger]);

  const maxBar = useMemo(() => Math.max(100, ...bars.map((b) => b.expenseCents)), [bars]);

  if (!ledger) {
    return (
      <div className="page-scroll" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <button type="button" className="icon-btn" onClick={() => void onRefresh()}>
          <RefreshCw size={15} /> 加载微信账单
        </button>
      </div>
    );
  }

  const { plan, config, fixedExpenses, recentTransactions } = ledger;

  const saveBalance = async () => {
    const cents = parseYuanToCents(balanceInput);
    if (cents === null) {
      onToast("请输入有效的金额，例如 1280.50");
      return;
    }
    setBusy(true);
    try {
      await onUpdateConfig({ balanceCents: cents });
      setBalanceInput("");
      onToast("已校准当前余额");
    } catch (err) {
      onToast(`校准失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveSavings = async () => {
    const cents = parseYuanToCents(savingsInput);
    if (cents === null || cents < 0) {
      onToast("请输入非负的月底保底金额");
      return;
    }
    setBusy(true);
    try {
      await onUpdateConfig({ savingsGoalCents: cents });
      setSavingsInput("");
      onToast("已更新月底保底目标");
    } catch (err) {
      onToast(`更新失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const submitFixed = async (e: React.FormEvent) => {
    e.preventDefault();
    const cents = parseYuanToCents(fixedYuan);
    if (!fixedName.trim() || cents === null || cents <= 0) {
      onToast("请填写固定开支名称和正数金额");
      return;
    }
    setBusy(true);
    try {
      await onAddFixed({ name: fixedName.trim(), amountCents: cents });
      setFixedName("");
      setFixedYuan("");
    } catch (err) {
      onToast(`添加失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const submitTx = async (e: React.FormEvent) => {
    e.preventDefault();
    const cents = parseYuanToCents(txYuan);
    if (!txTitle.trim() || cents === null || cents <= 0) {
      onToast("请填写账单摘要和正数金额");
      return;
    }
    setBusy(true);
    try {
      await onAddTx({ direction: txDir, amountCents: cents, title: txTitle.trim() });
      setTxTitle("");
      setTxYuan("");
    } catch (err) {
      onToast(`记账失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-scroll">
      <div style={{ maxWidth: 1120, margin: "0 auto 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Wallet size={20} style={{ color: "var(--accent-text)" }} />
          <h2 style={{ margin: 0, fontSize: 18 }}>微信账单与每日预算 ({plan.ym})</h2>
        </div>
        <button type="button" className="icon-btn" onClick={() => void onRefresh()}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      <div className="dashboard-grid">
        {/* Balance & Daily Quota */}
        <div className="card">
          <h3>当前预算概览</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--faint)" }}>微信当前余额</div>
              <div className="stat-value">
                {plan.balanceCents !== null ? `¥${formatYuan(plan.balanceCents)}` : "未校准"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--faint)" }}>今日剩余可用</div>
              <div className="stat-value" style={{ color: (plan.todayRemainingCents ?? 0) < 0 ? "var(--error)" : "var(--ok)" }}>
                {plan.todayRemainingCents !== null ? `¥${formatYuan(plan.todayRemainingCents)}` : "--"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--faint)" }}>今日上限 / 已支出</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {plan.todayLimitCents !== null ? `¥${formatYuan(plan.todayLimitCents)}` : "--"} / ¥{formatYuan(plan.todayExpenseCents)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "var(--faint)" }}>本月支出 / 收入</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                -¥{formatYuan(plan.monthExpenseCents)} / +¥{formatYuan(plan.monthIncomeCents)}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              className="search-input"
              value={balanceInput}
              onChange={(e) => setBalanceInput(e.target.value)}
              placeholder={`校准余额 (当前 ${plan.balanceCents !== null ? formatYuan(plan.balanceCents) : "未设"})`}
            />
            <button type="button" className="icon-btn primary" disabled={busy} onClick={() => void saveBalance()}>
              校准
            </button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="search-input"
              value={savingsInput}
              onChange={(e) => setSavingsInput(e.target.value)}
              placeholder={`月底保底目标 (当前 ¥${formatYuan(config.savingsGoalCents)})`}
            />
            <button type="button" className="icon-btn" disabled={busy} onClick={() => void saveSavings()}>
              保存目标
            </button>
          </div>
        </div>

        {/* 7-day bar chart */}
        <div className="card">
          <h3>近 7 天自由消费趋势</h3>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 155, paddingTop: 14 }}>
            {bars.map((b) => {
              const pct = Math.max(4, Math.round((b.expenseCents / maxBar) * 100));
              const isToday = b.ymd === plan.ymd;
              return (
                <div key={b.ymd} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%", justifyContent: "flex-end" }}>
                  <span style={{ fontSize: 11, color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>
                    {b.expenseCents > 0 ? formatYuan(b.expenseCents) : ""}
                  </span>
                  <div
                    style={{
                      width: "100%",
                      maxWidth: 32,
                      height: `${pct}%`,
                      borderRadius: "8px 8px 4px 4px",
                      background: isToday ? "var(--primary-strong)" : "var(--sky)",
                    }}
                  />
                  <span style={{ fontSize: 11.5, fontWeight: isToday ? 700 : 500, color: isToday ? "var(--accent-text)" : "var(--muted)" }}>
                    {b.label}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: "var(--faint)", marginTop: 10 }}>
            本月剩余 {plan.daysLeftInclusive} 天 · 未付固定开支 ¥{formatYuan(plan.unpaidFixedCents)}
            {plan.nextDailyLimitCents !== null ? ` · 明起每日上限 ¥${formatYuan(plan.nextDailyLimitCents)}` : ""}
          </div>
        </div>

        {/* Fixed expenses */}
        <div className="card">
          <h3>每月固定开支（房租/话费等）</h3>
          <form onSubmit={submitFixed} style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input className="search-input" value={fixedName} onChange={(e) => setFixedName(e.target.value)} placeholder="项目名" />
            <input className="search-input" style={{ width: 92 }} value={fixedYuan} onChange={(e) => setFixedYuan(e.target.value)} placeholder="金额" />
            <button type="submit" className="icon-btn primary" disabled={busy}>
              <Plus size={14} />
            </button>
          </form>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {fixedExpenses.length === 0 && <div style={{ fontSize: 12.5, color: "var(--faint)" }}>还没有设置固定开支</div>}
            {fixedExpenses.map((f) => {
              const paid = f.paidYm === plan.ym;
              return (
                <div key={f.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 10px", borderRadius: 12, background: "var(--surface-2)" }}>
                  <button
                    type="button"
                    className={`mini-btn ${paid ? "active" : ""}`}
                    onClick={() => void onToggleFixed(f.id, !paid)}
                  >
                    <Check size={12} /> {paid ? "本月已付" : "未付"}
                  </button>
                  <span style={{ flex: 1, marginLeft: 8, fontSize: 13.5, textDecoration: paid ? "line-through" : "none", color: paid ? "var(--faint)" : "var(--ink)" }}>
                    {f.name}
                  </span>
                  <strong style={{ marginRight: 8 }}>¥{formatYuan(f.amountCents)}</strong>
                  <button type="button" className="mini-btn" onClick={() => void onDeleteFixed(f.id)} title="删除">
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Manual record + Recent transactions */}
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h3>手动记一笔 & 最近流水</h3>
          <form onSubmit={submitTx} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            <select className="search-input" style={{ width: 96 }} value={txDir} onChange={(e) => setTxDir(e.target.value as LedgerTxDirection)}>
              <option value="expense">支出</option>
              <option value="income">收入</option>
            </select>
            <input className="search-input" style={{ flex: 1, minWidth: 160 }} value={txTitle} onChange={(e) => setTxTitle(e.target.value)} placeholder="商户或用途（例如：午饭、打车）" />
            <input className="search-input" style={{ width: 110 }} value={txYuan} onChange={(e) => setTxYuan(e.target.value)} placeholder="金额 (元)" />
            <button type="submit" className="icon-btn primary" disabled={busy}>
              <Plus size={14} /> 记一笔
            </button>
          </form>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recentTransactions.length === 0 && <div style={{ fontSize: 13, color: "var(--faint)" }}>最近暂无流水记录</div>}
            {recentTransactions.slice(0, 40).map((tx) => (
              <div key={tx.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderRadius: 12, background: "var(--surface-2)", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{tx.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
                    {tx.ymd} · {tx.source === "wechat_notify" ? "微信自动捕获" : tx.source === "assistant" ? "爱弥斯代记" : "手动记账"}
                    {tx.note ? ` · ${tx.note}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <strong style={{ color: tx.direction === "income" ? "var(--ok)" : "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
                    {tx.direction === "income" ? "+" : "-"}¥{formatYuan(tx.amountCents)}
                  </strong>
                  <button type="button" className="mini-btn" onClick={() => void onDeleteTx(tx.id)} title="删除记录">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
