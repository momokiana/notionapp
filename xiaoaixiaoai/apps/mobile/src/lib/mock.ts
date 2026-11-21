/**
 * In-memory fake relay used when the server URL is `mock://demo`.
 * Lets the whole UI be demoed without a relay or a computer.
 */
import {
  PUT_LIMITS, DSH_ARCHIVE, DSH_UNFILED, DSH_DIRECTORY_PAGE_SIZE, isRuntimeRequestId, RUNTIME_SESSION_TEXT_LIMIT,
  type DshDirectoryEntry, type DshDirectoryReply, type DshDirectoryRequest,
  agentKey,
  pairLink,
  rowsChange,
  type Agent,
  type AssistantConfirm,
  type AssistantItem,
  type AssistantMemoryItem,
  type AssistantPersonaConfig,
  type AssistantState,
  type MemoryCategory,
  type PersonaPresetSummary,
  type Reminder,
  type AgentStatus,
  type ConvEvent,
  type Device,
  type DeviceKind,
  type JoinRequest,
  type Notice,
  type PairCode,
  type PairResponse,
  type RpcMethod,
  type SubSession,
  type TerminalRowsEvent,
  type TerminalStreamParams,
} from "@xiaoaixiaoai/protocol";
import { useLive } from "./store";
import { isWide } from "./ansi";
import type { Link } from "./relay";

export function isMockServer(server: string | null | undefined): boolean {
  return !!server && server.startsWith("mock://");
}

/** What demo invite links point at: a placeholder address, so screenshots show nothing real. */
export const MOCK_PUBLIC_URL = "https://xiaoaixiaoai.example.com";

const now = () => Date.now();
const MIN = 60_000;

const HOST_A = "dev_macbook";
const HOST_B = "dev_cloud_vps";

function makeDevices(): Device[] {
  const t = now();
  return [
    { id: HOST_A, name: "我的 MacBook", kind: "host", platform: "darwin", online: true, createdAt: t - 9 * 86_400_000, lastSeenAt: t, sources: ["hc", "herdr", "uniflo", "runtime-sessions", "dsh-directory"], version: "0.1.7" },
    { id: HOST_B, name: "云服务器", kind: "host", platform: "linux", online: true, createdAt: t - 4 * 86_400_000, lastSeenAt: t - 20_000, sources: ["hc", "uniflo"], version: "0.1.0" },
    { id: "dev_pad", name: "我的平板", kind: "viewer", platform: "android", online: false, createdAt: t - 2 * 86_400_000, lastSeenAt: t - 5 * 3_600_000 },
  ];
}

function demoDirectory(q: DshDirectoryRequest): DshDirectoryReply {
  const demo = { id: "demo-dsh", title: "WSL 演示项目" };
  const ui = { id: "demo-ui", title: "界面演示项目" };
  const archive = { id: DSH_ARCHIVE, title: "已归档" };
  const unfiled = { id: DSH_UNFILED, title: "未分组" };
  const examples: DshDirectoryEntry[] = [
    { project: demo, archived: false, session: { id: "dsh-demo-session", title: "演示：检查项目布局", state: "idle", canSend: true } },
    { project: ui, archived: false, session: { id: "dsh-demo-ui", title: "演示：预览星海主题", state: "running", canSend: true } },
    { project: archive, archived: true, session: { id: "dsh-demo-archive", title: "演示：旧版打包记录", state: "inactive", canSend: false } },
    { project: unfiled, archived: false, session: { id: "dsh-demo-unfiled", title: "演示：未分组笔记", state: "idle", canSend: true } },
    ...Array.from({ length: 36 }, (_, i): DshDirectoryEntry => ({ project: demo, archived: false,
      session: { id: `example-${String(i + 1).padStart(2, "0")}`, title: `演示任务 ${i + 1}`, state: "inactive", canSend: false } })),
  ];
  const scope = "profile";
  function page<T>(rows: T[], id: (x: T) => string, after?: string) {
    const sorted = rows.filter((x) => !after || id(x) > after).sort((a, b) => id(a) < id(b) ? -1 : 1);
    const part = sorted.slice(0, DSH_DIRECTORY_PAGE_SIZE);
    return { part, next: sorted.length > part.length ? id(part[part.length - 1]!) : undefined };
  }
  if (q.view === "projects") {
    const p = page([demo, ui, archive, unfiled], (x) => x.id, q.after);
    return { view: q.view, scope, projects: p.part, next: p.next };
  }
  if (q.view === "exact") return { view: q.view, scope, entries: examples.filter((x) => q.sessionIds.includes(x.session.id)) };
  const phrase = q.search?.trim().toLowerCase();
  const p = page(examples.filter((x) => (!q.projectId || q.projectId === x.project.id) &&
    (!phrase || [x.project.title, x.project.id, x.session.title, x.session.id].some((s) => s.toLowerCase().includes(phrase)))), (x) => x.session.id, q.after);
  return { view: q.view, scope, entries: p.part, next: p.next };
}

function ag(
  deviceId: string,
  localId: string,
  harness: string,
  status: AgentStatus,
  title: string,
  where: string,
  cwd: string,
  ago: number,
  extra: Partial<Agent> = {},
): Agent {
  return {
    key: agentKey(deviceId, "hc", localId),
    deviceId,
    source: "hc",
    localId,
    harness,
    title,
    where,
    cwd,
    status,
    statusSince: now() - ago,
    turn: extra.turn ?? 3,
    isShell: false,
    updatedAt: now() - ago,
    ...extra,
  };
}

