import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Image, Pressable, ScrollView, View, type ListRenderItem } from "react-native";
import { ActivityIndicator, Button, Snackbar, Text } from "react-native-paper";
import Markdown from "react-native-markdown-display";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import type { Agent, ConvEvent, SubSession } from "@xiaoaixiaoai/protocol";
import { call, subscribe } from "../lib/relay";
import { splitPictures } from "../lib/attach";
import { followSends, forget } from "../lib/outbox";
import { useLive, usePending, useSettings, type PendingSend } from "../lib/store";
import { fixCjkEmphasis, hasList } from "../lib/markdown";
import { openSub, SUB_STATUS, type Crumb } from "../lib/subnav";
import { usePalette } from "../theme/theme";
import { brand, fonts, radius, space, statusColors, type Palette } from "../theme/tokens";
import { EmptyState, TypingDots } from "./ui";
import { ReplyDots, SendMark } from "./outbox";
import { BusyMascot, Sparkle } from "./Mascot";
import { CuteIcon } from "./icons";

const clock = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Event -> row folding
// ---------------------------------------------------------------------------

type ToolCall = Extract<ConvEvent, { kind: "tool_call" }>;
type ToolResult = Extract<ConvEvent, { kind: "tool_result" }>;

export type Row =
  | { type: "user"; id: string; text: string; ts: number; injected?: string; pictures?: string[] }
  | { type: "assistant"; id: string; text: string; ts: number }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; call: ToolCall; result?: ToolResult }
  /** A run of tool calls folded into one line. */
  | { type: "tools"; id: string; items: Extract<Row, { type: "tool" }>[] }
  /** Sent from this phone, not yet echoed by the session. */
  | { type: "pending"; id: string; text: string; ts: number; pictures?: string[]; send: PendingSend; agentKey: string }
  | { type: "turn_end"; id: string; ts: number }
  | { type: "system"; id: string; text: string; summary: string };

export function foldEvents(events: ConvEvent[]): Row[] {
  const rows: Row[] = [];
  const toolIndex = new Map<string, number>();
  for (const e of events) {
    switch (e.kind) {
      case "user_message":
        if (e.synthetic) {
          // Older hostd builds: harness-made "user" messages are system notes.
          if (e.text.trim()) rows.push({ type: "system", id: e.id, text: e.text, summary: systemSummary(e.text) });
        } else if (e.text.trim() || e.injected?.trim()) {
          rows.push({ type: "user", id: e.id, text: e.text, ts: e.ts, injected: e.injected?.trim() || undefined });
        }
        break;
      case "assistant_message":
        if (e.text.trim()) rows.push({ type: "assistant", id: e.id, text: e.text, ts: e.ts });
        break;
      case "reasoning":
        if (e.text.trim()) rows.push({ type: "thinking", id: e.id, text: e.text });
        break;
      case "tool_call":
        toolIndex.set(e.call_id, rows.length);
        rows.push({ type: "tool", id: e.id, call: e });
        break;
      case "tool_result": {
        const i = toolIndex.get(e.call_id);
        const row = i == null ? undefined : rows[i];
        if (row && row.type === "tool") row.result = e;
        break;
      }
      case "turn_end":
        if (rows.length && rows[rows.length - 1]?.type !== "turn_end") rows.push({ type: "turn_end", id: e.id, ts: e.ts });
        break;
      case "system":
        if (e.text.trim()) rows.push({ type: "system", id: e.id, text: e.text, summary: e.summary?.trim() || systemSummary(e.text) });
        break;
      default:
        break; // usage, turn_start: not shown
    }
  }
  return groupTools(rows);
}

/** Fold each run of two or more tool calls into one "tools" row so replies are not buried under tool cards. */
function groupTools(rows: Row[]): Row[] {
  const out: Row[] = [];
  let run: Extract<Row, { type: "tool" }>[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: "tools", id: `g-${run[0]!.id}`, items: run });
    else out.push(...run);
    run = [];
  };
  for (const r of rows) {
    if (r.type === "tool") run.push(r);
    else {
      if (run.length) flush();
      out.push(r);
    }
  }
  if (run.length) flush();
  return out;
}

/** Fallback one-liner for a system note without a hostd `summary`. */
function systemSummary(text: string): string {
  const first = text
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return "系统提醒";
  return first.length > 24 ? `${first.slice(0, 23)}…` : first;
}

/** Pretty-print JSON strings/values; leaves anything else as is. */
export function prettyMaybeJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "string") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  const t = v.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return v;
}

/** One-line human summary of a tool input. */
export function toolSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "file_path", "pattern", "path", "query", "url", "description", "prompt"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const s = JSON.stringify(o);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

