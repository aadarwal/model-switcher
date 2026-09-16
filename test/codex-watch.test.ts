import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

// `ms _codex_watch` is exercised IN PROCESS, not through `bin/ms` like the
// hook: the fixture is a rollout file the test appends to between passes, and
// the assertions are about what the store looks like afterwards. tmux is still
// a real subprocess against a stub on PATH. Nothing here touches the network,
// the real `~/.codex`, or the real `~/.config/model-switcher`.

const SOCKET = "/private/tmp/tmux-501/default";
const MS_BIN = "/opt/homebrew/bin/ms";
const NOW = () => Math.floor(Date.now() / 1000);

/** A rollout line, in the shape and spelling Codex 0.153.4 persists (snake_case,
 * `event_msg` wrapper, `task_complete` payload). A successful turn writes the
 * same record with `error` absent. */
function taskComplete(turnId: string, error: string | null): string {
  const payload: Record<string, unknown> = { type: "task_complete", turn_id: turnId, last_agent_message: error ? null : "done" };
  if (error) payload.error = { message: "You've hit your usage limit.", codex_error_info: error };
  return JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload });
}
/** Anything else in the rollout: turn context, messages, reasoning. */
const noise = (n: number) => JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "agent_message", message: `m${n}` } });

type Ev = Record<string, unknown>;

/** The snapshot cache file, exactly as `writeCache` leaves it. No poller ever
 * runs in these tests: the watchdog reads this file and nothing else. */
function seedSnapshot(msHome: string, rows: { name: string; provider: string; percent: number }[]): void {
  writeFileSync(path.join(msHome, "snapshot.json"), JSON.stringify({
    takenAt: Date.now(),
    backoff: {},
    accounts: rows.map((r) => ({
      name: r.name, provider: r.provider, shared: false, error: null, errorKind: null, observedAt: Date.now(), stale: false,
      usage: { session: { usedPercent: r.percent, resetsAt: null }, weeklyAll: { usedPercent: 0, resetsAt: null }, weeklyFable: null },
    })),
  }) + "\n", { mode: 0o600 });
}

async function world(opts: { rows?: Record<string, unknown>[]; events?: Record<string, Ev[]>; rollouts?: Record<string, string[]>; autorotate?: boolean; hot?: { name: string; provider: string; percent: number }[] } = {}) {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const tlog = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${tlog}"; exit 0`);

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.MS_BIN = MS_BIN;
  process.env.PATH = `${dir}:${process.env.PATH}`;
  if (opts.autorotate) process.env.MS_CODEX_AUTOROTATE = "1";
  else delete process.env.MS_CODEX_AUTOROTATE;

  const rollout = (id: string) => path.join(home, `rollout-${id}.jsonl`);
  for (const [id, lines] of Object.entries(opts.rollouts ?? { s1: [] })) {
    writeFileSync(rollout(id), lines.length ? lines.join("\n") + "\n" : "");
  }

  const { openState } = await import("../src/state.ts");
  const st = openState();
  if (opts.hot) seedSnapshot(msHome, opts.hot);
  for (const row of opts.rows ?? [{ id: "s1" }]) {
    const id = String(row.id);
    st.createSession({ id, provider: "codex", cliSessionId: `cx-${id}`, cwd: "/tmp", socket: SOCKET, pane: "%7", serverStart: "1",
      need: "any", account: "dirk", generation: 2, state: "running", desired: "running", flags: [], ...row } as Parameters<typeof st.createSession>[0]);
    if (existsSync(rollout(id))) st.updateSession(id, { transcriptPath: rollout(id) });
  }
  st.close();

  const { appendEvent } = await import("../src/events.ts");
  const evs = opts.events ?? { s1: [{ t: NOW(), kind: "activity", session: "s1", generation: 2, turnId: "t-1" }] };
  for (const list of Object.values(evs)) for (const e of list) appendEvent(e as Parameters<typeof appendEvent>[0]);

  return { home, msHome, tlog, openState, rollout };
}

