import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { run, stubDir, tempHome } from "./helpers.ts";

function setup() {
  const { home, msHome } = tempHome(); const { dir, stub } = stubDir();
  const tlog = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${tlog}"; case "$*" in *capture-pane*) printf '❯ do it\\n  ⎿  You'"'"'ve reached your Fable limit. Run /usage-credits to continue or switch models with /model.\\n\\n❯ \\n' ;; esac; exit 0`);
  const env = { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}`, MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: "/private/tmp/tmux-501/default", MS_PANE: "%7" };
  return { home, msHome, env, tlog };
}

function events(msHome: string, session = "s1"): Record<string, unknown>[] {
  return readFileSync(path.join(msHome, "sessions", session, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("SessionStart with source resume appends a resumed event carrying the inherited generation", async () => {
  const { env, msHome } = setup();
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "c-42" }));
  assert.equal(r.code, 0); assert.equal(r.stdout, "");
  const ev = events(msHome);
  assert.deepEqual([ev[0].kind, ev[0].generation, ev[0].cliSessionId], ["resumed", 2, "c-42"]);
});

test("SessionStart maps every source, UserPromptSubmit is activity and SessionEnd is ended", () => {
  for (const [source, kind] of [["startup", "started"], ["clear", "cleared"], ["compact", "compacted"], [undefined, "started"]] as const) {
    const { env, msHome } = setup();
    const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "SessionStart", source, session_id: "c-7" }));
    assert.equal(r.code, 0);
    assert.equal(events(msHome)[0].kind, kind);
  }
  const a = setup();
  assert.equal(run(["_hook", "claude"], a.env, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "c-7" })).code, 0);
  assert.deepEqual([events(a.msHome)[0].kind, events(a.msHome)[0].cliSessionId], ["activity", "c-7"]);
  const b = setup();
  assert.equal(run(["_hook", "claude"], b.env, JSON.stringify({ hook_event_name: "SessionEnd", reason: "clear", session_id: "c-7" })).code, 0);
  assert.deepEqual([events(b.msHome)[0].kind, events(b.msHome)[0].kindDetail], ["ended", "clear"]);
});

test("StopFailure rate_limit records the wall kind from the screen, opens a recovery and asks tmux to dispatch the worker", async () => {
  const { env, msHome, tlog } = setup();
  process.env.HOME = env.HOME; process.env.MS_HOME = env.MS_HOME;
  const { openState } = await import("../src/state.ts");
  const st = openState(); st.createSession({ id: "s1", provider: "claude", cliSessionId: "c-42", cwd: "/tmp", socket: env.MS_SOCKET, pane: "%7", serverStart: "1", need: "fable", account: "dirk", generation: 2, state: "running", desired: "running", flags: [] }); st.close();
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", error_message: "x", session_id: "c-42" }));
  assert.equal(r.code, 0); assert.equal(r.stdout, "");
  const ev = events(msHome).pop()!;
  assert.equal(ev.kind, "rate_limited"); assert.equal(ev.kindDetail, "fable");
  const st2 = openState(); assert.equal(st2.pendingRecovery("s1")!.kind, "fable"); st2.close();
  assert.match(readFileSync(tlog, "utf8"), /-S \/private\/tmp\/tmux-501\/default run-shell -b '.*ms' '_recover' 's1'/);
});

test("a StopFailure that is not a rate limit, or an unmanaged pane, does nothing", async () => {
  const { env, msHome } = setup();
  run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "overloaded" }));
  run(["_hook", "claude"], { ...env, MS_SESSION: "" }, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" }));
  assert.throws(() => readFileSync(path.join(msHome, "sessions", "s1", "events.jsonl")));
});

test("an unknown event, empty stdin and unparseable stdin all exit 0 silently", () => {
  const { env, msHome } = setup();
  for (const input of [JSON.stringify({ hook_event_name: "PreToolUse" }), "", "not json"]) {
    const r = run(["_hook", "claude"], env, input);
    assert.equal(r.code, 0); assert.equal(r.stdout, ""); assert.doesNotMatch(r.stderr, /ms _hook|unknown verb/);
  }
  assert.equal(existsSync(path.join(msHome, "sessions", "s1", "events.jsonl")), false);
});

test("a rate limit for a stale generation is recorded but never dispatched", async () => {
  const { env, msHome, tlog } = setup();
  process.env.HOME = env.HOME; process.env.MS_HOME = env.MS_HOME;
  const { openState } = await import("../src/state.ts");
  const st = openState(); st.createSession({ id: "s1", provider: "claude", cliSessionId: "c-42", cwd: "/tmp", socket: env.MS_SOCKET, pane: "%7", serverStart: "1", need: "any", account: "dirk", generation: 5, state: "running", desired: "running", flags: [] }); st.close();
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "c-42" }));
  assert.equal(r.code, 0);
  assert.equal(events(msHome).pop()!.kind, "rate_limited");
  const st2 = openState(); assert.equal(st2.pendingRecovery("s1"), null); st2.close();
  assert.doesNotMatch(readFileSync(tlog, "utf8"), /run-shell/);
});

test("a rate limit for a session the store has never seen is recorded but never dispatched", () => {
  const { env, msHome, tlog } = setup();
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", session_id: "c-42" }));
  assert.equal(r.code, 0);
  assert.equal(events(msHome).pop()!.kind, "rate_limited");
  assert.doesNotMatch(readFileSync(tlog, "utf8"), /run-shell/);
});

test("wallKindFromText reads each wall kind from the TUI's own rendering", async () => {
  const { wallKindFromText } = await import("../src/wall.ts");
  const screen = (body: string) => `❯ do it\n${body}\n\n❯ \n`;
  assert.equal(wallKindFromText(screen("  ⎿  You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.")), "fable");
  assert.equal(wallKindFromText(screen("  ⎿  You've reached your weekly usage limit. Resets Monday.")), "weekly");
  assert.equal(wallKindFromText(screen("  ⎿  You've hit your usage limit. New messages wait for your usage limit to reset.")), "session");
  assert.equal(wallKindFromText(screen("Claude usage limit reached")), "session");
  assert.equal(wallKindFromText(screen("  ⎿  Wrote 12 lines to src/wall.ts")), null);
});

test("wall text quoted in prose or left in an earlier turn never reads as a wall", async () => {
  const { wallKindFromText, lastTurn } = await import("../src/wall.ts");
  // mid-line prose: the anchor is the line start, so this is not a wall
  assert.equal(wallKindFromText("❯ explain\n  the pane said You've hit your usage limit and rotated twice\n\n❯ \n"), null);
  // an earlier turn's real wall is out of scope once a new turn starts
  const old = "❯ first\n  ⎿  You've reached your Fable limit.\n❯ second\n  ⎿  Done.\n\n❯ \n";
  assert.equal(wallKindFromText(old), null);
  assert.deepEqual(lastTurn(old), ["❯ second", "  ⎿  Done.", ""]);
  // no user echo above the composer: fall back to the 16 rows above it
  const deep = [...Array(30).keys()].map((i) => `row ${i}`);
  deep[10] = "  ⎿  You've reached your Fable limit.";
  assert.equal(wallKindFromText(deep.join("\n") + "\n❯ \n"), null);
  deep[20] = "  ⎿  You've reached your Fable limit.";
  assert.equal(wallKindFromText(deep.join("\n") + "\n❯ \n"), "fable");
});
