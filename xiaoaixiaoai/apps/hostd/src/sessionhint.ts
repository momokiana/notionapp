/**
 * The Uniflo session a running agent writes to, read from the process itself
 * rather than guessed from cwd and title:
 *
 * - Claude Code keeps `~/.claude/sessions/<pid>.json` with the live session id
 *   (it changes on /clear and /resume, the file follows). Some versions leave a
 *   stray `}` after the object when they rewrite it shorter, which strict
 *   parsers reject, so only the first object is read.
 * - A program started with `--resume <id>` / `--session-id <id>` names it on
 *   its command line (Claude Code, omp and others).
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Parses the first JSON object in `s`, ignoring whatever follows it. */
export function firstJsonObject(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    /* fall through: trailing garbage */
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,}$/;
const FLAGS = new Set(["--resume", "-r", "--session-id", "--session", "--continue-session"]);

/** Subcommands whose next word is a session id (`codex resume <id>`, `claude attach <short id>`). */
const SUBCOMMANDS = new Set(["resume", "attach"]);

/**
 * Session id named on a command line (`--resume <id>`, `--resume=<id>`,
 * `codex resume <id>`, `claude attach <id>`). May be a short prefix of the id.
 */
export function argvSessionId(argv: string[] | undefined): string | undefined {
  if (!argv?.length) return undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = /^(--[\w-]+)=(.+)$/.exec(a);
    if (eq && FLAGS.has(eq[1]!) && ID.test(eq[2]!)) return eq[2];
    const next = argv[i + 1];
    if ((FLAGS.has(a) || (SUBCOMMANDS.has(a) && i === 1)) && next && ID.test(next)) return next;
  }
  return undefined;
}

export class SessionHints {
  private cache = new Map<number, { mtimeMs: number; id?: string }>();
  private home: string;
  constructor(home = homedir()) {
    this.home = home;
  }

  /** Live Claude Code session id of process `pid`, from its registry file. */
  claudeSession(pid: number | undefined): string | undefined {
    if (!pid) return undefined;
    const file = join(this.home, ".claude", "sessions", `${pid}.json`);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      this.cache.delete(pid);
      return undefined;
    }
    const hit = this.cache.get(pid);
    if (hit && hit.mtimeMs === mtimeMs) return hit.id;
    let id: string | undefined;
    try {
      const j = firstJsonObject(readFileSync(file, "utf8"));
      // The file is keyed by pid, but pids get reused: trust it only for this process.
      if (j && (j.pid === undefined || j.pid === pid) && typeof j.sessionId === "string" && ID.test(j.sessionId)) id = j.sessionId;
    } catch {
      id = undefined;
    }
    this.cache.set(pid, { mtimeMs, id });
    return id;
  }

  /**
   * Uniflo key (`<harness>:<id>`) for an agent, or undefined.
   * `harness` is the Uniflo harness id (claude, omp, codex…).
   */
  key(harness: string | undefined, argv: string[] | undefined, pid: number | undefined): string | undefined {
    if (!harness) return undefined;
    const id = (harness === "claude" ? this.claudeSession(pid) : undefined) ?? argvSessionId(argv);
    return id ? `${harness}:${id}` : undefined;
  }

  /** Drops entries of processes that are gone. */
  prune(live: Set<number>): void {
    for (const pid of this.cache.keys()) if (!live.has(pid)) this.cache.delete(pid);
  }
}
