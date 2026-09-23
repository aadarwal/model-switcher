// src/import.ts
//
// `ms import`: bring conversations that run outside tmux into it.
//
//   ms import [--since <window>] [--dir <path>]… [--as <account>]
//             [--continue] [--include-tmux] [--dry-run] [--yes]
//   ms import --plan <manifest>
//   ms import --status <manifest>
//
// People run dozens of Claude Code and Codex conversations in plain terminal
// tabs. None of them can rotate on a usage wall — no pane to respawn, no row,
// no account of ours — and none is visible to `ms status`. A running process
// cannot be moved into tmux on macOS, but both CLIs keep every conversation on
// disk keyed by working directory, so the conversation can be found, its
// original stopped, and the SAME conversation resumed in a tmux pane under an
// account with room. That is the whole verb.
//
// This file is the seam between the three halves that do the work and the
// human: it parses the command line, composes the scanner's real dependencies
// (src/import/scan.ts), hands the candidates to the pure planner
// (src/import/plan.ts), writes the manifest (src/import/manifest.ts), shows the
// table, asks ONCE, and runs the executor (src/import/execute.ts).
//
// Two refusals are deliberate and both are about consent. An import stops
// processes a human did not stop themselves, so it asks first — and a stdin
// that is not a terminal cannot answer, which is a refusal (exit 2), never an
// assumed yes. And `--yes` is the only way past it, so a wizard or a script
// that skips the question has said so out loud.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import type { Verb } from "./cli.ts";
import { ensureStore, msHome } from "./paths.ts";
import { openState } from "./state.ts";
import { Tmux } from "./tmux.ts";
import { rolloutIdsFromName } from "./adopt.ts";
import { defaultScanDeps, scanConversations } from "./import/scan.ts";
import { planImport, type ContinueFor, type Plan } from "./import/plan.ts";
import { formatManifest, manifestFromPlan, manifestPath, planFromManifest, readManifest, writeManifest } from "./import/manifest.ts";
import { executeImport, paneReturnWatch, pidAlive, shellPollMs, signalPid, type ExecuteDeps } from "./import/execute.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `usage: ms import [--since <window>] [--dir <path>]… [--as <account>] [--continue] [--include-tmux] [--dry-run] [--yes]
       ms import --plan <manifest>
       ms import --status <manifest>
  <window> is 30m, 2h, 1d or all (default 2h); it filters idle conversations only.`;

/** Every word this verb says goes through the io it was handed — so the
 *  refusals a test has to prove (a stdin nobody can answer from, a manifest
 *  that will not parse) are readable in process, which is the only place the
 *  no-terminal case can be exercised at all: a test's own stdin is a pipe. */
const sayTo = (io: ImportIo) => (msg: string, detail: string[] = []): void => {
  io.err(`ms import: ${msg}\n${detail.map((l) => `  ${l}\n`).join("")}`);
};

const usageTo = (io: ImportIo) => (why: string): 2 => {
  sayTo(io)(why);
  io.err(USAGE + "\n");
  return EXIT_USAGE;
};

// --- The command line ---------------------------------------------------

export interface ImportArgs {
  since: string;
  dirs: string[];
  as: string | null;
  continueFor: ContinueFor;
  includeTmux: boolean;
  dryRun: boolean;
  yes: boolean;
  plan: string | null;
  status: string | null;
}

/**
 * `--since` as an epoch-ms CUTOFF, which is what the scanner wants: it has no
 * clock of its own, deliberately (src/import/scan.ts), so the conversion from
 * "two hours" to "since 10:41" happens exactly here, once.
 *
 * `all` is null — every idle conversation, however old. Anything else is a
 * number and one of `m`/`h`/`d`; a bare number would have to guess a unit, and
 * the guess is the difference between half an hour and half a day.
 */
export function parseSince(raw: string, now: number): { ms: number | null } | { error: string } {
  if (raw === "all") return { ms: null };
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!m) return { error: `--since takes 30m, 2h, 1d or all, not ${JSON.stringify(raw)}` };
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]!;
  return { ms: now - n * unit };
}

export function parseImportArgs(argv: string[]): ImportArgs | { error: string } {
  const out: ImportArgs = {
    since: "2h", dirs: [], as: null, continueFor: "live", includeTmux: false,
    dryRun: false, yes: false, plan: null, status: null,
  };
  /** The flags that take a value, and where each one puts it. */
  const takesValue: Record<string, (v: string) => void> = {
    "--since": (v) => { out.since = v; },
    "--dir": (v) => { out.dirs.push(v); },
    "--as": (v) => { out.as = v; },
    "--plan": (v) => { out.plan = v; },
    "--status": (v) => { out.status = v; },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--yes" || a === "-y") { out.yes = true; continue; }
    if (a === "--include-tmux") { out.includeTmux = true; continue; }
    if (a === "--continue") { out.continueFor = "all"; continue; }
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    const set = takesValue[name];
    if (!set) return { error: `unexpected argument ${JSON.stringify(a)}` };
    if (eq >= 0) {
      const v = a.slice(eq + 1);
      if (!v) return { error: `${name} needs a value` };
      set(v);
      continue;
    }
    const next = argv[i + 1];
    // `ms import --dir --yes` is a forgotten path, not a directory called
    // `--yes`: swallowing the next flag would scan somewhere nobody named.
    if (!next || next.startsWith("-")) return { error: `${name} needs a value` };
    set(next);
    i += 1;
  }
  if (out.plan && out.status) return { error: "--plan and --status name two different jobs; pick one" };
  if ((out.plan || out.status) && (out.dirs.length || out.as || out.includeTmux || out.since !== "2h" || out.continueFor !== "live")) {
    return { error: "--plan and --status run a manifest that was already scanned; the scan's own flags do not apply" };
  }
  return out;
}

// --- The world the scan and the plan read -------------------------------

/** Claude Code's own config dir, as Claude Code resolves it. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.CLAUDE_CONFIG_DIR;
  return v && v.length > 0 ? v : path.join(env.HOME || homedir(), ".claude");
}

/** Codex's own home, as Codex resolves it — the human's, not ours. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.CODEX_HOME;
  return v && v.length > 0 ? v : path.join(env.HOME || homedir(), ".codex");
}

/** The tmux server an import lands in: the one the human is standing in, else
 *  the tool's own — the same rule the planner encodes, asked here because the
 *  existing session names have to be read off that server BEFORE the plan can
 *  avoid colliding with them. */
export function targetSocket(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env.TMUX;
  return t ? t.split(",")[0]! : path.join(msHome(), "tmux.sock");
}

const SUBPROCESS_TIMEOUT_MS = 10_000;

/** `git`, bounded, in a directory that may not be a repo (and may not exist). */
export function runGit(args: string[], cwd: string): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 4 << 20 });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

// --- Readiness ----------------------------------------------------------

/**
 * "The conversation is back", read off the store rather than the screen.
 *
 * Both CLIs report themselves through their own hooks, and `ms claude` /
 * `ms adopt` write a session row the moment they launch — so the honest
 * evidence that an imported pane worked is a row for THIS conversation that
 * has reached `running` (a launch reporting itself) or `continuing` (a resume
 * that was handed the continuation). Nothing is scraped.
 *
 * Two things make the match wider than "the row whose `cliSessionId` is the
 * conversation id", and both are facts about the CLIs rather than looseness:
 *
 *   * Codex's rollout id travels on the row's `transcriptPath`, which is what
 *     its hook reports, so a row can name this conversation by its file before
 *     it names it by id;
 *   * a Claude launch is given its own `--session-id`, so the row carries a
 *     fresh uuid until Claude Code's first SessionStart replaces it with the
 *     id it actually resumed. Until that hook fires there is nothing to match
 *     by name at all — but a row for this provider, in this directory, created
 *     after this import began IS the launch we just typed.
 *
 * And one exception, which is the same one reconciliation already makes
 * (`adoptIdleCodex`, src/reconcile.ts): Codex fires SessionStart LAZILY, at
 * the first submitted prompt. An imported Codex conversation that was idle
 * carries no continuation — nothing is submitted for it — so it would sit in
 * `launching` with its TUI on screen in front of the human until this wait
 * gave up and called a perfectly good pane a failure. There, a live pane past
 * a short settle is the report.
 */
const CODEX_SETTLE_MS = 5_000;

/** Run one plan against the real world: the plan's own tmux server, real
 *  signals, the store-backed readiness check. The verb and the wizard's
 *  import step both go through here, so the two can never drift. */
export async function runImportPlan(
  plan: Plan,
  manifestPath: string,
  log: (line: string) => void,
): Promise<{ moved: number; stopped: number; failed: number }> {
  const tmux = new Tmux(plan.socket);
  return executeImport(plan, manifestPath, {
    tmux,
    kill: signalPid,
    alive: pidAlive,
    now: () => Date.now(),
    sleep: sleepMs,
    waitReady: storeWaitReady(plan, tmux),
    log,
  });
}

export function storeWaitReady(plan: Plan, tmux: Tmux): ExecuteDeps["waitReady"] {
  // A store row belongs to ONE conversation. Once a row has answered for a
  // conversation, no other conversation may be reported back on it — the
  // failure that guards against is worse than a slow wait: two conversations
  // in one directory, one launch that worked and one that did not, and a
  // manifest saying both came back. The manifest is the rollback record; a
  // false `resumed in …` is the one entry a human cannot recover from,
  // because it is the one they will not read twice.
  const claimedBy = new Map<string, string>();

  return async (candidateId, deadlineMs, paneId) => {
    let firstSeen: number | null = null;
    // The store is not the only thing that knows. A command that refused —
    // `ms adopt` on a rollout it cannot find, a launch with no account free —
    // writes no row at all, so the loop below has nothing to see and spends
    // the whole sixty seconds seeing it. The pane it was typed into says so in
    // one call: the command is over and the shell is back (`paneReturnWatch`,
    // src/import/execute.ts). Asked once a second, inside the same bound.
    const returned = paneReturnWatch(Date.now());
    let lastPanePoll = 0;
    for (;;) {
      const st = openState();
      let verdict: "ready" | "died" | null = null;
      let present = false;
      let claim: string | null = null;
      try {
        for (const row of st.listSessions()) {
          const owner = claimedBy.get(row.id);
          if (owner !== undefined && owner !== candidateId) continue;
          if (!rowIsFor(row, candidateId)) continue;
          present = true;
          claim = row.id;
          if (row.state === "running" || row.state === "continuing") { verdict = "ready"; break; }
          if (row.pane && tmux.paneDead(row.pane) === true) { verdict = "died"; break; }
          if (row.provider === "codex" && row.state === "launching") {
            firstSeen ??= Date.now();
            if (Date.now() - firstSeen >= CODEX_SETTLE_MS && tmux.paneDead(row.pane) === false) { verdict = "ready"; break; }
          }
        }
      } finally {
        st.close();
      }
      if (verdict) {
        if (claim) claimedBy.set(claim, candidateId);
        return verdict;
      }
      if (!present) firstSeen = null;
      // The store first, always: a row that has reached `running` is the
      // conversation back, whatever the pane happens to be running this
      // instant.
      if (paneId && Date.now() - lastPanePoll >= shellPollMs()) {
        lastPanePoll = Date.now();
        if (returned(tmux.paneCurrentCommand(paneId), Date.now())) return "returned";
      }
      if (Date.now() >= deadlineMs) return "timeout";
      await sleepMs(Math.max(50, Math.min(500, shellPollMs(), deadlineMs - Date.now())));
    }
  };
}

/**
 * Is this store row THIS conversation's?
 *
 * By name, and only by name. Both halves are the id the human's conversation
 * already has: `ms claude --resume <id>` and `ms adopt <id>` both write the
 * row on that id (`claudeResumeId`, src/launch.ts; `extras.resumeId`, for
 * Codex), and Codex's hook later reports the rollout the conversation is in,
 * which is the second spelling of the same fact — matched through the rollout
 * filename's own parser rather than by substring, so a shorter id that happens
 * to sit inside a longer one's filename is not a match.
 *
 * There is deliberately no "a row for this provider, in this directory,
 * started since the run began" fallback. It matched any row in the directory,
 * so two conversations in one project reported the SAME row and the manifest
 * claimed both had come back when one had.
 */
export function rowIsFor(
  row: { provider: string; cliSessionId: string | null; transcriptPath: string | null },
  id: string,
): boolean {
  if (!id) return false;
  if (row.cliSessionId === id) return true;
  if (row.provider !== "codex" || !row.transcriptPath) return false;
  const ids = rolloutIdsFromName(path.basename(row.transcriptPath));
  return !!ids && (ids.threadId === id || ids.rolloutId === id);
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- The confirmation ---------------------------------------------------

export interface ImportIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Null when there is nobody to ask — a pipe, a cron job, a wizard's child
   *  process. The caller refuses rather than assuming an answer. */
  confirm: ((question: string) => Promise<boolean>) | null;
}

/** One line from the real stdin, `y`/`yes` and nothing else. Not a re-asking
 *  prompter: an import asks exactly once, and a person who typed something
 *  else meant no. */
async function askOnce(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function processIo(): ImportIo {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    confirm: process.stdin.isTTY ? askOnce : null,
  };
}

// --- The verb -----------------------------------------------------------

export async function runImport(argv: string[], io: ImportIo = processIo()): Promise<number> {
  const say = sayTo(io);
  const usage = usageTo(io);
  const parsed = parseImportArgs(argv);
  if ("error" in parsed) return usage(parsed.error);

  // `--status`: read a manifest back, print its table, touch nothing.
  if (parsed.status) {
    try {
      io.out(formatManifest(readManifest(parsed.status)));
    } catch (e) {
      say((e as Error).message);
      return EXIT_FAILED;
    }
    return EXIT_OK;
  }

  let plan: Plan;
  let file: string;
  if (parsed.plan) {
    // `--plan`: no scan and no question. The human confirmed when they chose
    // to run this file; re-asking would be asking about a decision already
    // made, and re-scanning would silently execute a different plan.
    let manifest;
    try {
      manifest = readManifest(parsed.plan);
    } catch (e) {
      say((e as Error).message);
      return EXIT_FAILED;
    }
    plan = planFromManifest(manifest);
    file = parsed.plan;
    if (!countPanes(plan)) {
      say("that manifest has no conversations to move");
      return EXIT_OK;
    }
  } else {
    const since = parseSince(parsed.since, Date.now());
    if ("error" in since) return usage(since.error);
    const dirs: string[] = [];
    for (const d of parsed.dirs) {
      const abs = path.resolve(d);
      if (!existsSync(abs)) return usage(`no such directory: ${d}`);
      dirs.push(realpathSync(abs));
    }

    const socket = targetSocket();
    const tmux = new Tmux(socket);
    const candidates = scanConversations({
      claudeConfigDir: claudeConfigDir(),
      codexHome: codexHome(),
      sinceMs: since.ms,
      dirs,
      ...defaultScanDeps(),
    });
    // A conversation already in a tmux pane is already somewhere it can be
    // rotated, so it is not an import. `--include-tmux` LISTS those rows (the
    // table names them, skipped, with the reason) — moving them is a
    // follow-up, by the spec's own reckoning.
    const considered = parsed.includeTmux ? candidates : candidates.filter((c) => !c.inTmux);
    plan = planImport(considered, {
      as: parsed.as,
      continueFor: parsed.continueFor,
      git: runGit,
      existingSessions: new Set(tmux.sessionNames()),
      tmuxEnv: process.env.TMUX,
      msSocket: path.join(msHome(), "tmux.sock"),
    });

    ensureStore();
    file = manifestPath();
    writeManifest(file, manifestFromPlan(plan, { since: parsed.since, dirs }));
  }

  const manifest = readManifest(file);
  io.out(formatManifest(manifest));
  io.err(`ms import: manifest ${file}\n`);

  const panes = countPanes(plan);
  if (!panes) {
    say("nothing to import");
    return EXIT_OK;
  }
  if (parsed.dryRun) return EXIT_OK;

  if (!parsed.plan && !parsed.yes) {
    const live = livePanes(plan);
    const question = `Move ${panes} conversation${panes === 1 ? "" : "s"}${live ? `, stopping ${live} live process${live === 1 ? "" : "es"}` : ""}? [y/N] `;
    if (!io.confirm) {
      say("stdin is not a terminal, so there is nobody to ask", [
        "re-run with --yes to say so out loud, or --dry-run to see the plan without moving anything",
        `the plan is written: ms import --plan ${file}`,
      ]);
      return EXIT_USAGE;
    }
    if (!(await io.confirm(question))) {
      say("nothing was moved", [`the plan is written: ms import --plan ${file}`]);
      return EXIT_OK;
    }
  }

  const result = await runImportPlan(plan, file, (line) => io.err(`ms import: ${line}\n`));

  io.err(`ms import: moved ${result.moved}, stopped ${result.stopped}, failed ${result.failed}\n`);
  io.err(`ms import: manifest ${file}\n`);
  if (result.moved && plan.server === "ms") io.err(`ms import: they are on the tool's own server — ms attach\n`);
  return result.failed ? EXIT_FAILED : EXIT_OK;
}

const countPanes = (plan: Plan): number => plan.sessions.reduce((n, s) => n + s.windows.reduce((k, w) => k + w.panes.length, 0), 0);
const livePanes = (plan: Plan): number =>
  plan.sessions.reduce((n, s) => n + s.windows.reduce((k, w) => k + w.panes.filter((p) => p.candidate.pid !== null).length, 0), 0);

/** `ms import`. */
export const importVerb: Verb = (argv) => runImport(argv);
