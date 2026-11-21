import { memo, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { effectiveAgentStatus, type Agent, type AgentStatus } from "@xiaoaixiaoai/protocol";
import { usePalette } from "../theme/theme";
import { agentStatusLabel, fonts, radius, space, spaceColors, statusColors } from "../theme/tokens";
import { agentSpace, agentTitle, quotaChip, relTime, stableHash, type QuotaTone } from "../lib/format";
import { harnessLook } from "../lib/harness";
import { reconnectNow } from "../lib/relay";
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

function quotaChipColors(tone: QuotaTone, dark: boolean): { fg: string; bg: string } {
  if (tone === "ok") return statusColors("working", dark);
  if (tone === "low") return statusColors("blocked", dark);
  if (tone === "warn") return { fg: dark ? "#FFD28A" : "#9A4E04", bg: dark ? "#402E14" : "#FFEDD5" };
  return statusColors("idle", dark);
}

export const AgentRow = memo(function AgentRow({
  agent,
  offline,
  deviceName,
  pinned,
  onLongPress,
}: {
  agent: Agent;
  offline?: boolean;
  deviceName?: string;
  pinned?: boolean;
  onLongPress?: () => void;
}) {
  const p = usePalette();
  const sub = [harnessLook(agent.harness, agent.isShell).label, deviceName, agent.model, agent.turn ? `第 ${agent.turn} 轮` : null]
    .filter(Boolean)
    .join(" · ");
  const quota = offline ? null : quotaChip(agent.modelQuota);
  const qColors = quota ? quotaChipColors(quota.tone, p.dark) : null;
  const summaryLine = (agent.statusNote || agent.preview || "").replace(/\s+/g, " ").trim();
  const needsYou = agent.status === "blocked" && !offline;
  const c = statusColors("blocked", p.dark);
  return (
    <Card
      onPress={() => openAgent(agent.key)}
      onLongPress={onLongPress}
      accessibilityLabel={`${spacedTitle(agent)}，${agent.harness}${agent.model ? `，${agent.model}` : ""}${quota ? `，${quota.text}` : ""}${offline ? "，电脑离线" : ""}`}
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {pinned ? <MaterialCommunityIcons name="pin" size={14} color={p.accentText} /> : null}
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 16, color: offline ? p.muted : p.ink }}>
            {spacedTitle(agent)}
          </Text>
          {agent.canSend === false ? (
            <View style={{ backgroundColor: p.surface2, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1 }}>
              <Text style={{ color: p.faint, fontFamily: fonts.bodySemi, fontSize: 10.5 }}>只读</Text>
            </View>
          ) : null}
        </View>
        {summaryLine ? (
          <Text numberOfLines={1} style={{ fontSize: 12.5, color: needsYou ? c.fg : p.muted }}>
            {summaryLine}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12.5, color: offline ? p.faint : p.muted }}>
            {sub}
          </Text>
          {quota && qColors ? (
            <View style={{ backgroundColor: qColors.bg, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 }}>
              <Text style={{ color: qColors.fg, fontFamily: fonts.bodySemi, fontSize: 11 }}>{quota.text}</Text>
            </View>
          ) : null}
          {agent.subagents ? (
            <View
              accessibilityLabel={`${agent.subagents} 个子 agent${agent.subagentsWorking ? `，${agent.subagentsWorking} 个在忙` : ""}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: p.lavenderContainer, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 }}
            >
              {agent.subagentsWorking ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColors("working", p.dark).fg }} /> : null}
              <Text style={{ color: p.ink, fontFamily: fonts.bodySemi, fontSize: 11.5 }}>
                {`子 agent ${agent.subagents}${agent.subagentsWorking ? ` · ${agent.subagentsWorking} 在忙` : ""}`}
              </Text>
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
          <StatusPill status={effectiveAgentStatus(agent)} label={agentStatusLabel(agent)} compact />
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
  const nextRetryAt = useLive((s) => s.nextRetryAt);
  const reconnectAttempt = useLive((s) => s.reconnectAttempt);
  const [secsLeft, setSecsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (link !== "offline" || nextRetryAt === null) return;
    const update = () => setSecsLeft(Math.max(1, Math.ceil((nextRetryAt - Date.now()) / 1000)));
    const first = setTimeout(update, 0);
    const id = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [link, nextRetryAt]);
  const copy = LINK_COPY[link];
  if (!copy) return null;
  const warn = link === "offline" || link === "unauthorized";
  const fg = warn ? p.error : p.ink;
  const repair = link === "unauthorized";
  let text = copy.text;
  if (link === "offline") {
    const secs = nextRetryAt !== null ? secsLeft : null;
    text = secs && secs > 0
      ? `连不上服务器，${secs} 秒后自动重连（点此重试）`
      : `和服务器断开了，正在自动重连（第 ${Math.max(1, reconnectAttempt)} 次）`;
  } else if (link === "connecting" && reconnectAttempt > 0) {
    text = `正在尝试重连服务器（第 ${reconnectAttempt} 次）…`;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        if (repair) void signOut().then(() => router.replace("/connect"));
        else reconnectNow();
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
      <Text style={{ flex: 1, fontSize: 13.5, color: fg }}>{text}</Text>
      {repair ? <MaterialCommunityIcons name="chevron-right" size={18} color={fg} /> : <MaterialCommunityIcons name="refresh" size={16} color={fg} />}
    </Pressable>
  );
}
