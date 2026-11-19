import { Agent } from "node:https";

/** Opt-in on this computer only. Do not use a proxy for a plaintext relay. */
export function localRelayProxy(value: string | undefined, server: string): Agent | undefined {
  if (value === undefined) return undefined;
  const allow = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(value);
  const port = Number(allow?.[1]);
  if (allow?.[0] !== value || port > 65_535) throw new Error("--relay-proxy requires http://127.0.0.1:<port>.");
  const relay = new URL(server);
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash) {
    throw new Error("--relay-proxy requires the registered HTTPS relay without URL credentials, query, or fragment.");
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!major || major < 24 || (major === 24 && (minor ?? 0) < 5)) throw new Error("--relay-proxy requires Node 24.5 or newer.");
  // An implicit env proxy is not enough: ws supplies its own createConnection.
  // CONNECT carries the original TLS stream, and must never disable certificate checks.
  return new Agent({ proxyEnv: { HTTPS_PROXY: value, NO_PROXY: "" }, rejectUnauthorized: true });
}
