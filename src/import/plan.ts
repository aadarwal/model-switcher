// src/import/plan.ts
//
// `ms import`, front half #2: turn the scanner's candidates into the tmux
// layout they will be moved into, and the exact command each pane will run.
//
// Pure. Nothing here reads the filesystem, talks to tmux or shells out; `git`
// arrives as a function, the set of existing session names arrives as a set,
// and `$TMUX` arrives as a string. That is what makes the plan a thing the
// human can be shown (`--dry-run`), written down (the manifest) and run later
// (`--plan`) — the decisions are all made here, once, and the executor only
// carries them out.
//
// The shape of the layout is the spec's, and it is a claim about how people
// work rather than about tmux: one session per repo ROOT (that is the project
// you are in), one window per WORKTREE (that is the branch you are on), four
// panes to a window (past four a pane is too small to read a CLI in). The
// fifth conversation in a worktree does not squeeze in; it opens `name-2`.
//
// The one rule here with a security edge is the flag whitelist. A live CLI's
// argv is carried into the new pane's command line so the conversation resumes
// the way it was running — but a command line is readable by anything that can
// talk to the tmux server, and argv is exactly where a human's `--api-key`
// ends up. So flags are KEPT BY NAME from `KEPT_FLAGS` and everything else is
// dropped, including harmless things. A whitelist fails closed; a blacklist
// fails open, and the failure is a secret in a tmux command string.

import path from "node:path";
import type { Candidate, ImportProvider } from "./scan.ts";

export interface PaneSpec {
  candidate: Candidate;
  command: string[];
  session: string;
  window: string;
  /** 0-3 within its window. */
  index: number;
}

export interface PlanWindow {
  name: string;
  worktree: string;
  panes: PaneSpec[];
}

export interface PlanSession {
  name: string;
  root: string;
  windows: PlanWindow[];
}

export interface Plan {
  /** `current` = the tmux server the command is being run from; `ms` = the
   *  tool's own server, which the human reaches with `ms attach`. */
  server: "current" | "ms";
  socket: string | null;
  sessions: PlanSession[];
  skipped: { candidate: Candidate; reason: string }[];
}

/** Which rows resume with the rotation's continuation on their command line.
 *  `live` — only a conversation whose process this import stops, because that
 *  is the one with work left mid-flight; `all` — the human said `--continue`;
 *  `none` — nobody is continued. */
export type ContinueFor = "live" | "all" | "none";

export interface PlanOptions {
  as: string | null;
  /** Default `live`. */
  continueFor?: ContinueFor;
  /** `git(args, cwd)` → stdout, or null when git failed or there is no repo. */
  git: (args: string[], cwd: string) => string | null;
  existingSessions: Set<string>;
  /** `process.env.TMUX`, verbatim. */
  tmuxEnv: string | undefined;
  msSocket: string;
}

/** How many panes a window may hold before the next one opens `name-2`. */
export const PANES_PER_WINDOW = 4;

/**
 * The flags an imported pane may inherit from the process it replaces — the
 * launch whitelist rotation already uses, per provider.
 *
 * Kept by exact name. A flag that is not on this list is dropped whatever it
 * looks like, which is the only rule under which a credential on the original
 * command line cannot reach the new one.
 */
export const KEPT_FLAGS: { claude: string[]; codex: string[] } = {
  claude: ["--model", "--permission-mode", "--dangerously-skip-permissions", "--allowedTools"],
  codex: [
    "--model", "--yolo", "--sandbox", "--ask-for-approval", "--full-auto", "--profile",
    "--dangerously-bypass-approvals-and-sandbox",
  ],
};

/** Of the kept flags, the ones whose next word is their value rather than the
 *  next flag. None of them can carry a secret — they name a model, a sandbox
 *  policy, an approval mode, a profile or a tool filter. */
const VALUE_FLAGS = new Set([
  "--model", "--sandbox", "--ask-for-approval", "--profile", "--permission-mode", "--allowedTools",
]);

