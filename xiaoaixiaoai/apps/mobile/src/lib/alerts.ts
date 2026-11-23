/**
 * Background alerts: a resident Android service keeps /v1/notify open and posts
 * a notification when an agent needs you, finishes, or a reminder is due.
 */
import { useEffect } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { create } from "zustand";
import { XiaoaiNative } from "../../modules/xiaoaixiaoai-native";
import { applog } from "./applog";
import { useSettings } from "./store";
import { loadToken } from "./auth";
import { isMockServer } from "./mock";
import { useAssistant } from "./assistant";

export const alertsSupported = !!XiaoaiNative;

interface AlertsState {
  connected: boolean;
  notificationsAllowed: boolean;
  channelSoundAllowed: boolean;
  batteryUnrestricted: boolean;
}

export const useAlerts = create<AlertsState>()(() => ({
  connected: false,
  notificationsAllowed: true,
  channelSoundAllowed: true,
  batteryUnrestricted: false,
}));

export function refreshAlertState() {
  if (!XiaoaiNative) return;
  const s = XiaoaiNative.notifierState();
  useAlerts.setState({
    connected: s.connected,
    notificationsAllowed: s.notificationsAllowed,
    channelSoundAllowed: s.channelSoundAllowed ?? true,
    batteryUnrestricted: s.batteryUnrestricted,
  });
}

XiaoaiNative?.addListener("onNotifier", (e) => {
  useAlerts.setState({ connected: e.connected });
  refreshAlertState();
  applog(e.connected ? "info" : "warn", "notify", `notifier ${e.connected ? "connected" : "disconnected"}${e.reason ? ` (${e.reason})` : ""}`);
});

export function openAppDetails(): void {
  XiaoaiNative?.openAppDetails?.();
}

/** Asks for the notification permission (Android 13+). */
export async function askNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (Number(Platform.Version) < 33) return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  refreshAlertState();
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

async function sync() {
  if (!XiaoaiNative) return;
  const before = useSettings.getState();
  const real = !!before.server && !isMockServer(before.server);
  const token = real ? await loadToken().catch(() => null) : null;
  const s = useSettings.getState();
  if (s.server !== before.server || s.deviceId !== before.deviceId) return;
  const kinds = ["reminder", ...(s.alertBlocked ? ["blocked"] : []), ...(s.alertDone ? ["done"] : []), ...(s.alertProgress ? ["progress"] : [])];
  try {
    XiaoaiNative.configureNotifier(real ? s.server : null, token, real && s.alertsOn && !!token, kinds, useAssistant.getState().name);
  } catch {
    // Starting a foreground service can be refused while the app is in the background; it is retried on the next change.
  }
  refreshAlertState();
}

/** Keeps the native service in step with the pairing and the alert settings. */
export function useAlertSync() {
  const hydrated = useSettings((s) => s.hydrated);
  const server = useSettings((s) => s.server);
  const deviceId = useSettings((s) => s.deviceId);
  const on = useSettings((s) => s.alertsOn);
  const blocked = useSettings((s) => s.alertBlocked);
  const done = useSettings((s) => s.alertDone);
  const progress = useSettings((s) => s.alertProgress);
  const asked = useSettings((s) => s.alertsAsked);
  const name = useAssistant((s) => s.name);
  useEffect(() => {
    if (!hydrated) return;
    void sync();
  }, [hydrated, server, deviceId, on, blocked, done, progress, name]);
  useEffect(() => {
    if (!hydrated) return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void sync();
    });
    return () => sub.remove();
  }, [hydrated]);
  // First time on a real server: ask once, so alerts can show at all.
  useEffect(() => {
    if (!hydrated || asked || !server || isMockServer(server) || !XiaoaiNative) return;
    useSettings.getState().set({ alertsAsked: true });
    void askNotificationPermission();
  }, [hydrated, asked, server]);
}
