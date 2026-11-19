/**
 * Left sliding sidebar: computers and their
 * dynamically scoped Spaces, plus entries for devices and settings. Agent status
 * stays on the home page.
 * Built on RN Animated + PanResponder (no extra navigation dependency).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Animated, BackHandler, Easing, PanResponder, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Device } from "@xiaoaixiaoai/protocol";
import { SpaceBadge } from "./agents";
import { Mascot } from "./Mascot";
import { CuteIcon } from "./icons";
import { IconTile } from "./ui";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

export interface SidebarData {
  hosts: Device[];
  /** Agent count per host id (after the shells toggle). */
  hostCounts: Record<string, number>;
  /** Space counts are already scoped to the selected computer. */
  allCount: number;
  hostFilter: string | null;
  onHost: (id: string | null) => void;
  spaces: [string, number][];
  scopeCount: number;
  spaceFilter: string | null;
  onSpace: (name: string | null) => void;
  onNewSpace: () => void;
  onNewInSpace: (name: string) => void;
}

export function useSidebar() {
  const { width } = useWindowDimensions();
  const panelW = Math.min(340, Math.round(width * 0.86));
  const [x] = useState(() => new Animated.Value(-panelW));
  const [open, setOpen] = useState(false);
  const animate = useCallback((to: boolean) => {
    setOpen(to);
    Animated.timing(x, { toValue: to ? 0 : -panelW, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [x, panelW]);
  const settle = useCallback((dx: number, vx: number, fromOpen: boolean) => {
    const pos = (fromOpen ? 0 : -panelW) + dx;
    animate(vx > 0.3 || (vx > -0.3 && pos > -panelW / 2));
  }, [animate, panelW]);
  // Swipe right from the left edge to open.
  const edge = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dx > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => x.setValue(Math.min(0, -panelW + Math.max(0, g.dx))),
        onPanResponderRelease: (_e, g) => settle(g.dx, g.vx, false),
        onPanResponderTerminate: () => animate(false),
      }),
    [x, panelW, settle, animate],
  );
  // Swipe left on the open panel to close.
  const panel = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dx < -10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => x.setValue(Math.max(-panelW, Math.min(0, g.dx))),
        onPanResponderRelease: (_e, g) => settle(g.dx, g.vx, true),
        onPanResponderTerminate: () => animate(true),
      }),
    [x, panelW, settle, animate],
  );
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      animate(false);
      return true;
    });
    return () => sub.remove();
  }, [open, animate]);
  return { open, show: () => animate(true), hide: () => animate(false), x, panelW, edge, panel };
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ gap: 2, paddingTop: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingBottom: space.xs }}>
        <Text style={{ flex: 1, fontFamily: fonts.bodyBold, color: p.muted, fontSize: 12.5 }}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function Item({ on, onPress, lead, label, count, a11y, trailing }: { on?: boolean; onPress: () => void; lead: ReactNode; label: string; count?: number; a11y: string; trailing?: ReactNode }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      accessibilityLabel={a11y}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        minHeight: 46,
        marginHorizontal: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        backgroundColor: on ? p.accentContainer : pressed ? p.surface3 : "transparent",
      })}
    >
      <View style={{ width: 24, alignItems: "center" }}>{lead}</View>
      <Text numberOfLines={1} style={{ flex: 1, color: p.ink, fontFamily: on ? fonts.bodyBold : fonts.bodySemi, fontSize: 14.5 }}>
        {label}
      </Text>
      {count != null ? <Text style={{ color: on ? p.accentText : p.faint, fontFamily: fonts.bodyBold, fontSize: 13 }}>{count}</Text> : null}
      {trailing}
    </Pressable>
  );
}

/* Idle and completed agents stay on the home page; the sidebar is only computer → space navigation. */
/* QuietRow/Fold intentionally removed from the sidebar. */
/*
function QuietRow({ a, offline, onOpen }: { a: Agent; offline?: boolean; onOpen: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${spacedTitle(a)}，${offline ? "电脑离线" : agentStatusLabel(a)}`}
      onPress={onOpen}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 50, marginHorizontal: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: pressed ? p.surface3 : "transparent" })}
    >
      <HarnessAvatar harness={a.harness} isShell={a.isShell} size={30} dim={offline} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={{ color: offline ? p.muted : p.ink, fontFamily: fonts.bodySemi, fontSize: 14 }}>
          {spacedTitle(a)}
        </Text>
        <Text numberOfLines={1} style={{ color: p.faint, fontSize: 12 }}>
          {offline ? "电脑离线" : agentStatusLabel(a)} · {relTime(a.statusSince ?? a.updatedAt)}
        </Text>
      </View>
    </Pressable>
  );
}

function Fold({ title, count, children, initial = false }: { title: string; count: number; children: ReactNode; initial?: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(initial);
  if (!count) return null;
  return (
    <View style={{ paddingTop: space.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title} ${count} 个，${open ? "点按收起" : "点按展开"}`}
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 40, paddingHorizontal: space.lg }}
      >
        <MaterialCommunityIcons name={open ? "chevron-down" : "chevron-right"} size={18} color={p.muted} />
        <Text style={{ fontFamily: fonts.bodyBold, color: p.muted, fontSize: 12.5 }}>{title}</Text>
        <Text style={{ fontFamily: fonts.bodyBold, color: p.faint, fontSize: 12.5 }}>{count}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}
*/

