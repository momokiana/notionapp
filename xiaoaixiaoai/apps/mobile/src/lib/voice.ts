/**
 * Voice call state for the UI. The audio itself runs natively (modules/xiaoaixiaoai-native):
 * here we only start/stop the call and turn its events into captions and a phase
 * the call screen animates.
 */
import { PermissionsAndroid, Platform } from "react-native";
import { makeMutable, withTiming } from "react-native-reanimated";
import { create } from "zustand";
import { XiaoaiNative } from "../../modules/xiaoaixiaoai-native";
import { useSettings } from "./store";
import { loadToken } from "./auth";
import { isMockServer, mockAssistant } from "./mock";
import { applog } from "./applog";

export type CallStatus = "idle" | "connecting" | "ready" | "ended";

/** What the call is doing right now; one at a time, in this order of priority. */
export type CallPhase = "connecting" | "speaking" | "thinking" | "muted" | "listening" | "idle";

/** One caption of the current call. Text is always the whole line so far, never a piece. */
export interface CallLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** False while the line is still being said. */
  final: boolean;
}

interface VoiceState {
  status: CallStatus;
  muted: boolean;
  /** Why the last call ended or failed; shown once. */
  message: string | null;
  /** Captions of this call, oldest first. */
  lines: CallLine[];
  speaking: boolean;
  listening: boolean;
  /** The person finished a sentence and the answer has not started yet. */
  waiting: boolean;
  task: { id: string; title: string; status: "running" | "done" | "failed" } | null;
  /** When the call was answered; null until then. */
  startedAt: number | null;
}

const QUIET = { speaking: false, listening: false, waiting: false, task: null, lines: [] as CallLine[] };

export const useVoice = create<VoiceState>()(() => ({
  status: "idle",
  muted: false,
  message: null,
  startedAt: null,
  ...QUIET,
}));

/**
 * Loudness 0..1 of whoever is audible (the assistant while it speaks, otherwise
 * the microphone). Lives outside React so ten updates a second animate on the UI
 * thread without re-rendering the screen.
 */
export const callLevel = makeMutable(0);

export function callPhase(s: Pick<VoiceState, "status" | "speaking" | "task" | "waiting" | "muted" | "listening">): CallPhase {
  if (s.status === "connecting") return "connecting";
  if (s.speaking) return "speaking";
  if (s.task || s.waiting) return "thinking";
  if (s.muted) return "muted";
  if (s.listening) return "listening";
  return "idle";
}

const MAX_LINES = 30;

/** Adds a caption or replaces the one with the same id. */
function upsertLine(lines: CallLine[], line: CallLine): CallLine[] {
  const i = lines.findIndex((l) => l.id === line.id);
  if (i >= 0) {
    const next = lines.slice();
    next[i] = line;
    return next;
  }
  return [...lines, line].slice(-MAX_LINES);
}

/** The person's sentence in progress has no turn number yet; it gets one when it ends. */
const OPEN_USER = "u:open";
let waitTimer: ReturnType<typeof setTimeout> | null = null;
let lastOutAt = 0;
/** The sentence the person just finished, to tell its late pieces from a new sentence. */
let lastHeard = { text: "", at: 0 };

function setWaiting(on: boolean) {
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = on ? setTimeout(() => useVoice.setState({ waiting: false }), 20_000) : null;
  useVoice.setState({ waiting: on });
}

