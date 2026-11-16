import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import { lastTurnAt, launchArgv, lostServers, planRestore, restoreFlags, transcriptOf, type RestoreOptions } from "../src/restore.ts";
import { type SessionRow } from "../src/state.ts";

const DEAD = "64025:1790613772";
const SOCK = "/private/tmp/tmux-501/default";
const LOST_AT = 2_000_000;
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let seq = 0;
/** A row as reconciliation leaves one whose server died: stopped, still
 *  wanted, stamped. Each call is a later `createdAt` than the one before. */
function lost(over: Partial<SessionRow> = {}): SessionRow {
  seq++;
  return {
    id: `s${seq}`, provider: "claude", cliSessionId: ID(seq), cwd: "/work/a", socket: SOCK, pane: `%${seq}`,
    serverStart: DEAD, need: "any", account: "gmail", generation: 1, state: "stopped", desired: "running",
    flags: [], wakeupAt: null, createdAt: 1_000_000 + seq, updatedAt: LOST_AT, transcriptPath: null, rolloutOffset: 0,
    lastMoveAt: null, pinnedAccount: null, tmuxSession: "ms", windowIndex: seq, windowName: null, lostAt: LOST_AT,
    ...over,
  };
}

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
/** Everything is recent and every directory exists, unless a test says so. */
const opts = (over: Partial<RestoreOptions> = {}): RestoreOptions => ({
  sinceMs: NOW - 24 * HOUR, activity: () => NOW - HOUR, dirExists: () => true, ...over,
});

test("planRestore: nothing was ever lost with a server — an empty plan, and no server named", () => {
  const ended = lost({ lostAt: null });
  assert.deepEqual(planRestore([ended], opts()), { server: null, servers: [], items: [], skipped: [] });
});

test("planRestore: one launch per conversation, from its NEWEST row, in the window it sat in", () => {
  const first = lost({ cliSessionId: ID(900), account: "gmail", flags: ["--model", "opus"], windowIndex: 4, windowName: "old" });
  const rotated = lost({ cliSessionId: ID(900), account: "work", need: "fable", flags: ["--model", "opus", "--chrome"], tmuxSession: "repo", windowIndex: 12, windowName: "review" });
  const other = lost({ cliSessionId: ID(901), cwd: "/work/b", windowIndex: 3 });

  const plan = planRestore([first, rotated, other], opts());

  assert.deepEqual(plan.skipped, [], "a conversation's older rows are not conversations anybody is missing");
  assert.equal(plan.server!.identity, DEAD);
  assert.equal(plan.server!.rows, 3);
  assert.deepEqual(plan.items.map((i) => [i.conversation, i.row.id, i.session, i.windowIndex, i.windowName, i.need, i.cwd]), [
    [ID(901), other.id, "ms", 3, null, "any", "/work/b"],
    [ID(900), rotated.id, "repo", 12, "review", "fable", "/work/a"],
  ]);
  assert.deepEqual(plan.items[1]!.flags, ["--model", "opus", "--chrome"]);
});

test("planRestore: a row that ended, was stopped, or names no conversation is never launched — and only the last is worth a line", () => {
  const ended = lost({ lostAt: null });                       // /exit, or its pane was closed, on a live server
  const stopped = lost({ desired: "stopped" });              // `ms stop`, or superseded on its pane
  const nameless = lost({ cliSessionId: null });             // a launch that never reported an id
  const good = lost();

  const plan = planRestore([ended, stopped, nameless, good], opts());

  assert.deepEqual(plan.items.map((i) => i.row.id), [good.id]);
  assert.deepEqual(plan.skipped.map((s) => [s.row.id, s.why]), [[nameless.id, "no conversation id was ever recorded for it"]]);
});

test("planRestore: a conversation that is running again, or was brought back since, is left alone", () => {
  const a = lost({ cliSessionId: ID(910) });
  const b = lost({ cliSessionId: ID(911) });
  const c = lost({ cliSessionId: ID(912) });
  const live = lost({ id: "live", cliSessionId: ID(910), state: "running", lostAt: null, serverStart: "9:9", pane: "%3", createdAt: LOST_AT + 50 });
  const againStopped = lost({ id: "again", cliSessionId: ID(911), state: "stopped", desired: "stopped", lostAt: null, serverStart: "9:9", createdAt: LOST_AT + 60 });
  // The same conversation on an EARLIER row is history, not an answer.
  const earlier = lost({ id: "earlier", cliSessionId: ID(912), lostAt: null, serverStart: "1:1", createdAt: 5 });

  const plan = planRestore([a, b, c, live, againStopped, earlier], opts());

  assert.deepEqual(plan.items.map((i) => i.row.id), [c.id]);
  assert.deepEqual(plan.skipped.map((s) => [s.row.id, s.why]), [
    [a.id, "already running in pane %3 (session live)"],
    [b.id, "already brought back since (session again)"],
  ]);
});

