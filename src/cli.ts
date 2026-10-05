import { execLaunch, resolveOnPath } from "./exec.ts";
import { cliVersion, compatNotices, msVersion, type Cli, type Found } from "./compat.ts";
import { updateCheck } from "./update-check.ts";
import { claudeHook } from "./hooks/claude-hook.ts";
import { codexHook, codexWatch } from "./hooks/codex-hook.ts";
import { attachVerb, launchClaude, launchCodex, launchCredential } from "./launch.ts";
import { meshRowsVerb } from "./mesh.ts";
import { adoptVerb } from "./adopt.ts";
import { importVerb } from "./import.ts";
import { dashboard } from "./dashboard.ts";
import { statuslineVerb } from "./setup/statusline.ts";
import { rotateVerb, stopVerb, switchVerb } from "./manual.ts";
import { paneDied, reconcile } from "./reconcile.ts";
import { recoverVerb } from "./recover.ts";
import { rebalanceWorkerVerb } from "./rebalance.ts";
import { rebalanceVerb } from "./rebalance-verb.ts";
import { status } from "./status.ts";
import { calendar } from "./calendar.ts";
import { doctor } from "./doctor.ts";
import { accountsVerb } from "./accounts.ts";
import { setupVerb } from "./setup.ts";

export type Verb = (args: string[]) => Promise<number>;
const verbs = new Map<string, Verb>();
export function registerVerb(name: string, fn: Verb): void { verbs.set(name, fn); }

registerVerb("_exec", execLaunch);
registerVerb("_hook", async ([which]) => (which === "claude" ? claudeHook() : which === "codex" ? codexHook() : 2));
// The Codex fleet watchdog: ONE timer per tmux server, dispatched by tmux, so
// it inherits no MS_* identity and reads every Codex session from the store.
registerVerb("_codex_watch", codexWatch);
registerVerb("_pane_died", paneDied);
registerVerb("_statusline", statuslineVerb);
registerVerb("claude", launchClaude);
registerVerb("codex", launchCodex);
// The `mesh` picker's ctrl-r (src/mesh.ts): a fresh reading, the previews
// re-rendered, the rows printed for fzf. Which accounts this device can
// launch is the launch's own credential check, handed in.
registerVerb("_mesh_rows", (argv) => meshRowsVerb(argv, launchCredential));
registerVerb("attach", attachVerb);
// `ms adopt`: take over a Codex conversation this tool did not start.
registerVerb("adopt", adoptVerb);
// `ms import`: bring conversations running outside tmux into it.
registerVerb("import", importVerb);
registerVerb("_recover", recoverVerb);
// The rebalance move: the human's own `ms switch` transaction, minus the
// continuation, dispatched by tmux so it lives outside the CLI whose turn just
// ended (src/rebalance.ts).
registerVerb("_rebalance", rebalanceWorkerVerb);
registerVerb("status", status);
// `ms rebalance`: the same decision the turn-end hook takes, for the whole
// fleet, printed — and, without --dry-run, acted on (src/rebalance-verb.ts).
registerVerb("rebalance", rebalanceVerb);
registerVerb("calendar", calendar);
registerVerb("doctor", doctor);
registerVerb("accounts", accountsVerb);
registerVerb("setup", setupVerb);
registerVerb("rotate", rotateVerb);
registerVerb("switch", switchVerb);
registerVerb("stop", stopVerb);
registerVerb("dashboard", dashboard);

const USAGE = `usage: ms <verb> [args]
  setup | claude | codex | adopt | import | status | calendar | accounts | rotate | switch | rebalance | stop | doctor | attach | dashboard
  (internal: _exec _hook _codex_watch _recover _rebalance _pane_died _statusline _mesh_rows)`;


/**
 * Node prints `ExperimentalWarning: SQLite …` to stderr the moment `node:sqlite`
 * loads. For `ms _hook claude` that stderr is rendered inside the human's Claude
 * transcript, so it must never happen — but silencing warnings wholesale would
 * also hide the ones worth reading. Replace Node's own handler with one that
 * drops ExperimentalWarning and prints everything else. (Hooks also load
 * `state.ts` lazily, so the SQLite warning is emitted after this is installed.)
 */