const mark = (d: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="${d}"/></svg>`;
/** Demo answers for `harness.icons`: plain placeholder shapes, not anyone's logo. */
const MOCK_MARKS: Record<string, string> = {
  workbuddy: mark("M8 4h8a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4zm1.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"),
  factory: mark("M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"),
};

function makeAgents(): Agent[] {
  return [
    ag(HOST_A, "t47", "claude-code", "blocked", "要不要删掉旧的迁移脚本？", "和弦本 / 1", "/Users/me/code/chord-book", 2 * MIN, {
      sessionKey: "claude:demo-1", model: "claude-opus-5-5", turn: 14, costUsd: 1.58, contextTokens: 112_811, contextLimit: 1_000_000,
      preview: "把和弦图组件改成可以左右滑动切换的", subagents: 2, subagentsWorking: 1,
    }),
    ag(HOST_A, "t4f", "claude-code", "working", "桌宠动画改用 Rust 渲染", "桌面宠物 / 1", "/Users/me/code/desk-pet", 40_000, {
      sessionKey: "claude:demo-2", model: "claude-opus-5-5", turn: 20, costUsd: 0.92, contextTokens: 64_200, contextLimit: 1_000_000,
      queued: 1, queuedText: "渲染完了顺便把帧率打到日志里", queuedSince: now() - 25_000,
    }),
    ag(HOST_A, "t4m", "omp", "working", "博客平台 登录鉴权重构", "博客平台 / 1", "/Users/me/code/blog-platform", 3 * MIN, { sessionKey: "omp:demo-3", model: "gpt-5.5", turn: 2 }),
    ag(HOST_A, "t4q", "omp", "done", "notes-cli 0.2.8 发布检查", "notes-cli / 1", "/Users/me/code/notes-cli", 25 * MIN, { sessionKey: "omp:demo-4", turn: 6 }),
    ag(HOST_A, "t52", "codex", "idle", "API 网关用量面板", "api-gateway / 2", "/Users/me/code/api-gateway", 70 * MIN, {
      model: "gpt-6.2-sol",
      turn: 1,
      modelQuota: { available: true, primary: { remainingPercent: 21, windowMinutes: 10080, resetsAt: now() + 3 * 3_600_000, label: "7天" }, balance: "25422.92" },
    }),
    // Harnesses without a sticker: bundled glyph (qodercli, kiro-cli), or a mark the computer sends (workbuddy, droid).
    ag(HOST_A, "t5a", "qodercli", "idle", "README 中英对照", "notes-cli / 3", "/Users/me/code/notes-cli", 95 * MIN, { turn: 2 }),
    ag(HOST_A, "t5b", "kiro-cli", "idle", "接口文档补全", "api-gateway / 3", "/Users/me/code/api-gateway", 2 * 3_600_000, { turn: 4 }),
    ag(HOST_A, "t5c", "workbuddy", "idle", "周报整理", "杂事 / 1", "/Users/me/Documents", 3 * 3_600_000, { turn: 1 }),
    ag(HOST_B, "t10", "droid", "idle", "备份脚本加重试", "运维 / 3", "/srv/ops", 4 * 3_600_000, { turn: 3 }),
    ag(HOST_A, "t4v", "sh", "idle", "zsh", "notes-cli / 2", "/Users/me/code/notes-cli", 3 * 3_600_000, { isShell: true, turn: 0 }),
    ag(HOST_B, "t3", "opencode", "working", "日志清理脚本影响范围评估", "运维 / 1", "/srv/ops", 90_000, { sessionKey: "opencode:demo-5", turn: 5 }),
    ag(HOST_B, "t5", "gemini", "done", "Nginx 证书自动续期", "运维 / 2", "/srv/ops", 50 * MIN, { turn: 2 }),
    ag(HOST_B, "t8", "claude-code", "blocked", "确认是否重启 relay 服务", "xiaoaixiaoai / 1", "/srv/xiaoaixiaoai", 6 * MIN, { sessionKey: "claude:demo-6", turn: 3 }),
    ag(HOST_B, "t9", "claude-code", "blocked", "整理发布说明", "xiaoaixiaoai / 2", "/srv/xiaoaixiaoai", 3 * MIN, {
      turn: 2,
      errored: true,
      statusNote: "API Error: 529 overloaded. The model is busy right now; try again in a moment.",
    }),
  ];
}

function conversation(session: string): ConvEvent[] {
  const t0 = now() - 12 * MIN;
  let i = 0;
  const e = (body: Record<string, unknown>, dt: number): ConvEvent => ({ id: `${session}#${i++}`, session, ts: t0 + dt, ...body }) as ConvEvent;
  return [
    e({ kind: "turn_start" }, 0),
    e({ kind: "user_message", text: "把和弦图组件改成可以左右滑动切换的，顺便把旧的迁移脚本清理掉" }, 1000),
    e({ kind: "reasoning", text: "先看一下和弦图组件现在是怎么渲染的，再找出迁移脚本目录里哪些已经不用了。" }, 4000),
    e({ kind: "tool_call", call_id: "c1", name: "Bash", input: { command: "rg -l ChordDiagram src/ | head" } }, 6000),
    e({ kind: "tool_call", call_id: "c0", name: "Task", input: { description: "找出不再被引用的迁移脚本", subagent_type: "Explore" } }, 6500),
    e({ kind: "tool_result", call_id: "c0", name: "Task", output: "找到 3 个没有被任何代码或配置引用的迁移脚本。", is_error: false }, 7500),
    e({ kind: "tool_call", call_id: "c0b", name: "Task", input: { description: "检查和弦图滑动的无障碍标签", subagent_type: "general-purpose" } }, 7600),
    e({ kind: "tool_result", call_id: "c1", name: "Bash", output: "src/components/ChordDiagram.tsx\nsrc/screens/SongScreen.tsx\nsrc/screens/PracticeScreen.tsx", is_error: false }, 8000),
    e({ kind: "tool_call", call_id: "c2", name: "Edit", input: { file_path: "src/components/ChordDiagram.tsx", old_string: "<View>", new_string: "<PagerView>" } }, 20_000),
    e({ kind: "tool_result", call_id: "c2", name: "Edit", output: "The file src/components/ChordDiagram.tsx has been updated.", is_error: false }, 21_000),
    e({ kind: "tool_call", call_id: "c3", name: "Bash", input: { command: "pnpm test ChordDiagram" } }, 40_000),
    e({ kind: "tool_result", call_id: "c3", name: "Bash", output: "FAIL src/components/ChordDiagram.test.tsx\n  ✕ swipes to next chord (32 ms)\n    Expected index 1, received 0", is_error: true }, 52_000),
    e({ kind: "tool_call", call_id: "c4", name: "Edit", input: { file_path: "src/components/ChordDiagram.tsx", old_string: "onPageSelected", new_string: "onPageSelected={(e) => setIndex(e.nativeEvent.position)}" } }, 70_000),
    e({ kind: "tool_result", call_id: "c4", name: "Edit", output: "The file has been updated.", is_error: false }, 71_000),
    e({ kind: "tool_call", call_id: "c5", name: "Bash", input: { command: "pnpm test ChordDiagram" } }, 80_000),
    e({ kind: "tool_result", call_id: "c5", name: "Bash", output: "PASS src/components/ChordDiagram.test.tsx\n  ✓ renders chord name (12 ms)\n  ✓ swipes to next chord (28 ms)", is_error: false }, 92_000),
    e({
      kind: "assistant_message",
      text:
        "和弦图现在可以**左右滑动**切换了，测试也通过了：\n\n- `ChordDiagram` 改用 `PagerView`，滑动时同步当前和弦\n- 补了一个滑动测试\n\n迁移脚本那边我找到 **3 个** 已经不再被引用的文件：\n\n```\nmigrations/2025-03-legacy-tabs.sql\nmigrations/2025-04-tmp-fix.sql\nmigrations/2025-05-rollback.sql\n```\n\n要不要删掉？删除后不能自动恢复。",
    }, 100_000),
    e({ kind: "turn_end", reason: "waiting_for_user" }, 101_000),
  ];
}

