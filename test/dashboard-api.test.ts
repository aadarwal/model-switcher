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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome, stubDir } from "./helpers.ts";
import { appendEvent } from "../src/events.ts";
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
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

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
  const json = res.json as {
    accounts: { name: string; label: string; state: string }[];
    sessions: { id: string; account: string; pending: string | null; walled: string }[];
    takenAt: number;
  };
  assert.equal(json.accounts.length, 2);
  assert.equal(json.sessions.length, 2);
  assert.ok(json.sessions.some((s) => s.id === "s1" && s.account === "dirk"));
  assert.ok(json.sessions.some((s) => s.id === "s2" && s.account === "gmail"));
  assert.ok(Number.isFinite(json.takenAt) && json.takenAt > 0);

  // Review round 1 (P4-T2), finding 1: LABEL/STATE/PENDING/WALLED? travel
  // through the dashboard API too, not just `ms status --json` directly —
  // this route is `statusJson()` end to end, so a regression here would be
  // `handle()` itself dropping a key, not the underlying computation.
  const dirk = json.accounts.find((a) => a.name === "dirk")!;
  assert.equal(dirk.label, "Dirk");
  assert.equal(dirk.state, "ok");
  const gmail = json.accounts.find((a) => a.name === "gmail")!;
  assert.equal(gmail.label, "Gmail");
  assert.equal(gmail.state, "ok");
  const s1 = json.sessions.find((s) => s.id === "s1")!;
  assert.equal(s1.pending, null);
  assert.equal(s1.walled, ""); // running, idle screen: no wall, no open recovery
  const s2 = json.sessions.find((s) => s.id === "s2")!;
  assert.equal(s2.pending, null);
  assert.equal(s2.walled, ""); // pane %9 isn't in the tmux stub's pane list at all

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
  // A POST reconciles first now, and reconciliation READS tmux — so the log
  // is not empty. What matters is unchanged: nothing was done to a pane.
  assert.ok(!logLines(w).some((l) => l.includes("send-keys") || l.includes("respawn-pane")), "a pane was touched");
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
    { method: "POST", path: "/api/switch-all", body: {} }, // missing to
    { method: "POST", path: "/api/switch-all" }, // no body at all
    { method: "POST", path: "/api/switch-all", body: "home" }, // not an object
    { method: "POST", path: "/api/switch-all", body: { to: "home", force: "yes" } }, // wrong type
    { method: "POST", path: "/api/switch-all", body: { to: "home", timeoutMs: -1 } }, // not positive
    { method: "POST", path: "/api/switch-all", body: { to: "home", timeoutMs: "600000" } }, // wrong type
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
//
// A fleet move touches more than one pane at once, so it needs the same
// pane-KEYED stub test/manual.test.ts's `--all` tests use (`FLEET_STUB`
// below is that stub, trimmed to what this file needs) — the single-pane
// stub above would have one session's `/exit` answer for both.

const FLEET_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
st="$MS_TMUX_STATE"
pane=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-t" ]; then pane="$a"; fi
  prev="$a"
done
get() { grep "^$1=" "$st" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { printf '%s=%s\n' "$1" "$2" >> "$st"; }
case "$1" in
  list-panes) get panes | tr ' ' '\n' ;;
  display-message)
    case "$*" in
      *pane_pid*) printf '%s\t%s\t%s\t%s\n' "$(get "pid$pane")" claude "$(get "dead$pane")" "$(get cwd)" ;;
      *pane_dead_status*) printf '\n' ;;
      *pane_dead*) get "dead$pane" ;;
      *) get identity ;;
    esac ;;
  capture-pane) cat "$MS_TMUX_SCREENS/$pane" 2>/dev/null ;;
  send-keys) case "$*" in */exit*) put "dead$pane" 1 ;; esac ;;
  respawn-pane) put "dead$pane" 0 ;;
