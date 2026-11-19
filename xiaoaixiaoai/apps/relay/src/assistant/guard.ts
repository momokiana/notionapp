/**
 * Keeps what the assistant says about its own actions true. The model's
 * sentence is checked against what really happened in the same run: a message
 * is "sent" only when a send reached `done`, and another agent "replied" only
 * when its conversation was read after the send. A claim with nothing behind
 * it is replaced by the plain fact.
 */
import type { AssistantAction } from "@xiaoaixiaoai/protocol";

/** What one run of the model really did. */
export interface RunFacts {
  /** Actions it started (direct or proposed) and how each ended. */
  actions: Array<{ kind: AssistantAction["kind"]; state: AssistantAction["state"]; agent?: string; title?: string; result?: string; seq: number }>;
  /** Agents whose conversation or terminal it read, with when (same counter as actions). */
  reads: Array<{ agent: string; seq: number }>;
  seq: number;
}

export function newFacts(): RunFacts {
  return { actions: [], reads: [], seq: 0 };
}

/** "发过去了", "递到了", "已经告诉它了", "转达了": the message reached the other side. */
const DELIVERED =
  /(发|递|传|转|带|捎|送)(过去|到|好|出去|给[^，。！？\n]{0,12}了)|(已经?|都)(发|递|传|转告|转达|告诉|说给)|(发|递|传|转告|转达|告诉[^，。！？\n]{0,10})了|说过去了|带到了|话带到/;
/**
 * "那边回话说", "它回复说", "对方表示": another agent's answer. A bare "它说" is
 * left alone: it is how the assistant reports what it read before sending.
 */
const REPLIED = /回话|回复|回信|回了话|答复|回应|回过来|回答说|(那边|对方)(说|讲|表示|觉得|回)/;
/** "它还没回", "等它回了我叫你": about a reply that has not come, which is true. */
const NO_REPLY_YET = /没(有)?(回|答|动静)|还没|等它|等那边|回了(我)?再|回来(我)?再|一回(我)?就|有回音/;
const SEND_KINDS = new Set<AssistantAction["kind"]>(["send", "keys", "create", "resume"]);

function sentences(text: string): string[] {
  return text.match(/[^。！？!?\n]+[。！？!?]*\n?|\n/g) ?? [text];
}

/**
 * Replaces false claims about delivery and invented replies. `fixed` names what
 * was changed, for the log. The text is left alone when nothing was sent in this
 * run and nothing claims otherwise.
 */
export function guardClaims(text: string, facts: RunFacts): { text: string; fixed: string[] } {
  const sends = facts.actions.filter((a) => SEND_KINDS.has(a.kind));
  if (!sends.length) return { text, fixed: [] };
  const done = sends.filter((a) => a.state === "done");
  const pending = sends.filter((a) => a.state === "pending");
  const failed = sends.filter((a) => a.state === "failed");
  const lastSend = Math.max(...sends.map((a) => a.seq));
  const readAfter = facts.reads.some((r) => r.seq > lastSend);
  const fixed: string[] = [];
  const out: string[] = [];
  let replaced = false;
  for (const s of sentences(text)) {
    // Nothing was read after sending: any "it answered ..." is made up.
    const reply = !readAfter && REPLIED.test(s) && !NO_REPLY_YET.test(s);
    const delivery = !done.length && DELIVERED.test(s);
    if (reply) fixed.push("reply");
    if (delivery) {
      fixed.push("delivery");
      if (!replaced) {
        replaced = true;
        out.push(pending.length ? "还没发，等你点头：要发吗？" : failed.length ? `没发成：${clip(failed[0]!.result ?? "电脑那边没接住")}。` : "还没发出去。");
      }
    }
    if (!reply && !delivery) out.push(s);
  }
  if (!fixed.length) return { text, fixed };
  let next = out.join("").trim();
  if (!next) next = done.length ? "发过去了，它还没回。" : pending.length ? "还没发，等你点头：要发吗？" : "还没发出去。";
  return { text: next, fixed: [...new Set(fixed)] };
}

/** A line the voice model said on its own: does it claim a delivery or a reply? */
export function claimsDelivery(text: string): boolean {
  return DELIVERED.test(text) || (REPLIED.test(text) && !NO_REPLY_YET.test(text));
}

function clip(s: string): string {
  const c = Array.from(s.replace(/\s+/g, " ").trim());
  return c.length > 40 ? `${c.slice(0, 40).join("")}…` : c.join("").replace(/[。.]$/, "");
}
