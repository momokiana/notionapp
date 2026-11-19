/**
 * The assistant's reminders: a bottom sheet in the same style as the new-agent
 * sheet. Each reminder says what it will tell you, when (a countdown plus the
 * day and time), and which agent it watches; the only action is cancelling one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { Easing, FadeOut, LinearTransition, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Agent, Reminder } from "@xiaoaixiaoai/protocol";
import { cancelReminder } from "../lib/assistant";
import { useLive, useSettings } from "../lib/store";
import { agentTitle, dueTime } from "../lib/format";
import { usePalette } from "../theme/theme";
import { agentStatusLabel, fonts, motion, radius, space } from "../theme/tokens";
import { CuteIcon, type CuteIconName } from "./icons";
import { Mascot } from "./Mascot";
import { HarnessAvatar, IconTile } from "./ui";

/** Lines of a reminder shown before "展开全文". Reminders can be up to 500 characters. */
const CLAMP = 5;
/** Wide screens keep a readable line length. */
const MAX_WIDTH = 560;

export function RemindersSheet({ visible, reminders, name, onDismiss }: { visible: boolean; reminders: Reminder[]; name: string; onDismiss: () => void }) {
  // Mounted only while open, so each opening starts its own slide-in.
  return visible ? <Sheet reminders={reminders} name={name} onDismiss={onDismiss} /> : null;
}

function Sheet({ reminders, name, onDismiss }: { reminders: Reminder[]; name: string; onDismiss: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { height: screen } = useWindowDimensions();
  const scale = useSettings((s) => s.textScale);
  const agents = useLive((s) => s.agents);
  const devices = useLive((s) => s.devices);
  const byKey = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const list of Object.values(agents)) for (const a of list) m.set(a.key, a);
    return m;
  }, [agents]);
  // Soonest first; reminders that only watch an agent go last (the relay sends them in this order too).
  const list = useMemo(() => [...reminders].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)), [reminders]);

  // Countdowns stay current while the sheet is open.
  const [now, setNow] = useState(() => Date.now());
  const timed = list.some((r) => r.dueAt);
  useEffect(() => {
    if (!timed) return;
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [timed]);

  // 0 = closed (below the screen, scrim clear), 1 = open.
  const shown = useSharedValue(0);
  const height = useSharedValue(0);
  const closing = useRef(false);
  useEffect(() => {
    shown.set(withTiming(1, { duration: motion.standard + 40, easing: motion.glide }));
  }, [shown]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    shown.set(
      withTiming(0, { duration: 200, easing: Easing.in(Easing.cubic) }, () => {
        scheduleOnRN(onDismiss);
      }),
    );
  }, [shown, onDismiss]);
  const scrimStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  // Until the sheet is measured it waits a full screen below, so the first frame never flashes in place.
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - shown.get()) * (height.get() || screen) }] }));

  return (
    <Modal visible transparent animationType="none" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(30,26,38,0.38)" }, scrimStyle]}>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭提醒" onPress={close} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          onLayout={(e) => height.set(e.nativeEvent.layout.height)}
          style={[
            {
              width: "100%",
              maxWidth: MAX_WIDTH,
              alignSelf: "center",
              maxHeight: "85%",
              backgroundColor: p.page,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              overflow: "hidden",
            },
            sheetStyle,
          ]}
        >
          <View style={{ alignItems: "center", paddingTop: space.sm }}>
            <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: p.divider }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.xl, paddingRight: space.md, paddingTop: space.xs }}>
            <Text accessibilityRole="header" style={{ fontFamily: fonts.cute, fontSize: 22, lineHeight: 30, color: p.ink }}>
              提醒
            </Text>
            {list.length ? (
              <View style={{ minWidth: 24, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: p.accentContainer, alignItems: "center" }}>
                <Text accessibilityLabel={`${list.length} 个`} style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>
                  {list.length}
                </Text>
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            <IconTile icon="close" tone="plain" size={44} iconSize={20} onPress={close} a11y="关闭" />
          </View>
          {list.length ? (
            <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20, paddingHorizontal: space.xl, paddingBottom: space.sm }}>到时候{name}会在聊天里叫你。</Text>
          ) : null}

          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: insets.bottom + space.xl, gap: space.md }}
          >
            {list.length ? (
              list.map((r) => <ReminderCard key={r.id} r={r} now={now} scale={scale} agent={r.agent ? byKey.get(r.agent) : undefined} deviceName={(id) => devices[id]?.name} />)
            ) : (
              <Empty name={name} scale={scale} />
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function ReminderCard({ r, now, scale, agent, deviceName }: { r: Reminder; now: number; scale: number; agent?: Agent; deviceName: (id: string) => string | undefined }) {
  const p = usePalette();
  const [cancelling, setCancelling] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const when = r.dueAt ? dueTime(r.dueAt, now) : null;
  const watch = r.agent ? (r.until === "blocked" ? "等它需要你" : "等它停下来") : null;
  const icon: CuteIconName = when ? "bell" : r.until === "blocked" ? "blocked" : "done";
  const tint = when ? { fg: p.accentText, bg: p.accentContainer } : { fg: p.dusk, bg: p.duskContainer };

  async function cancel() {
    setCancelling(true);
    setFailed(null);
    try {
      await cancelReminder(r.id);
    } catch (e) {
      setFailed((e as Error).message);
      setCancelling(false);
    }
  }

  return (
    <Animated.View
      exiting={FadeOut.duration(motion.quick)}
      layout={LinearTransition.duration(motion.standard)}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, backgroundColor: p.surface, borderRadius: radius.card, paddingLeft: space.lg, paddingRight: space.xs, paddingVertical: space.md + 2 }}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: tint.bg, alignItems: "center", justifyContent: "center" }}>
        <CuteIcon name={icon} size={19} color={tint.fg} fill={p.dark ? "transparent" : "#FFFFFF"} strokeWidth={2.4} />
      </View>

      <View style={{ flex: 1, gap: space.sm, paddingTop: 1 }}>
        <ClampedText text={r.text} scale={scale} />

        {/* When: the countdown in the accent colour, then the day and clock. */}
        <View style={{ gap: 2 }}>
          {when ? (
            <Text style={{ fontSize: 13.5 * scale, lineHeight: 19 * scale, color: p.muted }}>
              <Text style={{ fontFamily: fonts.bodyBold, color: p.accentText }}>{when.rel}</Text>
              {"  ·  "}
              {when.abs}
            </Text>
          ) : null}
          {watch ? (
            <Text style={{ fontSize: 13.5 * scale, lineHeight: 19 * scale, color: p.muted }}>
              {when ? "或者" : ""}
              <Text style={{ fontFamily: fonts.bodyBold, color: p.dusk }}>{watch}</Text>
              {when ? "，看哪个先到" : ""}
            </Text>
          ) : null}
        </View>

        {r.agent ? <AgentStrip agent={agent} deviceName={agent ? deviceName(agent.deviceId) : undefined} scale={scale} /> : null}

        {failed ? <Text style={{ color: p.error, fontSize: 12.5 * scale, lineHeight: 18 * scale }}>没取消掉：{failed}</Text> : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`取消提醒：${r.text.slice(0, 30)}`}
        accessibilityState={{ disabled: cancelling, busy: cancelling }}
        disabled={cancelling}
        onPress={() => void cancel()}
        style={({ pressed }) => ({ width: 44, height: 44, marginTop: -space.sm, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : "transparent" })}
      >
        {cancelling ? <ActivityIndicator size="small" color={p.muted} /> : <CuteIcon name="close" size={18} color={p.faint} strokeWidth={2.4} />}
      </Pressable>
    </Animated.View>
  );
}

