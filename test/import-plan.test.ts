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
/** Where Codex keeps a rollout — the path an imported pane adopts BY, because
 *  the id alone means nothing to a shell with no `CODEX_HOME` of ours. */
const ROLLOUTS = "/Users/x/.codex/sessions/2026/09/19";
const ROLLOUT = `${ROLLOUTS}/rollout-2026-09-19T09-15-00-r-1.jsonl`;
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

/**
 * A `git` stand-in over a declared world.
 *
 * `roots` maps a cwd prefix to the SHARED root — the thing
 * `--git-common-dir` points into, which is the same for a repo and all of its
 * linked worktrees. `toplevels` is what `--show-toplevel` answers where that
 * DIFFERS, which is exactly the case that matters: run inside a linked
 * worktree, real git answers with the worktree itself, and taking that as the
 * root is what once made a worktree its own session. `worktrees` maps a root
 * to its `git worktree list --porcelain`. Anything unclaimed is not a repo,
 * which is what `null` means.
 */
function fakeGit(world: {
  roots?: Record<string, string>;
  /** The literal `--git-common-dir` answer, for the layouts where it is not
   *  `<root>/.git`: a bare repo, or a git too old for `--path-format`. */
  commonDirs?: Record<string, string>;
  toplevels?: Record<string, string>;
  worktrees?: Record<string, string>;
} = {}) {
  const longestMatch = (map: Record<string, string> | undefined, cwd: string): string | null => {
    let best: [string, string] | null = null;
    for (const [prefix, value] of Object.entries(map ?? {})) {
      if (cwd !== prefix && !cwd.startsWith(prefix + "/")) continue;
      if (!best || prefix.length > best[0].length) best = [prefix, value];
    }
    return best ? best[1] : null;
  };
  return (args: string[], cwd: string): string | null => {
    if (args.includes("--git-common-dir")) {
      const literal = longestMatch(world.commonDirs, cwd);
      if (literal) return `${literal}\n`;
      const root = longestMatch(world.roots, cwd);
      return root ? `${root}/.git\n` : null;
    }
    if (args.includes("--show-toplevel")) {
      return longestMatch(world.toplevels, cwd) ?? longestMatch(world.roots, cwd);
    }
    if (args[0] === "worktree") return world.worktrees?.[cwd] ?? null;
    return null;
  };
}

