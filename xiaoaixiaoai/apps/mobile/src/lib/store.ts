import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Agent, Device } from "@xiaoaixiaoai/protocol";
import type { TermKeyLayout } from "./termkeys";
import type { DshFollowStore } from "./dsh-follows";

export type ThemeMode = "system" | "light" | "dark";

/** A newer app release found on GitHub (see lib/update.ts). */
export interface ReleaseInfo {
  version: string;
  /** APK download URL; empty when the release has no Android asset yet. */
  url: string;
  fileName: string;
  size: number;
  /** The APK's SHA-256 from the release, when known; the download is checked against it. */
  sha256?: string;
  /** Release page, for reading or downloading by hand. */
  page: string;
  notes: string;
}

interface SettingsState {
  /** Relay base URL, e.g. https://xiaoaixiaoai.example.com, or mock://demo. Null until set up. */
  server: string | null;
  /** Last real relay this phone paired with; kept across sign-out so re-pairing only needs a code. */
  lastServer: string | null;
  deviceId: string | null;
  deviceName: string | null;
  themeMode: ThemeMode;
  textScale: number;
  showShells: boolean;
  /** Agent list device switcher: a host deviceId, or null for all hosts. */
  hostFilter: string | null;
  /** Only bookmarked opaque IDs and notice prefs for the current pairing. */
  dshFollows: DshFollowStore | null;
  /** Agent list groups the person folded (blocked / working / done / idle / offline). */
  foldedGroups: string[];
  /** Pinned agent keys kept at the top of the Agents tab. */
  pinnedAgents: string[];
  /** Accessory key bar order/visibility (normalise with normalizeTermKeyLayout). */
  termKeys: TermKeyLayout | null;
  /** Terminal keyboard button opens the phone's own key panel ("pad") or the system input method. */
  termInput: "pad" | "system";
  /** Key row height of that panel in dp (clampPadRow). */
  termPadRow: number;
  /** Background alerts (a resident service keeps the push channel open). */
  alertsOn: boolean;
  alertBlocked: boolean;
  alertDone: boolean;
  alertProgress: boolean;
  /** Whether the notification permission was asked once already. */
  alertsAsked: boolean;
  /** In-app update: last check, what it found, and the version the one-time prompt was shown for. */
  updateCheckedAt: number;
  updateRelease: ReleaseInfo | null;
  updatePrompted: string | null;
  hydrated: boolean;
  set: (patch: Partial<Omit<SettingsState, "set" | "hydrated">>) => void;
  signOut: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      server: null,
      lastServer: null,
      deviceId: null,
      deviceName: null,
      themeMode: "system",
      textScale: 1,
      showShells: false,
      hostFilter: null,
      dshFollows: null,
      foldedGroups: [],
      pinnedAgents: [],
      termKeys: null,
      termInput: "pad",
      termPadRow: 34,
      alertsOn: true,
      alertBlocked: true,
      alertDone: true,
      alertProgress: false,
      alertsAsked: false,
      updateCheckedAt: 0,
      updateRelease: null,
      updatePrompted: null,
      hydrated: false,
      set: (patch) => set((s) => ({ ...patch, ...((patch.server !== undefined && patch.server !== s.server) ||
        (patch.deviceId !== undefined && patch.deviceId !== s.deviceId) ? { dshFollows: null } : {}) })),
      signOut: () =>
        set((s) => ({
          server: null,
          deviceId: null,
          deviceName: null,
          hostFilter: null,
          dshFollows: null,
          lastServer: s.server && !s.server.startsWith("mock://") ? s.server : s.lastServer,
        })),
    }),
    {
      name: "xiaoaixiaoai.settings",
      version: 2,
      migrate: (persisted: unknown, version) => {
        if (!persisted || typeof persisted !== "object") return persisted as SettingsState;
        const next = { ...(persisted as Record<string, unknown>) };
        // Prior versions defaulted alertProgress=true, flooding phones with step-by-step progress notices.
        if (version < 2) next.alertProgress = false;
        return next as unknown as SettingsState;
      },
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ hydrated: _h, set: _s, signOut: _o, ...rest }) => rest,
      onRehydrateStorage: () => () => {
        useSettings.setState({ hydrated: true });
      },
    },
  ),
);