/**
 * The flags of `argv` this tool will carry into the new pane.
 *
 * Everything that is not a whitelisted flag goes: an unknown flag, a
 * positional (the original prompt, a resume id), and the value of any flag
 * that did not survive — because a dropped `--api-key` leaves `sk-…` behind as
 * a bare word, and a bare word is never kept.
 */
export function keptFlags(provider: ImportProvider, argv: string[] | null): string[] {
  if (!argv) return [];
  const allowed = new Set(KEPT_FLAGS[provider]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue; // a positional, or a dropped flag's value
    const eq = token.indexOf("=");
    const name = eq < 0 ? token : token.slice(0, eq);
    if (!allowed.has(name)) continue;
    out.push(token);
    if (eq < 0 && VALUE_FLAGS.has(name)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.push(next);
        i++;
      }
    }
  }
  return out;
}

/**
 * Does this row's resumed command line carry the continuation?
 *
 * A continuation says "continue the unfinished work from this conversation",
 * and that is only true of a conversation whose CLI was RUNNING when this
 * import stopped it — the turn it was mid-way through is the work to pick up.
 * An idle transcript from three hours ago has none: handed the continuation,
 * the resumed CLI is being told to invent some, which is the exact failure
 * `CONTINUATION`'s own doc comment (src/recover.ts) records from a live
 * rotation. So the default is `live`, and `--continue` (`all`) is the human
 * saying they know better for this run.
 */
export function shouldContinue(candidate: Candidate, mode: ContinueFor = "live"): boolean {
  if (mode === "all") return true;
  if (mode === "none") return false;
  return candidate.pid !== null;
}

/**
 * The command line a pane runs, as argv for `ms`.
 *
 * Claude resumes in place (`ms claude … --resume <id>`). Codex goes through
 * `ms adopt`, which is not a detour: a rollout started outside this tool is
 * not in the shared store every `ms` Codex home reads, and a COMPACTED one
 * needs its whole lineage copied with it or the resume dies on a missing
 * source rollout (see src/adopt.ts).
 *
 * `command[0]` is the literal string `ms`, never a path: the plan is written
 * to a manifest and may be run later, and baking one install's binary path
 * into it would outlive that install. The executor substitutes `msBinary()`
 * at send time (src/import/execute.ts).
 */
export function paneCommand(candidate: Candidate, as: string | null, continueAfter: boolean): string[] {
  const flags = keptFlags(candidate.provider, candidate.argv);
  const account = as ? ["--as", as] : [];
  const carry = continueAfter ? ["--continue"] : [];
  if (candidate.provider === "claude") {
    return ["ms", "claude", ...account, ...carry, "--", ...flags, "--resume", candidate.id];
  }
  return ["ms", "adopt", candidate.id, ...account, ...carry, ...(flags.length ? ["--", ...flags] : [])];
}

/** Why a candidate is not moved. Checked in this order, so a row that is two
 *  of these is reported as the strongest claim on it. */
function skipReason(c: Candidate): string | null {
  if (c.inTmux) return "in tmux";
  if (c.managed) return "already managed";
  if (c.id === "") return "live, no conversation found";
  return null;
}

