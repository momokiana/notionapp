import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Image, Pressable, ScrollView, TextInput as RNTextInput, View, type TextStyle } from "react-native";
import { ActivityIndicator, Button, Checkbox, Dialog, IconButton, List, Portal, ProgressBar, Snackbar, Text } from "react-native-paper";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PUT_LIMITS, RUNTIME_SESSION_TEXT_LIMIT, type Agent, type TerminalStreamParams } from "@xiaoaixiaoai/protocol";
import { call, subscribe, type RelayError } from "../lib/relay";
import { addPictures, canPickImages, pickImages, type Attachment } from "../lib/attach";
import { onQueueEvent, sendOut } from "../lib/outbox";
import { chunks, typingDiff } from "../lib/typing";
import { useLive, usePending, useSettings } from "../lib/store";
import { normalizeTermKeyLayout, TERM_KEYS, visibleTermKeys } from "../lib/termkeys";
import { compactNum, money, quotaWindowText, relTime, shortPath } from "../lib/format";
import { TERM_BG, TERM_FG } from "../lib/ansi";
import { TermScreen, type ScreenView, type ShownRow } from "../lib/termscreen";
import { harnessLook } from "../lib/harness";
import { parseChoices, type Choice } from "../lib/choices";
import { formatQuotedMessage, type ReplyQuote } from "../lib/quote";
import { usePalette } from "../theme/theme";
import { agentStatusLabel, fonts, radius, space, statusColors } from "../theme/tokens";
import { QuoteComposerBanner } from "./quote-ui";
import { RuntimeQuestionPrompt } from "./RuntimeQuestionPrompt";
import { TermKeyboard } from "./TermKeyboard";
import { EmptyState, IconTile, SendPill } from "./ui";

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const TERM_PAD = 12;
const READ_SIZE = 12.5;

/** Per-font-size cell metrics, measured once from the real fonts (mono cell, CJK fallback glyph). */
function useCellMetrics() {
  const [m, setM] = useState<{ cell: number; cjk: number } | null>(null);
  const probe = (
    <View pointerEvents="none" style={{ position: "absolute", opacity: 0, left: -9999, top: 0 }}>
      <ScrollView horizontal>
        <View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 20 }} onTextLayout={(e) => setM((x) => ({ cjk: x?.cjk ?? 20, cell: (e.nativeEvent.lines[0]?.width ?? 120) / 10 / 20 }))}>
            MMMMMMMMMM
          </Text>
          <Text style={{ fontFamily: fonts.mono, fontSize: 20 }} onTextLayout={(e) => setM((x) => ({ cell: x?.cell ?? 0.6, cjk: (e.nativeEvent.lines[0]?.width ?? 200) / 10 / 20 }))}>
            中中中中中中中中中中
          </Text>
        </View>
      </ScrollView>
    </View>
  );
  // Ratios per 1pt of font size; fall back to Maple Mono-ish values until measured.
  return { cellRatio: m?.cell ?? 0.6, cjkRatio: m?.cjk ?? 1, probe };
}

/** Queue notices ride every terminal stream; the open terminal hands them to the message box. */
const queueListeners = new Map<string, Set<(event: any) => void>>();
function onQueue(agentKey: string, fn: (event: any) => void): () => void {
  const set = queueListeners.get(agentKey) ?? new Set();
  queueListeners.set(agentKey, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) queueListeners.delete(agentKey);
  };
}

/** One terminal line. Rendered again only when its own content (or the font) changes. */
const TermRow = memo(function TermRow({ row, style, wideGap }: { row: ShownRow; style: TextStyle; wideGap: number }) {
  return (
    <Text selectable style={style}>
      {row.runs.map((r, j) => (
        <Text
          key={j}
          style={{
            color: r.fg,
            backgroundColor: r.bg,
            fontFamily: r.bold ? fonts.monoBold : fonts.mono,
            fontStyle: r.italic ? "italic" : "normal",
            textDecorationLine: r.underline ? "underline" : "none",
            letterSpacing: r.wide ? wideGap : 0,
          }}
        >
          {r.text}
        </Text>
      ))}
    </Text>
  );
});

/** Lines keyed by an id that moves with them, so a scroll mounts the new lines and moves the rest. */
const TermRows = memo(function TermRows({ view, style, wideGap }: { view: ScreenView; style: TextStyle; wideGap: number }) {
  return (
    <View>
      {view.rows.map((r) => (
        <TermRow key={r.id} row={r.row} style={style} wideGap={wideGap} />
      ))}
    </View>
  );
});

type LiveState = "connecting" | "live" | "stale" | "error";

