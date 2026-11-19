/**
 * The assistant thread as the phone sees it: loaded over REST, kept fresh by
 * `assistant_*` frames on the main socket (see relay.ts). In demo mode a small
 * local stand-in answers instead.
 */
import { create } from "zustand";
import type { AssistantConfirm, AssistantItem, AssistantState, Reminder, ServerFrame } from "@xiaoaixiaoai/protocol";
import { useSettings } from "./store";
import { loadToken } from "./auth";
import { isMockServer, mockAssistant } from "./mock";

export const DEFAULT_ASSISTANT_NAME = "爱弥斯";

interface AssistantStore {
  name: string;
  items: AssistantItem[];
  busy: boolean;
  busyLabel: string | null;
  ready: boolean;
  voice: boolean;
  model: string | null;
  reminders: Reminder[];
  /** "always": the assistant asks before acting in typed chats. Unknown (older relay): null. Calls never wait. */
  confirm: AssistantConfirm | null;
  loaded: boolean;
  error: string | null;
  /** Things the assistant brought up on its own while its screen was not in view. */
  unread: number;
}

export const useAssistant = create<AssistantStore>()(() => ({
  name: DEFAULT_ASSISTANT_NAME,
  items: [],
  busy: false,
  busyLabel: null,
  ready: false,
  voice: false,
  model: null,
  reminders: [],
  confirm: null,
  loaded: false,
  error: null,
  unread: 0,
}));

let watching = false;

/** The assistant screen is in view (or not): what arrives while it is counts as read. */
export function setAssistantWatching(on: boolean): void {
  watching = on;
  if (on && useAssistant.getState().unread) useAssistant.setState({ unread: 0 });
}

mockAssistant.bind({
  upsert: (item) => upsertItem(item),
  busy: (busy, label) => useAssistant.setState({ busy, busyLabel: label ?? null }),
  reset: (s) => applyAssistantState(s),
});

/** Time order, stable: an answer streamed around a tool's card ends up after the card. */
function byTime(items: AssistantItem[]): AssistantItem[] {
  return items.slice().sort((a, b) => a.ts - b.ts);
}

export function applyAssistantState(s: AssistantState): void {
  useAssistant.setState({
    // Older relays list a streamed answer where its first draft was, ahead of the card it reports on.
    items: byTime(s.items),
    name: s.settings?.name?.trim() || DEFAULT_ASSISTANT_NAME,
    busy: s.busy,
    ready: s.ready,
    voice: s.voice,
    model: s.model ?? null,
    reminders: s.reminders,
    confirm: s.settings?.confirm ?? null,
    loaded: true,
    error: null,
  });
}

export function upsertItem(item: AssistantItem): void {
  useAssistant.setState((s) => {
    const i = s.items.findIndex((x) => x.id === item.id);
    if (i >= 0) {
      const items = s.items.slice();
      const moved = items[i]!.ts !== item.ts;
      items[i] = item;
      // Each draft of a streamed answer is newer: it moves past the cards put up while it was being written.
      return { items: moved ? byTime(items) : items };
    }
    // Keep time order: voice lines and notices can arrive slightly out of order.
    const items = [...s.items, item].sort((a, b) => a.ts - b.ts);
    return { items: items.slice(-200), unread: item.role === "notice" && !watching ? s.unread + 1 : s.unread };
  });
}

/** Main-socket frames for the assistant; true when handled. */
export function onAssistantFrame(f: ServerFrame): boolean {
  switch (f.type) {
    case "assistant_item":
      upsertItem(f.item);
      return true;
    case "assistant_busy":
      useAssistant.setState({ busy: f.busy, busyLabel: f.label ?? null });
      return true;
    case "assistant_reset":
      void loadAssistant();
      return true;
    default:
      return false;
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const server = useSettings.getState().server;
  if (!server) throw new Error("还没连上服务器");
  const token = await loadToken();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      signal: abort.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error("连不上服务器，检查一下网络");
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw new Error(body.error?.message ?? (res.status === 404 ? "服务器还没有助理功能，需要先更新服务器" : `出错了（${res.status}）`));
  return body;
}

export async function loadAssistant(): Promise<void> {
  const server = useSettings.getState().server;
  if (!server) return;
  if (isMockServer(server)) {
    applyAssistantState(mockAssistant.state());
    return;
  }
  try {
    applyAssistantState(await api<AssistantState>("/v1/assistant"));
  } catch (e) {
    useAssistant.setState({ loaded: true, error: (e as Error).message });
  }
}

export async function sendToAssistant(text: string): Promise<void> {
  const server = useSettings.getState().server;
  if (isMockServer(server)) {
    mockAssistant.say(text);
    return;
  }
  const r = await api<{ item: AssistantItem }>("/v1/assistant/messages", { body: { text } });
  upsertItem(r.item);
}

export async function decideAction(id: string, decision: "confirm" | "cancel"): Promise<void> {
  if (isMockServer(useSettings.getState().server)) {
    mockAssistant.decide(id, decision);
    return;
  }
  const r = await api<{ item: AssistantItem }>(`/v1/assistant/actions/${encodeURIComponent(id)}`, { body: { decision } });
  upsertItem(r.item);
}

export async function clearAssistant(): Promise<void> {
  if (isMockServer(useSettings.getState().server)) {
    mockAssistant.clear();
    return;
  }
  await api("/v1/assistant/thread", { method: "DELETE" });
  useAssistant.setState({ items: [] });
}

export async function cancelReminder(id: string): Promise<void> {
  if (isMockServer(useSettings.getState().server)) {
    mockAssistant.cancelReminder(id);
    return;
  }
  await api(`/v1/assistant/reminders/${encodeURIComponent(id)}`, { method: "DELETE" });
  useAssistant.setState((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) }));
}

/** Whether the assistant asks before it acts ("always") or just does it ("never", the default). */
export async function setAssistantConfirm(confirm: AssistantConfirm): Promise<void> {
  const before = useAssistant.getState().confirm;
  useAssistant.setState({ confirm });
  try {
    if (isMockServer(useSettings.getState().server)) {
      mockAssistant.setConfirm(confirm);
      return;
    }
    const r = await api<{ confirm: AssistantConfirm }>("/v1/assistant/settings", { body: { confirm } });
    useAssistant.setState({ confirm: r.confirm });
  } catch (e) {
    useAssistant.setState({ confirm: before });
    throw e;
  }
}
