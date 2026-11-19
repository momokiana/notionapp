// Where things live on each OS. macOS and Linux keep the XDG-style folders; Windows uses
// %APPDATA% (settings), %LOCALAPPDATA% (state, logs) and named pipes instead of Unix sockets.
// Functions take the environment and platform so tests can ask for the other OS.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

type Env = Record<string, string | undefined>;

function appData(env: Env, home: string): string {
  return env.APPDATA || win32.join(home, "AppData", "Roaming");
}

export function localAppData(env: Env = process.env, home = homedir()): string {
  return env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
}

/** Settings and the device token (hostd.json). */
export function configDir(env: Env = process.env, windows = IS_WINDOWS, home = homedir()): string {
  if (env.XIAOAIXIAOAI_HOME) return env.XIAOAIXIAOAI_HOME;
  return windows ? win32.join(appData(env, home), "xiaoaixiaoai") : posix.join(home, ".config", "xiaoaixiaoai");
}

/** Things this computer keeps but never syncs: received pictures, the Windows service log. */
export function stateDir(env: Env = process.env, windows = IS_WINDOWS, home = homedir()): string {
  if (env.XIAOAIXIAOAI_STATE) return env.XIAOAIXIAOAI_STATE;
  return windows ? win32.join(localAppData(env, home), "xiaoaixiaoai") : posix.join(home, ".local", "state", "xiaoaixiaoai");
}

/**
 * The daemon's local control channel: a socket in the config folder, or on Windows a
 * named pipe whose name comes from that folder (pipes share one namespace per machine).
 */
export function controlAddress(dir: string, windows = IS_WINDOWS, which: "hostd" | "service" = "hostd"): string {
  if (!windows) return posix.join(dir, which === "hostd" ? "hostd.sock" : "service.sock");
  const id = createHash("sha256").update(dir.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\xiaoaixiaoai-${which}-${id}`;
}

/** `hc`, or on Windows the copy its installer puts in %LOCALAPPDATA%\Programs\herdr-core. */
export function defaultHcBin(env: Env = process.env, windows = IS_WINDOWS): string {
  if (env.HC_BIN) return env.HC_BIN;
  if (!windows) return "hc";
  const exe = win32.join(localAppData(env), "Programs", "herdr-core", "hc.exe");
  return onPath("hc", env, true) ?? (existsSync(exe) ? exe : "hc");
}

/** File extensions Windows runs from a bare name, in PATHEXT order (only real programs, not scripts). */
export function programExtensions(env: Env = process.env): string[] {
  const allowed = new Set([".exe", ".cmd", ".bat", ".com"]);
  const list = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => allowed.has(e));
  return list.length ? list : [".exe", ".cmd"];
}

/** Folders where Windows installers put command-line programs, besides PATH. */
export function windowsBins(env: Env = process.env, home = homedir()): string[] {
  const local = localAppData(env, home);
  return [
    win32.join(home, ".local", "bin"), // Claude Code's native installer
    win32.join(appData(env, home), "npm"),
    win32.join(local, "pnpm"),
    win32.join(home, ".bun", "bin"),
    win32.join(local, "Volta", "bin"),
    win32.join(home, "scoop", "shims"),
    win32.join(local, "Microsoft", "WinGet", "Links"),
    win32.join(home, ".cargo", "bin"),
    win32.join(home, ".deno", "bin"),
  ];
}

/** Full path of a program the way `where` finds it, or undefined. Windows only. */
export function onPath(name: string, env: Env = process.env, windows = IS_WINDOWS, extra: string[] = []): string | undefined {
  if (!windows) return undefined;
  const dirs = [...(env.PATH ?? env.Path ?? "").split(";"), ...extra].map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const exts = programExtensions(env);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A program name without its Windows extension: `claude.cmd` -> `claude`. */
export function programName(file: string): string {
  return file.replace(/\.(exe|cmd|bat|com)$/i, "");
}
