// The dashboard's JSON API (src/dashboard/api.ts): `handle()` over the same
// store and manual verbs `ms status`/`ms rotate`/`ms switch`/`ms stop` use,
// with no HTTP in between — every test below calls `handle()` directly.
//
// Harness: a temp HOME/MS_HOME (test/helpers.ts), a bash `tmux` stub on PATH
// (the same stub test/manual.test.ts uses, for the one test — `/api/stop` —
// that actually has to touch a pane), two seeded accounts and two seeded
// sessions. Nothing here calls the real network: the usage snapshot is
// pre-written fresh, so `statusJson()` serves it from the cache file rather
// than polling.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome, stubDir } from "./helpers.ts";
import { openState } from "../src/state.ts";
import { saveLaunchToken } from "../src/launch-credentials.ts";
import type { Verb } from "../src/cli.ts";
import { captureVerb, handle } from "../src/dashboard/api.ts";

const PANE = "%7";
const SOCKET = "/tmp/ms-dashboard-api-test.sock";
const IDENTITY = "1:2";
const SHELL = "/bin/bash";
const ORIGINAL_PATH = process.env.PATH ?? "";
const HOUR = 3_600_000;

// Same stub as test/manual.test.ts's TMUX_STUB: a bash `tmux` on PATH that
// keeps one pane's state in a temp file, and logs every call it sees.
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

/** A search needle no dashboard response may ever contain. */
const FIXTURE_TOKEN = "sk-ant-oat01-FIXTURE0123456789abcdefghijklmno";

type World = { home: string; msHome: string; log: string; cwd: string };

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

/**
 * Two accounts (dirk, gmail), two sessions (s1 on dirk/running, s2 on
 * gmail/parked), a fresh usage snapshot covering both accounts (so
 * `statusJson()` never has to poll), and a stub `tmux` on PATH — touched by
 * only the `/api/stop` test below, but set up for every test the way
 * test/manual.test.ts's `world()` always does, so nothing here depends on
 * which test happens to exercise the pane.
 */
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
  // Only s1's pane needs to exist for the stub: it is the only session any
  // test here actually touches through tmux (s2 is used only to exercise API
  // validation, which refuses before tmux is ever asked anything).
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
  // The verbs read both; a real tmux around the test runner must not answer
  // for the stub one, and "no argument" is only a pane when we say it is.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  saveLaunchToken("dirk", FIXTURE_TOKEN);
  saveLaunchToken("gmail", "sk-ant-oat01-gmail0123456789abcdefghijklmn");
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
    st.createSession({
      id: "s2",
      provider: "claude",
      cliSessionId: "c-2",
      cwd,
      socket: SOCKET,
      pane: "%9",
      serverStart: IDENTITY,
      need: "any",
      account: "gmail",
      generation: 1,
      state: "parked",
      desired: "running",
      flags: [],
    });
  } finally {
    st.close();
  }

  return { home, msHome, log, cwd };
}

const logLines = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim());

// --- GET /api/state ---------------------------------------------------

test("GET /api/state returns both tables, a numeric takenAt, and no token-shaped string", async (t) => {
  await world(t);

  const res = await handle({ method: "GET", path: "/api/state" });

  assert.equal(res.status, 200);
  const json = res.json as { accounts: unknown[]; sessions: { id: string; account: string }[]; takenAt: number };
  assert.equal(json.accounts.length, 2);
  assert.equal(json.sessions.length, 2);
  assert.ok(json.sessions.some((s) => s.id === "s1" && s.account === "dirk"));
  assert.ok(json.sessions.some((s) => s.id === "s2" && s.account === "gmail"));
  assert.ok(Number.isFinite(json.takenAt) && json.takenAt > 0);

  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(FIXTURE_TOKEN), `token leaked into the API response: ${serialized}`);
  assert.ok(!serialized.includes("sk-ant-oat01"), `a token-shaped string leaked into the API response: ${serialized}`);
});

// --- POST /api/stop -----------------------------------------------------

