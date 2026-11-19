/**
 * Shows the first-run setup code of a relay that has no devices yet.
 * Reads the relay's database directly, so it only works where the database is.
 *
 *   node apps/relay/src/bootstrap.ts [--json] [--new] [--server <public url>]
 *
 * Env: POCKET_DB (default ./data/relay.db), POCKET_PUBLIC_URL.
 * Exit 0 with the code; exit 3 when the relay already has devices.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "./store.ts";
import { describeSetup, issueSetupCode } from "./setup.ts";

const { values } = parseArgs({
  options: { json: { type: "boolean", default: false }, new: { type: "boolean", default: false }, server: { type: "string" } },
});
const dbPath = resolve(process.env.POCKET_DB ?? "./data/relay.db");
if (!existsSync(dbPath)) {
  console.error(`no relay database at ${dbPath}. Start the relay once, or set POCKET_DB.`);
  process.exit(1);
}

const store = new Store(dbPath);
try {
  const info = issueSetupCode(store, values.server ?? process.env.POCKET_PUBLIC_URL, values.new);
  if (!info) {
    const devices = store.deviceCount();
    if (values.json) console.log(JSON.stringify({ setUp: true, devices }));
    else console.log(`This relay is already set up (${devices} devices). Invite more from a connected device: App → 设备 → 邀请设备, or \`xiaoaixiaoai pair\`.`);
    process.exitCode = 3;
  } else if (values.json) {
    console.log(JSON.stringify(info));
  } else {
    console.log(await describeSetup(info, ""));
  }
} finally {
  store.close();
}