function events(msHome: string, session = "s1"): Ev[] {
  const f = path.join(msHome, "sessions", session, "events.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}
const tmuxLog = (tlog: string) => (existsSync(tlog) ? readFileSync(tlog, "utf8") : "");
/** How many timers were armed at a given interval. The default is the SLOW
 * one: `world` seeds no snapshot cache unless asked, and no reading means no
 * evidence that anything is near a wall. */
const rearms = (tlog: string, seconds = 120) =>
  (tmuxLog(tlog).match(new RegExp(`run-shell -b -d ${seconds} '.*ms' '_codex_watch'`, "g")) ?? []).length;

async function watch(): Promise<number> {
  const { codexWatch } = await import("../src/hooks/codex-hook.ts");
  return codexWatch();
}
async function row(openState: () => { getSession: (id: string) => unknown; close: () => void }, id = "s1") {
  const st = openState();
  try { return st.getSession(id) as Record<string, unknown> | null; } finally { st.close(); }
}

test("a successful task_complete closes the turn and the watch stands down", async () => {
  const w = await world({ rollouts: { s1: [noise(1), taskComplete("t-1", null)] } });
  assert.equal(await watch(), 0);
  const ev = events(w.msHome).pop()!;
  assert.deepEqual([ev.kind, ev.turnId, ev.generation], ["stop", "t-1", 2]);
  assert.equal(rearms(w.tlog), 0, "nothing is in flight any more");
  const st = w.openState();
  try { assert.equal(st.getKv("codexWatchArmedUntil"), null, "and the timer claim is cleared"); } finally { st.close(); }
});

test("a usage-limit task_complete for the current turn is recorded as rate_limited", async () => {
  const w = await world({ rollouts: { s1: [noise(1), taskComplete("t-1", "usage_limit_exceeded")] } });
  assert.equal(await watch(), 0);
  const ev = events(w.msHome).pop()!;
  // The record says a usage limit, not WHICH window, so the kind is `session`
  // and the chooser polls real usage before it picks.
  assert.deepEqual([ev.kind, ev.kindDetail, ev.turnId, ev.generation], ["rate_limited", "session", "t-1", 2]);
});

test("without MS_CODEX_AUTOROTATE the wall is recorded and nothing is rotated", async () => {
  // Spike verdict G1 is PARTIAL — no live Codex wall has ever been seen — so
  // the automatic path ships disabled.
  const w = await world({ rollouts: { s1: [taskComplete("t-1", "usage_limit_exceeded")] } });
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).pop()!.kind, "rate_limited");
  const st = w.openState();
  try { assert.equal((st as unknown as { pendingRecovery: (s: string) => unknown }).pendingRecovery("s1"), null); } finally { st.close(); }
  assert.doesNotMatch(tmuxLog(w.tlog), /_recover/);
});

test("with MS_CODEX_AUTOROTATE=1 the same record opens a recovery and dispatches the worker", async () => {
  const w = await world({ rollouts: { s1: [taskComplete("t-1", "usage_limit_exceeded")] }, autorotate: true });
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).pop()!.kind, "rate_limited");
  const st = w.openState() as unknown as { pendingRecovery: (s: string) => Record<string, unknown>; close: () => void };
  try {
    const rec = st.pendingRecovery("s1")!;
    assert.deepEqual([rec.kind, rec.turnId, rec.generation], ["session", "t-1", 2]);
  } finally { st.close(); }
  assert.match(tmuxLog(w.tlog), /-S \/private\/tmp\/tmux-501\/default run-shell -b '.*ms' '_recover' 's1'/);
});

test("a usage-limit record for an OLD turn is history, not a wall", async () => {
  // `codex resume` re-renders the whole conversation, so a rollout a rotation
  // reopens is full of old endings. Acting on one would rotate a session for a
  // wall it hit yesterday — on the account it has already been moved off.
  const w = await world({
    rollouts: { s1: [taskComplete("t-OLD", "usage_limit_exceeded"), noise(1)] },
    autorotate: true,
  });
  assert.equal(await watch(), 0);
  assert.deepEqual(events(w.msHome).map((e) => e.kind), ["activity"], "nothing was recorded");
  const st = w.openState() as unknown as { pendingRecovery: (s: string) => unknown; close: () => void };
  try { assert.equal(st.pendingRecovery("s1"), null); } finally { st.close(); }
  assert.equal(rearms(w.tlog), 1, "the turn is still in flight, so the watch re-arms");
});

