// Stands in for an agent program in the Windows CI test (windows-agents/e2e.ts): says it is
// ready and in which folder, then echoes each line it is sent ("got: ...") and names the
// keys it gets ("got key: esc"), so the test can read the effect of everything it sends.
//
// Started as `claude` (FAKE_CLAUDE=1), it also keeps a transcript where Claude Code keeps
// one (~/.claude/projects/<folder>/<session>.jsonl): each line is a user message answered
// with "done: <line>", so Uniflo has a conversation for the phone to read.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const out = (s) => process.stdout.write(s);
out(`fake agent ready, in: ${basename(process.cwd())}\r\n`);
if (process.argv.length > 2) out(`args: ${process.argv.slice(2).join(" ")}\r\n`);
out("> ");

const session = randomUUID();
const folder = join(homedir(), ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
let parent = null;
function remember(text) {
  if (process.env.FAKE_CLAUDE !== "1") return;
  mkdirSync(folder, { recursive: true });
  const at = new Date().toISOString();
  const common = { sessionId: session, cwd: process.cwd(), version: "2.0.0", userType: "external", isSidechain: false, timestamp: at };
  const user = { ...common, type: "user", uuid: randomUUID(), parentUuid: parent, message: { role: "user", content: text } };
  const reply = {
    ...common,
    type: "assistant",
    uuid: randomUUID(),
    parentUuid: user.uuid,
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-fake",
      content: [{ type: "text", text: `done: ${text}` }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  parent = reply.uuid;
  appendFileSync(join(folder, `${session}.jsonl`), `${JSON.stringify(user)}\n${JSON.stringify(reply)}\n`);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let line = "";
process.stdin.on("data", (chunk) => {
  for (const ch of chunk.replace(/\x1b\[20[01]~/g, "")) {
    if (ch === "\r" || ch === "\n") {
      if (line) {
        out(`\r\ngot: ${line}\r\n> `);
        remember(line);
      }
      line = "";
    } else if (ch === "\x1b") out("\r\ngot key: esc\r\n> ");
    else if (ch === "\x03") out("\r\ngot key: ctrl+c\r\n> ");
    else if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
    else if (ch >= " ") {
      line += ch;
      out(ch);
    }
  }
});
