// test/import-plan.test.ts — the planner (`src/import/plan.ts`).
//
// Pure: no filesystem, no tmux, no git. `git` is a function the test supplies,
// which is what makes "this cwd is in that worktree" a rule to prove rather
// than a repo to build.
import test from "node:test";
import assert from "node:assert/strict";
import type { Candidate } from "../src/import/scan.ts";
import type { PlanOptions } from "../src/import/plan.ts";

const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);
let seq = 0;

function cand(over: Partial<Candidate> & Pick<Candidate, "cwd">): Candidate {
  seq += 1;
  return {
    provider: "claude", id: `id-${seq}`, transcriptPath: `/t/${seq}.jsonl`,
    lastActivity: T0 - seq * 1000, title: `title ${seq}`, compacted: false,
    pid: null, argv: null, startedAt: null, inTmux: false, managed: false,
    ...over,
  };
}

/** A `git` stand-in over a declared world: `roots` maps a cwd prefix to its
 *  repo root, `worktrees` maps a root to its `git worktree list --porcelain`
 *  output. Anything unclaimed is not a repo, which is what `null` means. */
function fakeGit(world: { roots?: Record<string, string>; worktrees?: Record<string, string> } = {}) {
  return (args: string[], cwd: string): string | null => {
    if (args[0] === "rev-parse") {
      for (const [prefix, root] of Object.entries(world.roots ?? {})) {
        if (cwd === prefix || cwd.startsWith(prefix + "/")) return root;
      }
      return null;
    }
    if (args[0] === "worktree") return world.worktrees?.[cwd] ?? null;
    return null;
  };
}

function opts(over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    as: null, git: fakeGit(), existingSessions: new Set(), tmuxEnv: undefined,
    msSocket: "/store/tmux.sock", ...over,
  };
}

const porcelain = (entries: [string, string | null][]): string =>
  entries.map(([p, branch]) => `worktree ${p}\nHEAD abc123\n${branch ? `branch refs/heads/${branch}` : "detached"}\n`).join("\n");

const paneIds = (plan: { sessions: { windows: { panes: { candidate: Candidate }[] }[] }[] }): string[] =>
  plan.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => p.candidate.id)));

// --- Grouping --------------------------------------------------------------

test("conversations group by repo root, then by worktree, newest first", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const data = "/Users/x/src/data";
  const wt = "/Users/x/src/ms-imp1";
  const anu = "/Users/x/src/anu";
  const plan = planImport(
    [
      cand({ cwd: anu, lastActivity: T0 - 3000, id: "anu-1" }),
      cand({ cwd: `${wt}/src`, lastActivity: T0 - 1000, id: "wt-1" }),
      cand({ cwd: data, lastActivity: T0 - 2000, id: "data-1" }),
      cand({ cwd: `${data}/lib`, lastActivity: T0 - 4000, id: "data-2" }),
    ],
    opts({
      git: fakeGit({
        roots: { [data]: data, [wt]: data, [anu]: anu },
        worktrees: { [data]: porcelain([[data, "main"], [wt, "import-scan"]]), [anu]: porcelain([[anu, "main"]]) },
      }),
    }),
  );

  assert.deepEqual(plan.sessions.map((s) => s.name), ["data", "anu"], "the root holding the newest work comes first");
  assert.deepEqual(plan.sessions[0]!.root, data);
  assert.deepEqual(plan.sessions[0]!.windows.map((w) => w.name), ["import-scan", "main"]);
  assert.deepEqual(plan.sessions[0]!.windows.map((w) => w.worktree), [wt, data]);
  assert.deepEqual(plan.sessions[0]!.windows[0]!.panes.map((p) => p.candidate.id), ["wt-1"]);
  assert.deepEqual(plan.sessions[0]!.windows[1]!.panes.map((p) => p.candidate.id), ["data-1", "data-2"]);
  assert.deepEqual(plan.sessions[1]!.windows[0]!.panes.map((p) => p.candidate.id), ["anu-1"]);
  assert.deepEqual(plan.skipped, []);
});

test("a directory that is not a repo is its own root, and the window is its basename", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const plan = planImport([cand({ cwd: "/Users/x/notes", id: "n" })], opts());
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0]!.name, "notes");
  assert.equal(plan.sessions[0]!.root, "/Users/x/notes");
  assert.equal(plan.sessions[0]!.windows[0]!.name, "notes");
  assert.equal(plan.sessions[0]!.windows[0]!.worktree, "/Users/x/notes");
});

test("a detached worktree takes its directory's basename for a window name", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const wt = "/Users/x/src/detached-wt";
  const plan = planImport(
    [cand({ cwd: wt, id: "d" })],
    opts({
      git: fakeGit({
        roots: { [root]: root, [wt]: root },
        worktrees: { [root]: porcelain([[root, "main"], [wt, null]]) },
      }),
    }),
  );
  assert.equal(plan.sessions[0]!.windows[0]!.name, "detached-wt");
  assert.equal(plan.sessions[0]!.windows[0]!.worktree, wt);
});

