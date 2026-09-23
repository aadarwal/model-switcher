// `ms rebalance [--dry-run] [--session <id>]` — the rule, on demand
// (docs/superpowers/specs/2026-09-19-rebalance-design.md, "Visibility").
//
// The decision itself is proved pure in test/rebalance.test.ts; nothing here
// re-tests a threshold. What is proved here is the VERB: which sessions it
// looks at, which guard it waives for an explicit human run and which it
// never waives, that `--dry-run` touches nothing at all, and the exit codes.
//
// Harness: a temp HOME/MS_HOME, a bash `tmux` stub on PATH that logs every
// call it is handed, and a usage snapshot written fresh to disk — so
// `getSnapshot` serves the file and no test here ever reaches the network.
// The switch transaction is injected (`switcher`), because what this verb
// owes the transaction is an ARGUMENT, not a handoff: test/manual.test.ts
// already proves what `switchOne` does with it.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, stubDir, tempHome } from "./helpers.ts";
import { appendEvent } from "../src/events.ts";
import { openState } from "../src/state.ts";
import { saveLaunchToken } from "../src/launch-credentials.ts";
import { rebalanceFleet, type RebalanceReport } from "../src/rebalance-verb.ts";
import type { Switcher } from "../src/rebalance.ts";

const SOCKET = "/tmp/ms-rebalance-verb-test.sock";
const IDENTITY = "1:2";
const HOUR = 3_600_000;
const ORIGINAL_PATH = process.env.PATH ?? "";
const FIXTURE_TOKEN = "sk-ant-oat01-FIXTURE0123456789abcdefghijklmno";

/** A pane that is plainly between turns: a finished answer and a fresh
 *  prompt. `isBusy` (src/recover.ts) reads it as idle, which is the only
 *  reading this rule ever acts on. */
const IDLE_SCREEN = ["❯ ship it", "", "  Done.", "", "❯ ", ""].join("\n");

/** Enough tmux for a pane reading, and a log of every call — so "a dry run
 *  moved nothing" can be asserted over what tmux was actually asked, not
 *  over the absence of a message. */
const TMUX_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
case "$1" in
  list-panes) printf '%s\n' $MS_TMUX_PANES ;;
  capture-pane) cat "$MS_TMUX_SCREEN" 2>/dev/null ;;
  display-message) printf '%s\n' "$MS_TMUX_IDENTITY" ;;
