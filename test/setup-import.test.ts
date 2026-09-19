// test/setup-import.test.ts — the wizard's `import` step (src/setup/import-step.ts).
//
// Unit-level, not the end-to-end child-process driver setup.test.ts uses:
// `scan`, `plan` and `runImport` are all injected fakes, so these tests prove
// the step's OWN orchestration — what it asks, in what order, what it does
// with each answer — without touching a real ~/.claude, ~/.codex, tmux or
// git. `ctx.persist()` still writes a real (temp) MS_HOME/setup.json, which is
// the one piece of the real world these tests need: proving the manifest path
// really lands in `ctx.state.importManifest`.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import { makeCtx, type Ctx } from "../src/setup/steps.ts";
import { scriptedPrompter } from "../src/setup/prompt.ts";
import { loadSetup } from "../src/setup/state.ts";
import { importStep, type ScanFn, type PlanFn, type RunImportFn } from "../src/setup/import-step.ts";
import { planImport } from "../src/import/plan.ts";
import type { Candidate } from "../src/import/scan.ts";

const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);
const H = 3_600_000;
let seq = 0;

function cand(over: Partial<Candidate> & Pick<Candidate, "cwd">): Candidate {
  seq += 1;
  return {
    provider: "claude",
    id: `id-${seq}`,
    transcriptPath: `/t/${seq}.jsonl`,
    lastActivity: T0,
    title: `title ${seq}`,
    compacted: false,
    pid: null,
    argv: null,
    startedAt: null,
    inTmux: false,
    managed: false,
    ...over,
  };
}

/** Captures every line a step's `ctx.say` writes, without a child process. */
async function captureStdoutAsync<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const orig = process.stdout.write;
  const lines: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    process.stdout.write = orig;
  }
}

/** A `plan` fake that runs the REAL (already-tested) planner over a fixed,
 *  test-controlled `PlanOptions`, so a happy-path test proves real grouping
 *  rather than a canned `Plan` the step never actually had to earn. */
function realPlan(): PlanFn {
  return (candidates) =>
    planImport(candidates, {
      as: null,
      git: () => null, // nothing here is a repo: each cwd is its own root
      existingSessions: new Set(),
      tmuxEnv: undefined,
      msSocket: "/store/tmux.sock",
    });
}

/** A `scan` fake over a fixed candidate list, filtering by `dirs`/`sinceMs`
 *  exactly the way `scanConversations` documents it — a live candidate (`pid
 *  !== null`) always passes the cutoff, same as the real scanner's rule. */
function fakeScan(all: Candidate[], calls: { sinceMs: number | null; dirs: string[] }[]): ScanFn {
  return (opts) => {
    calls.push(opts);
    return all.filter((c) => {
      if (opts.dirs.length && !opts.dirs.includes(c.cwd)) return false;
      if (c.pid !== null) return true;
      if (opts.sinceMs !== null && c.lastActivity < opts.sinceMs) return false;
      return true;
    });
  };
}

/** A fresh, temp `HOME`/`MS_HOME` per test — `ctx.persist()` really writes
 *  `setup.json`, and without this it would write the operator's own real
 *  MS_HOME (`msHome()` reads `process.env.MS_HOME`, same as every other
 *  setup test — see test/setup-state.test.ts's `useTempHome`). */
function makeTestCtx(answers: string[], yes = false): { ctx: Ctx; msHome: string } {
  const { home, msHome } = tempHome();
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const state = loadSetup();
  const ctx = makeCtx(scriptedPrompter(answers), state, yes);
  return { ctx, msHome };
}

const refusingRunImport: RunImportFn = async () => {
  throw new Error("runImport should not have been called");
};
const refusingScan: ScanFn = () => {
  throw new Error("scan should not have been called");
};
const refusingPlan: PlanFn = () => {
  throw new Error("plan should not have been called");
};

// --- Declining -------------------------------------------------------------

test("declining the opening question moves nothing and asks nothing else", async () => {
  const { ctx } = makeTestCtx(["n"]);
  const step = importStep({ runImport: refusingRunImport, scan: refusingScan, plan: refusingPlan });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.equal(ctx.state.importManifest, null);
  assert.ok(lines.some((l) => /Leaving conversations that run outside tmux/.test(l)), lines.join("\n"));
});

test("--yes answers the opening question No and never touches scan/plan/runImport", async () => {
  const { ctx } = makeTestCtx([], true);
  const step = importStep({ runImport: refusingRunImport, scan: refusingScan, plan: refusingPlan });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.equal(ctx.state.importManifest, null);
  assert.ok(lines.some((l) => /Leaving conversations that run outside tmux/.test(l)), lines.join("\n"));
});