function quietExperimentalWarnings(): void {
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name !== "ExperimentalWarning") process.stderr.write(`${w.name}: ${w.message}\n`);
  });
}

/**
 * Reconciliation (spec §9) runs at the start of every PUBLIC verb: nothing of
 * ours stays resident, so each invocation is the moment we repair what a
 * crashed worker, a restarted tmux server or a closed pane left behind.
 *
 * Internal verbs (`_exec`, `_hook`, `_recover`, `_rebalance`, `_pane_died`, `_mesh_rows`) skip
 * it — they are the hot and re-entrant paths, the hook must never print or block the
 * human's turn, and a `_recover` that reconciled would be repairing itself.
 * `--version`/`--help` have already returned before this is reached.
 *
 * Nothing here may fail the verb the human asked for: a repair is a courtesy,
 * and its failure is worth exactly one line, and only when asked for it.
 */
function runReconcile(verb: string): void {
  if (verb.startsWith("_")) return;
  const verbose = process.env.MS_VERBOSE === "1";
  try {
    const repaired = reconcile(); // always; only the account of it is optional
    if (verbose) for (const line of repaired) process.stderr.write(`ms: reconcile: ${line}\n`);
  } catch (e) {
    if (verbose) process.stderr.write(`ms: reconcile failed: ${(e as Error).message}\n`);
  }
}

/**
 * Which CLIs a verb's version notice is about: the one a launch is about to
 * run, both for every other user-facing verb, none for `ms doctor` (which
 * reports both on lines of its own, against the same table).
 */
const NOTICE_CLIS: Record<string, Cli[]> = { claude: ["claude"], codex: ["codex"], adopt: ["codex"], doctor: [] };

/**
 * The lines a human sees before a public verb runs (src/compat.ts,
 * src/update-check.ts): the CLI on PATH is newer than this `ms` was verified
 * against, or a newer `ms` is out. Never for an internal verb — `_hook`'s
 * stderr lands in a Claude transcript, `_statusline`'s on the status line —
 * and only when stderr is a terminal: these are for a human, not for the
 * script that pipes `ms status` somewhere, and not for the test suite.
 *
 * Like `runReconcile`, nothing here may fail or delay the verb: a probe is
 * cached per binary, the release check reads a file and leaves the network to
 * a detached child, and any error is no notice at all.
 */
export function startupNotices(verb: string, out: { isTTY?: boolean; write(s: string): unknown } = process.stderr): void {
  if (verb.startsWith("_") || !out.isTTY) return;
  try {
    const found: Found[] = [];
    for (const cli of NOTICE_CLIS[verb] ?? (["claude", "codex"] as Cli[])) {
      const bin = resolveOnPath(cli);
      const version = bin ? cliVersion(bin) : null;
      if (version) found.push({ cli, version });
    }
    const lines = compatNotices(found);
    const update = updateCheck();
    if (update) lines.push(update);
    for (const line of lines) out.write(`${line}\n`);
  } catch {
    /* a notice is a courtesy */
  }
}

export async function main(argv: string[]): Promise<number> {
  quietExperimentalWarnings();
  const [verb, ...rest] = argv;
  if (!verb || verb === "-h" || verb === "--help") { process.stderr.write(USAGE + "\n"); return verb ? 0 : 2; }
  if (verb === "--version" || verb === "-V") { process.stdout.write(msVersion() + "\n"); return 0; }
  const fn = verbs.get(verb);
  if (!fn) { process.stderr.write(`ms: unknown verb '${verb}'\n${USAGE}\n`); return 2; }
  runReconcile(verb);
  startupNotices(verb);
  try { return await fn(rest); }
  catch (e) { process.stderr.write(`ms ${verb}: ${(e as Error).message}\n`); return 1; }
}