/** Turns one call event (MOSS-Live action, or a relay.* one) into state. Exported for the demo and tests. */
export function applyCallEvent(action: string | undefined, d: Record<string, any>): void {
  const text = typeof d.text === "string" ? d.text : "";
  switch (action) {
    case "input.speech.started":
      setWaiting(false);
      useVoice.setState({ listening: true });
      break;
    case "input.speech.stopped":
      useVoice.setState({ listening: false });
      break;
    case "input.transcript.updated":
      if (!text.trim()) break;
      // A piece of the sentence that has just ended can arrive after its end: it is not a new sentence.
      if (Date.now() - lastHeard.at < 2500 && lastHeard.text.startsWith(text.trim())) break;
      useVoice.setState((s) => ({ lines: upsertLine(s.lines, { id: OPEN_USER, role: "user", text, final: false }) }));
      break;
    case "input.transcript.done":
    case "input.transcript.revised": {
      const id = d.turn != null ? `u:${d.turn}` : OPEN_USER;
      useVoice.setState((s) => {
        // The sentence in progress becomes this turn; a later correction replaces the turn's text.
        const rest = action === "input.transcript.done" ? s.lines.filter((l) => l.id !== OPEN_USER) : s.lines;
        return { lines: text.trim() ? upsertLine(rest, { id, role: "user", text, final: true }) : rest.filter((l) => l.id !== id) };
      });
      if (action === "input.transcript.done" && text.trim()) {
        lastHeard = { text: text.trim(), at: Date.now() };
        setWaiting(true);
      }
      break;
    }
    case "output.transcript.updated":
    case "output.transcript.done": {
      if (!text.trim()) break;
      const id = `a:${d.run_id ?? d.turn_id ?? "current"}`;
      useVoice.setState((s) => ({ lines: upsertLine(s.lines, { id, role: "assistant", text, final: action === "output.transcript.done" }) }));
      break;
    }
    case "response.audio.started":
      setWaiting(false);
      lastOutAt = Date.now();
      useVoice.setState({ speaking: true });
      break;
    case "response.interrupted": {
      // Cut off mid-sentence: keep what was actually said.
      const id = `a:${d.run_id ?? d.turn_id ?? "current"}`;
      lastOutAt = 0;
      useVoice.setState((s) => ({
        speaking: false,
        lines: text.trim() ? upsertLine(s.lines, { id, role: "assistant", text: `${text.trim()}…`, final: true }) : s.lines.map((l) => (l.id === id ? { ...l, final: true } : l)),
      }));
      break;
    }
    case "response.ended":
      setWaiting(false);
      break;
    case "relay.task":
      useVoice.setState({ task: d.status === "running" ? (d as VoiceState["task"]) : null });
      break;
    case "call.stats":
      // From the native player when a call ends: how smooth the speech was on this phone.
      applog(d.stalls || d.underruns > 0 ? "warn" : "info", "voice", `call audio: ${d.stalls ?? 0} stalls, ${d.underruns ?? -1} underruns, cushion ${d.target_ms ?? 0}/${d.max_target_ms ?? 0} ms, ${d.stops ?? 0} cut`, d);
      break;
    case "error":
      applog("warn", "voice", `voice service error ${d.error?.code ?? "unknown"}`);
      useVoice.setState({ message: `语音服务报错：${d.error?.code ?? "未知"}` });
      break;
  }
}

/** Loudness from the native side, ten times a second. Also decides when the assistant has really stopped being heard. */
export function applyCallLevel(mic: number, out: number): void {
  const now = Date.now();
  if (out > 0.012) lastOutAt = now;
  const s = useVoice.getState();
  // Speech has short gaps between words; only a real pause counts as having stopped.
  const audible = now - lastOutAt < 450;
  if (audible !== s.speaking && s.status === "ready") useVoice.setState({ speaking: audible });
  const level = audible ? out : s.muted ? 0 : mic;
  callLevel.value = withTiming(Math.min(1, Math.max(0, level)), { duration: 110 });
}

export const voiceSupported = !!XiaoaiNative;

let wired = false;
function wire() {
  if (wired || !XiaoaiNative) return;
  wired = true;
  XiaoaiNative.addListener("onCall", (e) => {
    if (e.state !== useVoice.getState().status) applog(e.state === "ended" && e.message ? "warn" : "info", "voice", `call ${e.state}${e.message ? `: ${e.message}` : ""}`);
    if (e.state === "ended") {
      setWaiting(false);
      callLevel.value = 0;
      useVoice.setState({ status: "ended", message: e.message ?? null, muted: false, startedAt: null, ...QUIET });
    } else {
      useVoice.setState((s) => ({
        status: e.state,
        startedAt: e.state === "ready" ? (s.startedAt ?? Date.now()) : s.startedAt,
        ...(e.muted !== undefined ? { muted: e.muted } : {}),
      }));
    }
  });
  XiaoaiNative.addListener("onLevel", (e) => applyCallLevel(e.mic, e.out));
  XiaoaiNative.addListener("onCallEvent", ({ json }) => {
    let m: { action?: string; data?: Record<string, any> };
    try {
      m = JSON.parse(json);
    } catch {
      return;
    }
    applyCallEvent(m.action, m.data ?? {});
  });
  // A call can outlive the screen (it runs in the background service).
  const s = XiaoaiNative.callState();
  if (s.active) useVoice.setState({ status: "ready", muted: s.muted, startedAt: Date.now() });
}
wire();

/** Starts a call; resolves with an error message when it cannot. */
export async function startCall(): Promise<string | null> {
  const server = useSettings.getState().server;
  if (isMockServer(server)) {
    startDemoCall();
    return null;
  }
  if (!XiaoaiNative || Platform.OS !== "android") return "这个版本的 App 还不支持语音，装一下新版";
  if (!server) return "还没连上服务器";
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: "用麦克风和助理说话",
    message: "通话时把你的声音发给助理，挂断后就停止。",
    buttonPositive: "允许",
  });
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) return "没有麦克风权限，没法语音。可以在系统设置里打开";
  const token = await loadToken();
  if (!token) return "这台手机还没配对";
  useVoice.setState({ status: "connecting", message: null, muted: false, startedAt: null, ...QUIET });
  XiaoaiNative.startCall(server, token);
  return null;
}

