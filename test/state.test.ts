import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync, chmodSync } from "node:fs";
import { tempHome } from "./helpers.ts";
import type { SessionRow } from "../src/state.ts";

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
  assert.equal(s.wakeupAt, null);
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

test("a failed recovery is closed: it does not block addRecovery from opening a new one", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  const id = st.addRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  st.finishRecovery(id, "failed");
  assert.equal(st.pendingRecovery("s1"), null, "failed is a closed status, like done/obsolete");
  const next = st.addRecovery({ sessionId: "s1", generation: 2, turnId: "t2", kind: "weekly" });
  assert.notEqual(next, id, "a fresh recovery opens rather than joining the failed one");
  assert.equal(st.pendingRecovery("s1")!.id, next);
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

test("insertRecovery races safely: a duplicate insert returns the existing pending id instead of throwing", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  // Two processes both observing "no pending recovery" and both trying to
  // create one land here as two back-to-back insertRecovery calls for the
  // same session — this is what the TOCTOU race looks like at the
  // database layer, independent of addRecovery's own pre-check.
  const id1 = st.insertRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  const id2 = st.insertRecovery({ sessionId: "s1", generation: 1, turnId: "t2", kind: "unknown" });
  assert.equal(id2, id1, "the loser of the race returns the winner's id, never throws");
  assert.equal(st.pendingRecovery("s1")!.id, id1);
  st.close();
});

test("updateSession whitelists columns: unknown keys and injected column syntax are ignored, and the caller can never set updatedAt", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  // An unknown key does nothing.
  st.updateSession("s1", { notAColumn: "x" } as unknown as Partial<SessionRow>);
  assert.equal(st.getSession("s1")!.account, "gmail");
  // A patch key that is itself a SQL fragment must never become a column
  // reference in the generated SET clause.
  st.updateSession("s1", { "account=99, state": "hijacked" } as unknown as Partial<SessionRow>);
  const afterInjection = st.getSession("s1")!;
  assert.equal(afterInjection.account, "gmail");
  assert.equal(afterInjection.state, "launching");
  // A legitimate column update succeeds, but a caller-supplied updatedAt
  // riding along in the same patch is never the value actually written.
  st.updateSession("s1", { account: "other", updatedAt: 999999999999 } as unknown as Partial<SessionRow>);
  const after = st.getSession("s1")!;
  assert.equal(after.account, "other");
  assert.notEqual(after.updatedAt, 999999999999);
  st.close();
});

test("openState chmods a pre-existing 0644 state file to 0600", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const file = `${msHome}/state.sqlite`;
  writeFileSync(file, "");
  chmodSync(file, 0o644);
  assert.equal(statSync(file).mode & 0o777, 0o644);
  const { openState } = await import("../src/state.ts");
  const st = openState();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  st.close();
});

test("SessionRow carries wakeupAt, defaulted to null on creation", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  assert.equal(st.getSession("s1")!.wakeupAt, null);
  st.setWakeup("s1", 42);
  assert.equal(st.getSession("s1")!.wakeupAt, 42);
  st.close();
});

test("close() is idempotent", async () => {
  const { st } = await fresh();
  st.close();
  assert.doesNotThrow(() => st.close());
});

test("addAttempt is one transaction with one timestamp", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  const id = st.addRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  st.addAttempt({ recoveryId: id, account: "dirk", outcome: "ok", note: "" });
  const [attempt] = st.attempts(id);
  const recovery = st.pendingRecovery("s1")!;
  assert.equal(recovery.attempts, 1);
  assert.equal(recovery.updatedAt, attempt.createdAt, "the attempt row and the recovery's bumped counter share one timestamp");
  st.close();
});

test("createLaunch/getLaunch round-trip command and env as JSON", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  st.createLaunch({ id: "l1", sessionId: "s1", generation: 1, account: "gmail", command: ["claude", "--foo", "bar"], env: { MS_ACCOUNT: "gmail" }, createdAt: 1789000000 });
  const l = st.getLaunch("l1")!;
  assert.deepEqual(l.command, ["claude", "--foo", "bar"]);
  assert.deepEqual(l.env, { MS_ACCOUNT: "gmail" });
  assert.equal(l.sessionId, "s1");
  assert.equal(st.getLaunch("missing"), null);
  st.close();
});

test("listSessions returns every session, ordered by createdAt", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  st.createSession({ id: "s2", ...base, pane: "%6" });
  assert.deepEqual(st.listSessions().map((s) => s.id), ["s1", "s2"]);
  st.close();
});

test("releaseRecovery reopens an owned recovery as pending with no owner", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  const id = st.addRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  assert.equal(st.ownRecovery(id, "worker-A"), true);
  st.releaseRecovery(id);
  const r = st.pendingRecovery("s1")!;
  assert.equal(r.id, id);
  assert.equal(r.status, "pending");
  assert.equal(r.owner, null);
  // Reopened means claimable again.
  assert.equal(st.ownRecovery(id, "worker-B"), true);
  st.close();
});

test("setWakeup(null) clears a wakeup so the session drops out of dueWakeups", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  st.setWakeup("s1", 100);
  assert.deepEqual(st.dueWakeups(200).map((s) => s.id), ["s1"]);
  st.setWakeup("s1", null);
  assert.deepEqual(st.dueWakeups(200), []);
  assert.equal(st.getSession("s1")!.wakeupAt, null);
  st.close();
});
