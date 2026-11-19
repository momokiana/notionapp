import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Device, DeviceKind, Notice, RuntimeTaskEvent, RuntimeTaskNoticeTarget } from "@xiaoaixiaoai/protocol";
import {
  RUNTIME_TASK_MAX_ACTIVE,
  RUNTIME_TASK_MAX_CLAIMS_PER_HOST,
  RUNTIME_TASK_MAX_NONTERMINAL,
  RUNTIME_TASK_REPLAY_LIMIT,
  RUNTIME_TASK_REPLAY_MS,
  RUNTIME_TASK_TTL_MS,
  runtimeTaskNotice,
  type RuntimeTaskDelivery,
} from "./runtime-task-notices.ts";

/** Device tokens are stored hashed; the plain token is shown once at pairing. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const WORDS = ["MEOW", "BAAA", "MOOO", "WOOF", "PEEP", "HONK", "QUAK", "PURR"];
/** `created_by` of the first-run setup code. */
const SETUP = "setup";

export interface PairCodeRow {
  code: string;
  kind: DeviceKind | null;
  expiresAt: number;
  createdBy: string | null;
}

export interface EventRow {
  ts: number;
  source: string;
  device?: string;
  kind: string;
  level: string;
  msg: string;
  /** JSON object, already clipped. */
  data?: string;
}

