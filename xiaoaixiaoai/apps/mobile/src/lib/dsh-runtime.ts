import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { create } from "zustand";
import type { RuntimeSessionState } from "@xiaoaixiaoai/protocol";
import { followsFor, observedIdle, updateFollow, type DshIntent } from "./dsh-follows";
import { call } from "./relay";
import { useLive, useSettings } from "./store";

type Pending = DshIntent & { server: string; viewer: string; sequence: number };
let nextIntent = 0;
export const useDshIntent = create<{ pending: Pending | null }>(() => ({ pending: null }));
export function stageDshIntent(intent: DshIntent, server: string, viewer: string) {
  useDshIntent.setState({ pending: { ...intent, server, viewer, sequence: ++nextIntent } });
}

const activeNow = () => AppState.currentState === "active";
function subscribeApp(change: () => void) {
  const sub = AppState.addEventListener("change", change);
  return () => sub.remove();
}
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribeApp, activeNow, () => false);
}

function useFollowScope() {
  const saved = useSettings((s) => s.dshFollows);
  const server = useSettings((s) => s.server);
  const configured = useSettings((s) => s.deviceId);
  const live = useLive((s) => s.self?.id);
  const viewer = configured === live ? live : undefined;
  return { server, viewer, items: followsFor(saved, server, viewer) };
}

export function useDshFollows(hostId: string) {
  const { server, viewer, items } = useFollowScope();
  const local = useMemo(() => items.filter((s) => s.hostId === hostId), [items, hostId]);
  const change = useCallback((sessionId: string, mode: Parameters<typeof updateFollow>[3]) => {
    const settings = useSettings.getState();
    const live = useLive.getState();
    if (!server || !viewer || settings.server !== server || settings.deviceId !== viewer || live.self?.id !== viewer ||
        (mode !== "unfollow" && (live.link !== "online" || !live.devices[hostId]?.online || AppState.currentState !== "active"))) return false;
    const previous = followsFor(settings.dshFollows, server, viewer);
    const items = updateFollow(previous, hostId, sessionId, mode);
    if (!items) return false;
    if (previous !== items) settings.set({ dshFollows: items.length ? { server, viewer, items } : null });
    return true;
  }, [server, viewer, hostId]);
  return { items: local, change };
}

/** Local in-app notices only. The old relay is a transport, not a subscriber to this directory. */
export function useDshForegroundNotice() {
  const { server, viewer, items } = useFollowScope();
  const subscribed = useMemo(() => items.filter((s) => s.remind), [items]);
  const enabled = useSettings((s) => s.alertsOn && s.alertDone);
  const online = useLive((s) => s.link === "online");
  const active = useAppActive();
  const lease = useMemo(() => ({ enabled, online, active, server, viewer, subscribed }), [enabled, online, active, server, viewer, subscribed]);
  const [notice, setNotice] = useState<{ lease: typeof lease; count: number }>();
  useEffect(() => {
    const { enabled, online, active, server, viewer, subscribed } = lease;
    if (!enabled || !online || !active || !server || !viewer || !subscribed.length) return;
    const groups = new Map<string, Set<string>>();
    for (const s of subscribed) {
      let ids = groups.get(s.hostId);
      if (!ids) groups.set(s.hostId, ids = new Set());
      ids.add(s.sessionId);
    }
    const last = new Map<string, ReadonlyMap<string, RuntimeSessionState>>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && AppState.currentState === "active" && useLive.getState().link === "online" &&
      useLive.getState().self?.id === viewer && useSettings.getState().deviceId === viewer && useSettings.getState().server === server;
    const available = (id: string) => {
      const host = useLive.getState().devices[id];
      return host?.kind === "host" && host.online && host.sources?.includes("dsh-directory");
    };
    async function tick() {
      if (!current()) { last.clear(); return; }
      const counts = await Promise.all([...groups].map(async ([id, sessionIds]) => {
        if (available(id)) {
          try {
            const reply = await call(id, "runtimeSessions.browse", { view: "exact", sessionIds: [...sessionIds] });
            if (current() && available(id) && reply.view === "exact") {
              const next = observedIdle(last.get(id) ?? new Map(), reply.entries, sessionIds);
              last.set(id, next.observed);
              return next.count;
            }
          } catch { /* No notice from an unavailable or unauthorized observation. */ }
        }
        last.delete(id);
        return 0;
      }));
      if (!current()) return;
      const count = counts.reduce((a, b) => a + b, 0);
      if (count) setNotice((old) => ({ lease, count: (old?.lease === lease ? old.count : 0) + count }));
      timer = setTimeout(() => void tick(), 12_000);
    }
    void tick();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
  }, [lease]);
  return { notice: notice?.lease === lease ? notice.count : 0, dismiss: () => setNotice(undefined) };
}
