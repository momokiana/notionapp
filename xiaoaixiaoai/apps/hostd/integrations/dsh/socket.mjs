import { chmodSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

const MAX_CONNECTIONS = 8;
const MAX_BODY_BYTES = 32 * 1024;
const REQUEST_MS = 5_000;
const CONNECTION_MS = 7_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class HttpFault extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function validSocketPath(path) {
  // A real pathname only; reject abstract sockets and truncation of sun_path.
  return typeof path === "string" && path.startsWith("/") && path !== "/" && resolve(path) === path &&
    path.isWellFormed() && !/[\x00-\x1f\x7f]/.test(path) && Buffer.byteLength(path) <= 103;
}

function checkDirectory(path, uid) {
  // lstat every component, not just the final parent. Unrelated users must
  // not be able to substitute a writable ancestor (sticky /tmp is okay).
  const parent = dirname(path);
  for (let dir = parent; ; dir = dirname(dir)) {
    const entry = lstatSync(dir);
    if (!entry.isDirectory() || (entry.uid !== uid && entry.uid !== 0) ||
        ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0) ||
        (dir === parent && (entry.uid !== uid || (entry.mode & 0o7777) !== 0o700))) {
      throw new Error("Unsafe socket directory");
    }
    if (dir === "/") return;
  }
}

function protectSocket(path, uid) {
  const before = lstatSync(path);
  if (!before.isSocket() || before.uid !== uid) throw new Error("Unsafe socket");
  // Don't change the DSH process's umask. The 0700 parent protects the
  // socket during bind; HTTP requests are served only after this succeeds.
  chmodSync(path, 0o600);
  const after = lstatSync(path);
  if (!after.isSocket() || after.uid !== uid || (after.mode & 0o7777) !== 0o600 ||
      before.dev !== after.dev || before.ino !== after.ino) throw new Error("Unsafe socket");
}

export async function readJson(request, signal) {
  const type = request.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type) ||
      request.headers["content-encoding"] !== undefined ||
      (request.headers["transfer-encoding"] !== undefined && request.headers["transfer-encoding"].toLowerCase() !== "chunked")) {
    throw new HttpFault(415, "invalid_content_type");
  }
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) throw new HttpFault(413, "body_too_large");
  signal.throwIfAborted();
  const body = await new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    const finish = () => {
      remove();
      done(Buffer.concat(chunks, size));
    };
    const abort = () => {
      remove();
      fail(signal.reason);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      } else {
        remove();
        fail(new HttpFault(413, "body_too_large"));
      }
    };
    const remove = () => {
      request.pause();
      request.off("end", finish);
      request.off("data", data);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    request.once("end", finish);
    request.on("data", data);
  });
  signal.throwIfAborted();
  try {
    return JSON.parse(utf8.decode(body));
  } catch {
    throw new HttpFault(400, "invalid_json");
  }
}

function reply(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  });
  response.end(body);
}

export async function serveSocket(path, handle) {
  const uid = process.geteuid?.();
  const sockets = new Set();
  const active = new Set();
  let ready = false;
  let closing;
  const server = createServer({
    maxHeaderSize: 4096, headersTimeout: REQUEST_MS, requestTimeout: REQUEST_MS,
    connectionsCheckingInterval: 500, keepAliveTimeout: 1,
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 1;

  function close() {
    if (closing) return closing;
    ready = false;
    closing = new Promise((done) => server.close(() => done()));
    for (const work of active) work.abort();
    for (const socket of sockets) socket.destroy();
    return closing;
  }
  server.on("error", () => { if (ready) void close(); });
  server.on("connection", (socket) => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), CONNECTION_MS);
    timer.unref();
    socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  for (const event of ["checkContinue", "checkExpectation"]) {
    server.on(event, (_request, response) => reply(response, 417, { error: "expectation_not_supported" }));
  }
  server.on("request", (request, response) => {
    if (!ready || active.size >= MAX_CONNECTIONS) {
      reply(response, 503, { error: "unavailable" });
      return;
    }
    const work = new AbortController();
    active.add(work);
    const disconnect = () => { if (!response.writableFinished) work.abort(); };
    request.on("aborted", disconnect);
    request.on("error", disconnect);
    response.on("error", disconnect);
    response.once("close", disconnect);
    const timeout = setTimeout(() => {
      reply(response, 504, { error: "timeout" });
      work.abort();
    }, REQUEST_MS);
    timeout.unref();

    // Do not release a work slot merely because its caller timed out: a
    // service that ignores abort may still be running in the host process.
    void (async () => {
      try {
        const result = await handle(request, work.signal);
        if (!work.signal.aborted) reply(response, 200, result);
      } catch (error) {
        if (!work.signal.aborted) {
          if (error instanceof HttpFault) reply(response, error.status, { error: error.code });
          else reply(response, 503, { error: "unavailable" });
        }
      } finally {
        clearTimeout(timeout);
        active.delete(work);
      }
    })();
  });

  try {
    if (uid === undefined || !validSocketPath(path)) throw new Error("Invalid socket path");
    checkDirectory(path, uid);
    // Never unlink an occupied path, even if it is a seemingly stale socket.
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("Socket path occupied");
    await new Promise((done, fail) => {
      server.once("error", fail);
      server.listen({ path, backlog: MAX_CONNECTIONS }, () => {
        server.off("error", fail);
        try {
          protectSocket(path, uid);
          ready = true;
          done();
        } catch (error) { fail(error); }
      });
    });
    // Node removes the successfully bound Unix socket on close. No separate
    // unlink is attempted by the bridge, on startup, failure or teardown.
    return close;
  } catch {
    await close();
    throw new Error("DSH bridge cannot start: use an unused socket path in a private local directory.");
  }
}