esac
exit 0`;

type World = { home: string; msHome: string; log: string; env: (over?: Record<string, string>) => Record<string, string> };

/**
 * dirk is at 90 % of its 5 h window — a wall about to land — and gmail has
 * the whole of both of its. So the chooser prefers gmail and condition 1
 * holds for anything running on dirk, deterministically and with no clock
 * arithmetic in any test below.
 */
function writeSnapshot(msHome: string): void {
  const now = Date.now();
  const row = (name: string, session: number, weekly: number) => ({
    name,
    provider: "claude" as const,
    shared: false,
    usage: {
      session: { usedPercent: session, resetsAt: new Date(now + HOUR).toISOString() },
      weeklyAll: { usedPercent: weekly, resetsAt: new Date(now + 48 * HOUR).toISOString() },
      weeklyFable: null,
    },
    error: null,
    errorKind: null,
    observedAt: now,
    stale: false,
  });
  writeFileSync(
    path.join(msHome, "snapshot.json"),
    JSON.stringify({ takenAt: now, accounts: [row("dirk", 90, 20), row("gmail", 5, 10)], backoff: {} }),
    { mode: 0o600 },
  );
}

/** s1: running on dirk (the account about to wall) — the one row that moves.
 *  s2: parked on gmail — a state this rule never touches.
 *  s3: running on gmail — live, but already where the chooser would put it. */
async function world(_t: TestContext): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", TMUX_STUB);
  // `ms status`-shaped worlds reach the keychain for a launch token; 44 is
  // errSecItemNotFound, and no test may touch the real one.
  stub("security", "exit 44");
  const log = path.join(dir, "tmux.log");
  const screen = path.join(dir, "screen.txt");
  writeFileSync(log, "");
  writeFileSync(screen, IDLE_SCREEN);

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
  process.env.MS_TMUX_SCREEN = screen;
  process.env.MS_TMUX_PANES = "%1 %2";
  process.env.MS_TMUX_IDENTITY = IDENTITY;
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  delete process.env.MS_REBALANCE;

  saveLaunchToken("dirk", FIXTURE_TOKEN);
  saveLaunchToken("gmail", "sk-ant-oat01-gmail0123456789abcdefghijklmn");
  writeSnapshot(msHome);

  const st = openState();
  try {
    const base = { provider: "claude" as const, cwd: home, socket: SOCKET, serverStart: IDENTITY, need: "any" as const, desired: "running" as const, flags: [] };
    st.createSession({ ...base, id: "s1", cliSessionId: "c-1", pane: "%1", account: "dirk", generation: 2, state: "running" });
    st.createSession({ ...base, id: "s2", cliSessionId: "c-2", pane: "%9", account: "gmail", generation: 1, state: "parked" });
    st.createSession({ ...base, id: "s3", cliSessionId: "c-3", pane: "%2", account: "gmail", generation: 1, state: "running" });
  } finally {
    st.close();
  }

  return {
    home,
    msHome,
    log,
    env: (over = {}) => ({
      HOME: home,
      MS_HOME: msHome,
      PATH: `${dir}:${ORIGINAL_PATH}`,
      MS_TMUX_LOG: log,
      MS_TMUX_SCREEN: screen,
      MS_TMUX_PANES: "%1 %2",
      MS_TMUX_IDENTITY: IDENTITY,
      ...over,
    }),
  };
}

const logLines = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim());
const rowFor = (r: RebalanceReport, id: string) => r.rows.find((x) => x.session === id)!;

/** A switch transaction that records what it was asked for and never runs
 *  one. `code` is what it answers with. */
function fakeSwitcher(code = 0, message = "switched"): { calls: { session: string; to: string; opts: unknown }[]; switcher: Switcher } {
  const calls: { session: string; to: string; opts: unknown }[] = [];
  return {
    calls,
    switcher: async (session, to, opts) => {
      calls.push({ session, to, opts });
      return { code, message };
    },
  };
}

// --- What the table says --------------------------------------------------

test("rebalance: a live session on the account about to wall gets a row naming where it belongs and why", async (t) => {
  await world(t);
  const { calls, switcher } = fakeSwitcher();

  const report = await rebalanceFleet({ dryRun: true, switcher });

  const s1 = rowFor(report, "s1");
  assert.equal(s1.account, "dirk");
  assert.equal(s1.better, "gmail");
  assert.equal(s1.reason, "imminent-wall");
  assert.equal(s1.outcome, "would move");
  assert.equal(calls.length, 0, "a dry run asked the transaction for nothing");
  assert.equal(report.failed, 0);
});

test("rebalance: a live session already on the best account is a row, not a move", async (t) => {
  await world(t);

  const report = await rebalanceFleet({ dryRun: true, switcher: fakeSwitcher().switcher });

  const s3 = rowFor(report, "s3");
  assert.equal(s3.better, null, "gmail IS the best account; there is nowhere better to name");
  assert.equal(s3.reason, "already on the best account");
  assert.equal(s3.outcome, "—");
});

test("rebalance: a session that is neither running nor continuing is skipped BY NAME, with the reason", async (t) => {
  await world(t);

  const report = await rebalanceFleet({ dryRun: true, switcher: fakeSwitcher().switcher });

  assert.deepEqual(report.rows.map((r) => r.session).sort(), ["s1", "s3"]);
  assert.deepEqual(report.skipped, [{ session: "s2", why: "the session is parked" }]);
});

// --- The guards: one waived, one never --------------------------------------

test("rebalance waives the 6 h cooldown for an explicit human run — the hook's own guard is not the human's", async (t) => {
  await world(t);
  const st = openState();
  try {
    st.updateSession("s1", { lastMoveAt: Math.floor(Date.now() / 1000) - 60 });
  } finally {
    st.close();
  }

  const report = await rebalanceFleet({ dryRun: true, switcher: fakeSwitcher().switcher });

  assert.equal(rowFor(report, "s1").outcome, "would move", "a move one minute ago still lets a human ask");
});

test("rebalance never waives the 30 m wall guard — a session that just rotated off a wall is left alone", async (t) => {
  await world(t);
  appendEvent({ t: Math.floor(Date.now() / 1000) - 5 * 60, kind: "rate_limited", session: "s1", generation: 2 });

  const { calls, switcher } = fakeSwitcher();
  const report = await rebalanceFleet({ dryRun: false, switcher });

  const s1 = rowFor(report, "s1");
  assert.equal(s1.reason, "it rotated off a wall within the last 30m");
  assert.equal(s1.outcome, "—");
  assert.equal(calls.length, 0);
});

// --- A real run -------------------------------------------------------------

test("rebalance without --dry-run runs the same transaction the hook does: no continuation, never forced", async (t) => {
  await world(t);
  const { calls, switcher } = fakeSwitcher(0, "switched → gmail");

  const report = await rebalanceFleet({ dryRun: false, switcher });

  assert.deepEqual(calls, [{ session: "s1", to: "gmail", opts: { continueAfter: false, force: false } }]);
  assert.equal(rowFor(report, "s1").outcome, "moved");
  assert.equal(report.failed, 0);
});

test("rebalance: a refused transaction is the row's outcome and the run's exit code, not a throw", async (t) => {
  await world(t);
  const { switcher } = fakeSwitcher(1, "s1 is mid-turn; moving it now would kill that turn (use --force)");

  const report = await rebalanceFleet({ dryRun: false, switcher });

  assert.match(rowFor(report, "s1").outcome, /^failed: s1 is mid-turn/);
  assert.equal(report.failed, 1);
});

test("rebalance --session names one row and leaves every other session alone", async (t) => {
  await world(t);
  const { calls, switcher } = fakeSwitcher();

  const report = await rebalanceFleet({ dryRun: false, session: "s3", switcher });

  assert.deepEqual(report.rows.map((r) => r.session), ["s3"]);
  assert.equal(calls.length, 0, "s3 is already on the best account");
});

test("rebalance --session on a session nobody has heard of is a refusal, not an empty table", async (t) => {
  await world(t);

  const report = await rebalanceFleet({ dryRun: true, session: "nope", switcher: fakeSwitcher().switcher });

  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.skipped, [{ session: "nope", why: "no such session" }]);
  assert.equal(report.failed, 1);
});

// --- The verb itself --------------------------------------------------------

test("ms rebalance --dry-run prints the table, exits 0, and asks tmux for nothing but a reading", async (t) => {
  const w = await world(t);

  const r = run(["rebalance", "--dry-run"], w.env());
  assert.equal(r.code, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const header = lines.find((l) => l.startsWith("SESSION"))!;
  assert.ok(header, r.stdout);
  assert.deepEqual(header.trim().split(/\s{2,}/), ["SESSION", "ACCOUNT", "BETTER", "REASON", "OUTCOME"]);
  const s1 = lines.find((l) => l.startsWith("s1"))!;
  assert.ok(s1, r.stdout);
  assert.deepEqual(s1.trim().split(/\s{2,}/), ["s1", "dirk", "gmail", "imminent-wall", "would move"]);
  // s2 is named and explained. (Its state by now is reconciliation's word,
  // not the seeded one — a public verb repairs before it reports, and %9 was
  // never a pane — so the assertion is on "named, with a reason", not on
  // which reason.)
  assert.match(r.stdout, /skipped s2: the session is \w+/, `the skipped session is named and explained: ${r.stdout}`);

  // Inert: the pane was read, and nothing else was ever asked of tmux.
  const acted = logLines(w).filter((l) => /send-keys|respawn-pane|run-shell|kill/.test(l));
  assert.deepEqual(acted, [], `a dry run acted on tmux:\n${logLines(w).join("\n")}`);
});

test("ms rebalance: a command line it cannot read is exit 2 and a usage line", async (t) => {
  const w = await world(t);

  const bogus = run(["rebalance", "--nope"], w.env());
  assert.equal(bogus.code, 2, bogus.stderr);
  assert.match(bogus.stderr, /usage: ms rebalance/);

  const noValue = run(["rebalance", "--session"], w.env());
  assert.equal(noValue.code, 2, noValue.stderr);
  assert.match(noValue.stderr, /--session needs a session id/);
});

test("ms rebalance --session on an unknown session exits 1", async (t) => {
  const w = await world(t);

  const r = run(["rebalance", "--dry-run", "--session", "nope"], w.env());
  assert.equal(r.code, 1, r.stdout + r.stderr);
});
