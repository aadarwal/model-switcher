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
import { DEFAULT_CALENDAR_DAYS, toIcs, upcomingResets } from "../calendar.ts";

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

/** Review round 1, finding 4 (supersedes the brief's "within 30 s"): a
 *  background/hidden tab's own JS timers are throttled by the browser
 *  starting around 60 s, so a 30 s idle default could let the dashboard exit
 *  under a human's nose while the tab is still open, just backgrounded. 90 s
 *  gives the 5 s poll two full throttled cycles of slack; the page's own
 *  `visibilitychange` handler (src/dashboard/page.ts) re-polls immediately
 *  the moment the tab is foregrounded again, so a human who switches back
 *  sees a fresh read well before this would ever fire. */
export const DEFAULT_IDLE_MS = 90_000;

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

/**
 * Every hostname a browser can mean by "this machine" — the bind address we
 * actually listen on (`127.0.0.1`), the name most humans type instead
 * (`localhost`), and its IPv6 spelling. `URL#hostname` keeps an IPv6 host's
 * bracket syntax (`new URL("http://[::1]:1").hostname === "[::1]"`, not
 * `"::1"`), so the bracketed form is the one this set carries. A loopback
 * bind is not ONE origin (fix-R, fix-C-report.md item 4's flagged
 * deviation): a human who reaches the dashboard at `http://localhost:<port>`
 * instead of the `http://127.0.0.1:<port>` the tool prints and opens was
 * refused on every action, though a page served from `localhost:<ourport>`
 * IS our page.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whole-branch review, area C, finding C4: why a loopback bind is not, by
 * itself, an access control.
 *
 * A cross-origin `fetch(url, { method: "POST", body })` with the default
 * `text/plain` content type is a CORS *simple* request: the browser sends it
 * with no preflight, and the missing `Access-Control-Allow-Origin` on the
 * answer only stops the ATTACKER from reading the reply — the verb has
 * already run. So any page the human had open could stop a session or move a
 * fleet for as long as the dashboard was up, and the ephemeral port is
 * scannable from JS in a loop.
 *
 * Two rules, and each one alone would be enough for the common case:
 *
 *   * `application/json` is NOT a simple content type, so a cross-origin POST
 *     carrying it must preflight with `OPTIONS` — which this server answers
 *     with a plain 404 and no CORS headers, so the real request is never
 *     sent. A POST that arrives without it is refused 415 before the body is
 *     even parsed.
 *   * An `Origin` header that is present and does not name THIS SERVER —
 *     scheme `http`, a loopback hostname (`LOOPBACK_HOSTNAMES` above), and
 *     the exact port we bound — is somebody else's page, and `Sec-Fetch-Site`
 *     saying so is the same answer from the other direction. Browsers attach
 *     both to a POST themselves, and neither can be set by the page's own
 *     JavaScript. The PORT is still what makes an origin ours: any loopback
 *     hostname at a DIFFERENT port is exactly the scan this guard exists to
 *     refuse.
 *
 * GET is deliberately untouched: the page's own poll must not be made to
 * carry headers a plain browser navigation would not, and no route here ever
 * sends a CORS header, so a cross-origin READ still cannot see the answer.
 */
function isSelfOrigin(origin: string, selfPort: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return u.protocol === "http:" && u.port === selfPort && LOOPBACK_HOSTNAMES.has(u.hostname);
}

function refuseUnsafePost(req: IncomingMessage, selfPort: string): { status: number; error: string } | null {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return null;

  // `none` is a user's own navigation (a typed URL, a bookmark); `same-origin`
  // is the page this server served. Anything else — `cross-site`, and
  // `same-site`, which loopback has no honest version of — is another site.
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return { status: 403, error: `refused: a ${site} request` };
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && !isSelfOrigin(origin, selfPort)) {
    return { status: 403, error: "refused: this request came from another origin" };
  }

  // The media type only; a browser may append `; charset=utf-8`.
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { status: 415, error: "refused: POST requires content-type: application/json" };
  }
  return null;
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
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, selfPort: string): Promise<void> {
  const method = req.method ?? "GET";
  const unsafe = refuseUnsafePost(req, selfPort);
  if (unsafe) {
    // Drain rather than destroy: the same reasoning as the 413 above — a
    // socket torn down mid-request races the answer, and the client sees a
    // reset connection instead of the refusal it should read.
    req.resume();
    sendJson(res, unsafe.status, { error: unsafe.error });
    return;
  }
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
  // Review round 1, finding 3: `touch()` at arrival alone is not enough — a
  // slow request (a slow client trickling its body, a slow `handle()` call)
  // can outlive a short `idleMs`, and `waitUntilIdle()` would resolve while
  // that request is still being answered. `close()` then tears the socket
  // down mid-response, and the browser never learns whether its own rotate/
  // switch/stop actually happened. `inFlight` makes the idle clock refuse to
  // fire at all while any request is still open, on top of `touch()` also
  // running again when it finishes (so the idle window starts counting from
  // the response, not the request).
  let inFlight = 0;
  const touch = (): void => {
    lastActivity = Date.now();
  };
  // Filled in below, the moment the OS tells us which port we got — nothing
  // can reach `handleApi` before `listen()` resolves, so there is no window in
  // which a POST is judged against an empty port. It starts as a string no
  // `URL#port` can equal rather than "": an origin with no explicit port
  // parses to "" (the scheme's default), and a guard whose default matched
  // THAT would be the wrong kind of default.
  let selfPort = "\u0000unbound";

  const server = createServer((req, res) => {
    touch();
    inFlight++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      touch();
    };
    // Both fire for a normal completed response; `close` alone fires if the
    // client (or we) abandon the connection early. Either way the request is
    // no longer in flight — `released` makes the decrement happen exactly
    // once regardless of which combination fires.
    res.on("finish", release);
    res.on("close", release);

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
        if (req.method === "GET" && pathName === "/calendar.ics") {
          // The one non-JSON, non-HTML answer: a calendar file. GET and read-only,
          // like the page itself. A calendar app on this machine can subscribe to
          // it while the dashboard is up; Google Calendar cannot (it fetches feeds
          // from Google's servers, and this listens on 127.0.0.1 only) -- for
          // Google, the page's per-event links or an import of this file.
          const now = Date.now();
          const ics = toIcs(await upcomingResets(DEFAULT_CALENDAR_DAYS, now), now);
          res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="model-switcher-resets.ics"', "cache-control": "no-store" });
          res.end(ics);
          return;
        }
        if (pathName.startsWith("/api/")) {
          await handleApi(req, res, pathName, selfPort);
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
  // The PORT alone — `isSelfOrigin` above accepts any loopback hostname, so
  // this is the one part of the bound address that still has to match
  // exactly (`URL#port`'s own string form, e.g. "52288", never "0").
  selfPort = String(address.port);

  if (open) openInBrowser(url);

  function waitUntilIdle(): Promise<void> {
    return new Promise((resolve) => {
      const POLL_MS = 250;
      const check = (): void => {
        if (inFlight > 0) {
          // A request is still open; the idle clock does not even start
          // counting down until it finishes (release() calls touch() again).
          setTimeout(check, POLL_MS);
          return;
        }
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
