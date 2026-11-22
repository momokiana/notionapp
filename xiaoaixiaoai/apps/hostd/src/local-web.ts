import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest, type Agent as HttpsAgent } from "node:https";
import type { Duplex } from "node:stream";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_LOCAL_WEB_PORT = 18546;

export interface LocalWebOptions {
  relayServer: string;
  webDir?: string;
  port?: number;
  host?: string;
  relayAgent?: HttpsAgent;
  log?: (msg: string) => void;
}

export interface LocalWebBridge {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: http: https:; frame-ancestors 'none'";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function sendJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: { code, message } }));
}

function defaultWebDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

function statRegularFile(path: string) {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function safeCloseCode(code: number): number | undefined {
  if (!Number.isInteger(code) || code < 1000 || code >= 5000) return undefined;
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return 1000;
  return code;
}

function isRelayProxyPath(pathname: string): boolean {
  return (
    pathname === "/v1" ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/j/")
  );
}

/** Resolve desired local web port from `XIAOAIXIAOAI_WEB_PORT`, returning null when explicitly disabled. */
export function resolveLocalWebPort(raw = process.env.XIAOAIXIAOAI_WEB_PORT): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LOCAL_WEB_PORT;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "none") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_LOCAL_WEB_PORT;
  return n;
}

/**
 * Serves the prebuilt Desktop Web UI on loopback HTTP (`127.0.0.1`) and bridges `/v1/*` HTTP
 * and WebSocket traffic directly to `relayServer`, bypassing broken or slow browser proxy chains.
 */
