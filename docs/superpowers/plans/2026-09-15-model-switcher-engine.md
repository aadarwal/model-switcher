# model-switcher Engine (Claude) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ms` with the full Claude Code path working end to end on one Mac: accounts, chooser, launch through `ms _exec`, hook-driven events, durable recovery in place, manual verbs, `ms status`, a minimal `ms doctor`, and a passed live matrix. Codex rotation, the wizard, the brew tap and the dashboard are the second plan (`2026-09-15-model-switcher-codex-and-install.md`, written after this plan's live matrix passes and gates G1/G2 have run).

**Architecture:** One TypeScript CLI (`ms`) with zero runtime dependencies (Node ≥ 22: `node:sqlite`, `node:util` `parseArgs`, `process.execve`, global `fetch`). Nothing of ours stays resident: `ms _exec` execs the CLI in place inside the pane, Claude Code's own hooks append events and ask tmux to dispatch a short-lived `ms _recover` worker, tmux holds any timers (`run-shell -b -d`). State lives in `~/.config/model-switcher/` (registry JSON, a SQLite file, per-session JSONL audit logs), everything 0600/0700.

**Tech Stack:** TypeScript (ESM), Node ≥ 22.13 (`node:sqlite` unflagged; brew node 26 in production), `tsx` for tests (`node --import tsx --test`), `esbuild` to bundle `dist/ms.js`, `node:test` + `node:assert/strict`, stub binaries on a temp `PATH` for tmux/claude/security in tests. No runtime npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-model-switcher-design.md` — read it first; every task below cites the section it implements.

## Global Constraints

- macOS only; Node ≥ 22.13; tmux ≥ 3.2 (pane-scoped hooks) and `run-shell -b -d` (tmux ≥ 3.3; the author has 3.7b).
- Zero runtime npm dependencies. Dev dependencies only: `typescript`, `tsx`, `esbuild`, `@types/node`.
- No secret ever on argv, in a tmux command string, in a tmux environment (`-e`), in a log, in a pane, or in an error message. `ms accounts token <name>` is the only verb that prints one.
- Every network call and every subprocess call is bounded (AbortSignal / `timeout` option); nothing waits forever.
- Store root is `MS_HOME` (default `~/.config/model-switcher`), directories 0700, files 0600. A registry that cannot be parsed is never rewritten.
- Rotation is triggered only by the provider's own report (Claude's StopFailure hook with `error: rate_limit`); screen text names the wall kind and flags "walled, unreported" — it never triggers.
- Every git commit carries the three trailers on separate lines: `Co-Authored-By: Claude <noreply@anthropic.com>`, `Co-authored-by: Codex <codex@openai.com>`, `Co-authored-by: Homi <322615700+Homi@users.noreply.github.com>`; commit with `-c commit.gpgsign=false`.
- Tests never touch the real tmux server, the real `~/.claude`, the real keychain or a real account; `MS_HOME` and `HOME` point at temp dirs and `PATH` is prefixed with a stub dir.

---

## File structure

```
package.json, tsconfig.json, .gitignore, README.md
bin/ms                              #!/usr/bin/env node — imports dist/ms.js (built) or src via tsx in dev
scripts/build.mjs                   esbuild bundle → dist/ms.js
src/cli.ts                          verb dispatch (parseArgs), reconciliation at start of every verb, exit codes
src/paths.ts                        MS_HOME, file paths, ensureStore() with modes
src/registry.ts                     accounts.json: types, validate, load, save-if-parsed
src/pick.ts                         the chooser rule (pure)
src/state.ts                        node:sqlite: sessions, launches, recoveries, wakeups (+ migrations)
src/events.ts                       events.jsonl append/read (tolerates a torn trailing line)
src/tmux.ts                         socket-aware tmux wrapper: respawn, run-shell, options, capture, hooks
src/lock.ts                         mkdir locks with holder file + revalidated stale reclaim
src/providers/claude-usage.ts       poll grant: credentials (file/keychain), refresh, usage, profile
src/snapshot.ts                     coalesced usage snapshot on disk (20 s freshness, backoff)
src/launch-credentials.ts           setup-token store (file 0600)
src/accounts.ts                     ms accounts add|login|verify|remove|token
src/exec.ts                         ms _exec <launch-id>: env + process.execve
src/launch.ts                       ms claude: pick, record, own-pane respawn or tool server
src/hooks/claude-hook.ts            ms _hook claude: stdin JSON → event (+ dispatch on rate_limit)
src/hooks/install.ts                merge hooks into ~/.claude/settings.json with backup
src/recover.ts                      ms _recover <session>: the transaction
src/manual.ts                       ms rotate | switch | stop
src/status.ts                       ms status [--watch]
src/reconcile.ts                    abandoned locks/workers/wakeups, gone panes, dead-pane shell restore
src/doctor.ts                       ms doctor (minimal in this plan)
src/wall.ts                         anchored wall-text patterns (kind only)
test/helpers.ts                     temp MS_HOME/HOME, stub PATH builder, run(ms, args)
test/*.test.ts                      one per module
docs/superpowers/plans/2026-09-15-live-matrix-claude.md   Task 20's record
```

---

### Task 1: Repository scaffold and `ms --version`

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `bin/ms`, `scripts/build.mjs`, `src/cli.ts`, `test/helpers.ts`, `test/cli.test.ts`, `README.md`

**Interfaces:**
- Produces: `bin/ms` runnable in dev (`node --import tsx bin/ms …`) and after `npm run build`; `run(args, opts)` test helper returning `{code, stdout, stderr}`; the verb table in `src/cli.ts` that later tasks add entries to (`registerVerb(name, handler)` pattern below).

- [ ] **Step 1: Write the failing test**

`test/helpers.ts`:
```ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tempHome(): { home: string; msHome: string } {
  const home = mkdtempSync(path.join(tmpdir(), "ms-test-"));
  const msHome = path.join(home, ".config", "model-switcher");
  mkdirSync(msHome, { recursive: true, mode: 0o700 });
  return { home, msHome };
}

/** A directory of fake executables; `stub(name, script)` writes a bash script. */
export function stubDir(): { dir: string; stub: (name: string, body: string) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "ms-stubs-"));
  return {
    dir,
    stub(name, body) {
      const p = path.join(dir, name);
      writeFileSync(p, `#!/bin/bash\n${body}\n`);
      chmodSync(p, 0o755);
    },
  };
}

export function run(args: string[], env: Record<string, string> = {}, input = ""): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("bin/ms"), ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
```

`test/cli.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, tempHome } from "./helpers.ts";

