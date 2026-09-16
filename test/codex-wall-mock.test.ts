// test/codex-wall-mock.test.ts
//
// The mock is a TEST INSTRUMENT: when a live drill fails, the first question
// is always "was that the CLI or was that the mock?". These tests are the
// answer — they pin every byte the Codex source actually reads, so a failure
// in the live drill can be blamed on the CLI with a straight face.
//
// Each assertion names the source line it is pinning (openai/codex
// `rust-v0.154.0`, commit 6b9826e, paths relative to `codex-rs/`), because the
// contract is THEIRS, not ours: if one of these drifts, the fix is to re-read
// that file, never to loosen the test.
//
// Every server here binds 127.0.0.1 on port 0 and is closed in the same test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startMock,
  quotaBody,
  genericBody,
  healthyUsageBody,
  successTurnStream,
  formatLog,
  isUpgradeRequest,
  isResponsesPath,
  isUsagePath,
  parseMockArgs,
  DEFAULT_RESETS_IN,
} from "../scripts/codex-wall-mock.mjs";
import { fetchCodexUsage, CODEX_USAGE_URL, type CodexAuth } from "../src/providers/codex-usage.ts";

const NOW = 1_700_000_000;
const signal = () => AbortSignal.timeout(5_000);

/** Raw HTTP over a socket, for the handshakes `fetch` will not let us send:
 *  `Connection` and `Upgrade` are forbidden header names in the fetch spec, so
 *  the WebSocket handshake has to be written by hand.
 *
 *  Resolves as soon as the response HEADERS are complete, rather than on
 *  close: a 426 sent down the ordinary request path leaves a keep-alive
 *  connection open, so waiting for close would hang on exactly the case this
 *  helper exists to test. */
function rawRequest(port: number, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(`${lines.join("\r\n")}\r\n\r\n`));
    let out = "";
    sock.setTimeout(5_000, () => { sock.destroy(); reject(new Error("timed out")); });
    sock.on("data", (b) => {
      out += b.toString("utf8");
      if (out.includes("\r\n\r\n")) { sock.destroy(); resolve(out); }
    });
    sock.on("error", reject);
    sock.on("close", () => resolve(out));
  });
}

// --- the wall body ------------------------------------------------------

test("the 429 body is the ONE shape api_bridge.rs turns into a wall, and the generic one is not", () => {
  // `api_bridge.rs:132-163`: a 429 is a wall only when the body parses as
  // `{error:{type:"usage_limit_reached"}}`. `plan_type` and `resets_at` live
  // INSIDE `error` (`:264-270`), and `resets_at` is unix SECONDS — the struct
  // has no `resets_in_seconds` field at all, so a duration there is ignored.
  const wall = quotaBody({ resetsAt: 1_789_000_000, planType: "pro" });
  assert.equal(wall.error.type, "usage_limit_reached");
  assert.equal(wall.error.plan_type, "pro");
  assert.equal(wall.error.resets_at, 1_789_000_000);
  assert.equal("resets_in_seconds" in wall.error, false);

  // `plan_type` and `resets_at` are both optional (`api_bridge_tests.rs:336-359`
  // omits `resets_at` entirely and still gets the wall); only `type` decides.
  const bare = quotaBody({ resetsAt: null, planType: null });
  assert.deepEqual(Object.keys(bare.error).sort(), ["message", "type"]);

  // The negative. A 429 with any other body falls through `:135` and `:160` to
  // `CodexErr::RetryLimit` at `:165` — rendered "exceeded retry limit, last
  // status: 429" (`protocol/src/error.rs:628-640`), which is NOT a wall.
  assert.notEqual(genericBody().error.type, "usage_limit_reached");
  assert.notEqual(genericBody().error.type, "usage_not_included");
});

