import {
  isRuntimeId,
  isRuntimeRequestId,
  RUNTIME_TASK_EVENT_KINDS,
  RUNTIME_TASK_EVENTS_LIMIT,
  type Notice,
  type RuntimeTaskEvent,
  type RuntimeTaskNoticeTarget,
} from "@xiaoaixiaoai/protocol";

export const RUNTIME_TASK_FRAME_MAX_BYTES = 1024;
export const RUNTIME_TASK_TTL_MS = 3 * 86_400_000;
export const RUNTIME_TASK_REPLAY_MS = 86_400_000;
export const RUNTIME_TASK_REPLAY_LIMIT = 40;
export const RUNTIME_TASK_MAX_ACTIVE = 4096;
export const RUNTIME_TASK_MAX_CLAIMS_PER_HOST = 10_000;
export const RUNTIME_TASK_MAX_NONTERMINAL = 8;
const UPLOAD_WINDOW_MS = 60_000;
const MAX_UPLOADS_PER_WINDOW = 2 * RUNTIME_TASK_EVENTS_LIMIT;

export type RuntimeTaskDispatch = Omit<RuntimeTaskNoticeTarget, "hostId">;
export interface RuntimeTaskDelivery {
  viewerId: string;
  notice: Notice;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only the exact dispatch target; the opaque input is not part of a task notice. */
export function runtimeTaskDispatch(params: unknown): RuntimeTaskDispatch | undefined {
  const p = object(params);
  if ((p?.runtime !== "dsh" && p?.runtime !== "codex") || !isRuntimeId(p.projectId) || !isRuntimeId(p.sessionId) || !isRuntimeRequestId(p.requestId)) return;
  return { projectId: p.projectId, sessionId: p.sessionId, requestId: p.requestId.toLowerCase() };
}

export function confirmsRuntimeTask(result: unknown, requestId: string): boolean {
  const r = object(result);
  return r?.accepted === true && isRuntimeRequestId(r.requestId) && r.requestId.toLowerCase() === requestId;
}

/** Reject extra fields at either level, including any attempted recipient, text or routing data. */
export function parseRuntimeTaskFrame(value: unknown): RuntimeTaskEvent | undefined {
  const f = object(value);
  if (f?.type !== "runtime_task_event" || Object.keys(f).length !== 2) return;
  const e = object(f.event);
  if (!e || Object.keys(e).length !== 3 || !isRuntimeRequestId(e.eventId) || !isRuntimeRequestId(e.requestId)) return;
  const kind = RUNTIME_TASK_EVENT_KINDS.find((k) => k === e.kind);
  if (!kind) return;
  // Keep the wire spelling for the ack; the store uses the case-normalized event ID.
  return { eventId: e.eventId, requestId: e.requestId.toLowerCase(), kind };
}

const COPY: Record<RuntimeTaskEvent["kind"], Pick<Notice, "kind" | "title" | "body" | "verdict">> = {
  progress: { kind: "progress", title: "项目会话 · 已观察到执行步骤", body: "在这轮请求中观察到一个执行步骤。" },
  attention: { kind: "blocked", verdict: "decide", title: "项目会话 · 需要你确认", body: "这轮请求需要你查看并决定下一步。" },
  completed: { kind: "done", title: "项目会话 · 此轮已结束", body: "此轮已结束。请在会话详情查看结果。" },
  stopped: { kind: "done", verdict: "stopped", title: "项目会话 · 此轮已停止", body: "此轮已停止，未确认结果。" },
};

export function runtimeTaskNotice(id: string, kind: RuntimeTaskEvent["kind"], ts: number, runtimeTask: RuntimeTaskNoticeTarget): Notice {
  return { id, ...COPY[kind], ts, runtimeTask };
}

/** Limit upload work per registered host (not per WebSocket), including retries. */
export class RuntimeTaskUploadRate {
  private windows = new Map<string, { start: number; count: number }>();

  take(hostId: string, now: number): boolean {
    const w = this.windows.get(hostId);
    if (!w || now - w.start >= UPLOAD_WINDOW_MS) {
      this.windows.set(hostId, { start: now, count: 1 });
      return true;
    }
    if (w.count >= MAX_UPLOADS_PER_WINDOW) return false;
    w.count++;
    return true;
  }

  forget(hostId: string): void {
    this.windows.delete(hostId);
  }

  prune(now: number): void {
    for (const [hostId, w] of this.windows) if (now - w.start >= UPLOAD_WINDOW_MS) this.windows.delete(hostId);
  }
}
