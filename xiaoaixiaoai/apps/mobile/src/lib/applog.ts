/**
 * The phone's own log: a small ring of lines about the link to the relay,
 * calls and streams that failed, JavaScript errors, voice calls, updates and
 * pairing. It is uploaded to the relay (POST /v1/logs) every minute and when
 * the app goes to the background, so whoever runs the relay can see what went
 * wrong on the phone. Never tokens; message text is clipped to 200 characters.
 */
import { AppState } from "react-native";
import type { ClientLogEntry, LogLevel } from "@xiaoaixiaoai/protocol";
import { useSettings } from "./store";
import { loadToken } from "./auth";
import { isMockServer } from "./mock";

const MAX = 300;
const BATCH = 150;
const EVERY_MS = 60_000;

const ring: ClientLogEntry[] = [];
let started = false;
let uploading = false;
/** An older relay without /v1/logs: stop trying until the app restarts. */
let unsupported = false;

function clip(s: string, n: number): string {
  const c = Array.from(s);
  return c.length > n ? `${c.slice(0, n).join("")}…` : s;
}

function redact(s: string): string {
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\bhp_[A-Za-z0-9_-]{8,}/g, "hp_***")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s"']+/gi, "$1***");
}

/** One line for the relay's log. `kind`: link, rpc, stream, js, voice, update, pair, assistant… */
export function applog(level: LogLevel, kind: string, msg: string, data?: Record<string, unknown>): void {
  let packed: Record<string, unknown> | undefined;
  if (data) {
    packed = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      packed[k] = typeof v === "string" ? clip(redact(v), 300) : v;
    }
  }
  ring.push({ ts: Date.now(), level, kind, msg: clip(redact(msg.replace(/\s+/g, " ").trim()), 500), data: packed });
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
}

/** Sends what the ring holds now; lines that could not go out wait for the next try. */
export async function uploadAppLog(): Promise<void> {
  if (uploading || unsupported || !ring.length) return;
  const server = useSettings.getState().server;
  if (!server || isMockServer(server)) {
    // The demo has no relay to keep it: the newest lines are enough.
    if (ring.length > MAX / 2) ring.splice(0, ring.length - MAX / 2);
    return;
  }
  uploading = true;
  const batch = ring.splice(0, BATCH);
  try {
    const token = await loadToken();
    if (!token) {
      ring.unshift(...batch);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const res = await fetch(`${server}/v1/logs`, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ entries: batch }),
      });
      if (res.status === 404) unsupported = true;
      // 5xx and network trouble: try again later. 4xx: the relay will not take these lines.
      else if (res.status >= 500) ring.unshift(...batch);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    ring.unshift(...batch);
    if (ring.length > MAX) ring.splice(MAX);
  } finally {
    uploading = false;
  }
}

/** Starts the minute timer, the upload on leaving the app, and the JS error hook. Safe to call twice. */
export function startAppLog(): void {
  if (started) return;
  started = true;
  setInterval(() => void uploadAppLog(), EVERY_MS);
  AppState.addEventListener("change", (s) => {
    applog("info", "app", `app ${s}`);
    if (s === "background") void uploadAppLog();
  });
  const g = globalThis as unknown as {
    ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void };
  };
  const previous = g.ErrorUtils?.getGlobalHandler();
  g.ErrorUtils?.setGlobalHandler((e, fatal) => {
    const err = e as { message?: string; stack?: string } | undefined;
    applog(fatal ? "error" : "warn", "js", `${fatal ? "fatal: " : ""}${err?.message ?? String(e)}`, { stack: err?.stack ? clip(err.stack, 600) : undefined });
    void uploadAppLog();
    previous?.(e, fatal);
  });
  applog("info", "app", "app started");
}
