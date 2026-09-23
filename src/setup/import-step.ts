// src/setup/import-step.ts
//
// The `import` step of `ms setup` (spec: docs/superpowers/specs/
// 2026-09-19-import-design.md, "Wizard step"). It runs after `hooks` and
// before the opt-ins, and it is the one step that can be reached from a
// human's plain terminal tabs into a moved tmux pane: `Move conversations
// that run outside tmux into it?` — default No, and under `--yes` the
// driver answers that default WITHOUT ever calling `ctx.confirm`'s
// prompter, so an unattended run touches nothing here. That single default
// is the whole safety story; nothing below it needs its own `--yes` guard.
//
// Composed the same way every other step is: `scanConversations` and
// `planImport` already exist and are already tested (Tasks 1-2), and so is
// the executor (Task 3, `executeImport`, reached here through `runImportPlan`
// in `../import.ts` — the same composition the verb itself calls, so the two
// can never drift). All three moving parts are still INJECTED, though —
// `scan`/`plan` default to the real ones (composed below against the real
// environment), and `runImport` has no default at all, because `steps.ts` is
// the one place that decides which executor a run actually gets, and every
// test in `test/setup-import.test.ts` proves this module's own logic against
// a fake one.
//
// The manifest is written HERE, before `runImport` is ever called —
// `executeImport`'s first act is reading that file back (`src/import/
// execute.ts`), so a step that asked the human to confirm a plan it had not
// yet written down would hand the executor a path that does not exist.
//
// This module never talks to setup.json directly beyond `ctx.state`/
// `ctx.persist()`, same as every other step; `Ctx` is imported type-only so
// there is no runtime cycle back to steps.ts, which imports this module.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { formatManifest, manifestFromPlan, manifestPath, readManifest, writeManifest } from "../import/manifest.ts";
import { defaultScanDeps, scanConversations, type Candidate } from "../import/scan.ts";
import { planImport, type Plan } from "../import/plan.ts";
import { ensureStore, msHome } from "../paths.ts";
import { Tmux } from "../tmux.ts";
import type { Ctx } from "./steps.ts"; // type-only: erased, no import cycle at runtime

/** What the step asks the scanner for on each pass: a cutoff (null = every
 *  idle conversation too, "all") and the directories chosen in the wizard. */
export type ScanFn = (opts: { sinceMs: number | null; dirs: string[] }) => Candidate[];

/** Everything the step varies about the plan is already baked into
 *  `candidates` by the time this runs — the wizard asks no account-override
 *  question of its own, so `as` is always null and the rest of `PlanOptions`
 *  is the real environment. */
export type PlanFn = (candidates: Candidate[]) => Plan;

/** `executeImport`'s own contract (`src/import/execute.ts`, reached in
 *  production through `runImportPlan` in `../import.ts`), declared here
 *  rather than imported so this step's tests can inject a fake without
 *  pulling in tmux, signals or the store. */
export type RunImportFn = (plan: Plan, manifestPath: string) => Promise<{ moved: number; stopped: number; failed: number }>;

export interface ImportStepDeps {
  runImport: RunImportFn;
  scan?: ScanFn;
  plan?: PlanFn;
}

/** `1h/2h/6h/24h`, in the menu order the spec gives; index 1 (`2h`) is the
 *  default, which is what a human who says nothing gets. */
