/**
 * The voice call: a full screen with the living orb, what is being said, and
 * three buttons; plus the small bar that stands in for it while the person looks
 * at the chat during a call.
 */
import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, BackHandler, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from "react-native-reanimated";
import type { Notice } from "@xiaoaixiaoai/protocol";
import { callPhase, dismissCallMessage, hangup, toggleMute, useVoice, type CallLine, type CallPhase } from "../lib/voice";
import { useAssistant } from "../lib/assistant";
import { findAgent } from "../lib/store";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { CallFace, LevelBars, VoiceOrb } from "./VoiceOrb";
import { NoticeIcon, noticeLook } from "./notice";
import { CuteIcon, type CuteIconName } from "./icons";
import { IconTile } from "./ui";


function usePhase(): CallPhase {
  const status = useVoice((s) => s.status);
  const speaking = useVoice((s) => s.speaking);
  const listening = useVoice((s) => s.listening);
  const waiting = useVoice((s) => s.waiting);
  const muted = useVoice((s) => s.muted);
  const task = useVoice((s) => s.task);
  return callPhase({ status, speaking, listening, waiting, muted, task });
}

function phaseText(phase: CallPhase, name: string, hasTask: boolean): string {
  switch (phase) {
    case "connecting":
      return "正在接通…";
    case "speaking":
      return `${name}在说`;
    case "thinking":
      return hasTask ? `${name}在查` : `${name}在想`;
    case "muted":
      return "你静音了";
    case "listening":
      return "在听你说";
    default:
      return "说吧，我在听";
  }
}

/** mm:ss since the call was answered. */
function useCallClock(): string {
  const startedAt = useVoice((s) => s.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return "";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The newest thing the assistant brought up on its own during this call, for a short while. */
function useCallNotice(): Notice | null {
  const startedAt = useVoice((s) => s.startedAt);
  const items = useAssistant((s) => s.items);
  const latest = useMemo(() => {
    if (!startedAt) return null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.ts < startedAt) break;
      if (it.role === "notice" && it.notice) return it.notice;
    }
    return null;
  }, [items, startedAt]);
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    if (!latest) return;
    const t = setTimeout(() => setHidden(latest.id), Math.max(0, latest.ts + 25_000 - Date.now()));
    return () => clearTimeout(t);
  }, [latest]);
  return latest && hidden !== latest.id ? latest : null;
}

