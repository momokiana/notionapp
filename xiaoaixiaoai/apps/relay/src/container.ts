// Entry point of the Docker image. Volumes that platforms mount at /data (Fly.io, Railway,
// Render, bind mounts) are often owned by root. Started as root, this hands the data folder to
// the unprivileged `node` user and switches to it before any relay code runs; started as any
// other user, it changes nothing. No arguments: run the relay. Arguments: the relay CLI.
import { chownSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const uid = Number(process.env.POCKET_UID || 1000);
const gid = Number(process.env.POCKET_GID || 1000);

function own(path: string): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink()) return;
  if (s.uid !== uid || s.gid !== gid) chownSync(path, uid, gid);
  if (s.isDirectory()) for (const name of readdirSync(path)) own(join(path, name));
}

if (process.getuid?.() === 0 && uid !== 0) {
  const data = dirname(process.env.POCKET_DB || "/data/relay.db");
  mkdirSync(data, { recursive: true });
  own(data);
  process.setgroups?.([gid]);
  process.setgid?.(gid);
  process.setuid?.(uid);
  process.env.HOME = "/home/node";
}

const args = process.argv.slice(2);
if (args.length) {
  process.argv = [process.argv[0]!, join(dirname(fileURLToPath(import.meta.url)), "cli.ts"), ...args];
  await import("./cli.ts");
} else {
  await import("./main.ts");
}
