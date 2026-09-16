#!/usr/bin/env node
// scripts/codex-wall-mock.mjs
//
// A local stand-in for OpenAI's ChatGPT backend, for ONE purpose: to make a
// real `codex` binary hit a real usage wall, on demand, without spending a
// real subscription. Everything else in the drill stays real — the account,
// its `auth.json`, the tmux pane, `ms`'s hooks, the rollout watcher, the
// rotation. Only the two HTTP endpoints that decide "you are out of quota"
// are ours.
//
// Zero dependencies, `node:http` and nothing else on the serving path. It
// binds 127.0.0.1 only; there is no code here that can reach the network.
//
// ---------------------------------------------------------------------------
// WHAT THE CODEX SOURCE SAYS (verified against openai/codex `rust-v0.154.0`,
// commit 6b9826e; paths below are relative to that checkout's `codex-rs/`)
// ---------------------------------------------------------------------------
//
// THE WALL. `codex-api/src/api_bridge.rs:132-165` is the only branch that
// produces one. An HTTP 429 whose body parses as
//
//     { "error": { "type": "usage_limit_reached", ... } }
//
// becomes `CodexErr::UsageLimitReached`; `plan_type` and `resets_at` inside
// that object are both optional and only change the rendered sentence
// (`api_bridge.rs:259-270` is the whole struct — unknown fields are ignored).
// `resets_at` is UNIX SECONDS, not a duration. Anything else under a 429 —
// another `type`, a different shape, unparseable bytes — falls through to
// `CodexErr::RetryLimit` at `:165`, which is a DIFFERENT error
// (`response_too_many_failed_attempts`, rendered "exceeded retry limit, last
// status: 429 Too Many Requests") and must never be mistaken for a wall. That
// distinction is why this file can also serve the non-wall body on purpose:
// see `--generic-429`.
//
// ONE ROUND TRIP. There is no retry to wait out. 429 is excluded from the
// transport retry set (`model-provider-info/src/lib.rs:313-319`),
// `UsageLimitReached` is classified non-retryable
// (`protocol/src/error.rs:370-392`), and the turn loop returns before the
// retry machinery (`core/src/session/turn.rs:1489-1496`). The first POST that
// gets the 429 is the wall.
//
// WHERE THE POST GOES. `{base_url}/responses`
// (`codex-api/src/endpoint/responses.rs:42` + `codex-api/src/provider.rs:52`).
// `base_url` comes either from a custom provider's own `base_url` or, for the
// built-in `openai` provider, from the `openai_base_url` config key
// (`model-provider-info/src/lib.rs:293-312`). Neither is validated: no scheme
// check, no host allowlist. So this server answers any path whose last
// segment is `responses`, which covers both routes below.
//
// THE WEBSOCKET DETOUR. The built-in `openai` provider sets
// `supports_websockets: true` (`model-provider-info/src/lib.rs:419`) and the
// client PREFERS Responses-over-WebSocket (`core/src/client.rs:1013-1017`).
// It falls back to plain HTTP for exactly one answer: HTTP 426 Upgrade
// Required on the handshake (`core/src/client.rs:1808-1812`); any other
// failure is a hard error. A custom provider avoids the detour entirely,
// because `supports_websockets` is `#[serde(default)]` = false
// (`:147-149`) — which is why the custom provider is the RECOMMENDED route and
// the 426 handler here exists only to keep the `openai_base_url` route
// working. Both are supported; neither costs the other anything.
//
// THE USAGE POLL. `{chatgpt_base_url}/wham/usage` when the base URL contains
// `/backend-api`, else `{chatgpt_base_url}/api/codex/usage`
// (`backend-client/src/client.rs:117-133` picks the style;
// `backend-client/src/client/rate_limit_resets.rs:124-129` builds the path).
// Both are served here, so either spelling of `chatgpt_base_url` works.
//
// THE USAGE BODY is `RateLimitStatusWithResetCredits`
// (`backend-client/src/types.rs:55-67`) flattening `RateLimitStatusPayload`
// (`codex-backend-openapi-models/.../rate_limit_status_payload.rs:15-52`), so
// `plan_type` and `rate_limit` sit at the TOP level. `plan_type` is required;
// inside `rate_limit`, `allowed` and `limit_reached` are required, and a
// window carries all four of `used_percent`, `limit_window_seconds`,
// `reset_after_seconds`, `reset_at` (`.../rate_limit_window_snapshot.rs:14-22`
// — none optional). The same top-level `rate_limit.primary_window` shape is
// what this repo's own `src/providers/codex-usage.ts` reads, so ONE body
// satisfies both readers, which is the point: `ms` must keep ranking the
// scratch account normally while its turns are being walled.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//
//   node scripts/codex-wall-mock.mjs [--port N] [--resets-in SECONDS]
//                                    [--usage-json FILE] [--allow-turns N]
//                                    [--generic-429]
//
// Port 0 (the default) asks the OS for a free one and the chosen port is
// printed once, as `codex-wall-mock: http://127.0.0.1:<port>`, on stdout.
// Every request is logged to stderr as `METHOD PATH -> STATUS` and NOTHING
// else — no bodies, no headers. A mock that sits between a real account and a
// real CLI must not become the one place a token or a prompt is written down.
//
// See docs/superpowers/plans/2026-09-16-codex-wall-mock.md for the live drill.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** The loopback address this server will bind, and the only one it ever binds. */
export const HOST = "127.0.0.1";