// --- Nothing found -----------------------------------------------------

test("an empty first scan says so and marks the step done without asking anything else", async () => {
  const { ctx } = makeTestCtx(["y"]);
  const calls: { sinceMs: number | null; dirs: string[] }[] = [];
  const step = importStep({ runImport: refusingRunImport, scan: fakeScan([], calls), plan: refusingPlan });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sinceMs: null, dirs: [] });
  assert.equal(ctx.state.importManifest, null);
  assert.ok(lines.some((l) => /No conversations found/.test(l)), lines.join("\n"));
});

test("an empty rescan (everything fell outside the chosen window) stops before planning", async () => {
  const dirA = "/Users/x/src/data";
  // Idle and decades old — older than any of the four windows regardless of
  // when this test actually runs (the step's cutoff is real Date.now(), not
  // the fixture clock T0 other tests use for candidates that stay excluded
  // by directory choice rather than by time).
  const ANCIENT = Date.UTC(2000, 0, 1);
  const all = [cand({ cwd: dirA, lastActivity: ANCIENT, pid: null })];
  const { ctx } = makeTestCtx(["y", "all", "1"]); // move? yes; dirs: all; window: 1h
  const calls: { sinceMs: number | null; dirs: string[] }[] = [];
  const step = importStep({ runImport: refusingRunImport, scan: fakeScan(all, calls), plan: refusingPlan });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].dirs, [dirA]);
  assert.equal(ctx.state.importManifest, null);
  assert.ok(lines.some((l) => /No conversations left in that window/.test(l)), lines.join("\n"));
});

// --- The directory menu -----------------------------------------------

test("the directory menu numbers each distinct cwd with its total and live counts", async () => {
  const dirA = "/Users/x/src/data";
  const dirB = "/Users/x/src/anu";
  const all = [
    cand({ cwd: dirA, lastActivity: T0, pid: 111 }), // live
    cand({ cwd: dirA, lastActivity: T0 - H }),
    cand({ cwd: dirB, lastActivity: T0 - 2 * H }),
  ];
  const { ctx } = makeTestCtx(["y", "all", "2"]);
  const calls: { sinceMs: number | null; dirs: string[] }[] = [];
  const step = importStep({ runImport: refusingRunImport, scan: fakeScan(all, calls), plan: () => ({ server: "ms", socket: null, sessions: [], skipped: [] }) });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.ok(lines.includes(`1) ${dirA} — 2 (1 live)`), lines.join("\n"));
  assert.ok(lines.includes(`2) ${dirB} — 1 (0 live)`), lines.join("\n"));
});

test("an out-of-range directory choice is rejected and re-asked", async () => {
  const dirA = "/Users/x/src/data";
  const all = [cand({ cwd: dirA, lastActivity: T0 })];
  // "5" is out of range (only one directory) — must be re-asked before "1" is accepted.
  const { ctx } = makeTestCtx(["y", "5", "1", "1"]);
  const calls: { sinceMs: number | null; dirs: string[] }[] = [];
  const step = importStep({ runImport: refusingRunImport, scan: fakeScan(all, calls), plan: () => ({ server: "ms", socket: null, sessions: [], skipped: [] }) });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.ok(lines.some((l) => /not a selection I can use/.test(l)), lines.join("\n"));
  assert.deepEqual(calls[1], { sinceMs: calls[1].sinceMs, dirs: [dirA] });
});

// --- The happy path: scan, choose one of two dirs, 1h, proceed ------------