test("ms --version prints the package version", () => {
  const { home, msHome } = tempHome();
  const r = run(["--version"], { HOME: home, MS_HOME: msHome });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("an unknown verb exits 2 with usage", () => {
  const { home, msHome } = tempHome();
  const r = run(["frobnicate"], { HOME: home, MS_HOME: msHome });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: ms/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test` (after Step 3's package.json exists it fails on a missing `bin/ms`); before that, `node --import tsx --test test/cli.test.ts` fails with "Cannot find module".

- [ ] **Step 3: Write the scaffold**

`package.json`:
```json
{
  "name": "model-switcher",
  "version": "0.1.0",
  "description": "Run claude and codex on whichever of your accounts has room; rotate a walled session in place.",
  "type": "module",
  "bin": { "ms": "bin/ms" },
  "engines": { "node": ">=22.13" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "node --import tsx --test test/*.test.ts",
    "typecheck": "tsc --noEmit -p ."
  },
  "devDependencies": {
    "@types/node": "^22",
    "esbuild": "^0.28",
    "tsx": "^4",
    "typescript": "^5"
  },
  "license": "MIT"
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
    "types": ["node"], "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "bin/ms"]
}
```

`.gitignore`:
```
node_modules/
dist/
```

`bin/ms`:
```js
#!/usr/bin/env node
// Built install: dist/ms.js exists. Dev: fall back to the TypeScript sources via tsx
// (tests run this file with `node --import tsx`).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "ms.js");
const entry = existsSync(dist) ? dist : path.join(here, "..", "src", "cli.ts");
const { main } = await import(entry);
process.exitCode = await main(process.argv.slice(2));
```

`scripts/build.mjs`:
```js
import { build } from "esbuild";
await build({
  entryPoints: ["src/cli.ts"], outfile: "dist/ms.js", bundle: true, platform: "node",
  format: "esm", target: "node22", banner: { js: "// model-switcher — built bundle" },
  external: ["node:*"],
});
console.log("built dist/ms.js");
```

`src/cli.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Verb = (args: string[]) => Promise<number>;
const verbs = new Map<string, Verb>();
export function registerVerb(name: string, fn: Verb): void { verbs.set(name, fn); }

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
```

`README.md`: title, one paragraph from spec §1, "Status: engine under construction; see docs/superpowers/specs".

- [ ] **Step 4: Install dev dependencies and run the tests**

Run: `npm install && npm test`
Expected: 2 tests pass. Also `npm run typecheck` clean and `npm run build` writes `dist/ms.js` (then `rm -rf dist` so tests keep using the sources).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore bin/ms scripts/build.mjs src/cli.ts test/helpers.ts test/cli.test.ts README.md
git -c commit.gpgsign=false commit -F - <<'EOF'
Scaffold: ms CLI entry, verb table, test harness, esbuild bundle

Co-Authored-By: Claude <noreply@anthropic.com>
Co-authored-by: Codex <codex@openai.com>
Co-authored-by: Homi <322615700+Homi@users.noreply.github.com>
EOF
```

---

### Task 2: Store paths and the registry (`accounts.json`)

**Files:**
- Create: `src/paths.ts`, `src/registry.ts`, `test/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `paths.ts`: `msHome(): string`, `ensureStore(): void` (creates `MS_HOME`, `claude/`, `codex/`, `launch/`, `sessions/`, `hooks/`, `locks/` with mode 0700), `p.registry`, `p.state`, `p.snapshot`, `p.sessionDir(id)`, `p.eventsFile(id)`, `p.recoverLog(id)`, `p.launchToken(name)`, `p.claudeConfigDir(name)`, `p.codexHome(name)`, `p.lockDir(name)`.
  - `registry.ts`: `type Account = { name: string; provider: "claude" | "codex"; label: string; orgId: string | null; shared: boolean; identityVerified: boolean }`, `type Registry = { version: 1; accounts: Account[] }`, `loadRegistry(): { registry: Registry; parseError: string | null }` (never throws; on a parse error returns an empty registry and the error), `saveRegistry(r: Registry, prev: { parseError: string | null })` (throws `RegistryUnreadable` if `prev.parseError` is set), `validateRegistry(raw: unknown): { registry: Registry; problems: string[] }`, `findAccount(r, name)`.

- [ ] **Step 1: Write the failing tests**

`test/registry.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";

test("loadRegistry on a missing file returns an empty registry with no error", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { loadRegistry } = await import("../src/registry.ts");
  const r = loadRegistry();
  assert.deepEqual(r.registry, { version: 1, accounts: [] });
  assert.equal(r.parseError, null);
});

test("a malformed registry is reported, never rewritten", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { loadRegistry, saveRegistry } = await import("../src/registry.ts");
  const file = path.join(msHome, "accounts.json");
  writeFileSync(file, '{"version":1,"accounts":[{"name":"a",}]}');
  const r = loadRegistry();
  assert.match(r.parseError ?? "", /JSON/);
  assert.throws(() => saveRegistry({ version: 1, accounts: [] }, r), /unreadable/);
  assert.equal(readFileSync(file, "utf8"), '{"version":1,"accounts":[{"name":"a",}]}');
});

test("validateRegistry skips bad rows by position and reports each problem", async () => {
  const { validateRegistry } = await import("../src/registry.ts");
  const v = validateRegistry({ version: 1, accounts: [
    { name: "ok", provider: "claude", label: "OK", orgId: null, shared: false, identityVerified: false },
    null,
    { name: "bad provider", provider: "gemini", label: "x" },
    { name: "ok", provider: "claude", label: "dupe" },
  ]});
  assert.equal(v.registry.accounts.length, 1);
  assert.equal(v.problems.length, 3);
  assert.match(v.problems[0], /accounts\[1\]/);
  assert.match(v.problems[1], /provider/);
  assert.match(v.problems[2], /duplicate name/);
});

test("saveRegistry writes 0600 atomically and round-trips", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { loadRegistry, saveRegistry } = await import("../src/registry.ts");
  const r = loadRegistry();
  r.registry.accounts.push({ name: "gmail", provider: "claude", label: "Gmail", orgId: "org-1", shared: false, identityVerified: true });
  saveRegistry(r.registry, r);
  const file = path.join(msHome, "accounts.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadRegistry().registry.accounts[0].orgId, "org-1");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- test/registry.test.ts` — Expected: FAIL, cannot find `../src/registry.ts`.

- [ ] **Step 3: Implement**

`src/paths.ts`:
```ts
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function msHome(): string {
  return process.env.MS_HOME || path.join(process.env.HOME || homedir(), ".config", "model-switcher");
}
const sub = (...s: string[]) => path.join(msHome(), ...s);
export const p = {
  get registry() { return sub("accounts.json"); },
  get state() { return sub("state.sqlite"); },
  get snapshot() { return sub("snapshot.json"); },
  get locks() { return sub("locks"); },
  sessionDir: (id: string) => sub("sessions", id),
  eventsFile: (id: string) => sub("sessions", id, "events.jsonl"),
  recoverLog: (id: string) => sub("sessions", id, "recover.log"),
  launchToken: (name: string) => sub("launch", `${name}.token`),
  claudeConfigDir: (name: string) => sub("claude", name),
  codexHome: (name: string) => sub("codex", name),
  lockDir: (name: string) => sub("locks", name),
  hooksDir: () => sub("hooks"),
};
export function ensureStore(): void {
  for (const d of [msHome(), sub("claude"), sub("codex"), sub("launch"), sub("sessions"), sub("hooks"), sub("locks")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}
export function ensureSessionDir(id: string): string {
  const d = p.sessionDir(id);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
```

`src/registry.ts`:
```ts
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";

export type Provider = "claude" | "codex";
export type Account = { name: string; provider: Provider; label: string; orgId: string | null; shared: boolean; identityVerified: boolean };
export type Registry = { version: 1; accounts: Account[] };
export class RegistryUnreadable extends Error {}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateRegistry(raw: unknown): { registry: Registry; problems: string[] } {
  const problems: string[] = [];
  const out: Account[] = [];
  const rows = raw && typeof raw === "object" && Array.isArray((raw as { accounts?: unknown }).accounts)
    ? ((raw as { accounts: unknown[] }).accounts) : [];
  if (!rows.length && raw && typeof raw === "object" && !("accounts" in raw)) problems.push("accounts: missing array");
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const at = `accounts[${i}]`;
    if (!row || typeof row !== "object") { problems.push(`${at}: not an object`); return; }
    const a = row as Record<string, unknown>;
    if (typeof a.name !== "string" || !NAME_PATTERN.test(a.name)) { problems.push(`${at}: bad name`); return; }
    if (a.provider !== "claude" && a.provider !== "codex") { problems.push(`${at}: unknown provider ${JSON.stringify(a.provider)}`); return; }
    const key = `${a.provider}:${a.name}`;
    if (seen.has(key)) { problems.push(`${at}: duplicate name ${a.name} for ${a.provider}`); return; }
    seen.add(key);
    out.push({
      name: a.name, provider: a.provider, label: typeof a.label === "string" ? a.label : a.name,
      orgId: typeof a.orgId === "string" ? a.orgId : null,
      shared: a.shared === true, identityVerified: a.identityVerified === true,
    });
  });
  return { registry: { version: 1, accounts: out }, problems };
}

export function loadRegistry(): { registry: Registry; parseError: string | null; problems: string[] } {
  ensureStore();
  if (!existsSync(p.registry)) return { registry: { version: 1, accounts: [] }, parseError: null, problems: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(p.registry, "utf8")); }
  catch (e) { return { registry: { version: 1, accounts: [] }, parseError: `accounts.json: ${(e as Error).message} (JSON)`, problems: [] }; }
  const v = validateRegistry(raw);
  return { registry: v.registry, parseError: null, problems: v.problems };
}

export function saveRegistry(r: Registry, prev: { parseError: string | null }): void {
  if (prev.parseError) throw new RegistryUnreadable(`refusing to write over an unreadable registry: ${prev.parseError}`);
  ensureStore();
  const tmp = `${p.registry}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, p.registry);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

export function findAccount(r: Registry, name: string, provider?: Provider): Account | undefined {
  return r.accounts.find((a) => a.name === name && (!provider || a.provider === provider));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- test/registry.test.ts` — Expected: 4 pass. `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts src/registry.ts test/registry.test.ts
git -c commit.gpgsign=false commit -F - <<'EOF'
Store paths and a validated registry that is never rewritten from an unparsed state

Co-Authored-By: Claude <noreply@anthropic.com>
Co-authored-by: Codex <codex@openai.com>
Co-authored-by: Homi <322615700+Homi@users.noreply.github.com>
EOF
```

---

### Task 3: The chooser (spec §2)

**Files:**
- Create: `src/pick.ts`, `test/pick.test.ts`
- Reference (read, do not copy blindly): `/Users/aadarwal/src/aadarwal/data/lib/pick.ts` and its tests — the same rule, already fixture-tested there.

**Interfaces:**
- Produces:
  ```ts
  export type Need = "any" | "fable";
  export type Window = { usedPercent: number; resetsAt: string | null };   // ISO time
  export type PickInput = { name: string; provider: "claude" | "codex"; shared: boolean;
    session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null; error: string | null };
  export type PickResult = { picks: { name: string; resetsAt: string | null; remaining: number }[];
    out: { name: string; why: string }[] };
  export function pickAccounts(inputs: PickInput[], need: Need, exclude?: string[]): PickResult;
  export function parseNeed(s: string | undefined): Need | null;
  ```

- [ ] **Step 1: Write the failing tests**

`test/pick.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAccounts, parseNeed, type PickInput } from "../src/pick.ts";

const w = (used: number, resets: string | null = "2026-09-20T00:00:00Z") => ({ usedPercent: used, resetsAt: resets });
const acct = (name: string, o: Partial<PickInput> = {}): PickInput => ({
  name, provider: "claude", shared: false, session: w(10, "2026-09-15T05:00:00Z"),
  weeklyAll: w(50, "2026-09-18T00:00:00Z"), weeklyFable: w(50, "2026-09-18T00:00:00Z"), error: null, ...o,
});

test("a window at 100 is out; earliest weekly reset orders the rest", () => {
  const r = pickAccounts([
    acct("late", { weeklyAll: w(10, "2026-09-21T00:00:00Z") }),
    acct("early", { weeklyAll: w(90, "2026-09-16T00:00:00Z") }),
    acct("full", { session: w(100, "2026-09-15T06:00:00Z") }),
  ], "any");
  assert.deepEqual(r.picks.map((x) => x.name), ["early", "late"]);
  assert.deepEqual(r.out, [{ name: "full", why: "session window at 100" }]);
});

test("99.6 is not 100 (no rounding)", () => {
  const r = pickAccounts([acct("almost", { weeklyAll: w(99.6) })], "any");
  assert.equal(r.picks.length, 1);
});

test("need=fable gates on the fable window; need=any ignores it", () => {
  const a = [acct("x", { weeklyFable: w(100) })];
  assert.equal(pickAccounts(a, "fable").out[0]?.why, "fable window at 100");
  assert.equal(pickAccounts(a, "any").picks.length, 1);
});

test("a missing window makes the account ineligible with a reason", () => {
  const r = pickAccounts([acct("nowk", { weeklyAll: null })], "any");
  assert.deepEqual(r.out, [{ name: "nowk", why: "no weekly window" }]);
});

test("ties on reset: more remaining first, then solo before shared", () => {
  const r = pickAccounts([
    acct("shared", { shared: true, weeklyAll: w(20) }),
    acct("solo", { weeklyAll: w(20) }),
    acct("fuller", { weeklyAll: w(60) }),
  ], "any");
  assert.deepEqual(r.picks.map((x) => x.name), ["solo", "shared", "fuller"]);
});

test("exclude and error", () => {
  const r = pickAccounts([acct("a"), acct("b", { error: "token dead" })], "any", ["a"]);
  assert.deepEqual(r.picks, []);
  assert.deepEqual(r.out.map((o) => o.why), ["excluded", "error: token dead"]);
});

test("parseNeed", () => {
  assert.equal(parseNeed(undefined), "any"); assert.equal(parseNeed("fable"), "fable"); assert.equal(parseNeed("fabel"), null);
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- test/pick.test.ts`: FAIL, module missing.

- [ ] **Step 3: Implement `src/pick.ts`**

```ts
export type Need = "any" | "fable";
export type Window = { usedPercent: number; resetsAt: string | null };
export type PickInput = { name: string; provider: "claude" | "codex"; shared: boolean;
  session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null; error: string | null };
export type PickResult = { picks: { name: string; resetsAt: string | null; remaining: number }[]; out: { name: string; why: string }[] };

export function parseNeed(s: string | undefined): Need | null {
  if (s === undefined || s === "" || s === "any") return "any";
  if (s === "fable") return "fable";
  return null;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);

export function pickAccounts(inputs: PickInput[], need: Need, exclude: string[] = []): PickResult {
  const out: PickResult["out"] = [];
  const eligible: { name: string; resetsAt: string | null; remaining: number; shared: boolean; resetMs: number }[] = [];
  for (const a of inputs) {
    if (exclude.includes(a.name)) { out.push({ name: a.name, why: "excluded" }); continue; }
    if (a.error) { out.push({ name: a.name, why: `error: ${a.error}` }); continue; }
    if (!a.session) { out.push({ name: a.name, why: "no session window" }); continue; }
    if (!a.weeklyAll) { out.push({ name: a.name, why: "no weekly window" }); continue; }
    if (need === "fable" && !a.weeklyFable) { out.push({ name: a.name, why: "no fable window" }); continue; }
    if (a.session.usedPercent >= 100) { out.push({ name: a.name, why: "session window at 100" }); continue; }
    if (a.weeklyAll.usedPercent >= 100) { out.push({ name: a.name, why: "weekly window at 100" }); continue; }
    if (need === "fable" && a.weeklyFable!.usedPercent >= 100) { out.push({ name: a.name, why: "fable window at 100" }); continue; }
    const windows = need === "fable" ? [a.weeklyAll, a.weeklyFable!] : [a.weeklyAll];
    const remaining = Math.min(...windows.map((x) => 100 - x.usedPercent));
    const resetMs = Math.min(...windows.map((x) => ms(x.resetsAt)));
    const resetsAt = windows.map((x) => x.resetsAt).filter((x): x is string => !!x).sort((x, y) => ms(x) - ms(y))[0] ?? null;
    eligible.push({ name: a.name, resetsAt, remaining, shared: a.shared, resetMs });
  }
  eligible.sort((x, y) => x.resetMs - y.resetMs || y.remaining - x.remaining || Number(x.shared) - Number(y.shared) || x.name.localeCompare(y.name));
  return { picks: eligible.map(({ name, resetsAt, remaining }) => ({ name, resetsAt, remaining })), out };
}
```

- [ ] **Step 4: Run to verify they pass** — `npm test -- test/pick.test.ts`: 7 pass.

- [ ] **Step 5: Commit** — `git add src/pick.ts test/pick.test.ts` and commit "Chooser: a window at 100 is out, earliest weekly reset first" with the three trailers.

---

### Task 4: State store (`node:sqlite`)

**Files:**
- Create: `src/state.ts`, `test/state.test.ts`

**Interfaces:**
- Produces (all synchronous, one `openState()` per process, closed on exit):
  ```ts
  export type SessionRow = { id: string; provider: "claude" | "codex"; cliSessionId: string | null; cwd: string;
    socket: string; pane: string; serverStart: string; need: "any" | "fable"; account: string; generation: number;
    state: "launching" | "running" | "walled" | "stopping" | "resuming" | "continuing" | "parked" | "waiting" | "stopped";
    desired: "running" | "stopped"; flags: string[]; createdAt: number; updatedAt: number };
  export type LaunchRow = { id: string; sessionId: string; generation: number; account: string; command: string[]; env: Record<string,string>; createdAt: number };
  export type RecoveryRow = { id: number; sessionId: string; generation: number; turnId: string | null; kind: "session" | "weekly" | "fable" | "unknown";
    status: "pending" | "owned" | "done" | "obsolete"; owner: string | null; attempts: number; nextAttemptAt: number | null; createdAt: number; updatedAt: number };
  export type AttemptRow = { id: number; recoveryId: number; account: string; outcome: "ok" | "exhausted" | "auth" | "infra" | "resume-broken" | "forced" ; note: string; createdAt: number };
  export class State {
    createSession(s: Omit<SessionRow,"createdAt"|"updatedAt">): void; getSession(id): SessionRow | null; listSessions(): SessionRow[];
    updateSession(id, patch: Partial<SessionRow>): void;
    createLaunch(l: LaunchRow): void; getLaunch(id): LaunchRow | null;
    addRecovery(r: Omit<RecoveryRow,"id"|"status"|"owner"|"attempts"|"nextAttemptAt"|"createdAt"|"updatedAt">): number;
    pendingRecovery(sessionId): RecoveryRow | null; ownRecovery(id, owner): boolean; finishRecovery(id, status: "done"|"obsolete"): void;
    addAttempt(a: Omit<AttemptRow,"id"|"createdAt">): void; attempts(recoveryId): AttemptRow[];
    setWakeup(sessionId, at: number): void; dueWakeups(now): SessionRow[];
    close(): void;
  }
  export function openState(): State;   // creates the file 0600 and the schema if missing
  ```
  The `env` column of a launch holds only NON-secret variables (names of credential refs, `MS_*`); the secret is read by `ms _exec` from the launch-credentials store at exec time.

- [ ] **Step 1: Write the failing tests**

`test/state.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { tempHome } from "./helpers.ts";

async function fresh() {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { openState } = await import("../src/state.ts");
  return { st: openState(), msHome };
}
const base = { provider: "claude" as const, cliSessionId: "c1", cwd: "/tmp/x", socket: "/private/tmp/tmux-501/default",
  pane: "%5", serverStart: "1789000000", need: "any" as const, account: "gmail", generation: 1,
  state: "launching" as const, desired: "running" as const, flags: ["--dangerously-skip-permissions"] };

test("the state file is 0600 and sessions round-trip", async () => {
  const { st, msHome } = await fresh();
  st.createSession({ id: "s1", ...base });
  assert.equal(statSync(`${msHome}/state.sqlite`).mode & 0o777, 0o600);
  const s = st.getSession("s1")!;
  assert.equal(s.account, "gmail"); assert.deepEqual(s.flags, ["--dangerously-skip-permissions"]);
  st.updateSession("s1", { state: "running", generation: 2 });
  assert.equal(st.getSession("s1")!.generation, 2);
  st.close();
});

test("one pending recovery per session; owning it is atomic", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base });
  const id = st.addRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  const dup = st.addRecovery({ sessionId: "s1", generation: 1, turnId: "t1", kind: "fable" });
  assert.equal(dup, id, "a duplicate failure for the same generation joins the pending recovery");
  assert.equal(st.pendingRecovery("s1")!.status, "pending");
  assert.equal(st.ownRecovery(id, "worker-A"), true);
  assert.equal(st.ownRecovery(id, "worker-B"), false);
  st.addAttempt({ recoveryId: id, account: "dirk", outcome: "exhausted", note: "" });
  assert.equal(st.attempts(id).length, 1);
  st.finishRecovery(id, "done");
  assert.equal(st.pendingRecovery("s1"), null);
  st.close();
});

test("wakeups come due in order", async () => {
  const { st } = await fresh();
  st.createSession({ id: "s1", ...base }); st.createSession({ id: "s2", ...base, pane: "%6" });
  st.setWakeup("s1", 200); st.setWakeup("s2", 100);
  assert.deepEqual(st.dueWakeups(150).map((s) => s.id), ["s2"]);
  assert.deepEqual(st.dueWakeups(300).map((s) => s.id), ["s2", "s1"]);
  st.close();
});
```

- [ ] **Step 2: Run to verify they fail** — module missing.

- [ ] **Step 3: Implement `src/state.ts`**

```ts
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";

export type Provider = "claude" | "codex";
export type SessionState = "launching" | "running" | "walled" | "stopping" | "resuming" | "continuing" | "parked" | "waiting" | "stopped";
export type SessionRow = { id: string; provider: Provider; cliSessionId: string | null; cwd: string; socket: string; pane: string;
  serverStart: string; need: "any" | "fable"; account: string; generation: number; state: SessionState;
  desired: "running" | "stopped"; flags: string[]; createdAt: number; updatedAt: number };
export type LaunchRow = { id: string; sessionId: string; generation: number; account: string; command: string[]; env: Record<string, string>; createdAt: number };
export type WallKind = "session" | "weekly" | "fable" | "unknown";
export type RecoveryRow = { id: number; sessionId: string; generation: number; turnId: string | null; kind: WallKind;
  status: "pending" | "owned" | "done" | "obsolete"; owner: string | null; attempts: number; nextAttemptAt: number | null; createdAt: number; updatedAt: number };
export type AttemptOutcome = "ok" | "exhausted" | "auth" | "infra" | "resume-broken" | "forced";
export type AttemptRow = { id: number; recoveryId: number; account: string; outcome: AttemptOutcome; note: string; createdAt: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, provider TEXT, cliSessionId TEXT, cwd TEXT, socket TEXT, pane TEXT,
  serverStart TEXT, need TEXT, account TEXT, generation INTEGER, state TEXT, desired TEXT, flags TEXT, wakeupAt INTEGER, createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, sessionId TEXT, generation INTEGER, account TEXT, command TEXT, env TEXT, createdAt INTEGER);
CREATE TABLE IF NOT EXISTS recoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, generation INTEGER, turnId TEXT, kind TEXT,
  status TEXT, owner TEXT, attempts INTEGER DEFAULT 0, nextAttemptAt INTEGER, createdAt INTEGER, updatedAt INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_recovery ON recoveries(sessionId) WHERE status IN ('pending','owned');
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, recoveryId INTEGER, account TEXT, outcome TEXT, note TEXT, createdAt INTEGER);
`;
const now = () => Math.floor(Date.now() / 1000);

export class State {
  constructor(private db: DatabaseSync) { db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); db.exec(SCHEMA); }
  private rowToSession(r: Record<string, unknown> | undefined): SessionRow | null {
    if (!r) return null;
    return { ...(r as unknown as SessionRow), flags: JSON.parse(String(r.flags ?? "[]")) };
  }
  createSession(s: Omit<SessionRow, "createdAt" | "updatedAt">): void {
    const t = now();
    this.db.prepare(`INSERT INTO sessions (id,provider,cliSessionId,cwd,socket,pane,serverStart,need,account,generation,state,desired,flags,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, s.provider, s.cliSessionId, s.cwd, s.socket, s.pane, s.serverStart, s.need, s.account, s.generation, s.state, s.desired, JSON.stringify(s.flags), t, t);
  }
  getSession(id: string): SessionRow | null { return this.rowToSession(this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined); }
  listSessions(): SessionRow[] { return (this.db.prepare("SELECT * FROM sessions ORDER BY createdAt").all() as Record<string, unknown>[]).map((r) => this.rowToSession(r)!); }
  updateSession(id: string, patch: Partial<SessionRow>): void {
    const cols = Object.keys(patch).filter((k) => k !== "id");
    if (!cols.length) return;
    const vals = cols.map((k) => (k === "flags" ? JSON.stringify((patch as Record<string, unknown>)[k]) : (patch as Record<string, unknown>)[k]));
    this.db.prepare(`UPDATE sessions SET ${cols.map((c) => `${c}=?`).join(",")}, updatedAt=? WHERE id=?`).run(...(vals as (string | number | null)[]), now(), id);
  }
  createLaunch(l: LaunchRow): void {
    this.db.prepare("INSERT INTO launches (id,sessionId,generation,account,command,env,createdAt) VALUES (?,?,?,?,?,?,?)")
      .run(l.id, l.sessionId, l.generation, l.account, JSON.stringify(l.command), JSON.stringify(l.env), l.createdAt);
  }
  getLaunch(id: string): LaunchRow | null {
    const r = this.db.prepare("SELECT * FROM launches WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as LaunchRow), command: JSON.parse(String(r.command)), env: JSON.parse(String(r.env)) } : null;
  }
  addRecovery(r: { sessionId: string; generation: number; turnId: string | null; kind: WallKind }): number {
    const open = this.pendingRecovery(r.sessionId);
    if (open) return open.id;
    const t = now();
    const res = this.db.prepare("INSERT INTO recoveries (sessionId,generation,turnId,kind,status,createdAt,updatedAt) VALUES (?,?,?,?,'pending',?,?)")
      .run(r.sessionId, r.generation, r.turnId, r.kind, t, t);
    return Number(res.lastInsertRowid);
  }
  pendingRecovery(sessionId: string): RecoveryRow | null {
    return (this.db.prepare("SELECT * FROM recoveries WHERE sessionId=? AND status IN ('pending','owned') LIMIT 1").get(sessionId) as RecoveryRow | undefined) ?? null;
  }
  ownRecovery(id: number, owner: string): boolean {
    const res = this.db.prepare("UPDATE recoveries SET status='owned', owner=?, updatedAt=? WHERE id=? AND status='pending'").run(owner, now(), id);
    return Number(res.changes) === 1;
  }
  finishRecovery(id: number, status: "done" | "obsolete"): void { this.db.prepare("UPDATE recoveries SET status=?, updatedAt=? WHERE id=?").run(status, now(), id); }
  releaseRecovery(id: number): void { this.db.prepare("UPDATE recoveries SET status='pending', owner=NULL, updatedAt=? WHERE id=?").run(now(), id); }
  addAttempt(a: { recoveryId: number; account: string; outcome: AttemptOutcome; note: string }): void {
    this.db.prepare("INSERT INTO attempts (recoveryId,account,outcome,note,createdAt) VALUES (?,?,?,?,?)").run(a.recoveryId, a.account, a.outcome, a.note, now());
    this.db.prepare("UPDATE recoveries SET attempts=attempts+1, updatedAt=? WHERE id=?").run(now(), a.recoveryId);
  }
  attempts(recoveryId: number): AttemptRow[] { return this.db.prepare("SELECT * FROM attempts WHERE recoveryId=? ORDER BY id").all(recoveryId) as AttemptRow[]; }
  setWakeup(sessionId: string, at: number | null): void { this.db.prepare("UPDATE sessions SET wakeupAt=?, updatedAt=? WHERE id=?").run(at, now(), sessionId); }
  dueWakeups(t: number): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE wakeupAt IS NOT NULL AND wakeupAt<=? ORDER BY wakeupAt").all(t) as Record<string, unknown>[]).map((r) => this.rowToSession(r)!);
  }
  close(): void { this.db.close(); }
}