test("the longest matching worktree path wins, so a nested worktree is not swallowed by its parent", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const nested = "/Users/x/src/data/wt/feature";
  const plan = planImport(
    [cand({ cwd: `${nested}/src`, id: "n" })],
    opts({
      git: fakeGit({
        roots: { [root]: root },
        worktrees: { [root]: porcelain([[root, "main"], [nested, "feature"]]) },
      }),
    }),
  );
  assert.equal(plan.sessions[0]!.windows[0]!.name, "feature");
  assert.equal(plan.sessions[0]!.windows[0]!.worktree, nested);
});

// --- Four panes per window -------------------------------------------------

test("a window holds four panes; the fifth opens `name:2` and the ninth `name:3`", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const nine = Array.from({ length: 9 }, (_, i) =>
    cand({ cwd: root, id: `c${i + 1}`, lastActivity: T0 - i * 1000 }));
  const plan = planImport(nine, opts({
    git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }),
  }));

  const windows = plan.sessions[0]!.windows;
  assert.deepEqual(windows.map((w) => w.name), ["main", "main:2", "main:3"]);
  assert.deepEqual(windows.map((w) => w.panes.length), [4, 4, 1]);
  assert.deepEqual(windows.map((w) => w.panes.map((p) => p.index)), [[0, 1, 2, 3], [0, 1, 2, 3], [0]]);
  assert.deepEqual(paneIds(plan), ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]);
  assert.deepEqual(windows.map((w) => w.worktree), [root, root, root]);
  for (const w of windows) for (const p of w.panes) assert.equal(p.session, "data");
  assert.equal(windows[1]!.panes[0]!.window, "main:2");
});

test("four is exactly four: a fourth pane does not overflow", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const four = Array.from({ length: 4 }, (_, i) => cand({ cwd: root, id: `c${i + 1}`, lastActivity: T0 - i * 1000 }));
  const plan = planImport(four, opts({
    git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }),
  }));
  assert.deepEqual(plan.sessions[0]!.windows.map((w) => w.name), ["main"]);
  assert.equal(plan.sessions[0]!.windows[0]!.panes.length, 4);
});

// --- Naming ----------------------------------------------------------------

test("two roots with the same basename: the second takes its parent's name too", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const mine = "/Users/aadarwal/data";
  const theirs = "/Users/other/data";
  const plan = planImport(
    [cand({ cwd: mine, id: "m", lastActivity: T0 }), cand({ cwd: theirs, id: "t", lastActivity: T0 - 1000 })],
    opts({
      git: fakeGit({
        roots: { [mine]: mine, [theirs]: theirs },
        worktrees: { [mine]: porcelain([[mine, "main"]]), [theirs]: porcelain([[theirs, "main"]]) },
      }),
    }),
  );
  assert.deepEqual(plan.sessions.map((s) => s.name), ["data", "data (other)"]);
  assert.deepEqual(plan.sessions.map((s) => s.root), [mine, theirs]);
  assert.equal(plan.sessions[1]!.windows[0]!.panes[0]!.session, "data (other)");
});

test("an existing tmux session of that name is reused, not renamed around", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const plan = planImport(
    [cand({ cwd: root, id: "c" })],
    opts({
      existingSessions: new Set(["data", "scratch"]),
      git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }),
    }),
  );
  assert.deepEqual(plan.sessions.map((s) => s.name), ["data"]);
});

test("a synthesised name steps over an existing session it would otherwise land on", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const mine = "/Users/aadarwal/data";
  const theirs = "/Users/other/data";
  const plan = planImport(
    [cand({ cwd: mine, id: "m", lastActivity: T0 }), cand({ cwd: theirs, id: "t", lastActivity: T0 - 1000 })],
    opts({
      existingSessions: new Set(["data", "data (other)"]),
      git: fakeGit({
        roots: { [mine]: mine, [theirs]: theirs },
        worktrees: { [mine]: porcelain([[mine, "main"]]), [theirs]: porcelain([[theirs, "main"]]) },
      }),
    }),
  );
  assert.deepEqual(
    plan.sessions.map((s) => s.name),
    ["data", "data (other-2)"],
    "the plain name is a reuse; a name we invented must not collide with something unrelated",
  );
});

// --- Commands --------------------------------------------------------------

test("a Claude pane resumes through `ms claude`, keeping only whitelisted flags", async () => {
  const { planImport, KEPT_FLAGS } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const plan = planImport(
    [cand({
      cwd: root, id: "sess-1", provider: "claude", pid: 4321,
      argv: ["claude", "--model", "opus", "--api-key", "sk-secret", "--dangerously-skip-permissions", "fix the tests", "--resume", "old-id"],
    })],
    opts({ git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }),
  );
  assert.deepEqual(plan.sessions[0]!.windows[0]!.panes[0]!.command, [
    "ms", "claude", "--", "--model", "opus", "--dangerously-skip-permissions", "--resume", "sess-1",
  ]);
  assert.ok(KEPT_FLAGS.claude.includes("--model"));
  assert.ok(!KEPT_FLAGS.claude.includes("--api-key"));
});

