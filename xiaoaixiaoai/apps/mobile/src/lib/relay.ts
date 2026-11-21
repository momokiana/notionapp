import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";
import { XiaoaiNative } from "../../modules/xiaoaixiaoai-native";
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type Device,
  type DeviceKind,
  type JoinRequest,
  type PairCode,
  type PairResponse,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerFrame,
} from "@xiaoaixiaoai/protocol";
import { useLive } from "./store";
import { isMockServer, mockLink, mockApi } from "./mock";
import { loadAssistant, onAssistantFrame } from "./assistant";
import { onAssistantSpeechFrame } from "./chat-voice";
import { onLedgerFrame } from "./ledger";
import { applog } from "./applog";

export class RelayError extends Error {
  code: RpcError["code"];
  constructor(code: RpcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Minimal surface both the real socket and the mock implement. */
export type StreamEvent = (event: any) => void;
export interface Link {
  call(to: string, method: RpcMethod, params: unknown, timeoutMs: number): Promise<unknown>;
  subscribe(to: string, stream: "terminal" | "session", params: unknown, onEvent: StreamEvent, onState?: StreamEvent): () => void;
  ping(): void;
  reconnect?: () => void;
  close(): void;
}

export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (isMockServer(s)) return s;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

async function rest<T>(server: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let res: Response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12_000);
  try {
    res = await fetch(`${server}${path}`, { ...init, signal: abort.signal, headers: { ...headers, ...(init.headers as object) } });
  } catch {
    throw new RelayError("offline", `连不上 ${server.replace(/^https?:\/\//i, "")}，检查一下服务器地址和网络`);
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: RpcError } & T;
  if (!res.ok) {
    const e = body.error;
    throw new RelayError(e?.code ?? (res.status === 401 ? "unauthorized" : "internal"), e?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

/** `previousToken`: this phone's current token on the same relay, so the relay replaces that registration. */
export async function pairDevice(server: string, code: string, name: string, platform: string, previousToken?: string): Promise<PairResponse> {
  if (isMockServer(server)) return mockApi.pair(code, name, platform);
  try {
    const r = await rest<PairResponse>(server, "/v1/pair", {
      method: "POST",
      token: previousToken,
      body: JSON.stringify({ code: code.trim().toUpperCase(), name, kind: "viewer", platform }),
    });
    applog("info", "pair", `paired as "${r.device.name}"${previousToken ? " (replacing this phone's old registration)" : ""}`);
    return r;
  } catch (e) {
    applog("warn", "pair", `pairing failed: ${(e as Error).message}`);
    throw e;
  }
}

/** An invite: without `kind` it lets in a phone or a computer alike. */
export async function createPairCode(server: string, token: string, kind?: DeviceKind): Promise<PairCode> {
  if (isMockServer(server)) return mockApi.createPairCode(kind);
  return rest<PairCode>(server, "/v1/pair/codes", { method: "POST", token, body: JSON.stringify(kind ? { kind } : {}) });
}

/** A device that showed a "join" QR and waits for this phone to let it in. */
export async function getJoinRequest(server: string, token: string, id: string): Promise<JoinRequest> {
  if (isMockServer(server)) return mockApi.joinRequest(id);
  return rest<JoinRequest>(server, `/v1/join/${encodeURIComponent(id)}`, { token });
}

export async function answerJoinRequest(server: string, token: string, id: string, allow: boolean): Promise<Device | null> {
  if (isMockServer(server)) return mockApi.answerJoin(id, allow);
  const r = await rest<{ device?: Device }>(server, `/v1/join/${encodeURIComponent(id)}/${allow ? "approve" : "deny"}`, { method: "POST", token });
  applog("info", "pair", `${allow ? "approved" : "denied"} a join request${r.device ? ` for "${r.device.name}"` : ""}`);
  return r.device ?? null;
}

/** False only when the relay positively says this token is no longer valid. */
export async function tokenStillValid(server: string, token: string): Promise<boolean> {
  try {
    await rest(server, "/v1/devices", { token });
    return true;
  } catch (e) {
    return !(e instanceof RelayError && e.code === "unauthorized");
  }
}

export async function revokeDevice(server: string, token: string, id: string): Promise<void> {
  if (isMockServer(server)) return mockApi.revoke(id);
  await rest(server, `/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE", token });
}

// ---------------------------------------------------------------------------
// Live socket
// ---------------------------------------------------------------------------

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method?: string; to?: string };
type Stream = { id: string; to: string; stream: "terminal" | "session"; params: unknown; onEvent: StreamEvent; onState?: StreamEvent };

/** React Native's WebSocket also takes request headers (the DOM typing doesn't know). */
type RNWebSocket = new (url: string, protocols: string | string[] | null, options: { headers: Record<string, string> }) => WebSocket;

const CONNECT_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const STALE_FOREGROUND_MS = 20_000;

class SocketLink implements Link {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private streams = new Map<string, Stream>();
  private seq = 0;
  private backoff = 1000;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private appSub: NativeEventSubscription | null = null;
  private notifierSub: { remove(): void } | null = null;
  private closed = false;
  /** Set once the relay greets this socket; a close before that may mean a rejected token. */
  private welcomed = false;
  private openStartedAt = 0;
  private lastInboundAt = 0;

  constructor(private server: string, private token: string) {
    this.open();
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.appSub = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s !== "active" || this.closed) return;
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (!ws || ws.readyState > WebSocket.OPEN || Date.now() - this.openStartedAt > 3_000) this.reconnectNow();
        return;
      }
      if (Date.now() - this.lastInboundAt > STALE_FOREGROUND_MS) this.reconnectNow();
      else this.ping();
    });
    this.notifierSub = XiaoaiNative?.addListener("onNotifier", (e) => {
      if (!e.connected || this.closed) return;
      const link = useLive.getState().link;
      if (link === "offline" || (link === "connecting" && Date.now() - this.openStartedAt > 2_500)) {
        this.reconnectNow();
      }
    }) ?? null;
  }

  private url() {
    return `${this.server.replace(/^http/i, "ws")}/v1/ws`;
  }

  private clearWatchdogs() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private open() {
    if (this.closed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearWatchdogs();
    this.openStartedAt = Date.now();
    useLive.setState({ link: "connecting", nextRetryAt: null, reconnectAttempt: this.attempts, runtimeTaskNotices: false });
    this.welcomed = false;
    // The token rides in a header (React Native's third argument): a URL ends up in reverse-proxy access logs.
    const ws = new (WebSocket as unknown as RNWebSocket)(this.url(), null, { headers: { Authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.closed || this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      applog("warn", "link", "socket connect timed out, scheduling retry");
      this.handleDrop(ws, false, "connect timeout");
      try { ws.close(); } catch {}
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws || this.closed) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.lastInboundAt = Date.now();
      applog("info", "link", "socket open");
      this.send({ type: "hello", version: PROTOCOL_VERSION, platform: "mobile" });
      // Under new ids: an older relay or computer may still hold the old ones and refuse them as duplicates.
      const open = [...this.streams.values()];
      this.streams.clear();
      for (const s of open) {
        s.id = this.streamId();
        this.streams.set(s.id, s);
        this.send({ type: "stream_subscribe", id: s.id, to: s.to, stream: s.stream, params: s.params });
      }
      this.ping();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.closed) return;
      this.lastInboundAt = Date.now();
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      this.onFrame(frame);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev) => {
      const revokedCode = ev.code === REVOKED_CLOSE_CODE || ev.code === 4401;
      const reason = `${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`;
      this.handleDrop(ws, revokedCode, reason);
    };
  }

  private handleDrop(ws: WebSocket, revokedCode: boolean, reason: string) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.clearWatchdogs();
    this.failPending("offline", "连接断开了");
    if (this.closed) return;
    if (revokedCode) {
      applog("warn", "link", `socket closed ${reason}, revoked`);
      this.revoked();
      return;
    }
    const delay = this.backoff;
    this.attempts += 1;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    applog(this.welcomed ? "warn" : "info", "link", `socket closed (${reason})${this.welcomed ? "" : " before welcome"}, retry #${this.attempts} in ${Math.round(delay / 1000)}s`);
    useLive.setState({ link: "offline", nextRetryAt: Date.now() + delay, reconnectAttempt: this.attempts });
    this.retryTimer = setTimeout(() => this.open(), delay);
    // A token revoked while this phone was away is refused at the HTTP upgrade (401),
    // which a WebSocket only reports as a plain close. Ask the relay so we stop retrying forever.
    if (!this.welcomed) {
      tokenStillValid(this.server, this.token).then((ok) => {
        if (!ok && !this.closed && this.ws === null) this.revoked();
      });
    }
  }

  private revoked() {
    applog("error", "link", "this phone's token was revoked or refused");
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearWatchdogs();
    useLive.setState({ link: "unauthorized", nextRetryAt: null, reconnectAttempt: 0, lastError: "这台手机的授权已失效，请重新配对" });
  }

  reconnectNow() {
    if (this.closed) return;
    if (useLive.getState().link === "unauthorized") return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearWatchdogs();
    this.backoff = 1000;
    this.attempts = 0;
    const prev = this.ws;
    this.ws = null;
    try { prev?.close(); } catch {}
    this.failPending("offline", "正在重连服务器");
    this.open();
  }

  private onFrame(f: ServerFrame) {
    switch (f.type) {
      case "welcome":
        this.welcomed = true;
        this.backoff = 1000;
        this.attempts = 0;
        useLive.setState({ self: f.device, link: "online", nextRetryAt: null, reconnectAttempt: 0, lastError: null, runtimeTaskNotices: f.runtimeTaskNotices === true });
        // Catch up on anything the assistant said while this socket was down.
        void loadAssistant();
        break;
      case "snapshot": {
        const devices = Object.fromEntries(f.devices.map((d) => [d.id, d]));
        const agents: Record<string, typeof f.agents> = {};
        for (const a of f.agents) (agents[a.deviceId] ??= []).push(a);
        useLive.setState({ devices, agents, link: "online" });
        break;
      }
      case "device":
        useLive.setState((s) => ({ devices: { ...s.devices, [f.device.id]: f.device } }));
        break;
      case "device_removed":
        useLive.setState((s) => {
          const devices = { ...s.devices };
          const agents = { ...s.agents };
          delete devices[f.id];
          delete agents[f.id];
          return { devices, agents };
        });
        break;
      case "agents":
        useLive.setState((s) => ({ agents: { ...s.agents, [f.deviceId]: f.agents } }));
        break;
      case "stream_open": {
        const s = this.streams.get(f.id);
        if (f.error) applog("warn", "stream", `${s?.stream ?? "?"} stream failed: ${f.error.code}: ${f.error.message}`, { to: s?.to });
        if (f.error) s?.onState?.({ status: "error", message: f.error.message });
        else s?.onState?.({ status: "open", result: f.result });
        break;
      }
      case "stream_event": {
        this.streams.get(f.id)?.onEvent(f.event);
        break;
      }
      case "rpc_result": {
        const p = this.pending.get(f.id);
        if (!p) return;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.error && f.error.code !== "not_found") applog("warn", "rpc", `${p.method ?? "call"} failed: ${f.error.code}: ${f.error.message}`, { to: p.to });
        if (f.error) p.reject(new RelayError(f.error.code, f.error.message));
        else p.resolve(f.result);
        break;
      }
      case "pong":
        useLive.setState({ rttMs: Math.max(0, Date.now() - f.t) });
        break;
      case "error":
        applog("warn", "link", `relay error: ${f.error.message}`);
        useLive.setState({ lastError: f.error.message });
        break;
      default:
        // Viewers never execute rpc; unknown frames are ignored (forward compatible).
        if (!onAssistantFrame(f) && !onLedgerFrame(f)) onAssistantSpeechFrame(f);
        break;
    }
  }

  private send(frame: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private failPending(code: RpcError["code"], message: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RelayError(code, message));
    }
    this.pending.clear();
  }

  ping() {
    const ws = this.ws;
    if (!ws) {
      if (!this.closed) this.reconnectNow();
      return;
    }
    if (!this.send({ type: "ping", t: Date.now() })) return;
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.closed || this.ws !== ws) return;
        applog("warn", "link", "ping timed out, reconnecting");
        this.handleDrop(ws, false, "ping timeout");
        try { ws.close(); } catch {}
      }, PONG_TIMEOUT_MS);
    }
  }

  private streamId() {
    return `s${Date.now().toString(36)}${(this.seq++).toString(36)}`;
  }

  subscribe(to: string, stream: "terminal" | "session", params: unknown, onEvent: StreamEvent, onState?: StreamEvent): () => void {
    const entry: Stream = { id: this.streamId(), to, stream, params, onEvent, onState };
    this.streams.set(entry.id, entry);
    if (!this.send({ type: "stream_subscribe", id: entry.id, to, stream, params })) onState?.({ status: "error", message: "还没连上服务器" });
    return () => {
      if (this.streams.get(entry.id) === entry) this.streams.delete(entry.id);
      this.send({ type: "stream_unsubscribe", id: entry.id, to });
    };
  }

  call(to: string, method: RpcMethod, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = `m${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        applog("warn", "rpc", `${method} timed out after ${timeoutMs}ms`, { to });
        reject(new RelayError("timeout", "电脑那边没有及时回应"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, to });
      if (!this.send({ type: "rpc", id, to, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RelayError("offline", "还没连上服务器"));
      }
    });
  }

  reconnect() {
    this.reconnectNow();
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.clearWatchdogs();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.appSub?.remove();
    this.notifierSub?.remove();
    this.failPending("offline", "连接已关闭");
    this.streams.clear();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
  }
}

/** Close code the relay uses when a device token is revoked. */
export const REVOKED_CLOSE_CODE = 4001;

let current: Link | null = null;

export function startLink(server: string, token: string) {
  stopLink();
  current = isMockServer(server) ? mockLink() : new SocketLink(server, token);
  if (isMockServer(server)) void loadAssistant();
}

export function stopLink() {
  current?.close();
  current = null;
  useLive.getState().reset();
}

export function subscribe(to: string, stream: "terminal" | "session", params: unknown, onEvent: StreamEvent, onState?: StreamEvent): () => void {
  if (!current) {
    onState?.({ status: "error", message: "还没连上服务器" });
    return () => undefined;
  }
  return current.subscribe(to, stream, params, onEvent, onState);
}

export function pingNow() {
  const link = useLive.getState().link;
  if (link === "offline") {
    current?.reconnect?.();
    return;
  }
  current?.ping();
}

export function reconnectNow() {
  current?.reconnect?.();
}

export function call<M extends RpcMethod>(to: string, method: M, params: RpcParams<M>, timeoutMs = 15_000): Promise<RpcResult<M>> {
  if (!current) return Promise.reject(new RelayError("offline", "还没连上服务器"));
  return current.call(to, method, params, timeoutMs) as Promise<RpcResult<M>>;
}
