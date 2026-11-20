import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, SectionList, View } from "react-native";
import { Button, Searchbar, Snackbar, Text } from "react-native-paper";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useNavigation, router } from "expo-router";
import { effectiveAgentStatus, type Agent, type AgentStatus } from "@xiaoaixiaoai/protocol";
import { AgentRow, ConnectionBanner, SpaceBadge } from "../../components/agents";
import { Card, EmptyState, IconTile, PageBackground } from "../../components/ui";
import { LiveMascot } from "../../components/LiveMascot";
import { CuteIcon } from "../../components/icons";
import { Sidebar, useSidebar } from "../../components/Sidebar";
import { CreateAgentSheet, type CreateTarget } from "../../components/CreateAgentSheet";
import { allAgents, useLive, useSettings } from "../../lib/store";
import { agentSpace, agentTitle, greeting } from "../../lib/format";
import { harnessLook } from "../../lib/harness";
import { pingNow } from "../../lib/relay";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space, statusColors } from "../../theme/tokens";

/** Round "+" FAB size; the list leaves this much room (plus margins) at its end. */
const FAB = 56;

/** Every agent is in exactly one group; all are listed, and a group folds when its header is tapped. */
type GroupKey = "pinned" | "blocked" | "working" | "done" | "idle" | "offline";
const GROUPS: { key: GroupKey; title: string }[] = [
  { key: "pinned", title: "置顶" },
  { key: "blocked", title: "需要你" },
  { key: "working", title: "工作中" },
  { key: "done", title: "已完成" },
  { key: "idle", title: "空闲" },
  { key: "offline", title: "离线" },
];

const byRecent = (x: Agent, y: Agent) => (y.statusSince ?? y.updatedAt) - (x.statusSince ?? x.updatedAt);