test("a Codex pane resumes through `ms adopt`, which copies the rollout and its lineage", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const plan = planImport(
    [cand({
      cwd: root, id: "roll-1", provider: "codex", pid: 99, compacted: true,
      argv: ["codex", "--yolo", "--sandbox", "danger-full-access", "--api-key", "sk-secret", "resume", "roll-1"],
    })],
    opts({ git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }),
  );
  assert.deepEqual(plan.sessions[0]!.windows[0]!.panes[0]!.command, [
    "ms", "adopt", "roll-1", "--continue", "--", "--yolo", "--sandbox", "danger-full-access",
  ]);
});

test("`--as` names the account on every pane, and an idle conversation carries no flags", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const plan = planImport(
    [
      cand({ cwd: root, id: "c-1", provider: "claude", lastActivity: T0 }),
      cand({ cwd: root, id: "r-1", provider: "codex", lastActivity: T0 - 1000 }),
    ],
    opts({ as: "work", git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }),
  );
  const [claude, codex] = plan.sessions[0]!.windows[0]!.panes;
  assert.deepEqual(claude!.command, ["ms", "claude", "--as", "work", "--", "--resume", "c-1"]);
  assert.deepEqual(codex!.command, ["ms", "adopt", "r-1", "--as", "work", "--continue"]);
});

test("the whitelist keeps a flag's value with it, and drops a secret whatever shape it arrives in", async () => {
  const { keptFlags } = await import("../src/import/plan.ts");
  assert.deepEqual(keptFlags("codex", ["codex", "--yolo", "--model", "gpt-5", "--api-key", "sk-secret"]),
    ["--yolo", "--model", "gpt-5"]);
  assert.deepEqual(keptFlags("codex", ["codex", "--api-key=sk-secret", "--full-auto"]), ["--full-auto"]);
  assert.deepEqual(keptFlags("claude", ["node", "/x/claude", "--allowedTools", "Bash(ls)", "--verbose"]),
    ["--allowedTools", "Bash(ls)"], "an unlisted flag goes even when it is harmless");
  assert.deepEqual(keptFlags("claude", ["claude", "--model=sonnet"]), ["--model=sonnet"]);
  assert.deepEqual(keptFlags("claude", ["claude", "a prompt", "--model", "sonnet"]), ["--model", "sonnet"]);
  assert.deepEqual(keptFlags("claude", null), []);
  assert.deepEqual(keptFlags("codex", ["codex", "--profile"]), ["--profile"], "a value-taking flag at the end keeps itself");
});

// --- The target server -----------------------------------------------------

test("the plan targets the server the command is being run from, else the tool's own", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const inside = planImport([], opts({ tmuxEnv: "/private/tmp/tmux-501/default,12345,0" }));
  assert.equal(inside.server, "current");
  assert.equal(inside.socket, "/private/tmp/tmux-501/default");

  const outside = planImport([], opts({ tmuxEnv: undefined }));
  assert.equal(outside.server, "ms");
  assert.equal(outside.socket, "/store/tmux.sock");

  const empty = planImport([], opts({ tmuxEnv: "" }));
  assert.equal(empty.server, "ms", "an empty TMUX is not a server");
});

// --- Skipping --------------------------------------------------------------

test("in tmux, already managed, and live-with-no-conversation are skipped, each by name", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const plan = planImport(
    [
      cand({ cwd: root, id: "keep", lastActivity: T0 }),
      cand({ cwd: root, id: "in-a-pane", inTmux: true, pid: 1, argv: ["claude"], lastActivity: T0 - 1000 }),
      cand({ cwd: root, id: "ours", managed: true, lastActivity: T0 - 2000 }),
      cand({ cwd: root, id: "", pid: 2, argv: ["codex"], provider: "codex", lastActivity: T0 - 3000 }),
    ],
    opts({ git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }),
  );
  assert.deepEqual(paneIds(plan), ["keep"]);
  assert.deepEqual(
    plan.skipped.map((s) => [s.candidate.id, s.reason]),
    [["in-a-pane", "in tmux"], ["ours", "already managed"], ["", "live, no conversation found"]],
  );
});

test("a session with nothing left to plan does not appear at all", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const plan = planImport(
    [cand({ cwd: root, id: "only", inTmux: true, pid: 1, argv: ["claude"] })],
    opts({ git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }),
  );
  assert.deepEqual(plan.sessions, []);
  assert.equal(plan.skipped.length, 1);
});

test("git is asked once per directory, not once per conversation", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const inner = fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } });
  const calls: string[] = [];
  const git = (args: string[], cwd: string): string | null => {
    calls.push(`${args[0]} ${cwd}`);
    return inner(args, cwd);
  };
  planImport(
    [cand({ cwd: root, id: "a" }), cand({ cwd: root, id: "b" }), cand({ cwd: `${root}/lib`, id: "c" })],
    opts({ git }),
  );
  assert.deepEqual(calls, [`rev-parse ${root}`, `worktree ${root}`, `rev-parse ${root}/lib`]);
});
