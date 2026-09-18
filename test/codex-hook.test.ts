import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { run, stubDir, tempHome } from "./helpers.ts";

function setup() {
  const { home, msHome } = tempHome(); const { dir, stub } = stubDir();
  const tlog = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${tlog}"; exit 0`);
  const env = { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}`, MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: "/private/tmp/tmux-501/default", MS_PANE: "%7" };
  return { home, msHome, env, tlog };
}

/** Node's warnings fully enabled: neither the harness's `NODE_NO_WARNINGS` nor
 * its `NODE_OPTIONS=--disable-warning=…` may be what keeps the hook quiet. A
 * hook's stderr is rendered inside the human's Codex transcript. */
const LOUD = { NODE_OPTIONS: "", NODE_NO_WARNINGS: "" };

function events(msHome: string, session = "s1"): Record<string, unknown>[] {
  return readFileSync(path.join(msHome, "sessions", session, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
const eventsExist = (msHome: string, session = "s1") => existsSync(path.join(msHome, "sessions", session, "events.jsonl"));
const tmuxLog = (tlog: string) => (existsSync(tlog) ? readFileSync(tlog, "utf8") : "");

async function seedSession(env: Record<string, string>, patch: Record<string, unknown> = {}) {
  process.env.HOME = env.HOME; process.env.MS_HOME = env.MS_HOME;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  st.createSession({ id: "s1", provider: "codex", cliSessionId: null, cwd: "/tmp", socket: env.MS_SOCKET, pane: "%7", serverStart: "1",
    need: "any", account: "dirk", generation: 2, state: "running", desired: "running", flags: [], ...patch } as Parameters<typeof st.createSession>[0]);
  st.close();
  return openState;
}

test("each Codex lifecycle event appends its own kind", () => {
  for (const [source, kind] of [["startup", "started"], ["resume", "resumed"], [undefined, "started"], ["mystery", "started"]] as const) {
    const { env, msHome } = setup();
    assert.equal(run(["_hook", "codex"], env, JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "cx-7" })).code, 0);
    assert.deepEqual([events(msHome)[0].kind, events(msHome)[0].cliSessionId], [kind, "cx-7"], String(source));
  }

  const a = setup();
  assert.equal(run(["_hook", "codex"], a.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-7", turn_id: "t-1", prompt: "do it" })).code, 0);
  assert.deepEqual([events(a.msHome)[0].kind, events(a.msHome)[0].turnId], ["activity", "t-1"]);
  // The prompt the human typed is not ours to record.
  assert.ok(!JSON.stringify(events(a.msHome)[0]).includes("do it"), "the hook logs the turn, never its content");

  const b = setup();
  assert.equal(run(["_hook", "codex"], b.env, JSON.stringify({ hook_event_name: "Stop", session_id: "cx-7", turn_id: "t-1", last_assistant_message: "done" })).code, 0);
  assert.deepEqual([events(b.msHome)[0].kind, events(b.msHome)[0].turnId], ["stop", "t-1"]);
  assert.ok(!JSON.stringify(events(b.msHome)[0]).includes("done"), "and never the assistant's message either");

  const c = setup();
  assert.equal(run(["_hook", "codex"], c.env, JSON.stringify({ hook_event_name: "SessionEnd", reason: "other", session_id: "cx-7" })).code, 0);
  assert.deepEqual([events(c.msHome)[0].kind, events(c.msHome)[0].kindDetail], ["ended", "other"]);

  const d = setup();
  assert.equal(run(["_hook", "codex"], d.env, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "cx-7" })).code, 0);
  assert.ok(!("kindDetail" in events(d.msHome)[0]), "no reason means no kindDetail, not an empty one");
});

test("UserPromptSubmit arms ONE fleet watchdog, at the interval the cache justifies", () => {
  // The whole Codex trigger rests on this. A usage-limit turn fires no hook at
  // all, so the only thing that will ever notice one is the watch armed here —
  // and it is one timer for the tmux server, not one per turn, so ten Codex
  // panes taking a turn each do not wake ten readers of the same rows.
  const { env, tlog } = setup();
  assert.equal(run(["_hook", "codex"], env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-7", turn_id: "t-1" })).code, 0);
  // 120 s, not 45: `setup` seeds no snapshot cache, and with no reading saying
  // any Codex account is near its limit the watch takes the slow interval.
  assert.match(tmuxLog(tlog), /-S \/private\/tmp\/tmux-501\/default run-shell -b -d 120 '.*ms' '_codex_watch'/);
  assert.doesNotMatch(tmuxLog(tlog), /'t-1'/, "the timer names no turn: it reads every in-flight one");

  // No other event arms one.
  for (const payload of [
    { hook_event_name: "SessionStart", source: "startup", session_id: "cx-7" },
    { hook_event_name: "Stop", session_id: "cx-7", turn_id: "t-1" },
    { hook_event_name: "SessionEnd", session_id: "cx-7" },
  ]) {
    const c = setup();
    assert.equal(run(["_hook", "codex"], c.env, JSON.stringify(payload)).code, 0);
    assert.doesNotMatch(tmuxLog(c.tlog), /run-shell/, payload.hook_event_name);
  }
});

test("SessionStart records the rollout path — the only place a walled turn leaves a trace", async () => {
  const a = setup();
  const openA = await seedSession(a.env, { cliSessionId: null });
  assert.equal(run(["_hook", "codex"], a.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-1", transcript_path: "/tmp/rollout-a.jsonl" })).code, 0);
  const stA = openA();
  try { assert.equal(stA.getSession("s1")!.transcriptPath, "/tmp/rollout-a.jsonl"); } finally { stA.close(); }

  // A NEW path is a new conversation, so the byte offset into the old one is
  // meaningless: carrying it over would skip the head of a fresh rollout.
  const b = setup();
  const openB = await seedSession(b.env, { cliSessionId: "cx-1" });
  const seeded = openB();
  seeded.updateSession("s1", { transcriptPath: "/tmp/rollout-old.jsonl", rolloutOffset: 900 });
  seeded.close();
  assert.equal(run(["_hook", "codex"], b.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "cx-2", transcript_path: "/tmp/rollout-new.jsonl" })).code, 0);
  const stB = openB();
  try {
    const s = stB.getSession("s1")!;
    assert.deepEqual([s.transcriptPath, s.rolloutOffset], ["/tmp/rollout-new.jsonl", 0]);
  } finally { stB.close(); }

  // The SAME path keeps its offset: a hook is not a reason to re-read history.
  const c = setup();
  const openC = await seedSession(c.env, { cliSessionId: "cx-1" });
  const held = openC();
  held.updateSession("s1", { transcriptPath: "/tmp/rollout-same.jsonl", rolloutOffset: 900 });
  held.close();
  assert.equal(run(["_hook", "codex"], c.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-1", transcript_path: "/tmp/rollout-same.jsonl" })).code, 0);
  const stC = openC();
  try { assert.equal(stC.getSession("s1")!.rolloutOffset, 900); } finally { stC.close(); }
});

test("SessionStart records the CLI session id on a row that has none — Codex has no --session-id", async () => {
  // This hook is the ONLY place the tool ever learns a Codex session's id, and
  // the id is what `codex resume <id>` needs to bring a rotated session back. A
  // row still on null after a launch could never be resumed.
  const a = setup();
  const openA = await seedSession(a.env, { cliSessionId: null, state: "launching" });
  assert.equal(run(["_hook", "codex"], a.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-new" })).code, 0);
  const stA = openA();
  try {
    const s = stA.getSession("s1")!;
    assert.equal(s.cliSessionId, "cx-new", "the row learns the id Codex minted");
    assert.equal(s.state, "running", "and the launch has answered for itself");
  } finally {
    stA.close();
  }
  assert.equal(events(a.msHome).pop()!.prevCliSessionId, null, "the event records the null it replaced");

  // An id that MOVED is the same write, and the event records both.
  const b = setup();
  const openB = await seedSession(b.env, { cliSessionId: "cx-old" });
  assert.equal(run(["_hook", "codex"], b.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "cx-new" })).code, 0);
  const stB = openB();
  try { assert.equal(stB.getSession("s1")!.cliSessionId, "cx-new"); } finally { stB.close(); }
  assert.equal(events(b.msHome).pop()!.prevCliSessionId, "cx-old");

  // An id that did not move claims no change it did not make.
  const c = setup();
  await seedSession(c.env, { cliSessionId: "cx-same" });
  assert.equal(run(["_hook", "codex"], c.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-same" })).code, 0);
  assert.ok(!("prevCliSessionId" in events(c.msHome).pop()!));

  // And never for a generation the session has left.
  const d = setup();
  const openD = await seedSession(d.env, { cliSessionId: null, generation: 5 });
  assert.equal(run(["_hook", "codex"], d.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-new" })).code, 0);
  const stD = openD();
  try { assert.equal(stD.getSession("s1")!.cliSessionId, null, "generation 2's report may not move generation 5's row"); } finally { stD.close(); }
});

test("a row already running with no id still adopts the one the first prompt finally reports", async () => {
  // The other end of C1. A Codex relaunch that carries no prompt is marked
  // `running` by the recovery worker on the strength of its live pane
  // (src/recover.ts's `waitForSettle`), because this TUI fires SessionStart
  // only when a prompt is SUBMITTED — which may be an hour later. When it
  // finally does, the row is `running` and its id is still null, and this is
  // the only place the tool will ever learn the id `codex resume <id>` needs.
  // A guard that only adopted from `launching`/`resuming` would leave that
  // session unrotatable for the rest of its life.
  for (const source of ["startup", "resume"] as const) {
    const a = setup();
    const openA = await seedSession(a.env, { state: "running", cliSessionId: null });
    assert.equal(
      run(["_hook", "codex"], a.env, JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "cx-late", transcript_path: "/tmp/rollout-late.jsonl" })).code,
      0,
    );
    const stA = openA();
    try {
      const s = stA.getSession("s1")!;
      assert.deepEqual(
        [s.cliSessionId, s.transcriptPath, s.state],
        ["cx-late", "/tmp/rollout-late.jsonl", "running"],
        `${source}: the id and the rollout are adopted, and a running row is left running`,
      );
    } finally {
      stA.close();
    }
    assert.equal(events(a.msHome).pop()!.prevCliSessionId, null, "and the event records the null it replaced");
  }
});

test("a resumed session is adopted the moment its replacement CLI reports itself", async () => {
  const a = setup();
  const openA = await seedSession(a.env, { state: "resuming", cliSessionId: "cx-1" });
  const seeded = openA(); seeded.setWakeup("s1", Math.floor(Date.now() / 1000) + 600); seeded.close();
  assert.equal(run(["_hook", "codex"], a.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "cx-1" })).code, 0);
  const stA = openA();
  try {
    const s = stA.getSession("s1")!;
    assert.deepEqual([s.state, s.wakeupAt], ["continuing", null], "the CLI is back, and the row says so at once");
  } finally { stA.close(); }

  // A `startup` under a NEW id is a resume that landed somewhere else: record
  // the id, but leave the row `resuming` for the worker to park.
  const b = setup();
  const openB = await seedSession(b.env, { state: "resuming", cliSessionId: "cx-1" });
  assert.equal(run(["_hook", "codex"], b.env, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-2" })).code, 0);
  const stB = openB();
  try {
    const s = stB.getSession("s1")!;
    assert.deepEqual([s.state, s.cliSessionId], ["resuming", "cx-2"]);
  } finally { stB.close(); }

  // Only from `resuming`. Every other state belongs to somebody else.
  for (const state of ["running", "stopping", "parked"] as const) {
    const c = setup();
    const openC = await seedSession(c.env, { state, cliSessionId: "cx-1" });
    assert.equal(run(["_hook", "codex"], c.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "cx-1" })).code, 0);
    const stC = openC();
    try { assert.equal(stC.getSession("s1")!.state, state, state); } finally { stC.close(); }
  }
});

test("the first turn after a resume finishes the rotation, and a turn never un-stops a session", async () => {
  const a = setup();
  const openA = await seedSession(a.env, { state: "continuing" });
  assert.equal(run(["_hook", "codex"], a.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-1", turn_id: "t-1" })).code, 0);
  const stA = openA();
  try { assert.equal(stA.getSession("s1")!.state, "running", "the resumed session is working again"); } finally { stA.close(); }

  const b = setup();
  const openB = await seedSession(b.env, { state: "stopping", desired: "stopped" });
  assert.equal(run(["_hook", "codex"], b.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-1", turn_id: "t-1" })).code, 0);
  const stB = openB();
  try { assert.equal(stB.getSession("s1")!.state, "stopping"); } finally { stB.close(); }
});

test("an unmanaged pane is left alone: the session is real, one MS_ variable is not", () => {
  // MS_SESSION stays s1 on purpose — if the guard broke, events would land there.
  for (const missing of ["MS_PANE", "MS_SOCKET", "MS_SESSION"] as const) {
    const a = setup();
    const env = { ...a.env }; delete (env as Record<string, string>)[missing];
    assert.equal(run(["_hook", "codex"], env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-1", turn_id: "t-1" })).code, 0);
    assert.equal(eventsExist(a.msHome), false, `no ${missing}: not our pane`);
    assert.doesNotMatch(tmuxLog(a.tlog), /run-shell/, `no ${missing}: no watchdog either`);
  }
  // `Number("")` is 0, and 0 is finite — a blank generation is not a generation.
  for (const gen of ["", " ", "0", "-1", "1.5", "nope"]) {
    const c = setup();
    assert.equal(run(["_hook", "codex"], { ...c.env, MS_GENERATION: gen }, JSON.stringify({ hook_event_name: "SessionStart", source: "startup" })).code, 0);
    assert.equal(eventsExist(c.msHome), false, `MS_GENERATION=${JSON.stringify(gen)} is not a generation`);
  }
});

test("an unknown event, empty stdin and unparseable stdin all exit 0 silently", () => {
  const { env, msHome, tlog } = setup();
  for (const input of [JSON.stringify({ hook_event_name: "PreToolUse" }), JSON.stringify({ hook_event_name: "Interrupt" }), "", "not json", "[]", "null", " "]) {
    const r = run(["_hook", "codex"], { ...env, ...LOUD }, input);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], JSON.stringify(input));
  }
  assert.equal(eventsExist(msHome), false);
  assert.equal(tmuxLog(tlog), "");
});

test("an unmanaged pane opens no store at all, not merely an empty one", async () => {
  // `cli.ts` imports this module for EVERY verb, so nothing here may reach
  // node:sqlite at module scope: the early return has to happen before a store
  // is created. The sqlite files are the observable half of that — `openState`
  // and the lock both create theirs at 0600 the moment they are called.
  const a = setup();
  const { MS_PANE: _pane, ...unmanaged } = a.env;
  assert.equal(run(["_hook", "codex"], { ...unmanaged, ...LOUD }, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-1", turn_id: "t-1" })).code, 0);
  for (const f of ["state.sqlite", "locks.sqlite", "snapshot.json"]) {
    assert.equal(existsSync(path.join(a.msHome, f)), false, f);
  }
  // and a managed one does open them, so the check above is not vacuous
  const b = setup();
  assert.equal(run(["_hook", "codex"], b.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx-1", turn_id: "t-1" })).code, 0);
  assert.equal(existsSync(path.join(b.msHome, "state.sqlite")), true);
});

test("the hook prints nothing on stderr with Node's own warnings fully enabled", async () => {
  // `state.ts` pulls in node:sqlite, whose ExperimentalWarning would land in the
  // human's transcript. Both halves are under test: the unmanaged early return
  // must not load it at all, and the SessionStart path must not leak it either.
  const a = setup();
  const { MS_PANE: _pane, ...unmanaged } = a.env;
  const r1 = run(["_hook", "codex"], { ...unmanaged, ...LOUD }, JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
  assert.deepEqual([r1.code, r1.stdout, r1.stderr], [0, "", ""], "unmanaged pane: not one byte");

  const b = setup();
  await seedSession(b.env, { state: "launching", cliSessionId: null });
  const r2 = run(["_hook", "codex"], { ...b.env, ...LOUD }, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "cx-1" }));
  assert.deepEqual([r2.code, r2.stdout, r2.stderr], [0, "", ""], "a real report: not one byte");
  assert.equal(events(b.msHome).pop()!.cliSessionId, "cx-1", "and it still did the work");
});

test("_hook with no provider, or one we do not run, exits 2 rather than pretending to have worked", () => {
  const { env, msHome } = setup();
  for (const which of [[], ["gemini"]]) {
    assert.equal(run(["_hook", ...which], env, JSON.stringify({ hook_event_name: "SessionStart" })).code, 2, JSON.stringify(which));
  }
  assert.equal(eventsExist(msHome), false);
});

test("an exported MS_CODEX_AUTOROTATE is written into the store, which is what the dispatched processes read", async () => {
  // A-I2. `ms _codex_watch` and `ms _recover` are dispatched with `tmux
  // run-shell`, which runs them with the tmux SERVER's global environment —
  // never the shell that typed `export MS_CODEX_AUTOROTATE=1`. The hook is one
  // of the few `ms` processes that DOES see the human's own environment, so it
  // carries the gate into the store on its way past.
  const { DatabaseSync } = await import("node:sqlite");
  const gate = (msHome: string): string | null => {
    const db = new DatabaseSync(path.join(msHome, "state.sqlite"));
    try { return ((db.prepare("SELECT v FROM kv WHERE k=?").get("codexAutorotate") as { v: string } | undefined)?.v) ?? null; } finally { db.close(); }
  };

  const on = setup();
  await seedSession(on.env);
  assert.equal(run(["_hook", "codex"], { ...on.env, MS_CODEX_AUTOROTATE: "1" }, JSON.stringify({ hook_event_name: "Stop", session_id: "cx-7", turn_id: "t-1" })).code, 0);
  assert.equal(gate(on.msHome), "1", "every event carries it, not only the ones that open a store already");

  // Turning it off travels the same way.
  assert.equal(run(["_hook", "codex"], { ...on.env, MS_CODEX_AUTOROTATE: "0" }, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "cx-7" })).code, 0);
  assert.equal(gate(on.msHome), "0");

  // A shell with no export says nothing: "I was not told" must never read as
  // "turn it off", or one unflagged `ms` would undo the human's setting.
  assert.equal(run(["_hook", "codex"], { ...on.env, MS_CODEX_AUTOROTATE: "1" }, JSON.stringify({ hook_event_name: "Stop", session_id: "cx-7", turn_id: "t-2" })).code, 0);
  assert.equal(run(["_hook", "codex"], { ...on.env, MS_CODEX_AUTOROTATE: "" }, JSON.stringify({ hook_event_name: "Stop", session_id: "cx-7", turn_id: "t-3" })).code, 0);
  assert.equal(gate(on.msHome), "1");

  // And an unmanaged pane still writes nothing at all — the identity gate
  // comes first, so a Codex the human launched by hand cannot set this.
  const bare = setup();
  const anon = { ...bare.env, MS_CODEX_AUTOROTATE: "1" } as Record<string, string>;
  delete anon.MS_SESSION;
  assert.equal(run(["_hook", "codex"], { ...anon, MS_SESSION: "" }, JSON.stringify({ hook_event_name: "Stop", session_id: "cx-7", turn_id: "t-1" })).code, 0);
  assert.equal(existsSync(path.join(bare.msHome, "state.sqlite")), false, "no store is even opened");
});

test("a codex launch that RESUMED is running once its hook reports (0.2.5)", async () => {
  // The rescue `ms adopt` automates: the pane is launched on `codex resume
  // <id>`, so the TUI's first SessionStart carries source `resume`, not
  // `startup`. A row that only promoted on `startup` read `launching` until
  // reconciliation's stuck rule got to it — while the conversation was up and
  // answering.
  const a = setup();
  const openA = await seedSession(a.env, { state: "launching", cliSessionId: "cx-7" });
  assert.equal(run(["_hook", "codex"], a.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "cx-7" })).code, 0);
  const stA = openA();
  try {
    assert.equal(stA.getSession("s1")!.state, "running");
  } finally {
    stA.close();
  }

  // `resuming` is still the recovery worker's state and still becomes
  // `continuing` on a resume report — this must not have swallowed that.
  const b = setup();
  const openB = await seedSession(b.env, { state: "resuming", cliSessionId: "cx-7" });
  assert.equal(run(["_hook", "codex"], b.env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "cx-7" })).code, 0);
  const stB = openB();
  try {
    assert.equal(stB.getSession("s1")!.state, "continuing");
  } finally {
    stB.close();
  }
});