export function hangup() {
  if (demo) {
    stopDemoCall("挂断了");
    return;
  }
  XiaoaiNative?.hangup();
}

export function toggleMute() {
  const next = !useVoice.getState().muted;
  useVoice.setState({ muted: next });
  if (!demo) XiaoaiNative?.setMuted(next);
}

export function dismissCallMessage() {
  useVoice.setState({ message: null, status: "idle" });
}

// ---------------------------------------------------------------------------
// Demo call: no microphone and no server, a short scripted conversation so the
// call screen can be seen (and checked) in demo mode.
// ---------------------------------------------------------------------------

let demo: { timers: ReturnType<typeof setTimeout>[]; ticker: ReturnType<typeof setInterval> } | null = null;

const DEMO_SCRIPT: { who: "user" | "assistant"; text: string; task?: string; notice?: boolean }[] = [
  { who: "assistant", text: "哎，我在。" },
  { who: "user", text: "帮我看看谁跑完了" },
  { who: "assistant", text: "迁移脚本跑完了，测试全过。登录页那个还在等你点确认。", task: "谁跑完了" },
  { who: "user", text: "登录页那个它在问什么" },
  { who: "assistant", text: "它想删掉旧的样式文件，问你同不同意。", task: "登录页在问什么" },
  // Nobody asked: an agent finished meanwhile and the assistant brings it up.
  { who: "assistant", text: "对了，刚才又有一个跑完了，测试全过，没有要你处理的。", notice: true },
];

function startDemoCall() {
  stopDemoCall(null);
  useVoice.setState({ status: "connecting", message: null, muted: false, startedAt: null, ...QUIET });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
  let mic = 0;
  let out = 0;
  // Loudness that rises and falls like syllables.
  const ticker = setInterval(() => {
    const wobble = 0.35 + 0.65 * Math.abs(Math.sin(Date.now() / 140) * Math.sin(Date.now() / 370));
    applyCallLevel(mic * wobble, out * wobble);
  }, 100);
  demo = { timers, ticker };
  let t = 900;
  at(t, () => useVoice.setState({ status: "ready", startedAt: Date.now() }));
  t += 500;
  DEMO_SCRIPT.forEach((line, i) => {
    const chars = [...line.text];
    const spoken = 400 + chars.length * 170;
    if (line.who === "user") {
      at(t, () => {
        mic = 0.7;
        applyCallEvent("input.speech.started", {});
      });
      chars.forEach((_, n) => at(t + (n * spoken) / chars.length, () => applyCallEvent("input.transcript.updated", { text: chars.slice(0, n + 1).join("") })));
      t += spoken;
      at(t, () => {
        mic = 0;
        applyCallEvent("input.speech.stopped", {});
        applyCallEvent("input.transcript.done", { text: line.text, turn: i });
      });
      t += 500;
    } else {
      if (line.task) {
        const task = { id: `demo-${i}`, title: line.task, status: "running" };
        at(t, () => applyCallEvent("relay.task", task));
        t += 2600;
        at(t, () => applyCallEvent("relay.task", { ...task, status: "done" }));
      }
      if (line.notice) {
        t += 2500;
        at(t, () => mockAssistant.notice("done"));
        t += 600;
      }
      at(t, () => {
        out = 0.8;
        applyCallEvent("response.audio.started", { run_id: `demo-${i}` });
      });
      chars.forEach((_, n) => at(t + (n * spoken) / chars.length, () => applyCallEvent("output.transcript.updated", { text: chars.slice(0, n + 1).join(""), run_id: `demo-${i}` })));
      t += spoken;
      at(t, () => {
        out = 0;
        applyCallEvent("output.transcript.done", { text: line.text, run_id: `demo-${i}` });
        applyCallEvent("response.ended", { run_id: `demo-${i}` });
      });
      t += 1400;
    }
  });
}

function stopDemoCall(message: string | null) {
  if (!demo) return;
  for (const t of demo.timers) clearTimeout(t);
  clearInterval(demo.ticker);
  demo = null;
  setWaiting(false);
  callLevel.value = 0;
  // Same as a real call: "ended" shows the reason once, then the screen goes back to idle.
  useVoice.setState({ status: message ? "ended" : "idle", message, muted: false, startedAt: null, ...QUIET });
}