function opts(over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    as: null, git: fakeGit(), existingSessions: new Set(), tmuxEnv: undefined,
    ...over,
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

test("a linked worktree is a window in its main repo's session, not a session of its own", async () => {
  // The live dry-run's first defect. `git rev-parse --show-toplevel` run
  // inside a linked worktree answers with the WORKTREE, so `~/live/repo-feature`
  // became a session called `repo-feature` holding one window called
  // `feature` — the branch severed from the project it belongs to. The shared
  // root is what `--git-common-dir` points into, and that is the same answer
  // from the repo and from every worktree of it.
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/ms-import-live/repo";
  const wt = "/Users/x/ms-import-live/repo-feature";
  const plain = "/Users/x/ms-import-live/notes";
  const plan = planImport(
    [
      cand({ cwd: wt, id: "w", lastActivity: T0 }),
      cand({ cwd: root, id: "r", lastActivity: T0 - 1000 }),
      cand({ cwd: plain, id: "p", lastActivity: T0 - 2000 }),
    ],
    opts({
      git: fakeGit({
        roots: { [root]: root, [wt]: root },
        toplevels: { [wt]: wt }, // real git's answer, and the whole defect
        worktrees: { [root]: porcelain([[root, "main"], [wt, "feature"]]) },
      }),
    }),
  );

  assert.deepEqual(plan.sessions.map((s) => s.name), ["repo", "notes"]);
  assert.equal(plan.sessions[0]!.root, root);
  assert.deepEqual(plan.sessions[0]!.windows.map((w) => w.name), ["feature", "main"]);
  assert.deepEqual(plan.sessions[0]!.windows.map((w) => w.worktree), [wt, root]);
  assert.deepEqual(
    plan.sessions[0]!.windows.flatMap((w) => w.panes.map((p) => `${p.session}:${p.window}`)),
    ["repo:feature", "repo:main"],
  );
  assert.equal(plan.sessions[1]!.name, "notes", "a plain directory is still a session of its own");
  assert.equal(plan.sessions[1]!.root, plain);
});

test("a layout whose common dir is not a `.git` falls back to --show-toplevel", async () => {
  // `--git-common-dir` answers `<root>/.git` for an ordinary repo and every
  // worktree of it. It does not for a bare repo (the repo dir itself), for a
  // `--separate-git-dir` or submodule layout, or on a git too old for
  // `--path-format` (a relative `.git`). Each of those degrades to the
  // previous question rather than to a computed-and-wrong root.
  const { planImport } = await import("../src/import/plan.ts");
  const bareWork = "/Users/x/work-from-bare";
  const oldGit = "/Users/x/old-git-repo";
  const plan = planImport(
    [cand({ cwd: bareWork, id: "b", lastActivity: T0 }), cand({ cwd: `${oldGit}/src`, id: "o", lastActivity: T0 - 1000 })],
    opts({
      git: fakeGit({
        commonDirs: { [bareWork]: "/Users/x/mirror.git", [oldGit]: "../.git" },
        toplevels: { [bareWork]: bareWork, [oldGit]: oldGit },
        worktrees: { [bareWork]: porcelain([[bareWork, "main"]]), [oldGit]: porcelain([[oldGit, "trunk"]]) },
      }),
    }),
  );
  assert.deepEqual(plan.sessions.map((s) => s.root), [bareWork, oldGit]);
  assert.deepEqual(plan.sessions.map((s) => s.name), ["work-from-bare", "old-git-repo"]);
  assert.deepEqual(plan.sessions.map((s) => s.windows[0]!.name), ["main", "trunk"]);
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

test("a window holds four panes; the fifth opens `name-2` and the ninth `name-3`", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const nine = Array.from({ length: 9 }, (_, i) =>
    cand({ cwd: root, id: `c${i + 1}`, lastActivity: T0 - i * 1000 }));
  const plan = planImport(nine, opts({
    git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }),
  }));

  const windows = plan.sessions[0]!.windows;
  assert.deepEqual(
    windows.map((w) => w.name),
    ["main", "main-2", "main-3"],
    "a colon is tmux's own session:window separator; an overflow window must still be nameable in a target",
  );
  for (const w of windows) assert.ok(!w.name.includes(":"), `window ${JSON.stringify(w.name)} carries tmux's own separator`);
  assert.deepEqual(windows.map((w) => w.panes.length), [4, 4, 1]);
  assert.deepEqual(windows.map((w) => w.panes.map((p) => p.index)), [[0, 1, 2, 3], [0, 1, 2, 3], [0]]);
  assert.deepEqual(paneIds(plan), ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]);
  assert.deepEqual(windows.map((w) => w.worktree), [root, root, root]);
  for (const w of windows) for (const p of w.panes) assert.equal(p.session, "data");
  assert.equal(windows[1]!.panes[0]!.window, "main-2");
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
    "ms", "claude", "--continue", "--", "--model", "opus", "--dangerously-skip-permissions", "--resume", "sess-1",
  ]);
  assert.ok(KEPT_FLAGS.claude.includes("--model"));
  assert.ok(!KEPT_FLAGS.claude.includes("--api-key"));
});

test("a Codex pane resumes through `ms adopt`, which copies the rollout and its lineage", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const rollout = "/Users/x/.codex/sessions/2026/09/19/rollout-2026-09-19T09-15-00-roll-1.jsonl";
  const plan = planImport(
    [cand({
      cwd: root, id: "roll-1", transcriptPath: rollout, provider: "codex", pid: 99, compacted: true,
      argv: ["codex", "--yolo", "--sandbox", "danger-full-access", "--api-key", "sk-secret", "resume", "roll-1"],
    })],
    opts({ git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }),
  );
  assert.deepEqual(plan.sessions[0]!.windows[0]!.panes[0]!.command, [
    "ms", "adopt", rollout, "--continue", "--", "--yolo", "--sandbox", "danger-full-access",
  ]);
});

