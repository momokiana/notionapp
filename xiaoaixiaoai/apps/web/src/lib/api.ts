import type {
  AssistantConfirm,
  AssistantItem,
  AssistantMemoryItem,
  AssistantPersonaConfig,
  AssistantReplyMode,
  AssistantState,
  Device,
  JoinClaim,
  JoinTicket,
  LedgerState,
  LedgerTxDirection,
  MemoryCategory,
  PairResponse,
  PersonaPresetSummary,
} from "@xiaoaixiaoai/protocol";

export interface StoredAuth {
  server: string;
  token: string;
  deviceId: string;
  deviceName: string;
}

const AUTH_KEY = "xiaoaixiaoai.web.auth.v1";

/** Infer relay base URL when served at `/app/` (supports reverse-proxy subpaths like `/xiaoaixiaoai/app/`). */
export function detectDefaultServer(): string {
  try {
    const u = new URL(window.location.href);
    const cleanedPath = u.pathname.replace(/\/app(?:\/.*)?$/, "");
    return `${u.origin}${cleanedPath}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function normalizeServer(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (parsed.server && parsed.token && parsed.deviceId) {
      return {
        server: normalizeServer(parsed.server),
        token: parsed.token,
        deviceId: parsed.deviceId,
        deviceName: parsed.deviceName || "桌面端",
      };
    }
  } catch {}
  return null;
}

export function saveAuth(auth: StoredAuth | null): void {
  try {
    if (!auth) localStorage.removeItem(AUTH_KEY);
    else localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  } catch {}
}

export async function apiFetch<T>(
  server: string,
  path: string,
  opts: { token?: string; method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const base = normalizeServer(server);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      signal: ac.signal,
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!res.ok) {
      throw new Error(data.error?.message ?? `请求失败 (${res.status})`);
    }
    return data;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("请求超时，请检查网络连接");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthInfo {
  ok: boolean;
  name: string;
  version: string;
  protocol: number;
  devices: number;
  online: number;
  assistant: string[];
  voice: string | null;
}

export const getHealth = (server: string) => apiFetch<HealthInfo>(server, "/v1/health");

export async function pairWithCode(server: string, code: string, name: string): Promise<PairResponse> {
  return apiFetch<PairResponse>(server, "/v1/pair", {
    body: { code: code.trim(), name: name.trim() || "桌面端", kind: "viewer", platform: "web-desktop" },
  });
}

export async function pairWithAdminToken(server: string, adminToken: string, name: string): Promise<PairResponse> {
  const minted = await apiFetch<{ code: string }>(server, "/v1/pair/codes", {
    token: adminToken.trim(),
    body: { kind: "viewer", ttlSec: 300 },
  });
  return pairWithCode(server, minted.code, name);
}

export async function requestJoin(server: string, name: string): Promise<JoinTicket> {
  return apiFetch<JoinTicket>(server, "/v1/join", {
    body: { name: name.trim() || "桌面端", kind: "viewer", platform: "web-desktop" },
  });
}

export async function claimJoin(server: string, id: string, secret: string): Promise<JoinClaim> {
  return apiFetch<JoinClaim>(server, `/v1/join/${encodeURIComponent(id)}/claim`, {
    body: { secret },
  });
}

export const createRelayApi = (auth: StoredAuth) => ({
  health: () => getHealth(auth.server),
  devices: () => apiFetch<{ devices: Device[] }>(auth.server, "/v1/devices", { token: auth.token }),
  mintPairCode: (kind: "host" | "viewer") =>
    apiFetch<{ code: string; expiresAt: number; link: string }>(auth.server, "/v1/pair/codes", {
      token: auth.token,
      body: { kind },
    }),

  // Assistant
  getAssistant: () => apiFetch<AssistantState>(auth.server, "/v1/assistant", { token: auth.token }),
  sendMessage: (text: string) =>
    apiFetch<{ item: AssistantItem }>(auth.server, "/v1/assistant/messages", { token: auth.token, body: { text } }),
  decideAction: (id: string, decision: "confirm" | "cancel") =>
    apiFetch<{ item: AssistantItem }>(auth.server, `/v1/assistant/actions/${encodeURIComponent(id)}`, {
      token: auth.token,
      body: { decision },
    }),
  clearThread: () =>
    apiFetch<{ ok: boolean }>(auth.server, "/v1/assistant/thread", { token: auth.token, method: "DELETE" }),
  cancelReminder: (id: string) =>
    apiFetch<{ ok: boolean }>(auth.server, `/v1/assistant/reminders/${encodeURIComponent(id)}`, {
      token: auth.token,
      method: "DELETE",
    }),
  updateSettings: (patch: { confirm?: AssistantConfirm; replyMode?: AssistantReplyMode }) =>
    apiFetch<{ confirm: AssistantConfirm; replyMode?: AssistantReplyMode }>(auth.server, "/v1/assistant/settings", {
      token: auth.token,
      body: patch,
    }),

  // Voice in chat
  warmupVoice: () =>
    apiFetch<{ ok: boolean }>(auth.server, "/v1/assistant/voice/warmup", { token: auth.token, body: {}, timeoutMs: 10_000 }).catch(() => ({ ok: false })),
  sendVoiceNote: (audioBase64: string, sampleRate: number) =>
    apiFetch<{ text: string; item?: AssistantItem }>(auth.server, "/v1/assistant/voice", {
      token: auth.token,
      body: { audioBase64, sampleRate },
      timeoutMs: 90_000,
    }),
  speakItem: (itemId: string, text?: string) =>
    apiFetch<{ ok: boolean; utteranceId: string }>(auth.server, "/v1/assistant/speak", {
      token: auth.token,
      body: { itemId, ...(text ? { text } : {}) },
    }),
  stopSpeak: () =>
    apiFetch<{ ok: boolean }>(auth.server, "/v1/assistant/speak/stop", { token: auth.token, body: {} }).catch(() => ({ ok: false })),

  // Profile & memories
  getProfile: () =>
    apiFetch<{ profile: AssistantPersonaConfig; presets: PersonaPresetSummary[] }>(auth.server, "/v1/assistant/profile", {
      token: auth.token,
    }),
  updateProfile: (patch: {
    name?: string;
    userCall?: string;
    personaText?: string;
    presetId?: string;
    autoMemory?: boolean;
    reset?: boolean;
  }) =>
    apiFetch<{ profile: AssistantPersonaConfig; presets: PersonaPresetSummary[] }>(auth.server, "/v1/assistant/profile", {
      token: auth.token,
      body: patch,
    }),
  getMemories: (q?: string) =>
    apiFetch<{ items: AssistantMemoryItem[]; total: number }>(
      auth.server,
      `/v1/assistant/memories${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      { token: auth.token },
    ),
  addMemory: (input: { category: MemoryCategory; content: string; pinned?: boolean }) =>
    apiFetch<{ item: AssistantMemoryItem }>(auth.server, "/v1/assistant/memories", {
      token: auth.token,
      body: input,
    }),
  deleteMemory: (id: string) =>
    apiFetch<{ ok: boolean }>(auth.server, `/v1/assistant/memories/${encodeURIComponent(id)}`, {
      token: auth.token,
      method: "DELETE",
    }),
  exportMemories: () =>
    apiFetch<{ markdown: string }>(auth.server, "/v1/assistant/memories/export", { token: auth.token }),

  // Ledger
  getLedger: () => apiFetch<LedgerState>(auth.server, "/v1/ledger", { token: auth.token }),
  updateLedgerConfig: (patch: { enabled?: boolean; balanceCents?: number | null; savingsGoalCents?: number }) =>
    apiFetch<LedgerState>(auth.server, "/v1/ledger/config", { token: auth.token, body: patch }),
  addLedgerFixed: (input: { name: string; amountCents: number; paidThisMonth?: boolean }) =>
    apiFetch<LedgerState>(auth.server, "/v1/ledger/fixed", { token: auth.token, body: input }),
  updateLedgerFixed: (id: string, patch: { name?: string; amountCents?: number; paid?: boolean }) =>
    apiFetch<LedgerState>(auth.server, `/v1/ledger/fixed/${encodeURIComponent(id)}`, {
      token: auth.token,
      method: "PATCH",
      body: patch,
    }),
  deleteLedgerFixed: (id: string) =>
    apiFetch<LedgerState>(auth.server, `/v1/ledger/fixed/${encodeURIComponent(id)}`, {
      token: auth.token,
      method: "DELETE",
    }),
  addLedgerTx: (input: { direction: LedgerTxDirection; amountCents: number; title: string; note?: string; fixedId?: string }) =>
    apiFetch<{ state: LedgerState }>(auth.server, "/v1/ledger/transactions", {
      token: auth.token,
      body: { ...input, source: "manual" },
    }),
  deleteLedgerTx: (id: string) =>
    apiFetch<LedgerState>(auth.server, `/v1/ledger/transactions/${encodeURIComponent(id)}`, {
      token: auth.token,
      method: "DELETE",
    }),
});
