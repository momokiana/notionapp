/**
 * The assistant thread as the phone sees it: loaded over REST, kept fresh by
 * `assistant_*` frames on the main socket (see relay.ts). In demo mode a small
 * local stand-in answers instead.
 */
import { create } from "zustand";
import {
  type AssistantConfirm,
  type AssistantItem,
  type AssistantMemoryItem,
  type AssistantPersonaConfig,
  type AssistantReplyMode,
  type AssistantState,
  type MemoryCategory,
  type PersonaPresetSummary,
  type Reminder,
  type ServerFrame,
} from "@xiaoaixiaoai/protocol";
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
  /** Whether the relay exposes normal-chat dual-track voice + push-to-talk (local provider). */
  chatVoice: boolean;
  model: string | null;
  reminders: Reminder[];
  /** "always": the assistant asks before acting in typed chats. Unknown (older relay): null. Calls never wait. */
  confirm: AssistantConfirm | null;
  /** "voice": normal chat uses voice + text dual-track; "text": silent text bubbles only. */
  replyMode: AssistantReplyMode;
  loaded: boolean;
  error: string | null;
  /** Things the assistant brought up on its own while its screen was not in view. */
  unread: number;
  profile: AssistantPersonaConfig | null;
  presets: PersonaPresetSummary[];
  memories: AssistantMemoryItem[];
  memoriesTotal: number;
}