export function openState(): State {
  ensureStore();
  const fresh = !existsSync(p.state);
  const db = new DatabaseSync(p.state);
  if (fresh) chmodSync(p.state, 0o600);
  return new State(db);
}
```

- [ ] **Step 4: Run to verify they pass** — 3 pass (Node 22 prints an ExperimentalWarning for sqlite; silence it in `bin/ms` with `process.removeAllListeners("warning")` guarded to that name is NOT allowed — instead run tests with `NODE_NO_WARNINGS=1` in the `test` script: update package.json's test script to `NODE_NO_WARNINGS=1 node --import tsx --test test/*.test.ts`).

- [ ] **Step 5: Commit** — "State store: sessions, launches, one open recovery per session, attempts, wakeups (node:sqlite)".

---

### Task 5: Events (`events.jsonl`)

**Files:**
- Create: `src/events.ts`, `test/events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EventKind = "started" | "resumed" | "cleared" | "compacted" | "activity" | "rate_limited" | "ended" | "died" | "recovery" | "note";
  export type Event = { t: number; kind: EventKind; session: string; generation: number; cliSessionId?: string | null; turnId?: string | null; kindDetail?: string; text?: string };
  export function appendEvent(e: Event): void;        // O_APPEND, one line, 0600
  export function readEvents(session: string): Event[]; // tolerates a torn last line
  export function lastEvent(session: string, kind?: EventKind): Event | null;
  ```

- [ ] **Step 1: Write the failing tests**

`test/events.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { tempHome } from "./helpers.ts";

test("append and read; a torn trailing line is ignored, not fatal", async () => {
  const { home, msHome } = tempHome(); process.env.HOME = home; process.env.MS_HOME = msHome;
  const { appendEvent, readEvents, lastEvent } = await import("../src/events.ts");
  const { p } = await import("../src/paths.ts");
  appendEvent({ t: 1, kind: "started", session: "s1", generation: 1, cliSessionId: "c1" });
  appendEvent({ t: 2, kind: "rate_limited", session: "s1", generation: 1, kindDetail: "fable" });
  appendFileSync(p.eventsFile("s1"), '{"t":3,"kind":"ended","ses');   // a crash mid-write
  assert.equal(statSync(p.eventsFile("s1")).mode & 0o777, 0o600);
  assert.equal(readEvents("s1").length, 2);
  assert.equal(lastEvent("s1", "rate_limited")!.kindDetail, "fable");
  assert.equal(readEvents("nope").length, 0);
  assert.equal(readFileSync(p.eventsFile("s1"), "utf8").split("\n").length, 3);
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `src/events.ts`**

```ts
import { appendFileSync, existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { ensureSessionDir, p } from "./paths.ts";

export type EventKind = "started" | "resumed" | "cleared" | "compacted" | "activity" | "rate_limited" | "ended" | "died" | "recovery" | "note";
export type Event = { t: number; kind: EventKind; session: string; generation: number; cliSessionId?: string | null; turnId?: string | null; kindDetail?: string; text?: string };

export function appendEvent(e: Event): void {
  ensureSessionDir(e.session);
  const f = p.eventsFile(e.session);
  if (!existsSync(f)) closeSync(openSync(f, "a", 0o600));
  appendFileSync(f, JSON.stringify(e) + "\n", { mode: 0o600 });
}
export function readEvents(session: string): Event[] {
  const f = p.eventsFile(session);
  if (!existsSync(f)) return [];
  const out: Event[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Event); } catch { /* torn trailing line: ignore */ }
  }
  return out;
}
export function lastEvent(session: string, kind?: EventKind): Event | null {
  const ev = readEvents(session).filter((e) => !kind || e.kind === kind);
  return ev.length ? ev[ev.length - 1] : null;
}
```

- [ ] **Step 4: Run to verify it passes.** — 1 pass.
- [ ] **Step 5: Commit** — "Events: append-only per-session audit log".

---

### Task 6: tmux wrapper (socket-aware)

**Files:**
- Create: `src/tmux.ts`, `test/tmux.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class Tmux {
    constructor(public socket: string | null);        // null = default server; always passes -S when set
    run(args: string[], input?: string): { code: number; stdout: string; stderr: string };  // bounded 10 s
    serverIdentity(): string;                          // "#{pid}:#{start_time}" — pane ids recur after a restart
    paneExists(pane): boolean; paneInfo(pane): { pid: number; command: string; dead: boolean; cwd: string } | null;
    setPaneOption(pane, name, value): void; unsetPaneOption(pane, name): void; paneOptions(pane): Record<string,string>;
    remainOnExit(pane, on: boolean): void;
    capture(pane, lines = 200): string;
    respawn(pane, cwd, command: string[]): void;       // respawn-pane -k -c cwd -t pane -- shell-quoted command
    runShell(command: string[], opts?: { delaySeconds?: number }): void;  // run-shell -b [-d N] "<quoted>"
    setPaneDiedHook(pane, command: string[]): void;    // set-hook -p -t pane pane-died "run-shell -b '<quoted>'"
    sendKeys(pane, keys: string[]): void;
    newWindow(session, cwd, command: string[]): string; // returns the new pane id
    hasSession(name): boolean; newSession(name, cwd, command): string; attach(name): never-returning spawn (inherit stdio)
  }
  export function tmuxFromEnv(): Tmux;                 // socket from $TMUX's first field, else null
  export function shellQuote(args: string[]): string;  // POSIX single-quote quoting
  ```

- [ ] **Step 1: Write the failing tests** (a stub `tmux` that logs argv and answers a few queries)

`test/tmux.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

