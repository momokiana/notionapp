import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Button, Dialog, Divider, Portal, SegmentedButtons, Snackbar, Switch, Text, TextInput } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  computeRecentDaysBars,
  formatYuan,
  parseYuanToCents,
  type LedgerDayBar,
  type LedgerFixedExpense,
  type LedgerTransaction,
  type LedgerTxDirection,
} from "@xiaoaixiaoai/protocol";
import { Card, PageBackground, SectionHeader } from "../components/ui";
import {
  addFixedExpense,
  addLedgerTx,
  deleteFixedExpense,
  deleteLedgerTx,
  loadLedger,
  setLedgerConfig,
  updateFixedExpense,
  updateLedgerTx,
  useLedger,
} from "../lib/ledger";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

const SOURCE_LABEL = {
  wechat_notify: "微信捕获",
  assistant: "小爱记账",
  manual: "手动记账",
} as const;

function clockDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function LedgerScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { state, notifAccess } = useLedger();
  const { config, fixedExpenses, plan, recentTransactions } = state;
  const [toast, setToast] = useState<string | null>(null);

  // Dialog states
  const [planOpen, setPlanOpen] = useState(false);
  const [balInput, setBalInput] = useState("");
  const [goalInput, setGoalInput] = useState("");

  const [fixedOpen, setFixedOpen] = useState(false);
  const [fixedName, setFixedName] = useState("");
  const [fixedAmt, setFixedAmt] = useState("");
  const [fixedPaid, setFixedPaid] = useState(false);

  const [txOpen, setTxOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<LedgerTransaction | null>(null);
  const [txDir, setTxDir] = useState<LedgerTxDirection>("expense");
  const [txAmt, setTxAmt] = useState("");
  const [txTitle, setTxTitle] = useState("");
  const [txNote, setTxNote] = useState("");
  const [txFixedId, setTxFixedId] = useState<string | undefined>(undefined);

  useEffect(() => {
    void loadLedger();
  }, []);

  function openPlanModal() {
    setBalInput(config.balanceCents !== null ? formatYuan(config.balanceCents) : "");
    setGoalInput(config.savingsGoalCents ? formatYuan(config.savingsGoalCents) : "");
    setPlanOpen(true);
  }

  async function savePlanModal() {
    const patch: { balanceCents?: number; savingsGoalCents?: number } = {};
    if (balInput.trim()) {
      const c = parseYuanToCents(balInput);
      if (c === null) return setToast("余额格式不对，例如 4500 或 3820.5");
      patch.balanceCents = c;
    }
    const goal = goalInput.trim() ? parseYuanToCents(goalInput) : 0;
    if (goal === null || goal < 0) return setToast("想省金额格式不对");
    patch.savingsGoalCents = goal;
    try {
      await setLedgerConfig(patch);
      setPlanOpen(false);
      setToast("规划已更新");
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  async function saveFixedModal() {
    const name = fixedName.trim();
    const c = parseYuanToCents(fixedAmt);
    if (!name) return setToast("请填写固定开支名称，比如 Codex 会员");
    if (c === null || c <= 0) return setToast("金额需要大于 0");
    try {
      await addFixedExpense({ name, amountCents: c, paidThisMonth: fixedPaid });
      setFixedName("");
      setFixedAmt("");
      setFixedPaid(false);
      setFixedOpen(false);
      setToast(`已添加「${name}」`);
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  function openNewTx() {
    setEditingTx(null);
    setTxDir("expense");
    setTxAmt("");
    setTxTitle("");
    setTxNote("");
    setTxFixedId(undefined);
    setTxOpen(true);
  }

  function openEditTx(tx: LedgerTransaction) {
    setEditingTx(tx);
    setTxDir(tx.direction);
    setTxAmt(formatYuan(tx.amountCents));
    setTxTitle(tx.title);
    setTxNote(tx.note ?? "");
    setTxFixedId(tx.fixedId);
    setTxOpen(true);
  }

  async function saveTxModal() {
    const c = parseYuanToCents(txAmt);
    const title = txTitle.trim() || (txDir === "income" ? "微信收款" : "微信消费");
    if (c === null || c <= 0) return setToast("金额需要大于 0");
    try {
      if (editingTx) {
        await updateLedgerTx(editingTx.id, {
          direction: txDir,
          amountCents: c,
          title,
          note: txNote.trim(),
          fixedId: txDir === "expense" ? (txFixedId ?? null) : null,
        });
        setToast("流水已修改");
      } else {
        const res = await addLedgerTx({
          direction: txDir,
          amountCents: c,
          title,
          note: txNote.trim() || undefined,
          source: "manual",
          fixedId: txDir === "expense" ? txFixedId : undefined,
        });
        setToast(res.alert.title);
      }
      setTxOpen(false);
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  async function toggleFixed(item: LedgerFixedExpense) {
    const paid = item.paidYm === plan.ym;
    try {
      await updateFixedExpense(item.id, { paid: !paid });
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  const blockedColors = statusColors("blocked", p.dark);
  const okColors = statusColors("working", p.dark);
  const overspent = plan.overspentTodayCents > 0;
  const hasBalance = plan.balanceCents !== null;
  const bars = computeRecentDaysBars(recentTransactions, plan.ymd, 7);
  const dailyRefCents = plan.todayLimitCents ?? plan.nextDailyLimitCents ?? 0;

  return (
    <PageBackground>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xxl, gap: space.md }}>
        {!config.enabled ? (
          <Card flat style={{ padding: space.md, backgroundColor: p.accentContainer, gap: space.sm }}>
            <Text style={{ color: p.ink, fontSize: 13.5, lineHeight: 20 }}>
              微信账单与攒钱规划插件当前处于关闭状态，无法自动捕获微信收付款。
            </Text>
            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Button compact mode="contained" buttonColor={p.primary} textColor={p.onPrimary} onPress={() => router.push("/plugins")} style={{ borderRadius: radius.pill }}>
                去插件管理开启
              </Button>
            </View>
          </Card>
        ) : !notifAccess ? (
          <Card flat style={{ padding: space.md, backgroundColor: blockedColors.bg, flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <MaterialCommunityIcons name="bell-alert-outline" size={18} color={blockedColors.fg} />
            <Text style={{ flex: 1, color: p.ink, fontSize: 12.5, lineHeight: 18 }}>
              尚未授予通知使用权，目前不会自动抓微信收付款。
            </Text>
            <Button compact mode="contained-tonal" onPress={() => router.push("/plugins")} style={{ borderRadius: radius.pill }}>
              去开启
            </Button>
          </Card>
        ) : null}

        {/* Primary budget overview card */}
        <Card style={{ padding: space.lg, gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.md }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: p.muted, fontSize: 12.5, fontFamily: fonts.bodySemi }}>
                {!hasBalance ? "每日花钱规划" : overspent ? "今日已超出预算" : `今天还能用（${plan.ymd}）`}
              </Text>
              <Text style={{ fontFamily: fonts.cute, fontSize: 32, lineHeight: 38, color: !hasBalance ? p.ink : overspent ? blockedColors.fg : okColors.fg }}>
                {!hasBalance
                  ? "未设余额"
                  : overspent
                    ? `- ¥${formatYuan(plan.overspentTodayCents)}`
                    : `¥${formatYuan(plan.todayRemainingCents ?? 0)}`}
              </Text>
              <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>
                {!hasBalance
                  ? "点击右侧“设置余额”填入现在微信里有多少钱，马上自动算每天最多花多少。"
                  : overspent
                    ? plan.daysLeftAfterToday > 0
                      ? `已按月底剩 ${plan.daysLeftAfterToday} 天重算：明天起每天最多用 ¥${formatYuan(plan.nextDailyLimitCents ?? 0)}`
                      : "今天是本月最后一天，注意控制剩余余额"
                    : `今日基准上限 ¥${formatYuan(plan.todayLimitCents ?? 0)} · 今日日常支出 ¥${formatYuan(plan.todayDiscretionaryExpenseCents)}`}
              </Text>
            </View>
            <Button mode="contained-tonal" compact onPress={openPlanModal} style={{ borderRadius: radius.pill }}>
              {hasBalance ? "校准余额/目标" : "设置余额"}
            </Button>
          </View>

          <Divider style={{ backgroundColor: p.divider }} />

          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}>
            <Pressable onPress={openPlanModal} style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: p.faint, fontSize: 11.5 }}>推算微信余额</Text>
              <Text style={{ fontFamily: fonts.bodyBold, fontSize: 16, color: p.ink }}>
                {hasBalance ? `¥${formatYuan(plan.balanceCents!)}` : "点此填入"}
              </Text>
            </Pressable>
            <Pressable onPress={openPlanModal} style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: p.faint, fontSize: 11.5 }}>月底保底想省</Text>
              <Text style={{ fontFamily: fonts.bodyBold, fontSize: 16, color: p.ink }}>
                {`¥${formatYuan(plan.savingsGoalCents)}`}
              </Text>
            </Pressable>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: p.faint, fontSize: 11.5 }}>日常可用余钱</Text>
              <Text style={{ fontFamily: fonts.bodyBold, fontSize: 16, color: plan.spendableNowCents !== null && plan.spendableNowCents < 0 ? blockedColors.fg : p.ink }}>
                {plan.spendableNowCents !== null ? `¥${formatYuan(plan.spendableNowCents)}` : "--"}
              </Text>
            </View>
          </View>
        </Card>

        {/* Monthly stats */}
        <Card style={{ padding: space.lg, gap: space.sm }}>
          <Text style={{ fontFamily: fonts.bodyBold, fontSize: 14, color: p.ink }}>{`${plan.ym} 本月收支统计`}</Text>
          <View style={{ flexDirection: "row", gap: space.md }}>
            <StatCell label="本月收入" value={`+¥${formatYuan(plan.monthIncomeCents)}`} color={okColors.fg} />
            <StatCell label="本月支出" value={`-¥${formatYuan(plan.monthExpenseCents)}`} color={p.ink} />
            <StatCell label="待扣固定开支" value={`¥${formatYuan(plan.unpaidFixedCents)}`} color={blockedColors.fg} />
            <StatCell label="本月已扣固定" value={`¥${formatYuan(plan.paidFixedCents)}`} color={p.muted} />
          </View>
        </Card>

        {/* 7-day spending trend vs daily allowance */}
        {bars.length ? (
          <WeeklySpendCard bars={bars} todayYmd={plan.ymd} limitCents={dailyRefCents} okColor={okColors.fg} overColor={blockedColors.fg} />
        ) : null}

        {/* Monthly fixed recurring items (Codex / Gemini etc.) */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: space.xs }}>
          <SectionHeader title="每月固定必要开支" />
          <Button compact mode="text" icon="plus" textColor={p.accentText} onPress={() => setFixedOpen(true)}>
            添加固定项
          </Button>
        </View>
        <Card style={{ paddingVertical: space.xs }}>
          {!fixedExpenses.length ? (
            <Text style={{ padding: space.lg, color: p.muted, fontSize: 13, lineHeight: 19 }}>
              暂无固定开支。可以把 Codex 会员、Gemini 会员、话费等每月必交费用加上来（也可以直接跟爱弥斯说），规划时会自动扣除还未付款的项。
            </Text>
          ) : (
            fixedExpenses.map((f, idx) => {
              const paid = f.paidYm === plan.ym;
              return (
                <View key={f.id}>
                  {idx > 0 ? <Divider style={{ backgroundColor: p.divider }} /> : null}
                  <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontFamily: fonts.bodyBold, fontSize: 14.5, color: p.ink }}>{f.name}</Text>
                      <Text style={{ color: p.muted, fontSize: 12.5 }}>{`¥${formatYuan(f.amountCents)} / 月`}</Text>
                    </View>
                    <Pressable
                      onPress={() => void toggleFixed(f)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: radius.pill,
                        backgroundColor: pressed ? p.surface3 : paid ? okColors.bg : p.accentContainer,
                      })}
                    >
                      <Text style={{ fontSize: 12, fontFamily: fonts.bodyBold, color: paid ? okColors.fg : p.accentText }}>
                        {paid ? "本月已扣" : "本月待扣"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void deleteFixedExpense(f.id).catch((e) => setToast((e as Error).message))}
                      hitSlop={8}
                      accessibilityLabel={`删除 ${f.name}`}
                      style={{ padding: 4 }}
                    >
                      <MaterialCommunityIcons name="trash-can-outline" size={18} color={p.faint} />
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </Card>

        {/* Transaction history */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: space.xs }}>
          <SectionHeader title="账单流水" />
          <Button compact mode="contained-tonal" icon="plus" onPress={openNewTx} style={{ borderRadius: radius.pill }}>
            记一笔
          </Button>
        </View>
        <Card style={{ paddingVertical: space.xs }}>
          {!recentTransactions.length ? (
            <Text style={{ padding: space.lg, color: p.muted, fontSize: 13, lineHeight: 19 }}>
              还没有收支流水。微信通知一到达就会自动记录，也可以点上方「记一笔」或直接对爱弥斯说。
            </Text>
          ) : (
            recentTransactions.map((tx, idx) => {
              const inc = tx.direction === "income";
              return (
                <View key={tx.id}>
                  {idx > 0 ? <Divider style={{ backgroundColor: p.divider }} /> : null}
                  <Pressable
                    onPress={() => openEditTx(tx)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.md,
                      paddingHorizontal: space.lg,
                      paddingVertical: space.md,
                      backgroundColor: pressed ? p.surface2 : "transparent",
                    })}
                  >
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: inc ? okColors.bg : p.surface2,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <MaterialCommunityIcons name={inc ? "arrow-down-left" : "arrow-up-right"} size={18} color={inc ? okColors.fg : p.ink} />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 14.5, color: p.ink }}>{tx.title}</Text>
                      <Text numberOfLines={1} style={{ fontSize: 12, color: p.faint }}>
                        {`${clockDay(tx.ts)} · ${SOURCE_LABEL[tx.source]}${tx.fixedId ? " · 固定开支" : ""}${tx.note ? ` · ${tx.note}` : ""}`}
                      </Text>
                    </View>
                    <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15.5, color: inc ? okColors.fg : p.ink }}>
                      {`${inc ? "+" : "-"}¥${formatYuan(tx.amountCents)}`}
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </Card>
      </ScrollView>

      {/* Balance & Savings Goal Dialog */}
      <Portal>
        <Dialog visible={planOpen} onDismiss={() => setPlanOpen(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>微信余额与攒钱目标</Dialog.Title>
          <Dialog.Content style={{ gap: space.md }}>
            <TextInput
              mode="outlined"
              label="当前微信余额（元）"
              value={balInput}
              onChangeText={setBalInput}
              keyboardType="decimal-pad"
              placeholder="例如 4500"
            />
            <TextInput
              mode="outlined"
              label="本月想省出/月底至少保留（元）"
              value={goalInput}
              onChangeText={setGoalInput}
              keyboardType="decimal-pad"
              placeholder="例如 2000"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPlanOpen(false)} textColor={p.ink}>取消</Button>
            <Button textColor={p.accentText} onPress={() => void savePlanModal()}>保存</Button>
          </Dialog.Actions>
        </Dialog>

        {/* Add Monthly Fixed Expense Dialog */}
        <Dialog visible={fixedOpen} onDismiss={() => setFixedOpen(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>添加每月固定开支</Dialog.Title>
          <Dialog.Content style={{ gap: space.md }}>
            <TextInput
              mode="outlined"
              label="名称"
              value={fixedName}
              onChangeText={setFixedName}
              placeholder="例如 Codex 会员、Gemini 会员"
            />
            <TextInput
              mode="outlined"
              label="每月金额（元）"
              value={fixedAmt}
              onChangeText={setFixedAmt}
              keyboardType="decimal-pad"
              placeholder="例如 145"
            />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: p.ink, fontSize: 14 }}>这个月已经扣过款了</Text>
              <Switch value={fixedPaid} onValueChange={setFixedPaid} />
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setFixedOpen(false)} textColor={p.ink}>取消</Button>
            <Button textColor={p.accentText} onPress={() => void saveFixedModal()}>添加</Button>
          </Dialog.Actions>
        </Dialog>

        {/* Add / Edit Transaction Dialog */}
        <Dialog visible={txOpen} onDismiss={() => setTxOpen(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>{editingTx ? "修改账单" : "记一笔"}</Dialog.Title>
          <Dialog.Content style={{ gap: space.md }}>
            <SegmentedButtons
              value={txDir}
              onValueChange={(v) => setTxDir(v as LedgerTxDirection)}
              buttons={[
                { value: "expense", label: "支出" },
                { value: "income", label: "收入/收款" },
              ]}
            />
            <TextInput
              mode="outlined"
              label="金额（元）"
              value={txAmt}
              onChangeText={setTxAmt}
              keyboardType="decimal-pad"
              placeholder="例如 32.5"
            />
            <TextInput
              mode="outlined"
              label="商户或摘要"
              value={txTitle}
              onChangeText={setTxTitle}
              placeholder={txDir === "income" ? "例如 收到转账" : "例如 午饭、打车"}
            />
            <TextInput
              mode="outlined"
              label="备注（可选）"
              value={txNote}
              onChangeText={setTxNote}
            />
            {txDir === "expense" && fixedExpenses.length ? (
              <View style={{ gap: 6 }}>
                <Text style={{ color: p.muted, fontSize: 12 }}>若这是某项每月固定开支（如会员费），点选可避免重复占今日限额：</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {fixedExpenses.map((f) => {
                    const active = txFixedId === f.id;
                    return (
                      <Pressable
                        key={f.id}
                        onPress={() => setTxFixedId(active ? undefined : f.id)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                          borderRadius: radius.pill,
                          backgroundColor: active ? p.primary : p.surface2,
                        }}
                      >
                        <Text style={{ fontSize: 12, color: active ? p.onPrimary : p.ink, fontFamily: fonts.bodySemi }}>{f.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            {editingTx ? (
              <Button
                textColor={p.error}
                onPress={async () => {
                  const target = editingTx;
                  setTxOpen(false);
                  try {
                    await deleteLedgerTx(target.id);
                    setToast("已删除并修正余额");
                  } catch (e) {
                    setToast((e as Error).message);
                  }
                }}
              >
                删除
              </Button>
            ) : null}
            <Button onPress={() => setTxOpen(false)} textColor={p.ink}>取消</Button>
            <Button textColor={p.accentText} onPress={() => void saveTxModal()}>保存</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={2600}>
        {toast ?? ""}
      </Snackbar>
    </PageBackground>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color: string }) {
  const p = usePalette();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text numberOfLines={1} style={{ color: p.faint, fontSize: 11.5 }}>{label}</Text>
      <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 14, color }}>{value}</Text>
    </View>
  );
}

function WeeklySpendCard({
  bars,
  todayYmd,
  limitCents,
  okColor,
  overColor,
}: {
  bars: LedgerDayBar[];
  todayYmd: string;
  limitCents: number;
  okColor: string;
  overColor: string;
}) {
  const p = usePalette();
  const maxCents = Math.max(limitCents, ...bars.map((b) => b.expenseCents), 100);
  const BAR_H = 68;
  const limitBottom = limitCents > 0 ? Math.min(BAR_H, Math.round((limitCents / maxCents) * BAR_H)) : 0;

  return (
    <Card style={{ padding: space.lg, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontFamily: fonts.bodyBold, fontSize: 14, color: p.ink }}>近 7 天日常支出趋势</Text>
        <Text style={{ color: p.faint, fontSize: 11.5 }}>
          {limitCents > 0 ? `参考限额 ¥${formatYuan(limitCents)}/天` : "未设余额限额"}
        </Text>
      </View>
      <View style={{ height: BAR_H + 38, justifyContent: "flex-end", position: "relative", paddingTop: 18 }}>
        {limitCents > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 20 + limitBottom,
              borderTopWidth: 1,
              borderStyle: "dashed",
              borderColor: p.faint,
              opacity: 0.65,
            }}
          />
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
          {bars.map((b) => {
            const isToday = b.ymd === todayYmd;
            const over = limitCents > 0 && b.expenseCents > limitCents;
            const h = b.expenseCents > 0 ? Math.max(4, Math.round((b.expenseCents / maxCents) * BAR_H)) : 2;
            const barColor = b.expenseCents === 0 ? p.divider : over ? overColor : okColor;
            return (
              <View key={b.ymd} style={{ flex: 1, alignItems: "center", gap: 4 }}>
                <Text numberOfLines={1} style={{ fontSize: 10, color: over ? overColor : p.faint, fontFamily: isToday ? fonts.bodyBold : fonts.body }}>
                  {b.expenseCents > 0 ? formatYuan(b.expenseCents) : ""}
                </Text>
                <View style={{ width: "68%", height: h, borderRadius: 4, backgroundColor: barColor, opacity: isToday ? 1 : 0.78 }} />
                <Text style={{ fontSize: 10.5, color: isToday ? p.accentText : p.faint, fontFamily: isToday ? fonts.bodyBold : fonts.body }}>
                  {isToday ? "今天" : b.label}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </Card>
  );
}