/** One `git worktree list --porcelain` entry. */
interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export function parseWorktrees(out: string | null): WorktreeEntry[] {
  if (!out) return [];
  const entries: WorktreeEntry[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) entries.push({ path: line.slice("worktree ".length), branch: null });
    else if (line.startsWith("branch ")) {
      const last = entries[entries.length - 1];
      if (last) last.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return entries;
}

const basename = (p: string): string => path.basename(p) || p;

interface WindowGroup {
  worktree: string;
  name: string;
  items: Candidate[];
}
interface RootGroup {
  root: string;
  windows: WindowGroup[];
}

export function planImport(candidates: Candidate[], opts: PlanOptions): Plan {
  const skipped: { candidate: Candidate; reason: string }[] = [];
  const movable: Candidate[] = [];
  // Newest first, everywhere: the order decides which root names itself first
  // on a collision, which window a session opens on, and which conversation
  // gets the readable top-left pane.
  for (const c of [...candidates].sort((a, b) => b.lastActivity - a.lastActivity)) {
    const reason = skipReason(c);
    if (reason) skipped.push({ candidate: c, reason });
    else movable.push(c);
  }

  // git is asked once per directory and once per root, not once per
  // conversation: a repo with forty of them would otherwise be forty forks.
  const rootCache = new Map<string, string>();
  const rootOf = (cwd: string): string => {
    const hit = rootCache.get(cwd);
    if (hit !== undefined) return hit;
    const out = opts.git(["rev-parse", "--show-toplevel"], cwd);
    const root = out && out.trim() ? out.trim() : cwd; // not a repo: its own root
    rootCache.set(cwd, root);
    return root;
  };
  const worktreeCache = new Map<string, WorktreeEntry[]>();
  const worktreesOf = (root: string): WorktreeEntry[] => {
    const hit = worktreeCache.get(root);
    if (hit !== undefined) return hit;
    const entries = parseWorktrees(opts.git(["worktree", "list", "--porcelain"], root));
    worktreeCache.set(root, entries);
    return entries;
  };

  const roots: RootGroup[] = [];
  for (const c of movable) {
    const root = rootOf(c.cwd);
    // The LONGEST containing worktree, so a worktree nested inside its own
    // repo is not swallowed by the root entry that also contains it.
    let best: WorktreeEntry | null = null;
    for (const e of worktreesOf(root)) {
      if (c.cwd === e.path || c.cwd.startsWith(e.path + path.sep)) {
        if (!best || e.path.length > best.path.length) best = e;
      }
    }
    const worktree = best?.path ?? root;
    const name = best?.branch ?? basename(worktree);

    let group = roots.find((g) => g.root === root);
    if (!group) {
      group = { root, windows: [] };
      roots.push(group);
    }
    let window = group.windows.find((w) => w.worktree === worktree);
    if (!window) {
      window = { worktree, name, items: [] };
      group.windows.push(window);
    }
    window.items.push(c);
  }

  // Session names. A collision between two of OUR roots takes the parent's
  // basename (`data`, `data (aadarwal)`). An existing tmux session of the
  // plain name is deliberately NOT a collision — that is the reuse the spec
  // asks for, windows appended to the session already open for that repo. A
  // SYNTHESISED name is different: landing it on an unrelated existing session
  // would be an accident rather than a reuse, so those are stepped over.
  const claimed = new Set<string>();
  const sessions: PlanSession[] = [];
  for (const group of roots) {
    let name = basename(group.root);
    if (claimed.has(name)) {
      const parent = basename(path.dirname(group.root));
      let alt = `${name} (${parent})`;
      for (let n = 2; claimed.has(alt) || opts.existingSessions.has(alt); n++) alt = `${name} (${parent}-${n})`;
      name = alt;
    }
    claimed.add(name);

    const windows: PlanWindow[] = [];
    for (const group_ of group.windows) {
      for (let start = 0, part = 1; start < group_.items.length; start += PANES_PER_WINDOW, part++) {
        // `-2`, never `:2`: a colon is tmux's OWN `session:window` separator,
        // so a window called `main:2` cannot be named in a target at all —
        // `-t data:main:2` parses as window `main` of session `data`. The
        // executor addresses panes by `%id` for exactly this class of reason,
        // but the NAME still has to be one tmux can hold.
        const windowName = part === 1 ? group_.name : `${group_.name}-${part}`;
        const panes = group_.items.slice(start, start + PANES_PER_WINDOW).map((candidate, index) => ({
          candidate,
          command: paneCommand(candidate, opts.as, shouldContinue(candidate, opts.continueFor)),
          session: name,
          window: windowName,
          index,
        }));
        windows.push({ name: windowName, worktree: group_.worktree, panes });
      }
    }
    sessions.push({ name, root: group.root, windows });
  }

  // The server is the one the human is in, when they are in one: an import run
  // from a tmux pane belongs in that tmux. Outside it, the tool's own server,
  // which is where every `ms` launch already goes.
  const inTmux = !!opts.tmuxEnv;
  return {
    server: inTmux ? "current" : "ms",
    socket: inTmux ? opts.tmuxEnv!.split(",")[0]! : opts.msSocket,
    sessions,
    skipped,
  };
}