test("POST /v1/responses walls the first turn, with the exact status, content type and resets_at", async () => {
  const m = await startMock({ now: () => NOW, resetsIn: 900, log: () => {} });
  try {
    const res = await fetch(`${m.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: [] }),
      signal: signal(),
    });
    // Status and content type are both load-bearing: `map_api_error` only ever
    // parses the body of a `TransportError::Http`, and the client only builds
    // one from a non-2xx response.
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = (await res.json()) as ReturnType<typeof quotaBody>;
    assert.equal(body.error.type, "usage_limit_reached");
    assert.equal(body.error.plan_type, "pro");
    assert.equal(body.error.resets_at, NOW + 900, "resets_at is now + --resets-in, in seconds");
    assert.equal(m.stats.turnsServed, 0, "no turn was served — the wall is the first round trip");
    assert.equal(m.stats.wallsServed, 1);
  } finally {
    await m.close();
  }
});

test("the openai_base_url route walls too: POST /backend-api/codex/responses is the same endpoint", async () => {
  // `provider.rs:52` builds `{base_url}/responses`, so the two supported
  // config routes differ only in their base URL: a custom provider's
  // `…/v1` and the built-in provider's `…/backend-api/codex`.
  const m = await startMock({ now: () => NOW, log: () => {} });
  try {
    const res = await fetch(`${m.baseUrls.openai}/responses`, { method: "POST", body: "{}", signal: signal() });
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as ReturnType<typeof quotaBody>).error.type, "usage_limit_reached");
    assert.equal(m.baseUrls.provider, `${m.url}/v1`);
    assert.equal(m.baseUrls.chatgpt, `${m.url}/backend-api`);
  } finally {
    await m.close();
  }
});

test("--generic-429 serves a 429 that is deliberately NOT a wall", async () => {
  const m = await startMock({ generic429: true, log: () => {} });
  try {
    const res = await fetch(`${m.url}/v1/responses`, { method: "POST", body: "{}", signal: signal() });
    assert.equal(res.status, 429, "same status as the wall — the status alone never decides");
    assert.notEqual(((await res.json()) as ReturnType<typeof genericBody>).error.type, "usage_limit_reached");
  } finally {
    await m.close();
  }
});

// --- the websocket detour ----------------------------------------------

test("a WebSocket handshake is answered 426, the one status that makes the client fall back to HTTP", async () => {
  // `core/src/client.rs:1808-1812`: `StatusCode::UPGRADE_REQUIRED` is the ONLY
  // websocket outcome that yields `FallbackToHttp`; anything else is a hard
  // error and the POST that carries the wall never happens. Node would destroy
  // an upgrade socket with no listener, which is exactly that hard error, so
  // this test is the one that proves the fallback route works at all.
  const m = await startMock({ log: () => {} });
  try {
    const res = await rawRequest(m.port, [
      "GET /v1/responses HTTP/1.1",
      `Host: 127.0.0.1:${m.port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ]);
    assert.match(res, /^HTTP\/1\.1 426 Upgrade Required/);
    assert.equal(m.stats.upgradesRefused, 1);
    assert.equal(m.stats.wallsServed, 0, "a handshake is not a turn");
  } finally {
    await m.close();
  }
});

test("an upgrade that arrives on the ordinary request path is answered 426 as well", async () => {
  // Belt and braces: an `Upgrade: websocket` with no `Connection: Upgrade`
  // does not reach node's `upgrade` event, so the request handler has to
  // recognise it too — otherwise it would be answered 429 and the client
  // would read a wall it never asked for.
  assert.equal(isUpgradeRequest({ upgrade: "websocket" }), true);
  assert.equal(isUpgradeRequest({ connection: "keep-alive, Upgrade" }), true);
  assert.equal(isUpgradeRequest({ connection: "keep-alive" }), false);
  assert.equal(isUpgradeRequest({}), false);

  const m = await startMock({ log: () => {} });
  try {
    const res = await rawRequest(m.port, [
      "POST /v1/responses HTTP/1.1",
      `Host: 127.0.0.1:${m.port}`,
      "Upgrade: websocket",
      "Content-Length: 0",
    ]);
    assert.match(res, /^HTTP\/1\.1 426 /);
  } finally {
    await m.close();
  }
});

// --- the usage poll -----------------------------------------------------

