#!/usr/bin/env node
// `xiaoaixiaoai-relay`: run, inspect and update a relay installed by scripts/install-relay.sh.
// Settings come from the environment (relay.env), the same as for src/main.ts.
import { UPDATE_HELP, VERSION, updateCommand, versionCommand } from "@xiaoaixiaoai/update";

const BIN = "xiaoaixiaoai-relay";
const HELP = `${BIN} ${VERSION} — the 小爱小爱 relay

  start               Run the relay (settings from the environment, see deploy/relay.env.example).
  setup [--new]       Show the one-time code + QR for the first phone or computer (only while
                      the relay has no devices; reads POCKET_DB).
${UPDATE_HELP}
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      await import("./main.ts");
      return;
    case "setup":
      process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
      await import("./bootstrap.ts");
      return;
    case "version":
      return versionCommand(rest, { service: "relay", bin: BIN });
    case "update":
      return updateCommand(rest, { service: "relay", bin: BIN });
    case "selftest":
      // Used by `update` before switching to a new copy: loads the server and its dependencies.
      await import("./server.ts");
      console.log(VERSION);
      return;
    case "-V":
    case "--version":
      console.log(VERSION);
      return;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
