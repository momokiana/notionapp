import { DSH_DIRECTORY_PAGE_SIZE, DSH_DIRECTORY_SEARCH_LIMIT, RUNTIME_SESSION_TEXT_LIMIT, isRuntimeId, type DshDirectoryEntry, type RuntimeSessionState } from "@xiaoaixiaoai/protocol";

export interface DshFollow { hostId: string; sessionId: string; remind: boolean }
export interface DshFollowStore { server: string; viewer: string; items: DshFollow[] }
export type DshIntent = { action: "follow" | "unfollow"; search: string } | { action: "send"; search: string; draft: string };
export const FOLLOW_LIMIT = DSH_DIRECTORY_PAGE_SIZE;
const NONE: DshFollow[] = [];

/** Pairing scopes the phone's bookmarks; only opaque IDs, never title/history. */
export function followsFor(saved: DshFollowStore | null, server: string | null, viewer: string | undefined): DshFollow[] {
  return server && viewer && saved?.server === server && saved.viewer === viewer && Array.isArray(saved.items) &&
    saved.items.length <= FOLLOW_LIMIT && saved.items.every((x) => x && isRuntimeId(x.hostId) && isRuntimeId(x.sessionId) && typeof x.remind === "boolean") ? saved.items : NONE;
}

export function updateFollow(items: DshFollow[], hostId: string, sessionId: string, mode: "follow" | "unfollow" | "remind" | "mute"): DshFollow[] | null {
  if (!isRuntimeId(hostId) || !isRuntimeId(sessionId)) return null;
  const at = items.findIndex((s) => s.hostId === hostId && s.sessionId === sessionId);
  if (mode === "follow") return at >= 0 ? items : items.length < FOLLOW_LIMIT ? [...items, { hostId, sessionId, remind: false }] : null;
  if (at === -1) return items;
  if (mode === "unfollow") return items.filter((_, i) => i !== at);
  return items.map((s, i) => i === at ? { ...s, remind: mode === "remind" } : s);
}

/** Local, explicit text shortcut, not an instruction to the model or the runtime. */
export function dshIntent(text: string): DshIntent | "invalid" | undefined {
  const message = /^(?:(?:爱弥斯|小爱小爱|小爱)[，,：:\s]*)?(?:帮我\s*)?(?:发给|给)\s*DSH\s+/iu.exec(text.trim());
  if (message) {
    const rest = text.trim().slice(message[0].length);
    const split = rest.search(/[：:]/);
    const search = rest.slice(0, split).trim();
    const draft = rest.slice(split + 1).trim();
    return split > 0 && search && search.length <= DSH_DIRECTORY_SEARCH_LIMIT && !/[\p{Cc}\p{Cf}\uD800-\uDFFF]/u.test(search) &&
      draft && draft.length <= RUNTIME_SESSION_TEXT_LIMIT && !/[\0\uD800-\uDFFF]/u.test(draft) ? { action: "send", search, draft } : "invalid";
  }
  const m = /^(?:(?:爱弥斯|小爱小爱|小爱)[，,：:\s]*)?(?:帮我\s*)?(取消关注|关注)\s*DSH(?:(?:[\s：:]+|(?=\p{Script=Han}))([\s\S]*))?$/iu.exec(text.trim());
  if (!m) return undefined;
  const search = (m[2] ?? "").trim();
  return search.length <= DSH_DIRECTORY_SEARCH_LIMIT && !/[\p{Cc}\p{Cf}\uD800-\uDFFF]/u.test(search) ?
    { action: m[1] === "取消关注" ? "unfollow" : "follow", search } : "invalid";
}

/** Only a continuously observed running → idle is a notice. It isn't a task-success signal. */
export function observedIdle(previous: ReadonlyMap<string, RuntimeSessionState>, entries: DshDirectoryEntry[], subscribed: ReadonlySet<string>) {
  const observed = new Map<string, RuntimeSessionState>();
  let count = 0;
  for (const e of entries) {
    if (e.archived || !subscribed.has(e.session.id)) continue;
    const effState: RuntimeSessionState =
      e.session.state === "idle" && (e.session.subagentsWorking ?? 0) > 0 ? "running" : e.session.state;
    if (previous.get(e.session.id) === "running" && effState === "idle") count++;
    observed.set(e.session.id, effState);
  }
  return { observed, count };
}
