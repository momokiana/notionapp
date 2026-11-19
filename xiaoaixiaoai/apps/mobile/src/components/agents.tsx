import { memo } from "react";
import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { Agent, AgentStatus } from "@xiaoaixiaoai/protocol";
import { usePalette } from "../theme/theme";
import { agentStatusLabel, fonts, radius, space, spaceColors, statusColors } from "../theme/tokens";
import { agentSpace, agentTitle, relTime, stableHash } from "../lib/format";
import { harnessLook } from "../lib/harness";
import { Card, HarnessAvatar, StatusPill } from "./ui";
import { useLive, type LinkStatus } from "../lib/store";
import { signOut } from "../lib/session";

export function openAgent(key: string) {
  router.push({ pathname: "/agent/[key]", params: { key } });
}

/** "space · title" (title alone when there is no space or they are the same). */
export function spacedTitle(a: Agent): string {
  const sp = agentSpace(a);
  const t = agentTitle(a);
  return sp && !t.startsWith(sp) ? `${sp} · ${t}` : t;
}

/** Coloured square with the first character of a space name. */
export function SpaceBadge({ name, size = 22 }: { name: string; size?: number }) {
  const p = usePalette();
  const c = spaceColors(name, p.dark, stableHash);
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: c.bg, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: size * 0.55, lineHeight: size * 0.8 }}>{Array.from(name)[0] ?? "?"}</Text>
    </View>
  );
}

/**
 * Messages typed into a busy agent that its program has not taken yet (they sit
 * in its input box until the turn ends). Nothing when none are waiting.
 */
export function QueuedChip({ agent }: { agent: Agent }) {
  const p = usePalette();
  if (!agent.queued) return null;
  return (
    <View
      accessibilityLabel={`${agent.queued} 条消息排在它的输入框里，这一轮完了才会处理`}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: p.accentContainer, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.primary }} />
      <Text style={{ color: p.accentText, fontFamily: fonts.bodySemi, fontSize: 11.5 }}>排队中 {agent.queued}</Text>
    </View>
  );
}

export const AgentRow = memo(function AgentRow({ agent, offline, deviceName }: { agent: Agent; offline?: boolean; deviceName?: string }) {
  const p = usePalette();
  const sub = [harnessLook(agent.harness, agent.isShell).label, deviceName, agent.turn ? `第 ${agent.turn} 轮` : null]
    .filter(Boolean)
    .join(" · ");
  const needsYou = agent.status === "blocked" && !offline;
  const c = statusColors("blocked", p.dark);
  return (
    <Card
      onPress={() => openAgent(agent.key)}
      accessibilityLabel={`${spacedTitle(agent)}，${agent.harness}${offline ? "，电脑离线" : ""}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        gap: space.md,
        minHeight: 72,
        backgroundColor: needsYou ? (p.dark ? "#33242C" : "#FFF7F8") : offline ? p.surface2 : p.surface,
        borderWidth: needsYou ? 1.5 : 0,
        borderColor: needsYou ? c.bg : "transparent",
      }}
    >
      <HarnessAvatar harness={agent.harness} isShell={agent.isShell} dim={offline} size={48} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 16, color: offline ? p.muted : p.ink }}>
          {spacedTitle(agent)}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: offline ? p.faint : p.muted }}>
            {sub}
          </Text>
          {agent.subagents ? (
            <View
              accessibilityLabel={`${agent.subagents} 个子 agent${agent.subagentsWorking ? `，${agent.subagentsWorking} 个在忙` : ""}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: p.lavenderContainer, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 }}
            >
              {agent.subagentsWorking ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColors("working", p.dark).fg }} /> : null}
              <Text style={{ color: p.ink, fontFamily: fonts.bodySemi, fontSize: 11.5 }}>子 agent {agent.subagents}</Text>
            </View>
          ) : null}
          {offline ? null : <QueuedChip agent={agent} />}
        </View>
      </View>
      <View style={{ alignItems: "flex-end", gap: 6 }}>
        {offline ? (
          <View style={{ backgroundColor: p.surface3, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3 }}>
            <Text style={{ color: p.muted, fontFamily: fonts.bodyBold, fontSize: 12 }}>离线</Text>
          </View>
        ) : (
          <StatusPill status={agent.status} label={agentStatusLabel(agent)} compact />
        )}
        <Text style={{ fontSize: 12, color: p.faint }}>{relTime(agent.statusSince ?? agent.updatedAt)}</Text>
      </View>
    </Card>
  );
});

const TILES: Array<{ s: AgentStatus; label: string; icon: "heart-outline" | "play-circle-outline" | "check-circle-outline" }> = [
  { s: "blocked", label: "需要你", icon: "heart-outline" },
  { s: "working", label: "工作中", icon: "play-circle-outline" },
  { s: "done", label: "已完成", icon: "check-circle-outline" },
];

/** Three pastel stat tiles; tapping one filters the list. */
export function OverviewCard({ counts, onPick, active }: { counts: Record<AgentStatus, number>; onPick: (s: AgentStatus | null) => void; active: AgentStatus | null }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      {TILES.map(({ s, label, icon }) => {
        const c = statusColors(s, p.dark);
        const on = active === s;
        return (
          <Card
            key={s}
            flat
            onPress={() => onPick(on ? null : s)}
            outerStyle={{ flex: 1 }}
            accessibilityLabel={`${label} ${counts[s]} 个，点按${on ? "取消" : ""}筛选`}
            style={{
              backgroundColor: c.bg,
              borderRadius: radius.card,
              borderWidth: 2,
              borderColor: on ? c.fg : "transparent",
              paddingVertical: space.md,
              paddingHorizontal: space.md,
              minHeight: 92,
              justifyContent: "space-between",
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <MaterialCommunityIcons name={icon} size={16} color={c.fg} />
              <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: c.fg }}>{label}</Text>
            </View>
            <Text style={{ fontFamily: fonts.cute, fontSize: 32, lineHeight: 40, color: c.fg }}>{counts[s]}</Text>
          </Card>
        );
      })}
    </View>
  );
}

const LINK_COPY: Record<LinkStatus, { text: string; icon: "wifi-off" | "sync" | "lock-alert" } | null> = {
  idle: null,
  online: null,
  connecting: { text: "正在连接服务器…", icon: "sync" },
  offline: { text: "和服务器断开了，正在重连", icon: "wifi-off" },
  unauthorized: { text: "这台手机的授权已失效，点这里重新配对", icon: "lock-alert" },
};

export function ConnectionBanner() {
  const p = usePalette();
  const link = useLive((s) => s.link);
  const copy = LINK_COPY[link];
  if (!copy) return null;
  const warn = link !== "connecting";
  const fg = warn ? p.error : p.ink;
  const repair = link === "unauthorized";
  return (
    <Pressable
      disabled={!repair}
      accessibilityRole={repair ? "button" : undefined}
      onPress={() => {
        signOut().then(() => router.replace("/connect"));
      }}
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        marginHorizontal: space.lg,
        marginBottom: space.sm,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        borderRadius: radius.pill,
        backgroundColor: warn ? p.errorContainer : p.lavenderContainer,
      }}
    >
      <MaterialCommunityIcons name={copy.icon} size={16} color={fg} />
      <Text style={{ flex: 1, fontSize: 13.5, color: fg }}>{copy.text}</Text>
      {repair ? <MaterialCommunityIcons name="chevron-right" size={18} color={fg} /> : null}
    </Pressable>
  );
}