test("choosing one of two directories and 1h rescans narrowly and plans only that directory", async () => {
  const dirA = "/Users/x/src/data";
  const dirB = "/Users/x/src/anu";
  const all = [
    cand({ cwd: dirA, lastActivity: T0, title: "fix the thing", pid: 222, argv: ["claude"], startedAt: T0 - 60_000 }),
    cand({ cwd: dirB, lastActivity: T0 - 10 * H }), // idle, well outside a 1h window
  ];
  // Move? yes. Dirs: "1" (dirA only). Window: "1" (1h). Proceed? yes.
  const { ctx, msHome } = makeTestCtx(["y", "1", "1", "y"]);
  const scanCalls: { sinceMs: number | null; dirs: string[] }[] = [];
  const runImportCalls: { plan: unknown; manifestPath: string }[] = [];
  const runImport: RunImportFn = async (plan, manifestPath) => {
    runImportCalls.push({ plan, manifestPath });
    return { moved: 1, stopped: 1, failed: 0 };
  };
  const step = importStep({ runImport, scan: fakeScan(all, scanCalls), plan: realPlan() });

  const before = Date.now();
  const { lines } = await captureStdoutAsync(() => step(ctx));
  const after = Date.now();

  // Listing scan: window "all", every directory.
  assert.deepEqual(scanCalls[0], { sinceMs: null, dirs: [] });
  // Narrowed rescan: only dirA, and a 1h-ago cutoff.
  assert.equal(scanCalls.length, 2);
  assert.deepEqual(scanCalls[1].dirs, [dirA]);
  assert.ok(scanCalls[1].sinceMs! >= before - H - 1000 && scanCalls[1].sinceMs! <= after - H + 1000, String(scanCalls[1].sinceMs));

  // The executor really ran, exactly once, over a plan that only ever saw dirA.
  assert.equal(runImportCalls.length, 1);
  const plan = runImportCalls[0].plan as ReturnType<typeof planImport>;
  const cwds = plan.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => p.candidate.cwd)));
  assert.deepEqual(cwds, [dirA]);
  assert.equal(plan.skipped.length, 0);

  // The manifest path is MS_HOME/imports/<ISO>.json, and it is what got recorded.
  assert.equal(path.dirname(runImportCalls[0].manifestPath), path.join(msHome, "imports"));
  assert.match(path.basename(runImportCalls[0].manifestPath), /^.+\.json$/);
  assert.doesNotThrow(() => new Date(path.basename(runImportCalls[0].manifestPath, ".json")).toISOString());
  assert.equal(ctx.state.importManifest, runImportCalls[0].manifestPath);

  // The plan table and the summary are both on stdout.
  assert.ok(lines.some((l) => l.startsWith("PROVIDER")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes(dirA) && l.includes("fix the thing")), lines.join("\n"));
  assert.ok(lines.some((l) => /moved 1, stopped 1, failed 0/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes(`Manifest: ${runImportCalls[0].manifestPath}`)), lines.join("\n"));
});

test("choosing 'all' directories keeps every one of them in the rescan", async () => {
  const dirA = "/Users/x/src/data";
  const dirB = "/Users/x/src/anu";
  const all = [cand({ cwd: dirA, lastActivity: T0 }), cand({ cwd: dirB, lastActivity: T0 })];
  const { ctx } = makeTestCtx(["y", "all", ""]); // "" -> default window (2h)
  const scanCalls: { sinceMs: number | null; dirs: string[] }[] = [];
  const step = importStep({ runImport: refusingRunImport, scan: fakeScan(all, scanCalls), plan: () => ({ server: "ms", socket: null, sessions: [], skipped: [] }) });
  await captureStdoutAsync(() => step(ctx));
  assert.deepEqual(new Set(scanCalls[1].dirs), new Set([dirA, dirB]));
});

// --- Declining the plan itself ------------------------------------------

test("declining 'Proceed?' after seeing the plan moves nothing", async () => {
  const dirA = "/Users/x/src/data";
  // Real "now", not the fixture clock T0: this candidate must survive the
  // rescan's real-Date.now() cutoff to reach the Proceed? question at all.
  const all = [cand({ cwd: dirA, lastActivity: Date.now() })];
  const { ctx } = makeTestCtx(["y", "all", "1", "n"]);
  const step = importStep({ runImport: refusingRunImport, scan: fakeScan(all, []), plan: realPlan() });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.equal(ctx.state.importManifest, null);
  assert.ok(lines.some((l) => /Not moving anything/.test(l)), lines.join("\n"));
});

// --- Nothing plannable (every candidate skipped) ---------------------------

test("a plan with nothing movable (everything skipped) says so and never calls the executor", async () => {
  const dirA = "/Users/x/src/data";
  const all = [cand({ cwd: dirA, lastActivity: T0, inTmux: true, pid: 333 })];
  const { ctx } = makeTestCtx(["y", "all", "1"]);
  const step = importStep({
    runImport: refusingRunImport,
    scan: fakeScan(all, []),
    plan: (candidates) => ({ server: "ms", socket: null, sessions: [], skipped: candidates.map((c) => ({ candidate: c, reason: "in tmux" })) }),
  });
  const { lines } = await captureStdoutAsync(() => step(ctx));
  assert.equal(ctx.state.importManifest, null);
  assert.ok(lines.some((l) => /Nothing left to move/.test(l)), lines.join("\n"));
});
