import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button, Dialog, Divider, Portal, Snackbar, Switch, Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { formatYuan } from "@xiaoaixiaoai/protocol";
import { XiaoaiNative } from "../../modules/xiaoaixiaoai-native";
import { Card, PageBackground, SectionHeader } from "../components/ui";
import { clearLedgerData, loadLedger, refreshNotifAccess, setLedgerConfig, useLedger } from "../lib/ledger";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

export default function PluginsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { state, notifAccess } = useLedger();
  const enabled = state.config.enabled;
  const { plan } = state;
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    refreshNotifAccess();
    void loadLedger();
  }, []);

  async function toggleLedger(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await setLedgerConfig({ enabled: next });
      setToast(next ? "已开启「微信账单与攒钱规划」" : "已停用微信账单插件");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const quotaText =
    plan.balanceCents === null
      ? "未设微信余额"
      : plan.overspentTodayCents > 0
        ? `今日超支 ${formatYuan(plan.overspentTodayCents)} 元 · 明日起 ${formatYuan(plan.nextDailyLimitCents ?? 0)} 元/天`
        : `今天还能用 ${formatYuan(plan.todayRemainingCents ?? 0)} 元`;

  return (
    <PageBackground>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xxl, gap: space.md }}>
        <Text style={{ color: p.muted, fontSize: 13, lineHeight: 19 }}>
          这里的插件按需开启。关掉后不会监听相关通知，爱弥斯界面也不显示对应工具，不打扰日常使用。
        </Text>

        <SectionHeader title="已内置插件" />
        <Card style={{ paddingVertical: space.xs }}>
          <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
              <View style={{ width: 42, height: 42, borderRadius: radius.sm, backgroundColor: p.accentContainer, alignItems: "center", justifyContent: "center" }}>
                <MaterialCommunityIcons name="wechat" size={23} color={p.accentText} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontFamily: fonts.bodyBold, fontSize: 16, color: p.ink }}>微信账单与攒钱规划</Text>
                <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>
                  捕捉微信收付款通知，按当前微信余额、每月固定开支和月底攒钱目标自动规划每日限额。
                </Text>
              </View>
              <Switch
                value={enabled}
                disabled={busy}
                onValueChange={(v) => void toggleLedger(v)}
                accessibilityLabel="启用微信账单与攒钱规划"
              />
            </View>

            {enabled ? (
              <>
                <Divider style={{ backgroundColor: p.divider }} />
                <View style={{ gap: space.sm }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                      <MaterialCommunityIcons
                        name={notifAccess ? "check-circle-outline" : "bell-alert-outline"}
                        size={17}
                        color={notifAccess ? statusColors("working", p.dark).fg : p.error}
                      />
                      <Text style={{ fontSize: 13.5, fontFamily: fonts.bodySemi, color: notifAccess ? p.ink : p.error }}>
                        {notifAccess ? "已开启系统通知使用权" : "未开启系统通知使用权"}
                      </Text>
                    </View>
                    <Button
                      compact
                      mode="contained-tonal"
                      onPress={() => XiaoaiNative?.openNotificationAccessSettings?.()}
                      style={{ borderRadius: radius.pill }}
                    >
                      {notifAccess ? "管理权限" : "去开启"}
                    </Button>
                  </View>

                  {!notifAccess ? (
                    <View style={{ backgroundColor: p.surface2, borderRadius: radius.sm, padding: space.md, gap: 6 }}>
                      <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>
                        OPPO / Android 13+ 安装包若发现开关是灰色的：先点下方「应用信息」→ 右上角「⋮」→「允许受限制的设置」，再回来打开通知使用权；同时确保微信开启了「新消息通知 → 显示消息详情」。
                      </Text>
                      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                        <Button compact mode="text" textColor={p.accentText} onPress={() => XiaoaiNative?.openAppDetails?.()}>
                          打开应用信息
                        </Button>
                      </View>
                    </View>
                  ) : null}
                </View>

                <Divider style={{ backgroundColor: p.divider }} />
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: p.muted, fontSize: 12 }}>当前账本概览</Text>
                    <Text style={{ color: p.ink, fontSize: 14, fontFamily: fonts.bodySemi }}>{quotaText}</Text>
                  </View>
                  <Button mode="contained" buttonColor={p.primary} textColor={p.onPrimary} onPress={() => router.push("/ledger")} style={{ borderRadius: radius.pill }}>
                    打开账单
                  </Button>
                </View>

                <Divider style={{ backgroundColor: p.divider }} />
                <View style={{ gap: 6 }}>
                  <Text style={{ color: p.faint, fontSize: 12, lineHeight: 17 }}>
                    隐私边界：仅在本地匹配微信（com.tencent.mm）收付款通知；普通聊天通知不会读取、不上传也不存储。
                  </Text>
                  <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                    <Button compact textColor={p.error} onPress={() => setConfirmClear(true)}>
                      清空账单与固定开支
                    </Button>
                  </View>
                </View>
              </>
            ) : null}
          </View>
        </Card>
      </ScrollView>

      <Portal>
        <Dialog visible={confirmClear} onDismiss={() => setConfirmClear(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>清空所有账单记录？</Dialog.Title>
          <Dialog.Content>
            <Text style={{ color: p.muted, lineHeight: 22 }}>这会删除已记流水、每月固定开支清单，并把当前余额与目标重置为未设置。</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmClear(false)} textColor={p.ink}>取消</Button>
            <Button
              textColor={p.error}
              onPress={async () => {
                setConfirmClear(false);
                try {
                  await clearLedgerData();
                  setToast("已清空账单数据");
                } catch (e) {
                  setToast((e as Error).message);
                }
              }}
            >
              清空
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={2400}>
        {toast ?? ""}
      </Snackbar>
    </PageBackground>
  );
}
