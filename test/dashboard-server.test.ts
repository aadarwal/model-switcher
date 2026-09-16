// test/dashboard-server.test.ts
//
// `startDashboard` (src/dashboard/server.ts) and the `ms dashboard` verb
// (src/dashboard.ts): the loopback HTTP server that serves the page
// (src/dashboard/page.ts) over the JSON API (src/dashboard/api.ts, Task 1),
// binds 127.0.0.1 ONLY, and exits once nobody is polling it.
//
// Harness: a temp HOME/MS_HOME (test/helpers.ts), a bash `tmux` stub on PATH
// (the same stub test/dashboard-api.test.ts and test/manual.test.ts use), one
// seeded running session and two seeded accounts with a fresh usage snapshot
// — the same shape dashboard-api.test.ts's `world()` builds, duplicated here
// rather than imported, since each test file owns its own fixtures.
//
// The server binds port 0 so parallel tests never collide over a port. Every
// direct `startDashboard()` call below passes `open: false` except the one
// test that proves `open` really does get spawned when enabled — a real
// `open` popping a browser tab on every `npm test` run would be its own bug.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome, stubDir, run } from "./helpers.ts";
import { openState } from "../src/state.ts";
import { startDashboard, DEFAULT_IDLE_MS } from "../src/dashboard/server.ts";

const PANE = "%7";
const SOCKET = "/tmp/ms-dashboard-server-test.sock";
const IDENTITY = "1:2";
const SHELL = "/bin/bash";
const ORIGINAL_PATH = process.env.PATH ?? "";
const HOUR = 3_600_000;

// Same stub as test/dashboard-api.test.ts's TMUX_STUB: a bash `tmux` on PATH
// that keeps one pane's state in a temp file and logs every call it sees.
const TMUX_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
st="$MS_TMUX_STATE"
get() { grep "^$1=" "$st" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { printf '%s=%s\n' "$1" "$2" >> "$st"; }
case "$1" in
  list-panes) get panes ;;
  display-message)
    case "$*" in
      *pane_pid*) printf '%s\t%s\t%s\t%s\n' "$(get pane_pid)" "$(get command)" "$(get pane_dead)" "$(get cwd)" ;;
      *pane_dead_status*) get pane_dead_status ;;
      *pane_dead*) get pane_dead ;;
      *) get identity ;;
    esac ;;
  capture-pane) cat "$MS_TMUX_SCREEN" 2>/dev/null ;;
  send-keys)
    case "$*" in */exit*) put pane_dead 1; put exited 1 ;; esac ;;
  respawn-pane) put pane_dead 0 ;;