test("a Codex pane adopts the rollout BY PATH, so the pane's shell needs no CODEX_HOME of ours", async () => {
  // Live, mini 1, 0.3.0: three Codex conversations were running under an
  // `ms`-managed home (`CODEX_HOME=~/.config/model-switcher/codex/tulp`). The
  // scanner found them, because the caller's environment named that home. The
  // pane's command did not: `ms adopt <id>` ran in a fresh login shell with no
  // `CODEX_HOME`, looked under `~/.codex`, found nothing, printed its refusal
  // and handed back the prompt. The path is the same fact with no environment
  // in it — and `ms adopt` has always taken one.
  const { planImport, paneCommand } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const managed = "/Users/x/.config/model-switcher/codex/tulp/sessions/2026/09/19/rollout-2026-09-19T09-15-00-roll-9.jsonl";
  const c = cand({ cwd: root, id: "roll-9", transcriptPath: managed, provider: "codex" });
  assert.deepEqual(paneCommand(c, "work", false), ["ms", "adopt", managed, "--as", "work"]);

  const plan = planImport([c], opts({ git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }));
  assert.deepEqual(plan.sessions[0]!.windows[0]!.panes[0]!.command, ["ms", "adopt", managed]);

  // The ID still travels: the manifest is the rollback record, and `roll-9` is
  // what a human hands `codex resume` — and what the readiness check matches
  // a store row by.
  const { manifestFromPlan } = await import("../src/import/manifest.ts");
  const row = manifestFromPlan(plan, { since: "2h", dirs: [] }).rows[0]!;
  assert.equal(row.id, "roll-9");
  assert.deepEqual(row.command, ["ms", "adopt", managed]);

  // A candidate with no file to name falls back to the id rather than adopting
  // the empty string: a plan read back from a manifest has no transcript path.
  assert.deepEqual(paneCommand(cand({ cwd: root, id: "roll-9", transcriptPath: "", provider: "codex" }), null, false),
    ["ms", "adopt", "roll-9"]);
});

test("`--as` names the account on every pane, and an idle conversation carries no flags and no continuation", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const plan = planImport(
    [
      cand({ cwd: root, id: "c-1", provider: "claude", lastActivity: T0 }),
      cand({ cwd: root, id: "r-1", provider: "codex", transcriptPath: ROLLOUT, lastActivity: T0 - 1000 }),
    ],
    opts({ as: "work", git: fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } }) }),
  );
  const [claude, codex] = plan.sessions[0]!.windows[0]!.panes;
  assert.deepEqual(claude!.command, ["ms", "claude", "--as", "work", "--", "--resume", "c-1"]);
  assert.deepEqual(
    codex!.command,
    ["ms", "adopt", ROLLOUT, "--as", "work"],
    "neither was running: there is no unfinished turn for a continuation to name",
  );
});

// --- The continuation ------------------------------------------------------

test("only a conversation this import stops carries the continuation", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const root = "/Users/x/src/data";
  const git = fakeGit({ roots: { [root]: root }, worktrees: { [root]: porcelain([[root, "main"]]) } });
  const rows = [
    cand({ cwd: root, id: "live-c", provider: "claude", pid: 11, argv: ["claude"], lastActivity: T0 }),
    cand({ cwd: root, id: "idle-c", provider: "claude", lastActivity: T0 - 1000 }),
    cand({ cwd: root, id: "live-x", provider: "codex", transcriptPath: `${ROLLOUTS}/rollout-2026-09-19T09-15-00-live-x.jsonl`, pid: 12, argv: ["codex"], lastActivity: T0 - 2000 }),
    cand({ cwd: root, id: "idle-x", provider: "codex", transcriptPath: `${ROLLOUTS}/rollout-2026-09-19T09-16-00-idle-x.jsonl`, lastActivity: T0 - 3000 }),
  ];
  const commands = (mode?: "live" | "all" | "none"): string[][] =>
    planImport(rows, opts({ git, ...(mode ? { continueFor: mode } : {}) })).sessions[0]!.windows[0]!.panes.map((p) => p.command);

  assert.deepEqual(commands(), [
    ["ms", "claude", "--continue", "--", "--resume", "live-c"],
    ["ms", "claude", "--", "--resume", "idle-c"],
    ["ms", "adopt", `${ROLLOUTS}/rollout-2026-09-19T09-15-00-live-x.jsonl`, "--continue"],
    ["ms", "adopt", `${ROLLOUTS}/rollout-2026-09-19T09-16-00-idle-x.jsonl`],
  ], "the default carries it for a stopped process and for nothing else, both providers alike");

  assert.deepEqual(commands("all").map((c) => c.includes("--continue")), [true, true, true, true]);
  assert.deepEqual(commands("none").map((c) => c.includes("--continue")), [false, false, false, false]);
});

test("a continuation sits before the `--`, where ms's own parser reads it", async () => {
  const { paneCommand } = await import("../src/import/plan.ts");
  const c = cand({ cwd: "/x", id: "s-1", provider: "claude", argv: ["claude", "--model", "opus"] });
  assert.deepEqual(paneCommand(c, null, true),
    ["ms", "claude", "--continue", "--", "--model", "opus", "--resume", "s-1"]);
  assert.deepEqual(paneCommand(c, null, false),
    ["ms", "claude", "--", "--model", "opus", "--resume", "s-1"]);
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
  assert.deepEqual(keptFlags("codex", ["codex", "--profile"]), [], "a missing value must not produce a malformed imported launch");
});