export const useAssistant = create<AssistantStore>()(() => ({
  name: DEFAULT_ASSISTANT_NAME,
  items: [],
  busy: false,
  busyLabel: null,
  ready: false,
  voice: false,
  chatVoice: false,
  model: null,
  reminders: [],
  confirm: null,
  replyMode: "text",
  loaded: false,
  error: null,
  unread: 0,
  profile: null,
  presets: [],
  memories: [],
  memoriesTotal: 0,
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
    chatVoice: s.settings?.replyMode !== undefined,
    model: s.model ?? null,
    reminders: s.reminders,
    confirm: s.settings?.confirm ?? null,
    replyMode: s.settings?.replyMode ?? "text",
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
    case "assistant_profile":
      useAssistant.setState({
        profile: f.profile,
        name: f.profile.name?.trim() || DEFAULT_ASSISTANT_NAME,
      });
      return true;
    case "assistant_memories":
      void loadMemories();
      return true;
    default:
      return false;
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const server = useSettings.getState().server;
  if (!server) throw new Error("还没连上服务器");
  const token = await loadToken();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), init.timeoutMs ?? 15_000);
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

export async function setAssistantReplyMode(replyMode: AssistantReplyMode): Promise<void> {
  const before = useAssistant.getState().replyMode;
  useAssistant.setState({ replyMode });
  try {
    if (isMockServer(useSettings.getState().server)) {
      mockAssistant.setReplyMode(replyMode);
      return;
    }
    const r = await api<{ replyMode?: AssistantReplyMode }>("/v1/assistant/settings", { body: { replyMode } });
    useAssistant.setState({ replyMode: r.replyMode ?? replyMode });
  } catch (e) {
    useAssistant.setState({ replyMode: before });
    throw e;
  }
}

export async function warmupAssistantVoice(): Promise<void> {
  if (isMockServer(useSettings.getState().server)) return;
  await api("/v1/assistant/voice/warmup", { body: {}, timeoutMs: 10_000 }).catch(() => {});
}

export async function sendVoiceToAssistant(audioBase64: string, sampleRate: number): Promise<string> {
  if (isMockServer(useSettings.getState().server)) {
    mockAssistant.say("帮我看看现在哪个在等你", "voice");
    return "帮我看看现在哪个在等你";
  }
  const r = await api<{ text: string; item: AssistantItem | null }>("/v1/assistant/voice", {
    body: { audioBase64, sampleRate },
    timeoutMs: 90_000,
  });
  if (r.item) upsertItem(r.item);
  return r.text;
}

export async function requestAssistantSpeak(itemId: string, text?: string): Promise<string | null> {
  if (isMockServer(useSettings.getState().server)) return null;
  const r = await api<{ ok: boolean; utteranceId: string }>("/v1/assistant/speak", {
    body: { itemId, ...(text ? { text } : {}) },
    timeoutMs: 20_000,
  });
  return r.utteranceId ?? null;
}

export async function stopAssistantSpeakRemote(): Promise<void> {
  if (isMockServer(useSettings.getState().server)) return;
  await api("/v1/assistant/speak/stop", { body: {}, timeoutMs: 10_000 }).catch(() => {});
}

let lastMemFilter: { category?: MemoryCategory; q?: string } = {};

export async function loadAssistantProfile(): Promise<{ profile: AssistantPersonaConfig; presets: PersonaPresetSummary[] }> {
  if (isMockServer(useSettings.getState().server)) {
    const r = mockAssistant.profile();
    useAssistant.setState({ profile: r.profile, presets: r.presets, name: r.profile.name || DEFAULT_ASSISTANT_NAME });
    return r;
  }
  const r = await api<{ profile: AssistantPersonaConfig; presets: PersonaPresetSummary[] }>("/v1/assistant/profile");
  useAssistant.setState({ profile: r.profile, presets: r.presets, name: r.profile.name?.trim() || DEFAULT_ASSISTANT_NAME });
  return r;
}

export async function saveAssistantProfile(
  patch: Partial<Pick<AssistantPersonaConfig, "name" | "userCall" | "presetId" | "personaText" | "autoMemory">>,
): Promise<AssistantPersonaConfig> {
  if (isMockServer(useSettings.getState().server)) {
    const r = mockAssistant.setProfile(patch);
    useAssistant.setState({ profile: r.profile, presets: r.presets, name: r.profile.name || DEFAULT_ASSISTANT_NAME });
    return r.profile;
  }
  const r = await api<{ profile: AssistantPersonaConfig; presets: PersonaPresetSummary[] }>("/v1/assistant/profile", { body: patch });
  useAssistant.setState({ profile: r.profile, presets: r.presets, name: r.profile.name?.trim() || DEFAULT_ASSISTANT_NAME });
  return r.profile;
}

export async function loadMemories(opts?: { category?: MemoryCategory; q?: string }): Promise<{ memories: AssistantMemoryItem[]; total: number }> {
  const filter = opts ?? lastMemFilter;
  if (opts) lastMemFilter = opts;
  if (isMockServer(useSettings.getState().server)) {
    const r = mockAssistant.memories(filter);
    useAssistant.setState({ memories: r.memories, memoriesTotal: r.total });
    return r;
  }
  const qs = new URLSearchParams();
  if (filter.category) qs.set("category", filter.category);
  if (filter.q?.trim()) qs.set("q", filter.q.trim());
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const r = await api<{ memories: AssistantMemoryItem[]; total: number }>(`/v1/assistant/memories${suffix}`);
  useAssistant.setState({ memories: r.memories, memoriesTotal: r.total });
  return r;
}

export async function createMemory(input: {
  category: MemoryCategory;
  content: string;
  slotKey?: string;
  importance?: 1 | 2 | 3;
  pinned?: boolean;
  ttlDays?: number;
}): Promise<{ item: AssistantMemoryItem; replaced: boolean }> {
  const res = isMockServer(useSettings.getState().server)
    ? mockAssistant.remember(input)
    : await api<{ item: AssistantMemoryItem; replaced: boolean }>("/v1/assistant/memories", { body: input });
  await loadMemories();
  return res;
}

export async function updateMemory(
  id: string,
  patch: Partial<{ category: MemoryCategory; content: string; slotKey?: string; importance: 1 | 2 | 3; pinned: boolean }>,
): Promise<AssistantMemoryItem> {
  const item = isMockServer(useSettings.getState().server)
    ? mockAssistant.updateMemory(id, patch)
    : (await api<{ item: AssistantMemoryItem }>(`/v1/assistant/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: patch })).item;
  await loadMemories();
  return item;
}

export async function deleteMemory(id: string): Promise<void> {
  if (isMockServer(useSettings.getState().server)) mockAssistant.deleteMemory(id);
  else await api(`/v1/assistant/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadMemories();
}

export async function clearAllMemories(): Promise<number> {
  const removed = isMockServer(useSettings.getState().server)
    ? mockAssistant.clearMemories()
    : (await api<{ ok: boolean; removed: number }>("/v1/assistant/memories", { method: "DELETE" })).removed;
  await loadMemories();
  return removed;
}

export async function exportMemoriesMarkdown(): Promise<string> {
  if (isMockServer(useSettings.getState().server)) return mockAssistant.exportMemoriesMarkdown();
  const r = await api<{ markdown: string }>("/v1/assistant/memories/export");
  return r.markdown;
}
