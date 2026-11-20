import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { AppState, Image, Pressable, ScrollView, View } from "react-native";
import { ActivityIndicator, Button, Dialog, Portal, ProgressBar, Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Animated, { interpolateColor, useAnimatedStyle, useDerivedValue, withTiming } from "react-native-reanimated";
import { PROTOCOL_VERSION } from "@xiaoaixiaoai/protocol";
import { Card, PageBackground, PageTitle, SectionHeader } from "../../components/ui";
import { Mascot, Sparkle } from "../../components/Mascot";
import { StarTrail } from "../../components/Starlight";
import { useLive, useSettings, type ThemeMode } from "../../lib/store";
import { signOut } from "../../lib/session";
import { isMockServer } from "../../lib/mock";
import { loadAssistant, loadAssistantProfile, setAssistantConfirm, setAssistantReplyMode, useAssistant } from "../../lib/assistant";
import { alertsSupported, askNotificationPermission, refreshAlertState, useAlerts } from "../../lib/alerts";
import { useLedger } from "../../lib/ledger";
import { checkForUpdate, currentVersion, downloadUpdate, installUpdate, resumeInstallIfAllowed, useNewRelease, useUpdate } from "../../lib/update";
import { XiaoaiNative } from "../../../modules/xiaoaixiaoai-native";
import { usePalette } from "../../theme/theme";
import { fonts, makePalette, motion, radius, space } from "../../theme/tokens";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

const LINK_TEXT = { idle: "未连接", connecting: "连接中…", online: "已连接", offline: "断开了，重连中", unauthorized: "授权失效" } as const;
const SCALES = [
  { value: 0.85, label: "小", glyph: 13 },
  { value: 1, label: "标准", glyph: 16 },
  { value: 1.15, label: "大", glyph: 19 },
  { value: 1.3, label: "特大", glyph: 22 },
] as const;
const THEMES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
const PORTRAIT = require("../../../assets/brand/aimisi-avatar.png");

export default function SettingsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const s = useSettings();
  const link = useLive((x) => x.link);
  const rtt = useLive((x) => x.rttMs);
  const [confirm, setConfirm] = useState(false);
  const alerts = useAlerts();
  const askFirst = useAssistant((x) => x.confirm);
  const replyMode = useAssistant((x) => x.replyMode);
  const assistantName = useAssistant((x) => x.name);
  const assistantProfile = useAssistant((x) => x.profile);
  const assistantChatVoice = useAssistant((x) => x.chatVoice);
  const assistantLoaded = useAssistant((x) => x.loaded);
  const ledgerEnabled = useLedger((x) => x.state.config.enabled);
  const [askError, setAskError] = useState<string | null>(null);
  const [replyModeError, setReplyModeError] = useState<string | null>(null);
  useEffect(() => {
    if (!useAssistant.getState().loaded) void loadAssistant();
    if (!useAssistant.getState().profile) void loadAssistantProfile().catch(() => {});
  }, []);
  useEffect(() => {
    refreshAlertState();
    // Coming back from system settings: show what changed, and carry on with an update install.
    const sub = AppState.addEventListener("change", (st) => {
      if (st !== "active") return;
      refreshAlertState();
      resumeInstallIfAllowed();
    });
    return () => sub.remove();
  }, []);

  const demo = isMockServer(s.server);
  const linkColor = link === "online" ? "#3FB68B" : link === "connecting" ? p.lavender : p.error;
  const alertsLine = !alertsSupported
    ? "需要装新版 App"
    : demo
      ? "演示模式没有提醒"
      : !s.alertsOn
        ? "关着：只有打开 App 时才知道"
        : alerts.connected
          ? "在线：App 关着也会提醒你"
          : "正在连接服务器…";

  async function leave() {
    setConfirm(false);
    await signOut();
    router.replace("/connect");
  }

  return (
    <PageBackground>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + space.xl, paddingHorizontal: space.lg, paddingBottom: space.xxxl }}>
        <PageTitle sub="让爱弥斯更合你心意">设置</PageTitle>

        {/* This phone: who it is, where it is connected, how the line is. */}
        <View
          style={{
            marginTop: space.lg,
            borderRadius: radius.xl,
            shadowColor: p.shadow,
            shadowOpacity: p.dark ? 0.3 : 0.16,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: p.dark ? 0 : 3,
            backgroundColor: p.surface,
          }}
        >
          <LinearGradient
            colors={[p.skyContainer, p.surface2, p.accentContainer]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ borderRadius: radius.xl, padding: space.lg, flexDirection: "row", alignItems: "center", gap: space.lg, overflow: "hidden" }}
          >
            <View pointerEvents="none" style={{ position: "absolute", right: 0, top: 0 }}>
              <StarTrail width={136} opacity={p.dark ? 0.34 : 0.44} />
            </View>
            <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: p.surface, padding: 3 }}>
              {link === "online" || demo ? (
                <Image source={PORTRAIT} style={{ width: 78, height: 78, borderRadius: 39 }} accessibilityLabel="爱弥斯" />
              ) : (
                <View style={{ width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center", backgroundColor: p.surface2 }}>
                  <Mascot mood="sleepy" size={62} />
                </View>
              )}
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              <Text numberOfLines={1} style={{ fontFamily: fonts.cute, fontSize: 21, lineHeight: 28, color: p.ink }}>
                {s.deviceName ?? "这台手机"}
              </Text>
              <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12.5, fontFamily: demo ? fonts.body : fonts.mono }}>
                {demo ? "演示模式" : (s.server ?? "").replace(/^https?:\/\//, "")}
              </Text>
              <View
                accessibilityLabel={`连接状态：${LINK_TEXT[link]}`}
                style={{ alignSelf: "flex-start", marginTop: 3, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: p.surface, borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 5 }}
              >
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: linkColor }} />
                <Text style={{ color: p.ink, fontSize: 12.5, fontFamily: fonts.bodySemi }}>
                  {LINK_TEXT[link]}
                  {link === "online" && rtt != null ? ` · 延迟 ${rtt} ms` : ""}
                </Text>
              </View>
            </View>
          </LinearGradient>
        </View>

        <SectionHeader title="外观" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row icon="theme-light-dark" title="主题" sub="星海蓝粉：浅色、深色，或跟随系统">
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: space.md, paddingTop: space.md }}>
              {THEMES.map((t) => (
                <ThemeTile key={t.value} mode={t.value} label={t.label} selected={s.themeMode === t.value} onPress={() => s.set({ themeMode: t.value })} />
              ))}
            </View>
          </Row>
          <Divider />
          <Row icon="format-size" title="对话字号" sub="聊天和 agent 对话里文字的大小">
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingTop: space.md }}>
              {SCALES.map((x) => {
                const on = s.textScale === x.value;
                return (
                  <Pressable
                    key={x.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`字号${x.label}`}
                    onPress={() => s.set({ textScale: x.value })}
                    style={{ width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", backgroundColor: on ? p.primary : p.surface3, borderWidth: on ? 0 : 1, borderColor: p.divider }}
                  >
                    <Text style={{ fontFamily: fonts.bodyBold, fontSize: x.glyph, lineHeight: x.glyph + 6, color: on ? p.onPrimary : p.muted }}>A</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingTop: space.md }}>
              <Mascot size={30} />
              <View style={{ flexShrink: 1, backgroundColor: p.reply, borderRadius: radius.md, borderBottomLeftRadius: 5, paddingHorizontal: space.md, paddingVertical: 7 }}>
                <Text style={{ color: p.ink, fontSize: 15.5 * s.textScale, lineHeight: 22 * s.textScale }}>迁移脚本跑完了，测试全过。</Text>
              </View>
            </View>
          </Row>
        </Card>

        <SectionHeader title="助理提醒" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="bell-outline"
            title="后台提醒"
            sub={alertsLine}
            right={
              <Toggle
                label="后台提醒"
                value={s.alertsOn}
                disabled={!alertsSupported}
                onChange={async (v) => {
                  s.set({ alertsOn: v });
                  if (v) await askNotificationPermission();
                }}
              />
            }
          />
          <Divider />
          <Row
            icon="hand-back-left-outline"
            title="agent 在等你时"
            sub="要你确认、要你回答的时候"
            dim={!s.alertsOn}
            right={<Toggle label="agent 在等你时提醒" value={s.alertBlocked} disabled={!s.alertsOn} onChange={(v) => s.set({ alertBlocked: v })} />}
          />
          <Divider />
          <Row
            icon="check-circle-outline"
            title="agent 跑完时"
            sub="接收会话结束提醒；DSH 结束一轮不等于结果已验证"
            dim={!s.alertsOn}
            right={<Toggle label="agent 跑完时提醒" value={s.alertDone} disabled={!s.alertsOn} onChange={(v) => s.set({ alertDone: v })} />}
          />
          <Divider />
          <Row
            icon="progress-clock"
            title="DSH 任务有进展时"
            sub="任务执行中间步骤时推送（消息较多，默认关闭）"
            dim={!s.alertsOn}
            right={<Toggle label="DSH 进展提醒" value={s.alertProgress} disabled={!s.alertsOn} onChange={(v) => s.set({ alertProgress: v })} />}
          />
          {alertsSupported && s.alertsOn && !alerts.notificationsAllowed ? (
            <>
              <Divider />
              <Row icon="bell-off-outline" tone="error" title="通知被关掉了" sub="去系统设置里允许 小爱小爱 发通知" onPress={() => XiaoaiNative?.openNotificationSettings()} />
            </>
          ) : null}
          {alertsSupported && s.alertsOn && !alerts.batteryUnrestricted ? (
            <>
              <Divider />
              <Row icon="battery-heart-outline" title="允许在后台运行" sub="不然系统省电时会把提醒断掉。点这里，选“允许”或“无限制”" onPress={() => XiaoaiNative?.requestBatteryExemption()} />
            </>
          ) : null}
          {alertsSupported && s.alertsOn ? (
            <>
              <Divider />
              <Row icon="cog-outline" title="应用后台与自启动设置" sub="若只点进 App 才收得到通知，请到「应用信息 → 耗电管理」允许完全后台行为，并打开自启动" onPress={() => XiaoaiNative?.openAppDetails?.()} />
              <Divider />
              <Row icon="bell-ring-outline" title="发一条测试提醒" sub="看看通知能不能送到这台手机" onPress={() => XiaoaiNative?.testNotice("爱弥斯：测试提醒", "能看到这条，说明 agent 的提醒也能送到。")} />
            </>
          ) : null}
        </Card>

        <SectionHeader title="功能与插件" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="puzzle-outline"
            title="功能插件"
            sub={ledgerEnabled ? "已开启「微信账单与攒钱规划」" : "按需开启可选功能，如微信收付款记账与每日预算（默认关闭）"}
            right={<MaterialCommunityIcons name="chevron-right" size={20} color={p.faint} />}
            onPress={() => router.push("/plugins")}
          />
        </Card>

        <SectionHeader title="爱弥斯办事" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="card-account-details-outline"
            title={`${assistantName}人设与记忆库`}
            sub={
              assistantProfile
                ? `服务器保存 · 称呼「${assistantProfile.userCall || "你"}」· ${assistantProfile.autoMemory ? "自动记住生活细节" : "仅手动记住"}`
                : "服务器统一存储人设、称呼与私人生活记忆库"
            }
            onPress={() => router.push("/persona")}
          />
          <Divider />
          <Row
            icon="volume-high"
            title="平时聊天用语音回复"
            sub={
              replyModeError
                ? `没改成：${replyModeError}`
                : !assistantChatVoice && !demo
                  ? "未开启本地语音服务，可用文字模式聊天"
                  : replyMode === "voice"
                    ? "打开：爱弥斯一边出文字一边用语音读出来（聊天里说“接下来用文字”也能切换）"
                    : "关着：只发文字气泡（聊天里说“接下来用语音”或点单条播报也能听）"
            }
            dim={!assistantChatVoice && !demo}
            right={
              <Toggle
                label="平时聊天用语音回复"
                value={replyMode === "voice"}
                disabled={!assistantChatVoice && !demo}
                onChange={async (v) => {
                  setReplyModeError(null);
                  try {
                    await setAssistantReplyMode(v ? "voice" : "text");
                  } catch (e) {
                    setReplyModeError((e as Error).message);
                  }
                }}
              />
            }
          />
          <Divider />
          <Row
            icon="comment-question-outline"
            title="爱弥斯动手前先问我"
            sub={
              askError
                ? `没改成：${askError}`
                : askFirst === null
                  ? assistantLoaded
                    ? "服务器还不支持这个设置，更新服务器后可用"
                    : "正在读取…"
                  : askFirst === "always"
                    ? "发消息、按键、开新 agent 前先等你点确认。打电话时不等，直接办"
                    : "关着：爱弥斯直接去办，办完照实告诉你结果"
            }
            dim={askFirst === null}
            right={
              <Toggle
                label="爱弥斯动手前先问我"
                value={askFirst === "always"}
                disabled={askFirst === null}
                onChange={async (v) => {
                  setAskError(null);
                  try {
                    await setAssistantConfirm(v ? "always" : "never");
                  } catch (e) {
                    setAskError((e as Error).message);
                  }
                }}
              />
            }
          />
        </Card>

        <SectionHeader title="列表" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="console-line"
            title="显示普通终端"
            sub="没在跑 agent 的 shell 窗口"
            right={<Toggle label="显示普通终端" value={s.showShells} onChange={(v) => s.set({ showShells: v })} />}
          />
        </Card>

        <SectionHeader title="连接" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row icon="server-network" title="更换服务器 / 重新配对" sub="换一台服务器，或者让这台手机重新授权" onPress={() => setConfirm(true)} />
        </Card>

        <SectionHeader title="版本" />
        <Card style={{ paddingVertical: space.xs }}>
          <UpdateRow demo={demo} />
        </Card>

        <View style={{ alignItems: "center", gap: 6, paddingTop: space.xxxl }}>
          <Sparkle size={19} color={p.skyText} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <View style={{ width: 44, height: 1, backgroundColor: p.divider }} />
            <Text style={{ fontFamily: fonts.cute, fontSize: 18, color: p.accentText }}>小爱小爱</Text>
            <View style={{ width: 44, height: 1, backgroundColor: p.divider }} />
          </View>
          <Text style={{ color: p.faint, fontSize: 12.5 }}>
            版本 {currentVersion()} · 协议 v{PROTOCOL_VERSION}
          </Text>
        </View>
      </ScrollView>

      <Portal>
        <Dialog visible={confirm} onDismiss={() => setConfirm(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>要重新配对吗？</Dialog.Title>
          <Dialog.Content>
            <Text style={{ color: p.muted, lineHeight: 22 }}>这台手机的授权会作废，并从设备列表里移除。服务器地址会保留，之后扫码或输入一个新的配对码就能连回来。</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirm(false)} textColor={p.ink}>
              取消
            </Button>
            <Button textColor={p.error} onPress={leave}>
              重新配对
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </PageBackground>
  );
}

/** Check for a new version, download it with progress, then install. */
function UpdateRow({ demo }: { demo: boolean }) {
  const p = usePalette();
  const { phase, progress, note } = useUpdate();
  const release = useNewRelease();
  const version = currentVersion();
  const mb = release?.size ? ` · ${(release.size / 1048576).toFixed(0)} MB` : "";
  const sub =
    demo && phase === "idle"
      ? "演示模式不检查更新"
      : phase === "checking"
        ? "正在看有没有新版本…"
        : phase === "downloading"
          ? `正在下载 v${release?.version ?? ""}，${Math.round(progress * 100)}%`
          : phase === "permission"
            ? "先在系统设置里允许 小爱小爱 安装应用，回来就会接着装"
            : phase === "ready"
              ? (note ?? "下载好了，点这里安装")
              : release
                ? (note ?? `有新版本 v${release.version}${mb}，点这里更新`)
                : (note ?? (phase === "latest" ? `已经是最新版 v${version}` : `当前 v${version}，点一下看看有没有新版本`));
  const onPress =
    phase === "checking" || phase === "downloading"
      ? undefined
      : phase === "ready" || phase === "permission"
        ? installUpdate
        : release
          ? () => void downloadUpdate()
          : () => void checkForUpdate(true);
  const badge = release && phase === "available" ? "更新" : phase === "ready" ? "安装" : null;
  const right =
    phase === "checking" || phase === "downloading" ? (
      <ActivityIndicator size={18} />
    ) : badge ? (
      <View style={{ backgroundColor: p.primary, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5 }}>
        <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>{badge}</Text>
      </View>
    ) : undefined;
  return (
    <Row icon={release ? "cellphone-arrow-down" : "update"} title={release ? "有新版本" : "检查更新"} sub={sub} right={right} onPress={onPress}>
      {phase === "downloading" ? (
        <ProgressBar progress={progress} color={p.primary} style={{ height: 6, borderRadius: 3, marginTop: space.sm, backgroundColor: p.surface3 }} />
      ) : release?.notes && phase === "available" ? (
        <Text numberOfLines={4} style={{ color: p.faint, fontSize: 12.5, lineHeight: 18, paddingTop: space.xs }}>
          {release.notes}
        </Text>
      ) : null}
    </Row>
  );
}

function Divider() {
  const p = usePalette();
  return <View style={{ height: 1, backgroundColor: p.divider, marginLeft: space.lg + 40 + space.md, marginRight: space.lg }} />;
}

/**
 * One setting: a tinted icon tile, what it is, one line of what it does, and its
 * control on the right. Bigger controls (theme tiles, sizes) go underneath as children.
 */
function Row({
  icon,
  title,
  sub,
  right,
  onPress,
  tone,
  dim,
  children,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  right?: ReactNode;
  onPress?: () => void;
  tone?: "error";
  dim?: boolean;
  children?: ReactNode;
}) {
  const p = usePalette();
  const fg = tone === "error" ? p.error : p.accentText;
  const body = (
    <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, opacity: dim ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 }}>
        <View style={{ width: 40, height: 40, borderRadius: radius.sm, backgroundColor: tone === "error" ? p.errorContainer : p.accentContainer, alignItems: "center", justifyContent: "center" }}>
          <MaterialCommunityIcons name={icon} size={21} color={fg} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15.5, color: tone === "error" ? p.error : p.ink }}>{title}</Text>
          {sub ? <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 17 }}>{sub}</Text> : null}
        </View>
        {right ?? (onPress ? <MaterialCommunityIcons name="chevron-right" size={22} color={p.faint} /> : null)}
      </View>
      {children ? <View style={{ paddingLeft: 40 + space.md }}>{children}</View> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={sub ? `${title}，${sub}` : title} onPress={onPress} android_ripple={{ color: p.surface3 }}>
      {body}
    </Pressable>
  );
}