const TOOL_ICONS: Record<string, "console-line" | "file-edit-outline" | "file-document-outline" | "magnify" | "web" | "robot-outline" | "wrench-outline"> = {
  bash: "console-line",
  shell: "console-line",
  exec: "console-line",
  edit: "file-edit-outline",
  write: "file-edit-outline",
  multiedit: "file-edit-outline",
  apply_patch: "file-edit-outline",
  read: "file-document-outline",
  grep: "magnify",
  glob: "magnify",
  search: "magnify",
  webfetch: "web",
  websearch: "web",
  task: "robot-outline",
  agent: "robot-outline",
};

function toolIcon(name: string) {
  return TOOL_ICONS[name.toLowerCase()] ?? "wrench-outline";
}

/** Each kind of tool gets its own pastel tile: commands mint, edits peach, reading and search sky, helpers lavender. */
function toolTint(name: string, p: Palette): { bg: string; fg: string } {
  const icon = toolIcon(name);
  if (icon === "console-line") return statusColors("working", p.dark);
  if (icon === "file-edit-outline") return p.dark ? { bg: "#4A3328", fg: "#FFB98F" } : { bg: "#FFE6D8", fg: "#B4572E" };
  if (icon === "file-document-outline" || icon === "magnify" || icon === "web") return p.dark ? { bg: "#243F55", fg: "#9FD0F5" } : { bg: "#DDEFFC", fg: "#2F6E9E" };
  return { bg: p.lavenderContainer, fg: p.dusk };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function mdStyles(p: Palette, scale: number) {
  const base = 15.5 * scale;
  return {
    body: { color: p.ink, fontFamily: fonts.body, fontSize: base, lineHeight: base * 1.55 },
    strong: { fontFamily: fonts.bodyBold, fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    heading1: { fontFamily: fonts.cute, fontSize: base * 1.4, lineHeight: base * 1.9, color: p.ink },
    heading2: { fontFamily: fonts.cute, fontSize: base * 1.25, lineHeight: base * 1.7, color: p.ink },
    heading3: { fontFamily: fonts.bodyBold, fontSize: base * 1.1, color: p.ink },
    link: { color: p.accentText },
    bullet_list_icon: { color: p.accentText, marginTop: 1 },
    ordered_list_icon: { color: p.accentText },
    code_inline: {
      fontFamily: fonts.mono,
      fontSize: base * 0.86,
      backgroundColor: p.surface3,
      color: p.ink,
      borderRadius: radius.xs,
      paddingHorizontal: 4,
    },
    fence: {
      fontFamily: fonts.mono,
      fontSize: 12.5 * scale,
      lineHeight: 12.5 * scale * 1.55,
      backgroundColor: p.surface,
      color: p.ink,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: p.divider,
      padding: space.md,
    },
    code_block: { fontFamily: fonts.mono, fontSize: 12.5 * scale, backgroundColor: p.surface2, borderRadius: radius.sm, padding: space.md, borderWidth: 0 },
    blockquote: { backgroundColor: p.surface2, borderLeftColor: p.accentText, borderLeftWidth: 3, paddingHorizontal: space.md, borderRadius: radius.xs },
    hr: { backgroundColor: p.divider },
    table: { borderColor: p.divider, borderRadius: radius.xs },
    th: { padding: 6 },
    td: { padding: 6, borderColor: p.divider },
  };
}

/** Small tappable chip that expands into a monospace, height-capped, scrollable block. */
function FoldChip({ label, icon, body, align = "center", a11y }: { label: string; icon: "information-outline" | "paperclip" | "image-outline"; body: string; align?: "center" | "flex-end"; a11y: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ alignItems: open ? "stretch" : align, gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${a11y}，${open ? "点按收起" : "点按展开"}`}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={({ pressed }) => ({
          alignSelf: open ? (align === "center" ? "center" : "flex-end") : undefined,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          maxWidth: "100%",
          minHeight: 30,
          paddingHorizontal: space.md,
          borderRadius: radius.pill,
          backgroundColor: pressed ? p.surface3 : p.surface2,
          borderWidth: 1,
          borderColor: p.divider,
        })}
      >
        <MaterialCommunityIcons name={icon} size={13} color={p.faint} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: p.faint, fontSize: 12, fontFamily: fonts.bodySemi }}>
          {label}
        </Text>
        <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={14} color={p.faint} />
      </Pressable>
      {open ? (
        <View style={{ backgroundColor: p.surface2, borderRadius: radius.sm, borderWidth: 1, borderColor: p.divider, maxHeight: 280, overflow: "hidden" }}>
          <ScrollView nestedScrollEnabled contentContainerStyle={{ padding: space.md }}>
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 17, color: p.muted }}>
              {body}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** `send`: sent from this phone and not in the conversation yet; its state shows under the bubble. */
const UserBubble = memo(function UserBubble({ text, injected, ts, send, agentKey, pictures }: { text: string; injected?: string; ts?: number; send?: PendingSend; agentKey?: string; pictures?: string[] }) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  // Picture paths sent with a message (and Claude Code's [Image #n] marks) fold into a chip.
  const shown = useMemo(() => splitPictures(text), [text]);
  return (
    <View style={{ alignItems: "flex-end", paddingLeft: 48, gap: space.xs }}>
      {shown.text ? (
        <View style={{ backgroundColor: p.bubble, borderRadius: radius.card, borderBottomRightRadius: radius.xs, paddingHorizontal: space.lg, paddingVertical: space.md }}>
          <Text selectable style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 15.5 * scale * 1.5 }}>
            {shown.text}
          </Text>
        </View>
      ) : null}
      {pictures?.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs }}>
          {pictures.map((uri, i) => (
            <Image key={i} source={{ uri }} accessibilityLabel={`发送的第 ${i + 1} 张图片`} style={{ width: 64, height: 64, borderRadius: radius.sm, backgroundColor: p.surface2 }} />
          ))}
        </View>
      ) : shown.count ? (
        <FoldChip label={`图片 ×${shown.count}`} icon="image-outline" body={shown.lines.join("\n")} align="flex-end" a11y={`这条消息带了 ${shown.count} 张图片`} />
      ) : null}
      {injected ? <FoldChip label="附加内容" icon="paperclip" body={injected} align="flex-end" a11y="这条消息的附加内容" /> : null}
      {send && agentKey ? (
        <SendMark send={send} agentKey={agentKey} time={clock(send.ts)} />
      ) : ts ? (
        <Text style={{ color: p.faint, fontSize: 11 }}>{clock(ts)}</Text>
      ) : null}
    </View>
  );
});

/** Children of the session on screen, keyed by the parent tool_call that spawned them. */
const SubCtx = createContext<{ byCall: Map<string, SubSession>; open: (s: SubSession) => void } | null>(null);

/** The agent's reply, always in full: folding it behind "展开全文" read as broken. */
const AssistantBlock = memo(function AssistantBlock({ text }: { text: string }) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  const styles = useMemo(() => mdStyles(p, scale), [p, scale]);
  const md = useMemo(() => fixCjkEmphasis(text), [text]);
  return (
    <View
      style={{
        alignSelf: "flex-start",
        ...(hasList(md) ? { width: "94%" as const } : { maxWidth: "94%" as const }),
        backgroundColor: p.surface,
        borderRadius: radius.card,
        borderBottomLeftRadius: 6,
        paddingHorizontal: space.lg,
        paddingVertical: space.xs,
        elevation: p.dark ? 0 : 1,
        shadowColor: p.shadow,
        shadowOpacity: 0.1,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
      }}
    >
      <Markdown style={styles}>{md}</Markdown>
    </View>
  );
});

function ThinkingPill({ text }: { text: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? "收起思考过程" : "展开思考过程"}
      onPress={() => setOpen((v) => !v)}
      style={{ alignSelf: open ? "stretch" : "flex-start", maxWidth: "100%", backgroundColor: p.duskContainer, borderRadius: open ? radius.md : radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 36, justifyContent: "center" }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <MaterialCommunityIcons name="thought-bubble-outline" size={15} color={p.dusk} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: p.dusk, fontFamily: fonts.bodySemi, fontSize: 13 }}>
          {open ? "思考过程" : text.trim().split("\n")[0]}
        </Text>
        <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={16} color={p.dusk} />
      </View>
      {open ? <Text selectable style={{ color: p.muted, fontSize: 13.5, lineHeight: 20, marginTop: space.sm }}>{text}</Text> : null}
    </Pressable>
  );
}

function ToolSection({ title, body, error }: { title: string; body: string; error?: boolean }) {
  const p = usePalette();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: p.faint, fontSize: 11.5, fontFamily: fonts.bodyBold }}>{title}</Text>
      <View style={{ backgroundColor: error ? "transparent" : p.surface2, borderRadius: radius.sm, maxHeight: 320, overflow: "hidden" }}>
        <ScrollView nestedScrollEnabled contentContainerStyle={{ padding: space.sm }}>
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 17, color: error ? p.error : p.muted }}>
              {body}
            </Text>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

function ToolCard({ call: c, result, bare }: { call: ToolCall; result?: ToolResult; bare?: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const failed = result?.is_error;
  const pending = !result;
  const tint = failed ? p.error : p.muted;
  const summary = toolSummary(c.input);
  const input = useMemo(() => (open ? prettyMaybeJson(c.input) : ""), [open, c.input]);
  const output = useMemo(() => (open ? prettyMaybeJson(result?.output ?? "") : ""), [open, result?.output]);
  const state = failed ? "失败" : pending ? "进行中" : "完成";
  const subs = useContext(SubCtx);
  const child = subs?.byCall.get(c.call_id);
  return (
    <View
      style={
        bare
          ? { backgroundColor: failed ? p.errorContainer : open ? p.surface2 : "transparent", borderRadius: radius.sm }
          : { backgroundColor: failed ? p.errorContainer : p.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: failed ? p.error : p.dark ? p.surface3 : "#F6E6EF" }
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`工具 ${c.name}，${state}，${open ? "点按收起" : "点按查看输入和输出"}`}
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: bare ? space.sm : space.md, minHeight: bare ? 38 : 44 }}
      >
        <View style={{ width: 28, height: 28, borderRadius: 10, backgroundColor: failed ? p.errorContainer : toolTint(c.name, p).bg, alignItems: "center", justifyContent: "center" }}>
          <MaterialCommunityIcons name={toolIcon(c.name)} size={16} color={failed ? tint : toolTint(c.name, p).fg} />
        </View>
        <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 13.5 }}>{c.name}</Text>
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: p.faint }}>
          {summary}
        </Text>
        {pending ? (
          <ActivityIndicator size={12} />
        ) : (
          failed ? <MaterialCommunityIcons name="alert-circle" size={16} color={p.error} /> : <CuteIcon name="done" size={16} color={statusColors("working", p.dark).fg} fill={p.dark ? "transparent" : statusColors("working", p.dark).bg} strokeWidth={2.4} />
        )}
        <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={16} color={p.faint} />
      </Pressable>
      {child && subs ? <SubLink s={child} onPress={() => subs.open(child)} /> : null}
      {open ? (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm }}>
          {input ? <ToolSection title="输入" body={input} /> : null}
          {result ? <ToolSection title={failed ? "输出（出错）" : "输出"} body={output || "（没有输出）"} error={failed} /> : <Text style={{ color: p.faint, fontSize: 12 }}>还在运行，结果出来后会显示在这里</Text>}
        </View>
      ) : null}
    </View>
  );
}

/** A run of tool calls on one line; tap to list them, tap one to see its input and output. */
function ToolGroup({ items: tools }: { items: Extract<Row, { type: "tool" }>[] }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const subs = useContext(SubCtx);
  const failed = tools.filter((t) => t.result?.is_error).length;
  const running = tools.filter((t) => !t.result);
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.call.name, (counts.get(t.call.name) ?? 0) + 1);
  const names = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
  const current = running[running.length - 1];
  const children = tools.map((t) => subs?.byCall.get(t.call.call_id)).filter((s): s is SubSession => !!s);
  return (
    <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: failed ? p.error : p.dark ? p.surface3 : "#F6E6EF" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`用了 ${tools.length} 个工具${failed ? `，${failed} 个失败` : ""}${running.length ? "，还在运行" : ""}，${open ? "点按收起" : "点按展开"}`}
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, minHeight: 42 }}
      >
        <View style={{ width: 26, height: 26, borderRadius: 9, backgroundColor: p.lavenderContainer, alignItems: "center", justifyContent: "center" }}>
          <MaterialCommunityIcons name="wrench-outline" size={15} color={p.dusk} />
        </View>
        <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 13.5 }}>{tools.length} 个工具</Text>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: p.faint }}>
          {names}
        </Text>
        {failed ? <Text style={{ color: p.error, fontFamily: fonts.bodyBold, fontSize: 12 }}>{failed} 个失败</Text> : null}
        {running.length ? <ActivityIndicator size={12} /> : failed ? null : <CuteIcon name="done" size={16} color={statusColors("working", p.dark).fg} fill={p.dark ? "transparent" : statusColors("working", p.dark).bg} strokeWidth={2.4} />}
        <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={16} color={p.faint} />
      </Pressable>
      {!open && current ? (
        <Text numberOfLines={1} style={{ paddingHorizontal: space.md, paddingBottom: space.sm, fontFamily: fonts.mono, fontSize: 11.5, color: p.muted }}>
          正在运行 {current.call.name} {toolSummary(current.call.input)}
        </Text>
      ) : null}
      {!open && subs ? children.map((s) => <SubLink key={s.key} s={s} onPress={() => subs.open(s)} />) : null}
      {open ? (
        <View style={{ paddingHorizontal: space.xs, paddingBottom: space.xs, gap: 2 }}>
          {tools.map((r) => (
            <ToolCard key={r.id} call={r.call} result={r.result} bare />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SubLink({ s, onPress }: { s: SubSession; onPress: () => void }) {
  const p = usePalette();
  const c = statusColors(s.status === "working" ? "working" : "idle", p.dark);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看子 agent 对话，${SUB_STATUS[s.status]}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 44,
        marginHorizontal: space.sm,
        marginBottom: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.sm,
        backgroundColor: pressed ? p.surface3 : p.lavenderContainer,
      })}
    >
      <MaterialCommunityIcons name="source-branch" size={16} color={p.ink} />
      <Text style={{ flex: 1, color: p.ink, fontFamily: fonts.bodyBold, fontSize: 13.5 }}>查看子 agent 对话</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />
        <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>{SUB_STATUS[s.status]}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={18} color={p.muted} />
    </Pressable>
  );
}

function TurnEnd({ ts }: { ts?: number }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs }}>
      <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
      <Sparkle size={10} color={p.dark ? p.lavender : brand.blush} />
      <Text style={{ color: p.faint, fontSize: 11.5, fontFamily: fonts.cute }}>这一轮结束{ts ? ` · ${clock(ts)}` : ""}</Text>
      <Sparkle size={10} color={p.dark ? p.lavender : brand.blush} />
      <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
    </View>
  );
}

const renderRow: ListRenderItem<Row> = ({ item }) => {
  switch (item.type) {
    case "user":
      return <UserBubble text={item.text} injected={item.injected} ts={item.ts} pictures={item.pictures} />;
    case "pending":
      return <UserBubble text={item.text} pictures={item.pictures} send={item.send} agentKey={item.agentKey} />;
    case "tools":
      return <ToolGroup items={item.items} />;
    case "assistant":
      return <AssistantBlock text={item.text} />;
    case "thinking":
      return <ThinkingPill text={item.text} />;
    case "tool":
      return <ToolCard call={item.call} result={item.result} />;
    case "turn_end":
      return <TurnEnd ts={item.ts} />;
    case "system":
      return <FoldChip label={item.summary} icon="information-outline" body={item.text} a11y={`系统提醒：${item.summary}`} />;
  }
};


// ---------------------------------------------------------------------------
// Chat view
// ---------------------------------------------------------------------------

interface ChatViewProps {
  agent: Agent;
  active: boolean;
  bottomInset: number;
  onNoSession: () => void;
  /** Read a subagent session of this agent instead of its own. */
  sub?: string;
  /** Known number of children of the session on screen (enables `session.children`). */
  childCount?: number;
  trail?: Crumb[];
}

export function ChatView(props: ChatViewProps) {
  // A new conversation owns a new event buffer, pagination and scroll position.
  return <SessionChatView key={JSON.stringify([props.agent.key, props.sub ?? null])} {...props} />;
}

function SessionChatView({
  agent,
  active,
  bottomInset,
  onNoSession,
  sub,
  childCount,
  trail = [],
}: ChatViewProps) {
  const p = usePalette();
  const [older, setOlder] = useState<ConvEvent[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const q = useQuery({
    queryKey: ["session.events", agent.key, sub ?? null],
    // One screenful first; older pages load as the list is scrolled up.
    queryFn: () => call(agent.deviceId, "session.events", { agent: agent.key, sub, limit: 60 }),
    enabled: active,
    refetchInterval: active && (sub || agent.status === "working") ? 8000 : active ? 20_000 : false,
  });
  // Everything received for this conversation, by id. The newest page slides forward as the agent works;
  // without this, events between the older pages and the current page would silently disappear.
  const [liveEvents, setLiveEvents] = useState<ConvEvent[]>([]);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "stale" | "error">("connecting");
  const linkOnline = useLive((s) => s.link === "online");
  useEffect(() => {
    const page = q.data?.events;
    if (!page?.length) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Merge external recovery-query pages into the live stream's retained event buffer.
    setLiveEvents((old) => {
      const oldestNew = posOf(page[0]!);
      const newestOld = old.length ? posOf(old[old.length - 1]!) : null;
      // The page no longer touches what we hold (long time away): what lies between is unknown, so start over from the page.
      if (newestOld !== null && oldestNew !== null && oldestNew > newestOld && !old.some((e) => e.id === page[0]!.id)) {
        setOlder([]);
        setOlderCursor(undefined);
        return page;
      }
      return mergeEvents(old, page);
    });
  }, [q.data]);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  useEffect(() => {
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize the status of a newly opened external session stream before delivery callbacks.
    setStreamState("connecting");
    let opened = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribe(agent.deviceId, "session", { agent: agent.key, sub }, (event) => {
      if (event?.kind === "session" && event.event) {
        const e = event.event as ConvEvent;
        setLiveEvents((old) => mergeEvents(old, [e]));
        setStreamState("live");
      } else if (event?.kind === "stale") setStreamState("stale");
      else if (event?.kind === "alive") setStreamState("live");
    }, (state) => {
      setStreamState(state.status === "open" ? "live" : "error");
      // A stream that reopens after a drop may have missed events; the page query fills them in.
      if (state.status === "open") {
        failures.current = 0;
        if (opened) void q.refetch();
        opened = true;
      } else {
        // Refused, or ended because the computer went away: try again a little later.
        retry ??= setTimeout(() => setAttempt((n) => n + 1), Math.min(30_000, 3000 * 2 ** failures.current++));
      }
    });
    return () => {
      clearTimeout(retry);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, agent.deviceId, agent.key, sub, attempt]);
  const kids = useQuery({
    queryKey: ["session.children", agent.key, sub ?? null],
    queryFn: () => call(agent.deviceId, "session.children", { agent: agent.key, sub }),
    enabled: active && (childCount ?? 0) > 0,
    refetchInterval: active && (sub || agent.status === "working") ? 3000 : active ? 10_000 : false,
    retry: false,
  });
  const subCtx = useMemo(() => {
    const byCall = new Map<string, SubSession>();
    for (const s of kids.data?.sessions ?? []) if (s.parentCall) byCall.set(s.parentCall, s);
    return { byCall, open: (s: SubSession) => openSub(agent.key, trail, s) };
  }, [kids.data, agent.key, trail]);

  const events = useMemo(() => {
    const seen = new Set(liveEvents.map((e) => e.id));
    return [...older.filter((e) => !seen.has(e.id)), ...liveEvents];
  }, [older, liveEvents]);

  // Messages sent from this phone show at once and give way to the session's own copy (lib/outbox).
  const sendsAll = usePending((s) => (sub ? undefined : s.byAgent[agent.key]));
  const patchSend = usePending((s) => s.update);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!sendsAll?.length && agent.status !== "working") return;
    const t = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, [sendsAll?.length, agent.status]);
  const folded = useMemo(() => foldEvents(events), [events]);
  const sends = useMemo(() => followSends(sendsAll ?? [], folded, { status: agent.status, queued: agent.queued }, nowTick), [sendsAll, folded, agent.status, agent.queued, nowTick]);
  useEffect(() => {
    for (const x of sends.patches) patchSend(agent.key, x.id, x.patch);
    if (sends.drop.length) forget(agent.key, sends.drop);
  }, [sends, patchSend, agent.key]);

  // Inverted list: newest at index 0. The session's copy of a message from this phone keeps its bubble's key.
  const rows = useMemo(
    () =>
      [
        ...folded.map((r): Row => {
          const x = r.type === "user" ? sends.echoes.get(r.id) : undefined;
          return r.type === "user" && x ? { ...r, id: x.id, pictures: x.pictures } : r;
        }),
        ...sends.shown.map((x): Row => ({ type: "pending", id: x.id, text: x.text, ts: x.ts, pictures: x.pictures, send: x, agentKey: agent.key })),
      ].reverse(),
    [folded, sends, agent.key],
  );
  const more = olderCursor === undefined ? q.data?.more : olderCursor !== null;

  const listRef = useRef<FlatList<Row>>(null);
  const busyRef = useRef(false);
  /** Until this time, keep pushing to the top as rows get measured (virtualised list). */
  const toTopUntil = useRef(0);
  const [jumping, setJumping] = useState<{ loaded: number } | null>(null);
  const [capped, setCapped] = useState(false);
  // Inverted list: offset 0 is the newest message.
  const [view, setView] = useState({ y: 0, h: 0, content: 0 });
  const atBottom = view.y < 48;
  const atTop = !more && view.content > 0 && view.y + view.h >= view.content - 48;
  // Unread: the newest row id when the user left the bottom; rows above it are new.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  // Keep this local derived selection in sync before commit, rather than cascading through an effect.
  const nextAnchor = atBottom ? null : anchorId ?? rows[0]?.id ?? null;
  if (anchorId !== nextAnchor) setAnchorId(nextAnchor);
  const unread = anchorId ? Math.max(0, rows.findIndex((r) => r.id === anchorId)) : 0;

  /** Fetch one older page; returns the next cursor (null at the beginning). */
  async function fetchOlder(before: string, limit: number): Promise<{ next: string | null; count: number }> {
    const res = await call(agent.deviceId, "session.events", { agent: agent.key, sub, limit, before });
    setOlder((o) => [...res.events, ...o]);
    const next = res.more ? res.nextBefore ?? res.events[0]?.pos ?? null : null;
    setOlderCursor(next);
    return { next, count: res.events.length };
  }

  async function loadOlder() {
    const first = events[0];
    if (!more || !first?.pos || busyRef.current) return;
    busyRef.current = true;
    setLoadingOlder(true);
    try {
      await fetchOlder(olderCursor ?? q.data?.nextBefore ?? first.pos, 120);
    } catch {
      /* next scroll retries */
    } finally {
      busyRef.current = false;
      setLoadingOlder(false);
    }
  }

  /** Load pages (300 each) until the beginning or ~5000 events, then scroll to the very top. */
  async function jumpToStart() {
    if (busyRef.current) return;
    busyRef.current = true;
    let cursor: string | null = more ? olderCursor ?? q.data?.nextBefore ?? events[0]?.pos ?? null : null;
    let total = events.length;
    setJumping({ loaded: total });
    setCapped(false);
    try {
      while (cursor && total < JUMP_CAP) {
        const r = await fetchOlder(cursor, 300);
        total += r.count;
        cursor = r.count ? r.next : null;
        setJumping({ loaded: total });
      }
      if (cursor) setCapped(true);
    } catch {
      /* show what we have */
    } finally {
      busyRef.current = false;
      setJumping(null);
      toTopUntil.current = Date.now() + 4000;
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 120);
    }
  }

  // The stream can deliver the first events before the recovery query returns.
  // Do not hide a live conversation behind a slow/unavailable snapshot request.
  if (q.isLoading && !liveEvents.length) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm }}>
        <ActivityIndicator />
        <Text style={{ color: p.faint, fontSize: 12 }}>正在接收对话…</Text>
      </View>
    );
  }
  if (q.isError && !liveEvents.length) {
    return <EmptyState mood="waiting" title="对话没加载出来" body={(q.error as Error).message} action={<Button textColor={p.accentText} onPress={() => q.refetch()}>再试一次</Button>} />;
  }
  if (q.data && !q.data.sessionKey && !liveEvents.length) {
    return (
      <EmptyState
        mood="waiting"
        title="还没找到它的对话记录"
        body={sub ? "这个子 agent 的会话暂时读不到。" : "这台电脑的 Uniflo 里没有和它对应的会话。可以先看终端画面。"}
        action={
          sub ? undefined : <Button mode="contained-tonal" icon="console" onPress={onNoSession} style={{ borderRadius: radius.pill }}>
            看终端
          </Button>
        }
      />
    );
  }
  if (!rows.length) return <EmptyState mood="sleepy" title="还没有对话" body={streamState === "error" || streamState === "stale" ? "实时连接暂时中断，正在重试；也可以点刷新。" : "它开始干活后，这里会实时更新。"} action={<Button textColor={p.accentText} onPress={() => q.refetch()}>刷新对话</Button>} />;

  return (
    <SubCtx.Provider value={subCtx}>
      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          inverted
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={renderRow}
          ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: bottomInset + space.md, paddingBottom: space.lg }}
          // Inverted: the list "end" is the top of the conversation. Older pages append there,
          // so the visible content keeps its offset from the bottom and nothing jumps.
          onEndReached={loadOlder}
          onEndReachedThreshold={1.5}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            setView({ y: contentOffset.y, h: layoutMeasurement.height, content: contentSize.height });
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (Date.now() < toTopUntil.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          onScrollBeginDrag={() => {
            toTopUntil.current = 0;
          }}
          ListFooterComponent={
            more ? (
              <View style={{ alignItems: "center", paddingVertical: space.md, minHeight: 40 }}>
                {loadingOlder ? <ActivityIndicator size={16} /> : null}
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.md }}>
                <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
                <Text style={{ color: p.faint, fontSize: 11.5 }}>对话开头</Text>
                <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
              </View>
            )
          }
          ListHeaderComponent={
            // Inverted list: the header sits under the newest message. One at a time: working, or about to answer.
            !sub && agent.status === "working" ? <WorkingBadge since={agent.statusSince} now={nowTick} /> : sends.awaiting ? <ReplyDots /> : undefined
          }
          keyboardDismissMode="interactive"
          extraData={subCtx}
        />
        <View pointerEvents="box-none" style={{ position: "absolute", right: space.lg, bottom: bottomInset + space.md, alignItems: "flex-end", gap: space.sm }}>
          {jumping ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: p.surface, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36, borderWidth: 1, borderColor: p.divider }}>
              <ActivityIndicator size={12} />
              <Text style={{ color: p.muted, fontSize: 12.5 }}>正在往前翻，已载入 {jumping.loaded} 条</Text>
            </View>
          ) : null}
          {!atBottom && !atTop && !jumping ? (
            <JumpButton icon="arrow-collapse-up" label="到开头" onPress={jumpToStart} />
          ) : null}
          {!atBottom ? (
            <JumpButton
              icon="arrow-collapse-down"
              label={unread ? `到最新，${unread} 条新消息` : "到最新"}
              badge={unread}
              onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
            />
          ) : null}
        </View>
        {/* Quiet is not broken: only say so when the link is down or the computer reports it cannot read the session. */}
        {!linkOnline || streamState === "stale" || streamState === "error" ? (
          <View pointerEvents="none" style={{ position: "absolute", top: 4, alignSelf: "center", paddingHorizontal: 10, minHeight: 24, justifyContent: "center", borderRadius: radius.pill, backgroundColor: p.surface2 }}>
            <Text style={{ color: p.faint, fontSize: 11 }}>{!linkOnline ? "和服务器断开了，正在重连" : "实时更新暂时中断，每隔几秒自动刷新"}</Text>
          </View>
        ) : null}
        <Snackbar visible={capped} onDismiss={() => setCapped(false)} duration={4000}>
          对话太长，只载入了最近约 {JUMP_CAP} 条，这里是已载入部分的开头
        </Snackbar>
      </View>
    </SubCtx.Provider>
  );
}

const JUMP_CAP = 5000;
const KEEP_EVENTS = 4000;

function posOf(e: ConvEvent): bigint | null {
  return e.pos && /^\d+$/.test(e.pos) ? BigInt(e.pos) : null;
}

/** Union by id (newer copy wins), in conversation order. */
function mergeEvents(old: ConvEvent[], add: ConvEvent[]): ConvEvent[] {
  const byId = new Map(old.map((e) => [e.id, e]));
  for (const e of add) byId.set(e.id, e);
  return [...byId.values()]
    .sort((a, b) => {
      const ap = posOf(a);
      const bp = posOf(b);
      if (ap !== null && bp !== null) return ap < bp ? -1 : ap > bp ? 1 : 0;
      return (a.pos ?? String(a.ts)).localeCompare(b.pos ?? String(b.ts));
    })
    .slice(-KEEP_EVENTS);
}

function workedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "刚开始";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分钟` : m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${Math.floor(m / 60)} 小时`;
}

/** Under the newest message while the agent works: the busy mascot on a soft card, and for how long. */
function WorkingBadge({ since, now }: { since?: number; now: number }) {
  const p = usePalette();
  const c = statusColors("working", p.dark);
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", paddingTop: space.md }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          backgroundColor: p.surface,
          borderRadius: radius.card,
          paddingLeft: space.sm,
          paddingRight: space.lg,
          paddingVertical: 6,
          borderWidth: 1,
          borderColor: p.dark ? p.surface3 : "#F6DDE8",
          elevation: p.dark ? 0 : 1,
          shadowColor: p.shadow,
          shadowOpacity: 0.1,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
        }}
      >
        <BusyMascot size={44} />
        <View style={{ width: 1, alignSelf: "stretch", marginVertical: 4, backgroundColor: p.divider }} />
        <View style={{ gap: 1 }}>
          <Text style={{ fontFamily: fonts.cute, fontSize: 15.5, color: p.accentText }}>正在干活</Text>
          <Text style={{ color: p.muted, fontSize: 12, fontFamily: fonts.bodySemi }}>{since ? workedFor(now - since) : "刚开始"}</Text>
        </View>
        <View style={{ marginLeft: space.xs }}>
          <TypingDots color={c.fg} />
        </View>
      </View>
    </View>
  );
}

/** Small round floating button for the chat's "到开头 / 到最新" jumps. */
function JumpButton({ icon, label, badge, onPress }: { icon: "arrow-collapse-up" | "arrow-collapse-down"; label: string; badge?: number; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? p.surface3 : p.surface,
        borderWidth: 1,
        borderColor: p.divider,
        shadowColor: p.shadow,
        shadowOpacity: p.dark ? 0 : 0.18,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
        elevation: p.dark ? 0 : 3,
      })}
    >
      <MaterialCommunityIcons name={icon} size={20} color={p.ink} />
      {badge ? (
        <View style={{ position: "absolute", top: -6, right: -6, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: p.primary }}>
          <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 11 }}>{badge > 99 ? "99+" : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