test("a torn trailing line is kept for the next pass, and the offset advances only past complete ones", async () => {
  // Codex is appending to this file as the watch reads it, so the tail is
  // routinely half a record. Advancing past it would lose the record entirely.
  const w = await world({ rollouts: { s1: [noise(1)] } });
  const file = w.rollout("s1");
  const torn = taskComplete("t-1", "usage_limit_exceeded");
  const head = torn.slice(0, 40);
  appendFileSync(file, head); // no newline: an unfinished line

  assert.equal(await watch(), 0);
  assert.deepEqual(events(w.msHome).map((e) => e.kind), ["activity"], "half a record is not a record");
  const afterFirst = (await row(w.openState))!.rolloutOffset as number;
  assert.equal(afterFirst, Buffer.byteLength(noise(1) + "\n"), "the offset stops at the last complete line");
  assert.equal(rearms(w.tlog), 1);

  // the writer finishes the line
  appendFileSync(file, torn.slice(40) + "\n");
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).pop()!.kind, "rate_limited", "the completed record is read on the next pass");
  assert.equal((await row(w.openState))!.rolloutOffset, Buffer.byteLength(readFileSync(file, "utf8")), "and the offset is now the whole file");
});

test("bytes already read are never read twice, with the turn still in flight", async () => {
  // The turn stays OPEN on purpose. A settled turn is skipped by the in-flight
  // test before the file is ever opened, so a test that let the turn settle
  // would prove nothing about the offset — which is the thing that has to be
  // right when a session takes many turns against one growing rollout.
  const w = await world({ rollouts: { s1: [noise(1), taskComplete("t-OTHER", "usage_limit_exceeded"), noise(2)] }, autorotate: true });
  const wholeFile = Buffer.byteLength(readFileSync(w.rollout("s1"), "utf8"));

  assert.equal(await watch(), 0);
  assert.equal((await row(w.openState))!.rolloutOffset, wholeFile, "the whole file was consumed");
  assert.deepEqual(events(w.msHome).map((e) => e.kind), ["activity"], "and none of it was ours");

  // A second pass adds nothing and moves nothing: every byte is behind us.
  assert.equal(await watch(), 0);
  assert.equal((await row(w.openState))!.rolloutOffset, wholeFile);
  assert.deepEqual(events(w.msHome).map((e) => e.kind), ["activity"]);

  // Only the NEW bytes are read when the writer appends this turn's ending.
  appendFileSync(w.rollout("s1"), taskComplete("t-1", "usage_limit_exceeded") + "\n");
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).filter((e) => e.kind === "rate_limited").length, 1, "one wall, one event");
});

test("a session with no turn in flight is not read at all", async () => {
  for (const evs of [
    // the turn already ended
    [{ t: NOW(), kind: "activity", session: "s1", generation: 2, turnId: "t-1" }, { t: NOW(), kind: "stop", session: "s1", generation: 2, turnId: "t-1" }],
    // the turn already walled
    [{ t: NOW(), kind: "activity", session: "s1", generation: 2, turnId: "t-1" }, { t: NOW(), kind: "rate_limited", session: "s1", generation: 2, turnId: "t-1" }],
    // the session quit
    [{ t: NOW(), kind: "activity", session: "s1", generation: 2, turnId: "t-1" }, { t: NOW(), kind: "ended", session: "s1", generation: 2 }],
    // the turn belongs to a generation the session has left
    [{ t: NOW(), kind: "activity", session: "s1", generation: 1, turnId: "t-1" }],
    // a turn with no id could never be matched against a record
    [{ t: NOW(), kind: "activity", session: "s1", generation: 2, turnId: null }],
    // nothing has happened at all
    [{ t: NOW(), kind: "started", session: "s1", generation: 2 }],
  ]) {
    const w = await world({ rollouts: { s1: [taskComplete("t-1", "usage_limit_exceeded")] }, events: { s1: evs as Ev[] }, autorotate: true });
    assert.equal(await watch(), 0);
    assert.equal(events(w.msHome).filter((e) => e.kind === "rate_limited").length, evs.some((e) => e.kind === "rate_limited") ? 1 : 0, JSON.stringify(evs));
    assert.equal((await row(w.openState))!.rolloutOffset, 0, "the rollout was never opened");
    assert.equal(rearms(w.tlog), 0, "and nothing is re-armed");
  }
});