function setup() {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *"#{pid}:#{start_time}"*) echo "4242:1789000000" ;;
  *"#{pane_pid}"*) echo "777	2.1.272	0	/tmp/work" ;;
  *"show-options -p"*) printf '@ms_session s1\\n@ms_generation 3\\n' ;;
  *capture-pane*) printf 'line one\\nline two\\n' ;;
  *"list-panes"*) echo "%5" ;;
esac
exit 0`);
  process.env.HOME = home; process.env.MS_HOME = msHome; process.env.PATH = `${dir}:${process.env.PATH}`;
  return { log };
}

test("every call carries -S when a socket is set; respawn and run-shell quote safely", async () => {
  const { log } = setup();
  const { Tmux, shellQuote } = await import("../src/tmux.ts");
  const t = new Tmux("/private/tmp/tmux-501/default");
  assert.equal(t.serverIdentity(), "4242:1789000000");
  t.respawn("%5", "/tmp/w d", ["ms", "_exec", "L1"]);
  t.runShell(["ms", "_recover", "s1"], { delaySeconds: 30 });
  t.setPaneDiedHook("%5", ["ms", "_pane_died", "s1"]);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("-S /private/tmp/tmux-501/default ")));
  assert.ok(lines.some((l) => l.includes("respawn-pane -k -c '/tmp/w d' -t %5 'ms' '_exec' 'L1'")));
  assert.ok(lines.some((l) => l.includes("run-shell -b -d 30 'ms' '_recover' 's1'")));
  assert.ok(lines.some((l) => l.includes("set-hook -p -t %5 pane-died")));
  assert.equal(shellQuote(["a b", "it's"]), "'a b' 'it'\\''s'");
});

test("paneInfo and paneOptions parse the stub's answers", async () => {
  setup();
  const { Tmux } = await import("../src/tmux.ts");
  const t = new Tmux(null);
  assert.deepEqual(t.paneInfo("%5"), { pid: 777, command: "2.1.272", dead: false, cwd: "/tmp/work" });
  assert.deepEqual(t.paneOptions("%5"), { "@ms_session": "s1", "@ms_generation": "3" });
  assert.equal(t.capture("%5"), "line one\nline two\n");
});

test("tmuxFromEnv reads the socket from $TMUX", async () => {
  setup();
  process.env.TMUX = "/private/tmp/tmux-501/default,123,0";
  const { tmuxFromEnv } = await import("../src/tmux.ts");
  assert.equal(tmuxFromEnv().socket, "/private/tmp/tmux-501/default");
  delete process.env.TMUX;
  assert.equal(tmuxFromEnv().socket, null);
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `src/tmux.ts`**

```ts
import { spawnSync, spawn } from "node:child_process";

