import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execLaunch } from "./exec.ts";
import { claudeHook } from "./hooks/claude-hook.ts";
import { launchClaude } from "./launch.ts";
import { paneDied, reconcile } from "./reconcile.ts";

export type Verb = (args: string[]) => Promise<number>;
const verbs = new Map<string, Verb>();
export function registerVerb(name: string, fn: Verb): void { verbs.set(name, fn); }

registerVerb("_exec", execLaunch);
registerVerb("_hook", async ([which]) => (which === "claude" ? claudeHook() : 0));
registerVerb("_pane_died", paneDied);
registerVerb("claude", launchClaude);

const USAGE = `usage: ms <verb> [args]
  setup | claude | codex | status | accounts | rotate | switch | stop | doctor | attach
  (internal: _exec _hook _recover _pane_died)`;

function version(): string {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(pkg, "utf8")).version;
}

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
 * Internal verbs (`_exec`, `_hook`, `_recover`, `_pane_died`) skip it — they
 * are the hot and re-entrant paths, the hook must never print or block the
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

export async function main(argv: string[]): Promise<number> {
  quietExperimentalWarnings();
  const [verb, ...rest] = argv;
  if (!verb || verb === "-h" || verb === "--help") { process.stderr.write(USAGE + "\n"); return verb ? 0 : 2; }
  if (verb === "--version" || verb === "-V") { process.stdout.write(version() + "\n"); return 0; }
  const fn = verbs.get(verb);
  if (!fn) { process.stderr.write(`ms: unknown verb '${verb}'\n${USAGE}\n`); return 2; }
  runReconcile(verb);
  try { return await fn(rest); }
  catch (e) { process.stderr.write(`ms ${verb}: ${(e as Error).message}\n`); return 1; }
}