test("a row that is not a running Codex session is skipped", async () => {
  for (const patch of [{ provider: "claude" }, { state: "walled" }, { state: "resuming" }, { state: "parked" }, { state: "stopping" }]) {
    const w = await world({ rows: [{ id: "s1", ...patch }], rollouts: { s1: [taskComplete("t-1", "usage_limit_exceeded")] }, autorotate: true });
    assert.equal(await watch(), 0);
    assert.deepEqual(events(w.msHome).map((e) => e.kind), ["activity"], JSON.stringify(patch));
    assert.equal(rearms(w.tlog), 0);
  }
  // `continuing` is a live turn in a just-rotated session: it IS watched.
  const b = await world({ rows: [{ id: "s1", state: "continuing" }], rollouts: { s1: [taskComplete("t-1", null)] } });
  assert.equal(await watch(), 0);
  assert.equal(events(b.msHome).pop()!.kind, "stop");
});

test("the watch re-arms exactly once while any session still has a turn in flight", async () => {
  const w = await world({
    rows: [{ id: "s1" }, { id: "s2", pane: "%8" }],
    rollouts: { s1: [taskComplete("t-1", null)], s2: [noise(1)] },
    events: {
      s1: [{ t: NOW(), kind: "activity", session: "s1", generation: 2, turnId: "t-1" }],
      s2: [{ t: NOW(), kind: "activity", session: "s2", generation: 2, turnId: "t-2" }],
    },
  });
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome, "s1").pop()!.kind, "stop", "s1's turn ended");
  assert.deepEqual(events(w.msHome, "s2").map((e) => e.kind), ["activity"], "s2's has not");
  assert.equal(rearms(w.tlog), 1, "one timer for the fleet, not one per session");
  const st = w.openState();
  try { assert.ok(Number(st.getKv("codexWatchArmedUntil")) > NOW(), "and the claim is renewed"); } finally { st.close(); }
});

test("two turns in a row arm exactly one timer", async () => {
  // The hook path, through `bin/ms`. Ten Codex panes taking a turn each would
  // otherwise mean ten timers waking to read the same rows.
  const { run } = await import("./helpers.ts");
  const w = await world({ rollouts: { s1: [] }, events: { s1: [] } });
  const env = { HOME: w.home, MS_HOME: process.env.MS_HOME!, PATH: process.env.PATH!, MS_BIN, MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: SOCKET, MS_PANE: "%7" };
  for (const turn of ["t-1", "t-2", "t-3"]) {
    assert.equal(run(["_hook", "codex"], env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-s1", turn_id: turn, transcript_path: w.rollout("s1") })).code, 0);
  }
  assert.equal(rearms(w.tlog), 1, "three turns, one timer");
  assert.equal(events(w.msHome).filter((e) => e.kind === "activity").length, 3, "but all three turns are recorded");
  // The rollout path rode in on the payload and is on the row.
  assert.equal((await row(w.openState))!.transcriptPath, w.rollout("s1"));
});

test("a rollout that is missing, unreadable or empty is not evidence: the turn stays in flight", async () => {
  const w = await world({ rollouts: { s1: [] } });
  assert.equal(await watch(), 0);
  assert.deepEqual(events(w.msHome).map((e) => e.kind), ["activity"]);
  assert.equal(rearms(w.tlog), 1);

  // a row that never learned a path at all
  const b = await world({ rollouts: {} });
  const st = b.openState() as unknown as { updateSession: (i: string, p: object) => void; close: () => void };
  st.updateSession("s1", { transcriptPath: null }); st.close();
  assert.equal(await watch(), 0);
  assert.deepEqual(events(b.msHome).map((e) => e.kind), ["activity"]);
  assert.equal(rearms(b.tlog), 1, "a path we never learned is not finished");

  // a path that is gone: the file was rotated away, or the home was wiped
  const gone = await world({ rollouts: { s1: [taskComplete("t-1", "usage_limit_exceeded")] }, autorotate: true });
  rmSync(gone.rollout("s1"));
  assert.equal(await watch(), 0);
  assert.deepEqual(events(gone.msHome).map((e) => e.kind), ["activity"], "a missing file records nothing");
  assert.equal(rearms(gone.tlog), 1);

  // a path we are not allowed to open — the one case the name claimed and the
  // test did not cover. statSync succeeds; the open is what fails.
  const denied = await world({ rollouts: { s1: [taskComplete("t-1", "usage_limit_exceeded")] }, autorotate: true });
  chmodSync(denied.rollout("s1"), 0o000);
  try {
    assert.equal(await watch(), 0);
    assert.deepEqual(events(denied.msHome).map((e) => e.kind), ["activity"], "an unreadable file records nothing");
    assert.equal((await row(denied.openState))!.rolloutOffset, 0, "and moves no offset");
    assert.equal(rearms(denied.tlog), 1, "unreadable is not finished");
  } finally {
    chmodSync(denied.rollout("s1"), 0o600);
  }
});

test("a rollout that shrank is re-read from the start rather than from a meaningless offset", async () => {
  const w = await world({ rollouts: { s1: [noise(1), noise(2), noise(3)] } });
  assert.equal(await watch(), 0);
  const big = (await row(w.openState))!.rolloutOffset as number;
  assert.ok(big > 0);
  // the file is replaced by a shorter one carrying this turn's ending
  writeFileSync(w.rollout("s1"), taskComplete("t-1", "usage_limit_exceeded") + "\n");
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).pop()!.kind, "rate_limited");
});

