/**
 * Harness marks the app can't ship itself, fetched from a computer's Uniflo
 * (`harness.icons`). For a harness with no sticker and no bundled glyph, an
 * online computer that runs agents of that harness is asked once per app
 * session. Answers are kept in memory and on disk so they survive restarts;
 * until one arrives (or when the computer has none) the avatar shows a letter.
 */
import { useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { HARNESS_ICON_MAX } from "@xiaoaixiaoai/protocol";
import { harnessLook } from "./harness";
import { call, RelayError } from "./relay";
import { useLive } from "./store";

/** At most this many marks are kept on disk (each is a small SVG, at most 64 KB). */
const KEEP = 80;

interface RemoteIcons {
  /** Uniflo harness id -> SVG document (`fill="currentColor"`, 24×24 viewBox). */
  icons: Record<string, string>;
}

export const useRemoteIcons = create<RemoteIcons>()(
  persist(() => ({ icons: {} }), {
    name: "xiaoaixiaoai.harness-icons",
    storage: createJSONStorage(() => AsyncStorage),
  }),
);

/** `device:id` pairs already asked this session (asked once, whatever the answer). */
const asked = new Set<string>();
/** Computers whose host doesn't know `harness.icons` yet. */
const unsupported = new Set<string>();
/** Computers with a request in flight. */
const busy = new Set<string>();

function remember(found: Record<string, string>): void {
  const entries = Object.entries(found).filter(([, svg]) => typeof svg === "string" && svg.startsWith("<svg"));
  if (!entries.length) return;
  useRemoteIcons.setState((s) => {
    const icons = { ...s.icons, ...Object.fromEntries(entries) };
    const keys = Object.keys(icons);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete icons[k];
    return { icons };
  });
}

function sync(): void {
  const { link, devices, agents } = useLive.getState();
  if (link !== "online") return;
  const have = useRemoteIcons.getState().icons;
  for (const [deviceId, list] of Object.entries(agents)) {
    if (!devices[deviceId]?.online || unsupported.has(deviceId) || busy.has(deviceId)) continue;
    const ids = new Set<string>();
    for (const a of list) {
      const id = harnessLook(a.harness, a.isShell).remoteId;
      if (id && !have[id] && !asked.has(`${deviceId}:${id}`)) ids.add(id);
    }
    if (!ids.size) continue;
    const batch = [...ids].slice(0, HARNESS_ICON_MAX);
    for (const id of batch) asked.add(`${deviceId}:${id}`);
    busy.add(deviceId);
    call(deviceId, "harness.icons", { ids: batch })
      .then((r) => remember(r.icons ?? {}))
      .catch((e: unknown) => {
        if (e instanceof RelayError && e.code === "unsupported") unsupported.add(deviceId);
      })
      .finally(() => {
        busy.delete(deviceId);
      });
  }
}

/** Keeps marks coming for the harnesses on screen; mount once near the root. */
export function useHarnessIconSync(): void {
  useEffect(() => {
    sync();
    return useLive.subscribe((s, prev) => {
      if (s.agents !== prev.agents || s.devices !== prev.devices || s.link !== prev.link) sync();
    });
  }, []);
}

/** The computer's mark for this Uniflo harness id, if one has arrived. */
export function useRemoteIcon(id: string | undefined): string | undefined {
  return useRemoteIcons((s) => (id ? s.icons[id] : undefined));
}