test("import preserves effort and every allow/deny/tool list value through later rotations", async () => {
  const { keptFlags, paneCommand } = await import("../src/import/plan.ts");
  const { flagsForResume } = await import("../src/recover.ts");
  for (const name of ["--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools"]) {
    const flags = ["--effort", "high", name, "Read", "Bash(rm *)", "--model=opus"];
    assert.deepEqual(keptFlags("claude", ["claude", ...flags]), flags);
    assert.deepEqual(flagsForResume(flags), flags, "the next account handoff retains the complete rule list");
    assert.deepEqual(paneCommand(cand({ cwd: "/tmp", id: "c1", argv: ["claude", ...flags] }), null, false), ["ms", "claude", "--", ...flags, "--resume", "c1"]);
  }
});

test("settings and MCP configuration are refused without exposing their values, even after Boolean options", async () => {
  const { keptFlags, configurationRefusal } = await import("../src/import/plan.ts");
  const cases = [
    ["claude", ["claude", "--verbose", "--settings", '{"env":{"KEY":"secret-value"}}'], "--settings"],
    ["claude", ["claude", "--settings=./private.json"], "--settings"],
    ["claude", ["claude", "--debug", "--mcp-config", '{"mcpServers":{"secret-value":{}}}'], "--mcp-config"],
    ["claude", ["claude", "--strict-mcp-config"], "--strict-mcp-config"],
    ["claude", ["claude", "--setting-sources", "user"], "--setting-sources"],
    ["codex", ["codex", "--no-daemon", "--config", 'mcp_servers.secret="secret-value"'], "--config"],
    ["codex", ["codex", "--no-daemon", "-c", 'mcp_servers.secret="secret-value"'], "-c"],
    ["codex", ["codex", '-cmcp_servers.secret="secret-value"'], "-c"],
  ] as const;
  for (const [provider, input, name] of cases) {
    const reason = configurationRefusal(provider, [...input]);
    assert.ok(reason?.includes(name));
    assert.match(reason!, /source process remains untouched/);
    assert.ok(!reason!.includes("secret-value"));
    assert.deepEqual(keptFlags(provider, [...input]), []);
  }
});

test("an unknown option's flag-shaped value and flags after -- never become launch settings", async () => {
  const { keptFlags, configurationRefusal } = await import("../src/import/plan.ts");
  const ambiguous = ["claude", "--append-system-prompt", "--model=secret-value"];
  assert.deepEqual(keptFlags("claude", ambiguous), []);
  assert.ok(!configurationRefusal("claude", ambiguous)!.includes("secret-value"));
  const prompt = ["claude", "--model", "opus", "--", "--settings", "secret-value", "--model=haiku"];
  assert.equal(configurationRefusal("claude", prompt), null);
  assert.deepEqual(keptFlags("claude", prompt), ["--model", "opus"]);
  for (const name of ["--system-prompt", "--model", "--allowedTools", "--disallowedTools"]) {
    const disguisedBoundary = ["claude", name, "--", "--settings", "secret-value"];
    assert.match(configurationRefusal("claude", disguisedBoundary)!, /source process remains untouched/);
    assert.deepEqual(keptFlags("claude", disguisedBoundary), []);
    assert.ok(!configurationRefusal("claude", disguisedBoundary)!.includes("secret-value"));
  }
});

test("a Codex in-process frontend preserves no-daemon without swallowing following model or policy", async () => {
  const { keptFlags, configurationRefusal } = await import("../src/import/plan.ts");
  const flags = ["--no-daemon", "--model", "gpt-6-luna", "--sandbox", "read-only"];
  for (const input of [["codex", ...flags], ["node", "/private/bin/codex", ...flags]]) {
    assert.equal(configurationRefusal("codex", input), null);
    assert.deepEqual(keptFlags("codex", input), flags);
  }
  assert.equal(configurationRefusal("codex", ["codex", "--profile=--no-daemon"]), null);
  assert.deepEqual(keptFlags("codex", ["codex", "--profile=--no-daemon"]), ["--profile=--no-daemon"]);
});