/** The agent a reminder watches: its badge, title, computer and what it is doing now. */
function AgentStrip({ agent, deviceName, scale }: { agent?: Agent; deviceName?: string; scale: number }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: p.surface2, borderWidth: 1, borderColor: p.divider, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 7 }}>
      {agent ? (
        <HarnessAvatar harness={agent.harness} isShell={agent.isShell} size={26} />
      ) : (
        <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: p.surface3, alignItems: "center", justifyContent: "center" }}>
          <CuteIcon name="robot" size={15} color={p.faint} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        {agent ? (
          <>
            <Text numberOfLines={1} style={{ color: p.ink, fontFamily: fonts.bodySemi, fontSize: 13.5 * scale, lineHeight: 19 * scale }}>
              {agentTitle(agent)}
            </Text>
            <Text numberOfLines={1} style={{ color: p.faint, fontSize: 12 * scale, lineHeight: 17 * scale }}>
              {[deviceName, agentStatusLabel(agent)].filter(Boolean).join(" · ")}
            </Text>
          </>
        ) : (
          <Text numberOfLines={2} style={{ color: p.faint, fontSize: 13 * scale, lineHeight: 18 * scale }}>
            暂时找不到这个 agent
          </Text>
        )}
      </View>
    </View>
  );
}

/** The reminder's own sentence; long ones fold after a few lines. */
function ClampedText({ text, scale }: { text: string; scale: number }) {
  const p = usePalette();
  const [lines, setLines] = useState(0);
  const [open, setOpen] = useState(false);
  const style = { color: p.ink, fontFamily: fonts.bodySemi, fontSize: 15.5 * scale, lineHeight: 22 * scale };
  return (
    <View>
      <Text style={style} numberOfLines={open ? undefined : CLAMP}>
        {text}
      </Text>
      {/* The whole text laid out unseen at the same width: tells whether the fold hides anything. */}
      <Text
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        onTextLayout={(e) => setLines(e.nativeEvent.lines.length)}
        style={[style, { position: "absolute", left: 0, right: 0, top: 0, opacity: 0, pointerEvents: "none" }]}
      >
        {text}
      </Text>
      {lines > CLAMP ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen((o) => !o)}
          hitSlop={{ top: 6, bottom: 6 }}
          style={{ alignSelf: "flex-start", minHeight: 32, justifyContent: "center", paddingRight: space.md }}
        >
          <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 13.5 * scale }}>{open ? "收起" : "展开全文"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const EXAMPLES = ["半小时后提醒我看一下进度", "登录重构那个跑完了叫我"];

function Empty({ name, scale }: { name: string; scale: number }) {
  const p = usePalette();
  return (
    <View style={{ alignItems: "center", gap: space.sm, paddingTop: space.md, paddingBottom: space.sm, paddingHorizontal: space.lg }}>
      <Mascot mood="sleepy" size={104} />
      <Text style={{ fontFamily: fonts.cute, fontSize: 20, lineHeight: 28, color: p.ink }}>还没有提醒</Text>
      <Text style={{ color: p.muted, fontSize: 14 * scale, lineHeight: 21 * scale, textAlign: "center" }}>想让{name}到点叫你、或者盯着哪个 agent，直接在聊天里说一声，比如：</Text>
      {/* Shaped like your own chat bubbles: things to say, not buttons. */}
      <View style={{ alignItems: "center", gap: space.sm, paddingTop: space.xs }}>
        {EXAMPLES.map((s) => (
          <View key={s} style={{ maxWidth: "100%", backgroundColor: p.bubble, borderRadius: radius.card, borderBottomRightRadius: 6, paddingHorizontal: space.md + 2, paddingVertical: 9 }}>
            <Text style={{ color: p.ink, fontSize: 14.5 * scale, lineHeight: 20 * scale }}>“{s}”</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