export function shellQuote(args: string[]): string {
  return args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

export class Tmux {
  constructor(public socket: string | null) {}
  private base(): string[] { return this.socket ? ["-S", this.socket] : []; }
  run(args: string[], input = ""): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("tmux", [...this.base(), ...args], { encoding: "utf8", input, timeout: 10_000 });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  private must(args: string[]): string {
    const r = this.run(args);
    if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim() || r.code}`);
    return r.stdout;
  }
  serverIdentity(): string { return this.must(["display-message", "-p", "#{pid}:#{start_time}"]).trim(); }
  paneExists(pane: string): boolean { return this.run(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.split("\n").includes(pane); }
  paneInfo(pane: string): { pid: number; command: string; dead: boolean; cwd: string } | null {
    const r = this.run(["display-message", "-p", "-t", pane, "#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{pane_current_path}"]);
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const [pid, command, dead, cwd] = r.stdout.trim().split("\t");
    return { pid: Number(pid), command, dead: dead === "1", cwd };
  }
  setPaneOption(pane: string, name: string, value: string): void { this.must(["set-option", "-p", "-t", pane, name, value]); }
  unsetPaneOption(pane: string, name: string): void { this.run(["set-option", "-pu", "-t", pane, name]); }
  paneOptions(pane: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of this.run(["show-options", "-p", "-t", pane]).stdout.split("\n")) {
      const i = line.indexOf(" "); if (i < 0) continue;
      out[line.slice(0, i)] = line.slice(i + 1).replace(/^"(.*)"$/, "$1");
    }
    return out;
  }
  remainOnExit(pane: string, on: boolean): void { this.must(["set-option", "-p", "-t", pane, "remain-on-exit", on ? "on" : "off"]); }
  capture(pane: string, lines = 200): string { return this.run(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", pane]).stdout; }
  respawn(pane: string, cwd: string, command: string[]): void { this.must(["respawn-pane", "-k", "-c", cwd, "-t", pane, shellQuote(command)]); }
  runShell(command: string[], opts: { delaySeconds?: number } = {}): void {
    const args = ["run-shell", "-b"]; if (opts.delaySeconds) args.push("-d", String(opts.delaySeconds));
    this.must([...args, shellQuote(command)]);
  }
  setPaneDiedHook(pane: string, command: string[]): void {
    this.must(["set-hook", "-p", "-t", pane, "pane-died", `run-shell -b ${shellQuote([shellQuote(command)])}`]);
  }
  sendKeys(pane: string, keys: string[]): void { this.must(["send-keys", "-t", pane, ...keys]); }
  newWindow(session: string, cwd: string, command: string[]): string {
    return this.must(["new-window", "-P", "-F", "#{pane_id}", "-t", session, "-c", cwd, shellQuote(command)]).trim();
  }
  hasSession(name: string): boolean { return this.run(["has-session", "-t", name]).code === 0; }
  newSession(name: string, cwd: string, command: string[]): string {
    return this.must(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "-c", cwd, shellQuote(command)]).trim();
  }
  attach(name: string): number {
    const r = spawnSync("tmux", [...this.base(), "attach-session", "-t", name], { stdio: "inherit" });
    return r.status ?? 1;
  }
}

export function tmuxFromEnv(): Tmux {
  const t = process.env.TMUX;
  return new Tmux(t ? t.split(",")[0] : null);
}
export function currentPane(): string | null { return process.env.TMUX_PANE || null; }
```

Note on `respawn`: tmux takes the command as ONE shell-command argument, so `shellQuote(command)` is passed as a single argv element; the stub logs it as text, which is what the assertion checks. `setPaneDiedHook` double-quotes because the hook's argument is itself a tmux command line.

- [ ] **Step 4: Run to verify they pass.** — 3 pass.
- [ ] **Step 5: Commit** — "tmux wrapper: socket-aware, quoted respawn/run-shell/hooks".

---

### Task 7: Claude poll credentials and usage provider (spec §6, §2)

**Files:**
- Create: `src/providers/claude-usage.ts`, `test/claude-usage.test.ts`
- Reference: `/Users/aadarwal/src/aadarwal/data/lib/providers/claude.ts` (the working poller: endpoints, refresh, error classification, write-back) and `lib/keychain.ts` there (bounded `security` calls). Port the behaviour; do not copy the dashboard's snapshot/cache machinery (Task 8 owns that).

**Interfaces:**
- Produces:
  ```ts
  export type PollCredentials = { accessToken: string; refreshToken: string; expiresAt: number; source: "file" | "keychain" };
  export function readPollCredentials(name: string): PollCredentials | null;   // file `<configDir>/.credentials.json` first, then keychain
  export function refreshPollCredentials(name: string, c: PollCredentials, signal: AbortSignal): Promise<PollCredentials>;  // writes back to where it came from; throws AuthError on 401/invalid_grant
  export type Usage = { session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null };
  export function fetchUsage(c: PollCredentials, signal: AbortSignal): Promise<Usage>;
  export type Profile = { email: string; orgId: string; orgName: string; tier: string | null };
  export function fetchProfile(c: PollCredentials, signal: AbortSignal): Promise<Profile>;
  export class AuthError extends Error {}; export class TransientError extends Error {}
  export const CLAUDE_USAGE_URL, CLAUDE_PROFILE_URL, CLAUDE_TOKEN_URL, CLAUDE_CLIENT_ID;   // copied from the dashboard provider
  ```
  `Window` is Task 3's type. Kinds map from the endpoint's `limits[].kind`: `session` → session, `weekly_all` → weeklyAll, `weekly_scoped` with the Fable display name → weeklyFable (exactly as the dashboard does; `usedPercent` raw, no rounding).
- Keychain read: `security find-generic-password -s "Claude Code-credentials" -a <account> -w` with `timeout: 3000`; the `<account>` for a custom config dir is discovered by **S0** below and stored in the registry-adjacent file `claude/<name>/keychain-account` by `ms accounts login` (Task 10). If that file is absent, keychain is not tried.

- [ ] **Step 0 (spike S0, run by the implementer on the author's machine, 10 minutes, no code kept):** With a throwaway `CLAUDE_CONFIG_DIR=$(mktemp -d)/probe`, run `claude auth login` (browser), then check where the credential landed: `ls -la $DIR/.credentials.json` and `security dump-keychain 2>/dev/null | grep -B2 -A4 'Claude Code'` (look for a second item and its `acct` value). Record the answer at the top of `test/claude-usage.test.ts` as a comment and implement `readPollCredentials` accordingly (file first, then keychain with the recorded account form). Log out (`claude auth logout` with the same config dir) and delete the temp dir afterwards.

- [ ] **Step 1: Write the failing tests** (fetch is stubbed by replacing `globalThis.fetch`; `security` by a stub on PATH)

`test/claude-usage.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

function env() {
  const { home, msHome } = tempHome(); process.env.HOME = home; process.env.MS_HOME = msHome;
  const dir = path.join(msHome, "claude", "gmail"); mkdirSync(dir, { recursive: true });
  return { dir, msHome };
}
const cred = { claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 } };

test("readPollCredentials prefers the credentials file", async () => {
  const { dir } = env();
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(cred));
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail")!.source, "file");
  assert.equal(readPollCredentials("gmail")!.accessToken, "at-1");
});

test("readPollCredentials falls back to the keychain account recorded at login", async () => {
  const { dir } = env();
  writeFileSync(path.join(dir, "keychain-account"), "aadarwal-abc123\n");
  const { stub, dir: bin } = stubDir(); process.env.PATH = `${bin}:${process.env.PATH}`;
  stub("security", `case "$*" in *"-a aadarwal-abc123"*) printf '%s' '${JSON.stringify(cred)}' ;; *) exit 44 ;; esac`);
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail")!.source, "keychain");
});

test("fetchUsage maps the three windows raw and classifies errors", async () => {
  env();
  const { fetchUsage, AuthError } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  globalThis.fetch = (async () => new Response(JSON.stringify({ limits: [
    { kind: "session", used_percent: 99.6, resets_at: "2026-09-15T05:00:00Z" },
    { kind: "weekly_all", used_percent: 40, resets_at: "2026-09-18T00:00:00Z" },
    { kind: "weekly_scoped", display_name: "Fable", used_percent: 100, resets_at: "2026-09-18T00:00:00Z" },
  ] }), { status: 200 })) as typeof fetch;
  const u = await fetchUsage(c, AbortSignal.timeout(1000));
  assert.equal(u.session!.usedPercent, 99.6); assert.equal(u.weeklyFable!.usedPercent, 100);
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  await assert.rejects(fetchUsage(c, AbortSignal.timeout(1000)), AuthError);
});

test("refreshPollCredentials writes the rotated refresh token back to the file", async () => {
  const { dir } = env();
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(cred));
  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
  const c2 = await refreshPollCredentials("gmail", readPollCredentials("gmail")!, AbortSignal.timeout(1000));
  assert.equal(c2.refreshToken, "rt-2");
  assert.equal(JSON.parse(readFileSync(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken, "rt-2");
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `src/providers/claude-usage.ts`** — port from the dashboard provider; skeleton:

```ts
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { p } from "../paths.ts";
import type { Window } from "../pick.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const CLAUDE_TOKEN_URL = "…copy from data/lib/providers/claude.ts…";
export const CLAUDE_CLIENT_ID = "…copy from data/lib/providers/claude.ts…";
export class AuthError extends Error {} export class TransientError extends Error {}
export type PollCredentials = { accessToken: string; refreshToken: string; expiresAt: number; source: "file" | "keychain" };
export type Usage = { session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null };
export type Profile = { email: string; orgId: string; orgName: string; tier: string | null };

function parseCredFile(txt: string): PollCredentials | null {
  const j = JSON.parse(txt) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
  const o = j.claudeAiOauth; if (!o?.accessToken || !o.refreshToken) return null;
  return { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: o.expiresAt ?? 0, source: "file" };
}
export function readPollCredentials(name: string): PollCredentials | null {
  const dir = p.claudeConfigDir(name);
  const f = path.join(dir, ".credentials.json");
  if (existsSync(f)) { try { return parseCredFile(readFileSync(f, "utf8")); } catch { return null; } }
  const accFile = path.join(dir, "keychain-account");
  if (!existsSync(accFile)) return null;
  const acct = readFileSync(accFile, "utf8").trim();
  const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", acct, "-w"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try { const c = parseCredFile(r.stdout.trim()); return c ? { ...c, source: "keychain" } : null; } catch { return null; }
}
function writeBack(name: string, c: PollCredentials): void {
  if (c.source !== "file") return;   // keychain write-back would put the secret on argv: the CLI's own refresh keeps that copy fresh; we re-read next time
  const f = path.join(p.claudeConfigDir(name), ".credentials.json");
  const j = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  j.claudeAiOauth = { ...(j.claudeAiOauth ?? {}), accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt };
  const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 }); renameSync(tmp, f);
}
export async function refreshPollCredentials(name: string, c: PollCredentials, signal: AbortSignal): Promise<PollCredentials> {
  const res = await fetch(CLAUDE_TOKEN_URL, { method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: CLAUDE_CLIENT_ID }) });
  if (res.status === 400 || res.status === 401) throw new AuthError(`refresh rejected (${res.status})`);
  if (!res.ok) throw new TransientError(`refresh failed (${res.status})`);
  let j: { access_token?: string; refresh_token?: string; expires_in?: number };
  try { j = await res.json(); } catch { throw new TransientError("token endpoint returned non-JSON"); }
  if (!j.access_token) throw new TransientError("token endpoint returned no access token");
  const next: PollCredentials = { accessToken: j.access_token, refreshToken: j.refresh_token ?? c.refreshToken, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, source: c.source };
  writeBack(name, next);
  return next;
}
async function authed(url: string, c: PollCredentials, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { authorization: `Bearer ${c.accessToken}`, "anthropic-beta": "oauth-2025-04-20" } });
  if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status} from ${new URL(url).pathname}`);
  if (res.status === 429 || res.status >= 500) throw new TransientError(`${res.status} from ${new URL(url).pathname}`);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).pathname}`);
  return res.json();
}
export async function fetchUsage(c: PollCredentials, signal: AbortSignal): Promise<Usage> {
  const j = (await authed(CLAUDE_USAGE_URL, c, signal)) as { limits?: { kind: string; display_name?: string; used_percent: number; resets_at: string | null }[] };
  const u: Usage = { session: null, weeklyAll: null, weeklyFable: null };
  for (const l of j.limits ?? []) {
    const w: Window = { usedPercent: Number(l.used_percent), resetsAt: l.resets_at ?? null };
    if (l.kind === "session") u.session = w;
    else if (l.kind === "weekly_all") u.weeklyAll = w;
    else if (l.kind === "weekly_scoped" && /fable/i.test(l.display_name ?? "")) u.weeklyFable = w;
  }
  return u;
}
export async function fetchProfile(c: PollCredentials, signal: AbortSignal): Promise<Profile> {
  const j = (await authed(CLAUDE_PROFILE_URL, c, signal)) as { account?: { email?: string }; organization?: { uuid?: string; name?: string; rate_limit_tier?: string } };
  return { email: j.account?.email ?? "", orgId: j.organization?.uuid ?? "", orgName: j.organization?.name ?? "", tier: j.organization?.rate_limit_tier ?? null };
}
```
Copy the exact header set, token URL and client id from the dashboard provider (they are the ones proven to work against these endpoints) and note in a comment where they came from.

- [ ] **Step 4: Run to verify they pass.** — 4 pass.
- [ ] **Step 5: Commit** — "Claude poll grant: credentials, refresh with write-back, usage and profile".

---

### Task 8: Coalesced usage snapshot (spec §9 pool coordination)

**Files:**
- Create: `src/snapshot.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Consumes: Task 7's provider, Task 2's registry, Task 12's `withLock` (write this task after Task 12 lands, or inline a temporary mkdir lock and swap it in Task 12 — the plan orders Task 12 before use; see Task 12).
- Produces:
  ```ts
  export type AccountUsage = { name: string; provider: "claude" | "codex"; shared: boolean; usage: Usage | null; error: string | null;
    errorKind: "auth" | "transient" | "other" | null; observedAt: number; stale: boolean };
  export type Snapshot = { takenAt: number; accounts: AccountUsage[] };
  export function getSnapshot(opts: { maxAgeMs?: number; only?: string[] }): Promise<Snapshot>;  // default 20 s; coalesced via a lock + the cache file
  export function toPickInputs(s: Snapshot): PickInput[];   // alive rule: usage present AND (no error OR transient error with observedAt < 10 min)
  ```
  Backoff per account: after a transient error, `nextAllowedAttemptAt = now + min(retryAfter, 15 min)` kept in the cache file; an account inside its backoff is served from cache (marked `stale`).

- [ ] **Step 1: Write the failing tests** — stub `fetch` counting calls; two concurrent `getSnapshot()` calls produce ONE poll per account; a second call within 20 s makes no network call; a 429 with `retry-after: 86400` is clamped to 15 min.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — `snapshot.json` (0600) `{takenAt, accounts, backoff: {name: untilMs}}`; `getSnapshot` = under `withLock("snapshot")`: if fresh, return; else poll each Claude account with `readPollCredentials` → refresh if `expiresAt < now + 60 s` → `fetchUsage`, all with `AbortSignal.timeout(15000)` and `Promise.allSettled`; classify errors (`AuthError` → auth, `TransientError`/timeout → transient); write the file atomically. `toPickInputs` maps to Task 3's shape with `error` set for dead accounts and the alive rule above.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** — "Usage snapshot: coalesced, 20 s fresh, bounded backoff".

---

### Task 9: Launch credentials store (spec §5, §11)

**Files:**
- Create: `src/launch-credentials.ts`, `test/launch-credentials.test.ts`