esac
exit 0`;

const IDLE_SCREEN = ["❯ ship it", "", "  Done.", "", "❯ ", ""].join("\n");

type World = { home: string; msHome: string; log: string; cwd: string; tmuxDir: string };

/** A live, disposable process whose pid the stub pane reports. */
function liveProcess(t: TestContext): number {
  const child: ChildProcess = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  return child.pid!;
}

function writeSnapshot(msHome: string): void {
  const now = Date.now();
  const row = (name: string, session: number, weekly: number) => ({
    name,
    provider: "claude" as const,
    shared: false,
    usage: {
      session: { usedPercent: session, resetsAt: new Date(now + HOUR).toISOString() },
      weeklyAll: { usedPercent: weekly, resetsAt: new Date(now + 6 * HOUR).toISOString() },
      weeklyFable: null,
    },
    error: null,
    errorKind: null,
    observedAt: now,
    stale: false,
  });
  writeFileSync(
    path.join(msHome, "snapshot.json"),
    JSON.stringify({ takenAt: now, accounts: [row("dirk", 12, 30), row("gmail", 5, 10)], backoff: {} }),
    { mode: 0o600 },
  );
}

/** One running session (s1, on dirk, pane %7) plus two accounts and a fresh
 *  usage snapshot — enough for every route the tests below exercise. */
async function world(t: TestContext): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", TMUX_STUB);
  const log = path.join(dir, "tmux.log");
  const state = path.join(dir, "tmux.state");
  const screen = path.join(dir, "screen.txt");
  const pid = liveProcess(t);
  const cwd = home;

  writeFileSync(log, "");
  writeFileSync(screen, IDLE_SCREEN);
  writeFileSync(
    state,
    [`panes=${PANE}`, `pane_pid=${pid}`, "command=claude", "pane_dead=0", `cwd=${cwd}`, `identity=${IDENTITY}`, ""].join("\n"),
  );
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "dirk", provider: "claude", label: "Dirk", shared: false },
        { name: "gmail", provider: "claude", label: "Gmail", shared: false },
      ],
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.MS_TMUX_LOG = log;
  process.env.MS_TMUX_STATE = state;
  process.env.MS_TMUX_SCREEN = screen;
  process.env.MS_TMUX_SNAP = "";
  process.env.MS_TMUX_REVIVE = "";
  process.env.MS_TMUX_FAIL = "";
  process.env.MS_POLL_MS = "20";
  process.env.MS_SETTLE_MS = "3000";
  process.env.MS_LOCK_WAIT_MS = "3000";
  process.env.SHELL = SHELL;
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  writeSnapshot(msHome);

  const st = openState();
  try {
    st.createSession({
      id: "s1",
      provider: "claude",
      cliSessionId: "c-1",
      cwd,
      socket: SOCKET,
      pane: PANE,
      serverStart: IDENTITY,
      need: "any",
      account: "dirk",
      generation: 2,
      state: "running",
      desired: "running",
      flags: [],
    });
  } finally {
    st.close();
  }

  t.after(() => {
    process.env.PATH = ORIGINAL_PATH;
  });

  return { home, msHome, log, cwd, tmuxDir: dir };
}

const logLines = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim());

/**
 * A POST whose body arrives in two halves, with a real delay between them —
 * so the SERVER genuinely has a request in flight for `splitDelayMs`, not a
 * simulated one. Reproduces review round 1's finding 3 proof scenario
 * ("a POST finishing 1.5s late") without needing to fake `handle()` itself
 * being slow: a client that trickles its body is enough to keep `readBody()`
 * — and therefore the whole request — open for exactly this long.
 */
function slowPost(url: string, body: string, splitDelayMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    const mid = Math.max(1, Math.floor(body.length / 2));
    req.write(body.slice(0, mid));
    setTimeout(() => req.end(body.slice(mid)), splitDelayMs);
  });
}

// --- GET / -----------------------------------------------------------

test("startDashboard binds 127.0.0.1 and GET / returns HTML with both table headers and the move-all control", async (t) => {
  await world(t);
  const dash = await startDashboard({ port: 0, open: false });
  t.after(() => dash.close());

  assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+$/, `unexpected url shape: ${dash.url}`);

  const res = await fetch(`${dash.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();

  // The accounts table's own header row.
  for (const h of ["NAME", "LABEL", "5H", "WEEK", "FABLE", "RESETS", "STATE"]) {
    assert.ok(html.includes(`>${h}<`), `accounts header missing: ${h}`);
  }
  // The sessions table's own header row (mirrors src/status.ts's columns).
  for (const h of ["SESSION", "PANE", "PROVIDER", "ACCOUNT", "NEED", "GEN", "PENDING", "WAKEUP", "WALLED?"]) {
    assert.ok(html.includes(`>${h}<`), `sessions header missing: ${h}`);
  }
  // The move-all control: "Move every <provider> pane to <account> [Go]".
  assert.ok(html.includes("Move every"), "move-all control text missing");
  assert.ok(html.includes('id="moveall-provider"'), "move-all provider select missing");
  assert.ok(html.includes('id="moveall-account"'), "move-all account select missing");
  assert.ok(html.includes('id="moveall-go"'), "move-all Go control missing");

  // Mutation check for the binding rule itself: never 0.0.0.0.
  const bound = new URL(dash.url);
  assert.equal(bound.hostname, "127.0.0.1");
  assert.notEqual(bound.hostname, "0.0.0.0");
});

// --- GET /api/state ----------------------------------------------------