const WINDOWS: { label: string; hours: number }[] = [
  { label: "1h", hours: 1 },
  { label: "2h", hours: 2 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
];
const DEFAULT_WINDOW_CHOICE = "2";

const GIT_TIMEOUT_MS = 10_000;

/** The real Claude Code / Codex config dirs on THIS machine — never this
 *  tool's own per-account stores (`src/paths.ts`'s `p.claudeConfigDir`,
 *  which is where `ms` keeps a subscription's credentials, not where the
 *  human's own CLI keeps its conversations). Same rule `src/launch.ts` and
 *  `src/adopt.ts` already apply to their own copies of this: `CLAUDE_CONFIG_DIR`/
 *  `CODEX_HOME` are the CLIs' own overrides and are read from THIS process's
 *  environment, because a human running either CLI out of a non-default home
 *  is exactly who `~/.claude`/`~/.codex` would be the wrong answer for. */
function realClaudeConfigDir(): string {
  const v = process.env.CLAUDE_CONFIG_DIR;
  return v && v.length > 0 ? v : path.join(process.env.HOME || homedir(), ".claude");
}
function realCodexHome(): string {
  const v = process.env.CODEX_HOME;
  return v && v.length > 0 ? v : path.join(process.env.HOME || homedir(), ".codex");
}

/** The scan the wizard runs when nothing is injected: the real stores, the
 *  real process table, the real tmux server, this tool's own managed-id set. */
export function defaultScan(opts: { sinceMs: number | null; dirs: string[] }): Candidate[] {
  return scanConversations({
    claudeConfigDir: realClaudeConfigDir(),
    codexHome: realCodexHome(),
    sinceMs: opts.sinceMs,
    dirs: opts.dirs,
    ...defaultScanDeps(),
  });
}

/** The tool's own tmux server for a plan run with no `$TMUX` of its own —
 *  same path `src/launch.ts`'s `TOOL_SOCKET` derives, spelled out again here
 *  because that constant is not exported (this step's only dependency on
 *  launch.ts would be for one path join). */
function toolSocket(): string {
  return path.join(msHome(), "tmux.sock");
}

/** Every session name on ONE tmux server, or an empty set when the server is
 *  not even up yet — which is not a failure, it just means no name is taken. */
function existingSessionNames(socket: string): Set<string> {
  const r = new Tmux(socket).run(["list-sessions", "-F", "#{session_name}"]);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\n").filter(Boolean));
}

function realGit(args: string[], cwd: string): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return r.status === 0 ? r.stdout : null;
}

/** The plan the wizard runs when nothing is injected: real `git`, the real
 *  session-name collision set of whichever server the plan will land on
 *  (`plan.ts`'s own rule — `$TMUX`'s socket when there is one, else this
 *  tool's), no `--as` override. */
export function defaultPlan(candidates: Candidate[]): Plan {
  const tmuxEnv = process.env.TMUX;
  const socket = tmuxEnv && tmuxEnv.length > 0 ? tmuxEnv.split(",")[0]! : toolSocket();
  return planImport(candidates, {
    as: null,
    git: realGit,
    existingSessions: existingSessionNames(socket),
    tmuxEnv,
    msSocket: toolSocket(),
  });
}

// --- Presentation ----------------------------------------------------------

/** `1) <dir> — N (M live)`, one line per distinct cwd, in the order the scan
 *  first showed it (that order is `lastActivity` descending — the busiest
 *  directory leads the menu). */
function dirMenu(candidates: Candidate[]): { dirs: string[]; lines: string[] } {
  const dirs: string[] = [];
  const counts = new Map<string, { total: number; live: number }>();
  for (const c of candidates) {
    let e = counts.get(c.cwd);
    if (!e) {
      e = { total: 0, live: 0 };
      counts.set(c.cwd, e);
      dirs.push(c.cwd);
    }
    e.total += 1;
    if (c.pid !== null) e.live += 1;
  }
  const lines = dirs.map((d, i) => {
    const { total, live } = counts.get(d)!;
    return `${i + 1}) ${d} — ${total} (${live} live)`;
  });
  return { dirs, lines };
}

// --- Asking ------------------------------------------------------------

/** `1,3` or `all`. Re-asks on anything else — an index out of range, empty
 *  input, a stray word — because a wizard that silently picked "all" (or
 *  nothing) for an unparsable answer would move conversations the human did
 *  not choose. Unreachable under `--yes`: the step already returned before
 *  this question exists (see the module doc), so there is no default to
 *  fall back on here and none is needed. */