/** Default `--resets-in`: an hour, in seconds. */
export const DEFAULT_RESETS_IN = 3600;

/**
 * The quota 429 body — the ONE shape `api_bridge.rs:132-163` turns into
 * `CodexErr::UsageLimitReached`.
 *
 * `message` is not read by the client (the struct at `api_bridge.rs:264-270`
 * has no such field and ignores unknown ones); it is here because the real
 * backend sends one and a human reading a capture should see the same shape.
 * The sentence the TUI actually prints is built client-side from `plan_type`
 * and `resets_at` (`protocol/src/error.rs:710-751`).
 */
export function quotaBody({ resetsAt = null, planType = "pro" } = {}) {
  const error = { type: "usage_limit_reached", message: "The usage limit has been reached" };
  if (planType != null) error.plan_type = planType;
  if (resetsAt != null) error.resets_at = resetsAt;
  return { error };
}

/**
 * A 429 that is NOT a wall.
 *
 * Same status, different `error.type`, so `api_bridge.rs` falls past the
 * `usage_limit_reached` arm at `:135` and past `usage_not_included` at `:160`
 * to `CodexErr::RetryLimit` at `:165` — which the TUI renders "exceeded retry
 * limit, last status: 429 Too Many Requests" (`protocol/src/error.rs:628-640`)
 * and which must NOT drive a rotation. Served by `--generic-429`, so the live
 * drill can prove the negative as well as the positive.
 */
export function genericBody() {
  return { error: { type: "rate_limit_exceeded", message: "Rate limit exceeded. Please slow down." } };
}

/**
 * A healthy Pro-shaped `/wham/usage` body: one 168 h window at 40 %, no
 * secondary.
 *
 * "Healthy" is deliberate. The account being walled at the inference endpoint
 * must still POLL as having room, because that is the real situation this
 * drill reproduces — a wall arrives mid-turn while the usage snapshot still
 * says there is headroom, and `ms` has to rank and rotate through that.
 *
 * `reset_after_seconds` is 60 % of the window, the arithmetic complement of a
 * 40 % spend, so the body is internally consistent for any reader that checks.
 * It matters for one reader in particular: `codex-usage.ts`'s `toWindow`
 * treats a window as "not started" only when `used_percent` is 0 AND
 * `reset_after_seconds >= limit_window_seconds`, so a 40 % window reports a
 * real `resetsAt` rather than a synthetic one.
 */