test("GET /backend-api/wham/usage serves a healthy Pro body — one 168h window at 40%, no secondary", async () => {
  const m = await startMock({ now: () => NOW, log: () => {} });
  try {
    const res = await fetch(`${m.baseUrls.chatgpt}/wham/usage`, { signal: signal() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = (await res.json()) as ReturnType<typeof healthyUsageBody>;

    // The shape the CLI deserialises: `plan_type` and `rate_limit` at the TOP
    // level, because `RateLimitStatusWithResetCredits` flattens
    // `RateLimitStatusPayload` (`backend-client/src/types.rs:55-67`).
    assert.equal(body.plan_type, "pro");
    // `allowed` and `limit_reached` are required, not optional
    // (`rate_limit_status_details.rs:18-20`).
    assert.equal(body.rate_limit.allowed, true);
    assert.equal(body.rate_limit.limit_reached, false);
    // All four window fields are required (`rate_limit_window_snapshot.rs:14-22`).
    assert.deepEqual(Object.keys(body.rate_limit.primary_window!).sort(), [
      "limit_window_seconds",
      "reset_after_seconds",
      "reset_at",
      "used_percent",
    ]);
    assert.equal(body.rate_limit.primary_window!.used_percent, 40);
    assert.equal(body.rate_limit.primary_window!.limit_window_seconds, 604_800);
    assert.equal(body.rate_limit.secondary_window, null);
  } finally {
    await m.close();
  }
});

test("the usage body is what src/providers/codex-usage.ts's own parser reads — room, weekly, no fable", async () => {
  // The real parser, over the real server: `globalThis.fetch` is redirected so
  // `fetchCodexUsage`'s hard-coded `CODEX_USAGE_URL` lands on the mock. That
  // hard-coding is the point of this test — `chatgpt_base_url` redirects the
  // CLI's poll, never ms's, so the two readers have to agree on ONE body.
  const m = await startMock({ now: () => NOW, log: () => {} });
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      assert.equal(String(url), CODEX_USAGE_URL);
      return saved(`${m.baseUrls.chatgpt}/wham/usage`, init);
    }) as typeof fetch;

    const auth = { tokens: { id_token: "x.y.z", access_token: "at", refresh_token: "rt", account_id: "acct" } } as CodexAuth;
    const usage = await fetchCodexUsage(auth, signal());

    // 604800 s is >= a day, so it classifies as the weekly window, not the
    // session one — and a Codex Pro account reporting only its weekly window
    // is exactly the case `pick.ts` has to tolerate.
    assert.equal(usage.session, null);
    assert.equal(usage.weeklyAll?.usedPercent, 40);
    // `used_percent` is non-zero, so the window is "started" and carries a
    // real reset time rather than the synthetic not-started null.
    assert.equal(usage.weeklyAll?.resetsAt, new Date((NOW + 362_880) * 1000).toISOString());
    // Codex has no Fable-scoped window at all.
    assert.equal(usage.weeklyFable, null);
    // Under 100, so `pick.ts` does not gate the account: the scratch account
    // keeps ranking normally while its turns are being walled.
    assert.ok((usage.weeklyAll?.usedPercent ?? 100) < 100);
  } finally {
    globalThis.fetch = saved;
    await m.close();
  }
});

test("the other path style is served too, and --usage-json replaces the body", async () => {
  // `backend-client/src/client.rs:117-133`: a base URL WITHOUT `/backend-api`
  // selects the `api/codex/usage` family instead of `wham/usage`.
  assert.equal(isUsagePath("/backend-api/wham/usage"), true);
  assert.equal(isUsagePath("/api/codex/usage"), true);
  assert.equal(isUsagePath("/wham/usage/thread_usage/query"), false);
  assert.equal(isResponsesPath("/v1/responses"), true);
  assert.equal(isResponsesPath("/backend-api/codex/responses"), true);
  assert.equal(isResponsesPath("/responses/other"), false);

  const mine = { plan_type: "plus", rate_limit: { allowed: true, limit_reached: false } };
  const m = await startMock({ usage: mine, log: () => {} });
  try {
    const res = await fetch(`${m.url}/api/codex/usage`, { signal: signal() });
    assert.deepEqual(await res.json(), mine);
  } finally {
    await m.close();
  }
});

// --- turns before the wall ---------------------------------------------

test("--allow-turns N serves N complete SSE turns and walls the one after", async () => {
  const m = await startMock({ allowTurns: 2, now: () => NOW, log: () => {} });
  try {
    for (const n of [1, 2]) {
      const res = await fetch(`${m.url}/v1/responses`, { method: "POST", body: "{}", signal: signal() });
      assert.equal(res.status, 200, `turn ${n}`);
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      const text = await res.text();
      // `sse/responses.rs:598` reports a stream that ends without
      // `response.completed` as an error, so all three events are required for
      // the turn to read as a turn.
      assert.ok(text.includes("event: response.created"), `turn ${n} created`);
      assert.ok(text.includes("event: response.output_item.done"), `turn ${n} item`);
      assert.ok(text.includes("event: response.completed"), `turn ${n} completed`);
    }
    const walled = await fetch(`${m.url}/v1/responses`, { method: "POST", body: "{}", signal: signal() });
    assert.equal(walled.status, 429);
    assert.equal(m.stats.turnsServed, 2);
    assert.equal(m.stats.wallsServed, 1);
  } finally {
    await m.close();
  }
});

