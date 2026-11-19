import { sgrOnly } from "./vt.ts";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { normalizeStatus, type Agent } from "@xiaoaixiaoai/protocol";
import { cleanTitle } from "./util.ts";

/** Subset of herdr's `AgentInfo` (src/api/schema/agents.rs). */
interface HerdrAgentInfo {
  terminal_id: string;
  name?: string | null;
  agent?: string | null;
  display_agent?: string | null;
  workspace_id?: string;
  tab_id?: string;
  pane_id: string;
  title?: string | null;
  terminal_title?: string | null;
  agent_status?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
}

/**
 * Bridges the herdr terminal UI server over its NDJSON socket API
 * (one request per connection). Polls `agent.list`; herdr's agent list is small.
 */
export class HerdrAdapter extends EventEmitter {
  agents: HerdrAgentInfo[] = [];
  private socketPath: string;
  private timer: NodeJS.Timeout | null = null;
  private last = "";

  constructor(socketPath = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock")) {
    super();
    this.socketPath = socketPath;
  }

  async available(): Promise<boolean> {
    if (!existsSync(this.socketPath)) return false;
    try {
      await this.call("ping", {}, 3000);
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const r = await this.call("agent.list", {});
      const agents = (r.agents ?? []) as HerdrAgentInfo[];
      const sig = JSON.stringify(agents.map((a) => [a.terminal_id, a.agent_status, a.title, a.cwd]));
      this.agents = agents;
      if (sig !== this.last) {
        this.last = sig;
        this.emit("change");
      }
    } catch {
      if (this.agents.length) {
        this.agents = [];
        this.last = "";
        this.emit("change");
      }
    }
  }

  call(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let buf = "";
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`herdr ${method} timed out`));
      }, timeoutMs);
      sock.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      sock.on("data", (d) => {
        buf += d.toString();
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(t);
        sock.end();
        try {
          const msg = JSON.parse(buf.slice(0, i));
          if (msg.error) reject(new Error(msg.error.message ?? msg.error.code));
          else resolve(msg.result);
        } catch (e) {
          reject(e);
        }
      });
      sock.write(`${JSON.stringify({ id: `hp_${Date.now()}`, method, params })}\n`);
    });
  }

  static toAgent(a: HerdrAgentInfo, deviceId: string): Agent {
    const harness = a.display_agent || a.agent || "agent";
    return {
      key: `${deviceId}/herdr:${a.terminal_id}`,
      deviceId,
      source: "herdr",
      localId: a.terminal_id,
      harness,
      title: cleanTitle(a.title ?? a.terminal_title) ?? a.name ?? undefined,
      where: [a.workspace_id, a.tab_id].filter(Boolean).join(" / ") || undefined,
      cwd: a.foreground_cwd ?? a.cwd ?? undefined,
      status: normalizeStatus(a.agent_status),
      isShell: false,
      updatedAt: Date.now(),
    };
  }

  find(localId: string): HerdrAgentInfo | undefined {
    return this.agents.find((a) => a.terminal_id === localId);
  }

  async read(localId: string, lines = 200): Promise<{ text: string; ansi?: string; complete?: boolean }> {
    const r = await this.call("agent.read", { target: localId, source: "recent", lines, format: "text", strip_ansi: true });
    let ansi: string | undefined;
    try {
      const c = await this.call("agent.read", { target: localId, source: "recent", lines, format: "ansi", strip_ansi: false });
      if (typeof c.text === "string") ansi = sgrOnly(c.text).replace(/\n+$/, "");
    } catch {
      /* older herdr: plain text only */
    }
    return { text: r.text ?? "", ansi, complete: !r.truncated };
  }

  async send(localId: string, text: string, enter = true): Promise<void> {
    const a = this.find(localId);
    if (!a) throw new Error("agent not found");
    await this.call("pane.send_input", { pane_id: a.pane_id, text, keys: enter ? ["enter"] : [] });
  }

  async keys(localId: string, keys: string[]): Promise<void> {
    const a = this.find(localId);
    if (!a) throw new Error("agent not found");
    // herdr parses lowercase names and chords: enter, esc, up, ctrl+c, shift+tab.
    await this.call("pane.send_keys", { pane_id: a.pane_id, keys: keys.map((k) => k.toLowerCase()) });
  }
}
