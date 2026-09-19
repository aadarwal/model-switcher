// `ms status`: read-only tables over the coalesced snapshot, the state
// store and the event logs, cross-checked against a stubbed tmux. Pure
// helpers (accountState, earliestWeeklyResetCli, localTimeCli, sessionWalled) are
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

test("accountState: no-token can never apply to a codex row — there is no separate launch grant to be missing", async () => {
  const { accountState } = await import("../src/status.ts");
  const a = { name: "x", provider: "codex" as const, shared: false, usage: null, error: null, errorKind: null, observedAt: 0, stale: false };
  // Even with hasToken=false (a claude-shaped question that does not apply
  // to codex at all), the row reads exactly as it would with hasToken=true:
  // no error, not stale → ok.
  assert.equal(accountState(a, false), "ok");
  assert.notEqual(accountState(a, false), "no-token");
});

test("accountState: codex's own missing-credential message ('no credentials …') reads as no-grant, same as claude's", async () => {
  const { accountState } = await import("../src/status.ts");
  const base = { name: "x", provider: "codex" as const, shared: false, usage: null, observedAt: 0, stale: true };
  assert.equal(
    accountState({ ...base, error: "no credentials (ms accounts login x)", errorKind: "auth" }, true),
    "no-grant",
  );
  // A live credential the endpoint itself refused is still plain `auth`.
  assert.equal(
    accountState({ ...base, error: "401 from wham/usage", errorKind: "auth" }, true),
    "auth",
  );
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

test("earliestWeeklyResetCli: picks the earlier of weeklyAll/weeklyFable, ignores session, null when neither weekly window exists", async () => {
  const { earliestWeeklyResetCli } = await import("../src/status.ts");
  assert.equal(earliestWeeklyResetCli(null), null);
  assert.equal(
    earliestWeeklyResetCli({ session: { usedPercent: 1, resetsAt: "2020-01-01T00:00:00Z" }, weeklyAll: null, weeklyFable: null }),
    null,
  );
  assert.equal(
    earliestWeeklyResetCli({
      session: { usedPercent: 1, resetsAt: "2020-01-01T00:00:00Z" },
      weeklyAll: { usedPercent: 1, resetsAt: "2026-09-20T00:00:00Z" },
      weeklyFable: { usedPercent: 1, resetsAt: "2026-09-18T12:30:00Z" },
    }),
    "2026-09-18T12:30:00Z",
  );
});

test("localTimeCli: local YYYY-MM-DD HH:MM, not UTC/ISO", async () => {
  const { localTimeCli } = await import("../src/status.ts");
  const s = localTimeCli(Date.parse("2026-09-18T12:30:00Z"));
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

test("sessionWalled: a Codex session's own wall text reads unreported when no rate_limited event backs it up (the trigger is the rollout record, never the screen)", async () => {
  const { sessionWalled } = await import("../src/status.ts");
  const s = { generation: 1 } as import("../src/state.ts").SessionRow;
  const screen =
    "❯ continue\n" +
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.\n\n" +
    "❯ \n";
  assert.equal(sessionWalled(s, false, screen, []), "unreported");
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

/** wham/usage's own shape (`src/providers/codex-usage.ts`'s `toWindow`): no
 *  `primary_window` at all (its only window is the 168 h one, classified by
 *  comes back (the spike record) — so `fmtPercentCli` renders 5H as "—", not
 *  "0%". `weeklyFable` has no source field on Codex at all and is always
 *  null regardless of what the endpoint returns. */
const CODEX_OK = {
  rate_limit: {
    secondary_window: { used_percent: 12.5, reset_at: Math.floor(Date.parse("2026-09-20T00:00:00Z") / 1000), reset_after_seconds: 300000, limit_window_seconds: 604800 },
  },
};

/** A `--import` module that replaces global fetch for both usage endpoints
 *  (Claude's `/api/oauth/usage` and Codex's `/backend-api/wham/usage`),
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
  if (!u.includes("/api/oauth/usage") && !u.includes("/backend-api/wham/usage")) return new Response("unexpected " + u, { status: 500 });
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
  // An account with no credentials file falls back to its scoped keychain
  // item, so `security` is stubbed too: 44 is errSecItemNotFound, and these
  // tests must never reach the real keychain.
  stub("security", "exit 44");
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

test("ms status: accounts table (NAME PROVIDER LABEL 5H WEEK FABLE RESETS STATE SESS) and sessions table, with the unreported flag", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);
  const { localTimeCli } = await import("../src/status.ts");

  const r = run(["status"], env());
  assert.equal(r.code, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const accHeaderIdx = lines.findIndex((l) => l.startsWith("NAME"));
  assert.ok(accHeaderIdx >= 0, r.stdout);
  assert.deepEqual(cells(lines[accHeaderIdx]!), ["NAME", "PROVIDER", "LABEL", "5H", "WEEK", "FABLE", "RESETS", "STATE", "SESS"]);

  const dirkLine = lines.find((l) => l.startsWith("dirk"))!;
  assert.ok(dirkLine, r.stdout);
  assert.deepEqual(cells(dirkLine), [
    "dirk", "claude", "Dirk", "42.5%", "10%", "33.3%", localTimeCli(Date.parse("2026-09-18T12:30:00Z")), "ok", "1",
  ]); // SESS 1: seedSessions() put sess-1 (walled, still live) on dirk

  const gmailLine = lines.find((l) => l.startsWith("gmail"))!;
  assert.ok(gmailLine, r.stdout);
  const gmailCells = cells(gmailLine);
  assert.equal(gmailCells[0], "gmail");
  assert.equal(gmailCells[1], "claude");
  assert.equal(gmailCells[2], "Gmail");
  assert.equal(gmailCells[3], "—"); // no poll grant → no reading
  assert.equal(gmailCells[7], "no-grant");
  assert.equal(gmailCells[8], "1"); // sess-2 runs on gmail

  const sessHeaderIdx = lines.findIndex((l) => l.startsWith("SESSION"));
  assert.ok(sessHeaderIdx >= 0, r.stdout);
  assert.deepEqual(cells(lines[sessHeaderIdx]!), [
    "SESSION", "PANE", "PROVIDER", "ACCOUNT", "NEED", "STATE", "GEN", "PENDING", "WAKEUP", "WALLED?",
  ]);

  // sess-1: an open recovery, so WALLED? is "reported" even though its own
  // stubbed screen also reads a wall — the recovery wins.
  const s1 = lines.find((l) => l.startsWith("sess-1"))!;
  assert.ok(s1, r.stdout);
  const s1Cells = cells(s1);
  assert.equal(s1Cells[0], "sess-1");
  assert.equal(s1Cells[1], "%1");
  assert.equal(s1Cells[2], "claude");
  assert.equal(s1Cells[3], "dirk");
  assert.equal(s1Cells[4], "any");
  assert.equal(s1Cells[5], "walled");
  assert.equal(s1Cells[6], "2");
  assert.equal(s1Cells[7], "pending");
  assert.match(s1Cells[8]!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(s1Cells[9], "reported");

  // sess-2: no recovery, no rate_limited event for generation 1, but its
  // screen reads a wall — the provider never said so: unreported.
  const s2 = lines.find((l) => l.startsWith("sess-2"))!;
  assert.ok(s2, r.stdout);
  const s2Cells = cells(s2);
  assert.equal(s2Cells[0], "sess-2");
  assert.equal(s2Cells[1], "%2");
  assert.equal(s2Cells[2], "claude");
  assert.equal(s2Cells[3], "gmail");
  assert.equal(s2Cells[4], "fable");
  assert.equal(s2Cells[5], "running");
  assert.equal(s2Cells[6], "1");
  assert.equal(s2Cells[7], "—"); // no pending recovery
  assert.equal(s2Cells[8], "—"); // no wakeup scheduled
  assert.equal(s2Cells[9], "unreported");
});

test("ms status: a Codex account row renders — for FABLE and a missing 5H window and never no-token; a Codex session with the wall on screen and no rate_limited event reads unreported", async () => {
  const { home, msHome } = tempHome();
  const CODEX_WALL_SCREEN =
    "❯ continue\n" +
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.\n\n" +
    "❯ \n";
  const { dir: tmuxDir } = tmuxStub(["%3"], { "%3": CODEX_WALL_SCREEN });
  const fetchStubUrl = usageStub(tmuxDir);

  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [{ name: "codexacct", provider: "codex", label: "CodexAcct", shared: false }],
    }),
    { mode: 0o600 },
  );

  // The Pro-plan shape from the spike record: no primary_window at all (5H
  // has nothing to show), a secondary (weekly) window that does.
  const CODEX_ACCESS_TOKEN = "SEKRET-STATUS-TOKEN";
  const codexDir = path.join(msHome, "codex", "codexacct");
  mkdirSync(codexDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(codexDir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id-codexacct", access_token: CODEX_ACCESS_TOKEN, refresh_token: "rt-codexacct", account_id: "acct-codex-1" },
      last_refresh: new Date().toISOString(), // fresh: no refresh attempted, no network call beyond the usage read
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  try {
    st.createSession({
      id: "sess-3", provider: "codex", cliSessionId: "cli-3", cwd: "/tmp/work3",
      socket: TMUX_SOCKET, pane: "%3", serverStart: "srv1",
      need: "any", account: "codexacct", generation: 1, state: "running", desired: "running", flags: [],
    });
  } finally {
    st.close();
  }

  const env = {
    HOME: home,
    MS_HOME: msHome,
    PATH: `${tmuxDir}:${process.env.PATH}`,
    TMUX: `${TMUX_SOCKET},123,0`,
    TMUX_PANE: "%1",
    MS_TEST_USAGE: JSON.stringify({ [CODEX_ACCESS_TOKEN]: { body: CODEX_OK } }),
    NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import ${fetchStubUrl}`,
  };

  const r = run(["status"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(CODEX_ACCESS_TOKEN), `token leaked in table output: ${r.stdout}`);
  assert.ok(!r.stderr.includes(CODEX_ACCESS_TOKEN), `token leaked in stderr: ${r.stderr}`);

  const lines = r.stdout.split("\n");
  const codexLine = lines.find((l) => l.startsWith("codexacct"))!;
  assert.ok(codexLine, r.stdout);
  const cCells = cells(codexLine);
  assert.equal(cCells[0], "codexacct");
  assert.equal(cCells[1], "codex");
  assert.equal(cCells[2], "CodexAcct");
  assert.equal(cCells[3], "—"); // 5H: no primary_window on this plan
  assert.equal(cCells[5], "—"); // FABLE: codex has no fable-scoped window at all
  assert.equal(cCells[7], "ok"); // a healthy read — never no-token, never no-grant

  const sess3 = lines.find((l) => l.startsWith("sess-3"))!;
  assert.ok(sess3, r.stdout);
  const s3Cells = cells(sess3);
  assert.equal(s3Cells[2], "codex"); // PROVIDER
  assert.equal(s3Cells[3], "codexacct"); // ACCOUNT
  assert.equal(s3Cells[s3Cells.length - 1], "unreported");

  // --json is a second, independent render path (JSON.stringify over the
  // snapshot/session rows, not the table) — prove it separately rather than
  // assuming the table's leak-freedom says anything about it.
  const rJson = run(["status", "--json"], env);
  assert.equal(rJson.code, 0, rJson.stderr);
  assert.ok(!rJson.stdout.includes(CODEX_ACCESS_TOKEN), `token leaked in --json output: ${rJson.stdout}`);
  assert.ok(!rJson.stderr.includes(CODEX_ACCESS_TOKEN), `token leaked in --json stderr: ${rJson.stderr}`);
  const parsed = JSON.parse(rJson.stdout) as { accounts: { name: string }[] };
  assert.ok(parsed.accounts.some((a) => a.name === "codexacct"), rJson.stdout);
});

test("ms status: a Codex account with no auth.json reads STATE no-grant through the REAL snapshot poll — pollCodexUsage's own 'no credentials' AuthError, not a hand-written accountState call", async () => {
  const { home, msHome } = tempHome();
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [{ name: "codexnogrant", provider: "codex", label: "CodexNoGrant", shared: false }],
    }),
    { mode: 0o600 },
  );
  // Deliberately no `codex/codexnogrant/auth.json` at all — not even the
  // home directory — exactly the state of a row `accounts add --provider
  // codex` created that has never been through `login`. No sessions exist
  // either, so this needs no tmux stub and (Codex has no keychain fallback)
  // no `security` stub — the account poll is the only thing this test does.

  const r = run(["status"], { HOME: home, MS_HOME: msHome });
  assert.equal(r.code, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const codexLine = lines.find((l) => l.startsWith("codexnogrant"))!;
  assert.ok(codexLine, r.stdout);
  const cCells = cells(codexLine);
  assert.equal(cCells[0], "codexnogrant");
  assert.equal(cCells[1], "codex");
  assert.equal(cCells[7], "no-grant");
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

// --- Review round 1 (P4-T2), finding 1: LABEL/PENDING/WALLED? additive ----
//
// `ms status --json` used to hand back the raw AccountUsage/SessionRow the
// snapshot and the store keep, with none of the derived words the TABLE
// renders (LABEL, STATE, PENDING, WALLED?) — a consumer of the JSON (the
// dashboard page) had no choice but to re-derive them, badly (finding 2:
// its copy never checked `hasToken`, so a token-less account read "ok").
// These fields are additive — the existing keys above are untouched — and
// computed by the exact same helpers the table itself calls, so the two
// views can never drift.

test("ms status --json: each account row also carries LABEL and STATE — the exact words the table prints, not the raw snapshot row", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);

  const r = run(["status", "--json"], env());
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { accounts: { name: string; label: string; state: string }[] };

  const dirk = parsed.accounts.find((a) => a.name === "dirk")!;
  assert.equal(dirk.label, "Dirk");
  assert.equal(dirk.state, "ok"); // matches the table's own "dirk" row above

  const gmail = parsed.accounts.find((a) => a.name === "gmail")!;
  assert.equal(gmail.label, "Gmail");
  assert.equal(gmail.state, "no-grant"); // matches the table's own "gmail" row above
});

test("ms status --json: each session row also carries PENDING and WALLED? — null/\"\" where the table prints \"—\", not just the raw store row", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);

  const r = run(["status", "--json"], env());
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { sessions: { id: string; pending: string | null; walled: string }[] };

  // sess-1: an open recovery → "pending" / "reported" (matches the table's
  // own sess-1 row above, where an open recovery wins even though the
  // stubbed screen also reads a wall).
  const s1 = parsed.sessions.find((s) => s.id === "sess-1")!;
  assert.equal(s1.pending, "pending");
  assert.equal(s1.walled, "reported");

  // sess-2: no recovery, no matching rate_limited event, but its screen
  // reads a wall → null pending, "unreported" (matches the table's own
  // sess-2 row above).
  const s2 = parsed.sessions.find((s) => s.id === "sess-2")!;
  assert.equal(s2.pending, null);
  assert.equal(s2.walled, "unreported");
});

test("ms status --json: finding 2 — a Claude account with no launch token reads STATE no-token, never ok", async () => {
  const { home, msHome } = tempHome();
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ name: "notoken", provider: "claude", label: "NoToken", shared: false }] }),
    { mode: 0o600 },
  );
  // Deliberately no saveLaunchToken() call and no poll-grant credentials
  // dir — exactly the state of an account `ms accounts add` registered but
  // neither `ms accounts login` nor `anu account add` has ever touched.

  const r = run(["status", "--json"], { HOME: home, MS_HOME: msHome });
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { accounts: { name: string; state: string }[] };
  const acct = parsed.accounts.find((a) => a.name === "notoken")!;
  assert.equal(acct.state, "no-token");
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

test("ms status --watch actually loops: MS_WATCH_ITERATIONS=2 redraws twice, not once", async () => {
  const { world: w, env } = await world({ panes: ["%1", "%2"], screens: { "%1": WALL_SCREEN, "%2": WALL_SCREEN } });
  await seedSessions(w);

  const r = run(["status", "--watch"], env({ MS_WATCH_ITERATIONS: "2", MS_WATCH_MS: "20" }));
  assert.equal(r.code, 0, r.stderr);

  // A single-print implementation (the loop body deleted, or run once and
  // exiting) would print one CLEAR and one header no matter what
  // MS_WATCH_ITERATIONS says — this only passes when the loop truly ran
  // twice.
  const occurrences = r.stdout.split(CLEAR).length - 1;
  assert.equal(occurrences, 2, r.stdout);
  // The CLEAR sequence and the redraw's first line share one line (no
  // newline between them), so "starts with NAME" per split("\n") line only
  // matches the SECOND redraw onward — count occurrences in the raw text
  // instead.
  const headerCount = (r.stdout.match(/NAME\s+PROVIDER\s+LABEL\s+5H\s+WEEK\s+FABLE\s+RESETS\s+STATE\s+SESS/g) ?? []).length;
  assert.equal(headerCount, 2, r.stdout);
  const sessionHeaderCount = (r.stdout.match(/SESSION\s+PANE\s+PROVIDER\s+ACCOUNT\s+NEED\s+STATE\s+GEN\s+PENDING\s+WAKEUP\s+WALLED\?/g) ?? []).length;
  assert.equal(sessionHeaderCount, 2, r.stdout);
});

test("ms status: a session whose pane no longer exists shows STATE gone, with no WALLED? flag", async () => {
  // %2 is deliberately left out of `list-panes` — sess-2's pane is gone.
  // Finding F6: a gone row is hidden by default, so this reads it with
  // --all — the word itself, not the default-hide rule, is the point here.
  const { world: w, env } = await world({ panes: ["%1"], screens: { "%1": "" } });
  await seedSessions(w);

  const r = run(["status", "--all"], env());
  assert.equal(r.code, 0, r.stderr);

  const lines = r.stdout.split("\n");
  const s2 = lines.find((l) => l.startsWith("sess-2"))!;
  assert.ok(s2, r.stdout);
  const s2Cells = cells(s2);
  assert.equal(s2Cells[5], "gone");
  // WALLED? is blank for a gone pane; as the last column, a blank trailing
  // cell doesn't survive the table renderer's trailing-space trim, so the
  // row simply has no tenth cell at all.
  assert.equal(s2Cells[9] ?? "", "");

  // sess-1's pane is still there and unaffected.
  const s1 = lines.find((l) => l.startsWith("sess-1"))!;
  assert.equal(cells(s1)[5], "walled");
});

test("ms status --json: a gone pane's JSON state is the same word the text table prints (fix-C-report.md item 1)", async () => {
  // %2 is deliberately left out of `list-panes` — sess-2's pane is gone,
  // exactly as in the text-table test above. Its store STATE is "running"
  // (seedSessions), so a fix that only patches the text table's own
  // `sessionRow` — and not `statusJson`'s `computeSession` application —
  // would print "gone" in one place and "running" in the other for the
  // same closed pane. Finding F6: a gone row is hidden by default, so this
  // reads it with --all.
  const { world: w, env } = await world({ panes: ["%1"], screens: { "%1": "" } });
  await seedSessions(w);

  const r = run(["status", "--json", "--all"], env());
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { sessions: { id: string; state: string }[] };
  const s2 = parsed.sessions.find((s) => s.id === "sess-2")!;
  assert.ok(s2, r.stdout);
  assert.equal(s2.state, "gone");

  // sess-1's pane is still there and unaffected.
  const s1 = parsed.sessions.find((s) => s.id === "sess-1")!;
  assert.equal(s1.state, "walled");
});

// --- Finding F6: gone/stopped sessions hidden by default -------------------
//
// `/api/state` and `ms status` used to list every session the store had ever
// recorded — 17 `gone` rows before one run, 20 after. `ms status` now hides
// `gone` and `stopped` rows by default and shows them with `--all`;
// `/api/state` itself is UNCHANGED (see test/dashboard-api.test.ts's own GET
// /api/state test — statusJson() is not touched here at all), because the
// dashboard page filters client-side over that same, still-complete json
// (test/dashboard-client.test.ts's isFinishedSession/visibleSessions tests).

test("ms status: gone and stopped sessions are hidden by default, and --all shows them", async () => {
  // %2 is left out of list-panes (the same fixture shape as the "gone" tests
  // above), so sess-2 reads STATE gone; sess-3 is created directly in state
  // "stopped" — the other word --all is the escape hatch for.
  const { world: w, env } = await world({ panes: ["%1"], screens: { "%1": WALL_SCREEN } });
  await seedSessions(w);
  const { openState } = await import("../src/state.ts");
  const st = openState();
  try {
    st.createSession({
      id: "sess-3", provider: "claude", cliSessionId: "cli-3", cwd: "/tmp/work3",
      socket: TMUX_SOCKET, pane: "", serverStart: "srv1",
      need: "any", account: "dirk", generation: 1, state: "stopped", desired: "stopped", flags: [],
    });
  } finally {
    st.close();
  }

  const r = run(["status"], env());
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.ok(lines.some((l) => l.startsWith("sess-1")), r.stdout);
  assert.ok(!lines.some((l) => l.startsWith("sess-2")), `a gone session shown by default: ${r.stdout}`);
  assert.ok(!lines.some((l) => l.startsWith("sess-3")), `a stopped session shown by default: ${r.stdout}`);

  const rAll = run(["status", "--all"], env());
  assert.equal(rAll.code, 0, rAll.stderr);
  const allLines = rAll.stdout.split("\n");
  assert.ok(allLines.some((l) => l.startsWith("sess-1")), rAll.stdout);
  assert.ok(allLines.some((l) => l.startsWith("sess-2")), `--all did not show the gone session: ${rAll.stdout}`);
  assert.ok(allLines.some((l) => l.startsWith("sess-3")), `--all did not show the stopped session: ${rAll.stdout}`);
});

test("ms status --json: gone/stopped are hidden by default and included with --all, the same two words the text table uses", async () => {
  const { world: w, env } = await world({ panes: ["%1"], screens: { "%1": WALL_SCREEN } });
  await seedSessions(w);
  const { openState } = await import("../src/state.ts");
  const st = openState();
  try {
    st.createSession({
      id: "sess-3", provider: "claude", cliSessionId: "cli-3", cwd: "/tmp/work3",
      socket: TMUX_SOCKET, pane: "", serverStart: "srv1",
      need: "any", account: "dirk", generation: 1, state: "stopped", desired: "stopped", flags: [],
    });
  } finally {
    st.close();
  }

  const r = run(["status", "--json"], env());
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { sessions: { id: string; state: string }[] };
  assert.deepEqual(parsed.sessions.map((s) => s.id).sort(), ["sess-1"]);

  const rAll = run(["status", "--json", "--all"], env());
  assert.equal(rAll.code, 0, rAll.stderr);
  const parsedAll = JSON.parse(rAll.stdout) as { sessions: { id: string; state: string }[] };
  assert.deepEqual(parsedAll.sessions.map((s) => s.id).sort(), ["sess-1", "sess-2", "sess-3"]);
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

// --- STATE: no room (0.2.5) ------------------------------------------------

test("accountState: a codex account whose only weekly window reads 100 is 'no room', not 'ok' — the same gate pick.ts applies", async () => {
  const { accountState } = await import("../src/status.ts");
  const row = (weekly: number) => ({
    name: "home", provider: "codex" as const, shared: false,
    usage: { session: null, weeklyAll: { usedPercent: weekly, resetsAt: "2026-09-20T00:00:00Z" }, weeklyFable: null },
    error: null, errorKind: null, observedAt: Date.now(), stale: false,
  });
  assert.equal(accountState(row(100), true), "no room");
  assert.equal(accountState(row(99), true), "ok");
});

test("accountState: a claude 5h window at 100 is 'no room' too, and a full FABLE window is not — the chooser only gates on fable for --need fable", async () => {
  const { accountState } = await import("../src/status.ts");
  const base = {
    name: "gmail", provider: "claude" as const, shared: false,
    error: null, errorKind: null, observedAt: Date.now(), stale: false,
  };
  const w = (p: number) => ({ usedPercent: p, resetsAt: "2026-09-20T00:00:00Z" });
  assert.equal(accountState({ ...base, usage: { session: w(100), weeklyAll: w(10), weeklyFable: null } }, true), "no room");
  assert.equal(accountState({ ...base, usage: { session: w(10), weeklyAll: w(100), weeklyFable: null } }, true), "no room");
  // Fable at 100 with room in the windows every run gates on: still runnable.
  assert.equal(accountState({ ...base, usage: { session: w(10), weeklyAll: w(10), weeklyFable: w(100) } }, true), "ok");
});

test("accountState: 'no room' replaces ok and nothing else — a missing launch token, a dead grant and a stale reading all still win", async () => {
  const { accountState } = await import("../src/status.ts");
  const w = (p: number) => ({ usedPercent: p, resetsAt: null });
  const full = { session: w(100), weeklyAll: w(100), weeklyFable: null };
  const base = { name: "gmail", provider: "claude" as const, shared: false, usage: full, observedAt: Date.now() };
  assert.equal(accountState({ ...base, error: null, errorKind: null, stale: false }, false), "no-token");
  assert.equal(accountState({ ...base, error: "refresh rejected", errorKind: "auth", stale: false }, true), "auth");
  assert.equal(accountState({ ...base, error: "timeout", errorKind: "transient", stale: false }, true), "transient");
  assert.equal(accountState({ ...base, error: null, errorKind: null, stale: true }, true), "stale");
});
