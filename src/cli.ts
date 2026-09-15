import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execLaunch } from "./exec.ts";
import { claudeHook } from "./hooks/claude-hook.ts";
import { launchClaude } from "./launch.ts";
import { recoverVerb } from "./recover.ts";
import { status } from "./status.ts";

export type Verb = (args: string[]) => Promise<number>;
const verbs = new Map<string, Verb>();
export function registerVerb(name: string, fn: Verb): void { verbs.set(name, fn); }

registerVerb("_exec", execLaunch);
registerVerb("_hook", async ([which]) => (which === "claude" ? claudeHook() : 0));
registerVerb("claude", launchClaude);
registerVerb("_recover", recoverVerb);
registerVerb("status", status);

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

export async function main(argv: string[]): Promise<number> {
  quietExperimentalWarnings();
  const [verb, ...rest] = argv;
  if (!verb || verb === "-h" || verb === "--help") { process.stderr.write(USAGE + "\n"); return verb ? 0 : 2; }
  if (verb === "--version" || verb === "-V") { process.stdout.write(version() + "\n"); return 0; }
  const fn = verbs.get(verb);
  if (!fn) { process.stderr.write(`ms: unknown verb '${verb}'\n${USAGE}\n`); return 2; }
  try { return await fn(rest); }
  catch (e) { process.stderr.write(`ms ${verb}: ${(e as Error).message}\n`); return 1; }
}