**Interfaces:**
- Produces: `saveLaunchToken(name, token)` (file `launch/<name>.token`, 0600, atomic), `readLaunchToken(name): string | null`, `deleteLaunchToken(name)`, `looksLikeSetupToken(s): boolean` (`/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/`).

- [ ] **Step 1: Failing tests:** save then read round-trips; mode is 0600; missing → null; `looksLikeSetupToken` accepts a sample and rejects `sk-ant-api03-…`.
- [ ] **Step 2–4:** implement with `writeFileSync(tmp, token + "\n", {mode: 0o600})` + `renameSync`; run.
- [ ] **Step 5: Commit** — "Launch token store (0600 files)".

---

### Task 10: `ms accounts` (Claude)

**Files:**
- Create: `src/accounts.ts`, `test/accounts.test.ts`; Modify: `src/cli.ts` (register `accounts`)

**Interfaces:**
- Consumes: registry (T2), provider (T7), launch store (T9).
- Produces the verb:
  ```
  ms accounts add <name> [--label L] [--shared]       registers a Claude account row (no credentials yet)
  ms accounts login <name>                             1) `claude auth login` with CLAUDE_CONFIG_DIR=<store>/claude/<name> (stdio inherited; browser)
                                                       2) locate the credential (file or keychain; write claude/<name>/keychain-account) and fetch the profile → orgId
                                                       3) `claude setup-token` with stdout piped: capture the token line, save it; verify it with a headless one-shot
                                                          `CLAUDE_CODE_OAUTH_TOKEN=<tok> claude -p "Reply with the single word ok." --model <cheapest>` (bounded 90 s)
                                                       4) identityVerified = the profile orgId matches `claude auth status --json`'s org when the CLI reports one under the token env; else recorded as false with a warning
  ms accounts verify <name>                            re-runs 2–4's checks without logging in
  ms accounts remove <name>                            deletes the row, the token file and the config dir
  ms accounts token <name>                             prints the launch token (the only secret-printing verb)
  ms accounts ls                                       table: name, label, org, poll grant ok?, launch token ok?, verified?
  ```
  Duplicate organisations are refused at `login` ("<name> resolves to the same organisation as <other>").

- [ ] **Step 1: Failing tests** with stub `claude` (records argv; `auth login` writes a fake `.credentials.json` into `$CLAUDE_CONFIG_DIR`; `setup-token` prints a token; `-p` prints "ok"; `auth status --json` prints `{"organization":{"uuid":"org-1"}}`) and stubbed `fetch` for profile: `add` writes the row; `login` stores the token at 0600, sets orgId, `identityVerified: true`; a second account resolving to `org-1` is refused; `token` prints the token and nothing else does (grep all stdout/stderr of the other verbs for the token).
- [ ] **Step 2–4:** implement; every `spawnSync` bounded (`timeout`), the token never on argv (env only), `setup-token` output parsed with `looksLikeSetupToken` on each line.
- [ ] **Step 5: Commit** — "ms accounts: add, login (both credentials, identity by org), verify, remove, token, ls".

---

### Task 11: Claude hook handler and installer (spec §8)

**Files:**
- Create: `src/hooks/claude-hook.ts`, `src/hooks/install.ts`, `test/claude-hook.test.ts`, `test/hooks-install.test.ts`; Modify: `src/cli.ts` (register `_hook`)

**Interfaces:**
- Consumes: events (T5), state (T4), tmux (T6), wall kinds (T17's `wall.ts` — create `src/wall.ts` in THIS task, see below).
- Produces:
  - `ms _hook claude` — reads the hook JSON on stdin; needs `MS_SESSION`, `MS_GENERATION`, `MS_SOCKET`, `MS_PANE` in its environment (inherited from `ms _exec`); with any of them missing it exits 0 silently (unmanaged pane). Maps: `hook_event_name` `SessionStart` (`source` startup|resume|clear|compact) → `started|resumed|cleared|compacted` with `cliSessionId`; `UserPromptSubmit` → `activity`; `StopFailure` with `error === "rate_limit"` → `rate_limited` (kindDetail from `wallKindFromText(tmux capture)` else `unknown`), then `state.addRecovery(...)` and `tmux.runShell(["<abs ms>", "_recover", session])`; `SessionEnd` → `ended`. Any other event or a parse failure → exit 0. Never prints. Total budget 5 s (`AbortSignal.timeout` on nothing network; just bounded subprocesses).
  - `src/wall.ts`: `wallKindFromText(screen: string): "session" | "weekly" | "fable" | null` with the ANCHORED patterns (line start, optional `⎿`), scoped to the last user-turn echo → composer as in the anu fix (`_wall_scope` semantics: from the last line starting with `❯ text` up to the bottom-most `❯`/`›` line; fallback 16 rows above the composer).
  - `src/hooks/install.ts`: `installClaudeHooks(settingsPath, msBin): { changed: boolean; backup: string | null }` — merges `hooks.SessionStart`, `hooks.UserPromptSubmit`, `hooks.StopFailure` (matcher `rate_limit`), `hooks.SessionEnd` entries whose command is `"<msBin> _hook claude"` into the existing JSON, preserving every other key and existing hook entries; backs up first (`settings.json.bak-<epoch>`); idempotent. `claudeHooksInstalled(settingsPath, msBin): boolean`.

- [ ] **Step 1: Write the failing tests**

`test/claude-hook.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { run, stubDir, tempHome } from "./helpers.ts";

function setup() {
  const { home, msHome } = tempHome(); const { dir, stub } = stubDir();
  const tlog = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${tlog}"; case "$*" in *capture-pane*) printf '❯ do it\\n  ⎿  You'"'"'ve reached your Fable limit. Run /usage-credits to continue or switch models with /model.\\n\\n❯ \\n' ;; esac; exit 0`);
  const env = { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}`, MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: "/private/tmp/tmux-501/default", MS_PANE: "%7" };
  return { home, msHome, env, tlog };
}

test("SessionStart with source resume appends a resumed event carrying the inherited generation", async () => {
  const { env, msHome } = setup();
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "c-42" }));
  assert.equal(r.code, 0); assert.equal(r.stdout, "");
  const ev = readFileSync(path.join(msHome, "sessions", "s1", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([ev[0].kind, ev[0].generation, ev[0].cliSessionId], ["resumed", 2, "c-42"]);
});

test("StopFailure rate_limit records the wall kind from the screen, opens a recovery and asks tmux to dispatch the worker", async () => {
  const { env, msHome, tlog } = setup();
  process.env.HOME = env.HOME; process.env.MS_HOME = env.MS_HOME;
  const { openState } = await import("../src/state.ts");
  const st = openState(); st.createSession({ id: "s1", provider: "claude", cliSessionId: "c-42", cwd: "/tmp", socket: env.MS_SOCKET, pane: "%7", serverStart: "1", need: "fable", account: "dirk", generation: 2, state: "running", desired: "running", flags: [] }); st.close();
  const r = run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", error_message: "x", session_id: "c-42" }));
  assert.equal(r.code, 0);
  const ev = readFileSync(path.join(msHome, "sessions", "s1", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  assert.equal(ev.kind, "rate_limited"); assert.equal(ev.kindDetail, "fable");
  const st2 = openState(); assert.equal(st2.pendingRecovery("s1")!.kind, "fable"); st2.close();
  assert.match(readFileSync(tlog, "utf8"), /-S \/private\/tmp\/tmux-501\/default run-shell -b '.*ms' '_recover' 's1'/);
});

test("a StopFailure that is not a rate limit, or an unmanaged pane, does nothing", async () => {
  const { env, msHome } = setup();
  run(["_hook", "claude"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "overloaded" }));
  run(["_hook", "claude"], { ...env, MS_SESSION: "" }, JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit" }));
  assert.throws(() => readFileSync(path.join(msHome, "sessions", "s1", "events.jsonl")));
});
```

`test/hooks-install.test.ts`: a settings file with `model`, `enabledPlugins` and an existing `Notification` hook → after `installClaudeHooks` those keys survive byte-for-byte in value, the four `ms` entries exist exactly once (run twice → `changed: false` the second time), a `.bak-*` exists, and `claudeHooksInstalled` is true. Also: a missing settings file is created with just `hooks`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`src/wall.ts`:
```ts
export type WallKind = "session" | "weekly" | "fable";
const LEAD = String.raw`^\s*(?:⎿\s*)?`;
const PATTERNS: [WallKind, RegExp][] = [
  ["fable", new RegExp(LEAD + String.raw`(?:you'?ve reached your fable limit|fable limit reached)`, "i")],
  ["weekly", new RegExp(LEAD + String.raw`(?:you'?(?:ve|\s+have) reached your weekly usage limit|weekly limit reached)`, "i")],
  ["session", new RegExp(LEAD + String.raw`(?:you'?ve hit your (?:usage )?limit|new messages wait for your usage limit to reset|claude usage limit reached|usage limit reached)`, "i")],
];
/** The last turn: from the last `❯ text` echo up to the composer (bottom-most `❯`/`›`); fallback 16 rows above it. */
export function lastTurn(screen: string): string[] {
  const lines = screen.split("\n"); let n = lines.length;
  while (n > 0 && !lines[n - 1].trim()) n--;
  let comp = -1; for (let i = n - 1; i >= 0; i--) if (/^\s*[❯›]/.test(lines[i])) { comp = i; break; }
  const end = comp >= 0 ? comp : n;
  let start = -1; for (let i = end - 1; i >= 0; i--) if (/^\s*[❯›]\s+\S/.test(lines[i])) { start = i; break; }
  if (start < 0) start = Math.max(0, end - 16);
  return lines.slice(start, end);
}
export function wallKindFromText(screen: string): WallKind | null {
  const scope = lastTurn(screen);
  for (const [kind, re] of PATTERNS) if (scope.some((l) => re.test(l))) return kind;
  return null;
}
```

`src/hooks/claude-hook.ts`:
```ts
import { appendEvent } from "../events.ts";
import { openState } from "../state.ts";
import { Tmux } from "../tmux.ts";
import { wallKindFromText } from "../wall.ts";
import { msBinary } from "../paths.ts";   // add to paths.ts: process.env.MS_BIN || path.resolve(bin dir, "ms")