test("planRestore: --since is measured on the conversation's last turn; an undated one needs --since all; a missing directory never launches", () => {
  const fresh = lost();
  const idle = lost();
  const undated = lost();
  const homeless = lost({ cwd: "/work/removed" });
  const activity = (r: SessionRow): number | null => (r.id === idle.id ? Date.UTC(2026, 9, 3, 14, 5) : r.id === undated.id ? null : NOW - HOUR);
  const dirExists = (d: string): boolean => d !== "/work/removed";

  const windowed = planRestore([fresh, idle, undated, homeless], opts({ sinceMs: NOW - 24 * HOUR, activity, dirExists }));
  assert.deepEqual(windowed.items.map((i) => i.row.id), [fresh.id]);
  assert.deepEqual(windowed.skipped.map((s) => [s.row.id, s.why]), [
    [idle.id, "idle since 2026-10-03 14:05Z"],
    [undated.id, "nothing dates its last turn (--since all restores it anyway)"],
    [homeless.id, "its directory is gone: /work/removed"],
  ]);

  const all = planRestore([fresh, idle, undated, homeless], opts({ sinceMs: null, activity, dirExists }));
  assert.deepEqual(all.items.map((i) => [i.row.id, i.lastActivity]), [[fresh.id, NOW - HOUR], [idle.id, Date.UTC(2026, 9, 3, 14, 5)], [undated.id, null]]);
  assert.deepEqual(all.skipped.map((s) => s.row.id), [homeless.id]);
});

test("planRestore: the server lost most recently is the default; --server names another; an unknown one restores nothing", () => {
  const old1 = lost({ serverStart: "111:1", lostAt: 500 });
  const old2 = lost({ serverStart: "111:1", lostAt: 510 });
  const recent = lost({ serverStart: DEAD, lostAt: LOST_AT });
  const rows = [old1, old2, recent];

  assert.deepEqual(lostServers(rows), [
    { socket: SOCK, identity: DEAD, lostAt: LOST_AT, rows: 1 },
    { socket: SOCK, identity: "111:1", lostAt: 510, rows: 2 },
  ]);
  assert.deepEqual(planRestore(rows, opts()).items.map((i) => i.row.id), [recent.id]);
  assert.deepEqual(planRestore(rows, opts({ server: "111:1" })).items.map((i) => i.row.id), [old1.id, old2.id]);
  const unknown = planRestore(rows, opts({ server: "7:7" }));
  assert.equal(unknown.server, null);
  assert.equal(unknown.servers.length, 2, "so the verb can say which ones there are");
  assert.deepEqual(unknown.items, []);
});

test("planRestore: a row written before layouts were recorded goes to the default session, after the ones with a window", () => {
  const legacy = lost({ tmuxSession: null, windowIndex: null, windowName: null });
  const placed = lost({ windowIndex: 9 });
  const plan = planRestore([legacy, placed], opts());
  assert.deepEqual(plan.items.map((i) => [i.row.id, i.session, i.windowIndex]), [[placed.id, "ms", 9], [legacy.id, "ms", null]]);
});

for (const [name, provider, flags, want] of [
  ["a recorded resume by id", "claude", ["--model", "opus", "--resume", ID(1), "--chrome"], ["--model", "opus", "--chrome"]],
  ["a bare --resume (the picker)", "claude", ["--dangerously-skip-permissions", "--resume"], ["--dangerously-skip-permissions"]],
  ["a resume by NAME", "claude", ["--model", "opus", "--resume", "nightly-ops"], ["--model", "opus"]],
  ["--resume=<id>", "claude", ["--resume=" + ID(1), "--chrome"], ["--chrome"]],
  ["-c / --continue: the most recent conversation is not this one", "claude", ["-c", "--continue", "--chrome"], ["--chrome"]],
  ["a prompt the launch began with", "claude", ["--model", "fable", "-n", "probe", "Read BRIEF.md and stop."], ["--model", "fable", "-n", "probe"]],
  ["a prompt after a flag that takes no value", "claude", ["--dangerously-skip-permissions", "fix the tests"], ["--dangerously-skip-permissions"]],
  ["a prompt after --chrome, with a real value kept elsewhere", "claude", ["--model", "opus", "--chrome", "Read BRIEF.md and stop."], ["--model", "opus", "--chrome"]],
  ["a prompt past --", "claude", ["--chrome", "--", "--not-a-flag, a prompt"], ["--chrome"]],
  ["--fork-session: the resumed id must stay the row's", "claude", ["--fork-session", "--resume", ID(1), "--verbose"], ["--verbose"]],
  ["a value after a flag that DOES take one", "claude", ["--permission-mode", "auto", "--add-dir", "../lib"], ["--permission-mode", "auto", "--add-dir", "../lib"]],
  ["codex: resume with a flag before the id", "codex", ["resume", ID(2), "--no-daemon"], ["--no-daemon"]],
] as const) {
  test(`restoreFlags: ${name} comes back as the flags alone`, () => {
    assert.deepEqual(restoreFlags(provider, [...flags]), [...want]);
  });
}