test("POST /api/stop on a running session ends it and the tmux log shows the exit sequence", async (t) => {
  const w = await world(t);

  const res = await handle({ method: "POST", path: "/api/stop", body: { session: "s1" } });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { code: 0, message: "ms: s1 stopped" });

  const lines = logLines(w);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at("send-keys -t %7 Escape") >= 0, `no Escape in:\n${lines.join("\n")}`);
  assert.ok(at("send-keys -t %7 /exit Enter") > at("send-keys -t %7 Escape"), "no /exit after Escape");
  assert.ok(at("respawn-pane") >= 0, "the pane was never given back");

  const st = openState();
  try {
    assert.equal(st.getSession("s1")!.state, "stopped");
  } finally {
    st.close();
  }
});

// --- POST /api/switch -----------------------------------------------------

test("POST /api/switch with an unregistered account is refused before tmux is touched", async (t) => {
  const w = await world(t);

  const res = await handle({ method: "POST", path: "/api/switch", body: { session: "s2", to: "nobody" } });

  assert.equal(res.status, 200);
  const json = res.json as { code: number; message: string };
  assert.equal(json.code, 1);
  // manual.ts's switchVerb names the unregistered account this way — not
  // "not registered" — so this is what the API actually relays.
  assert.match(json.message, /no such claude account 'nobody'/);
  assert.deepEqual(logLines(w), [], "tmux was never even asked a question");
});

// --- Malformed bodies → 400 -------------------------------------------

test("a malformed body is refused with 400, per route", async (t) => {
  await world(t);

  const cases: { method: string; path: string; body?: unknown }[] = [
    { method: "POST", path: "/api/rotate", body: {} }, // missing session
    { method: "POST", path: "/api/rotate", body: { session: 7 } }, // wrong type
    { method: "POST", path: "/api/rotate", body: "s1" }, // not an object
    { method: "POST", path: "/api/switch", body: { session: "s1" } }, // missing to
    { method: "POST", path: "/api/switch", body: { session: "s1", to: "gmail", force: "yes" } }, // wrong type
    { method: "POST", path: "/api/stop", body: {} }, // missing session
    { method: "POST", path: "/api/stop" }, // no body at all
    { method: "POST", path: "/api/switch-all", body: { to: 1 } }, // wrong type
  ];

  for (const req of cases) {
    const res = await handle(req);
    assert.equal(res.status, 400, `${req.method} ${req.path} with ${JSON.stringify(req.body)}`);
    assert.equal(typeof (res.json as { error: unknown }).error, "string");
  }
});

// --- Unknown route → 404 -----------------------------------------------

test("an unknown route is 404", async (t) => {
  await world(t);

  for (const req of [
    { method: "GET", path: "/api/nope" },
    { method: "DELETE", path: "/api/state" },
    { method: "GET", path: "/api/rotate" }, // right path, wrong method
  ]) {
    const res = await handle(req);
    assert.equal(res.status, 404, `${req.method} ${req.path}`);
    assert.equal(typeof (res.json as { error: unknown }).error, "string");
  }
});

// --- POST /api/switch-all ------------------------------------------------

test("POST /api/switch-all is not yet implemented (Task 3)", async (t) => {
  await world(t);

  const res = await handle({ method: "POST", path: "/api/switch-all", body: { to: "gmail" } });

  assert.equal(res.status, 501);
  assert.deepEqual(res.json, { error: "not yet" });
});

// --- captureVerb ----------------------------------------------------------

test("captureVerb restores process.stderr.write even when the verb throws", async () => {
  const original = process.stderr.write;
  const throwing: Verb = async () => {
    throw new Error("boom");
  };

  await assert.rejects(() => captureVerb(throwing, ["s1"]), /boom/);
  // Mutation-proven: drop the `finally` in captureVerb and this fails,
  // because the swapped stderr.write from the throwing call is still
  // installed here.
  assert.equal(process.stderr.write, original, "the swap must be undone on the throw path too");

  // The mutex is not wedged behind the throw: the next call still runs and
  // still gets its own stderr line back.
  const ok: Verb = async () => {
    process.stderr.write("ms: fine\n");
    return 0;
  };
  assert.deepEqual(await captureVerb(ok, []), { code: 0, message: "ms: fine" });
  assert.equal(process.stderr.write, original, "the second call also restored stderr.write");
});
