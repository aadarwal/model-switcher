import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, stubDir, tempHome } from "./helpers.ts";

function setup() {
  const { home, msHome } = tempHome(); const { dir, stub } = stubDir();
  const tlog = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${tlog}"; case "$*" in *capture-pane*) printf '❯ do it\\n  ⎿  You'"'"'ve reached your Fable limit. Run /usage-credits to continue or switch models with /model.\\n\\n❯ \\n' ;; esac; exit 0`);
  const env = { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}`, MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: "/private/tmp/tmux-501/default", MS_PANE: "%7" };
  return { home, msHome, env, tlog };
}

/** Node's warnings fully enabled: neither the harness's `NODE_NO_WARNINGS` nor
 * its `NODE_OPTIONS=--disable-warning=…` may be what keeps the hook quiet. A
 * hook's stderr is rendered inside the human's Claude transcript. */
const LOUD = { NODE_OPTIONS: "", NODE_NO_WARNINGS: "" };

function events(msHome: string, session = "s1"): Record<string, unknown>[] {
  return readFileSync(path.join(msHome, "sessions", session, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
const eventsExist = (msHome: string, session = "s1") => existsSync(path.join(msHome, "sessions", session, "events.jsonl"));

async function seedSession(env: Record<string, string>, patch: Record<string, unknown> = {}) {
  process.env.HOME = env.HOME; process.env.MS_HOME = env.MS_HOME;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  st.createSession({ id: "s1", provider: "claude", cliSessionId: "c-42", cwd: "/tmp", socket: env.MS_SOCKET, pane: "%7", serverStart: "1",
    need: "fable", account: "dirk", generation: 2, state: "running", desired: "running", flags: [], ...patch } as Parameters<typeof st.createSession>[0]);
  st.close();
  return openState;
}

test("SessionStart with source resume appends a resumed event carrying the inherited generation", () => {
  const { env, msHome } = setup();
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "c-42" }));
  assert.equal(r.code, 0); assert.equal(r.stdout, "");
  const ev = events(msHome);
  assert.deepEqual([ev[0].kind, ev[0].generation, ev[0].cliSessionId], ["resumed", 2, "c-42"]);
});

test("SessionStart maps every source, UserPromptSubmit is activity and SessionEnd is ended", () => {
  for (const [source, kind] of [["startup", "started"], ["clear", "cleared"], ["compact", "compacted"], [undefined, "started"]] as const) {
    const { env, msHome } = setup();
    assert.equal(run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "c-7" })).code, 0);
    assert.equal(events(msHome)[0].kind, kind);
  }
  const a = setup();
  assert.equal(run(["_hook", "claude"], a.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "c-7" })).code, 0);
  assert.deepEqual([events(a.msHome)[0].kind, events(a.msHome)[0].cliSessionId], ["activity", "c-7"]);
  const b = setup();
  assert.equal(run(["_hook", "claude"], b.env, JSON.stringify({ hook_event_name: "SessionEnd", reason: "clear", session_id: "c-7" })).code, 0);
  assert.deepEqual([events(b.msHome)[0].kind, events(b.msHome)[0].kindDetail], ["ended", "clear"]);
  const c = setup();
  assert.equal(run(["_hook", "claude"], c.env, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "c-7" })).code, 0);
  assert.equal(events(c.msHome)[0].kind, "ended");
  assert.ok(!("kindDetail" in events(c.msHome)[0]), "no reason means no kindDetail, not an empty one");
});

test("a /clear moves the row onto the new CLI session id, and the event records both", async () => {
  // `/clear` starts a new conversation inside one process. The row's id is what
  // a rotation resumes, so a row left on the pre-clear id would bring back the
  // conversation the human had just cleared.
  const { env, msHome } = setup();
  const openState = await seedSession(env); // the row is on c-42
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "SessionStart", source: "clear", session_id: "c-99" }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  const ev = events(msHome).pop()!;
  assert.deepEqual([ev.kind, ev.cliSessionId, ev.prevCliSessionId], ["cleared", "c-99", "c-42"]);
  const st = openState();
  try {
    assert.equal(st.getSession("s1")!.cliSessionId, "c-99", "the row follows the conversation the human is in");
  } finally {
    st.close();
  }
});

test("a resume or startup under another id moves the row too, but never one for a generation the session has left", async () => {
  for (const source of ["resume", "startup"]) {
    const { env, msHome } = setup();
    const openState = await seedSession(env);
    assert.equal(run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "c-7" })).code, 0);
    const st = openState();
    try {
      assert.equal(st.getSession("s1")!.cliSessionId, "c-7", source);
    } finally {
      st.close();
    }
    assert.equal(events(msHome).pop()!.prevCliSessionId, "c-42", source);
  }
  // A late report from a replaced generation is attributable to the process
  // that sent it and to nothing else: the row belongs to its replacement.
  const stale = setup();
  const openState = await seedSession(stale.env, { generation: 5 });
  assert.equal(run(["_hook", "claude"], stale.env, JSON.stringify({ hook_event_name: "SessionStart", source: "clear", session_id: "c-99" })).code, 0);
  const st = openState();
  try {
    assert.equal(st.getSession("s1")!.cliSessionId, "c-42", "generation 2's report may not move generation 5's row");
  } finally {
    st.close();
  }
  assert.ok(!("prevCliSessionId" in events(stale.msHome).pop()!), "and the event claims no change it did not make");
});

test("a launch is running once the CLI reports itself, and a continuation once the human's next turn arrives", async () => {
  // Spec §7 step 5 and §9 step 7. Nothing else writes either transition, so
  // without these every healthy session reads `launching` for ever and every
  // rotated one `continuing`.
  const a = setup();
  const openA = await seedSession(a.env, { state: "launching" });
  assert.equal(run(["_hook", "claude"], a.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "c-42" })).code, 0);
  const stA = openA();
  try {
    assert.equal(stA.getSession("s1")!.state, "running", "the launch answered for itself");
  } finally {
    stA.close();
  }

  const b = setup();
  const openB = await seedSession(b.env, { state: "continuing" });
  assert.equal(run(["_hook", "claude"], b.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "c-42" })).code, 0);
  const stB = openB();
  try {
    assert.equal(stB.getSession("s1")!.state, "running", "the resumed session is working again");
  } finally {
    stB.close();
  }

  // A LAUNCH that resumes reports `resume`, and it is still the launch
  // answering for itself (0.2.5): `ms claude -- --resume <id>` and `ms adopt`
  // both start a CLI that reports SessionStart with source `resume`, and a row
  // that only accepted `startup` sat in `launching` until reconciliation's
  // five-minute rule parked it. Only `launching` is touched — `resuming`
  // belongs to the recovery worker, and its own clause is below.
  const c = setup();
  const openC = await seedSession(c.env, { state: "launching" });
  assert.equal(run(["_hook", "claude"], c.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "c-42" })).code, 0);
  const stC = openC();
  try {
    assert.equal(stC.getSession("s1")!.state, "running", "a launch that resumed answered for itself");
  } finally {
    stC.close();
  }

  const d = setup();
  const openD = await seedSession(d.env, { state: "stopping", desired: "stopped" });
  assert.equal(run(["_hook", "claude"], d.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "c-42" })).code, 0);
  const stD = openD();
  try {
    assert.equal(stD.getSession("s1")!.state, "stopping", "a turn does not un-stop a session on its way out");
  } finally {
    stD.close();
  }
});

test("a resume report adopts a session whose worker never came back to it", async () => {
  // Live matrix case 9: the recovery worker was `kill -9`'d a second after its
  // respawn. The replacement CLI came up and reported itself through this very
  // hook — and nothing moved the row, so `ms status` read `resuming` until
  // reconciliation's five-minute stuck rule finally looked at it.
  const a = setup();
  const openA = await seedSession(a.env, { state: "resuming" });
  const seeded = openA();
  seeded.setWakeup("s1", Math.floor(Date.now() / 1000) + 600);
  seeded.close();

  assert.equal(run(["_hook", "claude"], a.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "c-42" })).code, 0);

  const stA = openA();
  try {
    const s = stA.getSession("s1")!;
    assert.equal(s.state, "continuing", "the CLI is back, and the row says so at once");
    assert.equal(s.wakeupAt, null, "a session whose CLI is back is not also waiting for a window to reset");
  } finally {
    stA.close();
  }

  // The other way a handoff comes back. A conversation with no transcript is
  // relaunched with `--session-id`, which reports a `startup` and carries no
  // continuation — so `running`, exactly what the worker writes for a handoff
  // with none. Matching only `resumed` left this shape in `resuming` limbo:
  // `noteActivity` rescues `continuing` and nothing else, and reconciliation's
  // stuck rule reads that `started` as "it came back" and leaves it alone.
  const fresh = setup();
  const openFresh = await seedSession(fresh.env, { state: "resuming" });
  const wasFresh = openFresh();
  wasFresh.setWakeup("s1", Math.floor(Date.now() / 1000) + 600);
  wasFresh.close();

  assert.equal(run(["_hook", "claude"], fresh.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "c-42" })).code, 0);

  const stFresh = openFresh();
  try {
    const s = stFresh.getSession("s1")!;
    assert.equal(s.state, "running", "a relaunch with no continuation is running, not continuing");
    assert.equal(s.wakeupAt, null);
  } finally {
    stFresh.close();
  }

  // A `started` under a DIFFERENT id is a `--resume` that landed a new
  // conversation (resume-broken): the id is recorded, but the row must stay
  // `resuming` so the worker (or reconciliation) parks it instead of the hook
  // marking a lost conversation healthy.
  const stray = setup();
  const openStray = await seedSession(stray.env, { state: "resuming" });
  assert.equal(run(["_hook", "claude"], stray.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "c-NEW" })).code, 0);
  const stStray = openStray();
  try {
    const s = stStray.getSession("s1")!;
    assert.equal(s.state, "resuming", "a started under a new id is not an adoption");
    assert.equal(s.cliSessionId, "c-NEW", "the id is still recorded");
  } finally {
    stStray.close();
  }

  // Only from `resuming`. Every other state belongs to somebody else — a stop,
  // a park, the worker itself — and a late report may not overwrite it.
  for (const state of ["running", "stopping", "parked"] as const) {
    for (const source of ["resume", "startup"] as const) {
      const b = setup();
      const openB = await seedSession(b.env, { state });
      assert.equal(run(["_hook", "claude"], b.env, JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "c-42" })).code, 0);
      const stB = openB();
      try {
        assert.equal(stB.getSession("s1")!.state, state, `${state} / ${source}`);
      } finally {
        stB.close();
      }
    }
  }

  // And never for a generation the session has left: that report is the dead
  // process's, and the row belongs to its replacement.
  const c = setup();
  const openC = await seedSession(c.env, { state: "resuming", generation: 5 });
  assert.equal(run(["_hook", "claude"], c.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "c-42" })).code, 0);
  const stC = openC();
  try {
    assert.equal(stC.getSession("s1")!.state, "resuming", "generation 2's report may not adopt generation 5's row");
  } finally {
    stC.close();
  }
});

test("StopFailure rate_limit records the wall kind from the screen, opens a recovery and asks tmux to dispatch the worker", async () => {
  const { env, msHome, tlog } = setup();
  const openState = await seedSession(env);
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", error_message: "x", session_id: "c-42" }));
  assert.equal(r.code, 0); assert.equal(r.stdout, "");
  const ev = events(msHome).pop()!;
  assert.equal(ev.kind, "rate_limited"); assert.equal(ev.kindDetail, "fable");
  const st2 = openState(); assert.equal(st2.pendingRecovery("s1")!.kind, "fable"); st2.close();
  assert.match(readFileSync(tlog, "utf8"), /-S \/private\/tmp\/tmux-501\/default run-shell -b '.*ms' '_recover' 's1'/);
});

test("an unmanaged pane is left alone: the session is real, one MS_ variable is not", () => {
  // MS_SESSION stays s1 on purpose — if the guard broke, events would land there.
  const a = setup();
  const { MS_PANE: _pane, ...noPane } = a.env;
  assert.equal(run(["_hook", "claude"], noPane, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "c-42" })).code, 0);
  assert.equal(eventsExist(a.msHome), false, "no MS_PANE: not our pane");

  const b = setup();
  const { MS_SOCKET: _sock, ...noSocket } = b.env;
  assert.equal(run(["_hook", "claude"], noSocket, JSON.stringify({ hook_event_name: "SessionStart", source: "startup" })).code, 0);
  assert.equal(eventsExist(b.msHome), false, "no MS_SOCKET: not our pane");

  // `Number("")` is 0, and 0 is finite — a blank generation is not a generation.
  for (const gen of ["", " ", "0", "-1", "1.5", "nope"]) {
    const c = setup();
    assert.equal(run(["_hook", "claude"], { ...c.env, MS_GENERATION: gen }, JSON.stringify({ hook_event_name: "SessionStart", source: "startup" })).code, 0);
    assert.equal(eventsExist(c.msHome), false, `MS_GENERATION=${JSON.stringify(gen)} is not a generation`);
  }
});

test("a StopFailure that is not a rate limit does nothing", () => {
  const { env, msHome } = setup();
  assert.equal(run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "overloaded" })).code, 0);
  assert.equal(eventsExist(msHome), false);
});

test("an unknown event, empty stdin and unparseable stdin all exit 0 silently", () => {
  const { env, msHome } = setup();
  for (const input of [JSON.stringify({ hook_event_name: "PreToolUse" }), "", "not json", "[]", "null"]) {
    const r = run(["_hook", "claude"], { ...env, ...LOUD }, input);
    assert.equal(r.code, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
  }
  assert.equal(eventsExist(msHome), false);
});

test("the hook prints nothing on stderr with Node's own warnings fully enabled", async () => {
  // `state.ts` pulls in node:sqlite, whose ExperimentalWarning would land in the
  // human's transcript. Both halves are under test: the unmanaged early return
  // must not load it at all, and the rate-limit path must not leak it either.
  const a = setup();
  const { MS_PANE: _pane, ...unmanaged } = a.env;
  const r1 = run(["_hook", "claude"], { ...unmanaged, ...LOUD }, JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
  assert.deepEqual([r1.code, r1.stdout, r1.stderr], [0, "", ""], "unmanaged pane: not one byte");

  const b = setup();
  await seedSession(b.env);
  const r2 = run(["_hook", "claude"], { ...b.env, ...LOUD }, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "c-42" }));
  assert.deepEqual([r2.code, r2.stdout, r2.stderr], [0, "", ""], "rate_limited: not one byte");
  assert.equal(events(b.msHome).pop()!.kindDetail, "fable", "and it still did the work");
});

test("a rate limit for a stale generation is recorded but never dispatched", async () => {
  const { env, msHome, tlog } = setup();
  const openState = await seedSession(env, { generation: 5 });
  assert.equal(run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "c-42" })).code, 0);
  assert.equal(events(msHome).pop()!.kind, "rate_limited");
  const st2 = openState(); assert.equal(st2.pendingRecovery("s1"), null); st2.close();
  assert.doesNotMatch(readFileSync(tlog, "utf8"), /run-shell/);
});

test("a rate limit for a session that is stopping, or one the store has never seen, is recorded but never dispatched", async () => {
  const a = setup();
  await seedSession(a.env, { desired: "stopped" });
  assert.equal(run(["_hook", "claude"], a.env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "c-42" })).code, 0);
  assert.equal(events(a.msHome).pop()!.kind, "rate_limited");
  assert.doesNotMatch(readFileSync(a.tlog, "utf8"), /run-shell/);

  const b = setup();
  assert.equal(run(["_hook", "claude"], b.env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "c-42" })).code, 0);
  assert.equal(events(b.msHome).pop()!.kind, "rate_limited");
  assert.doesNotMatch(readFileSync(b.tlog, "utf8"), /run-shell/);
});

// --- The turn end: rebalance's only trigger ------------------------------
//
// `Stop` writes nothing to the event log on purpose (unlike Codex, whose
// watchdog needs to know which turns are settled). Its whole job is to be the
// moment an idle session may be moved — so every assertion below is about
// what reached tmux, not about what reached the log.

/** The same world as `setup()`, plus a tmux that admits the pane exists:
 *  `maybeRebalance` re-reads the pane before it moves anything, and a
 *  `list-panes` that answers nothing means a pane that is GONE — which is a
 *  refusal, and would make every assertion below pass for the wrong reason. */
function setupLive() {
  const { home, msHome } = tempHome(); const { dir, stub } = stubDir();
  const tlog = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${tlog}"
case "$*" in
  *list-panes*) printf '%%7\\n' ;;
  *capture-pane*) printf '> done\\n\\n> \\n' ;;
esac
exit 0`);
  const env = { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}`, MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: "/private/tmp/tmux-501/default", MS_PANE: "%7" };
  return { home, msHome, env, tlog };
}

/** The tmux log, or "" when tmux was never run at all — which is itself the
 *  assertion in the gate-off case. */
const tmuxLog = (tlog: string): string => (existsSync(tlog) ? readFileSync(tlog, "utf8") : "");

/** A registry and a usage snapshot the chooser can actually read, written by
 *  hand into the temp MS_HOME. `takenAt` is now and every row is a fresh,
 *  unstale reading, so `getSnapshot` serves the file and nothing polls:
 *  `poll()` returns the cache untouched when it is fresh AND covers every
 *  registered account, and `maybeRebalance` only ever asks it for the cache. */
function fleet(msHome: string, rows: { name: string; session: number; weekly: number; resetHours: number }[]): void {
  const now = Date.now();
  const iso = (h: number) => new Date(now + h * 3_600_000).toISOString();
  writeFileSync(path.join(msHome, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: rows.map((r) => ({ name: r.name, provider: "claude", label: r.name, orgId: null, shared: false, identityVerified: true })),
  }), { mode: 0o600 });
  writeFileSync(path.join(msHome, "snapshot.json"), JSON.stringify({
    takenAt: now,
    backoff: {},
    accounts: rows.map((r) => ({
      name: r.name, provider: "claude", shared: false,
      usage: {
        session: { usedPercent: r.session, resetsAt: iso(3) },
        weeklyAll: { usedPercent: r.weekly, resetsAt: iso(r.resetHours) },
        // The seeded session needs fable, so the fable window has to be a
        // real reading: an account without one is one the chooser refuses.
        weeklyFable: { usedPercent: r.weekly, resetsAt: iso(r.resetHours) },
      },
      error: null, errorKind: null, observedAt: now, stale: false,
    })),
  }), { mode: 0o600 });
}

/** `here` is about to wall and `there` resets sooner with room to spare: the
 *  imminent-wall condition, as the rule sees it. */
const WALL_COMING = [
  { name: "here", session: 93, weekly: 20, resetHours: 120 },
  { name: "there", session: 4, weekly: 10, resetHours: 48 },
];

test("a turn end with the gate off writes nothing and dispatches nothing", async () => {
  const { env, msHome, tlog } = setupLive();
  await seedSession(env, { account: "here" });
  fleet(msHome, WALL_COMING);
  const r = run(["_hook", "claude"], { ...env, MS_REBALANCE: "0", ...LOUD }, JSON.stringify({ hook_event_name: "Stop", session_id: "c-42" }));
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], "a turn end is not a place to print");
  assert.equal(eventsExist(msHome), false, "Stop writes no event of its own");
  assert.equal(tmuxLog(tlog), "", "the gate is off, and off costs not one tmux call");
});

test("a turn end with nothing set (the default since 0.3.4) dispatches too", async () => {
  const { env, msHome, tlog } = setupLive();
  await seedSession(env, { account: "here" });
  fleet(msHome, WALL_COMING);
  const r = run(["_hook", "claude"], { ...env, ...LOUD }, JSON.stringify({ hook_event_name: "Stop", session_id: "c-42" }));
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  const dispatched = readFileSync(tlog, "utf8").split("\n").filter((l) => l.includes("_rebalance"));
  assert.equal(dispatched.length, 1, "silence means on now, not off");
});

test("a turn end with the gate on dispatches the switch worker, once", async () => {
  const { env, msHome, tlog } = setupLive();
  await seedSession(env, { account: "here" });
  fleet(msHome, WALL_COMING);
  const r = run(["_hook", "claude"], { ...env, MS_REBALANCE: "1", ...LOUD },
    JSON.stringify({ hook_event_name: "Stop", session_id: "c-42" }));
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);

  const dispatched = readFileSync(tlog, "utf8").split("\n").filter((l) => l.includes("_rebalance"));
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0], /run-shell -b .*'_rebalance' 's1' '--to' 'there'$/);
  assert.doesNotMatch(dispatched[0], /--continue/, "an idle pane is handed no continuation");

  const ev = events(msHome).filter((e) => e.kind === "rebalance");
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].from, ev[0].to, ev[0].kindDetail], ["here", "there", "imminent-wall"]);
});

test("the turn-end gate is mirrored out of the human's shell into the store", async () => {
  const { env, msHome } = setup();
  const openState = await seedSession(env);
  run(["_hook", "claude"], { ...env, MS_REBALANCE: "1" }, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "c-42" }));
  const on = openState(); assert.equal(on.getKv("rebalance"), "1"); on.close();

  // And a shell that says no travels too — a variable exported as anything
  // other than "1" is somebody turning this off.
  run(["_hook", "claude"], { ...env, MS_REBALANCE: "0" }, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "c-42" }));
  const off = openState(); assert.equal(off.getKv("rebalance"), "0"); off.close();
  assert.ok(existsSync(path.join(msHome, "state.sqlite")));
});

test("a turn end on the account that is already best moves nothing", async () => {
  const { env, msHome, tlog } = setupLive();
  await seedSession(env, { account: "here" });
  fleet(msHome, [
    { name: "here", session: 4, weekly: 10, resetHours: 48 },
    { name: "there", session: 4, weekly: 10, resetHours: 120 },
  ]);
  assert.equal(run(["_hook", "claude"], { ...env, MS_REBALANCE: "1" },
    JSON.stringify({ hook_event_name: "Stop", session_id: "c-42" })).code, 0);
  assert.doesNotMatch(tmuxLog(tlog), /_rebalance/);
});