/** Compact single-row stat pills (需要你 / 工作中 / 已完成); tap one to filter without eating half the screen. */
function StatRow({ counts, active, onPick }: { counts: Record<AgentStatus, number>; active: AgentStatus | null; onPick: (s: AgentStatus | null) => void }) {
  const p = usePalette();
  const items: { s: AgentStatus; label: string }[] = [
    { s: "blocked", label: "需要你" },
    { s: "working", label: "工作中" },
    { s: "done", label: "已完成" },
  ];
  return (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      {items.map(({ s, label }) => {
        const c = statusColors(s, p.dark);
        const on = active === s;
        return (
          <Pressable
            key={s}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${label} ${counts[s]} 个，点按${on ? "取消" : ""}筛选`}
            onPress={() => onPick(on ? null : s)}
            style={{
              flex: 1,
              minHeight: 48,
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
              borderRadius: radius.card,
              backgroundColor: c.bg,
              borderWidth: 2,
              borderColor: on ? c.fg : "transparent",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 4,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
              <CuteIcon name={s === "blocked" ? "blocked" : s === "working" ? "working" : "done"} size={15} color={c.fg} fill={p.dark ? "transparent" : "#FFFFFF"} strokeWidth={2.3} />
              <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 12.5, color: c.fg, flexShrink: 1 }}>{label}</Text>
            </View>
            <Text style={{ fontFamily: fonts.cute, fontSize: 21, lineHeight: 26, color: c.fg }}>{counts[s]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Removable small tag showing an active sidebar filter. */
function FilterTag({ label, lead, onClear }: { label: string; lead?: React.ReactNode; onClear: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`筛选：${label}，点按取消`}
      onPress={onClear}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingLeft: lead ? 6 : 12, paddingRight: 8, borderRadius: radius.pill, backgroundColor: p.accentContainer }}
    >
      {lead}
      <Text numberOfLines={1} style={{ maxWidth: 160, color: p.ink, fontFamily: fonts.bodyBold, fontSize: 13 }}>
        {label}
      </Text>
      <CuteIcon name="close" size={14} color={p.accentText} strokeWidth={2.6} />
    </Pressable>
  );
}

export default function AgentsHub() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { host } = useLocalSearchParams<{ host?: string }>();
  const agentsByHost = useLive((s) => s.agents);
  const devices = useLive((s) => s.devices);
  const link = useLive((s) => s.link);
  const showShellsDefault = useSettings((s) => s.showShells);
  const hostFilterSaved = useSettings((s) => s.hostFilter);
  const foldedGroups = useSettings((s) => s.foldedGroups);
  const pinnedAgents = useSettings((s) => s.pinnedAgents);
  const setSettings = useSettings((s) => s.set);
  const sidebar = useSidebar();
  const navigation = useNavigation();
  // The sidebar is a full-height overlay: hide the tab bar while it is open.
  useEffect(() => {
    navigation.setOptions({ tabBarStyle: { borderTopWidth: 0, backgroundColor: p.surface, elevation: 0, display: sidebar.open ? "none" : "flex" } });
  }, [navigation, sidebar.open, p.surface]);

  const [filter, setFilter] = useState<AgentStatus | null>(null);
  const [spaceFilter, setSpaceFilter] = useState<string | null>(null);
  const [writableOnly, setWritableOnly] = useState(false);
  const [harnessFilter, setHarnessFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [showShells, setShowShells] = useState(showShellsDefault);
  const [refreshing, setRefreshing] = useState(false);
  const [create, setCreate] = useState<CreateTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // "Show this computer" from the devices tab arrives as ?host=; store it as the remembered choice.
  useEffect(() => {
    if (host) {
      setSettings({ hostFilter: host });
      router.setParams({ host: undefined });
    }
  }, [host, setSettings]);

  const hosts = useMemo(() => {
    const list = Object.values(devices).filter((d) => d.kind === "host");
    for (const id of Object.keys(agentsByHost)) if (!devices[id]) list.push({ id, name: id, kind: "host", online: false, createdAt: 0, lastSeenAt: 0 });
    return list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [devices, agentsByHost]);
  const hostFilter = hostFilterSaved && hosts.some((h) => h.id === hostFilterSaved) ? hostFilterSaved : null;
  const isOnline = useCallback((a: Agent) => devices[a.deviceId]?.online ?? false, [devices]);

  const all = useMemo(() => allAgents(agentsByHost).filter((a) => showShells || !a.isShell), [agentsByHost, showShells]);
  const hostCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of all) m[a.deviceId] = (m[a.deviceId] ?? 0) + 1;
    return m;
  }, [all]);
  const onHost = useMemo(() => all.filter((a) => !hostFilter || a.deviceId === hostFilter), [all, hostFilter]);
  const spaces = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of onHost) {
      const sp = agentSpace(a);
      if (sp) m.set(sp, (m.get(sp) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [onHost]);
  const activeSpace = spaceFilter && spaces.some(([s]) => s === spaceFilter) ? spaceFilter : null;
  const inScope = useMemo(() => onHost.filter((a) => !activeSpace || agentSpace(a) === activeSpace), [onHost, activeSpace]);

  const counts = useMemo(() => {
    const c: Record<AgentStatus, number> = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
    for (const a of inScope) if (isOnline(a)) c[effectiveAgentStatus(a)]++;
    return c;
  }, [inScope, isOnline]);

  const q = query.trim().toLowerCase();
  const harnesses = useMemo(
    () => [...new Set(inScope.map((a) => a.harness).filter(Boolean))].sort(),
    [inScope],
  );
  const activeHarness = harnessFilter && harnesses.includes(harnessFilter) ? harnessFilter : null;
  const pinnedSet = useMemo(() => new Set(pinnedAgents), [pinnedAgents]);
  const togglePin = useCallback(
    (a: Agent) => {
      Haptics.selectionAsync().catch(() => undefined);
      const next = pinnedSet.has(a.key) ? pinnedAgents.filter((k) => k !== a.key) : [a.key, ...pinnedAgents.slice(0, 29)];
      setSettings({ pinnedAgents: next });
      setToast(pinnedSet.has(a.key) ? `已取消置顶「${agentTitle(a)}」` : `已置顶「${agentTitle(a)}」`);
    },
    [pinnedAgents, pinnedSet, setSettings],
  );
  const match = useCallback(
    (a: Agent) =>
      (!writableOnly || a.canSend !== false) &&
      (!activeHarness || a.harness === activeHarness) &&
      (!q || [agentTitle(a), a.harness, a.harness === "antigravity" ? "反重力" : undefined, a.where, a.cwd, a.preview, a.statusNote].some((s) => s?.toLowerCase().includes(q))),
    [activeHarness, q, writableOnly],
  );

  const sections = useMemo(() => {
    const by: Record<GroupKey, Agent[]> = { pinned: [], blocked: [], working: [], done: [], idle: [], offline: [] };
    for (const a of inScope) {
      if (!match(a)) continue;
      if (!filter && pinnedSet.has(a.key)) {
        by.pinned.push(a);
        continue;
      }
      const eff = effectiveAgentStatus(a);
      const g: GroupKey = !isOnline(a) ? "offline" : eff === "blocked" || eff === "working" || eff === "done" ? eff : "idle";
      by[g].push(a);
    }
    return GROUPS.filter((g) => by[g.key].length && (!filter || g.key === filter)).map((g) => {
      // A search or a picked status always shows what it found; folding is for browsing.
      const folded = !q && !filter && foldedGroups.includes(g.key);
      return { key: g.key, title: g.title, count: by[g.key].length, folded, data: folded ? [] : by[g.key].sort(byRecent) };
    });
  }, [filter, foldedGroups, inScope, isOnline, match, pinnedSet, q]);

  const toggleGroup = useCallback(
    (key: GroupKey) => setSettings({ foldedGroups: foldedGroups.includes(key) ? foldedGroups.filter((k) => k !== key) : [...foldedGroups, key] }),
    [foldedGroups, setSettings],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    pingNow();
    setTimeout(() => setRefreshing(false), 700);
  }, []);

  const multiHost = hosts.length > 1 && !hostFilter;
  const legacySessionHosts = useMemo(
    () => hosts.filter((h) => h.online && h.sources?.includes("runtime-sessions") && !all.some((a) => a.deviceId === h.id && a.source === "runtime")),
    [hosts, all],
  );
  const canCreateOnAnyHost = useMemo(
    () => hosts.some((h) => h.online && (h.sources?.includes("hc") || h.sources?.includes("runtime-create"))),
    [hosts],
  );
  const allDone = counts.blocked === 0 && counts.working === 0 && counts.done > 0;
  const headline = counts.blocked ? `有 ${counts.blocked} 个 agent 在等你` : counts.working ? `${counts.working} 个 agent 正在忙` : allDone ? "大家都忙完啦" : "大家都歇着呢";
  const hostName = hostFilter ? hosts.find((h) => h.id === hostFilter)?.name ?? "这台电脑" : null;

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.xs }}>
      {/* Raised so the mascot's speech bubble draws over the stat cards below. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, zIndex: 5, elevation: 5 }}>
        <IconTile icon="menu" tone="plain" size={40} onPress={sidebar.show} a11y="打开侧栏：电脑和空间" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontFamily: fonts.cute, fontSize: 24, lineHeight: 32, color: p.ink }}>{greeting()}</Text>
          <Text numberOfLines={1} style={{ color: p.muted, fontSize: 13.5 }}>
            {headline}
          </Text>
        </View>
        <IconTile icon="search" tone="plain" size={40} active={searching} onPress={() => setSearching((v) => !v)} a11y="搜索" />
        <IconTile icon="terminal" tone="plain" size={40} active={showShells} onPress={() => setShowShells((v) => !v)} a11y={showShells ? "隐藏普通终端" : "显示普通终端"} />
        <LiveMascot counts={counts} mood={allDone ? "yay" : counts.blocked ? "waiting" : "hello"} size={64} onLongPress={() => router.navigate("/")} />
      </View>

      <StatRow counts={counts} active={filter} onPick={setFilter} />

      {harnesses.length > 0 || inScope.some((a) => a.canSend === false) ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {inScope.some((a) => a.canSend === false) ? (
            <Pressable
              onPress={() => setWritableOnly((v) => !v)}
              style={({ pressed }) => ({
                paddingHorizontal: 10,
                minHeight: 28,
                justifyContent: "center",
                borderRadius: radius.pill,
                backgroundColor: writableOnly ? p.primary : pressed ? p.surface3 : p.surface,
                borderWidth: 1,
                borderColor: writableOnly ? p.primary : p.divider,
              })}
            >
              <Text style={{ fontSize: 12, fontFamily: fonts.bodySemi, color: writableOnly ? p.onPrimary : p.muted }}>仅看可回复</Text>
            </Pressable>
          ) : null}
          {harnesses.length > 1
            ? harnesses.map((h) => {
                const on = activeHarness === h;
                return (
                  <Pressable
                    key={h}
                    onPress={() => setHarnessFilter(on ? null : h)}
                    style={({ pressed }) => ({
                      paddingHorizontal: 10,
                      minHeight: 28,
                      justifyContent: "center",
                      borderRadius: radius.pill,
                      backgroundColor: on ? p.accentContainer : pressed ? p.surface3 : p.surface,
                      borderWidth: 1,
                      borderColor: on ? p.accentText : p.divider,
                    })}
                  >
                    <Text style={{ fontSize: 12, fontFamily: fonts.bodySemi, color: on ? p.accentText : p.muted }}>
                      {harnessLook(h, false).label}
                    </Text>
                  </Pressable>
                );
              })
            : null}
        </ScrollView>
      ) : null}

      {legacySessionHosts.length > 0 ? (
        <Card flat style={{ padding: space.md, gap: space.xs }}>
          <Text style={{ color: p.ink, fontFamily: fonts.bodyBold, fontSize: 13.5 }}>项目会话 · DSH / Codex / Antigravity</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            {legacySessionHosts.map((h) => (
              <Button key={h.id} mode="contained-tonal" compact icon="folder-open-outline" onPress={() => router.navigate({ pathname: "/devices", params: { openHost: h.id } })}>
                {h.name}
              </Button>
            ))}
          </View>
        </Card>
      ) : null}

      {hostName || activeSpace ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {hostName ? <FilterTag label={hostName} lead={<View style={{ marginLeft: 4 }}><CuteIcon name="laptop" size={16} color={p.ink} fill={p.surface} /></View>} onClear={() => setSettings({ hostFilter: null })} /> : null}
          {activeSpace ? <FilterTag label={activeSpace} lead={<SpaceBadge name={activeSpace} size={22} />} onClear={() => setSpaceFilter(null)} /> : null}
        </View>
      ) : null}
      {searching ? (
        <Searchbar
          autoFocus
          placeholder="搜标题、项目、目录"
          value={query}
          onChangeText={setQuery}
          style={{ backgroundColor: p.surface, borderRadius: radius.pill, elevation: 0, height: 46 }}
          inputStyle={{ minHeight: 46, fontSize: 15 }}
        />
      ) : null}
    </View>
  );

  const empty =
    link !== "online" ? (
      <EmptyState mood="sleepy" title="还在连服务器" body="连上以后，各台电脑上的 agent 会出现在这里。" />
    ) : hosts.length === 0 ? (
      <EmptyState mood="sleepy" title="还没有电脑加入" body="在电脑上运行 xiaoaixiaoai up，再到“设备”页点“扫一扫”扫它显示的二维码。" />
    ) : (
      <EmptyState
        mood="sleepy"
        title={filter || q ? "这里空空的" : "还没有 agent"}
        body={filter || q ? "换个筛选条件试试。" : canCreateOnAnyHost ? "点右下角的加号新建一个。" : "连接的电脑上暂时没有活跃会话，在电脑上打开 DSH、Codex 或 Antigravity 后会自动出现在这里。"}
      />
    );

  return (
    <PageBackground>
      <View style={{ paddingTop: insets.top + space.sm }}>
        <ConnectionBanner />
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(a) => a.key}
        renderItem={({ item }) => (
          <AgentRow
            agent={item}
            offline={!isOnline(item)}
            deviceName={multiHost ? devices[item.deviceId]?.name : undefined}
            pinned={pinnedSet.has(item.key)}
            onLongPress={() => togglePin(item)}
          />
        )}
        renderSectionHeader={({ section }) => {
          // Search and status filters ignore folding, so the header is a plain label there.
          const canFold = !q && !filter;
          return (
            <Pressable
              disabled={!canFold}
              accessibilityRole={canFold ? "button" : "header"}
              accessibilityState={canFold ? { expanded: !section.folded } : undefined}
              accessibilityLabel={`${section.title} ${section.count} 个${canFold ? `，点按${section.folded ? "展开" : "收起"}` : ""}`}
              onPress={() => toggleGroup(section.key)}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 44, marginTop: space.sm, paddingHorizontal: space.xs, borderRadius: radius.card, backgroundColor: pressed ? p.surface3 : "transparent" })}
            >
              <Text style={{ fontFamily: fonts.bodyBold, color: p.muted, fontSize: 14 }}>{section.title}</Text>
              <Text style={{ flex: 1, fontFamily: fonts.bodyBold, color: p.faint, fontSize: 13 }}>{section.count}</Text>
              {canFold ? <CuteIcon name={section.folded ? "chevronRight" : "chevronDown"} size={18} color={p.faint} /> : null}
            </Pressable>
          );
        }}
        renderSectionFooter={() => <View style={{ height: space.xs }} />}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: (canCreateOnAnyHost ? FAB : 0) + space.lg * 2, paddingTop: space.sm }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[p.primary]} />}
        keyboardShouldPersistTaps="handled"
      />

      {/* New agent FAB (thumb zone, bottom right; shown only when a connected host supports herdr create). */}
      {canCreateOnAnyHost ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建 agent 或空间"
          onPress={() => setCreate({ host: hostFilter, spaceName: activeSpace })}
          style={({ pressed }) => ({
            position: "absolute",
            right: space.lg,
            bottom: space.lg,
            width: FAB,
            height: FAB,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: FAB / 2,
            backgroundColor: pressed ? p.primaryPressed : p.primary,
            transform: [{ scale: pressed ? 0.94 : 1 }],
            shadowColor: p.shadow,
            shadowOpacity: p.dark ? 0 : 0.3,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
            elevation: 4,
          })}
        >
          <CuteIcon name="plus" size={28} color={p.onPrimary} strokeWidth={2.8} />
        </Pressable>
      ) : null}

      <Sidebar
        s={sidebar}
        d={{
          hosts,
          hostCounts,
          allCount: all.length,
          hostFilter,
          onHost: (id) => setSettings({ hostFilter: id }),
          spaces,
          scopeCount: onHost.length,
          spaceFilter: activeSpace,
          onSpace: setSpaceFilter,
          onNewSpace: () => {
            sidebar.hide();
            setCreate({ host: hostFilter, spaceName: null });
          },
          onNewInSpace: (name) => {
            sidebar.hide();
            setCreate({ host: hostFilter, spaceName: name });
          },
        }}
      />
      <CreateAgentSheet visible={!!create} onDismiss={() => setCreate(null)} target={create ?? {}} hosts={hosts} />
      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={1800}>
        {toast ?? ""}
      </Snackbar>
    </PageBackground>
  );
}