test("GET /api/state through the real server returns JSON with a numeric takenAt", async (t) => {
  await world(t);
  const dash = await startDashboard({ port: 0, open: false });
  t.after(() => dash.close());

  const res = await fetch(`${dash.url}/api/state`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const json = (await res.json()) as { accounts: unknown[]; sessions: unknown[]; takenAt: number };
  assert.ok(Number.isFinite(json.takenAt) && json.takenAt > 0, `bad takenAt: ${json.takenAt}`);
  assert.equal(json.accounts.length, 2);
  assert.equal(json.sessions.length, 1);
});

// --- POST /api/stop ------------------------------------------------------

test("POST /api/stop with a JSON body reaches handle() and the stub tmux log shows the exit sequence", async (t) => {
  const w = await world(t);
  const dash = await startDashboard({ port: 0, open: false });
  t.after(() => dash.close());

  const res = await fetch(`${dash.url}/api/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "s1" }),
  });

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { code: 0, message: "ms: s1 stopped" });

  const lines = logLines(w);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at("send-keys -t %7 Escape") >= 0, `no Escape in:\n${lines.join("\n")}`);
  assert.ok(at("send-keys -t %7 /exit Enter") > at("send-keys -t %7 Escape"), "no /exit after Escape");

  const st = openState();
  try {
    assert.equal(st.getSession("s1")!.state, "stopped");
  } finally {
    st.close();
  }
});

// --- Body size limit -----------------------------------------------------

test("a request body over 64 KB is refused with 413 before it reaches handle()", async (t) => {
  await world(t);
  const dash = await startDashboard({ port: 0, open: false });
  t.after(() => dash.close());

  const big = "x".repeat(70 * 1024);
  const res = await fetch(`${dash.url}/api/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: big }),
  });

  assert.equal(res.status, 413);
  const json = (await res.json()) as { error: string };
  assert.equal(typeof json.error, "string");

  // A body under the limit must still reach the route's own validation
  // (a session that does not exist, rather than a 413) — proves 64 KB is a
  // real threshold, not a mutation that rejects every body.
  const ok = await fetch(`${dash.url}/api/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "no-such-session" }),
  });
  assert.equal(ok.status, 200);
});

// --- waitUntilIdle / close -------------------------------------------------

test("waitUntilIdle resolves within ~1s of the last request, and the server actually closes", async (t) => {
  await world(t);
  const dash = await startDashboard({ port: 0, open: false, idleMs: 200 });

  await fetch(`${dash.url}/api/state`); // touches the idle timer once, then nothing else

  const start = Date.now();
  await dash.waitUntilIdle();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `waitUntilIdle took ${elapsed}ms after the last request`);

  dash.close();
  await assert.rejects(() => fetch(`${dash.url}/api/state`), "a request after close() must fail");
});

// --- Review round 1, finding 3: idle clock vs. in-flight requests --------

test("review round 1, finding 3: the idle clock never fires while a request is still in flight", async (t) => {
  await world(t);
  const dash = await startDashboard({ port: 0, open: false, idleMs: 400 });
  t.after(() => dash.close());

  const SPLIT_DELAY_MS = 1500;
  const slow = slowPost(`${dash.url}/api/rotate`, JSON.stringify({ session: "no-such-session" }), SPLIT_DELAY_MS);

  const start = Date.now();
  let idleAt: number | null = null;
  dash.waitUntilIdle().then(() => {
    idleAt = Date.now() - start;
  });

  // Well past the naive "touch on arrival only" bug window (idleMs=400ms
  // alone would have fired here already), well before the slow request's
  // body actually finishes arriving.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(idleAt, null, "waitUntilIdle resolved while a request was still in flight");

  const res = await slow; // let the slow request actually finish
  assert.equal(res.status, 200);

  // Idle window (400ms) plus slack, measured from when the request truly
  // completed — this is what close() destroying the socket mid-response
  // would have broken (finding 3's exact failure mode).
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(idleAt !== null, "waitUntilIdle never resolved after the in-flight request completed");
  assert.ok(idleAt! >= SPLIT_DELAY_MS, `resolved too early relative to when the request actually finished: ${idleAt}ms`);
});

// --- Review round 1, finding 4: the idle default -------------------------

test("review round 1, finding 4: the default idle timeout is 90s, not 30s (hidden-tab timers throttle starting around 60s)", () => {
  assert.equal(DEFAULT_IDLE_MS, 90_000);
});

test("a request received while waiting resets the idle clock", async (t) => {
  await world(t);
  const dash = await startDashboard({ port: 0, open: false, idleMs: 300 });
  t.after(() => dash.close());

  await fetch(`${dash.url}/api/state`);
  await new Promise((r) => setTimeout(r, 200));
  await fetch(`${dash.url}/api/state`); // resets the clock with ~100ms of the window left

  let idle = false;
  dash.waitUntilIdle().then(() => {
    idle = true;
  });
  await new Promise((r) => setTimeout(r, 150));
  // 150ms after the second request, with a 300ms idle window, this must not
  // have resolved yet — proves the timer is reset per request, not per server.
  assert.equal(idle, false, "waitUntilIdle resolved before the second request's own idle window elapsed");

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(idle, true, "waitUntilIdle never resolved after the window truly elapsed");
});

// --- open() spawning -------------------------------------------------------

test("startDashboard spawns `open <url>` only when open is not false", async (t) => {
  const w = await world(t);
  const { dir: openDir, stub } = stubDir();
  const openLog = path.join(openDir, "open.log");
  stub("open", `printf '%s\\n' "$*" >> ${JSON.stringify(openLog)}`);
  writeFileSync(openLog, "");
  // Layer the `open` stub in front of whatever world() already put on PATH
  // (the tmux stub) — this route never touches tmux, but nothing else here
  // should stop working either.
  process.env.PATH = `${openDir}:${process.env.PATH}`;
  t.after(() => {
    process.env.PATH = ORIGINAL_PATH;
  });
  void w;

  const withOpen = await startDashboard({ port: 0, open: true });
  t.after(() => withOpen.close());
  const afterEnabled = readFileSync(openLog, "utf8").trim();
  // Review round 1, finding 7: pin the EXACT argv, not just "the url shows up
  // somewhere in it" — `["open", "-a", "Safari", url]` would have passed a
  // looser `.includes(url)` check while silently changing which browser (or
  // profile, or window flags) the dashboard opens in.
  assert.equal(afterEnabled, withOpen.url, `open must be called with exactly [url], nothing else: ${afterEnabled}`);

  writeFileSync(openLog, "");
  const withoutOpen = await startDashboard({ port: 0, open: false });
  t.after(() => withoutOpen.close());
  assert.equal(readFileSync(openLog, "utf8").trim(), "", "open was spawned even with open: false");
});

// --- The `ms dashboard` verb, end to end ----------------------------------

test("`ms dashboard --no-open` never spawns open, prints exactly one URL line, and exits 0 once idle", async (t) => {
  const { home, msHome } = tempHome();
  const { dir: openDir, stub } = stubDir();
  const openLog = path.join(openDir, "open.log");
  stub("open", `printf '%s\\n' "$*" >> ${JSON.stringify(openLog)}`);
  writeFileSync(openLog, "");

  const res = run(["dashboard", "--no-open"], {
    HOME: home,
    MS_HOME: msHome,
    PATH: `${openDir}:${ORIGINAL_PATH}`,
    MS_DASHBOARD_IDLE_MS: "200",
  });

  assert.equal(res.code, 0, `exit code ${res.code}, stderr: ${res.stderr}`);
  const lines = res.stderr.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, `expected exactly one stderr line, got: ${JSON.stringify(lines)}`);
  assert.match(lines[0]!, /^ms dashboard: http:\/\/127\.0\.0\.1:\d+$/, `unexpected line: ${lines[0]}`);
  assert.equal(readFileSync(openLog, "utf8").trim(), "", "open was spawned despite --no-open");
});

test("the `ms dashboard` verb rejects an unknown flag with usage (exit 2), never starting a server", async () => {
  const { home, msHome } = tempHome();
  const res = run(["dashboard", "--bogus"], { HOME: home, MS_HOME: msHome, MS_DASHBOARD_IDLE_MS: "200" });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage: ms dashboard/);
});

