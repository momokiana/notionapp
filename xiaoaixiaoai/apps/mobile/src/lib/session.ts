import { Platform } from "react-native";
import { pairDevice, normalizeServer, revokeDevice, stopLink, RelayError } from "./relay";
import { clearToken, loadToken, saveToken } from "./auth";
import { isMockServer } from "./mock";
import { useSettings } from "./store";

/** The phone's own model name, so several phones are tellable apart in the device list. */
export function defaultDeviceName(): string {
  const c = Platform.constants as { Model?: string; Brand?: string };
  const model = c.Model?.trim();
  if (!model) return "我的安卓手机";
  const brand = c.Brand?.trim();
  const named = brand && !model.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${model}` : model;
  return named.slice(0, 40);
}

/** This phone's current registration on a real relay, if it has one. */
async function currentRegistration(): Promise<{ server: string; token: string; deviceId: string } | null> {
  const { server, deviceId } = useSettings.getState();
  if (!server || !deviceId || isMockServer(server)) return null;
  const token = await loadToken();
  return token ? { server, token, deviceId } : null;
}

/** Best effort: the relay forgets a registration this phone no longer uses. */
function forget(reg: { server: string; token: string; deviceId: string } | null): Promise<void> {
  if (!reg) return Promise.resolve();
  // Never keep the person waiting on this: an unreachable relay just leaves the old entry to be removed by hand.
  return Promise.race([
    revokeDevice(reg.server, reg.token, reg.deviceId).catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, 4000)),
  ]);
}

/** Exchange a pair code for a device token and remember the server. */
export async function completePairing(serverInput: string, code: string, name: string): Promise<void> {
  const server = normalizeServer(serverInput);
  if (!server) throw new RelayError("bad_request", "先填一下服务器地址");
  if (!code.trim()) throw new RelayError("bad_request", "配对码不能为空");
  const previous = await currentRegistration();
  const res = await pairDevice(server, code, name.trim() || defaultDeviceName(), Platform.OS, previous?.server === server ? previous.token : undefined);
  // Close the old socket first, so revoking the old registration is not read as "授权失效".
  stopLink();
  await saveToken(res.token);
  useSettings.getState().set({
    server,
    deviceId: res.device.id,
    deviceName: res.device.name,
    ...(isMockServer(server) ? {} : { lastServer: server }),
  });
  if (previous && previous.deviceId !== res.device.id) void forget(previous);
}

export async function signOut(): Promise<void> {
  const previous = await currentRegistration();
  stopLink();
  await forget(previous);
  await clearToken();
  useSettings.getState().signOut();
}

/**
 * The invite this phone's own scanner just read. Scanning is a clear intent, so the pair
 * screen connects at once; a link opened from elsewhere asks first when the phone is
 * already connected, so a stray link cannot move it to another server.
 */
let scannedInvite: string | null = null;
export function markScannedInvite(server: string, code: string): void {
  scannedInvite = `${server} ${code}`;
}
export function takeScannedInvite(server: string, code: string): boolean {
  const hit = scannedInvite === `${server} ${code}`;
  scannedInvite = null;
  return hit;
}

/** Relay messages are already written for people; only fill in when there is none. */
export function friendlyError(e: unknown): string {
  if (e instanceof RelayError) return e.message || "出了点小问题，再试一次吧";
  return e instanceof Error ? e.message : "出了点小问题，再试一次吧";
}
