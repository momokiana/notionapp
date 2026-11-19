import { randomUUID } from "node:crypto";

// Best-effort, process-local observation only. Keep the read limit in sync with
// the shared protocol; the plugin has no external dependencies.
const EVENT_LIMIT = 128;
const EVENT_TTL_MS = 15 * 60_000;
const REQUEST_LIMIT = 256;
const REQUEST_TTL_MS = 60 * 60_000;
const APPROVAL_DWELL_MS = 750;
const PENDING_APPROVAL_LIMIT = 8;
const ordinal = (n) => Number.isSafeInteger(n) && n >= 0;

export function createTaskEvents(ctx) {
  // Older synthetic contexts do not implement the Cordis event API.
  if (typeof ctx.on !== "function") return undefined;
  const requests = new Map(); // Canonical UUID -> request, including short-lived identity tombstones.
  const turns = new Map(); // Exact Session object -> the request claimed by its open turn.
  const events = [];
  let closed = false;

  function clearApprovals(task) {
    for (const timer of task.approvals.values()) clearTimeout(timer);
    task.approvals.clear();
  }

  function unbind(task) {
    if (turns.get(task.session) === task) turns.delete(task.session);
    clearApprovals(task);
    // Do not pin a Session or its history after we stop observing it.
    task.agent = undefined;
    task.session = undefined;
  }

  function discard(task) {
    unbind(task);
    task.staged = undefined;
  }

  function remove(task) {
    discard(task);
    requests.delete(task.requestId);
  }

  function prune() {
    const now = Date.now();
    for (const task of requests.values()) if (task.expiresAt <= now) remove(task);
    for (let i = events.length - 1; i >= 0; i--) if (events[i].expiresAt <= now) events.splice(i, 1);
  }

  function live(task) {
    if (closed || !task?.session) return false;
    if (task.expiresAt > Date.now()) return true;
    remove(task);
    return false;
  }

  function retain(requestId, kind) {
    events.push({ event: Object.freeze({ eventId: randomUUID(), requestId, kind }), expiresAt: Date.now() + EVENT_TTL_MS });
    if (events.length > EVENT_LIMIT) events.shift();
  }

  function record(task, kind) {
    // At most one progress, one attention, and one terminal observation.
    if (task.staged) task.staged.push(kind);
    else retain(task.requestId, kind);
  }

  function finish(task, kind) {
    record(task, kind);
    unbind(task);
  }

  function correlated(payload) {
    const source = payload?.message?.source;
    if (source?.kind !== "user" || typeof source.rpcId !== "string") return undefined;
    // Match the exact canonical string we sent, not an ID inferred from text or
    // session activity. The scope carrier (`this`) is not the Agent argument.
    const task = requests.get(source.rpcId);
    if (live(task) && task.agent === payload.agent && task.session === payload.agent?.session) return task;
  }

  function claim(payload) {
    const task = correlated(payload);
    if (!task || task.turn !== undefined || !ordinal(payload.turn)) return;
    const prior = turns.get(task.session);
    if (prior) {
      // Native queue mode assigns one ordinary prompt per turn. Do not guess
      // which request owns unnumbered approval events if that invariant breaks.
      unbind(prior);
      if (prior.turn === payload.turn) { unbind(task); return; }
    }
    task.turn = payload.turn;
    turns.set(task.session, task);
  }

  function queueDiscard(payload) {
    const task = correlated(payload);
    if (task) finish(task, "stopped");
  }

  function disposed(field, identity) {
    if (!identity) return;
    for (const task of requests.values()) {
      if (task[field] === identity && live(task)) finish(task, "stopped");
    }
  }

  function ask(task, id, source) {
    if (task.attention || typeof id !== "string" || !id.length || id.length > 128) return;
    const key = `${source}:${id}`;
    if (task.approvals.has(key) || task.approvals.size >= PENDING_APPROVAL_LIMIT) return;
    const timer = setTimeout(() => {
      if (task.approvals.get(key) !== timer || !live(task)) return;
      task.attention = true;
      clearApprovals(task);
      record(task, "attention");
    }, APPROVAL_DWELL_MS);
    timer.unref();
    task.approvals.set(key, timer);
  }

  function settle(task, id, source) {
    if (typeof id !== "string" || !id.length || id.length > 128) return;
    const key = `${source}:${id}`;
    const timer = task.approvals.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      task.approvals.delete(key);
    }
  }

  function sessionEvent(session, event) {
    const task = turns.get(session);
    if (!live(task)) return;
    const data = event?.data;
    switch (event?.type) {
      case "turn/start":
        // An open native turn normally emits its own end first. Prefer no
        // observation to treating later unnumbered audits as part of our turn.
        if (ordinal(data?.turn) && data.turn !== task.turn) unbind(task);
        break;
      case "step/end":
        if (data?.turn === task.turn && ordinal(data.step) && !task.progress) {
          task.progress = true;
          record(task, "progress");
        }
        break;
      case "approval/asked":
        // Observe the audit record, never insert an answerer in the waterfall.
        ask(task, data?.id, "approval");
        break;
      case "approval/decided":
        settle(task, data?.id, "approval");
        break;
      case "tool/call":
        // A blocking DSH question is a separate human-decision path. Read only
        // its tool name/opaque identity, not the question text or its answers.
        if (data?.turn === task.turn && data.name === "ask_user_question") ask(task, data.callId, "question");
        break;
      case "tool/result":
        if (data?.turn === task.turn) settle(task, data.message?.toolCallId, "question");
        break;
      case "turn/end":
        if (data?.turn === task.turn) finish(task, data.reason?.kind === "completed" ? "completed" : "stopped");
        break;
    }
  }

  function track(requestId, agent, session) {
    if (closed) return undefined;
    prune();
    const prior = requests.get(requestId);
    if (prior) {
      // Official hostd dispatches each UUID at most once. Do not change native
      // send policy for other local clients, but suppress ambiguous observations.
      discard(prior);
      return undefined;
    }
    if (requests.size >= REQUEST_LIMIT) remove(requests.values().next().value);
    const task = {
      requestId, agent, session, expiresAt: Date.now() + REQUEST_TTL_MS,
      staged: [], turn: undefined, progress: false, attention: false, approvals: new Map(),
    };
    requests.set(requestId, task);
    return {
      accept() {
        if (!task.staged || closed) return;
        if (task.expiresAt <= Date.now()) { remove(task); return; }
        const kinds = task.staged;
        task.staged = undefined;
        for (const kind of kinds) retain(requestId, kind);
      },
      discard: () => discard(task),
    };
  }

  const off = [];
  const sweep = setInterval(prune, 60_000);
  sweep.unref();
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(sweep);
    for (const task of requests.values()) discard(task);
    requests.clear();
    events.length = 0;
    for (const dispose of off) if (typeof dispose === "function") dispose();
  }

  try {
    off.push(ctx.on("agent/inbox/claimed", claim));
    off.push(ctx.on("agent/inbox/discarded", queueDiscard));
    off.push(ctx.on("agent/disposed", (payload) => disposed("agent", payload?.agent)));
    off.push(ctx.on("session/event", sessionEvent));
    off.push(ctx.on("session/disposed", (session) => disposed("session", session)));
  } catch (error) {
    close();
    throw error;
  }
  return { track, close, read: () => { prune(); return events.map(({ event }) => event); } };
}