test("launchArgv: Claude resumes by the recorded id on the CLI's side of --; Codex's id travels beside the argv", () => {
  const claude = planRestore([lost({ cliSessionId: ID(920), need: "fable", flags: ["--model", "opus", "--resume"] })], opts()).items[0]!;
  assert.deepEqual(launchArgv(claude, false), ["--need", "fable", "--", "--model", "opus", "--resume", ID(920)]);
  assert.deepEqual(launchArgv(claude, true), ["--continue", "--need", "fable", "--", "--model", "opus", "--resume", ID(920)]);

  const codex = planRestore([lost({ provider: "codex", cliSessionId: ID(921), flags: ["resume", ID(921), "--no-daemon"] })], opts()).items[0]!;
  assert.deepEqual(launchArgv(codex, false), ["--", "--no-daemon"], "no --need (codex has one window) and no resume: LaunchExtras.resumeId carries it");
});

// --- the transcript readers ------------------------------------------------

const line = (o: unknown): string => JSON.stringify(o) + "\n";

test("lastTurnAt: the last MODEL turn, not the last line and not the mtime", () => {
  const { home } = tempHome();
  const f = join(home, "t.jsonl");
  writeFileSync(f,
    line({ type: "user", timestamp: "2026-11-10T08:00:00.000Z" })
    + line({ type: "assistant", timestamp: "2026-11-10T08:00:05.000Z" })
    + line({ type: "assistant", timestamp: "2026-11-12T19:30:00.000Z" })
    // What a hook or a re-render appends days later: dated, and not a turn.
    + line({ type: "system", subtype: "hook", timestamp: "2026-11-16T08:01:00.000Z" })
    + line({ type: "user", timestamp: "2026-11-16T08:01:01.000Z" })
    + "{ not json\n");
  utimesSync(f, new Date("2026-11-16T08:01:02Z"), new Date("2026-11-16T08:01:02Z"));
  assert.equal(lastTurnAt(f), Date.parse("2026-11-12T19:30:00.000Z"));
});

test("lastTurnAt: a Codex rollout's turns are found in its payloads; a transcript with no model turn in it is undated, whatever its mtime; no file is null", () => {
  const { home } = tempHome();
  const codex = join(home, "rollout.jsonl");
  writeFileSync(codex,
    line({ timestamp: "2026-11-01T10:00:00.000Z", type: "response_item", payload: { type: "message", role: "user" } })
    + line({ timestamp: "2026-11-01T10:00:09.000Z", type: "response_item", payload: { type: "message", role: "assistant" } })
    + line({ timestamp: "2026-11-01T10:00:10.000Z", type: "event_msg", payload: { type: "token_count" } }));
  assert.equal(lastTurnAt(codex), Date.parse("2026-11-01T10:00:09.000Z"));

  // What Claude Code leaves for a conversation that was named and never
  // spoken in: metadata records, some dated, touched again long afterwards.
  const bare = join(home, "bare.jsonl");
  writeFileSync(bare, line({ type: "custom-title", customTitle: "ops" }) + line({ type: "mode", mode: "auto" })
    + line({ type: "pr-link", timestamp: "2026-11-16T13:01:53.808Z" }));
  utimesSync(bare, new Date("2026-11-16T13:01:54Z"), new Date("2026-11-16T13:01:54Z"));
  assert.equal(lastTurnAt(bare), null, "a touched file is not a conversation that did something");

  assert.equal(lastTurnAt(join(home, "absent.jsonl")), null);
});

test("transcriptOf: the path the hooks reported when it is still there, else where Claude Code writes one for this directory and id", () => {
  const { home } = tempHome();
  const env = { HOME: home };
  const projects = join(home, ".claude", "projects", "-work-my-repo-v2");
  mkdirSync(projects, { recursive: true });
  const derived = join(projects, `${ID(930)}.jsonl`);
  writeFileSync(derived, "");
  const reported = join(home, "reported.jsonl");
  writeFileSync(reported, "");

  const row = lost({ cliSessionId: ID(930), cwd: "/work/my.repo_v2" });
  assert.equal(transcriptOf(row, env), derived);
  assert.equal(transcriptOf({ ...row, transcriptPath: reported }, env), reported);
  assert.equal(transcriptOf({ ...row, transcriptPath: join(home, "moved-away.jsonl") }, env), derived, "a reported path that is gone is not an answer");
  assert.equal(transcriptOf({ ...row, cliSessionId: ID(931) }, env), null);
  assert.equal(transcriptOf({ ...row, provider: "codex" }, env), null, "a Codex rollout's path is not a function of the directory");
});
