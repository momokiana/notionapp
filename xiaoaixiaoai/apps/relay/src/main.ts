import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Relay } from "./server.ts";
import { describeSetup } from "./setup.ts";
import { loadModelSetup } from "./config.ts";
import { setTimeZone } from "./assistant/timezone.ts";

const env = process.env;
const port = Number(env.POCKET_PORT ?? 7420);
const host = env.POCKET_HOST ?? "0.0.0.0";
const dbPath = resolve(env.POCKET_DB ?? "./data/relay.db");
mkdirSync(dirname(dbPath), { recursive: true });

// Optional: without it the first device uses the one-time setup code printed at startup.
if (env.POCKET_ADMIN_TOKEN && env.POCKET_ADMIN_TOKEN.length < 24) {
  console.error("[relay] POCKET_ADMIN_TOKEN must be at least 24 characters.");
  process.exit(1);
}

// Text model and voice: environment, plus the optional POCKET_CONFIG file (docs/config.md).
const models = loadModelSetup(env);
for (const w of models.warnings) console.warn(`[relay] ${w}`);
if (models.errors.length) {
  for (const e of models.errors) console.error(`[relay] ${e}`);
  process.exit(1);
}
// Times the assistant says and reminders it takes are in this zone (POCKET_TIMEZONE, default Asia/Shanghai).
setTimeZone(models.timeZone);

const relay = new Relay({
  dbPath,
  adminToken: env.POCKET_ADMIN_TOKEN,
  publicUrl: env.POCKET_PUBLIC_URL,
  trustProxy: env.POCKET_TRUST_PROXY === "1",
  // Text assistant: models tried in order, each at its provider.
  assistant: models.assistant ?? { targets: [], ...models.assistantProfile },
  // Whether the assistant asks before acting (typed chats only; calls never wait). The app's Settings can change it.
  assistantConfirm: env.POCKET_ASSISTANT_CONFIRM === "always" ? "always" : "never",
  // Live voice; the key stays here and never reaches the phone.
  live: models.live,
});
console.log(`[relay] assistant: ${models.summary.assistant.join(", ") || "off"}  voice: ${models.summary.voice ?? "off"}`);

const actual = await relay.listen(port, host);
console.log(`[relay] listening on http://${host}:${actual}  db=${dbPath}`);
// No devices yet: print the one-time code for the first one (also: node src/bootstrap.ts).
const setup = relay.setupCode();
if (setup) console.log(await describeSetup(setup));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await relay.close();
    process.exit(0);
  });
}