export function CallScreen({ name, onMinimize }: { name: string; onMinimize: () => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const phase = usePhase();
  const muted = useVoice((s) => s.muted);
  const task = useVoice((s) => s.task);
  const lines = useVoice((s) => s.lines);
  const callMessage = useVoice((s) => s.message);
  const clock = useCallClock();
  const notice = useCallNotice();
  const [captions, setCaptions] = useState(true);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    if (!callMessage) return;
    const t = setTimeout(() => dismissCallMessage(), 5_000);
    return () => clearTimeout(t);
  }, [callMessage]);

  // Back leaves the call running and goes to the chat, like the button does.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onMinimize();
      return true;
    });
    return () => sub.remove();
  }, [onMinimize]);

  const orb = Math.round(Math.min(width * (captions ? 0.68 : 0.82), height * (captions ? 0.34 : 0.44), 340));
  const accent = phase === "muted" || phase === "connecting" ? p.muted : p.accentText;

  return (
    <LinearGradient colors={[p.pageTop, p.pageBottom]} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, paddingTop: insets.top + space.md, paddingBottom: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg }}>
        <RoundButton icon="chevronDown" label="收起通话，回到聊天" onPress={onMinimize} />
        <View style={{ flex: 1, alignItems: "center" }}>
          <View
            accessibilityLabel={phase === "connecting" ? "正在接通" : `通话中 ${clock}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: phase === "connecting" ? p.lavenderContainer : p.dark ? "#1F3A33" : "#DDF5EE", borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: phase === "connecting" ? p.lavender : "#3FB68B" }} />
            <Text style={{ fontFamily: fonts.bodyBold, fontSize: 14, color: p.ink, fontVariant: ["tabular-nums"] }}>{phase === "connecting" ? "正在接通" : `通话中 ${clock}`}</Text>
          </View>
        </View>
        <RoundButton icon={captions ? "captions" : "captionsOff"} label={captions ? "隐藏字幕" : "显示字幕"} onPress={() => setCaptions((v) => !v)} active={captions} />
      </View>

      <Animated.View layout={LinearTransition.duration(260)} style={{ alignItems: "center", paddingTop: captions ? space.md : space.xxxl }}>
        <VoiceOrb phase={phase} size={orb} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.xs, minHeight: 30 }}>
          <Text accessibilityLiveRegion="polite" style={{ fontFamily: fonts.cute, fontSize: 21, lineHeight: 30, color: accent }}>
            {phaseText(phase, name, !!task)}
          </Text>
          <LevelBars active={phase === "speaking" || phase === "listening"} color={p.primary} />
        </View>
      </Animated.View>

      <View style={{ flex: 1, paddingTop: space.md }}>
        {captions ? (
          lines.length ? (
            <ScrollView
              ref={scroller}
              onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
              contentContainerStyle={{ paddingHorizontal: space.lg, paddingVertical: space.xs, gap: space.sm }}
              showsVerticalScrollIndicator={false}
            >
              {lines.map((l, i) => (
                <Caption key={l.id} line={l} recent={i >= lines.length - 2} />
              ))}
            </ScrollView>
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xxl }}>
              <Text style={{ color: p.muted, textAlign: "center", lineHeight: 22 }}>
                {phase === "connecting" ? "接通后直接说话就行。" : "直接说话就行，比如“谁在等我”“帮我看看哪个跑完了”。"}
              </Text>
            </View>
          )
        ) : null}
      </View>

      <View style={{ minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }}>
        {callMessage ? (
          <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOut.duration(160)} style={{ maxWidth: "100%" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${callMessage}，点击关闭`}
              onPress={dismissCallMessage}
              style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: p.errorContainer, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: 8 }}
            >
              <Text numberOfLines={2} style={{ color: p.error, fontSize: 13, fontFamily: fonts.bodySemi }}>
                {callMessage}
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
        {notice ? <CallNotice notice={notice} onOpen={onMinimize} /> : null}
        {task ? (
          <Animated.View
            entering={FadeInDown.duration(220)}
            exiting={FadeOut.duration(160)}
            style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: p.surface, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: 9, maxWidth: "100%", elevation: p.dark ? 0 : 2, shadowColor: p.shadow, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } }}
          >
            <ActivityIndicator size={16} color={p.primary} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: p.ink, fontSize: 13.5, fontFamily: fonts.bodySemi }}>
              正在查：{task.title}
            </Text>
          </Animated.View>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "flex-start", gap: space.xxxl + space.sm, paddingBottom: Math.max(insets.bottom, space.sm) }}>
        <CallButton icon={muted ? "micOff" : "mic"} label={muted ? "取消静音" : "静音"} onPress={toggleMute} active={muted} />
        <CallButton icon="hangup" label="挂断" onPress={hangup} big />
        <CallButton icon="keyboard" label="打字" onPress={onMinimize} />
      </View>
    </LinearGradient>
  );
}

function Caption({ line, recent }: { line: CallLine; recent: boolean }) {
  const p = usePalette();
  if (line.role === "user") {
    return (
      <Animated.View entering={FadeIn.duration(180)} style={{ alignSelf: "flex-end", maxWidth: "82%", opacity: recent ? 1 : 0.5, backgroundColor: p.surface3, borderRadius: radius.card, borderBottomRightRadius: 6, paddingHorizontal: space.md, paddingVertical: 8, borderWidth: 1, borderColor: p.divider }}>
        <Text style={{ color: p.muted, fontSize: 14.5, lineHeight: 21 }}>{line.text}</Text>
      </Animated.View>
    );
  }
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      style={{ alignSelf: "flex-start", maxWidth: "90%", opacity: recent ? 1 : 0.5, backgroundColor: p.surface, borderRadius: radius.card, borderBottomLeftRadius: 6, paddingHorizontal: space.lg, paddingVertical: 11, elevation: p.dark || !recent ? 0 : 2, shadowColor: p.shadow, shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}
    >
      <Text style={{ color: p.ink, fontSize: 16.5, lineHeight: 25, fontFamily: fonts.bodySemi }}>{line.text}</Text>
    </Animated.View>
  );
}