export type LinkStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";

interface LiveState {
  link: LinkStatus;
  rttMs: number | null;
  self: Device | null;
  runtimeTaskNotices: boolean;
  devices: Record<string, Device>;
  /** Agents keyed by host deviceId. */
  agents: Record<string, Agent[]>;
  lastError: string | null;
  reconnectAttempt: number;
  nextRetryAt: number | null;
  reset: () => void;
}

export const useLive = create<LiveState>()((set) => ({
  link: "idle",
  rttMs: null,
  self: null,
  runtimeTaskNotices: false,
  devices: {},
  agents: {},
  lastError: null,
  reconnectAttempt: 0,
  nextRetryAt: null,
  reset: () =>
    set({
      link: "idle",
      rttMs: null,
      self: null,
      runtimeTaskNotices: false,
      devices: {},
      agents: {},
      lastError: null,
      reconnectAttempt: 0,
      nextRetryAt: null,
    }),
}));

export function allAgents(agents: Record<string, Agent[]>): Agent[] {
  return Object.values(agents).flat();
}

export function findAgent(key: string): Agent | undefined {
  const { agents } = useLive.getState();
  for (const list of Object.values(agents)) {
    const a = list.find((x) => x.key === key);
    if (a) return a;
  }
  return undefined;
}

/**
 * Where a message sent from this phone is: on its way, typed into the agent,
 * waiting behind the agent's turn, or not delivered (see lib/outbox.ts).
 */
export type SendState = "sending" | "sent" | "queued" | "failed";

/** A message sent from this phone, shown at once and followed until the agent's conversation shows it. */
export interface PendingSend {
  id: string;
  /** What the person wrote (without the picture paths the agent got). */
  text: string;
  ts: number;
  /** Image URIs of the pictures sent with it, for thumbnails. */
  pictures?: string[];
  state: SendState;
  /** The computer's send-queue id, matched against its `queue` stream events. */
  queueId?: string;
  /** It arrived during a turn: the agent's program holds it until the turn ends. */
  waiting?: boolean;
  /** When the computer took it. */
  sentAt?: number;
  /** Why it was not delivered. */
  error?: string;
  /** Id of the conversation's own copy, once it showed up: the bubble is that message from then on. */
  echo?: string;
}

interface PendingState {
  byAgent: Record<string, PendingSend[]>;
  /** Adds a message in the `sending` state; returns its id. */
  add: (agentKey: string, text: string, pictures?: string[]) => string;
  update: (agentKey: string, id: string, patch: Partial<Omit<PendingSend, "id">>) => void;
  drop: (agentKey: string, ids: string[]) => void;
}

export const usePending = create<PendingState>()((set) => ({
  byAgent: {},
  add: (agentKey, text, pictures) => {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      byAgent: {
        ...s.byAgent,
        [agentKey]: [...(s.byAgent[agentKey] ?? []), { id, text, ts: Date.now(), pictures: pictures?.length ? pictures : undefined, state: "sending" as const }].slice(-20),
      },
    }));
    return id;
  },
  update: (agentKey, id, patch) =>
    set((s) => {
      const list = s.byAgent[agentKey];
      if (!list?.some((x) => x.id === id)) return s;
      return { byAgent: { ...s.byAgent, [agentKey]: list.map((x) => (x.id === id ? { ...x, ...patch } : x)) } };
    }),
  drop: (agentKey, ids) =>
    set((s) => {
      const left = (s.byAgent[agentKey] ?? []).filter((x) => !ids.includes(x.id));
      return { byAgent: { ...s.byAgent, [agentKey]: left } };
    }),
}));