export function Sidebar({ s, d }: { s: ReturnType<typeof useSidebar>; d: SidebarData }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const scrim = s.x.interpolate({ inputRange: [-s.panelW, 0], outputRange: [0, 1], extrapolate: "clamp" });
  const dot = (online: boolean) => <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: online ? "#3FB68B" : p.faint }} />;
  const go = (fn: () => void) => {
    s.hide();
    fn();
  };
  return (
    <>
      {/* Edge strip for the open swipe (only while closed). */}
      {!s.open ? <View {...s.edge.panHandlers} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 22 }} /> : null}
      <Animated.View pointerEvents={s.open ? "auto" : "none"} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(30,26,38,0.38)", opacity: scrim }}>
        <Pressable accessibilityLabel="关闭侧栏" style={{ flex: 1 }} onPress={s.hide} />
      </Animated.View>
      <Animated.View
        {...s.panel.panHandlers}
        accessibilityViewIsModal={s.open}
        importantForAccessibility={s.open ? "yes" : "no-hide-descendants"}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: s.panelW,
          backgroundColor: p.surface,
          borderTopRightRadius: radius.xl,
          borderBottomRightRadius: radius.xl,
          transform: [{ translateX: s.x }],
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 16,
          elevation: 12,
        }}
      >
        <ScrollView contentContainerStyle={{ paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.lg }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg }}>
            <Mascot mood="default" size={44} />
            <Text style={{ flex: 1, fontFamily: fonts.cute, fontSize: 21, color: p.ink }}>小爱小爱</Text>
            <IconTile icon="back" tone="plain" size={40} onPress={s.hide} a11y="关闭侧栏" />
          </View>

          <Section title="电脑">
            <Item on={!d.hostFilter} onPress={() => d.onHost(null)} lead={<CuteIcon name="screens" size={20} color={p.ink} fill={p.accentContainer} />} label="全部电脑" count={d.allCount} a11y={`全部电脑，${d.allCount} 个 agent`} />
            {d.hosts.map((h) => (
              <Item
                key={h.id}
                on={d.hostFilter === h.id}
                onPress={() => d.onHost(d.hostFilter === h.id ? null : h.id)}
                lead={dot(h.online)}
                label={h.name}
                count={d.hostCounts[h.id] ?? 0}
                a11y={`${h.name}，${h.online ? "在线" : "离线"}，${d.hostCounts[h.id] ?? 0} 个 agent`}
              />
            ))}
          </Section>

          {
            <Section
              title="空间"
              right={
                <Pressable accessibilityRole="button" accessibilityLabel="新建空间" onPress={d.onNewSpace} hitSlop={6} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 2, minHeight: 36, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: pressed ? p.surface3 : p.accentContainer })}>
                  <CuteIcon name="plus" size={15} color={p.accentText} strokeWidth={2.6} />
                  <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>新建空间</Text>
                </Pressable>
              }
            >
              <Item on={!d.spaceFilter} onPress={() => d.onSpace(null)} lead={<CuteIcon name="grid" size={20} color={p.ink} fill={p.accentContainer} />} label="全部空间" count={d.scopeCount} a11y={`全部空间，${d.scopeCount} 个 agent`} />
              {d.spaces.map(([name, n]) => (
                <Item
                  key={name}
                  on={d.spaceFilter === name}
                  onPress={() => d.onSpace(d.spaceFilter === name ? null : name)}
                  lead={<SpaceBadge name={name} size={22} />}
                  label={name}
                  count={n}
                  a11y={`空间 ${name}，${n} 个 agent`}
                  trailing={
                    <Pressable accessibilityRole="button" accessibilityLabel={`在 ${name} 新建 agent`} onPress={() => d.onNewInSpace(name)} hitSlop={6} style={({ pressed }) => ({ width: 36, height: 36, marginRight: -6, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : "transparent" })}>
                      <CuteIcon name="plus" size={17} color={p.muted} strokeWidth={2.4} />
                    </Pressable>
                  }
                />
              ))}
            </Section>
          }

          <View style={{ height: 1, backgroundColor: p.divider, marginHorizontal: space.lg, marginTop: space.lg }} />
          <View style={{ paddingTop: space.sm }}>
            <Item onPress={() => go(() => router.navigate("/devices"))} lead={<CuteIcon name="laptop" size={20} color={p.ink} fill={p.accentContainer} />} label="设备" a11y="设备" />
            <Item onPress={() => go(() => router.navigate("/settings"))} lead={<CuteIcon name="gear" size={20} color={p.ink} fill={p.accentContainer} />} label="设置" a11y="设置" />
          </View>
        </ScrollView>
      </Animated.View>
    </>
  );
}