export async function startLocalWebBridge(opts: LocalWebOptions): Promise<LocalWebBridge> {
  const relayUrl = new URL(opts.relayServer.replace(/\/+$/, ""));
  const relayBasePath = relayUrl.pathname.replace(/\/+$/, "");
  const isHttps = relayUrl.protocol === "https:";
  const webRoot = resolve(opts.webDir ?? defaultWebDir());
  const log = opts.log ?? (() => {});

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const sockets = new Set<WebSocket>();

  const upstreamPath = (reqUrl: URL) => `${relayBasePath}${reqUrl.pathname}${reqUrl.search}`;

  const serveApp = (res: ServerResponse, rawSubpath: string, headOnly: boolean): void => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSubpath);
    } catch {
      sendJsonError(res, 400, "bad_request", "invalid path");
      return;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) {
      sendJsonError(res, 400, "bad_request", "invalid path");
      return;
    }
    const cleanRel = decoded.replace(/^\/+/, "") || "index.html";
    let targetPath = resolve(webRoot, cleanRel);
    const insideRoot = (p: string) => p === webRoot || p.startsWith(`${webRoot}/`) || p.startsWith(`${webRoot}\\`);
    if (!insideRoot(targetPath)) {
      sendJsonError(res, 403, "forbidden", "forbidden");
      return;
    }
    let st = statRegularFile(targetPath);
    if (!st && !extname(cleanRel)) {
      targetPath = resolve(webRoot, "index.html");
      st = statRegularFile(targetPath);
    }
    if (!st) {
      if (cleanRel === "index.html") {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(headOnly ? undefined : "<!doctype html><meta charset='utf-8'><title>小爱小爱桌面端</title><body><h3>未找到 apps/web/dist 静态资源</h3></body>");
      } else {
        sendJsonError(res, 404, "not_found", "asset not found");
      }
      return;
    }
    const ext = extname(targetPath).toLowerCase();
    const isHashed = cleanRel.startsWith("assets/");
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": String(st.size),
      "Cache-Control": isHashed ? "public, max-age=31536000, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": CSP,
    });
    if (headOnly) {
      res.end();
      return;
    }
    res.end(readFileSync(targetPath));
  };

  const proxyHttp = (req: IncomingMessage, res: ServerResponse, reqUrl: URL): void => {
    const headers: Record<string, string | string[]> = { host: relayUrl.host };
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const upReq = requestFn(
      {
        protocol: relayUrl.protocol,
        hostname: relayUrl.hostname,
        port: relayUrl.port || (isHttps ? 443 : 80),
        method: req.method ?? "GET",
        path: upstreamPath(reqUrl),
        headers,
        agent: isHttps ? opts.relayAgent : undefined,
      },
      (upRes) => {
        const resHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || k.toLowerCase() === "transfer-encoding") continue;
          resHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode ?? 502, resHeaders);
        upRes.pipe(res);
      },
    );
    upReq.setTimeout(120_000, () => {
      upReq.destroy(new Error("upstream request timeout"));
    });
    upReq.on("error", (err) => {
      log(`[local-web] proxy error ${reqUrl.pathname}: ${err.message}`);
      sendJsonError(res, 502, "bad_gateway", `直连中转站失败：${err.message}`);
    });
    res.on("close", () => {
      if (!upReq.destroyed) upReq.destroy();
    });
    req.pipe(upReq);
  };

  const server: Server = createHttpServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    if ((method === "GET" || method === "HEAD") && (reqUrl.pathname === "/" || reqUrl.pathname === "/app")) {
      res.writeHead(302, { Location: "/app/", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if ((method === "GET" || method === "HEAD") && reqUrl.pathname.startsWith("/app/")) {
      serveApp(res, reqUrl.pathname.slice(5), method === "HEAD");
      return;
    }
    if (isRelayProxyPath(reqUrl.pathname)) {
      proxyHttp(req, res, reqUrl);
      return;
    }
    sendJsonError(res, 404, "not_found", "not found");
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!reqUrl.pathname.startsWith("/v1/")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      sockets.add(client);
      const wsProto = isHttps ? "wss:" : "ws:";
      const portPart = relayUrl.port ? `:${relayUrl.port}` : "";
      const targetUrl = `${wsProto}//${relayUrl.hostname}${portPart}${upstreamPath(reqUrl)}`;
      const upstream = new WebSocket(targetUrl, {
        perMessageDeflate: false,
        ...(isHttps && opts.relayAgent ? { agent: opts.relayAgent } : {}),
      });
      sockets.add(upstream);

      const pending: Array<{ data: Buffer | string | ArrayBuffer | Buffer[]; isBinary: boolean }> = [];
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        sockets.delete(client);
        sockets.delete(upstream);
        pending.length = 0;
      };

      client.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        } else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 128) {
          pending.push({ data, isBinary });
        }
      });

      upstream.on("open", () => {
        for (const item of pending) {
          if (upstream.readyState !== WebSocket.OPEN) break;
          upstream.send(item.data, { binary: item.isBinary });
        }
        pending.length = 0;
      });

      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: isBinary });
        }
      });

      client.on("close", (code, reason) => {
        cleanup();
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          try {
            upstream.close(safeCloseCode(code), reason?.toString("utf8").slice(0, 120));
          } catch {
            upstream.terminate();
          }
        }
      });

      upstream.on("close", (code, reason) => {
        cleanup();
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          try {
            client.close(safeCloseCode(code), reason?.toString("utf8").slice(0, 120));
          } catch {
            client.terminate();
          }
        }
      });

      client.on("error", () => {
        cleanup();
        upstream.terminate();
      });

      upstream.on("error", (err) => {
        log(`[local-web] ws upstream error ${reqUrl.pathname}: ${err.message}`);
        cleanup();
        try {
          client.close(1011, "upstream error");
        } catch {
          client.terminate();
        }
      });
    });
  });

  const listenHost = opts.host ?? "127.0.0.1";
  const listenPort = opts.port ?? DEFAULT_LOCAL_WEB_PORT;
  await new Promise<void>((resolveReady, rejectReady) => {
    const onErr = (err: Error) => rejectReady(err);
    server.once("error", onErr);
    server.listen(listenPort, listenHost, () => {
      server.removeListener("error", onErr);
      resolveReady();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : listenPort;
  const url = `http://${listenHost}:${actualPort}/app/`;
  if (!existsSync(webRoot)) {
    log(`[local-web] webRoot missing (${webRoot}), /v1 proxy active at ${url}`);
  } else {
    log(`[local-web] desktop console listening at ${url} -> ${opts.relayServer}`);
  }

  return {
    url,
    port: actualPort,
    async close() {
      for (const s of [...sockets]) {
        try {
          s.terminate();
        } catch {}
      }
      sockets.clear();
      await new Promise<void>((resClose) => wss.close(() => resClose()));
      await new Promise<void>((resClose) => server.close(() => resClose()));
    },
  };
}
