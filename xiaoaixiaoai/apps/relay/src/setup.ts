/**
 * First run without the admin token: while the relay has no devices it keeps a one-time
 * setup code for the first phone or computer. Shown at startup and by `src/bootstrap.ts`.
 */
import QRCode from "qrcode";
import { pairLink } from "@xiaoaixiaoai/protocol";
import type { Store } from "./store.ts";

export const SETUP_TTL_SEC = 30 * 60;
/** A code with less time left than this is replaced instead of shown again. */
const SETUP_MIN_LEFT_MS = 5 * 60_000;

export interface SetupInfo {
  code: string;
  expiresAt: number;
  /** The QR link; absent when the relay does not know its public address. */
  link?: string;
  /** What to run on a computer to make it the first device. */
  hostCommand: string;
}

/** Null once any device is registered. `fresh` replaces a code that is still valid. */
export function issueSetupCode(store: Store, publicUrl: string | undefined, fresh = false): SetupInfo | null {
  const row = store.setupCode({ ttlSec: SETUP_TTL_SEC, minLeftMs: SETUP_MIN_LEFT_MS, fresh });
  if (!row) return null;
  const server = publicUrl?.trim().replace(/\/+$/, "");
  const link = server ? pairLink(server, row.code) : undefined;
  return {
    code: row.code,
    expiresAt: row.expiresAt,
    link,
    hostCommand: link ? `xiaoaixiaoai up ${link}` : `xiaoaixiaoai up --server <this relay's address> --code ${row.code}`,
  };
}

/**
 * Human block with a terminal QR. The first line is stable for installers:
 * `[relay] setup code=<CODE>[ link=<url>] expires=<ISO time>`.
 */
export async function describeSetup(info: SetupInfo, prefix = "[relay] "): Promise<string> {
  const mins = Math.max(1, Math.round((info.expiresAt - Date.now()) / 60_000));
  const lines = [
    `${prefix}setup code=${info.code}${info.link ? ` link=${info.link}` : ""} expires=${new Date(info.expiresAt).toISOString()}`,
    `${prefix}No devices yet. This one-time code lets the first phone or computer in (valid ${mins} min).`,
  ];
  if (info.link) {
    const qr = await QRCode.toString(info.link, { type: "terminal", small: true, errorCorrectionLevel: "L" });
    lines.push(`${prefix}Phone: scan this with the camera or the 小爱小爱 app:`, "", qr.trimEnd(), "", `${prefix}  ${info.link}`);
  } else {
    lines.push(`${prefix}Phone: in the app, enter this relay's address and the code. Set POCKET_PUBLIC_URL to get a QR code here.`);
  }
  lines.push(`${prefix}Computer: ${info.hostCommand}`);
  return lines.join("\n");
}
