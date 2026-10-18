import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ownsHook } from "../src/hooks/owner.ts";
import { run, stubDir, tempHome } from "./helpers.ts";

const tree = (rows: [number, number, string][]) =>
  new Map(rows.map(([pid, parent, command]) => [pid, { parent, command }]));

test("only the managed CLI and its hook shells own events", () => {
  const processes = tree([[100, 1, "claude"], [101, 100, "/bin/sh"], [102, 101, "/bin/bash"], [200, 100, "claude"], [201, 200, "sh"]]);
  assert.equal(ownsHook("claude", 100, 100, processes), true);
  assert.equal(ownsHook("claude", 100, 102, processes), true, "shell -c wrappers are transparent");
  assert.equal(ownsHook("claude", 100, 201, processes), false, "a nested CLI still inherits the pin");
  assert.equal(ownsHook("claude", 100, 999, processes), false, "unknown ancestry proves nothing");
  assert.equal(ownsHook("claude", 0, 100, processes), false);
  assert.equal(ownsHook("claude", 100, 101, tree([[101, 102, "sh"], [102, 101, "sh"]])), false, "cycles terminate");
});

test("Codex's npm launcher may own its direct native child, but nested execs and cross-provider children cannot", () => {
  const processes = tree([
    [100, 1, "/opt/node"], [101, 100, "/vendor/bin/codex"], [102, 101, "sh"],
    [200, 101, "node"], [201, 200, "codex"], [202, 201, "sh"],
    [300, 101, "codex"], [301, 300, "sh"],
  ]);
  assert.equal(ownsHook("codex", 100, 102, processes), true);
  assert.equal(ownsHook("codex", 100, 202, processes), false, "nested npm launcher");
  assert.equal(ownsHook("codex", 100, 301, processes), false, "nested native exec");
  assert.equal(ownsHook("codex", 101, 301, processes), false, "native pane PID cannot vouch for its native child");
  assert.equal(ownsHook("claude", 100, 102, processes), false, "the exception is Codex's launcher only");
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: a real headless descendant cannot change the identity, transcript, gates, or lifecycle`, async () => {
    const { home, msHome } = tempHome();
    const { dir, stub } = stubDir();
    const tmuxLog = path.join(home, "tmux.log");
    stub("tmux", `printf '%s\\n' "$*" >> '${tmuxLog}'`);
    process.env.HOME = home; process.env.MS_HOME = msHome;
    const { openState } = await import("../src/state.ts");
    const st = openState();
    st.createSession({ id: "s1", provider, cliSessionId: null, cwd: home, socket: "/unused", pane: "%7", serverStart: "1:2",
      need: "any", account: "work", generation: 2, state: "launching", desired: "running", flags: [] });
    st.createLaunch({ id: "L1", sessionId: "s1", generation: 2, account: "work", command: [provider], env: {}, createdAt: 1 });
    st.close();
    if (provider === "claude") {
      const { saveLaunchToken } = await import("../src/launch-credentials.ts");
      saveLaunchToken("work", "sk-ant-oat01-hook-owner-fixture");
    }

    // This fixture runs as the CLI's actual pinned PID, then launches a real
    // separate Node process carrying exactly the same MS_* environment.
    const fixture = path.join(dir, provider);
    writeFileSync(fixture, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
if (process.argv.includes("--version")) { console.log("0.153.4"); process.exit(0); }
const provider = ${JSON.stringify(provider)};
const hook = (input, child = false, cli = provider) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(path.resolve("bin/ms"))}, "_hook", cli], {
    input: JSON.stringify(input), encoding: "utf8",
    env: { ...process.env, ...(child ? { MS_REBALANCE: "0", MS_CODEX_AUTOROTATE: "0" } : {}) }
  });
  if (result.status !== 0 || result.stdout || result.stderr) throw new Error("hook must exit silently: " + JSON.stringify(result));
};
if (process.argv[2] === "child") {
  for (const input of [
    { hook_event_name: "SessionStart", source: "startup", transcript_path: "/tmp/child.jsonl" },
    { hook_event_name: "UserPromptSubmit", turn_id: "child-turn", transcript_path: "/tmp/child.jsonl" },
    { hook_event_name: "Stop" },
    { hook_event_name: "StopFailure", error: "rate_limit" },
    { hook_event_name: "SessionEnd" }
  ]) hook({ ...input, session_id: "child-conversation" }, true);
} else {
  hook({ hook_event_name: "SessionStart", source: "startup", session_id: "parent-conversation", transcript_path: "/tmp/parent.jsonl" });
  const child = spawnSync(process.execPath, [__filename, "child"], { encoding: "utf8", env: process.env });
  if (child.status !== 0) throw new Error(child.stderr);
  hook({ hook_event_name: "SessionStart", source: "startup", session_id: "cross-provider-child", transcript_path: "/tmp/cross.jsonl" }, true, provider === "claude" ? "codex" : "claude");
  hook({ hook_event_name: "UserPromptSubmit", session_id: "parent-conversation", turn_id: "parent-turn", transcript_path: "/tmp/parent.jsonl" });
}
`);
    chmodSync(fixture, 0o755);
    const result = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}` });
    assert.equal(result.code, 0, result.stderr);
    const after = openState();
    try {
      const row = after.getSession("s1")!;
      assert.deepEqual([row.cliSessionId, row.transcriptPath, row.state], ["parent-conversation", "/tmp/parent.jsonl", "running"]);
      assert.equal(after.pendingRecovery("s1"), null);
      assert.equal(after.getKv("rebalance"), null, "a child's environment cannot change the fleet's gate");
      assert.equal(after.getKv("codexAutorotate"), null);
    } finally { after.close(); }
    const events = readFileSync(path.join(msHome, "sessions/s1/events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => [event.kind, event.cliSessionId]), [["started", "parent-conversation"], ["activity", "parent-conversation"]]);
    const commands = existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8") : "";
    assert.doesNotMatch(commands, /_recover|_rebalance/);
    assert.equal((commands.match(/_codex_watch/g) ?? []).length, provider === "codex" ? 1 : 0);
  });
}

test("older live panes use tmux's pane PID and reject a restarted server or an unreadable owner", async () => {
  for (const [identity, pid, accepts] of [["1:2", String(process.pid), true], ["2:3", String(process.pid), false], ["1:2", "", false]] as const) {
    const { home, msHome } = tempHome();
    const { dir, stub } = stubDir();
    stub("tmux", `printf '%s\\t%s\\n' '${pid}' '${identity}'`);
    process.env.HOME = home; process.env.MS_HOME = msHome;
    const { openState } = await import("../src/state.ts");
    const st = openState();
    st.createSession({ id: "s1", provider: "claude", cliSessionId: "parent", cwd: home, socket: "/unused", pane: "%7", serverStart: "1:2",
      need: "any", account: "work", generation: 2, state: "running", desired: "running", flags: [] });
    st.close();
    const result = run(["_hook", "claude"], { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}`,
      MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: "/unused", MS_PANE: "%7" },
    JSON.stringify({ hook_event_name: "SessionStart", source: "clear", session_id: "new-conversation" }));
    assert.equal(result.code, 0);
    assert.equal(result.stdout + result.stderr, "");
    const after = openState();
    try { assert.equal(after.getSession("s1")!.cliSessionId, accepts ? "new-conversation" : "parent"); } finally { after.close(); }
    assert.equal(existsSync(path.join(msHome, "sessions/s1/events.jsonl")), accepts);
  }
});