test("junk in the rollout is skipped without stopping the pass", async () => {
  const w = await world({ rollouts: { s1: ["not json at all", "[]", "null", JSON.stringify({ payload: null }), JSON.stringify({ payload: { type: "task_complete" } }), taskComplete("t-1", null)] } });
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).pop()!.kind, "stop", "the real record is still found");
});

test("a task_complete that failed for some other reason ends the turn without claiming a wall", async () => {
  const w = await world({ rollouts: { s1: [taskComplete("t-1", "stream_disconnected")] }, autorotate: true });
  assert.equal(await watch(), 0);
  const ev = events(w.msHome).pop()!;
  assert.deepEqual([ev.kind, ev.kindDetail], ["stop", "stream_disconnected"], "the turn is over, and the log says why");
  const st = w.openState() as unknown as { pendingRecovery: (s: string) => unknown; close: () => void };
  try { assert.equal(st.pendingRecovery("s1"), null, "but nothing rotates"); } finally { st.close(); }
  assert.equal(rearms(w.tlog), 0);
});

test("a store created by the old schema is migrated in place, keeping its rows", async () => {
  // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
  // without the ALTER every query naming a new column would fail the first time
  // a hook ran against an existing install.
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(msHome, "state.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, provider TEXT, cliSessionId TEXT, cwd TEXT, socket TEXT, pane TEXT,
    serverStart TEXT, need TEXT, account TEXT, generation INTEGER, state TEXT, desired TEXT, flags TEXT, wakeupAt INTEGER, createdAt INTEGER, updatedAt INTEGER)`);
  old.prepare("INSERT INTO sessions (id,provider,account,generation,state,desired,flags,createdAt,updatedAt) VALUES ('old','codex','dirk',2,'running','running','[]',1,1)").run();
  old.close();

  const { openState } = await import("../src/state.ts");
  const st = openState();
  try {
    const s = st.getSession("old")!;
    assert.equal(s.account, "dirk", "the row survived");
    assert.equal(s.transcriptPath, null, "and gained the new columns at their defaults");
    assert.equal(s.rolloutOffset, 0);
    st.updateSession("old", { transcriptPath: "/tmp/r.jsonl", rolloutOffset: 42 });
    assert.equal(st.getSession("old")!.rolloutOffset, 42, "which are writable");
    st.setKv("k", "v");
    assert.equal(st.getKv("k"), "v", "and the kv table exists too");
  } finally { st.close(); }
  // idempotent: opening again must not try to add them twice
  const again = openState();
  try { assert.equal(again.getSession("old")!.transcriptPath, "/tmp/r.jsonl"); } finally { again.close(); }
});

test("the watch wakes every 45 s only when some Codex account's last reading is near its limit", async () => {
  // The two costs are not symmetric: a fast watch is a wake-up every 45 s for
  // as long as anything is thinking, and a slow one costs at most 75 extra
  // seconds of a walled session sitting there. So look often only when a wall
  // is plausible — and decide that from the CACHE, never a poll: this runs on
  // a hook's clock and inside the tmux server.
  const hot = await world({ rollouts: { s1: [noise(1)] }, hot: [{ name: "dirk", provider: "codex", percent: 91 }] });
  assert.equal(await watch(), 0);
  assert.equal(rearms(hot.tlog, 45), 1, "91% is over the mark");
  assert.equal(rearms(hot.tlog, 120), 0);

  const cool = await world({ rollouts: { s1: [noise(1)] }, hot: [{ name: "dirk", provider: "codex", percent: 79 }] });
  assert.equal(await watch(), 0);
  assert.equal(rearms(cool.tlog, 120), 1, "79% is not");
  assert.equal(rearms(cool.tlog, 45), 0);

  // Exactly at the mark counts, and a CLAUDE account at 99% does not: this is
  // about how close a Codex turn is to walling.
  const edge = await world({ rollouts: { s1: [noise(1)] }, hot: [{ name: "dirk", provider: "codex", percent: 80 }] });
  assert.equal(await watch(), 0);
  assert.equal(rearms(edge.tlog, 45), 1);

  const other = await world({ rollouts: { s1: [noise(1)] }, hot: [{ name: "gmail", provider: "claude", percent: 99 }] });
  assert.equal(await watch(), 0);
  assert.equal(rearms(other.tlog, 120), 1, "a walled Claude account says nothing about a Codex turn");

  // No cache at all is not a reason to wake up more often.
  const blind = await world({ rollouts: { s1: [noise(1)] } });
  assert.equal(await watch(), 0);
  assert.equal(rearms(blind.tlog, 120), 1);
});

test("the timer claim covers exactly the interval the timer was given", async () => {
  // A claim shorter than the wait would leave a hole in which a second timer
  // gets armed — which is the one thing the single-timer rule exists to stop.
  const w = await world({ rollouts: { s1: [noise(1)] } });
  assert.equal(await watch(), 0);
  const st = w.openState();
  try {
    const until = Number(st.getKv("codexWatchArmedUntil"));
    assert.ok(until >= NOW() + 118 && until <= NOW() + 121, `claimed until ${until - NOW()}s out, expected ~120`);
  } finally { st.close(); }
});

test("an append that fails leaves the offset where it was: the record is read again, never lost", async () => {
  // The offset used to move before the events were written. An append that
  // throws — a full disk, a mode nothing can write — then meant the next pass
  // started AFTER the record, the turn was never settled, and the watchdog
  // re-armed for ever over a session that had walled.
  const w = await world({ rollouts: { s1: [noise(1), taskComplete("t-1", "usage_limit_exceeded")] } });
  const log = path.join(w.msHome, "sessions", "s1", "events.jsonl");
  chmodSync(log, 0o400); // appendEvent will throw
  try {
    assert.equal(await watch(), 0);
    assert.equal((await row(w.openState))!.rolloutOffset, 0, "the bytes we could not record are still ahead of us");
    assert.equal(rearms(w.tlog), 1, "and the turn is still in flight");
  } finally {
    chmodSync(log, 0o600);
  }
  // With the log writable again the very same bytes are read, and the wall
  // lands. Nothing was lost.
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).pop()!.kind, "rate_limited");
  assert.equal((await row(w.openState))!.rolloutOffset, Buffer.byteLength(readFileSync(w.rollout("s1"), "utf8")));

  // The ordinary ending goes the same way. A `stop` that could not be written
  // is a turn the tool still believes is running, so its bytes must come round
  // again too — otherwise the watchdog re-arms for ever over a finished turn.
  const b = await world({ rollouts: { s1: [noise(1), taskComplete("t-1", null)] } });
  const blog = path.join(b.msHome, "sessions", "s1", "events.jsonl");
  chmodSync(blog, 0o400);
  try {
    assert.equal(await watch(), 0);
    assert.equal((await row(b.openState))!.rolloutOffset, 0, "a stop we could not record leaves the bytes ahead of us");
    assert.equal(rearms(b.tlog), 1, "and the turn reads as still in flight");
  } finally {
    chmodSync(blog, 0o600);
  }
  assert.equal(await watch(), 0);
  assert.equal(events(b.msHome).pop()!.kind, "stop", "the same record lands on the next pass");
  assert.equal(rearms(b.tlog), 1, "and nothing re-arms once it has");
});

test("a timer somebody else already armed is neither doubled nor cleared", async () => {
  // The pass begins when its own claim expires, and a UserPromptSubmit that
  // won the lock in that gap has already armed a replacement. Re-arming on top
  // of it leaves TWO timers, each renewing the other's claim for as long as the
  // fleet is busy.
  const w = await world({ rollouts: { s1: [noise(1)] } });
  const st = w.openState();
  const until = NOW() + 90;
  st.setKv("codexWatchArmedUntil", String(until));
  st.close();

  assert.equal(await watch(), 0);
  assert.equal(rearms(w.tlog, 120) + rearms(w.tlog, 45), 0, "no second timer");
  const after = w.openState();
  try { assert.equal(Number(after.getKv("codexWatchArmedUntil")), until, "and the other timer's claim is left alone"); } finally { after.close(); }

  // The same guard must not clear a live claim when nothing is in flight
  // either: that timer is still coming, and clearing would let the next hook
  // arm a second one.
  const idle = await world({ rollouts: { s1: [taskComplete("t-1", null)] } });
  const st2 = idle.openState();
  st2.setKv("codexWatchArmedUntil", String(NOW() + 90));
  st2.close();
  assert.equal(await watch(), 0);
  const after2 = idle.openState();
  try { assert.ok(Number(after2.getKv("codexWatchArmedUntil")) > NOW(), "the pending claim survives"); } finally { after2.close(); }
});

test("a line longer than the read cap is stepped over rather than stalling the session for ever", async () => {
  // A whole cap-sized read with no newline in it is not a record being written,
  // it is a line longer than the cap. Keeping the offset would re-read the same
  // bytes every pass and the turn would never end.
  const w = await world({ rollouts: { s1: [] } });
  const { ROLLOUT_CHUNK_MAX } = await import("../src/hooks/codex-hook.ts");
  writeFileSync(w.rollout("s1"), "x".repeat(ROLLOUT_CHUNK_MAX + 1024));

  // Skipping bytes is worth saying out loud — but only when asked. A watchdog
  // that wrote a line every 45 s would drown the one line worth reading.
  const said: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string) => { said.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    delete process.env.MS_VERBOSE;
    assert.equal(await watch(), 0);
    assert.deepEqual(said, [], "silent by default");
  } finally {
    process.stderr.write = real;
  }
  assert.equal((await row(w.openState))!.rolloutOffset, ROLLOUT_CHUNK_MAX, "exactly the cap, no more");
  assert.deepEqual(events(w.msHome).map((e) => e.kind), ["activity"], "and nothing is invented from it");

  // The rest of the monster line goes the same way, and then the real record
  // behind it is read.
  appendFileSync(w.rollout("s1"), "\n" + taskComplete("t-1", null) + "\n");
  assert.equal(await watch(), 0);
  assert.equal(events(w.msHome).pop()!.kind, "stop");

  // Asked for, it says so. (A fresh world, because `watch` reads whichever
  // store MS_HOME currently points at.)
  const loud = await world({ rollouts: { s1: [] } });
  writeFileSync(loud.rollout("s1"), "x".repeat(ROLLOUT_CHUNK_MAX + 1024));
  const heard: string[] = [];
  process.stderr.write = ((c: string) => { heard.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    process.env.MS_VERBOSE = "1";
    assert.equal(await watch(), 0);
  } finally {
    process.stderr.write = real;
    delete process.env.MS_VERBOSE;
  }
  assert.match(heard.join(""), /s1: skipped \d+ rollout bytes with no line break/);
});
