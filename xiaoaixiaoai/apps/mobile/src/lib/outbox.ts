/**
 * Messages sent from this phone to an agent. Each shows in the agent's
 * conversation at once, as the person's own bubble, and is followed until the
 * conversation shows its own copy: sending, then sent (typed in), or queued
 * (the agent is in a turn and its program holds the text), or failed (with a
 * retry). Sends to one agent go out one after another in the order written, so
 * a message with pictures is never overtaken by a quicker one after it.
 */
import type { Agent } from "@xiaoaixiaoai/protocol";
import { sameMessage, sendWithPictures, type Attachment } from "./attach";
import { findAgent, usePending, type PendingSend, type SendState } from "./store";

/** A send-queue event from the computer (`queue` on the terminal stream). */
export interface QueueEvent {
  queueId: string;
  status: "queued" | "sending" | "sent" | "failed";
  position?: number;
  message?: string;
}

export type SendResult = { ok: true } | { ok: false; message: string };

/** The conversation's copy may carry the computer's clock: allow it to read a little earlier. */
const ECHO_SLACK_MS = 30_000;
/**
 * How long a message not seen in the conversation stays on screen. Sent (typed in) but never shown there,
 * as with another session or a program without one: a few minutes, counted from when the computer took it.
 */
const TTL: Record<SendState, number> = { sending: Infinity, sent: 3 * 60_000, queued: 2 * 3_600_000, failed: 30 * 60_000 };
/** How long a message keeps its bubble's identity (key, thumbnails) once the conversation shows it. */
const ECHO_KEEP_MS = 15 * 60_000;
/** The computer counts text held during a turn (`Agent.queued`) once its agent list goes out. */
const WAIT_GRACE_MS = 10_000;
/** Longest the "it is answering" dots show for an agent that has not started working. */
const AWAIT_MS = 60_000;

/** Pictures of messages not delivered yet, kept for a retry, by message id. */
const keep = new Map<string, Attachment[]>();
/** Per agent: the send in progress, so the next one waits its turn. */
const lines = new Map<string, Promise<unknown>>();
/** Queue events that arrived before the send's own answer, by queue id. */
const early = new Map<string, QueueEvent>();

const patch = (agentKey: string, id: string, p: Partial<Omit<PendingSend, "id">>) => usePending.getState().update(agentKey, id, p);
const find = (agentKey: string, id: string) => usePending.getState().byAgent[agentKey]?.find((x) => x.id === id);

/** Shows the message at once, then sends it after any earlier ones to the same agent. */
export function sendOut(agent: Agent, text: string, pictures: Attachment[] = []): Promise<SendResult> {
  const id = usePending.getState().add(agent.key, text, pictures.map((x) => `data:${x.mime};base64,${x.data}`));
  if (pictures.length) keep.set(id, pictures);
  return deliver(agent, id, text);
}

/** Sends a message that did not go through again, keeping its place. */
export function resend(agentKey: string, id: string): Promise<SendResult> {
  const x = find(agentKey, id);
  const agent = findAgent(agentKey);
  if (!x || x.state !== "failed") return Promise.resolve({ ok: false, message: "这条消息已经不在了" });
  if (!agent) {
    patch(agentKey, id, { error: "找不到这个 agent 了" });
    return Promise.resolve({ ok: false, message: "找不到这个 agent 了" });
  }
  patch(agentKey, id, { state: "sending", ts: Date.now(), error: undefined, queueId: undefined, waiting: undefined, sentAt: undefined });
  return deliver(agent, id, x.text);
}

/** Takes messages off the screen (and their kept pictures). */
export function forget(agentKey: string, ids: string[]) {
  for (const id of ids) keep.delete(id);
  usePending.getState().drop(agentKey, ids);
}

function deliver(agent: Agent, id: string, text: string): Promise<SendResult> {
  const run = (lines.get(agent.key) ?? Promise.resolve()).then(async (): Promise<SendResult> => {
    try {
      const { accepted } = await sendWithPictures(agent, text, keep.get(id) ?? []);
      keep.delete(id);
      const waiting = !!accepted.waiting;
      const behind = (accepted.position ?? 0) > 0;
      // Older computers send no queue events: accepted is as far as the phone can follow.
      patch(agent.key, id, { queueId: accepted.queueId, waiting, sentAt: Date.now(), state: waiting || behind ? "queued" : accepted.queueId ? "sending" : "sent" });
      const ev = accepted.queueId ? early.get(accepted.queueId) : undefined;
      if (ev) {
        early.delete(ev.queueId);
        onQueueEvent(agent.key, ev);
      }
      // Never leave "sending" up when the computer's "sent" was missed.
      setTimeout(() => {
        if (find(agent.key, id)?.state === "sending") patch(agent.key, id, { state: "sent" });
      }, 8000);
      return { ok: true };
    } catch (e) {
      const message = (e as Error).message || "没发出去";
      patch(agent.key, id, { state: "failed", error: message });
      return { ok: false, message };
    }
  });
  lines.set(agent.key, run);
  return run;
}

