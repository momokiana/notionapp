import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { makeLlm, type LlmTarget, type Msg, type ToolDef } from "../src/assistant/llm.ts";

/** One local server plays every upstream; the path says which. */
let server: Server;
let base: string;
const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: any }> = [];
let handler: (path: string, body: any, res: ServerResponse) => void = (_p, _b, res) => res.writeHead(404).end();

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      handler(req.url ?? "", body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function stream(res: ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}

const TOOLS: ToolDef[] = [{ name: "list_agents", description: "列出 agent", input_schema: { type: "object", properties: { device: { type: "string" } } } }];

test("OpenAI Chat Completions: a streamed tool call comes back as tool_use, its result goes up as a tool message", async () => {
  seen.length = 0;
  const target: LlmTarget = { provider: "deepseek", protocol: "openai", baseUrl: `${base}/oa/v1/`, apiKey: "k-openai-test", model: "m1" };
  const llm = makeLlm({ targets: [target] });

  // Round 1: the call's arguments arrive in pieces.
  handler = (_p, _b, res) =>
    stream(res, [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list_agents", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"dev' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ice":"Mac"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  const messages: Msg[] = [{ role: "user", content: "谁在等我" }];
  const r1 = await llm({ system: "系统提示", messages, tools: TOOLS, maxTokens: 300 });
  assert.deepEqual(r1.content, [{ type: "tool_use", id: "call_1", name: "list_agents", input: { device: "Mac" } }]);
  assert.equal(r1.stopReason, "tool_use");
  const up1 = seen[0]!;
  assert.equal(up1.path, "/oa/v1/chat/completions");
  assert.equal(up1.headers.authorization, "Bearer k-openai-test");
  assert.equal(up1.headers["x-api-key"], undefined);
  assert.equal(up1.body.stream, true);
  assert.equal(up1.body.max_tokens, 300);
  assert.deepEqual(up1.body.messages, [
    { role: "system", content: "系统提示" },
    { role: "user", content: "谁在等我" },
  ]);
  assert.deepEqual(up1.body.tools, [{ type: "function", function: { name: "list_agents", description: "列出 agent", parameters: TOOLS[0]!.input_schema } }]);

  // Round 2: the history the assistant builds (Anthropic-shaped) is translated for this protocol.
  messages.push({ role: "assistant", content: r1.content });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Mac：2 个在等" }, { type: "text", text: "这是最后一次查看" }] });
  handler = (_p, _b, res) =>
    stream(res, [
      { choices: [{ index: 0, delta: { content: "两个" } }] },
      { choices: [{ index: 0, delta: { content: "在等你" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { total_tokens: 9 } },
    ]);
  const pieces: string[] = [];
  const r2 = await llm({ system: "系统提示", messages, tools: TOOLS, onText: (d) => pieces.push(d) });
  assert.deepEqual(r2.content, [{ type: "text", text: "两个在等你" }]);
  assert.equal(r2.stopReason, "end_turn");
  assert.deepEqual(pieces, ["两个", "在等你"]);
  assert.deepEqual(seen[1]!.body.messages.slice(2), [
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list_agents", arguments: '{"device":"Mac"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "Mac：2 个在等" },
    { role: "user", content: "这是最后一次查看" },
  ]);
});

test("Anthropic Messages: text and tool_use blocks, key header, version and extra headers", async () => {
  seen.length = 0;
  handler = (_p, _b, res) =>
    stream(res, [
      { type: "message_start", message: { id: "m" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我看看" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "list_agents" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"device":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Mac"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
  const llm = makeLlm({ targets: [{ provider: "custom", protocol: "anthropic", baseUrl: `${base}/gw`, apiKey: "k-anthropic-test", model: "a1", headers: { "user-agent": "ua-test" } }] });
  const r = await llm({ system: "s", messages: [{ role: "user", content: "hi" }], tools: TOOLS });
  assert.deepEqual(r.content, [
    { type: "text", text: "我看看" },
    { type: "tool_use", id: "toolu_1", name: "list_agents", input: { device: "Mac" } },
  ]);
  const up = seen[0]!;
  assert.equal(up.path, "/gw/v1/messages");
  assert.equal(up.headers["x-api-key"], "k-anthropic-test");
  assert.equal(up.headers.authorization, undefined);
  assert.equal(up.headers["anthropic-version"], "2023-06-01");
  assert.equal(up.headers["user-agent"], "ua-test");
  assert.equal(up.body.system, "s");
  assert.equal(up.body.max_tokens, 1200);
});

test("fallback: a failing provider hands over to the next one, across protocols; keys never reach the log", async () => {
  seen.length = 0;
  handler = (path, _b, res) => {
    if (path.startsWith("/an/")) res.writeHead(529, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "overloaded, key k-anthropic-secret" } }));
    else stream(res, [{ choices: [{ index: 0, delta: { content: "好" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
  };
  const logs: string[] = [];
  const llm = makeLlm({
    targets: [
      { provider: "anthropic", protocol: "anthropic", baseUrl: `${base}/an`, apiKey: "k-anthropic-secret", model: "a1" },
      { provider: "openai", protocol: "openai", baseUrl: `${base}/oa2/v1`, apiKey: "k-openai-2", model: "o1", maxTokensField: "max_completion_tokens", extraBody: { reasoning_effort: "low" } },
    ],
    log: (m) => logs.push(m),
  });
  const r = await llm({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 50 });
  assert.deepEqual(r.content, [{ type: "text", text: "好" }]);
  assert.equal(r.model, "o1");
  assert.deepEqual(
    seen.map((s) => s.path),
    ["/an/v1/messages", "/oa2/v1/chat/completions"],
  );
  assert.equal(seen[1]!.body.max_completion_tokens, 50);
  assert.equal(seen[1]!.body.max_tokens, undefined);
  assert.equal(seen[1]!.body.reasoning_effort, "low");
  assert.equal(seen[1]!.body.tools, undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^anthropic:a1 failed after \d+ms: anthropic:a1: HTTP 529/);
  assert.doesNotMatch(logs.join("\n"), /k-anthropic-secret/);
});

test("fallback: a provider that stays silent past the first-token limit is skipped; all failing throws the last error", async () => {
  seen.length = 0;
  handler = (path, _b, res) => {
    if (path.startsWith("/slow/")) res.writeHead(200, { "content-type": "text/event-stream" }).write(": still thinking\n\n");
    else if (path.startsWith("/empty/")) stream(res, [{ choices: [{ index: 0, delta: { role: "assistant" } }] }]);
    else stream(res, [{ choices: [{ index: 0, delta: { content: "到了" } }] }]);
  };
  const t = (provider: string, path: string): LlmTarget => ({ provider, protocol: "openai", baseUrl: `${base}${path}`, apiKey: "k", model: "m" });
  const ok = await makeLlm({ targets: [t("slow", "/slow"), t("fast", "/fast")], firstByteMs: 150 })({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.deepEqual(ok.content, [{ type: "text", text: "到了" }]);
  await assert.rejects(makeLlm({ targets: [t("slow", "/slow"), t("empty", "/empty")], firstByteMs: 150 })({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] }), { message: "empty:m: empty answer" });
});