export function TerminalView({ agent, active }: { agent: Agent; active: boolean }) {
  const p = usePalette();
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [width, setWidth] = useState(0);
  const [modePick, setMode] = useState<"fit" | "read" | null>(null);
  const [zoom, setZoom] = useState(READ_SIZE);
  const [liveState, setLiveStateNow] = useState<LiveState>("connecting");
  const liveRef = useRef<LiveState>("connecting");
  const setLiveState = useCallback((s: LiveState) => {
    if (liveRef.current === s) return;
    liveRef.current = s;
    setLiveStateNow(s);
  }, []);
  /** A screen came on the current stream. */
  const [gotLive, setGotLive] = useState(false);
  const gotLiveRef = useRef(false);
  /** The stream gave nothing for a while after subscribing. */
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const pinch = useRef<{ d: number; size: number } | null>(null);
  const busy = agent.status === "working" || agent.status === "blocked";
  const [screen] = useState(() => new TermScreen());
  const [view, setView] = useState<ScreenView | null>(null);
  const frame = useRef<number | null>(null);
  // However many paints arrive, the view renders at most once per display frame, with the latest.
  const show = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setView(screen.view());
    });
  }, [screen]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  // Polling is the recovery path: only while the stream is down or has not delivered yet.
  const poll = active && (liveState === "error" || liveState === "stale" || (!gotLive && slow));
  const q = useQuery({
    queryKey: ["terminal.read", agent.key],
    queryFn: () => call(agent.deviceId, "terminal.read", { agent: agent.key, lines: 120 }),
    enabled: poll,
    staleTime: 10_000,
    refetchInterval: poll ? (busy ? 5000 : 12000) : false,
    retry: 1,
  });
  useEffect(() => {
    // A polled (or cached) screen only while the stream has given nothing newer.
    if (!q.data || (gotLiveRef.current && liveRef.current === "live")) return;
    screen.screen(q.data);
    show();
  }, [q.data, screen, show]);
  useEffect(() => {
    if (!active) return;
    setLiveState("connecting");
    gotLiveRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A new external terminal subscription invalidates delivery state before its callbacks arrive.
    setGotLive(false);
    setSlow(false);
    screen.restart();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      retry ??= setTimeout(() => setAttempt((n) => n + 1), ms);
    };
    const slowTimer = setTimeout(() => setSlow(true), 1500);
    const got = () => {
      if (!gotLiveRef.current) {
        gotLiveRef.current = true;
        setGotLive(true);
      }
      setLiveState("live");
      show();
    };
    const params: TerminalStreamParams = { agent: agent.key, history: 120, rows: true };
    const stop = subscribe(
      agent.deviceId,
      "terminal",
      params,
      (event) => {
        if (event?.kind === "terminal_rows") {
          // A missed change: subscribe again, which starts with a whole screen.
          if (screen.rows(event)) got();
          else again(0);
        } else if (event?.kind === "terminal" && event.screen) {
          // Computers before row changes send the whole screen each time.
          screen.screen(event.screen);
          got();
        } else if (event?.kind === "stale") setLiveState("stale");
        else if (event?.kind === "queue") queueListeners.get(agent.key)?.forEach((fn) => fn(event));
      },
      (state) => {
        if (state.status === "open") {
          failures.current = 0;
          setLiveState("live");
        } else {
          // Refused or ended (the computer went away): poll meanwhile and try the stream again.
          setLiveState("error");
          again(Math.min(30_000, 3000 * 2 ** failures.current++));
        }
      },
    );
    // An unchanged screen sends nothing: silence is not a lost stream.
    return () => {
      clearTimeout(retry);
      clearTimeout(slowTimer);
      stop();
    };
  }, [active, agent.deviceId, agent.key, attempt, screen, show, setLiveState]);
  const linkOnline = useLive((s) => s.link === "online");
  const shown: LiveState = !linkOnline ? "stale" : liveState;
  const { cellRatio, cjkRatio, probe } = useCellMetrics();
  const cols = Math.max(view?.cols ?? 0, view?.widest ?? 0, 20);
  // Wide terminals (e.g. 191 cols) are unreadable when squeezed: default to readable size + horizontal scroll.
  const mode = modePick ?? (cols <= 100 ? "fit" : "read");
  const fitSize = width ? Math.max(5, Math.min(16, (width - TERM_PAD * 2) / (cols * cellRatio))) : READ_SIZE;
  const fontSize = mode === "fit" ? fitSize : zoom;
  const cellW = fontSize * cellRatio;
  // Wide chars render in the system CJK font; pad each to exactly two mono cells.
  const wideGap = 2 * cellW - fontSize * cjkRatio;
  const lineHeight = Math.round(fontSize * 1.38);
  const rowStyle = useMemo<TextStyle>(() => ({ fontFamily: fonts.mono, fontSize, lineHeight, height: lineHeight, color: TERM_FG }), [fontSize, lineHeight]);

  useEffect(() => {
    if (follow) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: false }));
  }, [follow, fontSize]);

  if (!view && q.isError) {
    return <EmptyState mood="waiting" title="终端画面没拿到" body={(q.error as Error).message} action={<Button textColor={p.accentText} onPress={() => q.refetch()}>再试一次</Button>} />;
  }
  if (!view) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm }}>
        <ActivityIndicator />
        <Text style={{ color: p.faint, fontSize: 12 }}>正在接收终端画面…</Text>
      </View>
    );
  }
  const empty = view.rows.length === 0;
  return (
    <View
      style={{ flex: 1, marginHorizontal: space.lg, marginTop: space.md, marginBottom: space.sm, borderRadius: radius.card, backgroundColor: TERM_BG, overflow: "hidden" }}
      onTouchStart={(e) => {
        const t = e.nativeEvent.touches;
        if (t.length === 2) pinch.current = { d: Math.hypot(t[0]!.pageX - t[1]!.pageX, t[0]!.pageY - t[1]!.pageY), size: fontSize };
      }}
      onTouchMove={(e) => {
        const t = e.nativeEvent.touches;
        if (t.length !== 2 || !pinch.current) return;
        const d = Math.hypot(t[0]!.pageX - t[1]!.pageX, t[0]!.pageY - t[1]!.pageY);
        const next = Math.round(Math.max(5, Math.min(22, (pinch.current.size * d) / pinch.current.d)) * 2) / 2;
        if (next !== zoom || mode !== "read") {
          setMode("read");
          setZoom(next);
        }
      }}
      onTouchEnd={(e) => {
        if (e.nativeEvent.touches.length < 2) pinch.current = null;
      }}
    >
      {probe}
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: space.lg, paddingRight: space.xs, minHeight: 44, backgroundColor: "#211B2C" }}>
        <Text style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: "#CFC5DA" }} numberOfLines={1}>
          {agent.localId} · {agent.where ?? agent.harness}
          {view.cols ? `  ${view.cols}×${view.height ?? view.rows.length}` : ""}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 4 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: shown === "live" ? "#5ED6A7" : shown === "stale" ? "#F0B85A" : "#E9819E" }} />
          <Text style={{ color: "#CFC5DA", fontSize: 10 }}>{shown === "live" ? "实时" : shown === "stale" ? "重连中" : shown === "connecting" ? "连接中" : "轮询"}</Text>
        </View>
        {q.isFetching ? <ActivityIndicator size={12} color="#CFC5DA" style={{ marginRight: 8 }} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mode === "fit" ? "切换到正常字号，可以左右滑动" : "切换到适应宽度"}
          onPress={() => {
            if (mode === "fit") {
              setZoom(READ_SIZE);
              setMode("read");
            } else setMode("fit");
          }}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 36, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: pressed ? "#3A3148" : "#2C2439" })}
        >
          <MaterialCommunityIcons name={mode === "fit" ? "arrow-expand-horizontal" : "format-size"} size={15} color="#EDE6F3" />
          <Text style={{ color: "#EDE6F3", fontSize: 12, fontFamily: fonts.bodySemi }}>{mode === "fit" ? "适应宽度" : `${fontSize} 号字`}</Text>
        </Pressable>
        <IconButton
          icon={copied ? "check" : "content-copy"}
          size={18}
          iconColor="#EDE6F3"
          accessibilityLabel="复制终端内容"
          onPress={async () => {
            await Clipboard.setStringAsync(screen.plain());
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        />
      </View>
      <ScrollView
        ref={scroller}
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          // A keyboard opening below shrinks the screen: keep the newest lines in view.
          if (follow) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: false }));
        }}
        // Only when the content grows or shrinks: a scroll of a full history keeps its height and stays at the bottom.
        onContentSizeChange={() => {
          if (follow) scroller.current?.scrollToEnd({ animated: false });
        }}
        onScrollBeginDrag={() => setFollow(false)}
        onMomentumScrollEnd={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          setFollow(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
        }}
        contentContainerStyle={{ paddingVertical: TERM_PAD }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={mode !== "fit"} contentContainerStyle={{ paddingHorizontal: TERM_PAD }}>
          {empty ? <Text style={rowStyle}>（屏幕是空的）</Text> : <TermRows view={view} style={rowStyle} wideGap={wideGap} />}
        </ScrollView>
      </ScrollView>
      {!follow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="跳到最新"
          onPress={() => setFollow(true)}
          style={{ position: "absolute", right: space.md, bottom: space.md, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: p.lavenderContainer, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 40 }}
        >
          <MaterialCommunityIcons name="arrow-collapse-down" size={16} color={p.onLavender} />
          <Text style={{ fontFamily: fonts.bodyBold, color: p.onLavender, fontSize: 13.5 }}>到最新</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Waiting card (docked above the composer when the agent is blocked)
// ---------------------------------------------------------------------------

/**
 * Last lines on the agent's screen, so the question it is asking can be read
 * without leaving the chat, and the options it offers (`parseChoices`).
 */
function useScreenTail(agent: Agent, enabled: boolean, lines = 7): { tail: string[]; choices: Choice[] } {
  const q = useQuery({
    queryKey: ["terminal.tail", agent.key],
    queryFn: () => call(agent.deviceId, "terminal.read", { agent: agent.key, lines: 40 }),
    enabled,
    refetchInterval: enabled ? 4000 : false,
    retry: false,
  });
  return useMemo(() => {
    const all = (q.data?.text ?? "").split("\n").map((l) => l.replace(/\s+$/, ""));
    while (all.length && !all[all.length - 1]!.trim()) all.pop();
    const choices = parseChoices(all);
    return { tail: all.filter((l, i) => l.trim() || (i > 0 && all[i - 1]!.trim())).slice(-lines), choices };
  }, [q.data?.text, lines]);
}

function WaitingCard({
  agent,
  onKey,
  onRetry,
  busy,
  compact,
  onOpenTerminal,
}: {
  agent: Agent;
  onKey: (key: string) => void;
  onRetry: () => void;
  busy: boolean;
  compact: boolean;
  onOpenTerminal?: () => void;
}) {
  const p = usePalette();
  const c = statusColors("blocked", p.dark);
  // Read even beside the terminal: the options decide which keys the buttons press.
  const { tail, choices } = useScreenTail(agent, !agent.errored);
  if (agent.errored) {
    // Stopped on an error, not on a question: y / n mean nothing to it.
    return (
      <View accessibilityLiveRegion="polite" style={{ marginHorizontal: space.lg, marginBottom: space.sm, backgroundColor: c.bg, borderRadius: radius.card, padding: space.md, gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <MaterialCommunityIcons name="alert-circle-outline" size={18} color={c.fg} />
          <Text style={{ flex: 1, fontFamily: fonts.cute, fontSize: 16, color: c.fg }}>它出错停下了</Text>
        </View>
        {agent.statusNote ? (
          <Text selectable numberOfLines={compact ? 2 : 6} style={{ fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: p.ink }}>
            {agent.statusNote}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Pressable
            disabled={busy}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="让它继续：发送“继续”"
            style={({ pressed }) => ({ flex: 1, minHeight: 40, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.accentText : p.primary, opacity: busy ? 0.5 : 1 })}
          >
            <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.onPrimary }}>让它继续</Text>
          </Pressable>
          {!compact && onOpenTerminal ? (
            <Pressable
              onPress={onOpenTerminal}
              accessibilityRole="button"
              style={({ pressed }) => ({ flex: 1, minHeight: 40, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : p.surface })}
            >
              <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.ink }}>看终端</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }
  const choice = (o: Choice) => (
    <Pressable
      key={o.key}
      disabled={busy}
      onPress={() => onKey(o.key)}
      accessibilityRole="button"
      accessibilityLabel={`选第 ${o.key} 项：${o.label}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 40,
        paddingHorizontal: space.md,
        paddingVertical: 6,
        borderRadius: radius.md,
        backgroundColor: pressed ? (o.selected ? p.accentText : p.surface3) : o.selected ? p.primary : p.surface,
        opacity: busy ? 0.5 : 1,
      })}
    >
      <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13, color: o.selected ? p.onPrimary : c.fg, minWidth: 14 }}>{o.key}</Text>
      <Text numberOfLines={2} style={{ flex: 1, fontFamily: fonts.bodySemi, fontSize: 13.5, color: o.selected ? p.onPrimary : p.ink }}>
        {o.label}
      </Text>
    </Pressable>
  );
  const answer = (label: string, key: string, a11y: string, primary = false) => (
    <Pressable
      key={key}
      disabled={busy}
      onPress={() => onKey(key)}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 40,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary ? (pressed ? p.accentText : p.primary) : pressed ? p.surface3 : p.surface,
        opacity: busy ? 0.5 : 1,
      })}
    >
      <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: primary ? p.onPrimary : p.ink }}>{label}</Text>
    </Pressable>
  );
  return (
    <View accessibilityLiveRegion="polite" style={{ marginHorizontal: space.lg, marginBottom: space.sm, backgroundColor: c.bg, borderRadius: radius.card, padding: space.md, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <MaterialCommunityIcons name="hand-wave-outline" size={18} color={c.fg} />
        <Text style={{ flex: 1, fontFamily: fonts.cute, fontSize: 16, color: c.fg }}>它在等你回复</Text>
        {!compact && onOpenTerminal ? (
          <Pressable hitSlop={8} accessibilityRole="button" onPress={onOpenTerminal}>
            <Text style={{ color: c.fg, fontFamily: fonts.bodySemi, fontSize: 12.5 }}>看终端</Text>
          </Pressable>
        ) : null}
      </View>
      {agent.statusNote ? (
        <Text selectable style={{ fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: p.ink }}>
          {agent.statusNote}
        </Text>
      ) : null}
      {!compact && tail.length && !choices.length ? (
        <Pressable accessibilityLabel="它屏幕上最后几行，点按去终端" onPress={onOpenTerminal} style={{ backgroundColor: TERM_BG, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm }}>
          {tail.map((l, i) => (
            <Text key={i} numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: TERM_FG }}>
              {l || " "}
            </Text>
          ))}
        </Pressable>
      ) : null}
      {choices.length ? (
        <View style={{ gap: 6 }}>
          {choices.slice(0, compact ? 4 : 9).map(choice)}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            {answer("回车", "enter", "按回车选高亮的那项")}
            {answer("Esc", "esc", "按 Esc 取消")}
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          {answer("是 y", "y", `同意，发送 y 给 ${agent.harness}`, true)}
          {answer("否 n", "n", "拒绝，发送 n")}
          {answer("回车", "enter", "按回车确认当前选项")}
          {answer("Esc", "esc", "按 Esc 取消")}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** Show / hide and reorder the accessory keys (saved). */
function KeyLayoutDialog({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const p = usePalette();
  const saved = useSettings((x) => x.termKeys);
  const set = useSettings((x) => x.set);
  const layout = normalizeTermKeyLayout(saved);
  const byId = new Map(TERM_KEYS.map((k) => [k.id, k]));
  const save = (order: string[], visible: string[]) => set({ termKeys: { order, visible: order.filter((id) => visible.includes(id)) } });
  const move = (idx: number, d: -1 | 1) => {
    const order = [...layout.order];
    const to = idx + d;
    if (to < 0 || to >= order.length) return;
    [order[idx], order[to]] = [order[to]!, order[idx]!];
    save(order, layout.visible);
  };
  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={{ borderRadius: radius.xl, backgroundColor: p.surface, maxHeight: "80%" }}>
        <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>调整按键</Dialog.Title>
        <Dialog.ScrollArea style={{ paddingHorizontal: 0 }}>
          <ScrollView>
            {layout.order.map((id, idx) => {
              const k = byId.get(id)!;
              const on = layout.visible.includes(id);
              return (
                <View key={id} style={{ flexDirection: "row", alignItems: "center", paddingLeft: space.lg, minHeight: 48 }}>
                  <Checkbox.Android
                    status={on ? "checked" : "unchecked"}
                    onPress={() => save(layout.order, on ? layout.visible.filter((x) => x !== id) : [...layout.visible, id])}
                    accessibilityLabel={`${on ? "隐藏" : "显示"} ${k.a11y}`}
                  />
                  <Text style={{ flex: 1, color: p.ink, fontFamily: k.mono ? fonts.mono : fonts.body, fontSize: 15 }}>{k.label}</Text>
                  <IconButton icon="chevron-up" size={20} disabled={idx === 0} onPress={() => move(idx, -1)} accessibilityLabel={`${k.a11y} 上移`} />
                  <IconButton icon="chevron-down" size={20} disabled={idx === layout.order.length - 1} onPress={() => move(idx, 1)} accessibilityLabel={`${k.a11y} 下移`} />
                </View>
              );
            })}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button textColor={p.ink} onPress={() => set({ termKeys: null })}>
            恢复默认
          </Button>
          <Button textColor={p.accentText} onPress={onDismiss}>
            好了
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

/**
 * Typing straight into the terminal: an invisible box holds the keyboard, and
 * every change goes to the terminal at once, so what is typed shows up on the
 * terminal screen itself. Hosts without `terminal.input` report `unsupported`.
 */
function useDirectTyping(agent: Agent, onError: (message: string, unsupported: boolean) => void) {
  const box = useRef<ComponentRef<typeof RNTextInput>>(null);
  const line = useRef("");
  const out = useRef({ queue: "", busy: false });
  const [on, setOn] = useState(false);

  async function flush() {
    const o = out.current;
    if (o.busy) return;
    o.busy = true;
    while (o.queue) {
      const data = o.queue;
      o.queue = "";
      try {
        for (const piece of chunks(data)) await call(agent.deviceId, "terminal.input", { agent: agent.key, data: piece });
      } catch (e) {
        o.queue = "";
        const err = e as RelayError;
        onError(err.message, err.code === "unsupported");
        if (err.code === "unsupported") box.current?.blur();
        break;
      }
    }
    o.busy = false;
  }
  function push(data: string) {
    if (!data) return;
    out.current.queue += data;
    void flush();
  }
  const input = (
    <RNTextInput
      ref={box}
      onChangeText={(v) => {
        push(typingDiff(line.current, v));
        line.current = v;
      }}
      onKeyPress={(e) => {
        // Deleting past what was typed here still reaches the terminal.
        if (e.nativeEvent.key === "Backspace" && line.current === "") push("\x7f");
      }}
      onSubmitEditing={() => {
        push("\r");
        line.current = "";
        box.current?.clear();
      }}
      submitBehavior="submit"
      onFocus={() => setOn(true)}
      onBlur={() => setOn(false)}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      caretHidden
      accessibilityLabel="直接输入到终端"
      style={{ position: "absolute", left: 0, bottom: 0, width: 1, height: 1, opacity: 0 }}
    />
  );
  const start = useCallback(() => {
    // The phone's own key panel may have typed in between: start the line afresh.
    line.current = "";
    box.current?.clear();
    box.current?.focus();
  }, []);
  const stop = useCallback(() => box.current?.blur(), []);
  return { on, input, start, stop, push };
}

/**
 * `chat`: a message box (keys behind a toggle). `terminal`: the key bar only, so the screen gets the room;
 * the keyboard button types straight into the terminal (older hosts: a one-line box).
 */
export function Composer({
  agent,
  bottomInset,
  mode,
  onOpenTerminal,
  quote,
  onClearQuote,
}: {
  agent: Agent;
  bottomInset: number;
  mode: "chat" | "terminal";
  onOpenTerminal?: () => void;
  quote?: ReplyQuote | null;
  onClearQuote?: () => void;
}) {
  const p = usePalette();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  /** Pictures to go with the next message (chat only). */
  const [pictures, setPictures] = useState<Attachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [extra, setExtra] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** The host cannot take direct typing: fall back to the one-line box. */
  const [boxOnly, setBoxOnly] = useState(false);
  /** The phone's own key panel is open (terminal only). */
  const [pad, setPad] = useState(false);
  const termInput = useSettings((x) => x.termInput);
  const setSettings = useSettings((x) => x.set);
  const direct = useDirectTyping(agent, (message, unsupported) => {
    if (unsupported) {
      setBoxOnly(true);
      setExtra(true);
      setPad(false);
      setToast("这台电脑的 hostd 还不支持直接打字，先用输入框发送");
    } else setToast(message);
  });
  // Switching between chat and terminal folds the extras and puts the keyboard away.
  const [shownMode, setShownMode] = useState(mode);
  if (shownMode !== mode) {
    setShownMode(mode);
    setExtra(false);
    setPad(false);
  }
  const stopDirect = direct.stop;
  useEffect(() => stopDirect, [mode, stopDirect]);
  const isRuntime = agent.source === "runtime";
  const online = useLive((s) => s.devices[agent.deviceId]?.online ?? false);
  const sessionQuery = useQuery({
    queryKey: ["session.events", agent.key, null],
    queryFn: () => call(agent.deviceId, "session.events", { agent: agent.key, limit: 60 }),
    enabled: isRuntime && online,
    staleTime: 2000,
  });
  const effectiveCanSend = isRuntime ? (sessionQuery.data?.canSend ?? agent.canSend) !== false : true;
  const effectiveReadOnlyReason = isRuntime ? (sessionQuery.data?.readOnlyReason ?? agent.readOnlyReason) : undefined;
  const pendingQuestions = isRuntime ? (sessionQuery.data?.pendingQuestions ?? []) : [];
  const showKeys = !isRuntime && (mode === "terminal" || extra);
  const showInput = isRuntime ? effectiveCanSend : mode === "chat" || (extra && boxOnly);
  /** A key press or "让它继续" on its way (messages go out on their own, see lib/outbox). */
  const [sending, setSending] = useState(false);
  /** This phone's messages that wait in the agent's input box: their bubbles say "排队中" already. */
  const mineWaiting = usePending((s) => (s.byAgent[agent.key] ?? []).filter((x) => x.state === "queued" && x.waiting && !x.echo).length);
  const textScale = useSettings((x) => x.textScale);
  const [tuning, setTuning] = useState(false);
  const termKeys = useSettings((x) => x.termKeys);
  const keys = useMemo(() => visibleTermKeys(normalizeTermKeyLayout(termKeys)), [termKeys]);
  const coral = statusColors("blocked", p.dark).fg;

  useEffect(() => {
    if (!online) return;
    // The computer's send queue moves the marks on the bubbles of messages sent from here.
    const onEvent = (event: any) => {
      if (event?.kind === "queue" && event.queueId) onQueueEvent(agent.key, event);
    };
    // The open terminal's stream carries them already; a second one would paint the whole screen again.
    if (mode === "terminal") return onQueue(agent.key, onEvent);
    // No screen needed. Computers before `screen: false` still send one; `history: 1` keeps it small
    // (they read a 0 as the default 120).
    const params: TerminalStreamParams = { agent: agent.key, screen: false, history: 1 };
    return subscribe(agent.deviceId, "terminal", params, onEvent);
  }, [agent.deviceId, agent.key, online, mode]);

  function refreshSoon() {
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: ["terminal.read", agent.key] });
      qc.invalidateQueries({ queryKey: ["session.events", agent.key] });
    }, 1000);
  }

  function send() {
    const t = text.trim();
    const pics = mode === "chat" ? pictures : [];
    if (!t && !pics.length) return;
    const activeQuote = mode === "chat" ? quote : null;
    const payload = activeQuote ? formatQuotedMessage(activeQuote, t) : t;
    // The message shows in the conversation at once, with its own state; the box is free for the next one.
    setText("");
    if (activeQuote) onClearQuote?.();
    if (pics.length) setPictures((cur) => cur.filter((x) => !pics.includes(x)));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    void sendOut(agent, payload, pics).then((r) => {
      if (r.ok) refreshSoon();
      // Beside the terminal there is no bubble to show the failure on.
      else if (mode === "terminal") setToast(r.message);
    });
  }

  async function attach() {
    if (!canPickImages()) return setToast("这个版本的 App 还不能选图片，更新 App 后再试");
    const room = PUT_LIMITS.files - pictures.length;
    if (room <= 0) return setToast(`一次最多发 ${PUT_LIMITS.files} 张图片`);
    setPicking(true);
    try {
      const picked = await pickImages(room);
      if (!picked.length) return;
      const r = addPictures(pictures, picked);
      setPictures(r.list);
      if (r.note) setToast(r.note);
    } catch (e) {
      setToast(`图片没读出来：${(e as Error).message}`);
    } finally {
      setPicking(false);
    }
  }

  async function press(key: string, haptic: "select" | "heavy" = "select") {
    if (haptic === "heavy") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    else Haptics.selectionAsync().catch(() => undefined);
    setSending(true);
    try {
      await call(agent.deviceId, "terminal.keys", { agent: agent.key, keys: [key] });
      refreshSoon();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  /** After an error (a dropped connection, a model that failed): ask it to carry on. */
  async function retry() {
    Haptics.selectionAsync().catch(() => undefined);
    setSending(true);
    const r = await sendOut(agent, "继续");
    setSending(false);
    if (r.ok) refreshSoon();
    else if (mode === "terminal") setToast(r.message);
  }

  async function interrupt() {
    if (!online || sending) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    setSending(true);
    try {
      const r = await call(agent.deviceId, "terminal.interrupt", { agent: agent.key });
      if (r.report) setToast(r.report);
      refreshSoon();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const keyStyle = { borderRadius: radius.pill, minHeight: 40, minWidth: 48, paddingHorizontal: 14, alignItems: "center" as const, justifyContent: "center" as const };
  const padOpen = mode === "terminal" && pad && online && !boxOnly;
  const closePad = useCallback(() => setPad(false), []);
  /** Keyboard button: closes whichever keyboard is up, else opens the one used last. */
  function toggleKeyboard() {
    if (boxOnly) return setExtra((v) => !v);
    if (padOpen || direct.on) {
      setPad(false);
      direct.stop();
    } else if (termInput === "system") direct.start();
    else setPad(true);
  }
  function switchToSystem() {
    setPad(false);
    setSettings({ termInput: "system" });
    direct.start();
  }
  function switchToPad() {
    direct.stop();
    setSettings({ termInput: "pad" });
    setPad(true);
  }

  return (
    <View style={{ paddingBottom: bottomInset + space.sm, paddingTop: space.xs }}>
      {mode === "terminal" && !boxOnly ? direct.input : null}
      {mode === "terminal" && direct.on ? (
        <View accessibilityLiveRegion="polite" style={{ marginHorizontal: space.lg, marginBottom: space.xs, paddingLeft: space.md, paddingRight: 4, minHeight: 32, borderRadius: radius.pill, backgroundColor: p.accentContainer, flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.primary }} />
          <Text style={{ color: p.accentText, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
            直接输入中，打的字会马上出现在终端里
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="换回小键盘，占的地方更少"
            onPress={switchToPad}
            style={({ pressed }) => ({ height: 26, paddingHorizontal: 10, borderRadius: radius.pill, justifyContent: "center", backgroundColor: pressed ? p.surface3 : p.surface })}
          >
            <Text style={{ fontFamily: fonts.bodySemi, fontSize: 12, color: p.accentText }}>小键盘</Text>
          </Pressable>
        </View>
      ) : null}
      {!isRuntime && agent.status === "blocked" && online ? <WaitingCard agent={agent} busy={sending} onKey={(k) => press(k)} onRetry={retry} compact={mode === "terminal"} onOpenTerminal={onOpenTerminal} /> : null}
      {isRuntime && pendingQuestions.length > 0 && online ? (
        <RuntimeQuestionPrompt
          agent={agent}
          pendingQuestions={pendingQuestions}
          canSend={effectiveCanSend}
          online={online}
          onAnswered={refreshSoon}
          onToast={(msg) => setToast(msg)}
        />
      ) : null}
      {showKeys ? (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
      <ScrollView horizontal style={{ flex: 1 }} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingLeft: space.lg, paddingRight: space.xs, paddingVertical: space.xs }} keyboardShouldPersistTaps="always">
        {mode === "terminal" ? (
          <IconTile
            icon={(boxOnly ? extra : direct.on || padOpen) ? "keyboardDown" : "keyboard"}
            size={40}
            disabled={!online}
            active={boxOnly ? extra : direct.on || padOpen}
            onPress={toggleKeyboard}
            a11y={boxOnly ? (extra ? "收起输入框" : "打字输入到终端") : direct.on || padOpen ? "收起键盘" : "直接在终端里打字"}
          />
        ) : null}
        <IconTile icon="tune" size={40} tone="plain" onPress={() => setTuning(true)} a11y="调整按键" />
        {keys.map((k) => (
          <Pressable
            key={k.key}
            disabled={!online}
            onPress={() => press(k.key)}
            accessibilityRole="button"
            accessibilityLabel={k.a11y}
            style={({ pressed }) => [keyStyle, { backgroundColor: pressed ? p.accentContainer : p.surface, borderWidth: 1, borderColor: p.dark ? p.surface3 : "#F6DDE8", opacity: online ? 1 : 0.5, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
          >
            <Text style={{ fontFamily: k.mono ? fonts.mono : fonts.bodySemi, fontSize: 13.5, color: p.ink }}>{k.label}</Text>
          </Pressable>
        ))}

      </ScrollView>
        <View style={{ paddingRight: space.lg, paddingLeft: space.xs }}>
        <Pressable
            disabled={!online}
            delayLongPress={500}
            onLongPress={() => press("ctrl+c", "heavy")}
            onPress={() => setToast("长按 0.5 秒发送 Ctrl+C，会打断它正在做的事")}
            accessibilityRole="button"
            accessibilityLabel="Ctrl+C，长按发送中断"
            style={({ pressed }) => [keyStyle, { borderWidth: 1.5, borderColor: coral, backgroundColor: pressed ? statusColors("blocked", p.dark).bg : p.surface, opacity: online ? 1 : 0.5 }]}
          >
            <Text style={{ fontFamily: fonts.monoBold, fontSize: 13, color: coral }}>Ctrl+C</Text>
          </Pressable>
        </View>
      </View>
      ) : null}
      {agent.queued && !(mode === "chat" && mineWaiting >= agent.queued) ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityLabel={`排队中，${agent.queued} 条消息在它的输入框里，这一轮完了才会处理`}
          style={{ marginHorizontal: space.lg, marginTop: space.xs, paddingHorizontal: space.md, minHeight: 30, borderRadius: radius.pill, backgroundColor: p.accentContainer, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.primary }} />
          <Text style={{ color: p.accentText, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
            {`排队中 · ${agent.queued} 条在它输入框里，这一轮完了才会处理${agent.queuedText ? `：${agent.queuedText}` : ""}`}
          </Text>
        </View>
      ) : null}
      {padOpen ? (
        <TermKeyboard onSend={direct.push} onSystem={switchToSystem} onClose={closePad} />
      ) : null}
      {mode === "chat" && pictures.length ? (
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: space.xs }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md, paddingLeft: space.lg, paddingRight: space.sm, paddingTop: 8, paddingBottom: 2 }} keyboardShouldPersistTaps="always">
            {pictures.map((x, i) => (
              <View key={x.id} style={{ width: 60, height: 60 }}>
                <Image
                  source={{ uri: `data:${x.mime};base64,${x.data}` }}
                  accessibilityLabel={`要发送的第 ${i + 1} 张图片`}
                  style={{ width: 60, height: 60, borderRadius: radius.sm, backgroundColor: p.surface2, borderWidth: 1, borderColor: p.dark ? p.surface3 : "#FBE3EC" }}
                />
                <Pressable
                  onPress={() => setPictures((cur) => cur.filter((y) => y.id !== x.id))}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`移除第 ${i + 1} 张图片`}
                  style={({ pressed }) => ({ position: "absolute", top: -7, right: -7, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.primaryPressed : p.primary, borderWidth: 2, borderColor: p.surface })}
                >
                  <MaterialCommunityIcons name="close" size={12} color={p.onPrimary} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Text accessibilityLiveRegion="polite" style={{ color: p.muted, fontSize: 12, paddingRight: space.lg }}>
            {`${pictures.length}/${PUT_LIMITS.files}`}
          </Text>
        </View>
      ) : null}
      {showInput && mode === "chat" && quote && onClearQuote ? <QuoteComposerBanner quote={quote} onClear={onClearQuote} /> : null}
      {showInput ? (
      <View
        style={{
          // Chat: the words get the full width and a toolbar sits under them. Terminal box: one row.
          flexDirection: mode === "chat" ? "column" : "row",
          gap: mode === "chat" ? 2 : space.sm,
          marginHorizontal: space.lg,
          marginTop: space.xs,
          backgroundColor: p.surface,
          borderRadius: radius.xl,
          // The send button stays at the bottom while a long line grows upward.
          alignItems: mode === "chat" ? "stretch" : "flex-end",
          paddingLeft: mode === "chat" ? 6 : space.lg,
          paddingRight: 6,
          paddingTop: mode === "chat" ? 2 : 6,
          paddingBottom: 6,
          borderWidth: 1,
          borderColor: p.dark ? p.surface3 : "#FBE3EC",
          shadowColor: p.shadow,
          shadowOpacity: p.dark ? 0 : 0.12,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: p.dark ? 0 : 2,
        }}
      >
        <RNTextInput
          value={text}
          onChangeText={setText}
          placeholder={!online ? "这台电脑离线了" : mode === "chat" ? "回它一句…" : "输入到终端，发送时带回车"}
          placeholderTextColor={p.faint}
          editable={online}
          maxLength={isRuntime ? RUNTIME_SESSION_TEXT_LIMIT : undefined}
          multiline={mode === "chat"}
          autoFocus={mode === "terminal"}
          autoCapitalize={mode === "terminal" ? "none" : undefined}
          autoCorrect={mode === "chat"}
          onSubmitEditing={mode === "terminal" ? send : undefined}
          style={
            mode === "chat"
              ? // Grows to about six lines, then scrolls.
                { fontFamily: fonts.body, fontSize: 15.5 * textScale, color: p.ink, minHeight: 44, maxHeight: Math.round(15.5 * textScale * 1.4 * 6) + 18, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 8 }
              : { flex: 1, fontFamily: fonts.mono, fontSize: 14, color: p.ink, maxHeight: 120, paddingVertical: 9 }
          }
          accessibilityLabel="发送给 agent 的内容"
        />
        {mode === "chat" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            {!isRuntime ? (
              <>
                <IconTile
                  icon={extra ? "keyboardDown" : "keyboard"}
                  size={42}
                  active={extra}
                  onPress={() => setExtra((v) => !v)}
                  a11y={extra ? "收起快捷按键" : "显示回车、Esc、方向键等快捷按键"}
                />
                <IconTile icon="image" size={42} disabled={!online || picking} onPress={attach} a11y="添加图片，和消息一起发给它" />
              </>
            ) : null}
            <View style={{ flex: 1 }} />
            {agent.status === "working" ? (
              <Button mode="outlined" compact disabled={!online || sending} loading={sending} onPress={interrupt} style={{ borderRadius: radius.pill, borderColor: p.error }} textColor={p.error}>
                停止
              </Button>
            ) : null}
            <SendPill disabled={(!text.trim() && !pictures.length) || !online} onPress={send} />
          </View>
        ) : (
          <SendPill disabled={!text.trim() || !online} onPress={send} />
        )}
      </View>
      ) : null}
      {isRuntime && !effectiveCanSend ? (
        <View
          style={{
            marginHorizontal: space.lg,
            marginTop: space.xs,
            paddingHorizontal: space.md,
            paddingVertical: 10,
            borderRadius: radius.pill,
            backgroundColor: p.surface2,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <MaterialCommunityIcons name="eye-outline" size={16} color={p.muted} />
          <Text style={{ flex: 1, color: p.muted, fontSize: 12.5 }}>{effectiveReadOnlyReason ?? "当前会话仅支持查看消息记录"}</Text>
          {agent.status === "working" ? (
            <Button mode="outlined" compact disabled={!online || sending} loading={sending} onPress={interrupt} style={{ borderRadius: radius.pill, borderColor: p.error }} textColor={p.error}>
              停止
            </Button>
          ) : null}
        </View>
      ) : null}
      <KeyLayoutDialog visible={tuning} onDismiss={() => setTuning(false)} />
      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={2500} wrapperStyle={{ bottom: 140 }}>
        {toast ?? ""}
      </Snackbar>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

export function InfoView({ agent, bottomInset }: { agent: Agent; bottomInset: number }) {
  const p = usePalette();
  const device = useLive((s) => s.devices[agent.deviceId]);
  const look = harnessLook(agent.harness, agent.isShell);
  const ratio = agent.contextTokens && agent.contextLimit ? agent.contextTokens / agent.contextLimit : null;
  const quota = agent.modelQuota;
  const windows = quota?.available ? [quota.primary, quota.secondary].filter((w): w is NonNullable<typeof w> => Boolean(w)) : [];
  const barColor = (pct: number) => (pct <= 15 ? p.error : pct <= 40 ? "#D97706" : statusColors("working", p.dark).fg);
  const row = (title: string, value: string | undefined | null, icon: string, mono = false) =>
    value ? (
      <List.Item
        key={title}
        title={title}
        description={value}
        descriptionNumberOfLines={3}
        titleStyle={{ fontSize: 13, color: p.muted }}
        descriptionStyle={{ fontSize: 15, color: p.ink, fontFamily: mono ? fonts.mono : fonts.body }}
        left={(props) => <List.Icon {...props} color={p.muted} icon={icon} />}
      />
    ) : null;
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: bottomInset + space.xxl, gap: space.md }}>
      {quota ? (
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: space.lg, gap: space.sm }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm }}>
            <Text style={{ fontFamily: fonts.bodyBold, color: p.ink }}>模型与剩余额度</Text>
            {quota.plan ? (
              <View style={{ backgroundColor: p.lavenderContainer, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
                <Text style={{ fontSize: 11.5, fontFamily: fonts.bodySemi, color: p.ink }}>{quota.plan}</Text>
              </View>
            ) : null}
          </View>
          {agent.model ? <Text style={{ fontSize: 14, color: p.ink, fontFamily: fonts.mono }}>{agent.model}</Text> : null}
          {quota.available ? (
            <View style={{ gap: space.sm }}>
              {windows.map((w, i) => (
                <View key={i} style={{ gap: 4 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
                    <Text style={{ fontSize: 13, color: p.muted }}>{quotaWindowText(w)}</Text>
                    <Text style={{ fontSize: 13, fontFamily: fonts.bodyBold, color: barColor(w.remainingPercent) }}>
                      {Math.round(w.remainingPercent)}%
                    </Text>
                  </View>
                  <ProgressBar
                    progress={Math.max(0, Math.min(1, w.remainingPercent / 100))}
                    color={barColor(w.remainingPercent)}
                    style={{ height: 8, borderRadius: 4, backgroundColor: p.surface3 }}
                  />
                </View>
              ))}
              {quota.balance ? <Text style={{ fontSize: 13, color: p.muted }}>账户可用余额 / Credits：{quota.balance}</Text> : null}
            </View>
          ) : (
            <Text style={{ fontSize: 13, color: p.muted }}>{quota.note ?? "该程序暂未向本机开放模型剩余配额接口"}</Text>
          )}
        </View>
      ) : null}
      {ratio != null ? (
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: space.lg, gap: space.sm }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontFamily: fonts.bodyBold, color: p.ink }}>上下文用量</Text>
            <Text style={{ color: p.muted }}>
              {compactNum(agent.contextTokens)} / {compactNum(agent.contextLimit)}
            </Text>
          </View>
          <ProgressBar progress={Math.min(1, ratio)} color={ratio > 0.8 ? p.error : p.lavender} style={{ height: 8, borderRadius: 4, backgroundColor: p.surface3 }} />
        </View>
      ) : null}
      <View style={{ backgroundColor: p.surface, borderRadius: radius.card, overflow: "hidden", paddingVertical: space.xs }}>
        {row("状态", `${agentStatusLabel(agent)} · ${relTime(agent.statusSince ?? agent.updatedAt)}`, "pulse")}
        {row("程序", look.label, "robot-outline")}
        {row("所在电脑", device?.name ?? agent.deviceId, "laptop")}
        {row("位置", agent.where, "tab")}
        {row("目录", shortPath(agent.cwd), "folder-outline", true)}
        {row("模型", agent.model, "brain")}
        {row("花费", money(agent.costUsd), "cash")}
        {row("轮次", agent.turn ? `第 ${agent.turn} 轮` : null, "counter")}
        {row("会话", agent.sessionKey, "message-text-outline", true)}
        {row(agent.source === "runtime" ? "来源" : "终端地址", `${agent.source}:${agent.localId}`, "console", true)}
      </View>
    </ScrollView>
  );
}