esac
exit 0`;

const FLEET_SOCKET = "/tmp/ms-dashboard-api-fleet-test.sock";

type FleetSession = { id: string; pane: string; cliSessionId: string; generation: number };
type FleetWorld = { home: string; msHome: string; log: string; sessions: FleetSession[] };

/** Two sessions, both on `away`, in their own panes — `to: "home"` moves both. */
const FLEET_SESSIONS: FleetSession[] = [
  { id: "f1", pane: "%1", cliSessionId: "c-f1", generation: 1 },
  { id: "f2", pane: "%2", cliSessionId: "c-f2", generation: 1 },
];

/** The fleet's own two accounts, `away` walled and `home` wide open. */
function writeFleetSnapshot(msHome: string): void {
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
    JSON.stringify({ takenAt: now, accounts: [row("home", 4, 8), row("away", 100, 60)], backoff: {} }),
    { mode: 0o600 },
  );
}

async function fleetWorld(t: TestContext): Promise<FleetWorld> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", FLEET_STUB);
  const log = path.join(dir, "tmux.log");
  const state = path.join(dir, "tmux.state");
  const screens = path.join(dir, "screens");
  mkdirSync(screens, { recursive: true });
  const pid = liveProcess(t);
  const cwd = home;
  const sessions = FLEET_SESSIONS;

  writeFileSync(log, "");
  writeFileSync(
    state,
    [
      `panes=${sessions.map((s) => s.pane).join(" ")}`,
      ...sessions.map((s) => `pid${s.pane}=${pid}`),
      ...sessions.map((s) => `dead${s.pane}=0`),
      `cwd=${cwd}`,
      `identity=${IDENTITY}`,
      "",
    ].join("\n"),
  );
  for (const s of sessions) writeFileSync(path.join(screens, s.pane), IDLE_SCREEN);
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "home", provider: "claude", label: "Home", shared: false },
        { name: "away", provider: "claude", label: "Away", shared: false },
      ],
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.MS_TMUX_LOG = log;
  process.env.MS_TMUX_STATE = state;
  process.env.MS_TMUX_SCREENS = screens;
  process.env.MS_TMUX_SCREEN = "";
  process.env.MS_TMUX_SNAP = "";
  process.env.MS_TMUX_REVIVE = "";
  process.env.MS_TMUX_FAIL = "";
  process.env.MS_POLL_MS = "20";
  process.env.MS_READY_MS = "5000";
  process.env.MS_SETTLE_MS = "";
  process.env.MS_LOCK_WAIT_MS = "";
  process.env.SHELL = SHELL;
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  saveLaunchToken("home", "sk-ant-oat01-home0123456789abcdefghijklmn");
  saveLaunchToken("away", "sk-ant-oat01-away0123456789abcdefghijklmn");
  // A fresh snapshot covering BOTH fleet accounts, so a `rotate` — which has
  // no named destination and must ask the chooser — reads it from the cache
  // instead of polling. `away` is at the wall and `home` is empty, so the
  // chooser's answer is the one the assertions name.
  writeFleetSnapshot(msHome);

  const st = openState();
  try {
    for (const s of sessions) {
      st.createSession({
        id: s.id,
        provider: "claude",
        cliSessionId: s.cliSessionId,
        cwd,
        socket: FLEET_SOCKET,
        pane: s.pane,
        serverStart: IDENTITY,
        need: "any",
        account: "away",
        generation: s.generation,
        state: "running",
        desired: "running",
        flags: [],
      });
    }
  } finally {
    st.close();
  }

  return { home, msHome, log, sessions };
}

/**
 * Claude Code's own SessionStart hook, for a fleet of panes at once: as soon
 * as the stub tmux shows a pane respawned, report that session's next
 * generation back under its ORIGINAL cli session id — `switchOne` resumes
 * rather than starts fresh, so `recoverSession`'s readiness wait
 * (`waitForReady`, src/recover.ts) is watching for exactly this. With no
 * report at all it would wait out the full `MS_READY_MS` per session.
 */
function reportFleet(w: FleetWorld): () => void {
  const byPane = new Map(w.sessions.map((s) => [s.pane, s]));
  const done = new Set<string>();
  const timer = setInterval(() => {
    for (const line of readFileSync(w.log, "utf8").split("\n")) {
      if (!line.includes("respawn-pane")) continue;
      const m = line.match(/ -t (%\d+)/);
      const pane = m?.[1];
      const s = pane ? byPane.get(pane) : undefined;
      if (!s || done.has(s.pane)) continue;
      done.add(s.pane);
      appendEvent({ t: nowSeconds(), kind: "resumed", session: s.id, generation: s.generation + 1, cliSessionId: s.cliSessionId });
    }
  }, 10);
  return () => clearInterval(timer);
}

test("POST /api/switch-all moves every session not already on the destination", async (t) => {
  const w = await fleetWorld(t);
  const stop = reportFleet(w);
  t.after(stop);

  const res = await handle({ method: "POST", path: "/api/switch-all", body: { to: "home" } });

  assert.equal(res.status, 200);
  const json = res.json as { code: number; message: string | null; results: { session: string; code: number; message: string }[] };
  assert.equal(json.code, 0);
  assert.equal(json.message, null);
  assert.equal(json.results.length, 2);
  for (const s of w.sessions) {
    const r = json.results.find((x) => x.session === s.id);
    assert.ok(r, `${s.id} missing from results`);
    assert.equal(r!.code, 0, `${s.id}: ${r!.message}`);
  }

  const st = openState();
  try {
    for (const s of w.sessions) assert.equal(st.getSession(s.id)!.account, "home", `${s.id} did not move`);
  } finally {
    st.close();
  }

  const lines = readFileSync(w.log, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  for (const s of w.sessions) {
    assert.ok(
      lines.some((l) => l.includes(`send-keys -t ${s.pane}`) && l.includes("/exit")),
      `${s.id}'s pane was never asked to exit`,
    );
    assert.ok(
      lines.some((l) => l.includes(`respawn-pane`) && l.includes(s.pane)),
      `${s.id}'s pane was never respawned`,
    );
  }
});

