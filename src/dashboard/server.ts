// src/dashboard/server.ts
//
// The loopback HTTP server `ms dashboard` (src/dashboard.ts) runs: one static
// page (src/dashboard/page.ts) over the JSON API from Task 1
// (src/dashboard/api.ts), bound to 127.0.0.1 ONLY — this is a local
// convenience, never a service meant to answer another machine — and alive
// for exactly as long as something keeps asking it something.
//
// "Alive only while open": every request, whichever route it hits, touches
// an idle timer; `waitUntilIdle()` resolves once `idleMs` has passed with no
// request. The page polls `/api/state` every 5 s, so an open tab is what
// keeps the idle timer from ever firing; closing the tab lets it fire within
// `idleMs`. Nothing here starts a second timer of its own — there is exactly
// one clock, and it is "time since the last request arrived".

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { handle, type ApiRequest } from "./api.ts";
import { renderDashboardPage } from "./page.ts";

/** Same order of magnitude as the manual verbs' own bounds (doctor.ts's
 *  REFRESH_TIMEOUT_MS, recover.ts's settle budgets) — `open` detaches its own
 *  child immediately, so this is only ever a guard against a broken `open`
 *  hanging the verb that is trying to print one line and exit. */
const OPEN_TIMEOUT_MS = 5_000;

/** A request body over this is refused with 413 before it is ever handed to
 *  `handle()` — the API's own bodies (a session id, an account name, two
 *  booleans) are a few hundred bytes at most, so 64 KB is generous headroom,
 *  not a working limit. */
const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_IDLE_MS = 30_000;

export type DashboardOptions = { port?: number; open?: boolean; idleMs?: number };
export type Dashboard = { url: string; close(): void; waitUntilIdle(): Promise<void> };

/**
 * Best-effort: a missing or broken `open` (not macOS, a stripped-down
 * container, PATH trouble) must never fail the server that is trying to tell
 * the human where it is — `spawnSync` reports failure on `result.error`
 * rather than throwing, but this still wraps the call, since the contract
 * here is "never let this step be the reason `ms dashboard` exits non-zero".
 */
function openInBrowser(url: string): void {
  try {
    spawnSync("open", [url], { stdio: "ignore", timeout: OPEN_TIMEOUT_MS });
  } catch {
    /* best-effort convenience only */
  }
}

/** `total` is checked as each chunk arrives, so a body that blows the limit
 *  is caught (and the connection torn down) without ever buffering the rest
 *  of it — an oversized body must not sit in memory while we wait for `end`
 *  to notice. The Promise settles the moment the limit is crossed, so the
 *  413 can be written back right away; the request is left to drain on its
 *  own (chunks past the limit are dropped, not buffered) rather than
 *  destroyed out from under the client — destroying the socket mid-stream
 *  races the 413 response itself and the client sees a reset connection
 *  instead of an answer. */
function readBody(req: IncomingMessage): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true;
          resolve("too-large");
        }
        return; // still draining — just not keeping any more of it
      }
      if (!settled) chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!settled) reject(e);
    });
  });
}

function sendJson(res: ServerResponse, status: number, json: unknown): void {
  const body = JSON.stringify(json);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/**
 * Everything under `/api/`: read the body (POST routes only — a GET body is
 * never read, matching `ApiRequest`'s optional `body`), parse it as JSON when
 * present, and hand the whole thing to `handle()` unchanged. A body that
 * fails to parse as JSON is passed through as `undefined` — the route's own
 * validator (src/dashboard/api.ts's `parse*Body`) then reports it as a
 * malformed body (400), the same way it reports a missing field: this layer
 * never invents a 400 of its own for bad JSON, it just gives `handle()`
 * nothing to work with.
 */
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? "GET";
  let body: unknown;
  if (method !== "GET" && method !== "HEAD") {
    const raw = await readBody(req);
    if (raw === "too-large") {
      sendJson(res, 413, { error: "request body too large (64 KB max)" });
      return;
    }
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = undefined;
      }
    }
  }
  const apiReq: ApiRequest = { method, path, body };
  const apiRes = await handle(apiReq);
  sendJson(res, apiRes.status, apiRes.json);
}

/**
 * Start the dashboard. Binds `127.0.0.1` explicitly (never `0.0.0.0`, never
 * the default "all interfaces") — port 0 asks the OS for any free loopback
 * port, which is what makes `startDashboard()` safe to call from parallel
 * tests. `open` (default true) runs `open <url>` once the server is up,
 * unless the caller passed `open: false` — the ONLY thing that suppresses it;
 * the CLI verb (src/dashboard.ts) maps `--no-open` onto exactly that.
 */
export async function startDashboard(opts: DashboardOptions = {}): Promise<Dashboard> {
  const { port = 0, open = true, idleMs = DEFAULT_IDLE_MS } = opts;

  let lastActivity = Date.now();
  const touch = (): void => {
    lastActivity = Date.now();
  };

  const server = createServer((req, res) => {
    touch();
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://dashboard.local");
        const pathName = url.pathname;
        if (req.method === "GET" && pathName === "/") {
          const html = renderDashboardPage();
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        if (pathName.startsWith("/api/")) {
          await handleApi(req, res, pathName);
          return;
        }
        sendJson(res, 404, { error: `no such route: ${req.method} ${pathName}` });
      } catch (e) {
        sendJson(res, 500, { error: (e as Error).message });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("dashboard: server did not bind a TCP address");
  }
  // Read back what actually got bound, rather than trusting the literal
  // passed to `listen()` above — a URL built from that literal would keep
  // reporting "127.0.0.1" even if a future edit changed the bind host, which
  // is exactly the mistake the "never 0.0.0.0" rule exists to catch. Refuse
  // to hand back a URL for anything else instead of just repeating it.
  if (address.address !== "127.0.0.1") {
    server.close();
    throw new Error(`dashboard: refused to report a URL for a non-loopback bind (${address.address})`);
  }
  const url = `http://127.0.0.1:${address.port}`;

  if (open) openInBrowser(url);

  function waitUntilIdle(): Promise<void> {
    return new Promise((resolve) => {
      const POLL_MS = 250;
      const check = (): void => {
        const remaining = idleMs - (Date.now() - lastActivity);
        if (remaining <= 0) {
          resolve();
          return;
        }
        setTimeout(check, Math.min(remaining, POLL_MS));
      };
      check();
    });
  }

  function close(): void {
    server.closeAllConnections?.();
    server.close();
  }

  return { url, close, waitUntilIdle };
}