export async function claudeHook(): Promise<number> {
  const session = process.env.MS_SESSION, gen = Number(process.env.MS_GENERATION), socket = process.env.MS_SOCKET, pane = process.env.MS_PANE;
  if (!session || !Number.isFinite(gen) || !socket || !pane) return 0;
  let input: Record<string, unknown>;
  try { input = JSON.parse(await readStdin(3000)); } catch { return 0; }
  const name = String(input.hook_event_name ?? "");
  const cliSessionId = typeof input.session_id === "string" ? input.session_id : null;
  const t = Math.floor(Date.now() / 1000);
  if (name === "SessionStart") {
    const src = String(input.source ?? "startup");
    const kind = src === "resume" ? "resumed" : src === "clear" ? "cleared" : src === "compact" ? "compacted" : "started";
    appendEvent({ t, kind, session, generation: gen, cliSessionId });
  } else if (name === "UserPromptSubmit") {
    appendEvent({ t, kind: "activity", session, generation: gen, cliSessionId });
  } else if (name === "SessionEnd") {
    appendEvent({ t, kind: "ended", session, generation: gen, cliSessionId, kindDetail: String(input.reason ?? "") });
  } else if (name === "StopFailure" && input.error === "rate_limit") {
    const tmux = new Tmux(socket);
    const kind = wallKindFromText(tmux.capture(pane, 200)) ?? "unknown";
    appendEvent({ t, kind: "rate_limited", session, generation: gen, cliSessionId, kindDetail: kind });
    const st = openState();
    try {
      const s = st.getSession(session);
      if (s && s.generation === gen && s.desired === "running") {
        st.addRecovery({ sessionId: session, generation: gen, turnId: null, kind });
        tmux.runShell([msBinary(), "_recover", session]);
      }
    } finally { st.close(); }
  }
  return 0;
}
function readStdin(ms: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = ""; const timer = setTimeout(() => resolve(buf), ms);
    process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (buf += d)); process.stdin.on("end", () => { clearTimeout(timer); resolve(buf); });
  });
}
```
Register in `cli.ts`: `registerVerb("_hook", async ([which]) => which === "claude" ? claudeHook() : 0)`. Add `msBinary()` to `paths.ts` (`process.env.MS_BIN` else the absolute path of `bin/ms` relative to the module, resolved at install time by the wizard).

`src/hooks/install.ts`: read JSON (or `{}`), ensure `hooks[event]` arrays, add `{ matcher, hooks: [{ type: "command", command: "<msBin> _hook claude" }] }` when no entry with that exact command exists; write atomically with a backup copy first; `matcher` is `"rate_limit"` for `StopFailure` and `""` for the others.

- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** — "Claude hook: events, rate-limit trigger via tmux dispatch; hook installer; anchored wall patterns".

---

### Task 12: Locks (spec §9)

**Files:**
- Create: `src/lock.ts`, `test/lock.test.ts`; Modify: `src/snapshot.ts` (use `withLock`)

**Interfaces:**
- Produces: `acquire(name, { staleAfterMs = 600_000 }): Release | null` (mkdir `locks/<name>`, writes `holder` = `<pid> <epoch>`; a dir whose holder pid is dead or whose age exceeds `staleAfterMs` is reclaimed by `rename` to a unique stale name, then re-validated after the rename exactly as the anu lock does — if the moved-aside holder is not the one judged stale, move it back and fail), `withLock(name, fn)` (blocks up to 5 s polling every 100 ms, then throws `Locked`), `release()` removes only a dir whose holder is this pid.

- [ ] **Step 1: Failing tests:** two acquires on one name → second null; release then acquire → ok; a holder-less dir older than staleAfter → reclaimed; a fresh dir with a live pid → not reclaimed; a real race: 8 `spawnSync` child processes each running a tiny script that acquires the same name and sleeps 300 ms → exactly one succeeds (assert via their exit codes).
- [ ] **Step 2–4:** implement; run.
- [ ] **Step 5: Commit** — "Locks: mkdir with holder, revalidated stale reclaim".

---

### Task 13: `ms _exec <launch-id>` (spec §7 step 4, §11)

**Files:**
- Create: `src/exec.ts`, `test/exec.test.ts`; Modify: `src/cli.ts`

**Interfaces:**
- Consumes: state (T4) `getLaunch`, launch store (T9), registry (T2).
- Produces: `ms _exec <launch-id>`: loads the launch row; builds the environment: everything inherited MINUS `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, PLUS `CLAUDE_CODE_OAUTH_TOKEN=<launch token>`, `MS_SESSION`, `MS_GENERATION`, `MS_SOCKET`, `MS_PANE`, `MS_ACCOUNT`, `MS_BIN`; then `process.execve(cli, [cli, ...launch.command.slice(1)], env)` where `cli` is resolved on PATH (`claude`). If the token or the row is missing: print one line to stderr (no secret) and exit 3 — the pane stays (remain-on-exit) so `ms status` can flag it.

- [ ] **Step 1: Failing test:** with a stub `claude` that prints `TOKEN=$CLAUDE_CODE_OAUTH_TOKEN MS_SESSION=$MS_SESSION ARGS=$*` and exits 0, create a launch row (`command: ["claude","--resume","c-1","hello"]`), save a token, run `_exec L1` → stdout shows the token in the env line and the args exactly, and `ps`-style argv (the stub prints `$0 $*`) contains no token; `MS_GENERATION` equals the row's generation. Missing token → exit 3, stderr mentions the account name only.
- [ ] **Step 2–4:** implement with `process.execve` (available on Node ≥ 22.15/23.11; `bin/ms` checks `typeof process.execve === "function"` and exits 1 with "Node 22.15+ required" otherwise); run.
- [ ] **Step 5: Commit** — "ms _exec: load the credential, exec the CLI in place".

---

### Task 14: `ms claude` launch (spec §7)

**Files:**
- Create: `src/launch.ts`, `test/launch.test.ts`; Modify: `src/cli.ts`

**Interfaces:**
- Consumes: registry, snapshot + pick, state, tmux, launch store.
- Produces: `ms claude [--as name] [--need any|fable] [-- <claude args>]`:
  1. `need`: `--need`, else auto (`--model` in the args containing "fable" → fable; `ANTHROPIC_MODEL`; else `~/.claude/settings.json` `model` containing "fable" → fable; else any).
  2. account: `--as` (must exist; exit 1 "no such account") else `pickAccounts(toPickInputs(await getSnapshot({maxAgeMs: 20_000})), need)`; on a snapshot failure (every account transient) use the last successful pick for this need if under 10 min (`state`-stored `lastPick`), else exit 4 "usage unreachable"; empty picks → exit 3 "no account has room" listing `out` reasons.
  3. `readLaunchToken(account)` must exist → else exit 1.
  4. Mint `id` (uuid) and `cliSessionId` (uuid); create the session row (`launching`, generation 1, cwd = `process.cwd()`, socket, pane, serverStart from `tmux.serverIdentity()`); create the launch row with `command: ["claude", "--session-id", cliSessionId, ...args]`.
  5. Inside tmux (`TMUX` and `TMUX_PANE` set): `tmux.remainOnExit(pane, true)`, `tmux.setPaneOption(pane, "@ms_session", id)`, `tmux.setPaneDiedHook(pane, [msBin, "_pane_died", id])`, then `tmux.respawn(pane, cwd, [msBin, "_exec", launchId])` — this replaces the very shell `ms` is running in; `ms` exits 0 immediately after issuing it.
  6. Outside tmux: `Tmux(socket = "<store>/tmux.sock")` (a tool-owned server); `hasSession("ms")` else `newSession("ms", cwd, [msBin, "_exec", launchId])` / else `newWindow("ms", cwd, …)`; set the same pane options and hook on the returned pane; then `attach("ms")`.
  7. Print nothing on success beyond a one-line `ms: <account> (<need>) → pane <id>` to stderr.
- [ ] **Step 1: Failing tests** with stub tmux (logs; answers `display-message` identity) and stub `claude`, a registry with two accounts, tokens saved, `fetch` stubbed for usage: inside tmux → the log shows `remain-on-exit on`, the hook, and `respawn-pane -k -c <cwd> -t %7 '<msBin>' '_exec' '<id>'`; the state has one session in `launching` with the picked account; `--as nope` exits 1; all accounts at 100 → exit 3 with the reasons; usage down and no recent pick → exit 4; outside tmux → `new-session -d … -s ms` then `attach-session -t ms`.
- [ ] **Step 2–4:** implement; run.
- [ ] **Step 5: Commit** — "ms claude: pick, record, launch in place (own pane) or on the tool's tmux server".

---

### Task 15: `ms _recover <session>` — the recovery transaction (spec §9)

**Files:**
- Create: `src/recover.ts`, `test/recover.test.ts`; Modify: `src/cli.ts`

**Interfaces:**
- Consumes: state, events, tmux, snapshot + pick, launch store, lock, `msBinary()`.
- Produces `recoverSession(id, opts: { manual?: { toAccount?: string; continueAfter: boolean }; force?: boolean }): Promise<0 | 1 | 2>` used by `_recover` and by Task 16's manual verbs. Exit codes: 0 handed off; 2 nothing has room (session `waiting`, wake-up scheduled); 1 anything else (refused, obsolete, failed — reason on stderr and in `recover.log`).
- The continuation text (exact): `Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions.`

The transaction, in order (every step logs one line to `sessions/<id>/recover.log` with the generation):

