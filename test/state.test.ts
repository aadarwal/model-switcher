import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { tempHome } from "./helpers.ts";

async function fresh() {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { openState } = await import("../src/state.ts");
  return { st: openState(), msHome };
}
const base = { provider: "claude" as const, cliSessionId: "c1", cwd: "/tmp/x", socket: "/private/tmp/tmux-501/default",
  pane: "%5", serverStart: "1789000000", need: "any" as const, account: "gmail", generation: 1,
  state: "launching" as const, desired: "running" as const, flags: ["--dangerously-skip-permissions"] };

test("the state file is 0600 and sessions round-trip", async () => {
  const { st, msHome } = await fresh();
  st.createSession({ id: "s1", ...base });
  assert.equal(statSync(`${msHome}/state.sqlite`).mode & 0o777, 0o600);
  const s = st.getSession("s1")!;
  assert.equal(s.account, "gmail"); assert.deepEqual(s.flags, ["--dangerously-skip-permissions"]);
  st.updateSession("s1", { state: "running", generation: 2 });
  assert.equal(st.getSession("s1")!.generation, 2);
  st.close();
});

test("one pending recovery per session; owning it is atomic", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  const id = st.addRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  const dup = st.addRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  assert.equal(dup, id, "a duplicate failure for the same generation joins the pending recovery");
  assert.equal(st.pendingRecovery("s1")!.status, "pending");
  assert.equal(st.ownRecovery(id, "worker-A"), true);
  assert.equal(st.ownRecovery(id, "worker-B"), false);
  st.addAttempt({ recoveryId: id, account: "dirk", outcome: "exhausted", note: "" });
  assert.equal(st.attempts(id).length, 1);
  st.finishRecovery(id, "done");
  assert.equal(st.pendingRecovery("s1"), null);
  st.close();
});

test("wakeups come due in order", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base }); st.createSession({ id: "s2", ...base, pane: "%6" });
  st.setWakeup("s1", 200); st.setWakeup("s2", 100);
  assert.deepEqual(st.dueWakeups(150).map((s) => s.id), ["s2"]);
  assert.deepEqual(st.dueWakeups(300).map((s) => s.id), ["s2", "s1"]);
  st.close();
});
