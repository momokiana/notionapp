import { FlatList, Pressable, View } from "react-native";
import { ActivityIndicator, Button, Text } from "react-native-paper";
import { router } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import type { Agent, SubSession } from "@xiaoaixiaoai/protocol";
import { call } from "../lib/relay";
import { agentTitle, relTime } from "../lib/format";
import { openSub, SUB_STATUS, subLabel, type Crumb } from "../lib/subnav";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";
import { Card, EmptyState, HarnessAvatar } from "./ui";

/** Children of the agent's session (or of `sub`), newest first. Read-only; tap to open. */
export function SubagentList({ agent, sub, trail, active, bottomInset }: { agent: Agent; sub?: string; trail: Crumb[]; active: boolean; bottomInset: number }) {
  const p = usePalette();
  const q = useQuery({
    queryKey: ["session.children", agent.key, sub ?? null],
    queryFn: () => call(agent.deviceId, "session.children", { agent: agent.key, sub }),
    enabled: active,
    refetchInterval: active ? 5000 : false,
  });
  if (q.isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (q.isError) {
    return <EmptyState mood="waiting" title="子 agent 列表没拿到" body={(q.error as Error).message} action={<Button textColor={p.accentText} onPress={() => q.refetch()}>再试一次</Button>} />;
  }
  const list = q.data?.sessions ?? [];
  return (
    <FlatList
      data={list}
      keyExtractor={(s) => s.key}
      renderItem={({ item }) => <SubRow s={item} onPress={() => openSub(agent.key, trail, item)} />}
      ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      ListEmptyComponent={<EmptyState mood="sleepy" title="还没有子 agent" body="它派出子 agent 干活时，会出现在这里。" />}
      contentContainerStyle={{ padding: space.lg, paddingBottom: bottomInset + space.xxl }}
    />
  );
}

function SubRow({ s, onPress }: { s: SubSession; onPress: () => void }) {
  const p = usePalette();
  const c = statusColors(s.status === "working" ? "working" : "idle", p.dark);
  const label = subLabel(s);
  const preview = s.preview?.trim().split("\n")[0];
  return (
    <Card onPress={onPress} accessibilityLabel={`子 agent ${label}，${SUB_STATUS[s.status]}`} style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, paddingLeft: space.lg, minHeight: 72 }}>
      <HarnessAvatar harness={s.harness} isShell={false} size={38} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: p.ink }}>
          {label}
        </Text>
        {preview && preview !== label ? (
          <Text numberOfLines={1} style={{ fontSize: 13, color: p.muted }}>
            {preview}
          </Text>
        ) : null}
        {s.children ? <Text style={{ fontSize: 12, color: p.faint }}>它还派了 {s.children} 个子 agent</Text> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />
          <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>{SUB_STATUS[s.status]}</Text>
        </View>
        <Text style={{ fontSize: 12, color: p.faint }}>{relTime(s.statusSince ?? s.updatedAt)}</Text>
      </View>
    </Card>
  );
}

/** "主 agent > 子 > 孙" — earlier steps are tappable and pop back to that level. */
export function Breadcrumb({ agent, trail }: { agent: Agent; trail: Crumb[] }) {
  const p = usePalette();
  const steps = [{ k: agent.key, t: agentTitle(agent) }, ...trail];
  return (
    <View accessibilityRole="header" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
      {steps.map((st, i) => {
        const last = i === steps.length - 1;
        const back = steps.length - 1 - i;
        return (
          <View key={st.k} style={{ flexDirection: "row", alignItems: "center", gap: 2, maxWidth: last ? "100%" : "45%" }}>
            {i > 0 ? <MaterialCommunityIcons name="chevron-right" size={14} color={p.faint} /> : null}
            <Pressable
              disabled={last}
              accessibilityRole={last ? "text" : "link"}
              accessibilityLabel={last ? `当前：${st.t}` : `回到 ${st.t}`}
              onPress={() => router.dismiss(back)}
              hitSlop={6}
              style={{ minHeight: 28, justifyContent: "center" }}
            >
              <Text numberOfLines={1} style={{ fontSize: 12.5, color: last ? p.ink : p.accentText, fontFamily: last ? fonts.bodyBold : fonts.bodySemi }}>
                {i === 0 ? `主 agent · ${st.t}` : st.t}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