/** Follows the computer's send queue for messages from this phone. */
export function onQueueEvent(agentKey: string, ev: QueueEvent) {
  const x = usePending.getState().byAgent[agentKey]?.find((m) => m.queueId === ev.queueId);
  if (!x) {
    // It can beat the send's own answer; keep the latest a moment for that answer.
    early.set(ev.queueId, ev);
    setTimeout(() => {
      if (early.get(ev.queueId) === ev) early.delete(ev.queueId);
    }, 15_000);
    return;
  }
  if (ev.status === "queued" && (ev.position ?? 0) > 0) patch(agentKey, x.id, { state: "queued" });
  else if (ev.status === "sending" && !x.waiting && x.state !== "sent") patch(agentKey, x.id, { state: "sending" });
  else if (ev.status === "sent") patch(agentKey, x.id, { state: x.waiting ? "queued" : "sent", sentAt: Date.now() });
  else if (ev.status === "failed") patch(agentKey, x.id, { state: "failed", error: ev.message || "电脑那边没打进去" });
}

/** The conversation rows `followSends` reads: user messages, and anything that counts as a reply. */
export interface ConvRow {
  type: string;
  id: string;
  text?: string;
  ts?: number;
}

export interface Followed {
  /** Not in the conversation yet: the person's own bubbles after it, in the state to show. */
  shown: PendingSend[];
  /** The conversation's copies of this phone's messages, by row id: they keep the bubble's key and thumbnails. */
  echoes: Map<string, PendingSend>;
  /** Store changes: messages to take off the screen, and states that moved on. */
  drop: string[];
  patches: { id: string; patch: Partial<PendingSend> }[];
  /** The phone has the last word and the agent, not working yet, has not answered. */
  awaiting: boolean;
}

/**
 * Matches messages sent from this phone with the conversation: each user
 * message in it stands for at most one sent message (same words, not much
 * earlier than the send), so its bubble gives way without a duplicate.
 */
export function followSends(sends: PendingSend[], rows: readonly ConvRow[], agent: Pick<Agent, "status" | "queued">, now: number): Followed {
  const drop: string[] = [];
  const patches: Followed["patches"] = [];
  const echoes = new Map<string, PendingSend>();
  const echoAt = new Map<string, number>();
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const claimed = new Set<number>();
  for (const x of sends) {
    const i = x.echo ? index.get(x.echo) : undefined;
    // A row id met again with other words (a conversation read anew) is not this message's copy.
    if (i !== undefined && sameMessage(rows[i]!.text ?? "", x.text)) {
      claimed.add(i);
      echoes.set(x.echo!, x);
      echoAt.set(x.id, i);
    }
  }
  const users = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.type === "user");
  // Messages that went through claim first: a failed one only matches when it got in after all.
  const open = sends.filter((x) => !x.echo).sort((a, b) => Number(a.state === "failed") - Number(b.state === "failed") || a.ts - b.ts);
  for (const x of open) {
    const hit = users.find(({ r, i }) => !claimed.has(i) && (r.ts ?? 0) >= x.ts - ECHO_SLACK_MS && sameMessage(r.text ?? "", x.text));
    if (!hit) continue;
    claimed.add(hit.i);
    echoes.set(hit.r.id, x);
    echoAt.set(x.id, hit.i);
    patches.push({ id: x.id, patch: { echo: hit.r.id, state: "sent", error: undefined } });
  }

  const shown: PendingSend[] = [];
  for (const x of sends) {
    if (x.echo || echoAt.has(x.id)) {
      if (now - x.ts > ECHO_KEEP_MS) drop.push(x.id);
      continue;
    }
    // Held during a turn until the computer stops counting it: taken (or the turn was cut short).
    if (x.state === "queued" && x.waiting && !agent.queued && now - (x.sentAt ?? x.ts) > WAIT_GRACE_MS) {
      patches.push({ id: x.id, patch: { state: "sent", sentAt: now } });
      shown.push({ ...x, state: "sent", sentAt: now });
      continue;
    }
    const since = x.state === "sent" ? (x.sentAt ?? x.ts) : x.ts;
    if (now - since > TTL[x.state]) drop.push(x.id);
    else shown.push(x);
  }

  let awaiting = false;
  const last = sends.reduce<PendingSend | undefined>((a, x) => (!a || x.ts > a.ts ? x : a), undefined);
  if (last && !drop.includes(last.id) && agent.status !== "working" && agent.status !== "blocked" && now - last.ts < AWAIT_MS) {
    const at = echoAt.get(last.id);
    const state = at !== undefined ? "sent" : shown.find((x) => x.id === last.id)?.state;
    if (state === "sending" || state === "sent") {
      // A reply is anything the agent wrote or did after the message (or, not matched yet, after it was sent).
      awaiting = !rows.some((r, i) => r.type !== "user" && r.type !== "system" && (at !== undefined ? i > at : (r.ts ?? 0) >= last.ts));
    }
  }
  return { shown, echoes, drop, patches, awaiting };
}