const SUBS: Record<string, { parent: string; info: Omit<SubSession, "key" | "parent"> }> = {
  "claude:demo-1/agent-a1": {
    parent: "claude:demo-1",
    info: { parentCall: "c0", harness: "claude-code", title: "找出不再被引用的迁移脚本", preview: "在 migrations/ 里找出没有被代码或配置引用的 SQL 文件，列出路径和最后修改时间", model: "claude-sonnet-5-5", status: "idle", statusSince: now() - 9 * MIN, startedAt: now() - 11 * MIN, updatedAt: now() - 9 * MIN, costUsd: 0.21, children: 1 },
  },
  "claude:demo-1/agent-b2": {
    parent: "claude:demo-1",
    info: { parentCall: "c0b", harness: "claude-code", title: "检查和弦图滑动的无障碍标签", preview: "确认 ChordDiagram 的每一页都有读屏标签，左右滑动时会读出当前和弦", model: "claude-haiku-5-5", status: "working", statusSince: now() - 40_000, startedAt: now() - 2 * MIN, updatedAt: now() - 20_000, costUsd: 0.04, children: 0 },
  },
  "claude:demo-1/agent-a1/agent-g1": {
    parent: "claude:demo-1/agent-a1",
    info: { parentCall: "a2", harness: "claude-code", title: "核对 CI 配置里的迁移引用", preview: "在 .github/workflows 和 scripts/ 里搜这 3 个迁移文件名，确认没有被部署脚本用到", model: "claude-haiku-5-5", status: "idle", statusSince: now() - 10 * MIN, startedAt: now() - 10.5 * MIN, updatedAt: now() - 10 * MIN, costUsd: 0.01, children: 0 },
  },
};

