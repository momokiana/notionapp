import { PROTOCOL_VERSION, type ClientFrame, type RpcMethod, type RpcParams, type RpcResult, type ServerFrame } from "@xiaoaixiaoai/protocol";
import type { StoredAuth } from "./api";

export type WsStatus = "connecting" | "connected" | "disconnected" | "unauthorized";

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

export function toWsUrl(httpBase: string, pathWithQuery: string): string {
  const base = httpBase.replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${base}${pathWithQuery}`;
}

export class RelaySocket {
  private readonly auth: StoredAuth;
  private readonly onFrame: (frame: ServerFrame) => void;
  private readonly onStatus: (status: WsStatus) => void;
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;
  private retryTimer: number | null = null;
  private seq = 0;
  private readonly pending = new Map<string, PendingRpc>();

  constructor(auth: StoredAuth, onFrame: (frame: ServerFrame) => void, onStatus: (status: WsStatus) => void) {
    this.auth = auth;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const [, p] of this.pending) {
      window.clearTimeout(p.timer);
      p.reject(new Error("连接已断开"));
    }
    this.pending.clear();
    try {
      this.ws?.close(1000, "logout");
    } catch {}
    this.ws = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.onStatus("connecting");
    const url = toWsUrl(this.auth.server, `/v1/ws?token=${encodeURIComponent(this.auth.token)}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || this.closed) return;
      this.retryMs = 1000;
      this.onStatus("connected");
      const hello: ClientFrame = {
        type: "hello",
        version: PROTOCOL_VERSION,
        platform: "web-desktop",
        appVersion: "0.3.5",
      };
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.closed || typeof ev.data !== "string") return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "rpc_result") {
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          window.clearTimeout(p.timer);
          if (frame.error) p.reject(new Error(frame.error.message || frame.error.code));
          else p.resolve(frame.result);
        }
        return;
      }
      this.onFrame(frame);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.pending) {
        window.clearTimeout(p.timer);
        p.reject(new Error("连接中断"));
      }
      this.pending.clear();
      if (this.closed) return;
      if (ev.code === 4001) {
        this.onStatus("unauthorized");
        return;
      }
      this.onStatus("disconnected");
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 1.6, 15_000);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      // onclose handles reconnect
    };
  }

  rpc<M extends RpcMethod>(to: string, method: M, params: RpcParams<M>, timeoutMs = 20_000): Promise<RpcResult<M>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("尚未连接到中转站"));
    }
    const id = `web-${Date.now().toString(36)}-${++this.seq}`;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("操作超时，电脑端未在规定时间内响应"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const frame: ClientFrame = { type: "rpc", id, to, method, params };
      this.ws!.send(JSON.stringify(frame));
    });
  }
}