export function healthyUsageBody(nowSeconds = Math.floor(Date.now() / 1000)) {
  const windowSeconds = 604_800; // 168 h
  const remaining = Math.round(windowSeconds * 0.6);
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 40,
        limit_window_seconds: windowSeconds,
        reset_after_seconds: remaining,
        reset_at: nowSeconds + remaining,
      },
      secondary_window: null,
    },
    additional_rate_limits: null,
    rate_limit_reset_credits: null,
    rate_limit_upsell: null,
    account_id: "acct_mock",
    user_id: "user_mock",
  };
}

/**
 * The smallest SSE stream that reads as a completed turn, for `--allow-turns`.
 *
 * Three events, in the order `codex-api/src/sse/responses.rs` accepts them:
 * `response.created` (`:408`), one `response.output_item.done` carrying an
 * assistant message (`:357`), and `response.completed` (`:483`). The last is
 * not optional — a stream that ends without it is reported as "stream closed
 * before response.completed" (`:598`), which is an error, not a turn.
 */
export function successTurnStream(n = 1, text = "ok") {
  const id = `resp_mock_${n}`;
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev("response.created", { type: "response.created", response: { id } }) +
    ev("response.output_item.done", {
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", id: `msg_mock_${n}`, content: [{ type: "output_text", text }] },
    }) +
    ev("response.completed", {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    })
  );
}

/** One log line. Method, path, status — never a body, never a header. */
export function formatLog(method, path, status) {
  return `codex-wall-mock: ${method} ${path} -> ${status}`;
}

/**
 * Is this request asking to become a WebSocket?
 *
 * Checked on the raw headers rather than on node's `upgrade` event alone,
 * because a handshake that reaches the ordinary request path (no `Connection:
 * Upgrade`, or a proxy that rewrote it) must still be answered 426 — the
 * client's fallback hinges on that one status and on nothing else.
 */
export function isUpgradeRequest(headers) {
  const upgrade = String(headers?.upgrade ?? "").toLowerCase();
  const connection = String(headers?.connection ?? "").toLowerCase();
  return upgrade.includes("websocket") || connection.includes("upgrade");
}

/** The inference endpoint, whichever base URL the account was pointed at:
 *  `…/v1/responses` (custom provider) or `…/backend-api/codex/responses`
 *  (`openai_base_url`). Both end in the one path segment the source builds. */
export const isResponsesPath = (pathname) => /(^|\/)responses$/.test(pathname);

/** The usage endpoint, in both path styles `backend-client` can choose
 *  (`client.rs:117-133`): `wham/usage` for a `/backend-api` base URL,
 *  `api/codex/usage` for anything else. */
export const isUsagePath = (pathname) => /(^|\/)(wham\/usage|api\/codex\/usage)$/.test(pathname);

/**
 * Start the mock and resolve once it is listening.
 *
 * Options:
 *   port        0 (default) asks the OS for a free port.
 *   resetsIn    seconds until the wall's `resets_at`; null omits the field.
 *   usage       the `/wham/usage` body to serve, or null for the healthy one.
 *   allowTurns  how many turns succeed before the wall. 0 walls the first.
 *   generic429  serve the NON-wall 429 body instead of the quota one.
 *   log         called with one already-formatted line per request.
 *   now         () => epoch seconds, so tests can pin `resets_at`.
 *
 * The returned handle carries `port`, the three base URLs a `config.toml`
 * needs, a `stats` object (so a test can assert how many turns were served),
 * and `close()`.
 */