test("an unsupported configured process is skipped before stop and its secret never enters the manifest", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const { manifestFromPlan } = await import("../src/import/manifest.ts");
  const source = cand({ cwd: "/tmp", pid: 42, argv: ["claude", "--settings", '{"KEY":"secret-value"}'] });
  const plan = planImport([source], opts());
  assert.deepEqual(paneIds(plan), []);
  assert.match(plan.skipped[0]!.reason, /--settings.*source process remains untouched/);
  const manifest = manifestFromPlan(plan, { since: "2h", dirs: [] });
  assert.ok(!JSON.stringify(manifest).includes("secret-value"));
  assert.equal(manifest.rows[0]!.command, null);
});

test("remote Codex frontends are refused without persisting the address, including launcher and attached forms", async () => {
  const { configurationRefusal, keptFlags, planImport } = await import("../src/import/plan.ts");
  const { manifestFromPlan } = await import("../src/import/manifest.ts");
  const address = "unix:///private/secret-remote-address.sock";
  for (const argv of [
    ["codex", "--remote", address],
    ["/private/bin/codex", `--remote=${address}`],
    ["node", "/private/bin/codex.mjs", "resume", "r-1", "--remote", address],
    ["node22", "/private/bin/codex.js", "--profile", "work", "--remote=" + address],
  ]) {
    const source = cand({ cwd: "/tmp", provider: "codex", pid: 42, argv });
    const plan = planImport([source], opts());
    assert.deepEqual(paneIds(plan), []);
    assert.match(plan.skipped[0]!.reason, /--remote.*source process remains untouched.*use plain codex/);
    assert.deepEqual(keptFlags("codex", argv), []);
    const manifest = manifestFromPlan(plan, { since: "2h", dirs: [] });
    assert.ok(!JSON.stringify(manifest).includes(address));
    assert.equal(manifest.rows[0]!.command, null);
  }
  assert.match(configurationRefusal("codex", ["--remote", address])!, /cannot import Codex --remote/,
    "a replayed provider argument list has the same preflight");
});

test("Codex remote-looking values and prompt words are not promoted into remote options", async () => {
  const { configurationRefusal } = await import("../src/import/plan.ts");
  for (const argv of [
    ["codex", "--model=--remote"],
    ["node", "/private/bin/codex.js", "--profile=--remote"],
    ["codex", "--image=--remote"],
    ["codex", "--model", "gpt-6-luna", "--", "--remote", "a prompt word"],
    ["codex", "resume", "r-1", "--", "--remote=prompt"],
  ]) assert.equal(configurationRefusal("codex", argv), null, JSON.stringify(argv));
  // The importer's existing strict value check may refuse a flag-shaped
  // scalar value; it must not reinterpret that value as remote ownership.
  assert.doesNotMatch(configurationRefusal("codex", ["codex", "--profile", "--remote"])!, /cannot import Codex --remote/);
});

// --- The target server -----------------------------------------------------

test("the plan targets the server the command is being run from, else the default server", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const inside = planImport([], opts({ tmuxEnv: "/private/tmp/tmux-501/default,12345,0" }));
  assert.equal(inside.server, "current");
  assert.equal(inside.socket, "/private/tmp/tmux-501/default");

  const outside = planImport([], opts({ tmuxEnv: undefined }));
  assert.equal(outside.server, "default");
  assert.equal(outside.socket, null, "the default server is named by no socket at all");

  const empty = planImport([], opts({ tmuxEnv: "" }));
  assert.equal(empty.server, "default", "an empty TMUX is not a server");
});

test("MS_TMUX_SOCKET is an override outside tmux, and ignored inside it", async () => {
  const { planImport } = await import("../src/import/plan.ts");
  const outside = planImport([], opts({ tmuxEnv: undefined, socketOverride: "/store/tmux.sock" }));
  assert.equal(outside.server, "socket:/store/tmux.sock");
  assert.equal(outside.socket, "/store/tmux.sock");

  const inside = planImport([], opts({ tmuxEnv: "/tmp/cur,1,0", socketOverride: "/store/tmux.sock" }));
  assert.equal(inside.server, "current");
  assert.equal(inside.socket, "/tmp/cur");
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
    calls.push(`${args.join(" ")} @${cwd}`);
    return inner(args, cwd);
  };
  planImport(
    [cand({ cwd: root, id: "a" }), cand({ cwd: root, id: "b" }), cand({ cwd: `${root}/lib`, id: "c" })],
    opts({ git }),
  );
  // One question per directory, one per root — and in a repo the common-dir
  // answer settles it, so `--show-toplevel` is never asked at all.
  assert.deepEqual(calls, [
    `rev-parse --path-format=absolute --git-common-dir @${root}`,
    `worktree list --porcelain @${root}`,
    `rev-parse --path-format=absolute --git-common-dir @${root}/lib`,
  ]);
});