function subChildren(parent: string): SubSession[] {
  return Object.entries(SUBS)
    .filter(([, v]) => v.parent === parent)
    .map(([key, v]) => ({ key, parent: v.parent, ...v.info }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function subConversation(sub: string): ConvEvent[] {
  const s = SUBS[sub];
  const t0 = now() - 11 * MIN;
  let i = 0;
  const e = (body: Record<string, unknown>, dt: number): ConvEvent => ({ id: `${sub}#${i++}`, session: sub, ts: t0 + dt, ...body }) as ConvEvent;
  const out: ConvEvent[] = [
    e({ kind: "user_message", text: s?.info.preview ?? "" }, 0),
    e({ kind: "tool_call", call_id: "a1", name: "Grep", input: { pattern: "2025-0[345]-", path: "." } }, 3000),
    e({ kind: "tool_result", call_id: "a1", name: "Grep", output: "migrations/2025-03-legacy-tabs.sql\nmigrations/2025-04-tmp-fix.sql\nmigrations/2025-05-rollback.sql", is_error: false }, 5000),
  ];
  if (s?.info.children) {
    out.push(
      e({ kind: "tool_call", call_id: "a2", name: "Task", input: { description: "核对 CI 配置里的迁移引用" } }, 8000),
      e({ kind: "tool_result", call_id: "a2", name: "Task", output: "CI 和部署脚本里都没有引用。", is_error: false }, 20_000),
    );
  }
  out.push(e({ kind: "assistant_message", text: "这 3 个文件都**没有被引用**。其中 `2025-04-tmp-fix.sql` 是临时补丁，**已被后续迁移覆盖。**可以放心删除。" }, 30_000));
  return out;
}

/** Older demo turns so paging / "到开头" can be tried in the demo. */
function history(session: string): ConvEvent[] {
  const out: ConvEvent[] = [];
  const t0 = now() - 6 * 3_600_000;
  const topics = ["调一下调音器的灵敏度", "曲谱页加个夜间模式", "节拍器支持 7/8 拍", "修一下横屏时和弦图被裁掉", "录音按钮加长按确认"];
  for (let k = 0; k < 70; k++) {
    const t = topics[k % topics.length]!;
    const ts = t0 + k * 4 * MIN;
    out.push(
      { id: `${session}#h${k}u`, session, ts, kind: "user_message", text: `第 ${k + 1} 件事：${t}` } as ConvEvent,
      { id: `${session}#h${k}a`, session, ts: ts + 60_000, kind: "assistant_message", text: `好的，**${t}**已经改好，测试通过。` } as ConvEvent,
      { id: `${session}#h${k}e`, session, ts: ts + 61_000, kind: "turn_end" } as ConvEvent,
    );
  }
  return out;
}

/** Page like hostd: newest `limit` events, or the `limit` before `before` (a position index). */
function page(all: ConvEvent[], limit: number, before?: string) {
  const withPos = all.map((e, i) => ({ ...e, pos: String(i) }));
  const end = before != null ? Math.max(0, Number(before)) : withPos.length;
  const start = Math.max(0, end - limit);
  return { events: withPos.slice(start, end), more: start > 0, nextBefore: start > 0 ? String(start) : null };
}

const TERMINAL = `╭──────────────────────────────────────────╮
│ ✻ Claude Code                            │
│   cwd: ~/code/chord-book                 │
╰──────────────────────────────────────────╯

> 把和弦图组件改成可以左右滑动切换的

● Bash(pnpm test ChordDiagram)
  ⎿  PASS src/components/ChordDiagram.test.tsx
     ✓ renders chord name (12 ms)
     ✓ swipes to next chord (28 ms)

● 和弦图现在可以左右滑动切换了。

  迁移脚本里有 3 个不再被引用的文件：
    migrations/2025-03-legacy-tabs.sql
    migrations/2025-04-tmp-fix.sql
    migrations/2025-05-rollback.sql

  要不要删掉？

 ╭────────────────────────────────────────╮
 │ ❯ 1. 是，删除这 3 个文件               │
 │   2. 否，先保留                         │
 ╰────────────────────────────────────────╯
`;

const E = "\x1b[";
/** Pad `inner` (may contain SGR) to `cells` columns, counting wide chars as 2. */
function boxRow(edge: string, inner: string, cells: number): string {
  const plain = inner.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return `${edge}│${E}0m${inner}${" ".repeat(Math.max(0, cells - w))}${edge}│${E}0m`;
}
/** Same screen with SGR colours, like hostd's `ansi` field. */
const TERMINAL_ANSI = [
  `${E}38;5;209m╭──────────────────────────────────────────╮${E}0m`,
  boxRow(`${E}38;5;209m`, ` ${E}38;5;209m✻${E}0m ${E}1mClaude Code${E}0m`, 42),
  boxRow(`${E}38;5;209m`, `   ${E}2mcwd: ~/code/chord-book${E}0m`, 42),
  `${E}38;5;209m╰──────────────────────────────────────────╯${E}0m`,
  "",
  `${E}2m>${E}0m 把和弦图组件改成可以左右滑动切换的`,
  "",
  `${E}32m●${E}0m ${E}1mBash${E}0m(pnpm test ChordDiagram)`,
  `  ${E}2m⎿${E}0m  ${E}42;30m PASS ${E}0m ChordDiagram.test.tsx`,
  `     ${E}32m✓${E}0m renders chord name ${E}2m(12 ms)${E}0m`,
  `     ${E}32m✓${E}0m swipes to next chord ${E}2m(28 ms)${E}0m`,
  "",
  `${E}37m●${E}0m 和弦图现在可以${E}1m左右滑动${E}0m切换了。`,
  "",
  "  迁移脚本里有 3 个不再被引用的文件：",
  `    ${E}36mmigrations/2025-03-legacy-tabs.sql${E}0m`,
  `    ${E}36mmigrations/2025-04-tmp-fix.sql${E}0m`,
  `    ${E}36mmigrations/2025-05-rollback.sql${E}0m`,
  "",
  "  要不要删掉？",
  "",
  ` ${E}38;2;255;143;179m╭────────────────────────────────────────╮${E}0m`,
  " " + boxRow(`${E}38;2;255;143;179m`, ` ${E}7m> 1. 是，删除这 3 个文件${E}27m`, 40),
  " " + boxRow(`${E}38;2;255;143;179m`, `   2. 否，先保留`, 40),
  ` ${E}38;2;255;143;179m╰────────────────────────────────────────╯${E}0m`,
  "",
  "",
].join("\n");

let devices: Device[] = [];
let agents: Agent[] = [];
/** Messages typed in the demo, echoed back into the conversation like a real session would. */
let sent: Record<string, ConvEvent[]> = {};
/** What direct typing put on each demo terminal's input line. */
let typed: Record<string, string> = {};

function typeInto(agent: string, data: string) {
  let line = Array.from(typed[agent] ?? "");
  // Arrows and other escape sequences move a cursor the demo does not draw.
  for (const ch of Array.from(data.replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1b/g, ""))) {
    if (ch === "\x7f") line = line.slice(0, -1);
    else if (ch === "\r") line = [];
    else if (ch < " ") line.push("^", String.fromCharCode(ch.charCodeAt(0) + 64));
    else line.push(ch);
  }
  typed[agent] = line.slice(-40).join("");
}

// A message sent in the demo plays out live, like on a real computer: the send
// queue reports it typed in, it shows up in the conversation a moment later, the
// agent starts working, thinks, answers and stops. Sent to a working agent, it
// waits ("排队中") until that turn ends. A message with "失败" in it fails once,
// so the retry on its bubble can be tried.

/** Live listeners of the demo streams: conversations by session, send queues by agent. */
const sessionSinks = new Map<string, Set<(event: unknown) => void>>();
const queueSinks = new Map<string, Set<(event: unknown) => void>>();
/** Text typed into a working demo agent, taken when its turn ends. */
let held: Record<string, string[]> = {};
/** Demo agents in a turn the demo itself will finish. */
const inTurn = new Set<string>();
const failedOnce = new Set<string>();
let timers: ReturnType<typeof setTimeout>[] = [];
let queueSeq = 0;

function later(ms: number, run: () => void) {
  timers.push(setTimeout(run, ms));
}

function listen(sinks: Map<string, Set<(event: unknown) => void>>, key: string, onEvent: (event: unknown) => void) {
  const set = sinks.get(key) ?? new Set();
  set.add(onEvent);
  sinks.set(key, set);
  return () => {
    set.delete(onEvent);
  };
}

function baseConversation(session: string): ConvEvent[] {
  return session === "claude:demo-1" ? [...history(session), ...conversation(session)] : conversation(session);
}

/** Adds an event to a demo conversation and streams it, at the position the page query gives it too. */
function say(agentKey: string, body: Record<string, unknown>) {
  const session = agents.find((x) => x.key === agentKey)?.sessionKey;
  if (!session) return;
  const list = (sent[session] ??= []);
  const e = { id: `${session}#sent${list.length}`, session, ts: now(), ...body } as ConvEvent;
  list.push(e);
  const pos = String(baseConversation(session).length + list.length - 1);
  for (const sink of sessionSinks.get(session) ?? []) sink({ kind: "session", event: { ...e, pos }, at: now() });
}

function setAgent(key: string, patch: Partial<Agent>) {
  agents = agents.map((x) => (x.key === key ? { ...x, ...patch } : x));
  publish();
}

function demoReply(text: string): string {
  const words = Array.from(text.split("\n")[0]!.trim());
  const clip = words.length > 24 ? `${words.slice(0, 24).join("")}…` : words.join("");
  return clip ? `收到：**${clip}**\n\n这是演示里的回复，真的 agent 会在这里接着干活，做完再回你。` : "收到图片了。这是演示里的回复。";
}

/** One demo turn: the message shows up, the agent starts working, thinks, answers and stops. */
function demoTurn(key: string, text: string) {
  inTurn.add(key);
  later(800, () => say(key, { kind: "user_message", text }));
  later(1600, () => setAgent(key, { status: "working", statusSince: now(), errored: undefined, statusNote: undefined }));
  later(3200, () => say(key, { kind: "reasoning", text: "先看看现在的代码是怎么写的，再动手。" }));
  later(6000, () => {
    say(key, { kind: "assistant_message", text: demoReply(text) });
    say(key, { kind: "turn_end", reason: "waiting_for_user" });
    endTurn(key);
  });
}

/** The turn ends; text that waited in the input box starts the next one. */
function endTurn(key: string) {
  inTurn.delete(key);
  const next = held[key]?.shift();
  const left = held[key]?.length ?? 0;
  setAgent(key, { status: "done", statusSince: now(), queued: left || undefined, queuedText: left ? held[key]![0] : undefined, queuedSince: left ? now() : undefined });
  if (next !== undefined) demoTurn(key, next);
}

function demoSend(key: string, text: string) {
  const a = agents.find((x) => x.key === key);
  if (!a) throw new Error("not_found");
  if (/失败/.test(text) && !failedOnce.has(text)) {
    failedOnce.add(text);
    throw new Error("演示：这条故意没发出去，点重发");
  }
  const queueId = `mq${++queueSeq}`;
  later(120, () => queueSinks.get(key)?.forEach((sink) => sink({ kind: "queue", queueId, status: "sending", position: 0, at: now() })));
  later(450, () => queueSinks.get(key)?.forEach((sink) => sink({ kind: "queue", queueId, status: "sent", position: 0, at: now() })));
  // Like Claude Code: text typed during a turn waits in the input box until the turn ends.
  if (a.status === "working" || inTurn.has(key)) {
    (held[key] ??= []).push(text);
    setAgent(key, { queued: (a.queued ?? 0) + 1, queuedText: a.queuedText ?? text, queuedSince: a.queuedSince ?? now() });
    // The demo's own long-running agents wrap up their turn soon, so the wait can be seen ending.
    if (!inTurn.has(key)) {
      inTurn.add(key);
      later(8000, () => endTurn(key));
    }
    return { ok: true, queueId, position: 0, agentStatus: a.status, waiting: true };
  }
  demoTurn(key, text);
  return { ok: true, queueId, position: 0, agentStatus: a.status, waiting: false };
}

/** The demo screen, with the typed line under it like a program's input box. */
function screen(agent: string | undefined) {
  const t = agent ? typed[agent] : "";
  if (!t) return { text: TERMINAL, ansi: TERMINAL_ANSI };
  return { text: `${TERMINAL}> ${t}\n`, ansi: `${TERMINAL_ANSI}${E}38;2;255;143;179m>${E}0m ${t}${E}7m ${E}0m` };
}

const LAUNCHERS = [
  { id: "claude", label: "Claude Code", takesTask: true },
  { id: "codex", label: "Codex", takesTask: true },
  { id: "omp", label: "omp", takesTask: true },
  { id: "opencode", label: "OpenCode", takesTask: true },
  { id: "gemini", label: "Gemini", takesTask: true },
  { id: "shell", label: "终端", takesTask: false },
];
const DEMO_SPACES = [
  { id: "w1", name: "和弦本", folder: "~/code/chord-book", tabs: 1, terminals: 1 },
  { id: "w2", name: "桌面宠物", folder: "~/code/desk-pet", tabs: 1, terminals: 1 },
  { id: "w3", name: "博客平台", folder: "~/code/blog-platform", tabs: 1, terminals: 1 },
  { id: "w4", name: "notes-cli", folder: "~/code/notes-cli", tabs: 2, terminals: 2 },
];

function publish() {
  const byHost: Record<string, Agent[]> = {};
  for (const a of agents) (byHost[a.deviceId] ??= []).push(a);
  useLive.setState({ devices: Object.fromEntries(devices.map((d) => [d.id, d])), agents: byHost });
}

export function mockLink(): Link {
  devices = makeDevices();
  agents = makeAgents();
  sent = {};
  typed = {};
  held = {};
  inTurn.clear();
  failedOnce.clear();
  const self: Device = { id: "dev_this_phone", name: "我的手机", kind: "viewer", platform: "android", online: true, createdAt: now(), lastSeenAt: now() };
  devices.push(self);
  useLive.setState({ link: "connecting" });
  const boot = setTimeout(() => {
    useLive.setState({ self, link: "online", rttMs: 38 });
    publish();
  }, 350);
  // Gentle liveliness: the working agent's turn ticks.
  const tick = setInterval(() => {
    agents = agents.map((a) => (a.status === "working" ? { ...a, updatedAt: now() } : a));
    publish();
  }, 8000);
  return {
    async call(_to: string, method: RpcMethod, params: unknown) {
      await new Promise((r) => setTimeout(r, 180));
      const p = (params ?? {}) as { agent?: string; sub?: string; text?: string; keys?: string[]; before?: string; limit?: number; space?: string; spaceName?: string; folder?: string; launcher?: string; task?: string };
      switch (method) {
        case "runtimeSessions.browse": {
          if (_to !== HOST_A) throw new Error("演示电脑不支持 DSH 目录");
          return demoDirectory(params as DshDirectoryRequest);
        }
        case "runtimeSessions.list":
          return {
            runtimes: [{ runtime: "dsh", online: true }, { runtime: "codex", online: true }, { runtime: "antigravity", online: true }],
            projects: [
              { runtime: "dsh", id: "demo-dsh", title: "WSL 演示项目", sessions: [{ id: "dsh-demo-session", title: "演示：检查项目布局", state: "attention", canSend: true }] },
              { runtime: "codex", id: "demo-codex", title: "Windows 演示项目", sessions: [{ id: "codex-demo-session", title: "演示：查看运行状态", state: "running", canSend: false }] },
              { runtime: "antigravity", id: "demo-ag", title: "Antigravity 演示工程", sessions: [{ id: "ag-demo-session", title: "演示：查看对话历史", state: "idle", canSend: false }] },
            ],
          };
        case "runtimeSessions.detail": {
          const d = params as { runtime?: "dsh" | "codex" | "antigravity"; projectId?: string; sessionId?: string };
          return {
            runtime: d.runtime ?? "dsh",
            project: { id: d.projectId ?? "demo-dsh", title: d.runtime === "codex" ? "Windows 演示项目" : d.runtime === "antigravity" ? "Antigravity 演示工程" : "WSL 演示项目" },
            session: { id: d.sessionId ?? "dsh-demo-session", title: "演示会话详情", state: d.runtime === "dsh" ? "attention" : "idle", canSend: d.runtime === "dsh" },
            messages: [
              { id: "m1", role: "user", text: "检查项目构建并汇报可选项。", ts: now() - 90_000 },
              { id: "m2", role: "tool", text: "ask_user_question（完成）", ts: now() - 60_000, toolName: "ask_user_question", isError: false },
              { id: "m3", role: "assistant", text: "检查完成了，你可以直接在这里确认构建方案。", ts: now() - 30_000 },
            ],
            pendingQuestions: d.runtime === "dsh" ? [{
              callId: "demo-q-1",
              state: "open" as const,
              questions: [{ id: "q1", header: "发布确认", question: "先构建哪一版安装包？", options: [{ label: "ARM64 正式包", description: "适合真机升级" }, { label: "仅检查类型", description: "不导出安装包" }], multiSelect: false }],
            }] : [],
            ...(d.runtime === "antigravity" ? { readOnlyReason: "Antigravity 会话在演示模式下仅支持查看。" } : {}),
          };
        }
        case "runtimeSessions.answer": {
          const a = params as { requestId?: string };
          return { accepted: true, requestId: isRuntimeRequestId(a.requestId) ? a.requestId.toLowerCase() : "00000000-0000-4000-8000-000000000000" };
        }
        case "runtimeSessions.send": {
          const t = params as { runtime?: string; projectId?: string; sessionId?: string; requestId?: string; input?: string };
          if (_to !== HOST_A || t.runtime !== "dsh" || typeof t.sessionId !== "string" || !isRuntimeRequestId(t.requestId) ||
              typeof t.input !== "string" || !t.input.trim() || t.input.length > RUNTIME_SESSION_TEXT_LIMIT || /[\0\uD800-\uDFFF]/u.test(t.input)) throw new Error("演示会话未授权发送");
          const target = demoDirectory({ view: "exact", sessionIds: [t.sessionId] });
          if (target.view !== "exact" || !target.entries.some((e) => !e.archived && e.project.id === t.projectId && e.session.canSend)) throw new Error("演示会话未授权发送");
          return { accepted: true, requestId: t.requestId.toLowerCase() };
        }
        case "agents.list":
          return { agents };
        case "terminal.read":
          return { ...screen(p.agent), cols: 46, rows: 28, how: "screen", complete: true };
        case "terminal.send":
          return demoSend(p.agent ?? "", p.text ?? "");
        case "terminal.keys":
          agents = agents.map((a) => (a.key === p.agent && a.status === "blocked" ? { ...a, status: "working", statusSince: now(), errored: undefined, statusNote: undefined } : a));
          publish();
          return { ok: true };
        case "terminal.put": {
          // Like `hc put`: each picture lands in the terminal's own folder on its computer.
          const files = (p as { files?: { name?: string }[] }).files ?? [];
          if (!files.length || files.length > PUT_LIMITS.files) throw new Error(`一次可以发 1 到 ${PUT_LIMITS.files} 张图片`);
          const local = agents.find((x) => x.key === p.agent)?.localId ?? "t1";
          return { paths: files.map((f, i) => `/Users/demo/.local/state/herdr-core/default/files/${local}/${(f.name ?? "").replace(/[^A-Za-z0-9._-]+/g, "-") || `image-${i + 1}.jpg`}`) };
        }
        case "terminal.input":
          if (p.agent && typeof (p as { data?: unknown }).data === "string") typeInto(p.agent, (p as { data: string }).data);
          return { ok: true };
        case "session.events": {
          const a = agents.find((x) => x.key === p.agent);
          if (p.sub) {
            if (!SUBS[p.sub]) throw new Error("forbidden");
            return { sessionKey: p.sub, events: p.before ? [] : subConversation(p.sub), more: false };
          }
          if (!a?.sessionKey) return { sessionKey: null, events: [], more: false };
          return { sessionKey: a.sessionKey, ...page([...baseConversation(a.sessionKey), ...(sent[a.sessionKey] ?? [])], p.limit ?? 120, p.before) };
        }
        case "session.children": {
          const a = agents.find((x) => x.key === p.agent);
          if (!a?.sessionKey) return { sessions: [] };
          return { sessions: subChildren(p.sub ?? a.sessionKey) };
        }
        case "spaces.list": {
          if (_to === HOST_B) return { spaces: [{ id: "w9", name: "运维", folder: "/srv/ops", tabs: 2, terminals: 2 }], launchers: LAUNCHERS.slice(0, 3), folders: ["/srv/ops", "/srv/xiaoaixiaoai"], canCreate: false, reason: "这台电脑上的 herdr 窗口没打开，打开后才能新建。" };
          return { spaces: DEMO_SPACES, launchers: LAUNCHERS, folders: ["~/code/chord-book", "~/code/blog-platform", "~/code/notes-cli", "~"], canCreate: true, typesTask: true };
        }
        case "agent.create": {
          const launcher = LAUNCHERS.find((l) => l.id === p.launcher);
          if (!launcher) throw new Error("没有这个程序");
          const sp = p.space ? DEMO_SPACES.find((x) => x.id === p.space) : undefined;
          if (p.space && !sp) throw new Error("这个空间已经不在了，刷新一下再试");
          const folder = p.folder || sp?.folder || "~";
          const spaceName = sp?.name ?? (p.spaceName?.trim() || folder.split("/").filter(Boolean).pop() || "~");
          const localId = `t${Math.floor(Math.random() * 900 + 100)}`;
          const a = ag(HOST_A, localId, launcher.id === "shell" ? "sh" : launcher.id, p.task ? "working" : "idle", p.task?.split("\n")[0] || `新的 ${launcher.label}`, `${spaceName} / ${(sp?.tabs ?? 0) + 1}`, folder, 0, { isShell: launcher.id === "shell", turn: 0 });
          // Like the real host: the agent shows up in agents.list a moment later.
          setTimeout(() => {
            agents = [...agents, a];
            publish();
          }, 1500);
          // Like a current host: a task goes in at start, or is typed in once the program is up (never into a shell).
          const task = p.task ? (launcher.id === "shell" ? ("failed" as const) : launcher.takesTask ? ("started" as const) : ("typed" as const)) : undefined;
          return { agent: a.key, space: sp?.id ?? "w-new", terminal: localId, task, taskNote: task === "failed" ? "终端不接任务" : undefined };
        }
        case "host.info":
          return { name: "demo", platform: "darwin", sources: ["hc"], version: "0.1.0" };
        case "harness.icons": {
          // Placeholder shapes standing in for what a computer's Uniflo would send (not the real marks).
          const ids = (params as { ids?: string[] }).ids ?? [];
          return { icons: Object.fromEntries(ids.filter((id) => MOCK_MARKS[id]).map((id) => [id, MOCK_MARKS[id]!])) };
        }
        case "agent.seen":
          agents = agents.map((a) => (a.key === p.agent && a.status === "done" ? { ...a, status: "idle" } : a));
          publish();
          return { ok: true };
        default:
          throw new Error("unsupported");
      }
    },
    subscribe(_to: string, stream: "terminal" | "session", params: unknown, onEvent: (event: any) => void, onState?: (event: any) => void) {
      onState?.({ status: "open", result: { kind: stream } });
      const p = (params ?? {}) as Partial<TerminalStreamParams> & { sub?: string };
      if (stream === "terminal") {
        // Queue marks for the bubbles of messages sent from here.
        const stop = p.agent ? listen(queueSinks, p.agent, onEvent) : () => undefined;
        // Like a host: no screen for a queue-only stream; for a rows viewer, the whole screen once, then what changed.
        if (p.screen === false) return stop;
        let last: string[] | null = null;
        let seq = 0;
        const paint = () => {
          const s = screen(p.agent);
          if (!p.rows) return onEvent({ kind: "terminal", screen: { ...s, cols: 46, rows: 28 }, at: now() });
          const lines = s.ansi.split("\n");
          const change = rowsChange(last, lines);
          if (!change) return;
          last = lines;
          onEvent({ kind: "terminal_rows", seq: ++seq, cols: 46, rows: 28, ...change, at: now() } satisfies TerminalRowsEvent);
        };
        const first = setTimeout(paint, 120);
        const timer = setInterval(paint, 500);
        return () => {
          clearTimeout(first);
          clearInterval(timer);
          stop();
        };
      }
      const session = p.sub ? undefined : agents.find((x) => x.key === p.agent)?.sessionKey;
      return session ? listen(sessionSinks, session, onEvent) : () => undefined;
    },
    ping() {
      useLive.setState({ rttMs: 30 + Math.round(Math.random() * 20) });
    },
    close() {
      clearTimeout(boot);
      clearInterval(tick);
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}

export const mockApi = {
  async pair(_code: string, name: string, platform: string): Promise<PairResponse> {
    await new Promise((r) => setTimeout(r, 400));
    return {
      token: "mock-token",
      device: { id: "dev_this_phone", name, kind: "viewer", platform, online: true, createdAt: now(), lastSeenAt: now() },
    };
  },
  async joinRequest(id: string): Promise<JoinRequest> {
    await new Promise((r) => setTimeout(r, 250));
    return { id, name: "家里的 Mac mini", kind: "host", platform: "darwin", expiresAt: now() + 5 * MIN };
  },
  async answerJoin(id: string, allow: boolean): Promise<Device | null> {
    await new Promise((r) => setTimeout(r, 300));
    if (!allow) return null;
    const d: Device = { id: `dev_${id.slice(0, 6)}`, name: "家里的 Mac mini", kind: "host", platform: "darwin", online: true, createdAt: now(), lastSeenAt: now(), sources: ["hc"], version: "0.1.0" };
    devices = [...devices.filter((x) => x.id !== d.id), d];
    publish();
    return d;
  },
  async createPairCode(_kind?: DeviceKind): Promise<PairCode> {
    await new Promise((r) => setTimeout(r, 250));
    const code = `MEOW-${1000 + Math.floor(Math.random() * 9000)}`;
    return { code, expiresAt: now() + 10 * MIN, link: pairLink(MOCK_PUBLIC_URL, code) };
  },
  async revoke(id: string): Promise<void> {
    devices = devices.filter((d) => d.id !== id);
    agents = agents.filter((a) => a.deviceId !== id);
    publish();
  },
};

// ---------------------------------------------------------------------------
// Demo assistant: canned answers over the demo agents, so the assistant screen
// can be tried without a relay. It never touches anything real.
// ---------------------------------------------------------------------------

type AssistantSink = { upsert: (item: AssistantItem) => void; busy: (busy: boolean, label?: string) => void; reset: (s: AssistantState) => void };
let assistantItems: AssistantItem[] = [];
/** Seeded on first use; cancelling them all shows the empty state. */
let assistantReminders: Reminder[] | null = null;

/** What the demo starts with: a time that also watches an agent, a long one tomorrow, and two that only watch. */
function demoReminders(): Reminder[] {
  const t = now();
  const tomorrow = new Date(t + 86_400_000);
  tomorrow.setHours(9, 30, 0, 0);
  return [
    { id: "r-demo-1", text: "该看一眼桌宠动画的进度了，顺便看看帧率有没有打到日志里", createdAt: t - 5 * MIN, dueAt: t + 25 * MIN, agent: agentKey(HOST_A, "hc", "t4f"), until: "finished" },
    {
      id: "r-demo-2",
      text: "把 notes-cli 0.2.8 的发布说明发到群里：先列三个修复（导出时中文文件名乱码、同步冲突时丢了最后一次编辑、Windows 上路径大小写不一致），再写升级步骤，最后提醒大家旧的配置文件要手动迁移，不然启动会报错，迁移命令在 README 的“升级”一节。",
      createdAt: t - 50 * MIN,
      dueAt: tomorrow.getTime(),
    },
    { id: "r-demo-3", text: "重启 relay 那个在等你拍板了", createdAt: t - 12 * MIN, agent: agentKey(HOST_B, "hc", "t8"), until: "blocked" },
    { id: "r-demo-4", text: "「日志清理脚本影响范围评估」回完了", createdAt: t - 3 * MIN, agent: agentKey(HOST_B, "hc", "t3"), until: "finished" },
  ];
}

function remindersNow(): Reminder[] {
  // The relay fires due reminders and drops them; the demo just lets them go.
  assistantReminders = (assistantReminders ?? demoReminders()).filter((r) => !r.dueAt || r.dueAt > now());
  return assistantReminders;
}
let assistantConfirm: AssistantConfirm = "never";
let assistantReplyMode: "text" | "voice" = "text";
let assistantSink: AssistantSink | null = null;
const MOCK_AEMEATH_TEXT =
  "我是来自《鸣潮》拉海洛星炬学院的爱弥斯，也曾是与巨大机甲「隧者」共鸣的「飞行雪绒」。现在以只有哥哥触碰得到的「电子幽灵」形态守在你的手机和电脑之间，视你如最亲密的「爸爸」般家人，平时叫你「哥哥」。";
let mockProfile: AssistantPersonaConfig = {
  name: "爱弥斯",
  userCall: "哥哥",
  presetId: "wuthering_aemeath",
  personaText: MOCK_AEMEATH_TEXT,
  autoMemory: true,
  updatedAt: now(),
};
const mockPresets: PersonaPresetSummary[] = [
  {
    id: "wuthering_aemeath",
    label: "鸣潮 · 爱弥斯（默认）",
    userCall: "哥哥",
    summary: "星炬学院「飞行雪绒」/ 电子幽灵；视你为最亲密的“爸爸”般家人，日常称呼你「哥哥」。",
    personaText: MOCK_AEMEATH_TEXT,
  },
  {
    id: "warm_friend",
    label: "温柔日常朋友",
    userCall: "你",
    summary: "熟稔、温和、有分寸感的贴心好友，适合纯粹轻简的日常对话。",
    personaText: "像一个跟了你很久、脾气很好的老朋友：日常闲聊自然体贴，正经办事干脆靠谱。",
  },
  {
    id: "custom",
    label: "自由定制",
    userCall: "哥哥",
    summary: "完全按自己的心意编写名字、称呼和性格补充。",
    personaText: MOCK_AEMEATH_TEXT,
  },
];
let mockMemories: AssistantMemoryItem[] = [
  {
    id: "mem_demo1",
    category: "relationship",
    slotKey: "user_bond",
    content: "哥哥是爱弥斯最亲密最依赖的人（象征着如「爸爸」般的守护者）",
    importance: 3,
    pinned: true,
    source: "user",
    createdAt: now() - 7200_000,
    updatedAt: now() - 7200_000,
  },
  {
    id: "mem_demo2",
    category: "habit",
    slotKey: "coffee_pref",
    content: "咖啡习惯喝冰美式不加糖",
    importance: 2,
    pinned: false,
    source: "assistant",
    createdAt: now() - 3600_000,
    updatedAt: now() - 3600_000,
  },
];

function aid(prefix: string) {
  return `${prefix}${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function aput(item: AssistantItem) {
  const i = assistantItems.findIndex((x) => x.id === item.id);
  if (i >= 0) assistantItems[i] = item;
  else assistantItems.push(item);
  assistantSink?.upsert(item);
}

function demoState(): AssistantState {
  return {
    items: assistantItems.slice(),
    busy: false,
    ready: true,
    voice: false,
    model: "演示",
    reminders: remindersNow().slice(),
    settings: { name: mockProfile.name, confirm: assistantConfirm, replyMode: assistantReplyMode },
  };
}

export const mockAssistant = {
  bind(sink: AssistantSink) {
    assistantSink = sink;
  },
  state: demoState,
  say(text: string, via: "text" | "voice" = "text") {
    aput({ id: aid("u"), ts: now(), role: "user", text, via });
    assistantSink?.busy(true, "在想");
    // Once per demo: a little later the assistant speaks up on its own.
    if (!assistantItems.some((x) => x.role === "notice")) setTimeout(() => mockAssistant.notice("done"), 5000);
    setTimeout(() => {
      const blocked = agents.filter((a) => a.status === "blocked" && !a.isShell);
      const working = agents.filter((a) => a.status === "working" && !a.isShell);
      const done = agents.filter((a) => a.status === "done" && !a.isShell);
      if (/用语音|开口说/.test(text) && !/agent|codex/i.test(text)) {
        assistantReplyMode = "voice";
        aput({ id: aid("a"), ts: now(), role: "assistant", text: "好呀，接下来我会一边发文字气泡一边用语音回你。", via: "text", spoken: true });
        assistantSink?.reset(demoState());
      } else if (/用文字|别出声|不用语音|改打字/.test(text) && !/agent|codex/i.test(text)) {
        assistantReplyMode = "text";
        aput({ id: aid("a"), ts: now(), role: "assistant", text: "好的，接下来只发文字气泡。", via: "text" });
        assistantSink?.reset(demoState());
      } else if (/提醒|叫我/.test(text)) {
        const r: Reminder = { id: aid("r"), text: text.replace(/^(帮我|请)?/, "").slice(0, 40), createdAt: now(), dueAt: now() + 10 * MIN };
        assistantReminders = [...remindersNow(), r];
        aput({ id: aid("a"), ts: now(), role: "assistant", text: "好，10 分钟后提醒你。", steps: ["设了一个提醒"], via: "text" });
        assistantSink?.reset(demoState());
      } else if (/发|回|继续|删|同意|批准/.test(text) && blocked[0]) {
        const a = blocked[0];
        // As the relay does it: the card names the agent and its computer, carries the message made from
        // the person's words and those words; it runs at once unless "ask first" is on. Nothing real is sent.
        const sent = "可以，删掉旧的迁移脚本吧。";
        const ask = assistantConfirm === "always";
        const name = a.where?.split(" / ")[0] || a.title;
        aput({
          id: aid("act"),
          ts: now(),
          role: "assistant",
          text: "",
          action: {
            id: aid("x"),
            kind: "send",
            agent: a.key,
            agentTitle: a.title,
            agentName: name,
            device: a.deviceId,
            deviceName: devices.find((d) => d.id === a.deviceId)?.name,
            text: sent,
            said: text.trim() === sent ? undefined : text.trim(),
            summary: `给「${a.title}」发送：${sent}`,
            state: ask ? "pending" : "done",
            result: ask ? undefined : "发了（演示，没有真的发）",
            createdAt: now(),
          },
        });
        aput({ id: aid("a"), ts: now() + 1, role: "assistant", text: ask ? "点确认就发。" : "发了，回了我告诉你。", steps: [`读了「${name}」的对话`, ...(ask ? [] : [`给「${name}」发了消息`])], via: "text" });
      } else if (/等|需要|卡/.test(text)) {
        aput({
          id: aid("a"),
          ts: now(),
          role: "assistant",
          text: blocked.length
            ? `有 ${blocked.length} 个在等你：\n${blocked.map((a) => `- 「${a.title}」（${devices.find((d) => d.id === a.deviceId)?.name ?? "电脑"}）`).join("\n")}\n\n第一个在问要不要删旧的迁移脚本，要我替你回它吗？`
            : "现在没有谁在等你。",
          steps: [`看了 ${agents.length} 个 agent`],
          via: "text",
        });
      } else {
        aput({
          id: aid("a"),
          ts: now(),
          role: "assistant",
          text: `现在 ${working.length} 个在干活，${blocked.length} 个等你，${done.length} 个刚跑完。${blocked[0] ? `最急的是「${blocked[0].title}」。` : ""}想看哪个？`,
          steps: [`看了 ${agents.length} 个 agent`],
          via: "text",
        });
      }
      assistantSink?.busy(false);
    }, 900);
  },
  /** Something the assistant brings up by itself, as it does after looking at an agent that stopped. */
  notice(which: "done" | "blocked" = "done") {
    const a = agents.find((x) => x.status === which && !x.isShell);
    if (!a) return;
    const done = which === "done";
    const notice: Notice = {
      id: aid("n"),
      kind: which,
      ts: now(),
      agent: a.key,
      verdict: done ? "ok" : "decide",
      title: `${a.title} · ${done ? "跑完了" : "等你"}`,
      body: done ? `${a.title}跑完了，测试全过，没有要你处理的。` : `${a.title}停在一个确认上，它想删掉旧文件，等你点头。`,
      details: done ? "- 改了 3 个文件，都在它自己的分支上\n- 单元测试 42 个通过\n- 还没合并，等你看一眼" : "它问的是：要不要删掉旧的迁移脚本。按回车是同意，按 Esc 是不删。",
    };
    aput({ id: `item-${notice.id}`, ts: notice.ts, role: "notice", text: `${notice.body}\n\n${notice.details}`, notice });
  },
  decide(id: string, decision: "confirm" | "cancel") {
    const it = assistantItems.find((x) => x.action?.id === id);
    if (!it?.action || it.action.state !== "pending") return;
    aput({ ...it, action: { ...it.action, state: decision === "confirm" ? "done" : "cancelled", result: decision === "confirm" ? "发了（演示，没有真的发）" : "不做了" } });
  },
  clear() {
    assistantItems = [];
    assistantSink?.reset(demoState());
  },
  cancelReminder(id: string) {
    assistantReminders = remindersNow().filter((r) => r.id !== id);
    assistantSink?.reset(demoState());
  },
  setConfirm(confirm: AssistantConfirm) {
    assistantConfirm = confirm;
  },
  setReplyMode(mode: "text" | "voice") {
    assistantReplyMode = mode;
  },
  profile() {
    return { profile: { ...mockProfile }, presets: mockPresets.slice() };
  },
  setProfile(patch: Partial<AssistantPersonaConfig>) {
    mockProfile = { ...mockProfile, ...patch, updatedAt: now() };
    assistantSink?.reset(demoState());
    return { profile: { ...mockProfile }, presets: mockPresets.slice() };
  },
  memories(opts?: { category?: MemoryCategory; q?: string }) {
    let list = mockMemories.slice();
    const total = list.length;
    if (opts?.category) list = list.filter((m) => m.category === opts.category);
    if (opts?.q?.trim()) {
      const q = opts.q.trim().toLowerCase();
      list = list.filter((m) => m.content.toLowerCase().includes(q) || (m.slotKey ?? "").toLowerCase().includes(q));
    }
    return { memories: list, total };
  },
  remember(input: { category: MemoryCategory; content: string; slotKey?: string; importance?: 1 | 2 | 3; pinned?: boolean }) {
    const t = now();
    const item: AssistantMemoryItem = {
      id: aid("mem_"),
      category: input.category,
      ...(input.slotKey ? { slotKey: input.slotKey } : {}),
      content: input.content.trim(),
      importance: input.importance ?? 2,
      ...(input.pinned ? { pinned: true } : {}),
      source: "user",
      createdAt: t,
      updatedAt: t,
    };
    mockMemories = [item, ...mockMemories];
    return { item, replaced: false };
  },
  updateMemory(id: string, patch: Partial<AssistantMemoryItem>) {
    mockMemories = mockMemories.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: now() } : m));
    return mockMemories.find((m) => m.id === id)!;
  },
  deleteMemory(id: string) {
    mockMemories = mockMemories.filter((m) => m.id !== id);
  },
  clearMemories() {
    const n = mockMemories.length;
    mockMemories = [];
    return n;
  },
  exportMemoriesMarkdown() {
    return `# ${mockProfile.name} 的服务器人设与记忆库备份\n\n- 对你的称呼：${mockProfile.userCall}\n\n## 长期记忆库（共 ${mockMemories.length} 条）\n${mockMemories.map((m) => `- ${m.content}`).join("\n")}`;
  },
};