test("POST /api/switch-all to an account nobody registered moves nothing", async (t) => {
  const w = await fleetWorld(t);

  const res = await handle({ method: "POST", path: "/api/switch-all", body: { to: "nobody" } });

  assert.equal(res.status, 200);
  const json = res.json as { code: number; message: string | null; results: unknown[] };
  assert.equal(json.code, 1);
  assert.match(json.message ?? "", /no such/);
  assert.deepEqual(json.results, []);
  assert.ok(!readFileSync(w.log, "utf8").includes("send-keys"), "a pane was touched for a destination that does not exist");
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

// --- Whole-branch review, area C ------------------------------------------

/**
 * C2: `/api/switch-all` used to run OUTSIDE `captureVerb`'s chain, so every
 * `ms _recover: …` line the fleet move wrote went to whatever
 * `process.stderr.write` happened to be at that instant — the `ms dashboard`
 * terminal (which promised exactly one line), or, worse, another session's
 * in-flight capture, which then returned a refusal about a session the human
 * had not touched.
 *
 * The provocation is the handoff pool: with all four slots held, every move
 * in this test refuses through `fail()`, which writes to stderr. The sentinel
 * below IS the process's real stderr for the duration, so a single escaped
 * line fails the test.
 */
test("POST /api/switch-all is captured like every other verb: no refusal reaches the process's stderr, or another verb's response", async (t) => {
  const w = await fleetWorld(t);
  const { acquire } = await import("../src/lock.ts");
  const held = [0, 1, 2, 3].map((k) => acquire(`handoff-${k}`));
  assert.ok(held.every(Boolean), "the test could not fill the handoff slots");
  t.after(() => held.forEach((r) => r?.()));

  const leaked: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    leaked.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  let all: Awaited<ReturnType<typeof handle>>;
  let rot: Awaited<ReturnType<typeof handle>>;
  try {
    [all, rot] = await Promise.all([
      handle({ method: "POST", path: "/api/switch-all", body: { to: "home" } }),
      handle({ method: "POST", path: "/api/rotate", body: { session: "f2" } }),
    ]);
  } finally {
    process.stderr.write = original;
  }

  assert.deepEqual(leaked, [], `the fleet move's own refusals reached the dashboard's terminal: ${leaked.join("")}`);

  // Nothing is lost by capturing it: every refusal is in `results`.
  const json = all.json as { code: number; message: string | null; results: { session: string; code: number; message: string }[] };
  assert.equal(json.code, 1);
  assert.equal(json.results.length, 2);
  for (const r of json.results) assert.equal(r.code, 1, `${r.session} should have been refused: ${r.message}`);

  // And the concurrent rotate answers for ITSELF: one line, its own.
  const rotJson = rot.json as { code: number; message: string };
  assert.equal(rotJson.code, 1);
  assert.equal(
    rotJson.message.split("\n").length,
    1,
    `the rotate's response absorbed another session's stderr: ${JSON.stringify(rotJson.message)}`,
  );
  assert.match(rotJson.message, /handoff slots are busy/);
});

/**
 * C6: a second click on Rotate was a second handoff — `captureVerb`'s chain
 * queues rather than dedupes, so the two ran back to back and the session
 * ended two accounts and two `/exit`+resume cycles later. The per-session
 * in-flight set refuses the second one outright, before it can queue.
 */
test("a verb for a session already in flight is refused at once, and the generation advances exactly once", async (t) => {
  const w = await fleetWorld(t);
  const stop = reportFleet(w);
  t.after(stop);

  const [first, second] = await Promise.all([
    handle({ method: "POST", path: "/api/rotate", body: { session: "f1" } }),
    handle({ method: "POST", path: "/api/rotate", body: { session: "f1" } }),
  ]);

  assert.equal(second.status, 200);
  assert.deepEqual(second.json, { code: 1, message: "a move is already in progress for f1" });
  const firstJson = first.json as { code: number; message: string };
  assert.equal(firstJson.code, 0, `the first rotate should have run: ${firstJson.message}`);

  const st = openState();
  try {
    const s = st.getSession("f1")!;
    assert.equal(s.generation, 2, "two clicks must not be two handoffs");
    assert.equal(s.account, "home");
  } finally {
    st.close();
  }
  const exits = readFileSync(w.log, "utf8")
    .split("\n")
    .filter((l) => l.includes("send-keys -t %1") && l.includes("/exit"));
  assert.equal(exits.length, 1, `the pane was asked to exit ${exits.length} times`);

  // The set is cleared in a `finally`, so the session is movable again.
  const again = await handle({ method: "POST", path: "/api/switch", body: { session: "f1", to: "away" } });
  const againJson = again.json as { code: number; message: string };
  assert.notEqual(againJson.message, "a move is already in progress for f1");
});

/**
 * Minor (report-C): `timeoutMs` must accept 0 — the CLI's own `--timeout 0`
 * means "start nothing" (src/manual.ts's `parseManualArgs`), and the API
 * 400'd the identical request.
 */
test("timeoutMs accepts 0: 'start nothing', exactly as the CLI's --timeout 0 does", async (t) => {
  const w = await fleetWorld(t);

  const res = await handle({ method: "POST", path: "/api/switch-all", body: { to: "home", timeoutMs: 0 } });

  assert.equal(res.status, 200, JSON.stringify(res.json));
  const json = res.json as { code: number; message: string | null; results: { session: string; code: number; message: string }[] };
  assert.equal(json.code, 1);
  assert.equal(json.results.length, 2);
  for (const r of json.results) assert.match(r.message, /not started: the 0ms budget ran out/);
  assert.ok(
    !readFileSync(w.log, "utf8").includes("send-keys"),
    "a zero budget started a handoff anyway",
  );
});

/**
 * Minor (report-C): the CLI reconciles once per process, so a `ms switch
 * --all` typed into a terminal repairs a closed pane's row first. A dashboard
 * left open for hours never did, so the same fleet move from the page refused
 * every gone session ("obsolete: the pane is gone") and came back exit 1.
 * GETs still never write: `ms status` reports, it does not repair.
 */
test("a POST verb reconciles first (a GET never does): a closed pane's row is repaired, not refused", async (t) => {
  const w = await fleetWorld(t);
  const seed = openState();
  try {
    seed.createSession({
      id: "f3",
      provider: "claude",
      cliSessionId: "c-f3",
      cwd: w.home,
      socket: FLEET_SOCKET,
      pane: "%3", // never in the stub's pane list: this pane is gone
      serverStart: IDENTITY,
      need: "any",
      account: "away",
      generation: 1,
      state: "running",
      desired: "running",
      flags: [],
    });
  } finally {
    seed.close();
  }

  // A read never repairs. (What it REPORTS for a closed pane is a separate
  // matter: `statusJson()` spreads the raw row, so its `state` is the store's
  // own word, not `computeSession`'s "gone" override — see fix-C-report.md.)
  const state = await handle({ method: "GET", path: "/api/state" });
  const stateJson = state.json as { sessions: { id: string }[] };
  assert.ok(stateJson.sessions.some((s) => s.id === "f3"));
  const afterGet = openState();
  try {
    assert.equal(afterGet.getSession("f3")!.state, "running", "a GET must not repair anything");
  } finally {
    afterGet.close();
  }

  const stop = reportFleet(w);
  t.after(stop);
  const res = await handle({ method: "POST", path: "/api/switch-all", body: { to: "home" } });

  const json = res.json as { code: number; message: string | null; results: { session: string; code: number; message: string }[] };
  assert.deepEqual(
    json.results.map((r) => r.session).sort(),
    ["f1", "f2"],
    "the gone session was still dragged into the fleet move",
  );
  assert.equal(json.code, 0, JSON.stringify(json.results));
  const afterPost = openState();
  try {
    assert.equal(afterPost.getSession("f3")!.state, "stopped", "the POST never reconciled");
  } finally {
    afterPost.close();
  }
});