/** Something the assistant brings up by itself mid-call (it also says it out loud). */
function CallNotice({ notice, onOpen }: { notice: Notice; onOpen: () => void }) {
  const p = usePalette();
  const look = noticeLook(notice, p);
  const agent = notice.agent ? findAgent(notice.agent) : undefined;
  return (
    <Animated.View entering={FadeInDown.duration(240)} exiting={FadeOut.duration(180)} style={{ alignSelf: "stretch" }}>
      <Pressable
        accessibilityRole={agent ? "button" : "text"}
        accessibilityLabel={`${notice.title}。${notice.body}`}
        disabled={!agent}
        onPress={() => {
          if (!agent) return;
          onOpen();
          router.push({ pathname: "/agent/[key]", params: { key: agent.key } });
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: p.surface, borderRadius: radius.card, padding: space.md, elevation: p.dark ? 0 : 2, shadowColor: p.shadow, shadowOpacity: 0.14, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}
      >
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: look.bg, alignItems: "center", justifyContent: "center" }}>
          <NoticeIcon look={look} size={19} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 14 }}>
            {notice.title}
          </Text>
          {notice.body ? (
            <Text numberOfLines={2} style={{ color: p.muted, fontSize: 13, lineHeight: 18 }}>
              {notice.body}
            </Text>
          ) : null}
        </View>
        {agent ? <CuteIcon name="chevronRight" size={18} color={p.faint} /> : null}
      </Pressable>
    </Animated.View>
  );
}

function RoundButton({ icon, label, onPress, active }: { icon: CuteIconName; label: string; onPress: () => void; active?: boolean }) {
  return <IconTile icon={icon} tone="plain" size={44} active={active} onPress={onPress} a11y={label} />;
}

/** Call controls: soft lavender tiles for mute and typing, a rosy round hang-up in the middle. */
function CallButton({ icon, label, onPress, big, active }: { icon: CuteIconName; label: string; onPress: () => void; big?: boolean; active?: boolean }) {
  const p = usePalette();
  const d = big ? 76 : 62;
  const bg = big ? (p.dark ? "#E2687E" : "#F2647F") : active ? p.primary : p.dark ? p.lavenderContainer : "#FFFFFF";
  const fg = big ? "#FFFFFF" : active ? p.onPrimary : p.ink;
  const fill = big ? "#FFFFFF" : active ? "#FFFFFF" : p.dark ? p.surface3 : p.accentContainer;
  return (
    <View style={{ alignItems: "center", gap: 6, width: 84 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => ({
          width: d,
          height: d,
          borderRadius: d / 2,
          marginTop: big ? 0 : 7,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: bg,
          borderWidth: big ? 4 : 1,
          overflow: "hidden",
          borderColor: big ? (p.dark ? "#5A2F3B" : "#FFD3DC") : p.dark ? p.surface3 : "#F6DDE8",
          transform: [{ scale: pressed ? 0.93 : 1 }],
          elevation: p.dark ? 0 : big ? 6 : 2,
          shadowColor: big ? "#F2647F" : p.shadow,
          shadowOpacity: big ? 0.35 : 0.14,
          shadowRadius: big ? 14 : 8,
          shadowOffset: { width: 0, height: big ? 6 : 3 },
        })}
      >
        {big ? (
          <LinearGradient
            colors={p.dark ? ["#F58AA6", "#D9566F"] : ["#FFA3C2", "#F2647F"]}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: d / 2 }}
          />
        ) : null}
        <CuteIcon name={icon} size={big ? 36 : 27} color={fg} fill={fill} />
      </Pressable>
      <Text style={{ color: p.ink, fontSize: 13, fontFamily: fonts.cute }}>{label}</Text>
    </View>
  );
}

/** The call, folded into one line above the composer while the chat is in view. */
export function CallBar({ name, onExpand }: { name: string; onExpand: () => void }) {
  const p = usePalette();
  const phase = usePhase();
  const muted = useVoice((s) => s.muted);
  const task = useVoice((s) => s.task);
  const clock = useCallClock();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`通话中，${phaseText(phase, name, !!task)}。点一下回到通话`}
      onPress={onExpand}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginHorizontal: space.lg, marginBottom: space.sm, backgroundColor: p.accentContainer, borderRadius: radius.xl, paddingLeft: 6, paddingRight: 6, paddingVertical: 6 }}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, overflow: "hidden", borderWidth: 2, borderColor: p.surface }}>
        <CallFace phase={phase} size={38} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.bodyBold, color: p.ink, fontSize: 14 }}>
            {phaseText(phase, name, !!task)}
          </Text>
          <LevelBars active={phase === "speaking" || phase === "listening"} color={p.accentText} />
        </View>
        <Text style={{ color: p.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{phase === "connecting" ? "正在接通" : `通话中 ${clock} · 点这里回到通话`}</Text>
      </View>
      <IconTile icon={muted ? "micOff" : "mic"} tone="plain" size={40} active={muted} onPress={toggleMute} a11y={muted ? "取消静音" : "静音"} />
      <IconTile icon="hangup" tone="danger" size={40} onPress={hangup} a11y="挂断" />
    </Pressable>
  );
}
