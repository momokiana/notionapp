/**
 * xiaoaixiaoai wire protocol, v1.
 *
 * Three parties:
 *   - relay  : the server every device registers with (e.g. a small VPS)
 *   - host   : a computer running herdr (GUI `hc` core and/or TUI `herdr`), via `hostd`
 *   - viewer : a phone (or any client) that watches and drives agents
 *
 * A host is also allowed to call other hosts, so computers can drive each other's
 * agents through the relay ("joint debugging").
 *
 * Versioning follows Uniflo's rule: v1 only gains optional fields and new
 * `type` / `kind` values. Clients must ignore what they don't recognise.
 */

export const PROTOCOL_VERSION = 1;

/** This fork's public app identity; internal package namespaces are not product identifiers. */
export const APP_DISPLAY_NAME = "小爱小爱";
export const APP_SCHEME = "xiaoaixiaoai";
export const APP_PACKAGE_ID = "dev.notifier.xiaoaixiaoai";
export const RELEASE_ASSET_PREFIX = "xiaoaixiaoai";

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type DeviceKind = "host" | "viewer";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  platform?: string; // darwin | linux | ios | android | ...
  online: boolean;
  createdAt: number; // epoch ms
  lastSeenAt: number; // epoch ms
  /** Agent sources a host can bridge, e.g. ["hc", "herdr", "uniflo"]. */
  sources?: HostSource[];
  version?: string;
}

// ---------------------------------------------------------------------------
// Agents (unified view over herdr-core terminals and herdr TUI agents)
// ---------------------------------------------------------------------------

/** Where the agent lives on its host. */
export type AgentSource = "hc" | "herdr" | "uniflo" | "runtime";
/** Metadata and operations for explicitly shared runtime sessions, not terminal Agents. */
export type HostSource = AgentSource | "runtime-sessions" | "runtime-create" | "dsh-directory" | "runtime-detail" | "local-voice";

export const RUNTIME_TASK_EVENTS_LIMIT = 128;
export const RUNTIME_TASK_EVENT_KINDS = ["progress", "attention", "completed", "stopped"] as const;
export type RuntimeTaskEventKind = (typeof RUNTIME_TASK_EVENT_KINDS)[number];
/** Observation of a DSH turn that claimed a particular phone-submitted request. No model text or tool arguments. */
export interface RuntimeTaskEvent {
  eventId: string;
  requestId: string;
  kind: RuntimeTaskEventKind;
}

/**
 * Unified status. Superset of herdr (`idle|working|blocked|done|unknown`) and
 * herdr-core status; Uniflo `work` maps to `working`.
 */
export type AgentStatus = "working" | "blocked" | "done" | "idle" | "unknown";

export interface Agent {
  /** Globally unique: `<deviceId>/<source>:<localId>`. */
  key: string;
  deviceId: string;
  source: AgentSource;
  /** Address on the host: hc `t42`, herdr terminal id, ... */
  localId: string;
  /** Harness / program, e.g. claude-code, omp, codex, sh. */
  harness: string;
  /**
   * Human title: the name given in herdr when there is one, else the Uniflo
   * session title, else the terminal title.
   */
  title?: string;
  /** Name given to the terminal in herdr (e.g. `hc run --name`); also used as `title`. */
  name?: string;
  /** "space / tab" location in the herdr GUI, with the names the desktop app shows. */
  where?: string;
  cwd?: string;
  status: AgentStatus;
  statusSince?: number;
  /**
   * What the program says about a `blocked` state, when it says something,
   * e.g. its error message. Older hosts never send it.
   */
  statusNote?: string;
  /**
   * The program stopped on an error (a model or connection failure) rather than
   * on a question. `status` is `blocked` then, so older apps still flag it.
   */
  errored?: boolean;
  turn?: number;
  /** True for plain shells; the app hides them by default. */
  isShell: boolean;
  /** Matching Uniflo session key, when found (enables the chat view). */
  sessionKey?: string;
  /** False when this session is view-only (e.g. Antigravity or read-only host). */
  canSend?: boolean;
  /** Human-readable reason shown in place of the input box when `canSend === false`. */
  readOnlyReason?: string;
  model?: string;
  /** Live model quota / rate-limit state when exposed by the runtime or provider. */
  modelQuota?: ModelQuota;
  /** First human prompt of the matched session. */
  preview?: string;
  costUsd?: number;
  contextTokens?: number;
  contextLimit?: number;
  /** Subagent sessions spawned by the matched session (Uniflo `parent`). */
  subagents?: number;
  subagentsWorking?: number;
  /**
   * Messages typed into it while it was busy that its program has not taken
   * yet (Claude Code and the like hold them in the input box until the turn
   * ends). Absent or 0 when nothing is waiting.
   */
  queued?: number;
  /** The oldest waiting message, clipped. */
  queuedText?: string;
  /** When the oldest waiting message was typed in (epoch ms). */
  queuedSince?: number;
  updatedAt: number;
}

/** A space in the desktop herdr app on one computer. */
export interface SpaceInfo {
  id: string;
  name: string;
  /** Folder its terminals started in. */
  folder?: string;
  tabs: number;
  terminals: number;
}

/** A program the phone may start on a computer (picked by id, never a command line). */
export interface LaunchOption {
  id: string;
  label: string;
  /**
   * Whether a first message can be given at start (on its command line). Hosts
   * with `typesTask` (spaces.list) also take a task for the others, except the
   * shell: they type it in once the program is up.
   */
  takesTask: boolean;
}

/**
 * What became of the first task given to agent.create: `started` went in with
 * the program, `typed` was typed in once it was up, `failed` did not reach it
 * (`taskNote` says why; the agent is open and idle).
 */
export type FirstTask = "started" | "typed" | "failed";

/** The desktop herdr app's layout on one computer: spaces -> tabs -> terminals. */
export interface LayoutSpace {
  id: string;
  name: string;
  folder?: string;
  /** The space the desktop window shows now. */
  active: boolean;
  tabs: LayoutTab[];
}

export interface LayoutTab {
  id: string;
  name: string;
  active: boolean;
  /** Put away: out of the lists, still running. */
  settled: boolean;
  terminals: LayoutTerminal[];
}

export interface LayoutTerminal {
  /** hc address, e.g. t42. */
  terminal: string;
  pane?: string;
  /** Key of the published agent, when this terminal is one. */
  agent?: string;
  title?: string;
  harness?: string;
  status?: AgentStatus;
}

/**
 * Desktop herdr commands a computer accepts over rpc (`herdr.command`), with the
 * arguments each takes. `confirm`: it ends or starts programs, so the assistant
 * asks first; the others only change the layout and can be undone.
 * Ids come from `herdr.layout`. Nothing here takes a command line.
 */
export const HERDR_COMMANDS = {
  "space.rename": { confirm: false, args: ["id", "name"], about: "给空间改名；name 为空字符串时恢复成按文件夹自动命名" },
  "space.move": { confirm: false, args: ["id", "index"], about: "把空间移到第 index 位，1 是最前" },
  "space.select": { confirm: false, args: ["id"], about: "让桌面窗口显示这个空间" },
  "space.close": { confirm: true, args: ["id"], about: "关闭空间，并结束它里面的所有终端" },
  "tab.rename": { confirm: false, args: ["id", "name"], about: "给标签改名；name 为空字符串时恢复成序号" },
  "tab.move": { confirm: false, args: ["id", "index"], about: "把标签移到所在空间的第 index 位，1 是最前" },
  "tab.select": { confirm: false, args: ["id"], about: "让桌面窗口显示这个标签" },
  "tab.settle": { confirm: false, args: ["id"], about: "把标签收起来：不在列表里显示，但继续运行；里面的 agent 需要人时会自己回来" },
  "tab.unsettle": { confirm: false, args: ["id"], about: "把收起的标签放回列表" },
  "tab.close": { confirm: true, args: ["id"], about: "关闭标签，并结束它里面的终端" },
  "pane.split": { confirm: true, args: ["pane", "direction", "launcher"], about: "把一个窗格向 right 或 down 分开，新窗格里开一个程序（launcher 是 list_launchers 里的 id，不填是普通终端）" },
  "pane.close": { confirm: true, args: ["pane"], about: "关闭窗格，并结束它的终端" },
  "pane.zoom": { confirm: false, args: ["pane"], about: "只显示这个窗格，或恢复显示全部" },
  "pane.focus": { confirm: false, args: ["pane", "terminal"], about: "把焦点放到某个窗格，或显示某个终端的窗格" },
  "terminal.pin": { confirm: false, args: ["terminal", "pinned"], about: "把 agent 置顶（pinned=true）或取消置顶（false）" },
  "terminal.keep": { confirm: false, args: ["terminal", "place"], about: "给没有窗格的后台终端（比如子 agent）一个窗格：place 是 tab、right 或 down" },
  "terminal.park": { confirm: false, args: ["terminal"], about: "收走终端的窗格，它在后台继续运行" },
  "agent.focus": { confirm: false, args: ["terminal"], about: "在桌面窗口显示这个 agent" },
} as const satisfies Record<string, { confirm: boolean; args: readonly string[]; about: string }>;

