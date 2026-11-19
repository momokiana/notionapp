import { execFile } from "node:child_process";
import { basename } from "node:path";

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      // windowsHide: no console window flashing up for each call when the daemon runs in the background.
      { timeout: opts.timeoutMs ?? 20_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true, ...(opts.env ? { env: opts.env } : {}) },
      (err, stdout, stderr) => {
        // `code` stays on the error: ENOENT means the program is not installed.
        if (err) reject(Object.assign(new Error(`${cmd} ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`), { code: (err as NodeJS.ErrnoException).code }));
        else resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Splits a stream into lines, buffering partial chunks. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

/**
 * Agent CLIs decorate terminal titles with spinners and Nerd Font glyphs
 * ("π ⠸ 󰉫 HEADER: fix it", "✳ Refactor auth"). Keep only the human part.
 */
export function cleanTitle(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw
    .replace(/[\u2800-\u28ff]/g, "") // braille spinners
    .replace(/[\ue000-\uf8ff]/g, "") // BMP private use (nerd fonts)
    .replace(/[\u{f0000}-\u{10ffff}]/gu, "") // supplementary private use
    .replace(/\s+/g, " ")
    .trim();
  const words = stripped.split(" ");
  while (words.length > 1 && words[0]!.length <= 2 && !/[A-Za-z0-9\u4e00-\u9fff]/.test(words[0]!)) words.shift();
  const out = words.join(" ").trim();
  return out || undefined;
}

export function base(p: string | undefined | null): string {
  return p ? basename(p) : "";
}

export function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字）`, truncated: true };
}

export function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}
