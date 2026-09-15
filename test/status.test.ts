// `ms status`: read-only tables over the coalesced snapshot, the state
// store and the event logs, cross-checked against a stubbed tmux. Pure
// helpers (accountState, earliestWeeklyReset, localTime, sessionWalled) are
// exercised directly; the verb itself is exercised end to end through the
// real `ms` binary (a subprocess, like launch.test.ts) so header/row
// formatting, --json and --watch are all proven on stdout, not inferred.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, tempHome, stubDir } from "./helpers.ts";

// --- Pure helpers ----------------------------------------------------------

test("accountState: no-token wins over everything else", async () => {
  const { accountState } = await import("../src/status.ts");
  const a = { name: "x", provider: "claude" as const, shared: false, usage: null, error: null, errorKind: null, observedAt: 0, stale: false };
  assert.equal(accountState(a, false), "no-token");
});

test("accountState: auth errors split into no-grant vs auth by message", async () => {
  const { accountState } = await import("../src/status.ts");
  const base = { name: "x", provider: "claude" as const, shared: false, usage: null, observedAt: 0, stale: true };
  assert.equal(
    accountState({ ...base, error: "no poll grant (run: ms accounts login x)", errorKind: "auth" }, true),
    "no-grant",
  );
  assert.equal(accountState({ ...base, error: "credentials missing", errorKind: "auth" }, true), "no-grant");
  assert.equal(accountState({ ...base, error: "refresh rejected: invalid_grant", errorKind: "auth" }, true), "auth");
});

test("accountState: transient (and the unclassified 'other') map to transient", async () => {
  const { accountState } = await import("../src/status.ts");
  const base = { name: "x", provider: "claude" as const, shared: false, usage: null, observedAt: 0, stale: true };
  assert.equal(accountState({ ...base, error: "502 from /api/oauth/usage", errorKind: "transient" }, true), "transient");
  assert.equal(accountState({ ...base, error: "no poller yet", errorKind: "other" }, true), "transient");
});

test("accountState: stale (no error, not refreshed this round) vs ok", async () => {
  const { accountState } = await import("../src/status.ts");
  const usage = { session: { usedPercent: 1, resetsAt: null }, weeklyAll: { usedPercent: 1, resetsAt: null }, weeklyFable: null };
  const base = { name: "x", provider: "claude" as const, shared: false, usage, error: null, errorKind: null, observedAt: 0 };
  assert.equal(accountState({ ...base, stale: true }, true), "stale");
  assert.equal(accountState({ ...base, stale: false }, true), "ok");
});

test("earliestWeeklyReset: picks the earlier of weeklyAll/weeklyFable, ignores session, null when neither weekly window exists", async () => {
  const { earliestWeeklyReset } = await import("../src/status.ts");
  assert.equal(earliestWeeklyReset(null), null);
  assert.equal(
    earliestWeeklyReset({ session: { usedPercent: 1, resetsAt: "2020-01-01T00:00:00Z" }, weeklyAll: null, weeklyFable: null }),
    null,
  );
  assert.equal(
    earliestWeeklyReset({
      session: { usedPercent: 1, resetsAt: "2020-01-01T00:00:00Z" },
      weeklyAll: { usedPercent: 1, resetsAt: "2026-09-20T00:00:00Z" },
      weeklyFable: { usedPercent: 1, resetsAt: "2026-09-18T12:30:00Z" },
    }),
    "2026-09-18T12:30:00Z",
  );
});