export function startMock(options = {}) {
  const {
    port = 0,
    resetsIn = DEFAULT_RESETS_IN,
    usage = null,
    allowTurns = 0,
    generic429 = false,
    log = (line) => process.stderr.write(`${line}\n`),
    now = () => Math.floor(Date.now() / 1000),
  } = options;

  const stats = { turnsServed: 0, wallsServed: 0, upgradesRefused: 0, usagePolls: 0, notFound: 0 };

  const send = (res, status, contentType, body, method, pathname) => {
    res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    log(formatLog(method, pathname, status));
  };

  const server = createServer((req, res) => {
    // A URL is parsed only for its pathname; query strings never select a
    // handler here, so a stray `?` cannot route a request somewhere else.
    const pathname = new URL(req.url ?? "/", `http://${HOST}`).pathname;

    if (isUpgradeRequest(req.headers)) {
      stats.upgradesRefused++;
      send(res, 426, "text/plain", "Upgrade Required\n", req.method ?? "GET", pathname);
      return;
    }

    if (req.method === "POST" && isResponsesPath(pathname)) {
      // The request body is drained and DISCARDED. It is the human's prompt
      // and their conversation; this server has no reason to see it and no
      // business keeping it. Draining is still required — leaving it unread
      // can stall the client's write.
      req.resume();
      if (stats.turnsServed < allowTurns) {
        stats.turnsServed++;
        send(res, 200, "text/event-stream", successTurnStream(stats.turnsServed), req.method, pathname);
        return;
      }
      stats.wallsServed++;
      const body = generic429
        ? genericBody()
        : quotaBody({ resetsAt: resetsIn == null ? null : now() + resetsIn });
      send(res, 429, "application/json", JSON.stringify(body), req.method, pathname);
      return;
    }

    if (req.method === "GET" && isUsagePath(pathname)) {
      stats.usagePolls++;
      send(res, 200, "application/json", JSON.stringify(usage ?? healthyUsageBody(now())), req.method, pathname);
      return;
    }

    req.resume();
    stats.notFound++;
    send(res, 404, "application/json", JSON.stringify({ error: { type: "not_found" } }), req.method ?? "GET", pathname);
  });

  // A `Connection: Upgrade` request never reaches the request handler: node
  // emits `upgrade` instead, and with no listener it destroys the socket —
  // which the client reports as a hard connection error, not as the 426 that
  // makes it fall back to HTTP. So the handshake is answered on the raw
  // socket, with the same status the request path would have sent.
  server.on("upgrade", (req, socket) => {
    const pathname = new URL(req.url ?? "/", `http://${HOST}`).pathname;
    stats.upgradesRefused++;
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    log(formatLog(req.method ?? "GET", pathname, 426));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const actual = server.address().port;
      const origin = `http://${HOST}:${actual}`;
      resolve({
        port: actual,
        url: origin,
        stats,
        /** Exactly the values a scratch account's `config.toml` needs. */
        baseUrls: {
          provider: `${origin}/v1`,
          openai: `${origin}/backend-api/codex`,
          chatgpt: `${origin}/backend-api`,
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// --- CLI ----------------------------------------------------------------

/** `--flag value` parsing, split out so the argument contract is testable
 *  without binding a port. Throws on a value that is not a whole number. */
export function parseMockArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "resets-in": { type: "string" },
      "usage-json": { type: "string" },
      "allow-turns": { type: "string" },
      "generic-429": { type: "boolean" },
    },
  });
  const int = (name, raw, fallback) => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} takes a whole number of seconds, not ${JSON.stringify(raw)}`);
    return Number(raw);
  };
  return {
    port: int("port", values.port, 0),
    resetsIn: int("resets-in", values["resets-in"], DEFAULT_RESETS_IN),
    allowTurns: int("allow-turns", values["allow-turns"], 0),
    generic429: values["generic-429"] === true,
    usage: values["usage-json"] === undefined ? null : JSON.parse(readFileSync(values["usage-json"], "utf8")),
  };
}

/** True when this module was run as a script rather than imported. */
const runAsScript = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (runAsScript) {
  const opts = parseMockArgs(process.argv.slice(2));
  const handle = await startMock(opts);
  process.stdout.write(`codex-wall-mock: ${handle.url}\n`);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      void handle.close().then(() => process.exit(0));
    });
  }
}