export type HerdrCommand = keyof typeof HERDR_COMMANDS;

/** A recorded agent session on one computer (Uniflo): any program, running or long finished. */
export interface SessionInfo {
  /** e.g. claude:<id>. */
  key: string;
  harness: string;
  title?: string;
  cwd?: string;
  model?: string;
  /** First prompt it was given. */
  preview?: string;
  status: "working" | "idle";
  startedAt?: number;
  updatedAt: number;
  costUsd?: number;
  steps?: number;
  /** Parent session key, for a subagent. */
  parent?: string;
  /** Key of the live agent this session is open in, if any. */
  agent?: string;
}

/** Full-text search result: one session and where the words were found in it. */
export interface SessionHit {
  session: string;
  harness: string;
  title?: string;
  cwd?: string;
  updatedAt: number;
  hits: Array<{ event: string; kind: string; ts?: number; snippet: string }>;
}

/** Tokens and cost of one group (a program, model, folder or day). */
export interface UsageRow {
  key: string;
  label: string;
  sessions: number;
  steps: number;
  prompts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

/** A subagent conversation spawned by an agent's session. */
export interface SubSession {
  key: string;
  /** Session key of the direct parent (an agent's session or another subagent). */
  parent: string;
  /** tool_call id in the parent that spawned it, links the tool card to this child. */
  parentCall?: string;
  harness: string;
  title?: string;
  /** First prompt it was given: what it was asked to do. */
  preview?: string;
  model?: string;
  status: "working" | "idle";
  statusSince?: number;
  startedAt?: number;
  updatedAt: number;
  costUsd?: number;
  /** Its own subagents. */
  children: number;
}

export function agentKey(deviceId: string, source: AgentSource, localId: string): string {
  return `${deviceId}/${source}:${localId}`;
}

export function parseAgentKey(key: string): { deviceId: string; source: AgentSource; localId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const rest = key.slice(slash + 1);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const source = rest.slice(0, colon) as AgentSource;
  if (source !== "hc" && source !== "herdr" && source !== "uniflo" && source !== "runtime") return null;
  return { deviceId: key.slice(0, slash), source, localId: rest.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// Conversation events (Uniflo schema v1 body, trimmed for the wire)
// ---------------------------------------------------------------------------

export type EventBody =
  /** `injected`: harness-added blocks stripped from the text, shown folded. */
  | { kind: "user_message"; text: string; synthetic?: boolean; injected?: string }
  | { kind: "assistant_message"; text: string; model?: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; call_id: string; name: string; input: unknown }
  | { kind: "tool_result"; call_id: string; name?: string; output: string; is_error: boolean }
  | { kind: "turn_start" }
  | { kind: "turn_end"; reason?: string }
  | { kind: "usage"; input?: number; output?: number; cost_usd?: number; model?: string }
  /** Injected by the harness, not said by anyone. `summary` is the folded one-liner. */
  | { kind: "system"; subtype?: string; text: string; summary?: string };

export type ConvEvent = EventBody & {
  id: string;
  session: string;
  ts: number;
  pos?: string;
  partial?: boolean;
  truncated?: boolean;
};

// ---------------------------------------------------------------------------
// Files sent to an agent (terminal.put)
// ---------------------------------------------------------------------------

/** A picture sent from a phone, contents in base64. */
export interface PutFile {
  /** Original file name; the host keeps a safe form of it. */
  name: string;
  /** One of `PUT_LIMITS.mimes`. */
  mime: string;
  data: string;
}

/**
 * What one `terminal.put` may carry. The total stays well under the relay's
 * 8 MiB WebSocket frame once base64 has grown it by a third; phones shrink
 * pictures to a few hundred KB first.
 */
export const PUT_LIMITS = {
  files: 6,
  /** Bytes of one file, decoded. */
  fileBytes: 3 * 1024 * 1024,
  /** Bytes of all files of one call, decoded. */
  totalBytes: 5 * 1024 * 1024,
  mimes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
} as const;

/** The message an agent gets for a text with pictures: the text, then each picture's path on a line of its own. */
export function textWithFiles(text: string, paths: string[]): string {
  return [text.trim(), ...paths].filter(Boolean).join("\n");
}

/**
 * A trailing line that stands for a picture: a path `textWithFiles` appended,
 * or Claude Code's `[Image #n]` marks, which it may put in their place.
 */
const PICTURE_LINE = /^(?:(?:\/|[A-Za-z]:\\).*\.(?:jpe?g|png|webp|gif)|(?:\[Image #\d+\]\s*)+)$/i;
/** An absolute path: `/…` (macOS, Linux) or `C:\…` (Windows). */
const FILE_PATH = /^(?:\/|[A-Za-z]:\\)/;

/** Undoes `textWithFiles`: the words, the picture lines after them, and how many pictures those are. */
export function splitFiles(message: string): { text: string; lines: string[]; count: number } {
  const all = message.replace(/\s+$/, "").split("\n");
  const lines: string[] = [];
  while (all.length > 0 && PICTURE_LINE.test(all[all.length - 1]!.trim())) lines.unshift(all.pop()!.trim());
  const count = lines.reduce((n, l) => n + (FILE_PATH.test(l) ? 1 : (l.match(/\[Image #\d+\]/gi)?.length ?? 1)), 0);
  return { text: all.join("\n").trim(), lines, count };
}

// ---------------------------------------------------------------------------
// RPC methods a host serves (callable by viewers and by other hosts)
// ---------------------------------------------------------------------------

export type SessionRuntime = "dsh" | "codex" | "antigravity";
export type RuntimeSessionState = "running" | "idle" | "inactive" | "attention" | "unknown";
export const RUNTIME_SESSION_TEXT_LIMIT = 4000;
export const RUNTIME_DETAIL_LIMIT = 100;

export interface QuotaWindow {
  /** Remaining quota percentage (0..100). */
  remainingPercent: number;
  /** Window duration in minutes when known (e.g. 300 = 5h, 10080 = 7d). */
  windowMinutes?: number;
  /** Epoch ms when this window resets, if known. */
  resetsAt?: number;
  /** Human-readable window label (e.g. "5小时" / "7天"). */
  label?: string;
}

export interface ModelQuota {
  /** True when the runtime/provider actually exposed live remaining quota data. */
  available: boolean;
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  /** Provider credit balance when finite, e.g. "25422.92". */
  balance?: string;
  /** Plan or subscription tier label when known. */
  plan?: string;
  /** Epoch ms when this quota snapshot was recorded. */
  updatedAt?: number;
  /** Honest note explaining why quota is unavailable when `available === false`. */
  note?: string;
}

export interface RuntimeSession {
  id: string;
  title: string;
  state: RuntimeSessionState;
  canSend: boolean;
  model?: string;
  contextTokens?: number;
  contextLimit?: number;
  modelQuota?: ModelQuota;
  updatedAt?: number;
  subagents?: number;
  subagentsWorking?: number;
}

export interface RuntimeProject {
  runtime: SessionRuntime;
  id: string;
  title: string;
  sessions: RuntimeSession[];
}

export interface RuntimeSessionSend {
  runtime: SessionRuntime;
  projectId: string;
  sessionId: string;
  requestId: string;
  text: string;
}

/** Acknowledged by the target runtime, not a claim the task has finished. */
export interface RuntimeSessionReceipt {
  accepted: true;
  requestId: string;
  receiptId?: string;
}

export interface RuntimeCatalog {
  runtimes: Array<{ runtime: SessionRuntime; online: boolean }>;
  projects: RuntimeProject[];
}

export const DSH_DIRECTORY_PAGE_SIZE = 32;
export const DSH_DIRECTORY_SEARCH_LIMIT = 120;
export const DSH_UNFILED = "dsh:unfiled";
export const DSH_ARCHIVE = "dsh:archive";

export interface DshDirectoryProject { id: string; title: string; runtime?: SessionRuntime }
export interface DshDirectoryEntry {
  runtime?: SessionRuntime;
  project: DshDirectoryProject;
  session: RuntimeSession;
  archived: boolean;
}

/** `after` is the last stable ID on the previous page; missing/removed IDs are fine. */
export type DshDirectoryRequest =
  | { runtime?: SessionRuntime; view: "projects"; after?: string }
  | { runtime?: SessionRuntime; view: "sessions"; projectId?: string; search?: string; after?: string }
  | { runtime?: SessionRuntime; view: "exact"; sessionIds: string[] };

type DshDirectoryScope = "profile" | "selected";
export type DshDirectoryReply =
  | { runtime?: SessionRuntime; view: "projects"; scope: DshDirectoryScope; projects: DshDirectoryProject[]; next?: string }
  | { runtime?: SessionRuntime; view: "sessions"; scope: DshDirectoryScope; entries: DshDirectoryEntry[]; next?: string }
  | { runtime?: SessionRuntime; view: "exact"; scope: DshDirectoryScope; entries: DshDirectoryEntry[] };

export interface RuntimeQuestionOption {
  label: string;
  description?: string;
}

export interface RuntimeQuestionItem {
  id: string;
  header?: string;
  question: string;
  detail?: string;
  options?: RuntimeQuestionOption[];
  multiSelect?: boolean;
}

export interface RuntimePendingQuestion {
  callId: string;
  state: "open" | "continued" | "readonly";
  questions: RuntimeQuestionItem[];
}

export interface RuntimeSessionMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  ts?: number;
  toolName?: string;
  isError?: boolean;
}

export interface RuntimeSessionDetailRequest {
  runtime: SessionRuntime;
  projectId: string;
  sessionId: string;
  limit?: number;
}

export interface RuntimeSessionDetail {
  runtime: SessionRuntime;
  project: { id: string; title: string };
  session: RuntimeSession;
  messages: RuntimeSessionMessage[];
  pendingQuestions: RuntimePendingQuestion[];
  readOnlyReason?: string;
}

export interface RuntimeQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface RuntimeSessionAnswer {
  runtime: SessionRuntime;
  projectId: string;
  sessionId: string;
  requestId: string;
  callId: string;
  answers: RuntimeQuestionAnswerItem[];
}

/** Opaque, bounded IDs; labels are display-only and never form a dispatch target. */
export function isRuntimeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
}

export function isRuntimeRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
}

export interface RpcMethods {
  /** On-demand directory for the one locally approved phone, not broadcast to models or peers. */
  "runtimeSessions.list": { params: Record<string, never>; result: RuntimeCatalog };
  /** Paged DSH metadata and exact lookups, with the same device authorization as list. */
  "runtimeSessions.browse": { params: DshDirectoryRequest; result: DshDirectoryReply };
  /** Read bounded recent conversation history and pending interactive questions for one session. */
  "runtimeSessions.detail": { params: RuntimeSessionDetailRequest; result: RuntimeSessionDetail };
  /** Answer a pending interactive question for one shared session. */
  "runtimeSessions.answer": { params: RuntimeSessionAnswer; result: RuntimeSessionReceipt };
  /** `input` keeps legacy relay RPC summaries from recording this text. */
  "runtimeSessions.send": { params: Omit<RuntimeSessionSend, "text"> & { input: string }; result: RuntimeSessionReceipt };
  /** Full agent list of this host. */
  "agents.list": { params: { includeShells?: boolean }; result: { agents: Agent[] } };
  /** Screen + history as plain text. */
  "terminal.read": {
    params: { agent: string; lines?: number };
    /**
     * `text`: plain screen + history. `ansi`: the same rows with SGR colors
     * only (no cursor moves), when the source can provide it; render it
     * without wrapping at `cols` cells per row.
     */
    result: { text: string; ansi?: string; cols?: number; rows?: number; how?: string; complete?: boolean };
  };
  /** Paste text and press Enter (like `hc send`). */
  "terminal.send": {
    params: { agent: string; text: string; enter?: boolean };
    /**
     * Accepted into the ordered input queue; `position=0` means sent.
     * `agentStatus`: the agent's status when the text arrived. `waiting`: it was
     * in a turn, so its program holds the text until the turn ends (the agent's
     * `queued` counts these). Older hosts send neither.
     */
    result: { ok: true; queueId?: string; position?: number; agentStatus?: AgentStatus; waiting?: boolean };
  };
  /** Press keys: enter, esc, up, down, tab, ctrl+c, y, n ... */
  "terminal.keys": { params: { agent: string; keys: string[] }; result: { ok: true } };
  /**
   * Type into the terminal as the person at it would, at once: UTF-8 text with
   * control bytes ("\r" Enter, "\x7f" Backspace). No queue, no Enter added.
   * Hosts before this call answer `unsupported`; fall back to `terminal.send`.
   */
  "terminal.input": { params: { agent: string; data: string }; result: { ok: true } };
  /**
   * Puts pictures beside the agent on its computer (like `hc put`) and says
   * where each landed, in order. Nothing is typed: the caller names the paths
   * in a following `terminal.send` (see `textWithFiles`), and agents such as
   * Claude Code and Codex read a picture from its path. Limits: `PUT_LIMITS`.
   * Hosts before this call answer `unsupported`.
   */
  "terminal.put": { params: { agent: string; files: PutFile[] }; result: { paths: string[] } };
  /** Conversation of the agent's matched Uniflo session, newest last. */
  "session.events": {
    /** `sub`: read a subagent session of this agent instead (from `session.children`). */
    params: { agent: string; sub?: string; limit?: number; before?: string };
    /** `nextBefore`: pass as `before` to load the previous page (null when none). */
    result: {
      sessionKey: string | null;
      events: ConvEvent[];
      more: boolean;
      nextBefore?: string | null;
      pendingQuestions?: RuntimePendingQuestion[];
      canSend?: boolean;
      readOnlyReason?: string;
    };
  };
  /** Subagent sessions under the agent's session (or under `sub`), newest first. */
  "session.children": { params: { agent: string; sub?: string }; result: { sessions: SubSession[] } };
  /** What can be created on this computer: spaces, programs, suggested folders. */
  "spaces.list": {
    params: Record<string, never>;
    /** `canCreate` false with `reason` when the desktop herdr window is closed or the host is read-only. */
    result: {
      spaces: SpaceInfo[];
      launchers: LaunchOption[];
      folders: string[];
      canCreate: boolean;
      reason?: string;
      /** This host types a first task into programs that take none at start (agent.create waits for that, up to about a minute). */
      typesTask?: boolean;
      /**
       * No desktop herdr on this computer (herdr on Windows is herdr-core alone; servers): there are
       * no spaces, and a new agent gets a terminal of its own in the folder. `spaceName` is unused.
       */
      standalone?: boolean;
    };
  };
  /**
   * Starts an agent: in a new tab of `space`, or (no `space`) in a new space
   * named `spaceName` (empty: named after its folder). Shown at once in the desktop app.
   */
  "agent.create": {
    params: { space?: string; spaceName?: string; tabName?: string; folder?: string; launcher: string; task?: string };
    result: { agent: string; space: string; terminal: string; task?: FirstTask; taskNote?: string };
  };
  "host.info": {
    params: Record<string, never>;
    result: { name: string; platform: string; sources: HostSource[]; version: string; hcVersion?: string };
  };
  /**
   * The person looked at this agent: a finished turn stops counting as "done"
   * here and in the desktop app (herdr keeps this on the terminal for every client).
   */
  "agent.seen": { params: { agent: string }; result: { ok: true } };
  /** Press the stop key (like `hc interrupt`); `report` says what happened. */
  "terminal.interrupt": { params: { agent: string }; result: { ok: true; report?: string } };
  /** End the terminal and its sub-agents. */
  "terminal.kill": { params: { agent: string }; result: { ok: true } };
  /** Spaces, tabs and terminals as the desktop herdr window shows them. */
  "herdr.layout": { params: Record<string, never>; result: { spaces: LayoutSpace[] } };
  /** One of `HERDR_COMMANDS` with its arguments. */
  "herdr.command": { params: { command: HerdrCommand; args?: Record<string, unknown> }; result: { ok: true; result?: unknown } };
  /**
   * Recorded sessions on this computer, newest first. `q` is Uniflo's filter
   * (`h:claude s:work in:<folder> since:2d` and free words). Assistant only.
   */
  "sessions.list": { params: { q?: string; limit?: number }; result: { sessions: SessionInfo[] } };
  /** Full-text search over every session's transcript. Assistant only. */
  "sessions.search": { params: { q: string; limit?: number }; result: { total: number; results: SessionHit[] } };
  /** Conversation of any session by key, newest last. Assistant only. */
  "sessions.read": {
    params: { session: string; limit?: number; before?: string };
    result: { session: SessionInfo; events: ConvEvent[]; more: boolean; nextBefore?: string | null };
  };
  /** Tokens and cost since `since` (`1d`, `7d`, `2026-11-01`), grouped. Assistant only. */
  "sessions.usage": {
    params: { since?: string; groupBy?: "harness" | "model" | "cwd" | "day" | "session" };
    result: { since?: number; rows: UsageRow[]; total: UsageRow };
  };
  /**
   * Opens a finished session again in a new tab (of `space`, else a new space),
   * with the resume command Uniflo gives for it. Assistant only.
   */
  "sessions.resume": { params: { session: string; space?: string }; result: { agent: string; space: string; terminal: string } };
  /**
   * Harness icons as the computer's Uniflo draws them: 24×24 single-colour SVGs
   * (`fill="currentColor"`), only safe shape elements. For marks the app can't
   * ship itself. `ids` are Uniflo harness ids (claude, workbuddy, factory…), at
   * most HARNESS_ICON_MAX; ids it doesn't know are left out. Older hosts answer
   * `unsupported`.
   */
  "harness.icons": { params: { ids: string[] }; result: { icons: Record<string, string> } };
  "voice.warmup": { params: {}; result: { ready: boolean } };
  "voice.transcribe": {
    params: { requestId: string; audioBase64: string; sampleRate: number };
    result: { text: string; cancelled?: boolean };
  };
  "voice.synthesize": {
    params: { requestId: string; text: string; speed?: number };
    result: { sampleRate: number; chunksBase64: string[]; cancelled?: boolean };
  };
  "voice.cancel": { params: { requestId?: string }; result: { cancelled: boolean } };
  "voice.release": { params: {}; result: { released: boolean } };
}

export const HARNESS_ICON_MAX = 40;

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];

export type RpcErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "offline"
  | "timeout"
  | "outcome_unknown"
  | "unsupported"
  | "internal";

export interface RpcError {
  code: RpcErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Assistant (runs on the relay; one shared thread for the owner of all devices)
// ---------------------------------------------------------------------------

/**
 * Whether the assistant asks before it acts on real agents. `never` (the
 * default): it does what it is told at once and reports the real outcome.
 * `always`: in typed chats every action waits for the person's confirmation.
 * Voice calls never wait for a confirmation.
 */
export type AssistantConfirm = "never" | "always";

export type AssistantReplyMode = "text" | "voice";

export interface AssistantSettings {
  confirm: AssistantConfirm;
  /** Normal chat reply mode: "voice" = dual-track voice + text, "text" = text only. */
  replyMode?: AssistantReplyMode;
  /** Relay-provided display name, not client-editable; older relays omit it (default: 爱弥斯). */
  readonly name?: string;
}

/**
 * Something the assistant does to a real agent. With confirmation on it waits
 * as `pending` until the person confirms it (a button in the app, or saying so
 * in a later turn); otherwise it runs at once and the card shows the outcome.
 */
export interface AssistantAction {
  id: string;
  /**
   * send / keys: input to an agent. create: a new agent. interrupt: the stop key.
   * close: end the terminal. herdr: a desktop herdr command. resume: reopen a session.
   */
  kind: "send" | "keys" | "create" | "interrupt" | "close" | "herdr" | "resume";
  /** Target agent key (send / keys / interrupt / close). */
  agent?: string;
  agentTitle?: string;
  /** send: the short name the assistant calls the agent by, the one its answer uses. Older relays leave it out. */
  agentName?: string;
  /** Target computer. */
  device?: string;
  deviceName?: string;
  /** send: exactly what is typed into the agent. create: its first task. */
  text?: string;
  /**
   * send: the person's own words the assistant made `text` from (typed, or heard
   * in a call), kept so both are on record. Absent when `text` is those words as they are.
   */
  said?: string;
  keys?: string[];
  launcher?: string;
  folder?: string;
  /** create / resume: the space to add a tab to (id); absent = a new space. */
  space?: string;
  /** create: name for the new space / the new tab. */
  spaceName?: string;
  tabName?: string;
  /** herdr: the command and its arguments. */
  command?: HerdrCommand;
  args?: Record<string, unknown>;
  /** resume: the session key. */
  session?: string;
  /** One line for people, e.g. 给「迁移脚本」发送：继续. */
  summary: string;
  state: "pending" | "running" | "done" | "cancelled" | "failed" | "expired";
  /** What happened, once it is no longer pending. */
  result?: string;
  createdAt: number;
}

export type NoticeKind = "blocked" | "done" | "reminder" | "progress";

export interface RuntimeTaskNoticeTarget {
  hostId: string;
  projectId: string;
  sessionId: string;
  requestId: string;
}

/** Something worth telling the person without being asked. */
export interface Notice {
  id: string;
  kind: NoticeKind;
  /** Short headline, e.g. 迁移脚本 · 跑完了. Also the phone notification title. */
  title: string;
  /** The one sentence the assistant says about it. Also the phone notification text. */
  body: string;
  /** What the assistant found when it looked: ok = it worked, decide = the person has to choose, failed = it did not work, stopped = it stopped without a clear result. */
  verdict?: NoticeVerdict;
  /** A few more lines for the chat (plain text or simple markdown); never read aloud. */
  details?: string;
  agent?: string;
  /** Private computer-task notification, never inserted into the shared assistant history. */
  runtimeTask?: RuntimeTaskNoticeTarget;
  ts: number;
}

export type NoticeVerdict = "ok" | "decide" | "failed" | "stopped";

export interface AssistantItem {
  id: string;
  ts: number;
  role: "user" | "assistant" | "notice";
  text: string;
  /** How it was said; voice items come from the live call transcript or voice note. */
  via?: "text" | "voice";
  /** True when this chat answer was also spoken aloud in dual-track mode. */
  spoken?: boolean;
  /** What the assistant looked at or did for this answer, one short label each. */
  steps?: string[];
  action?: AssistantAction;
  notice?: Notice;
  error?: boolean;
}

/** Something the person asked to be reminded of: at a time, or when an agent stops. */
export interface Reminder {
  id: string;
  text: string;
  createdAt: number;
  dueAt?: number;
  agent?: string;
  /** With `agent`: fire when it needs you (`blocked`) or stops working (`finished`). */
  until?: "blocked" | "finished";
}

export interface AssistantState {
  items: AssistantItem[];
  /** True while the assistant is working on an answer. */
  busy: boolean;
  /** Whether the relay has a text model configured. */
  ready: boolean;
  /** Whether live voice (MOSS-Live) is configured on the relay. */
  voice: boolean;
  model?: string;
  reminders: Reminder[];
  /** Older relays leave it out: they always ask first. */
  settings?: AssistantSettings;
}

// ---------------------------------------------------------------------------
// Logs: the relay's own events plus what phones and computers upload
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One line a phone or computer uploads (`log` frame or POST /v1/logs). Never tokens or keys. */
export interface ClientLogEntry {
  ts: number;
  level: LogLevel;
  /** Short dotted area, e.g. link, rpc, stream, js, voice, update, pair, send, create. */
  kind: string;
  /** One line, at most ~500 characters; message text inside is clipped to ~200. */
  msg: string;
  data?: Record<string, unknown>;
}

/** A stored log line, as GET /v1/logs returns it. */
export interface LogEntry extends ClientLogEntry {
  id: number;
  /** Who wrote it: the relay itself, or the kind of device that uploaded it. */
  source: "relay" | DeviceKind;
  /** Device the line is from or about. */
  device?: string;
  deviceName?: string;
}

// ---------------------------------------------------------------------------
// Terminal stream
// ---------------------------------------------------------------------------

/**
 * `stream_subscribe` params of `stream: "terminal"`. Hosts ignore fields they
 * do not know, so a viewer can always send all of them.
 */
export interface TerminalStreamParams {
  agent: string;
  /** Lines of history above the screen (hosts default to 120, at most 600). */
  history?: number;
  /**
   * Ask for `terminal_rows` events (only the lines that changed) instead of a
   * whole `terminal` screen on every paint. Hosts before this ignore it and
   * keep sending `terminal` events: a viewer that asks must take both.
   */
  rows?: boolean;
  /**
   * `false`: no screen at all, only `queue` notices (the message box needs no
   * picture). Hosts before this still send screens, which the viewer drops.
   */
  screen?: boolean;
}

/**
 * Turns one list of lines into the next: every line, or the lines dropped
 * from the top (a scroll) plus the lines that differ after that.
 */
export interface RowsChange {
  /** Every line; replaces all. When present the other fields are absent. */
  lines?: string[];
  /** Lines dropped from the top first. */
  shift?: number;
  /** Line count afterwards: lines past it go, new ones start as "". */
  length?: number;
  /** Changed lines as [index after the shift, line]. */
  set?: Array<[number, string]>;
}

/**
 * A terminal paint as SGR-colored lines (history first, like the `ansi` of
 * `terminal.read` split at "\n"), relative to the previous event of the same
 * stream. The first event carries `lines`. Apply with `applyRows`.
 */
export interface TerminalRowsEvent extends RowsChange {
  kind: "terminal_rows";
  /** 1 on the first event of a stream, then +1. A gap means one was missed: subscribe again. */
  seq: number;
  /** Terminal size in cells; 0 when the source does not say (the herdr terminal app). */
  cols: number;
  rows: number;
  at: number;
}

/** How far the content moved up between two paints: the shift that keeps the most lines in place. */
function scrolledBy(prev: readonly string[], next: readonly string[]): number {
  if (!prev.length || !next.length) return 0;
  // Where sampled new lines sat before; a scroll moves them all by the same amount.
  const where = new Map<string, number[]>();
  for (let j = 0; j < prev.length; j++) {
    const line = prev[j]!;
    if (!line) continue;
    const at = where.get(line);
    if (!at) where.set(line, [j]);
    else if (at.length < 4) at.push(j);
  }
  const candidates = new Set<number>([0]);
  const step = Math.max(1, Math.floor(next.length / 16));
  for (let i = 0; i < next.length; i += step) {
    for (const j of where.get(next[i]!) ?? []) if (j > i) candidates.add(j - i);
  }
  let best = 0;
  let bestHits = -1;
  for (const k of candidates) {
    let hits = 0;
    const n = Math.min(next.length, prev.length - k);
    for (let i = 0; i < n; i++) if (next[i] === prev[i + k]) hits++;
    if (hits > bestHits || (hits === bestHits && k < best)) {
      best = k;
      bestHits = hits;
    }
  }
  return best;
}

/** The change from `prev` to `next` as a shift plus changed lines (never `lines`). */
export function diffRows(prev: readonly string[], next: readonly string[]): RowsChange {
  const shift = scrolledBy(prev, next);
  const set: Array<[number, string]> = [];
  for (let i = 0; i < next.length; i++) if ((prev[i + shift] ?? "") !== next[i]) set.push([i, next[i]!]);
  const out: RowsChange = { length: next.length };
  if (shift) out.shift = shift;
  if (set.length) out.set = set;
  return out;
}

/** What to send for `next` after `prev`: the diff, or every line when that is not larger. Null when nothing changed. */
export function rowsChange(prev: readonly string[] | null, next: readonly string[]): RowsChange | null {
  if (!prev) return { lines: [...next] };
  const d = diffRows(prev, next);
  if (!d.shift && !d.set && d.length === prev.length) return null;
  const diffSize = (d.set ?? []).reduce((n, [, line]) => n + line.length + 8, 24);
  const fullSize = next.reduce((n, line) => n + line.length + 3, 0);
  return diffSize < fullSize ? d : { lines: [...next] };
}

/** Applies a `RowsChange` (a `terminal_rows` event) to the lines it was made against. */
export function applyRows(prev: readonly string[], change: RowsChange): string[] {
  if (Array.isArray(change.lines)) return change.lines.map(String);
  const out = prev.slice(Math.max(0, Number(change.shift) || 0));
  const length = typeof change.length === "number" && change.length >= 0 ? change.length : out.length;
  while (out.length < length) out.push("");
  out.length = length;
  for (const [i, line] of Array.isArray(change.set) ? change.set : []) {
    if (Number.isInteger(i) && i >= 0 && i < length && typeof line === "string") out[i] = line;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket frames (JSON text frames, one message each)
// ---------------------------------------------------------------------------

/** Client (host or viewer) -> relay. */
export type ClientFrame =
  /** First frame from a host: what it can do. */
  | { type: "hello"; version: number; platform?: string; sources?: HostSource[]; appVersion?: string }
  /** Host publishes its whole agent list (replaces the previous one). */
  | { type: "agents"; agents: Agent[] }
  /** Host reports a task event. Relay looks up the original authenticated sender and never accepts a recipient here. */
  | { type: "runtime_task_event"; event: RuntimeTaskEvent }
  /** Call a method on a host. `to` is the target deviceId. */
  | { type: "rpc"; id: string; to: string; method: RpcMethod; params: unknown }
  /** Host answers an rpc it received. */
  | { type: "rpc_result"; id: string; result?: unknown; error?: RpcError }
  /** Start a long-lived host stream; `id` is scoped to the viewer connection. */
  | { type: "stream_subscribe"; id: string; to?: string; from?: string; stream: "terminal" | "session"; params: unknown }
  | { type: "stream_unsubscribe"; id: string; to?: string; from?: string }
  /** Host -> relay stream lifecycle and data frames. */
  | { type: "stream_open"; id: string; result?: unknown; error?: RpcError }
  | { type: "stream_event"; id: string; event: unknown }
  | { type: "ping"; t: number }
  /** A batch of the client's own log lines (at most 200); stored per device. Older relays ignore it. */
  | { type: "log"; entries: ClientLogEntry[] };

/** Relay -> client. */
export type ServerFrame =
  | { type: "welcome"; version: number; device: Device; seq: number; runtimeTaskNotices?: true }
  /** Event persisted or already processed; host can stop retrying it on this link. */
  | { type: "runtime_task_ack"; eventId: string }
  /** Full state snapshot, sent after welcome to every client. */
  | { type: "snapshot"; seq: number; devices: Device[]; agents: Agent[] }
  | { type: "device"; seq: number; device: Device }
  | { type: "device_removed"; seq: number; id: string }
  /** Agents of one host changed (replace all agents of that device). */
  | { type: "agents"; seq: number; deviceId: string; agents: Agent[] }
  /** Forwarded rpc for a host to execute; `from` is the caller deviceId. */
  | { type: "rpc"; id: string; from: string; method: RpcMethod; params: unknown }
  | { type: "rpc_result"; id: string; result?: unknown; error?: RpcError }
  /** Stream subscription forwarded to a host. */
  | { type: "stream_subscribe"; id: string; from: string; stream: "terminal" | "session"; params: unknown }
  | { type: "stream_unsubscribe"; id: string; from: string }
  /**
   * A host has accepted a stream subscription. With `error` after it was
   * open: the stream ended (its computer went away); subscribe again later.
   */
  | { type: "stream_open"; id: string; result?: unknown; error?: RpcError }
  /**
   * Incremental terminal/session update from a subscribed host. Terminal
   * streams carry `{ kind: "terminal", screen }` (a whole `terminal.read`
   * result), `TerminalRowsEvent` when asked for, `queue` and `stale` notices.
   */
  | { type: "stream_event"; id: string; event: unknown }
  | { type: "pong"; t: number }
  | { type: "error"; error: RpcError }
  /** Assistant thread: a new item, or a newer version of one with the same id. Sent to viewers. */
  | { type: "assistant_item"; item: AssistantItem }
  /** The assistant started or stopped working; `label` says on what. */
  | { type: "assistant_busy"; busy: boolean; label?: string }
  /** The thread was cleared or reminders changed: refetch GET /v1/assistant. */
  | { type: "assistant_reset" }
  | { type: "assistant_profile"; profile: AssistantPersonaConfig }
  | { type: "assistant_memories" }
  | { type: "ledger_updated" }
  /** Normal-chat local TTS stream for an assistant or notice item. */
  | {
      type: "assistant_speech";
      itemId: string;
      utteranceId: string;
      phase: "start" | "chunk" | "done" | "stop";
      sampleRate?: number;
      pcmBase64?: string;
      error?: string;
    };

/**
 * GET /v1/notify?token=...&since=<ms> (WebSocket, viewers only): a light push
 * channel for a phone's background service, separate from the main socket so
 * it never replaces it. Server -> phone only, JSON text frames.
 */
export type NotifyFrame = { type: "notice"; notice: Notice } | { type: "hello"; ts: number };

/**
 * GET /v1/assistant/live?token=... (WebSocket, viewers only): a voice call.
 *
 * Phone -> relay: binary = 16 kHz mono PCM S16LE microphone audio; text = JSON
 * `{action, ...}` limited to LIVE_CLIENT_ACTIONS.
 * Relay -> phone: binary = 48 kHz mono PCM S16LE speech, each preceded by a
 * `response.audio.context` text frame; text = MOSS-Live events (`{action, data}`)
 * plus the relay's own `relay.state` and `relay.task`.
 *
 * Playback receipts follow what the speaker really played. Before
 * `playback.stopped` the phone receipts every chunk it played in full;
 * `played_audio_ms` is all of the answer it played, and the relay turns it into
 * what the service expects (MOSS-Live: only the part of the chunk being played).
 */
export const LIVE_CLIENT_ACTIONS = [
  "mic_state",
  "playback.chunk.completed",
  "playback.completed",
  "playback.stopped",
  "ping",
] as const;

export type LiveRelayEvent =
  | { action: "relay.state"; data: { state: "connecting" | "ready" | "closed" | "error"; message?: string } }
  /** A background task the voice assistant handed to the text assistant. */
  | { action: "relay.task"; data: { id: string; title: string; status: "running" | "done" | "failed" } }
  /**
   * A proactive notice arrived during the call. `line` is what the voice will say; `how` tells when:
   * `now` (it is being said through a running task) or `next` (the voice brings it up the next time the person speaks).
   */
  | { action: "relay.notice"; data: { id: string; line: string; how: "now" | "next" } };

// ---------------------------------------------------------------------------
// Assistant REST (device token)
// ---------------------------------------------------------------------------
//
// GET    /v1/assistant                        -> AssistantState
// POST   /v1/assistant/messages  {text}       -> { item }   (answer arrives as assistant_item frames)
// POST   /v1/assistant/actions/:id {decision: "confirm"|"cancel"} -> { item }
// DELETE /v1/assistant/thread                 -> { ok: true }  (starts a new conversation)
// DELETE /v1/assistant/reminders/:id          -> { ok: true }
// GET    /v1/assistant/settings               -> AssistantSettings & { default: AssistantConfirm }
// POST   /v1/assistant/settings {confirm}     -> AssistantSettings   (phones see assistant_reset)
//
// Logs
// POST   /v1/logs   (device)        body { entries: ClientLogEntry[] } -> { stored }   (same as the `log` frame)
// GET    /v1/logs   (device|admin)  ?since=1h|<ms>&until=&after=<id>&device=<id|name>&kind=&level=&source=&text=&limit=
//                                   -> { entries: LogEntry[] }   (oldest first; `after` for following)
// GET    /admin                     a small control panel (admin token, kept in the tab's sessionStorage)

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
//
// GET    /v1/health                         -> { ok, version, devices, online }
// POST   /v1/pair/codes        (admin|device) body {kind?, ttlSec?} -> PairCode
// POST   /v1/pair              body PairRequest -> PairResponse   (no auth; code is the secret.
//                              Sending the device's previous token replaces that registration.)
// POST   /v1/join              body {name, kind, platform?} -> JoinTicket   (no auth; rate limited.
//                              A new device asks to join and shows `link` as a QR.)
// POST   /v1/join/:id/claim    body {secret} -> JoinClaim          (the asking device polls this)
// GET    /v1/join/:id          (device)     -> JoinRequest         (what the approver is shown)
// POST   /v1/join/:id/approve  (device)     -> { device: Device }
// POST   /v1/join/:id/deny     (device)     -> { ok: true }
// GET    /v1/devices           (device)     -> { devices: Device[] }
// DELETE /v1/devices/:id       (device)     -> { ok: true }       (revoke)
// GET    /v1/ws?token=...      WebSocket
// GET    /p/:code              HTML landing page for an invite QR (opens the app, shows the code).
// GET    /j/:id                HTML landing page for a join QR. Both only echo the URL; they never
//                              look the code or request up.
//
// First run: while the relay has no devices it keeps a one-time setup code (any device kind,
// 30 min) printed at startup and by `node apps/relay/src/bootstrap.ts`; it is deleted as soon
// as the first device registers.
//
// Auth: `Authorization: Bearer <deviceToken>` (or `?token=` for WebSocket).
// Admin endpoints also accept the relay's admin token.

export interface PairCode {
  code: string; // short human code, e.g. "MEOW-4821"
  expiresAt: number;
  /** What the QR encodes: an https page on the relay, `<server>/p/<code>` (see pairLink). */
  link: string;
}

export interface PairRequest {
  code: string;
  name: string;
  kind: DeviceKind;
  platform?: string;
}

export interface PairResponse {
  device: Device;
  token: string;
}

/** A device asking to join; a paired device scans its QR and approves it. */
export interface JoinRequest {
  id: string;
  name: string;
  kind: DeviceKind;
  platform?: string;
  expiresAt: number;
}

export interface JoinTicket extends JoinRequest {
  /** Known only to the asking device; needed to collect the token. */
  secret: string;
  /** What the QR encodes: an https page on the relay, `<server>/j/<id>` (see joinLink). */
  link: string;
}

export type JoinClaim = { status: "pending" } | { status: "denied" } | ({ status: "approved" } & PairResponse);

// Links. QR codes carry an https page on the relay (`<server>/p/<code>`, `<server>/j/<id>`),
// so any camera can open them; the page hands the same data to the app through its own
// scheme (`xiaoaixiaoai://pair?...`, `xiaoaixiaoai://join?...`). The app reads web and app forms,
// but deliberately does not claim the upstream app's scheme.

const PAIR_CODE = /^[A-Za-z]{2,8}-?\d{2,8}$/;
const JOIN_ID = /^[A-Za-z0-9_-]{8,32}$/;
const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");

/** `<server>/<kind>/<value>`, allowing a trailing slash and query/fragment (chat apps append them). */
function parseWebLink(link: string, kind: "p" | "j"): { server: string; value: string } | null {
  const m = new RegExp(`^(https?:\\/\\/[^\\s?#]+)\\/${kind}\\/([A-Za-z0-9_-]+)\\/?(?:[?#]\\S*)?$`, "i").exec(link.trim());
  return m ? { server: m[1]!, value: m[2]! } : null;
}

function parseAppLink(link: string, kind: "pair" | "join", key: "code" | "id"): { server: string; value: string } | null {
  const m = new RegExp(`^${APP_SCHEME}:\\/\\/${kind}\\/?\\?(.*)$`, "i").exec(link.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const server = q.get("server");
  const value = q.get(key);
  return server && value ? { server, value } : null;
}

/** What a join QR encodes: an https page on the relay. */
export function joinLink(server: string, id: string): string {
  return `${trimSlash(server)}/j/${encodeURIComponent(id)}`;
}

/** The app's own deep link for a join request. */
export function joinAppLink(server: string, id: string): string {
  return `${APP_SCHEME}://join?server=${encodeURIComponent(trimSlash(server))}&id=${encodeURIComponent(id)}`;
}

export function parseJoinLink(link: string): { server: string; id: string } | null {
  const hit = parseWebLink(link, "j") ?? parseAppLink(link, "join", "id");
  return hit && JOIN_ID.test(hit.value) ? { server: hit.server, id: hit.value } : null;
}

/** What an invite QR encodes: an https page on the relay. */
export function pairLink(server: string, code: string): string {
  return `${trimSlash(server)}/p/${encodeURIComponent(code)}`;
}

/** The app's own deep link for an invite. */
export function pairAppLink(server: string, code: string): string {
  return `${APP_SCHEME}://pair?server=${encodeURIComponent(trimSlash(server))}&code=${encodeURIComponent(code)}`;
}

export function parsePairLink(link: string): { server: string; code: string } | null {
  const hit = parseWebLink(link, "p") ?? parseAppLink(link, "pair", "code");
  return hit && PAIR_CODE.test(hit.value.trim()) ? { server: hit.server, code: normalizeCode(hit.value) } : null;
}

/** Codes are case-insensitive and the dash is optional: "meow4821" -> "MEOW-4821". */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/^([A-Z]+)-?(\d+)$/, "$1-$2");
}

export function isPairCode(code: string): boolean {
  return PAIR_CODE.test(code);
}

export function isJoinId(id: string): boolean {
  return JOIN_ID.test(id);
}

/**
 * What a person may paste or type when pairing: a pair link (alone or inside a pasted
 * message), a "server code" pair, or just the code. The server is absent for a bare code.
 */
export function parsePairInput(input: string): { server?: string; code: string } | null {
  const text = input.trim();
  if (!text) return null;
  const link = parsePairLink(text);
  if (link) return link;
  // Scan whole URI candidates, so a URL nested inside a foreign app's query is not
  // accidentally treated as our invite. parsePairLink accepts only web links/our scheme.
  for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>，。；）)]+/gi)) {
    const inner = parsePairLink(m[0]);
    if (inner) return inner;
  }
  const parts = text.split(/\s+/);
  const code = parts[parts.length - 1]!;
  if (!PAIR_CODE.test(code)) return null;
  const normalized = normalizeCode(code);
  if (parts.length === 1) return { code: normalized };
  const server = parts.slice(0, -1).join("");
  return /^(https?:\/\/)?[\w.-]+(:\d+)?(\/\S*)?$/i.test(server) ? { server, code: normalized } : null;
}

// Releases are served exclusively from the owned repository below (or via the user's paired relay).
export const RELEASE_REPO: string | null = "momokiana/notionapp";
export const RELEASE_UPDATES_ENABLED: boolean = RELEASE_REPO !== null;
export const RELEASE_UPDATES_DISABLED_REASON = `Release updates are disabled: remote release lookup is turned off for ${APP_DISPLAY_NAME}.`;

/** Where people download this app by hand; null means no owned download source exists. */
export const RELEASES_PAGE: string | null = RELEASE_REPO ? `https://github.com/${RELEASE_REPO}/releases/latest` : null;

/** Release asset contract: `xiaoaixiaoai-<version>-android-arm64.apk`, version without a leading "v". */
export function apkAssetName(version: string): string {
  return `${RELEASE_ASSET_PREFIX}-${version.trim().replace(/^v/i, "")}-android-arm64.apk`;
}

/** A release asset's address, or null while this fork has no owned release source. */
export function releaseAssetUrl(version: string, name: string): string | null {
  if (!RELEASE_UPDATES_ENABLED || !RELEASE_REPO) return null;
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version.trim().replace(/^v/i, "")}/${name}`;
}

/** The newest release's checksum list, absent until an owned source is configured. */
export const LATEST_SUMS_URL: string | null = RELEASE_REPO ? `https://github.com/${RELEASE_REPO}/releases/latest/download/SHA256SUMS` : null;

/** Time-zone helper retained for future owned release-source policy; it enables no networking. */
export const CHINA_TIME_ZONES: ReadonlySet<string> = new Set(["Asia/Shanghai", "Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar", "PRC"]);

/** No third-party release proxies are enabled for this fork. Review them with the owned source. */
export const RELEASE_MIRRORS: readonly string[] = [];

/** This device's IANA time zone, or "" when the runtime cannot say. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** True when the time zone is mainland China's. */
export function inMainlandChina(timeZone: string = localTimeZone()): boolean {
  return CHINA_TIME_ZONES.has(timeZone);
}

/**
 * Where to fetch a GitHub release file from, in order: the mirrors first in mainland China,
 * GitHub itself first elsewhere, and the others after it when it fails. Whatever comes
 * through a mirror is checked against SHA256SUMS, and Android only installs an update
 * signed with the app's own key.
 */
export function releaseSources(githubUrl: string | null, china: boolean): string[] {
  if (!RELEASE_UPDATES_ENABLED || !githubUrl) return [];
  const mirrored = RELEASE_MIRRORS.map((m) => m + githubUrl);
  return china ? [...mirrored, githubUrl] : [githubUrl, ...mirrored];
}

/** The release a `SHA256SUMS` listing belongs to: its version and each file's hash. */
export function releaseFromSums(listing: string): { version: string; sums: Record<string, string> } | null {
  const sums: Record<string, string> = {};
  let version = "";
  for (const line of listing.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (!m) continue;
    sums[m[2]!] = m[1]!.toLowerCase();
    const v = new RegExp(`^${RELEASE_ASSET_PREFIX}-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)(?:-android-arm64\\.apk|\\.tar\\.gz)$`).exec(m[2]!);
    if (v && !version) version = v[1]!;
  }
  return version ? { version, sums } : null;
}

/**
 * Compares "1.2.10" with "v1.3" part by part as numbers. A pre-release ("1.3.0-beta.1")
 * sorts before its release. Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const s = v.trim().replace(/^v/i, "");
    const dash = s.indexOf("-");
    const main = dash < 0 ? s : s.slice(0, dash);
    return { nums: main.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: dash < 0 ? undefined : s.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  // Numbers inside pre-release tags compare as numbers: rc.10 is after rc.9.
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

// ---------------------------------------------------------------------------
// Helpers shared by host and app
// ---------------------------------------------------------------------------

export const SHELL_HARNESSES = new Set(["sh", "zsh", "bash", "fish", "nu", "pwsh", "powershell", "shell"]);

export function normalizeStatus(raw: string | null | undefined): AgentStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "working":
    case "work":
    case "busy":
      return "working";
    case "blocked":
    case "waiting":
    case "needs_input":
    // The program stopped on an error (e.g. "pick a different model"): it waits for a person too.
    // `statusNote` carries what it said.
    case "error":
    case "failed":
      return "blocked";
    case "done":
      return "done";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

/**
 * Effective session status across a main agent and its spawned subagents:
 * paused/done parents with running subagents stay `"working"` unless blocked.
 */
export function effectiveAgentStatus(a: { status: AgentStatus; subagentsWorking?: number }): AgentStatus {
  if (a.status === "blocked") return "blocked";
  if ((a.subagentsWorking ?? 0) > 0) return "working";
  return a.status;
}

/** Sort weight: what needs a human first. */
export const STATUS_ORDER: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

export type LedgerTxDirection = "expense" | "income";
export type LedgerTxSource = "wechat_notify" | "assistant" | "manual";

export interface LedgerFixedExpense {
  id: string;
  name: string;
  /** Positive integer cents (分). */
  amountCents: number;
  /** Month (`YYYY-MM`) marked as paid this month, or null/undefined if still unpaid. */
  paidYm?: string | null;
  createdAt: number;
}

export interface LedgerTransaction {
  id: string;
  ts: number;
  ym: string;
  ymd: string;
  direction: LedgerTxDirection;
  amountCents: number;
  title: string;
  note?: string;
  source: LedgerTxSource;
  /** Idempotency key for WeChat notification captures. */
  externalId?: string;
  /** Linked monthly fixed expense id when this spend fulfills a pre-reserved fixed item. */
  fixedId?: string;
}

export interface LedgerConfig {
  enabled: boolean;
  /** Estimated current WeChat wallet balance in cents; null until calibrated once. */
  balanceCents: number | null;
  /** Target minimum balance to keep by month-end (月底至少保留/想省出的钱), in cents. */
  savingsGoalCents: number;
  balanceUpdatedAt: number | null;
}

export interface LedgerDateParts {
  ym: string;
  ymd: string;
  day: number;
  daysInMonth: number;
}

export interface LedgerPlan {
  ym: string;
  ymd: string;
  daysInMonth: number;
  daysLeftInclusive: number;
  daysLeftAfterToday: number;
  balanceCents: number | null;
  savingsGoalCents: number;
  unpaidFixedCents: number;
  paidFixedCents: number;
  monthIncomeCents: number;
  monthExpenseCents: number;
  todayExpenseCents: number;
  todayDiscretionaryExpenseCents: number;
  spendableNowCents: number | null;
  todayLimitCents: number | null;
  todayRemainingCents: number | null;
  nextDailyLimitCents: number | null;
  overspentTodayCents: number;
}

export interface LedgerAlertSummary {
  title: string;
  body: string;
  overspent: boolean;
}

export interface LedgerState {
  config: LedgerConfig;
  fixedExpenses: LedgerFixedExpense[];
  plan: LedgerPlan;
  recentTransactions: LedgerTransaction[];
}

export function daysInYearMonth(year: number, month1Based: number): number {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

export function formatYuan(cents: number): string {
  const neg = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${neg}${whole}` : `${neg}${whole}.${String(rem).padStart(2, "0")}`;
}

/** Exact integer cents parser without floating-point rounding drift. */
export function parseYuanToCents(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[¥￥,\s元块]/g, "");
  if (!s) return null;
  const m = /^(-)?(\d+)(?:\.(\d{1,}))?$/.exec(s);
  if (!m) return null;
  const neg = m[1] === "-";
  const whole = Number.parseInt(m[2]!, 10);
  const fracRaw = (m[3] ?? "").slice(0, 2).padEnd(2, "0");
  const frac = Number.parseInt(fracRaw || "0", 10);
  if (!Number.isFinite(whole) || !Number.isFinite(frac) || whole > 10_000_000) return null;
  const total = whole * 100 + frac;
  return neg ? -total : total;
}

/**
 * Calculates remaining monthly spendable budget, today's allowance, and tomorrow-onwards
 * re-planned daily cap based strictly on current balance, unpaid fixed bills, and savings goal.
 */
export function computeLedgerPlan(
  config: LedgerConfig,
  fixedExpenses: LedgerFixedExpense[],
  monthTransactions: LedgerTransaction[],
  date: LedgerDateParts,
): LedgerPlan {
  const daysLeftInclusive = Math.max(1, date.daysInMonth - date.day + 1);
  const daysLeftAfterToday = Math.max(0, date.daysInMonth - date.day);

  let unpaidFixedCents = 0;
  let paidFixedCents = 0;
  for (const f of fixedExpenses) {
    if (f.paidYm === date.ym) paidFixedCents += f.amountCents;
    else unpaidFixedCents += f.amountCents;
  }

  let monthIncomeCents = 0;
  let monthExpenseCents = 0;
  let todayExpenseCents = 0;
  let todayDiscretionaryExpenseCents = 0;
  for (const tx of monthTransactions) {
    if (tx.ym !== date.ym) continue;
    if (tx.direction === "income") {
      monthIncomeCents += tx.amountCents;
    } else {
      monthExpenseCents += tx.amountCents;
      if (tx.ymd === date.ymd) {
        todayExpenseCents += tx.amountCents;
        if (!tx.fixedId) todayDiscretionaryExpenseCents += tx.amountCents;
      }
    }
  }

  if (config.balanceCents === null) {
    return {
      ym: date.ym,
      ymd: date.ymd,
      daysInMonth: date.daysInMonth,
      daysLeftInclusive,
      daysLeftAfterToday,
      balanceCents: null,
      savingsGoalCents: config.savingsGoalCents,
      unpaidFixedCents,
      paidFixedCents,
      monthIncomeCents,
      monthExpenseCents,
      todayExpenseCents,
      todayDiscretionaryExpenseCents,
      spendableNowCents: null,
      todayLimitCents: null,
      todayRemainingCents: null,
      nextDailyLimitCents: null,
      overspentTodayCents: 0,
    };
  }

  const spendableNowCents = config.balanceCents - unpaidFixedCents - config.savingsGoalCents;
  const spendableStartOfTodayCents = spendableNowCents + todayDiscretionaryExpenseCents;
  const todayLimitCents = Math.max(0, Math.floor(spendableStartOfTodayCents / daysLeftInclusive));
  const todayRemainingCents = todayLimitCents - todayDiscretionaryExpenseCents;
  const overspentTodayCents = todayRemainingCents < 0 ? -todayRemainingCents : 0;
  const nextDailyLimitCents =
    daysLeftAfterToday > 0 ? Math.max(0, Math.floor(Math.max(0, spendableNowCents) / daysLeftAfterToday)) : null;

  return {
    ym: date.ym,
    ymd: date.ymd,
    daysInMonth: date.daysInMonth,
    daysLeftInclusive,
    daysLeftAfterToday,
    balanceCents: config.balanceCents,
    savingsGoalCents: config.savingsGoalCents,
    unpaidFixedCents,
    paidFixedCents,
    monthIncomeCents,
    monthExpenseCents,
    todayExpenseCents,
    todayDiscretionaryExpenseCents,
    spendableNowCents,
    todayLimitCents,
    todayRemainingCents,
    nextDailyLimitCents,
    overspentTodayCents,
  };
}

/** Builds a clear push notification message after capturing or recording a transaction. */
export function formatBudgetAlert(
  tx: Pick<LedgerTransaction, "direction" | "amountCents" | "title">,
  plan: LedgerPlan,
): LedgerAlertSummary {
  const amt = formatYuan(tx.amountCents);
  const label = tx.title.trim() || (tx.direction === "income" ? "微信收款" : "微信消费");
  const balNote = plan.balanceCents !== null ? `当前余额约 ${formatYuan(plan.balanceCents)} 元` : "尚未设置初始余额";

  if (tx.direction === "income") {
    const quota =
      plan.todayRemainingCents !== null
        ? plan.todayRemainingCents >= 0
          ? `，今天还能用 ${formatYuan(plan.todayRemainingCents)} 元`
          : `，今日仍超出 ${formatYuan(-plan.todayRemainingCents)} 元`
        : "";
    return {
      title: `微信收款 ${amt} 元`,
      body: `「${label}」已入账，${balNote}${quota}。`,
      overspent: false,
    };
  }

  if (plan.overspentTodayCents > 0) {
    const over = formatYuan(plan.overspentTodayCents);
    if (plan.daysLeftAfterToday > 0) {
      const next = formatYuan(plan.nextDailyLimitCents ?? 0);
      const shortNote =
        plan.spendableNowCents !== null && plan.spendableNowCents <= 0 ? "（当前已不足覆盖保底/固定开支）" : "";
      return {
        title: `今日超支 ${over} 元`,
        body: `刚支出 ${amt} 元（${label}），${balNote}。已按剩余 ${plan.daysLeftAfterToday} 天重算：接下来每天最多用 ${next} 元${shortNote}。`,
        overspent: true,
      };
    }
    return {
      title: `今日超支 ${over} 元`,
      body: `刚支出 ${amt} 元（${label}），已是本月最后一天，${balNote}。`,
      overspent: true,
    };
  }

  const leftNote =
    plan.todayRemainingCents !== null
      ? `，今天还能用 ${formatYuan(plan.todayRemainingCents)} 元`
      : "（开启界面设置一次当前余额即可按日限额）";
  return {
    title: `微信支出 ${amt} 元`,
    body: `「${label}」已记账，${balNote}${leftNote}。`,
    overspent: false,
  };
}

export interface LedgerDayBar {
  ymd: string;
  label: string;
  expenseCents: number;
}

/** Last `count` calendar days ending at `todayYmd` (`YYYY-MM-DD`), oldest to newest, with discretionary expense totals. */
export function computeRecentDaysBars(
  transactions: LedgerTransaction[],
  todayYmd: string,
  count = 7,
): LedgerDayBar[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayYmd);
  if (!m) return [];
  const baseMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const totals = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.direction !== "expense" || tx.fixedId) continue;
    totals.set(tx.ymd, (totals.get(tx.ymd) ?? 0) + tx.amountCents);
  }
  const bars: LedgerDayBar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(baseMs - i * 86_400_000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const ymd = `${yyyy}-${mm}-${dd}`;
    bars.push({
      ymd,
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      expenseCents: totals.get(ymd) ?? 0,
    });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Assistant persona & server-side personal memory bank
// ---------------------------------------------------------------------------

export type MemoryCategory =
  | "profile"
  | "habit"
  | "preference"
  | "schedule"
  | "relationship"
  | "work"
  | "note";

export const MEMORY_CATEGORIES: ReadonlyArray<{
  id: MemoryCategory;
  label: string;
  hint: string;
}> = [
  { id: "profile", label: "核心档案", hint: "城市、身份、常住地、基本信息" },
  { id: "habit", label: "生活习惯", hint: "作息时间、日常节律、健身频率" },
  { id: "preference", label: "偏好忌口", hint: "饮食口味、过敏忌口、沟通喜好" },
  { id: "schedule", label: "日程日子", hint: "纪念日、发薪日、固定计划、近期日程" },
  { id: "relationship", label: "重要的人", hint: "家人、朋友、同事、宠物称呼" },
  { id: "work", label: "工作项目", hint: "项目别名、电脑分工、工作约定" },
  { id: "note", label: "随手备忘", hint: "零碎生活琐事与长期交代" },
] as const;

export interface AssistantMemoryItem {
  id: string;
  category: MemoryCategory;
  /** Optional slot key so updated facts (e.g. sleep_time / city) supersede old values cleanly. */
  slotKey?: string;
  content: string;
  /** 3 = core permanent, 2 = important long-term, 1 = normal daily fact. */
  importance: 1 | 2 | 3;
  pinned?: boolean;
  expiresAt?: number;
  source: "user" | "assistant" | "seed";
  createdAt: number;
  updatedAt: number;
}

export interface AssistantPersonaConfig {
  name: string;
  /** How she addresses the user (e.g. "哥哥"). */
  userCall: string;
  /** "wuthering_aemeath" | "warm_friend" | "custom" */
  presetId: string;
  personaText: string;
  /** True: assistant can capture stable life/personal facts during normal chat/calls. */
  autoMemory: boolean;
  updatedAt: number;
}

export interface PersonaPresetSummary {
  id: string;
  label: string;
  userCall: string;
  summary: string;
  personaText: string;
}