test("successTurnStream is well-formed SSE whose data lines each parse as JSON", () => {
  const frames = successTurnStream(1, "ok").split("\n\n").filter((f: string) => f !== "");
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    const [head, data] = frame.split("\n");
    assert.match(head, /^event: response\./);
    assert.match(data, /^data: /);
    assert.doesNotThrow(() => JSON.parse(data.slice("data: ".length)));
  }
});

// --- the default, and the log ------------------------------------------

test("anything else is a 404", async () => {
  const m = await startMock({ log: () => {} });
  try {
    for (const p of ["/", "/v1/chat/completions", "/backend-api/wham/rate-limit-reset-credits"]) {
      assert.equal((await fetch(`${m.url}${p}`, { signal: signal() })).status, 404, p);
    }
    assert.equal(m.stats.notFound, 3);
  } finally {
    await m.close();
  }
});

test("the log carries method, path and status — and never a body or a header", async () => {
  const lines: string[] = [];
  const m = await startMock({ log: (l: string) => lines.push(l) });
  const SECRET_PROMPT = "PROMPT-CANARY-do-not-log-me";
  const SECRET_TOKEN = "Bearer TOKEN-CANARY-do-not-log-me";
  try {
    await fetch(`${m.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: SECRET_TOKEN, "chatgpt-account-id": "ACCT-CANARY" },
      body: JSON.stringify({ input: [{ role: "user", content: SECRET_PROMPT }] }),
      signal: signal(),
    });
    await fetch(`${m.baseUrls.chatgpt}/wham/usage`, { headers: { authorization: SECRET_TOKEN }, signal: signal() });
    await fetch(`${m.url}/nope`, { signal: signal() });

    assert.deepEqual(lines, [
      "codex-wall-mock: POST /v1/responses -> 429",
      "codex-wall-mock: GET /backend-api/wham/usage -> 200",
      "codex-wall-mock: GET /nope -> 404",
    ]);
    const all = lines.join("\n");
    for (const canary of [SECRET_PROMPT, "TOKEN-CANARY", "ACCT-CANARY", "usage_limit_reached", "used_percent"]) {
      assert.equal(all.includes(canary), false, `the log leaked ${canary}`);
    }
  } finally {
    await m.close();
  }
});

test("formatLog is the whole log line: three fields, nothing else", () => {
  assert.equal(formatLog("POST", "/v1/responses", 429), "codex-wall-mock: POST /v1/responses -> 429");
});

// --- the CLI contract ---------------------------------------------------

test("parseMockArgs: defaults, every flag, and a refusal on a non-numeric value", () => {
  assert.deepEqual(parseMockArgs([]), { port: 0, resetsIn: DEFAULT_RESETS_IN, allowTurns: 0, generic429: false, usage: null });
  assert.equal(DEFAULT_RESETS_IN, 3600);

  const file = path.join(mkdtempSync(path.join(tmpdir(), "ms-wall-mock-")), "usage.json");
  writeFileSync(file, JSON.stringify({ plan_type: "plus" }));
  assert.deepEqual(parseMockArgs(["--port", "8899", "--resets-in", "60", "--allow-turns", "3", "--generic-429", "--usage-json", file]), {
    port: 8899,
    resetsIn: 60,
    allowTurns: 3,
    generic429: true,
    usage: { plan_type: "plus" },
  });

  assert.throws(() => parseMockArgs(["--resets-in", "an hour"]), /whole number/);
  // `--port=-1` rather than `--port -1`: node's own parseArgs rejects the
  // spaced form as ambiguous before this validator ever sees the value.
  assert.throws(() => parseMockArgs(["--port=-1"]), /whole number/);
});

test("the server binds loopback only", async () => {
  const m = await startMock({ log: () => {} });
  try {
    assert.match(m.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(m.port > 0);
  } finally {
    await m.close();
  }
});