export interface EventQuery {
  since?: number;
  until?: number;
  after?: number;
  device?: string;
  source?: string;
  kind?: string;
  levels?: string[];
  text?: string;
  limit?: number;
}

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  platform: string | null;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        platform TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY,
        kind TEXT,
        expires_at INTEGER NOT NULL,
        created_by TEXT
      );
      CREATE TABLE IF NOT EXISTS assistant_items (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assistant_items_ts ON assistant_items (ts);
      CREATE TABLE IF NOT EXISTS assistant_reminders (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_notices (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_task_claims (
        host_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        PRIMARY KEY (host_id, request_hash)
      );
      CREATE TABLE IF NOT EXISTS runtime_tasks (
        host_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (host_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS runtime_tasks_viewer ON runtime_tasks (viewer_id);
      CREATE INDEX IF NOT EXISTS runtime_tasks_expiry ON runtime_tasks (expires_at);
      CREATE TABLE IF NOT EXISTS runtime_task_events (
        host_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('progress', 'attention', 'completed', 'stopped')),
        notice_id TEXT NOT NULL UNIQUE,
        ts INTEGER NOT NULL,
        PRIMARY KEY (host_id, event_id),
        FOREIGN KEY (host_id, request_id) REFERENCES runtime_tasks (host_id, request_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS runtime_task_events_task ON runtime_task_events (host_id, request_id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        device TEXT,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        msg TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE INDEX IF NOT EXISTS events_device ON events (device, ts);
    `);
    this.pruneRuntimeTasks(Date.now());
  }

  // Settings changed at run time (e.g. from the app): one JSON value per key.

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT json FROM settings WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  putSetting(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, json) VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  // Event log (see eventlog.ts): rows are already redacted and clipped.

  putEvents(rows: EventRow[]): void {
    const stmt = this.db.prepare("INSERT INTO events (ts, source, device, kind, level, msg, data) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const r of rows) stmt.run(r.ts, r.source, r.device ?? null, r.kind, r.level, r.msg, r.data ?? null);
  }

  /** Oldest first. `kind` matches itself and its dotted children (`assistant` matches `assistant.tool`). */
  queryEvents(q: EventQuery): Array<EventRow & { id: number }> {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.since !== undefined) (where.push("ts >= ?"), args.push(q.since));
    if (q.until !== undefined) (where.push("ts <= ?"), args.push(q.until));
    if (q.after !== undefined) (where.push("id > ?"), args.push(q.after));
    if (q.device) (where.push("device = ?"), args.push(q.device));
    if (q.source) (where.push("source = ?"), args.push(q.source));
    if (q.kind) (where.push("(kind = ? OR kind LIKE ?)"), args.push(q.kind, `${q.kind.replace(/[%_]/g, "")}.%`));
    if (q.levels?.length) (where.push(`level IN (${q.levels.map(() => "?").join(",")})`), args.push(...q.levels));
    if (q.text) {
      const like = `%${q.text.replace(/[%_]/g, "")}%`;
      where.push("(msg LIKE ? OR data LIKE ?)");
      args.push(like, like);
    }
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000);
    // Following (`after`) reads forward; otherwise the newest `limit` lines are what matters.
    const order = q.after !== undefined ? "ASC" : "DESC";
    const sql = `SELECT id, ts, source, device, kind, level, msg, data FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ${order} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as unknown as Array<Omit<EventRow, "device" | "data"> & { id: number; device: string | null; data: string | null }>;
    const out = rows.map((r) => ({ ...r, device: r.device ?? undefined, data: r.data ?? undefined }));
    return order === "DESC" ? out.reverse() : out;
  }

  /** Drops lines older than `before`, then all but the newest `keep`. */
  pruneEvents(before: number, keep: number): void {
    this.db.prepare("DELETE FROM events WHERE ts < ?").run(before);
    const row = this.db.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?").get(keep) as { id: number } | undefined;
    if (row) this.db.prepare("DELETE FROM events WHERE id <= ?").run(row.id);
  }

  // Assistant thread, reminders and notices: opaque JSON rows owned by assistant/.

  putAssistantItem(id: string, ts: number, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO assistant_items (id, ts, json) VALUES (?, ?, ?)").run(id, ts, JSON.stringify(value));
  }

  /** Newest `limit` items, oldest first. */
  listAssistantItems<T>(limit: number): T[] {
    const rows = this.db.prepare("SELECT json FROM assistant_items ORDER BY ts DESC, id DESC LIMIT ?").all(limit) as Array<{ json: string }>;
    return rows.reverse().map((r) => JSON.parse(r.json) as T);
  }

  clearAssistantItems(): void {
    this.db.prepare("DELETE FROM assistant_items").run();
  }

  /** Keeps the newest `keep` items. */
  pruneAssistantItems(keep: number): void {
    this.db
      .prepare("DELETE FROM assistant_items WHERE id NOT IN (SELECT id FROM assistant_items ORDER BY ts DESC, id DESC LIMIT ?)")
      .run(keep);
  }

  putReminder(id: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO assistant_reminders (id, json) VALUES (?, ?)").run(id, JSON.stringify(value));
  }

  listReminders<T>(): T[] {
    return (this.db.prepare("SELECT json FROM assistant_reminders").all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as T);
  }

  deleteReminder(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM assistant_reminders WHERE id = ?").run(id).changes) > 0;
  }

  putNotice(id: string, ts: number, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO assistant_notices (id, ts, json) VALUES (?, ?, ?)").run(id, ts, JSON.stringify(value));
    this.db.prepare("DELETE FROM assistant_notices WHERE ts < ?").run(Date.now() - 3 * 86_400_000);
  }

  /** Notices newer than `since`, oldest first, at most `limit`. */
  noticesSince<T>(since: number, limit: number): T[] {
    const rows = this.db.prepare("SELECT json FROM assistant_notices WHERE ts > ? ORDER BY ts DESC LIMIT ?").all(since, limit) as Array<{ json: string }>;
    return rows.reverse().map((r) => JSON.parse(r.json) as T);
  }

  // Scoped runtime task notices: never stored in the assistant thread, notices or event log.

  bindRuntimeTask(target: RuntimeTaskNoticeTarget, viewerId: string, now: number): void {
    const { hostId, requestId, projectId, sessionId } = target;
    // Keep a bounded hash-only fence until the host registration goes away. Expiry or
    // viewer revocation removes all delivery data without allowing a replay to take it over.
    const requestHash = createHash("sha256").update(`${hostId}/${requestId}`).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.db.prepare(`
        INSERT INTO runtime_task_claims (host_id, request_hash)
        SELECT host.id, ? FROM devices AS host
        WHERE host.id = ? AND host.kind = 'host'
          AND (SELECT COUNT(*) FROM runtime_task_claims WHERE host_id = host.id) < ?
        ON CONFLICT (host_id, request_hash) DO NOTHING
      `).run(requestHash, hostId, RUNTIME_TASK_MAX_CLAIMS_PER_HOST);
      if (claim.changes) {
        // A receipt arriving just after revocation can leave a fence, but never delivery data.
        this.db.prepare(`
          INSERT INTO runtime_tasks (host_id, request_id, viewer_id, project_id, session_id, expires_at)
          SELECT ?, ?, viewer.id, ?, ?, ? FROM devices AS viewer
          WHERE viewer.id = ? AND viewer.kind = 'viewer'
            AND (SELECT COUNT(*) FROM runtime_tasks WHERE expires_at > ?) < ?
        `).run(hostId, requestId, projectId, sessionId, now + RUNTIME_TASK_TTL_MS, viewerId, now, RUNTIME_TASK_MAX_ACTIVE);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recordRuntimeTaskEvent(hostId: string, event: RuntimeTaskEvent, now: number): RuntimeTaskDelivery | "duplicate" | undefined {
    const { requestId, kind } = event;
    const eventId = event.eventId.toLowerCase();
    const task = this.db.prepare(`
      SELECT t.viewer_id, t.project_id, t.session_id FROM runtime_tasks AS t
      JOIN devices AS viewer ON viewer.id = t.viewer_id AND viewer.kind = 'viewer'
      JOIN devices AS host ON host.id = t.host_id AND host.kind = 'host'
      WHERE t.host_id = ? AND t.request_id = ? AND t.expires_at > ?
    `).get(hostId, requestId, now) as { viewer_id: string; project_id: string; session_id: string } | undefined;
    if (!task) return;
    const seen = this.db.prepare("SELECT request_id, kind FROM runtime_task_events WHERE host_id = ? AND event_id = ?")
      .get(hostId, eventId) as { request_id: string; kind: string } | undefined;
    if (seen) return seen.request_id === requestId && seen.kind === kind ? "duplicate" : undefined;

    const noticeId = randomUUID();
    const terminal = kind === "completed" || kind === "stopped";
    // A terminal observation closes the task permanently. Reserve space for it even
    // when the task's nonterminal budget runs out; dedup receipts are kept with the task.
    const result = this.db.prepare(`
      INSERT INTO runtime_task_events (host_id, event_id, request_id, kind, notice_id, ts)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM runtime_task_events WHERE host_id = ? AND request_id = ? AND kind IN ('completed', 'stopped'))
        AND (? OR (SELECT COUNT(*) FROM runtime_task_events WHERE host_id = ? AND request_id = ?) < ?)
      ON CONFLICT (host_id, event_id) DO NOTHING
    `).run(hostId, eventId, requestId, kind, noticeId, now, hostId, requestId, terminal ? 1 : 0, hostId, requestId, RUNTIME_TASK_MAX_NONTERMINAL);
    if (!result.changes) return;
    return {
      viewerId: task.viewer_id,
      notice: runtimeTaskNotice(noticeId, kind, now, { hostId, projectId: task.project_id, sessionId: task.session_id, requestId }),
    };
  }

  runtimeTaskNoticesSince(viewerId: string, since: number, now: number): Notice[] {
    const rows = this.db.prepare(`
      SELECT e.notice_id, e.kind, e.ts, t.host_id, t.request_id, t.project_id, t.session_id
      FROM runtime_tasks AS t JOIN runtime_task_events AS e USING (host_id, request_id)
      WHERE t.viewer_id = ? AND t.expires_at > ? AND e.ts > ?
      ORDER BY e.ts DESC, e.rowid DESC LIMIT ?
    `).all(viewerId, now, Math.max(since, now - RUNTIME_TASK_REPLAY_MS), RUNTIME_TASK_REPLAY_LIMIT) as unknown as Array<{
      notice_id: string; kind: RuntimeTaskEvent["kind"]; ts: number;
      host_id: string; request_id: string; project_id: string; session_id: string;
    }>;
    return rows.reverse().map((r) => runtimeTaskNotice(r.notice_id, r.kind, r.ts, {
      hostId: r.host_id, requestId: r.request_id, projectId: r.project_id, sessionId: r.session_id,
    }));
  }

  pruneRuntimeTasks(now: number): void {
    this.db.prepare("DELETE FROM runtime_tasks WHERE expires_at <= ?").run(now);
  }

  close(): void {
    this.db.close();
  }

  createPairCode(opts: { kind?: DeviceKind; ttlSec?: number; createdBy?: string; digits?: number }): PairCodeRow {
    const now = Date.now();
    this.db.prepare("DELETE FROM pair_codes WHERE expires_at < ?").run(now);
    const ttl = Math.min(Math.max(opts.ttlSec ?? 600, 60), 3600);
    const digits = Math.min(Math.max(opts.digits ?? 4, 4), 8);
    for (;;) {
      const code = `${WORDS[randomInt(WORDS.length)]}-${String(randomInt(10 ** digits)).padStart(digits, "0")}`;
      const exists = this.db.prepare("SELECT 1 FROM pair_codes WHERE code = ?").get(code);
      if (exists) continue;
      const row: PairCodeRow = {
        code,
        kind: opts.kind ?? null,
        expiresAt: now + ttl * 1000,
        createdBy: opts.createdBy ?? null,
      };
      this.db
        .prepare("INSERT INTO pair_codes (code, kind, expires_at, created_by) VALUES (?, ?, ?, ?)")
        .run(row.code, row.kind, row.expiresAt, row.createdBy);
      return row;
    }
  }

  /**
   * Consumes a pair code (single use). A code presented by the wrong kind of
   * device is left intact: typing a computer's code on a phone must not burn it.
   */
  consumePairCode(code: string, kind: DeviceKind): PairCodeRow | "missing" | "expired" | "wrong_kind" {
    const norm = code.trim().toUpperCase();
    const row = this.db.prepare("SELECT code, kind, expires_at, created_by FROM pair_codes WHERE code = ?").get(norm) as
      | { code: string; kind: string | null; expires_at: number; created_by: string | null }
      | undefined;
    if (!row) return "missing";
    if (row.expires_at < Date.now()) {
      this.db.prepare("DELETE FROM pair_codes WHERE code = ?").run(norm);
      return "expired";
    }
    if (row.kind && row.kind !== kind) return "wrong_kind";
    this.db.prepare("DELETE FROM pair_codes WHERE code = ?").run(norm);
    return { code: row.code, kind: row.kind as DeviceKind | null, expiresAt: row.expires_at, createdBy: row.created_by };
  }

  /**
   * The first-run setup code: a one-time code for the first device, kept only while the
   * relay has no devices. Reuses a code with at least `minLeftMs` to go unless `fresh`.
   * Null once any device exists.
   */
  setupCode(opts: { ttlSec: number; minLeftMs: number; fresh?: boolean }): PairCodeRow | null {
    if (this.deviceCount() > 0) {
      this.dropSetupCodes();
      return null;
    }
    if (!opts.fresh) {
      const row = this.db
        .prepare("SELECT code, kind, expires_at, created_by FROM pair_codes WHERE created_by = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
        .get(SETUP, Date.now() + opts.minLeftMs) as { code: string; kind: string | null; expires_at: number; created_by: string } | undefined;
      if (row) return { code: row.code, kind: null, expiresAt: row.expires_at, createdBy: row.created_by };
    }
    this.dropSetupCodes();
    return this.createPairCode({ ttlSec: opts.ttlSec, createdBy: SETUP, digits: 6 });
  }

  dropSetupCodes(): void {
    this.db.prepare("DELETE FROM pair_codes WHERE created_by = ?").run(SETUP);
  }

  deviceCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n);
  }

  /** "MacBook" -> "MacBook 2" when the name is taken, so the device list stays tellable apart. */
  uniqueName(name: string): string {
    const taken = new Set((this.db.prepare("SELECT name FROM devices").all() as Array<{ name: string }>).map((r) => r.name));
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) {
      const candidate = `${name.slice(0, 60)} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  createDevice(input: { name: string; kind: DeviceKind; platform?: string }): { device: Device; token: string } {
    const now = Date.now();
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const token = `hp_${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare(
        "INSERT INTO devices (id, name, kind, platform, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.kind, input.platform ?? null, hashToken(token), now, now);
    // The relay is set up now, however this device got in: the first-run code must not outlive that.
    this.dropSetupCodes();
    return { device: this.toDevice(this.getRow(id)!), token };
  }

  deviceByToken(token: string): Device | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(hashToken(token)) as
      | DeviceRow
      | undefined;
    return row ? this.toDevice(row) : null;
  }

  getDevice(id: string): Device | null {
    const row = this.getRow(id);
    return row ? this.toDevice(row) : null;
  }

  listDevices(): Device[] {
    const rows = this.db.prepare("SELECT * FROM devices ORDER BY kind, name").all() as unknown as DeviceRow[];
    return rows.map((r) => this.toDevice(r));
  }

  touch(id: string, platform?: string): void {
    if (platform) {
      this.db.prepare("UPDATE devices SET last_seen_at = ?, platform = ? WHERE id = ?").run(Date.now(), platform, id);
    } else {
      this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
    }
  }

  rename(id: string, name: string): void {
    this.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, id);
  }

  deleteDevice(id: string): boolean {
    const r = this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  private getRow(id: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
  }

  private toDevice(r: DeviceRow): Device {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as DeviceKind,
      platform: r.platform ?? undefined,
      online: false,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    };
  }
}
