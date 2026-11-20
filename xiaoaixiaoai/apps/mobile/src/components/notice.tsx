/**
 * Something the assistant tells the person without being asked: an agent
 * finished, needs them, or a reminder is due. In the chat it reads as the
 * assistant talking — its sentence first — not as a system card.
 */
import { memo, useMemo } from "react";
import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import Markdown from "react-native-markdown-display";
import type { AssistantItem, Notice } from "@xiaoaixiaoai/protocol";
import { findAgent, useSettings } from "../lib/store";
import { fixCjkEmphasis } from "../lib/markdown";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors, type Palette } from "../theme/tokens";
import { mdStyles } from "./chat";
import { CuteIcon, type CuteIconName } from "./icons";

/** Icon and colours for what the assistant found; older notices only carry their kind. Same icon family as the agent status chips. */
export function noticeLook(n: Pick<Notice, "kind" | "verdict">, p: Palette): { icon: CuteIconName; fg: string; bg: string } {
  const verdict = n.verdict ?? (n.kind === "blocked" ? "decide" : n.kind === "done" ? "ok" : undefined);
  switch (verdict) {
    case "ok":
      return { icon: "done", ...statusColors("working", p.dark) };
    case "decide":
      return { icon: "blocked", ...statusColors("blocked", p.dark) };
    case "failed":
      return { icon: "alert", fg: p.error, bg: p.errorContainer };
    case "stopped":
      return { icon: "pause", ...statusColors("idle", p.dark) };
    default:
      return { icon: "bell", fg: p.dusk, bg: p.duskContainer };
  }
}

/** A notice's icon drawn like the status chips: chubby stroke, white inner fill in light mode. */
export function NoticeIcon({ look, size }: { look: { icon: CuteIconName; fg: string }; size: number }) {
  const p = usePalette();
  return <CuteIcon name={look.icon} size={size} color={look.fg} fill={p.dark ? "transparent" : "#FFFFFF"} strokeWidth={2.4} />;
}

/** "去看看": opens the agent's own screen, from a notice or from what the assistant did to it. */
export function AgentLink({ agentKey }: { agentKey: string }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: "/agent/[key]", params: { key: agentKey } })}
      hitSlop={8}
      style={({ pressed }) => ({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 2, minHeight: 32, paddingLeft: 12, paddingRight: 8, borderRadius: radius.pill, backgroundColor: pressed ? p.accentContainer : p.dark ? p.surface2 : "#FFF1F6" })}
    >
      <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 13.5 }}>去看看</Text>
      <CuteIcon name="chevronRight" size={15} color={p.accentText} strokeWidth={2.6} />
    </Pressable>
  );
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const NoticeBubble = memo(function NoticeBubble({
  item,
  speaking,
  onToggleSpeak,
}: {
  item: AssistantItem;
  speaking?: boolean;
  onToggleSpeak?: () => void;
}) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  const styles = useMemo(() => {
    const md = mdStyles(p, scale * 0.9);
    return { ...md, body: { ...md.body, color: p.muted }, paragraph: { marginTop: 0, marginBottom: 4 } };
  }, [p, scale]);
  const n = item.notice!;
  const look = noticeLook(n, p);
  const agent = n.agent ? findAgent(n.agent) : undefined;
  // Shown in full: details are at most 300 characters, and folding them read as broken.
  const details = n.details?.trim();

  return (
    // A set width, not maxWidth: sized to its content, the card measured wrapped list
    // lines as one line each and the text ran out under it.
    <View style={{ alignSelf: "flex-start", width: "92%", gap: 4 }}>
      <View style={{ backgroundColor: p.surface, borderRadius: radius.card, borderBottomLeftRadius: 6, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm, gap: 7 }}>
        <View style={{ alignSelf: "flex-start", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: look.bg, borderRadius: radius.pill, paddingLeft: 7, paddingRight: 10, paddingVertical: 3 }}>
          <NoticeIcon look={look} size={15} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: look.fg, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>
            {n.title}
          </Text>
        </View>
        {n.body ? (
          <Text style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 22 * scale }} numberOfLines={details ? undefined : 8}>
            {n.body}
          </Text>
        ) : null}
        {details ? <Markdown style={styles}>{fixCjkEmphasis(details)}</Markdown> : null}
        {agent ? <AgentLink agentKey={agent.key} /> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
        <CuteIcon name="bell" size={12} color={p.faint} strokeWidth={2.4} />
        <Text style={{ color: p.faint, fontSize: 11 }}>{clock(item.ts)} · 主动告诉你</Text>
        {onToggleSpeak ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={speaking ? "停止语音播报" : "语音播报这条通知"}
            onPress={onToggleSpeak}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: radius.pill,
              backgroundColor: speaking || pressed ? p.skyContainer : p.surface2,
            })}
          >
            <CuteIcon name={speaking ? "volumeOff" : "volume"} size={12} color={speaking ? p.skyText : p.muted} strokeWidth={2.3} />
            <Text style={{ color: speaking ? p.skyText : p.muted, fontSize: 11, fontFamily: fonts.bodySemi }}>{speaking ? "停止" : "播报"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});