async function askDirs(ctx: Ctx, dirs: string[]): Promise<string[]> {
  for (;;) {
    const raw = (await ctx.ask("Which directories? (e.g. 1,3 or all)", { default: "all" })).trim();
    if (raw.toLowerCase() === "all") return dirs;
    const picked = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s));
    if (picked.length && picked.every((n) => Number.isInteger(n) && n >= 1 && n <= dirs.length)) {
      return [...new Set(picked)].map((n) => dirs[n - 1]!);
    }
    ctx.say(`That is not a selection I can use; answer with numbers like 1,3 (1-${dirs.length}) or 'all'.`);
  }
}

async function askWindowHours(ctx: Ctx): Promise<number> {
  for (const [i, w] of WINDOWS.entries()) ctx.say(`${i + 1}) ${w.label}`);
  const choice = await ctx.ask("Window?", { choices: WINDOWS.map((_, i) => String(i + 1)), default: DEFAULT_WINDOW_CHOICE });
  return WINDOWS[Number(choice) - 1]!.hours;
}

// --- The step ------------------------------------------------------------

/**
 * Build the `import` step's runner.
 *
 * Returns a plain `(ctx: Ctx) => Promise<void>`, which is exactly the shape
 * `STEP_RUNNERS` wants — `steps.ts` calls this once, at module load, wiring
 * in whichever `runImport` it was given (the real `executeImport`, reached
 * through `runImportPlan`, in production; a fake in every test here).
 */
export function importStep(deps: ImportStepDeps): (ctx: Ctx) => Promise<void> {
  const scan = deps.scan ?? defaultScan;
  const plan = deps.plan ?? defaultPlan;
  const { runImport } = deps;

  return async (ctx: Ctx): Promise<void> => {
    const doIt = await ctx.confirm("Move conversations that run outside tmux into it?", false);
    if (!doIt) {
      ctx.say("Leaving conversations that run outside tmux where they are.");
      return;
    }

    // The full listing, unfiltered — "window all" — so the directory menu's
    // counts are honest about everything found, not just what a later cutoff
    // would keep.
    const found = scan({ sinceMs: null, dirs: [] });
    if (found.length === 0) {
      ctx.say("No conversations found running outside tmux.");
      return;
    }

    const { dirs, lines } = dirMenu(found);
    ctx.say("Conversations found:");
    for (const l of lines) ctx.say(l);
    const chosenDirs = await askDirs(ctx, dirs);

    const hours = await askWindowHours(ctx);
    const sinceMs = Date.now() - hours * 3_600_000;

    const candidates = scan({ sinceMs, dirs: chosenDirs });
    if (candidates.length === 0) {
      ctx.say("No conversations left in that window.");
      return;
    }

    const thePlan = plan(candidates);
    if (thePlan.sessions.length === 0) {
      ctx.say("Nothing left to move — every conversation found is already in tmux, already managed, or a live process with none found.");
      return;
    }

    // Written NOW, before the human is even asked to proceed — the plan
    // shown below is read back from this same file (same as `ms import`
    // itself), and `runImport` (`executeImport`) reads this path as its
    // first act, so it must already exist by the time that call happens.
    const file = manifestPath();
    ensureStore();
    writeManifest(file, manifestFromPlan(thePlan, { since: `${hours}h`, dirs: chosenDirs }));
    ctx.say(formatManifest(readManifest(file)));

    if (!(await ctx.confirm("Proceed?", false))) {
      ctx.say(`Not moving anything — the plan is written: ms import --plan ${file}`);
      return;
    }

    const result = await runImport(thePlan, file);
    ctx.state.importManifest = file;
    ctx.persist();
    ctx.say(`moved ${result.moved}, stopped ${result.stopped}, failed ${result.failed}`);
    ctx.say(`Manifest: ${file}`);
  };
}
