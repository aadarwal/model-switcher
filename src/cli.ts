import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { accountsVerb } from "./accounts.ts";

export type Verb = (args: string[]) => Promise<number>;
const verbs = new Map<string, Verb>();
export function registerVerb(name: string, fn: Verb): void { verbs.set(name, fn); }

registerVerb("accounts", accountsVerb);

const USAGE = `usage: ms <verb> [args]
  setup | claude | codex | status | accounts | rotate | switch | stop | doctor | attach
  (internal: _exec _hook _recover _pane_died)`;

function version(): string {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(pkg, "utf8")).version;
}

export async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (!verb || verb === "-h" || verb === "--help") { process.stderr.write(USAGE + "\n"); return verb ? 0 : 2; }
  if (verb === "--version" || verb === "-V") { process.stdout.write(version() + "\n"); return 0; }
  const fn = verbs.get(verb);
  if (!fn) { process.stderr.write(`ms: unknown verb '${verb}'\n${USAGE}\n`); return 2; }
  try { return await fn(rest); }
  catch (e) { process.stderr.write(`ms ${verb}: ${(e as Error).message}\n`); return 1; }
}