test("localTime: local YYYY-MM-DD HH:MM, not UTC/ISO", async () => {
  const { localTime } = await import("../src/status.ts");
  const s = localTime(Date.parse("2026-09-18T12:30:00Z"));
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const d = new Date(Date.parse("2026-09-18T12:30:00Z"));
  const pad = (n: number) => String(n).padStart(2, "0");
  assert.equal(s, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
});

test("sessionWalled: reported wins even when the screen also shows a wall", async () => {
  const { sessionWalled } = await import("../src/status.ts");
  const s = { generation: 2 } as import("../src/state.ts").SessionRow;
  assert.equal(sessionWalled(s, true, "⎿ You've hit your usage limit. New messages wait for your usage limit to reset.\n", []), "reported");
});

test("sessionWalled: no pane screen (gone) is blank", async () => {
  const { sessionWalled } = await import("../src/status.ts");
  const s = { generation: 1 } as import("../src/state.ts").SessionRow;
  assert.equal(sessionWalled(s, false, null, []), "");
});

test("sessionWalled: a screen with no wall text is blank", async () => {
  const { sessionWalled } = await import("../src/status.ts");
  const s = { generation: 1 } as import("../src/state.ts").SessionRow;
  assert.equal(sessionWalled(s, false, "❯ hi\n  ⎿  Done.\n\n❯ \n", []), "");
});

test("sessionWalled: screen wall + no recovery + no rate_limited event for THIS generation → unreported", async () => {
  const { sessionWalled } = await import("../src/status.ts");
  const s = { generation: 3 } as import("../src/state.ts").SessionRow;
  const screen = "❯ continue\n  ⎿  You've hit your usage limit. New messages wait for your usage limit to reset.\n\n❯ \n";
  assert.equal(sessionWalled(s, false, screen, []), "unreported");
  // an event for a DIFFERENT (earlier) generation does not cover this one
  const staleEvent = { t: 1, kind: "rate_limited" as const, session: "s1", generation: 2 };
  assert.equal(sessionWalled(s, false, screen, [staleEvent]), "unreported");
});

test("sessionWalled: a rate_limited event for the CURRENT generation means the provider already reported it — blank, not unreported", async () => {
  const { sessionWalled } = await import("../src/status.ts");
  const s = { generation: 3 } as import("../src/state.ts").SessionRow;
  const screen = "❯ continue\n  ⎿  You've hit your usage limit. New messages wait for your usage limit to reset.\n\n❯ \n";
  const ev = { t: 1, kind: "rate_limited" as const, session: "s1", generation: 3 };
  assert.equal(sessionWalled(s, false, screen, [ev]), "");
});

// --- The verb, end to end ---------------------------------------------------

const SAMPLE_TOKEN = "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789";
const TMUX_SOCKET = "/tmp/ms-status-test-tmux-socket";
const WALL_SCREEN = "❯ continue\n  ⎿  You've hit your usage limit. New messages wait for your usage limit to reset.\n\n❯ \n";
const CLEAR = "\x1b[2J\x1b[H";

const window_ = (percent: number, resetsAt: string) => ({ percent, resets_at: resetsAt });
const DIRK_OK = {
  limits: [
    { kind: "session", ...window_(42.5, "2026-09-16T00:00:00Z") },
    { kind: "weekly_all", ...window_(10, "2026-09-20T00:00:00Z") },
    { kind: "weekly_scoped", ...window_(33.333, "2026-09-18T12:30:00Z"), scope: { model: { display_name: "Claude Fable 5" } } },
  ],
};

/** A `--import` module that replaces global fetch for the usage endpoint,
 *  keyed by bearer token — copied from launch.test.ts's own stub. */
function usageStub(dir: string): string {
  const f = path.join(dir, "usage-stub.mjs");
  writeFileSync(
    f,
    `const table = JSON.parse(process.env.MS_TEST_USAGE || "{}");
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const auth = String((init.headers || {}).Authorization || "");
  const entry = table[auth.replace(/^Bearer /, "")] || { status: 500 };
  if (!u.includes("/api/oauth/usage")) return new Response("unexpected " + u, { status: 500 });
  const status = entry.status || 200;
  if (status !== 200) return new Response("boom", { status });
  return new Response(JSON.stringify(entry.body || {}), { status: 200, headers: { "content-type": "application/json" } });
};
`,
  );
  return pathToFileURL(f).href;
}

/** tmux as `ms status` drives it: `list-panes -a` names which panes exist;
 *  `capture-pane ... -t <pane>` (pane is always the last argv element)
 *  answers from a per-pane screen file. */
function tmuxStub(panes: string[], screens: Record<string, string>): { dir: string; env: Record<string, string> } {
  const { dir, stub } = stubDir();
  const screenFiles: Record<string, string> = {};
  for (const [pane, text] of Object.entries(screens)) {
    const f = path.join(dir, `screen-${pane.replace(/[^a-zA-Z0-9]/g, "_")}.txt`);
    writeFileSync(f, text);
    screenFiles[pane] = f;
  }
  const cases = Object.entries(screenFiles)
    .map(([pane, f]) => `    "${pane}") cat "${f}" ;;`)
    .join("\n");
  stub(
    "tmux",
    `if [ "$1" = "-S" ]; then shift 2; fi
case "$1" in
  list-panes) printf '%s\\n' ${panes.map((p) => `"${p}"`).join(" ")} ;;
  capture-pane)
    last="\${!#}"
    case "$last" in
${cases}
    esac
    ;;
esac
exit 0`,
  );
  return { dir, env: {} };
}

type World = { home: string; msHome: string };

async function world(opts: { panes: string[]; screens: Record<string, string> }): Promise<{ world: World; env: (over?: Record<string, string>) => Record<string, string> }> {
  const { home, msHome } = tempHome();
  const { dir: tmuxDir } = tmuxStub(opts.panes, opts.screens);
  const fetchStubUrl = usageStub(tmuxDir);

  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "dirk", provider: "claude", label: "Dirk", shared: false },
        { name: "gmail", provider: "claude", label: "Gmail", shared: true },
      ],
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("dirk", SAMPLE_TOKEN);
  saveLaunchToken("gmail", SAMPLE_TOKEN);

  // dirk has a working poll grant; gmail deliberately has none (no-grant).
  const dirkDir = path.join(msHome, "claude", "dirk");
  mkdirSync(dirkDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dirkDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "at-dirk", refreshToken: "rt-dirk", expiresAt: Date.now() + 86_400_000 } }),
    { mode: 0o600 },
  );
  const usageTable = { "at-dirk": { body: DIRK_OK } };

  return {
    world: { home, msHome },
    env: (over = {}) => ({
      HOME: home,
      MS_HOME: msHome,
      PATH: `${tmuxDir}:${process.env.PATH}`,
      TMUX: `${TMUX_SOCKET},123,0`,
      TMUX_PANE: "%1",
      MS_TEST_USAGE: JSON.stringify(usageTable),
      NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import ${fetchStubUrl}`,
      ...over,
    }),
  };
}

/** Two sessions in the store, on the same MS_HOME the subprocess will read:
 *  sess-1 (dirk, pane %1) has an open recovery → "reported"; sess-2 (gmail,
 *  pane %2) has no recovery and its stubbed screen reads a wall → "unreported". */
async function seedSessions(w: World): Promise<{ sess1: string; sess2: string; wakeupAt: number }> {
  process.env.HOME = w.home;
  process.env.MS_HOME = w.msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  const wakeupAt = Math.floor(Date.now() / 1000) + 3600;
  try {
    st.createSession({
      id: "sess-1", provider: "claude", cliSessionId: "cli-1", cwd: "/tmp/work1",
      socket: TMUX_SOCKET, pane: "%1", serverStart: "srv1",
      need: "any", account: "dirk", generation: 2, state: "walled", desired: "running", flags: [],
    });
    st.setWakeup("sess-1", wakeupAt);
    st.addRecovery({ sessionId: "sess-1", generation: 2, turnId: null, kind: "weekly" });

    st.createSession({
      id: "sess-2", provider: "claude", cliSessionId: "cli-2", cwd: "/tmp/work2",
      socket: TMUX_SOCKET, pane: "%2", serverStart: "srv1",
      need: "fable", account: "gmail", generation: 1, state: "running", desired: "running", flags: [],
    });
  } finally {
    st.close();
  }
  return { sess1: "sess-1", sess2: "sess-2", wakeupAt };
}

/** Cells of a rendered table line, split on runs of 2+ spaces (our column
 *  separator is exactly two, and padding only ever adds more). */
const cells = (line: string): string[] => line.trim().split(/\s{2,}/);

test("ms status: accounts table (NAME LABEL 5H WEEK FABLE RESETS STATE) and sessions table, with the unreported flag", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);
  const { localTime } = await import("../src/status.ts");

  const r = run(["status"], env());
  assert.equal(r.code, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const accHeaderIdx = lines.findIndex((l) => l.startsWith("NAME"));
  assert.ok(accHeaderIdx >= 0, r.stdout);
  assert.deepEqual(cells(lines[accHeaderIdx]!), ["NAME", "LABEL", "5H", "WEEK", "FABLE", "RESETS", "STATE"]);

  const dirkLine = lines.find((l) => l.startsWith("dirk"))!;
  assert.ok(dirkLine, r.stdout);
  assert.deepEqual(cells(dirkLine), [
    "dirk", "Dirk", "42.5%", "10%", "33.3%", localTime(Date.parse("2026-09-18T12:30:00Z")), "ok",
  ]);

  const gmailLine = lines.find((l) => l.startsWith("gmail"))!;
  assert.ok(gmailLine, r.stdout);
  const gmailCells = cells(gmailLine);
  assert.equal(gmailCells[0], "gmail");
  assert.equal(gmailCells[1], "Gmail");
  assert.equal(gmailCells[2], "—"); // no poll grant → no reading
  assert.equal(gmailCells[6], "no-grant");

  const sessHeaderIdx = lines.findIndex((l) => l.startsWith("SESSION"));
  assert.ok(sessHeaderIdx >= 0, r.stdout);
  assert.deepEqual(cells(lines[sessHeaderIdx]!), [
    "SESSION", "PANE", "ACCOUNT", "NEED", "STATE", "GEN", "PENDING", "WAKEUP", "WALLED?",
  ]);

  // sess-1: an open recovery, so WALLED? is "reported" even though its own
  // stubbed screen also reads a wall — the recovery wins.
  const s1 = lines.find((l) => l.startsWith("sess-1"))!;
  assert.ok(s1, r.stdout);
  const s1Cells = cells(s1);
  assert.equal(s1Cells[0], "sess-1");
  assert.equal(s1Cells[1], "%1");
  assert.equal(s1Cells[2], "dirk");
  assert.equal(s1Cells[3], "any");
  assert.equal(s1Cells[4], "walled");
  assert.equal(s1Cells[5], "2");
  assert.equal(s1Cells[6], "pending");
  assert.match(s1Cells[7]!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(s1Cells[8], "reported");

  // sess-2: no recovery, no rate_limited event for generation 1, but its
  // screen reads a wall — the provider never said so: unreported.
  const s2 = lines.find((l) => l.startsWith("sess-2"))!;
  assert.ok(s2, r.stdout);
  const s2Cells = cells(s2);
  assert.equal(s2Cells[0], "sess-2");
  assert.equal(s2Cells[1], "%2");
  assert.equal(s2Cells[2], "gmail");
  assert.equal(s2Cells[3], "fable");
  assert.equal(s2Cells[4], "running");
  assert.equal(s2Cells[5], "1");
  assert.equal(s2Cells[6], "—"); // no pending recovery
  assert.equal(s2Cells[7], "—"); // no wakeup scheduled
  assert.equal(s2Cells[8], "unreported");
});

test("ms status --json prints { accounts, sessions, takenAt } and parses", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);

  const r = run(["status", "--json"], env());
  assert.equal(r.code, 0, r.stderr);

  const parsed = JSON.parse(r.stdout) as { accounts: unknown[]; sessions: { id: string; account: string }[]; takenAt: number };
  assert.equal(Object.keys(parsed).sort().join(","), "accounts,sessions,takenAt");
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.sessions.length, 2);
  assert.ok(parsed.sessions.some((s) => s.id === "sess-1" && s.account === "dirk"));
  assert.ok(parsed.sessions.some((s) => s.id === "sess-2" && s.account === "gmail"));
  assert.ok(Number.isFinite(parsed.takenAt) && parsed.takenAt > 0);
});

test("ms status --watch clears the screen and redraws exactly once when bounded", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);

  const r = run(["status", "--watch"], env({ MS_WATCH_ITERATIONS: "1", MS_WATCH_MS: "50000" }));
  assert.equal(r.code, 0, r.stderr);

  const occurrences = r.stdout.split(CLEAR).length - 1;
  assert.equal(occurrences, 1, r.stdout);
  assert.ok(r.stdout.includes("NAME"), r.stdout);
  assert.ok(r.stdout.includes("SESSION"), r.stdout);
});

test("ms status: a session whose pane no longer exists shows STATE gone, with no WALLED? flag", async () => {
  // %2 is deliberately left out of `list-panes` — sess-2's pane is gone.
  const { world: w, env } = await world({ panes: ["%1"], screens: { "%1": "" } });
  await seedSessions(w);

  const r = run(["status"], env());
  assert.equal(r.code, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const s2 = lines.find((l) => l.startsWith("sess-2"))!;
  assert.ok(s2, r.stdout);
  const s2Cells = cells(s2);
  assert.equal(s2Cells[4], "gone");
  // WALLED? is blank for a gone pane; as the last column, a blank trailing
  // cell doesn't survive the table renderer's trailing-space trim, so the
  // row simply has no ninth cell at all.
  assert.equal(s2Cells[8] ?? "", "");

  // sess-1's pane is still there and unaffected.
  const s1 = lines.find((l) => l.startsWith("sess-1"))!;
  assert.equal(cells(s1)[4], "walled");
});

test("ms status: an unreadable registry prints its parse error as the first line", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);

  writeFileSync(path.join(w.msHome, "accounts.json"), "{ not json");
  const r = run(["status"], env());
  assert.equal(r.code, 0, r.stderr);
  const first = r.stdout.split("\n")[0]!;
  assert.match(first, /^accounts\.json:.*\(JSON\)/);
  // The accounts table header still follows it — an unreadable registry is
  // named, not a crash — even though src/snapshot.ts's `only=null` scope
  // reads as "no known accounts" here (there is nothing to poll for and
  // nothing this run can vouch is still registered).
  assert.ok(r.stdout.includes("NAME"), r.stdout);
});