1. `withLock("session-<id>")` (5 s wait, else exit 1 "another recovery holds <id>"). Open state; read the session; `desired === "stopped"` → obsolete, exit 1.
2. Automatic mode: `rec = pendingRecovery(id)`; none → exit 1. `ownRecovery(rec.id, "<pid>@<host>")` must succeed. Obsolete if: `rec.generation !== session.generation`, or an `activity` event for that generation is newer than the last `rate_limited`, or the pane is gone (`!tmux.paneExists`) → `finishRecovery(obsolete)`, exit 1. Manual mode (`opts.manual`): no pending recovery required; refuse unless the pane's screen reads a wall (`wallKindFromText`) or the pane is idle (no `esc to interrupt` in the last 6 lines) or `force`.
3. Candidates: `getSnapshot({maxAgeMs: 20_000})` → `pickAccounts(inputs, need, [session.account, ...accounts already attempted in this recovery])`; `manual.toAccount` short-circuits to that one account (must resolve a token). Empty → schedule: `nextAttemptAt = earliest resetsAt among the out-reasons "… at 100"` (else now + 600 s); `setWakeup(id, at)`; `updateSession(state: "waiting")`; `tmux.runShell([ms, "_recover", id], { delaySeconds: at - now })`; `releaseRecovery`; exit 2 with one notification line to the log.
4. Verify the candidate's token resolves (`readLaunchToken`); if not, `addAttempt(outcome: "auth")` and go to the next candidate (bounded to the picks list).
5. `updateSession(state: "stopping")`; `tmux.setPaneOption(pane, "@ms_handoff", "<from>→<to>")`; `remainOnExit(pane, true)`.
6. Graceful exit for Claude at a prompt: `sendKeys(pane, ["Escape"])`, 300 ms, `sendKeys(pane, ["/exit", "Enter"])`; poll `paneInfo(pane)` every 250 ms up to 10 s until `dead === true` or the pane pid's process is gone. If still alive: `process.kill(pid, "SIGTERM")`, wait 3 s, `SIGKILL`, wait 1 s; record `forced: true`. Never send keys when the screen's last turn shows a modal choice (`esc to cancel` + numbered options) — go straight to the signal path in that case.
7. New generation `g+1`; new launch row `{ command: ["claude", "--resume", cliSessionId, continuationOrEmpty, ...whitelisted flags], account: candidate }` (whitelisted flags = the session's `flags`; the continuation is included when `manual` is absent or `manual.continueAfter`); `updateSession({ account, generation: g+1, state: "resuming" })`; `addAttempt(...)` for the LEFT account with outcome `exhausted` (automatic) or `ok` (manual); `tmux.respawn(pane, cwd, [ms, "_exec", launchId])`.
8. Readiness: poll `readEvents(id)` every 500 ms up to 60 s for a `resumed` (or `started`) event with `generation === g+1` and `cliSessionId === session.cliSessionId`; a `started` with a DIFFERENT cliSessionId means the resume fell back to a new conversation → outcome `resume-broken`: log the last 8 non-blank screen lines, `updateSession(state: "parked")`, exit 1. Timeout → the same. On success `updateSession(state: continuation ? "continuing" : "running")`; `finishRecovery(done)`; unset `@ms_handoff`; log `<id>: <from> → <to> (<kind> wall, generation <g+1>)`; exit 0.
9. Budget: if the recovery already has 3 attempts with outcome other than `ok`, park (`state: "parked"`, one log line "gave up after 3 attempts", `finishRecovery(done)`), exit 1. The reconciliation (Task 18) un-parks on `ms rotate --force`.

- [ ] **Step 1: Write the failing tests** (stub tmux that keeps an in-memory pane state in a temp file: `respawn-pane` appends to a log and flips `pane_dead` to 0; `send-keys` with `/exit` flips `pane_dead` to 1 after being called; `capture-pane` prints a screen file; stub `claude` unused because the test appends the `resumed` event itself right after seeing the respawn in the log — do this from a background watcher in the test using `fs.watch` on the tmux log, or simpler: pre-write the resumed event with the NEXT generation before running `_recover` and assert the worker accepts it only after respawn by checking log order). Cases: happy path (dirk → gmail, exit 0, session `continuing`, launch row has `--resume c-1 "<continuation>"`, recovery done, `@ms_handoff` set then unset); obsolete by newer activity (exit 1, recovery obsolete, no keys sent); pane gone (obsolete); nothing has room (exit 2, `waiting`, `run-shell -b -d <n> … _recover s1` in the log, recovery back to pending); resume fell back to a new session id (parked, exit 1, no continuation event); third failed attempt parks; lock held (exit 1, nothing typed); manual `toAccount` on an idle pane without continuation (launch row has no continuation text; state `running`).
- [ ] **Step 2–4:** implement; run (these tests take a few seconds because of the readiness polling — set `MS_POLL_MS=50` env to speed the loops in tests, default 500).
- [ ] **Step 5: Commit** — "Recovery transaction: own, recheck, pick, graceful exit, respawn with --resume, readiness by hook, bounded".

---

### Task 16: Manual verbs — `ms rotate`, `ms switch`, `ms stop`

**Files:**
- Create: `src/manual.ts`, `test/manual.test.ts`; Modify: `src/cli.ts`

**Interfaces:**
- `ms rotate <session|pane> [--force]` → `recoverSession(id, { manual: { continueAfter: true }, force })`; resolves `%N` to the session whose pane it is on the caller's socket.
- `ms switch <session|pane> --to <account> [--continue] [--force]` → `recoverSession(id, { manual: { toAccount, continueAfter: continue || screenIsWalled }, force })`; refuses a busy pane (`esc to interrupt` in the last 6 lines) unless `--force`.
- `ms stop <session|pane>` → `updateSession({ desired: "stopped", state: "stopped" })`, `finishRecovery(obsolete)` if pending, `setWakeup(null)`, then the graceful-exit sequence from Task 15 step 6, then `tmux.respawn(pane, cwd, [$SHELL, "-l"])` so the pane returns to a shell.
- [ ] **Step 1: Failing tests** with the Task 15 stubs: `rotate` on a walled pane hands off; `switch --to gmail` on an idle pane relaunches without a continuation; `switch` on a busy pane exits 1 unless `--force`; `stop` marks desired stopped, sends `/exit`, and respawns the login shell; `%N` resolution.
- [ ] **Step 2–4:** implement; run.
- [ ] **Step 5: Commit** — "Manual verbs: rotate, switch, stop".

---

### Task 17: `ms status`

**Files:**
- Create: `src/status.ts`, `test/status.test.ts`; Modify: `src/cli.ts`

**Interfaces:**
- `ms status [--watch] [--json]`: two tables. Accounts: `NAME LABEL 5H WEEK FABLE RESETS STATE` from `getSnapshot({maxAgeMs: 20_000})` (STATE = ok | stale | auth | transient | no-grant | no-token). Sessions: `SESSION PANE ACCOUNT NEED STATE GEN PENDING WAKEUP WALLED?` where WALLED? is `reported` when a pending recovery exists, `unreported` when the pane's screen reads a wall (`wallKindFromText`) with no pending recovery and no `rate_limited` event for the current generation (the "screen says wall, provider did not" flag — manual `ms rotate` territory), else blank. `--watch` redraws every 5 s until Ctrl-C (`clear` + reprint). `--json` prints the raw structures. Reconciliation (Task 18) runs first.
- [ ] **Step 1: Failing tests:** the tables contain the expected rows for a two-account, two-session fixture; `unreported` shows for a pane whose stub screen has a wall and no recovery; `--json` parses.
- [ ] **Step 2–4:** implement; run.
- [ ] **Step 5: Commit** — "ms status: pool and sessions, walled-unreported flag".

---

### Task 18: Reconciliation and `ms _pane_died`

**Files:**
- Create: `src/reconcile.ts`, `test/reconcile.test.ts`; Modify: `src/cli.ts` (run `reconcile()` at the start of every non-internal verb; register `_pane_died`)

**Interfaces:**
- `reconcile(): string[]` (a list of what it repaired, for `--verbose`): (a) locks whose holder pid is dead → removed; (b) recoveries `owned` for more than 10 min with a dead owner → back to `pending` and re-dispatched via `tmux.runShell`; (c) sessions whose pane no longer exists on their socket (or whose server identity changed) → `stopped`, pending recovery `obsolete`, wake-up cleared; (d) due wake-ups (`dueWakeups(now)`) → `runShell([ms, "_recover", id])` and clear the wake-up; (e) a session in `resuming`/`continuing` for more than 5 min with no `resumed` event → `parked` with a log line; (f) `launching` for more than 5 min with no `started` → `parked`.
- `ms _pane_died <session>` (the tmux `pane-died` hook): if the session's `desired` is `running` and its last event is `ended` with reason `exit`/`logout`/`clear`… (a normal end) → respawn the login shell in the pane and mark `stopped`; if there is no `ended` event for the current generation → append `died`, mark `parked` (the human decides; `ms status` shows it), leave the dead pane for inspection.
- [ ] **Step 1: Failing tests** for each of (a)–(f) and both `_pane_died` branches, with stub tmux answering `list-panes`/identity.
- [ ] **Step 2–4:** implement; run.
- [ ] **Step 5: Commit** — "Reconciliation on every invocation; pane-died handling".

---

### Task 19: `ms doctor` (minimal)

**Files:**
- Create: `src/doctor.ts`, `test/doctor.test.ts`; Modify: `src/cli.ts`

**Interfaces:**
- `ms doctor [--fix]` prints a checklist with ✓/✗: Node ≥ 22.15 with `process.execve`; tmux ≥ 3.3 (`tmux -V`); `claude --version` present; the four Claude hooks installed with the current `msBinary()` (`--fix` runs `installClaudeHooks`); store permissions 0700/0600 (`--fix` chmods); each Claude account: poll grant readable and refreshable (bounded), launch token present, identity verified; orphaned state (sessions whose pane is gone; `--fix` runs reconcile); the `ms` on PATH is the same file the hooks point at. Exit 1 if any ✗.
- [ ] **Step 1: Failing tests:** a fixture with one healthy and one grant-less account and hooks missing → the report lines and exit 1; `--fix` installs hooks and exits 0 on the healthy subset.
- [ ] **Step 2–4:** implement; run.
- [ ] **Step 5: Commit** — "ms doctor".

---

### Task 20: Live matrix (Claude) on the author's machine — gate before Plan 2

**Files:**
- Create: `docs/superpowers/plans/2026-09-15-live-matrix-claude.md` (the record)

This task is executed by the author (or a full-auto agent on the author's laptop), not in CI. Preconditions: `npm run build`, `MS_BIN=$(pwd)/bin/ms`, `ms accounts login` done for at least three of the real accounts (dirk is at a Fable wall daily; gmail and kratuvak have room), hooks installed into the live `~/.claude/settings.json` by `ms doctor --fix` (backup kept), and this laptop's anu arm paused for the duration (`tmux set -g @anu_autorotate 0`) so the two systems do not fight over the same panes.

- [ ] **Step 1: Cases** (record pane, before/after `ms status`, the `recover.log` lines, screen tail):
  1. `ms claude` in a fresh tmux pane → picked account in the statusline, `started` event, session `running`.
  2. `ms claude --as dirk --need fable -- --model fable` + one prompt → real Fable wall → `rate_limited` event with `kindDetail: fable`, a pending recovery, the worker dispatched by tmux, `dirk → <next>` in `recover.log`, the continuation answered on the new account, session back to `running`. Time the handoff.
  3. Two `ms rotate` on the same session at once → one `another recovery holds`, one proceeds.
  4. `ms switch --to kratuvak` on an idle session → no continuation, prompt back, statusline changed.
  5. `ms stop` → pane returns to a shell; session `stopped`.
  6. Quoted wall text: in a running session, paste "You've hit your usage limit for …" as a message → NO recovery, `ms status` shows nothing walled.
  7. `/clear` in a managed session → `cleared` event; a later wall resumes the NEW cli session id.
  8. Bogus resume: edit the session's `cliSessionId` in the state file to a random uuid, `ms rotate --force` → `resume-broken`, parked, last screen lines in the log, no continuation on a shell.
  9. Kill the worker mid-handoff (`kill -9` the `_recover` pid right after the respawn appears in the log) → `ms status` reconciles: the existing launch is adopted, no second copy.
  10. All accounts out (temporarily mark every other account's token file unreadable) → exit 2, `waiting`, a `run-shell -b -d` timer visible in `tmux show-hooks`/`ps`; restore → the wake-up fires and hands off.
  11. Outside tmux: `ms claude` from a plain Terminal window → the tool's tmux server, attach, rotation works there too.
  12. Mac sleep across a scheduled wake-up → after wake, the next `ms status` reconciles and dispatches.
- [ ] **Step 2: Exit criteria:** 1–8 and 11 PASS; 9, 10, 12 PASS or a documented reason. Record every failure as a bug task appended to this plan before continuing.
- [ ] **Step 3: Commit the record** — "Live matrix (Claude): results".

---

## Plan 2 (to be written after Task 20): Codex, wizard, packaging

Outline only — it gets its own plan document with full steps once gates G1/G2 have run:
- G1 spike: Codex failure contract (hooks file location and trust, real exhausted first/later turn, quoted text, transient error, modal, `codex resume <id> "<prompt>"`), recorded in `docs/superpowers/plans/2026-09-xx-codex-spike.md`.
- G2 spike: shared Codex authentication across concurrent processes.
- Codex provider (`providers/codex-usage.ts`, port of the dashboard's openai provider), `ms accounts login` for Codex, `ms codex` launch, `ms _hook codex`, Codex branch of the recovery transaction (graceful exit sequence for the Codex TUI; `codex resume <id> "<continuation>"`), status/doctor rows.
- Wizard `ms setup` (spec §10), statusline badge and alias opt-ins, hook trust for Codex.
- Homebrew tap `aadarwal/homebrew-tap` with the `model-switcher` formula (`depends_on "node"`, `depends_on "tmux"`, installs `dist/ms.js` + `bin/ms`), a `make release` script that builds and tags.
- `ms dashboard` and bounded `ms switch --all` (spec §13), after the Codex live matrix.
- Port of the Codex mechanics into anu (separate anu task).

---

## Self-review

- **Spec coverage.** §2 → T3. §3/§7 → T13, T14. §4 → T10, T14, T16, T17, T19 (`ms attach` is part of T14's outside-tmux path; `ms setup`, `ms codex` → Plan 2). §5 → T2, T4, T5, T9. §6 → T7, T9, T10 (identity by org; keychain deferred per the spec edit). §8 → T11 (Codex hooks → Plan 2). §9 → T12, T15, T16, T18 (pool coordination: snapshot lock in T8, per-session lock in T15, per-account credential lock is the same `withLock("account-<name>")` around refresh in T8; bounded simultaneous handoffs: T15 takes `withLock("handoffs")` as a counting semaphore of 4 — add that line to T15 step 5 during implementation). §10, §12 G1/G2, §13 → Plan 2. §11 → T13 (env only), T9 (0600), T11 (hooks never print). §12 S3–S5 → T20 (S3, S4 partially) and the stubbed suites (S5's harness is Plan 2's first task if T20 shows contention).
- **Placeholders.** None: every task has test code or a precise test list, and implementation code or a precise port instruction naming the source file. The "…copy from data/lib/providers/claude.ts…" constants in T7 are deliberate: the values are secrets-adjacent and must be copied from the proven source, not invented.
- **Type consistency.** `Window`/`PickInput`/`Need` (T3) used by T7/T8/T14; `SessionRow`/`LaunchRow`/`RecoveryRow` (T4) used by T11/T14/T15/T18; `Event`/`EventKind` (T5) used by T11/T15/T18; `Tmux` methods (T6) used everywhere by the names listed there; `wallKindFromText` (T11) used by T15/T17; `recoverSession` (T15) used by T16; `msBinary()` (T11 adds it to `paths.ts`) used by T11/T14/T15/T18/T19.