/** Pill switch in the app's pink; the stock one does not take the palette on every phone. */
function Toggle({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  const p = usePalette();
  const t = useDerivedValue(() => withTiming(value ? 1 : 0, { duration: motion.quick, easing: motion.glide }), [value]);
  const off = p.outline;
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(t.value, [0, 1], [off, p.primary]) }), [off, p.primary]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: t.value * 22 }] }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={10}
      onPress={() => onChange(!value)}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View style={[{ width: 52, height: 30, borderRadius: 15, padding: 3 }, track]}>
        <Animated.View style={[{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#FFFFFF", elevation: 2, shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }, knob]} />
      </Animated.View>
    </Pressable>
  );
}

/** A tiny phone showing what the theme looks like. */
function ThemeTile({ mode, label, selected, onPress }: { mode: ThemeMode; label: string; selected: boolean; onPress: () => void }) {
  const p = usePalette();
  const swatch = (night: boolean) => {
    const c = makePalette(night);
    return { bg: c.pageTop, bar: c.primary, line: c.sky, icon: c.skyText };
  };
  const light = swatch(false);
  const dark = swatch(true);
  const half = (c: typeof light, icon: IconName | null) => (
    <View style={{ flex: 1, backgroundColor: c.bg, padding: 5, gap: 4, alignItems: "center" }}>
      <View style={{ alignSelf: "stretch", height: 5, borderRadius: 3, backgroundColor: c.bar }} />
      <View style={{ alignSelf: "stretch", height: 4, borderRadius: 2, backgroundColor: c.line }} />
      <View style={{ flex: 1, justifyContent: "center" }}>{icon ? <MaterialCommunityIcons name={icon} size={16} color={c.icon} /> : null}</View>
    </View>
  );
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={`主题：${label}`} onPress={onPress} style={{ alignItems: "center", gap: 6 }}>
      <View style={{ padding: 3, borderRadius: 15, borderWidth: 2, borderColor: selected ? p.skyText : "transparent" }}>
        <View style={{ width: 50, height: 72, borderRadius: 10, overflow: "hidden", flexDirection: "row", borderWidth: 1, borderColor: p.divider }}>
          {mode === "system" ? (
            <>
              {half(light, "white-balance-sunny")}
              {half(dark, "moon-waning-crescent")}
            </>
          ) : mode === "light" ? (
            half(light, "white-balance-sunny")
          ) : (
            half(dark, "moon-waning-crescent")
          )}
        </View>
        {selected ? (
          <View style={{ position: "absolute", right: -5, bottom: -5, width: 20, height: 20, borderRadius: 10, backgroundColor: p.primary, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: p.surface }}>
            <MaterialCommunityIcons name="check" size={12} color={p.onPrimary} />
          </View>
        ) : null}
      </View>
      <Text style={{ fontSize: 12.5, fontFamily: selected ? fonts.bodyBold : fonts.body, color: selected ? p.ink : p.muted }}>{label}</Text>
    </Pressable>
  );
}
