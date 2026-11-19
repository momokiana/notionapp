import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, controlAddress } from "./platform.ts";

export interface HostConfig {
  server: string;
  token: string;
  deviceId: string;
  name: string;
}

export const CONFIG_DIR = configDir();
export const CONFIG_PATH = join(CONFIG_DIR, "hostd.json");
/** Unix socket, or a named pipe on Windows. */
export const CONTROL_SOCKET = controlAddress(CONFIG_DIR);
/** The Windows background service's own channel (start, stop, restart). */
export const SERVICE_SOCKET = controlAddress(CONFIG_DIR, undefined, "service");

export function loadConfig(): HostConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as HostConfig;
    return c.server && c.token ? c : null;
  } catch {
    return null;
  }
}

/** The file holds the device token: owner read/write only (on Windows the per-user %APPDATA% keeps it private). */
export function saveConfig(c: HostConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}
