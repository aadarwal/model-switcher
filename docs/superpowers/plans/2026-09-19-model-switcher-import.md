# `ms import` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ms import` finds Claude Code and Codex conversations that run outside tmux (or ran recently), stops the live ones after one confirmation, and resumes each in a tmux pane under an account with room — one session per repo root, one window per worktree, four panes per window — with a manifest written before and during the move; plus the matching wizard step.

**Architecture:** three pure-ish modules under `src/import/` (scan → plan → execute) behind one verb `src/import.ts`; the executor reuses `launchCodex`/`adopt` and `ms claude -- --resume`; the manifest is the seam (`--dry-run` writes it, `--plan` runs it).

**Tech Stack:** TypeScript ESM, Node ≥ 22.15, zero runtime deps, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-19-import-design.md` (binding).

## Global Constraints

- macOS only; zero runtime dependencies; every subprocess bounded (`ps`, `lsof`, `git`, `tmux`, `kill` all with timeouts).
- The scanner is read-only everywhere; it never reads more of a transcript than its header and first user line; it never touches `~/.codex`/`~/.claude` beyond reading.
- No secret on argv, in a tmux command, log line, manifest, stdout/stderr or error message (argv kept in the manifest is the CLI's own flags only; strip any `--api-key`-like value: keep the whitelist, drop everything else).
- Tests hermetic: temp `HOME`, `MS_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`; stub `tmux`, `ps`, `lsof`, `git` on PATH or injected; a sleeping script stands in for a live CLI; never the real stores or tmux server. `env -u CLAUDE_CONFIG_DIR -u MS_HOME -u CODEX_HOME -u MS_BIN MS_ENTRY=src npm test`; `npm run typecheck`; `npm run build`.
- Commits carry the three co-author trailers.

## File structure

| File | Responsibility |
|---|---|
| `src/import/scan.ts` | `scanConversations(opts) → Candidate[]`: Claude + Codex transcripts, process table, tmux detection, `ms`-managed filter |
| `src/import/plan.ts` | `planImport(candidates, opts) → Plan`: grouping, naming, four-per-window, commands, target server |
| `src/import/manifest.ts` | `writeManifest`, `readManifest`, `formatManifest` (the table) |
| `src/import/execute.ts` | `executeImport(plan, deps) → Summary`: stop, create panes, run, wait for the hook, record |
| `src/import.ts` | the verb: flags, confirmation, `--dry-run`/`--plan`/`--status`, exit codes |
| `src/setup/steps.ts` | the wizard step (prompter-driven) calling the same modules |
| `test/import-scan.test.ts`, `test/import-plan.test.ts`, `test/import-execute.test.ts`, `test/import-verb.test.ts`, `test/setup-import.test.ts` | tests |

---

### Task 1: Scanner

**Files:** Create `src/import/scan.ts`, `test/import-scan.test.ts`.

**Interfaces — Produces:**
```ts
export interface Candidate {
  provider: "claude" | "codex"; id: string; cwd: string; transcriptPath: string;
  lastActivity: number /* epoch ms */; title: string; compacted: boolean;
  pid: number | null; argv: string[] | null; startedAt: number | null;
  inTmux: boolean; managed: boolean;
}
export interface ScanOptions {
  claudeConfigDir: string; codexHome: string; sinceMs: number | null /* null = all */;
  dirs: string[] /* [] = everything */;
  ps: () => ProcessRow[];              // injected; default runs `ps -axo pid,lstart,tty,command`
  cwdOf: (pid: number) => string | null; // injected; default runs `lsof -a -p <pid> -d cwd -Fn`
  tmuxTtys: () => Set<string>;         // injected; default queries the default server and MS_HOME's socket
  managedIds: () => Set<string>;       // injected; default reads the store's live sessions
}
export function scanConversations(opts: ScanOptions): Candidate[];
```
Rules: Claude transcripts under `<claudeConfigDir>/projects/*/*.jsonl` (cwd from the first record's `cwd` field, else unescape the directory name: `-Users-x-y` → `/Users/x/y`; the escaping replaces `/` and `.` with `-`, so prefer the record); Codex rollouts under `<codexHome>/sessions/**/rollout-*.jsonl` (`session_meta` line: `id`, `cwd`, `history_base` ⇒ `compacted`). `title` = first `user` message's first line, ≤ 80 chars, control characters stripped. A process matches the newest conversation in its cwd with `lastActivity ≥ startedAt`; unmatched processes are returned with `id: ""` and skipped by the planner (listed in the table as `live, no conversation found`). `inTmux` when the process tty is in `tmuxTtys()`. Live processes bypass `sinceMs`. `dirs` filters by prefix on the real path.

- [ ] Failing tests: fixture trees for both providers (three Claude files across two dirs, two Codex rollouts, one compacted); title extraction; the escaped-name fallback; a fake `ps` with two live processes (one matches, one has no conversation), one of them in tmux; `sinceMs` filtering with live bypass; `dirs` prefix; `managed` flag.
- [ ] Implement; typecheck; commit `import: the scanner`.

### Task 2: Planner

**Files:** Create `src/import/plan.ts`, `test/import-plan.test.ts`.

**Interfaces — Consumes:** `Candidate`. **Produces:**
```ts
export interface PaneSpec { candidate: Candidate; command: string[]; session: string; window: string; index: number /* 0-3 */; }
export interface Plan { server: "current" | "ms"; socket: string | null; sessions: { name: string; root: string; windows: { name: string; worktree: string; panes: PaneSpec[] }[] }[]; skipped: { candidate: Candidate; reason: string }[]; }
export interface PlanOptions { as: string | null; git: (args: string[], cwd: string) => string | null /* injected */; existingSessions: Set<string>; tmuxEnv: string | undefined; msSocket: string; }
export function planImport(candidates: Candidate[], opts: PlanOptions): Plan;
export const KEPT_FLAGS: { claude: string[]; codex: string[] };
```
Rules from the spec: root = `git rev-parse --show-toplevel` (else the cwd); worktree = the `git worktree list --porcelain` entry whose path is a prefix of the cwd; session name = basename(root), collision → `name (parentBasename)`; existing session names reused; window = branch of the worktree, else basename; four panes per window, overflow `name:2`; order by `lastActivity` desc; command per provider as in the spec, with `--as` when given and only `KEPT_FLAGS` from argv; `server: "current"` iff `tmuxEnv` is set (socket parsed from it), else `"ms"` with `msSocket`. Skipped: `inTmux`, `managed`, `id === ""`.

- [ ] Failing tests: grouping across two roots with a worktree; window naming; overflow at five and nine; collision naming; session reuse; flag whitelist keeps `--yolo`/`--model x`, drops `--api-key x`; server rule; skipped reasons.
- [ ] Implement; typecheck; commit `import: the planner`.

### Task 3: Executor, manifest, verb

**Files:** Create `src/import/manifest.ts`, `src/import/execute.ts`, `src/import.ts`; modify `src/cli.ts` (register `import`, USAGE), `README.md`, `CHANGELOG.md` (`## Unreleased`); tests `test/import-execute.test.ts`, `test/import-verb.test.ts`.

**Interfaces — Consumes:** `Plan`, `Candidate`. **Produces:**
```ts
export interface ManifestRow { /* candidate fields + target + outcome: string */ }
export interface Manifest { createdAt: string; server: string; since: string; dirs: string[]; rows: ManifestRow[]; }
export function writeManifest(path: string, m: Manifest): void;   // 0600, atomic
export function readManifest(path: string): Manifest;
export function formatManifest(m: Manifest): string;             // the table
export interface ExecuteDeps { tmux: Tmux /* the repo's tmux wrapper on the plan's socket */; kill: (pid: number, sig: NodeJS.Signals) => boolean; alive: (pid: number) => boolean; now: () => number; sleep: (ms: number) => Promise<void>; waitReady: (candidateId: string, deadlineMs: number) => Promise<"ready" | "timeout" | "died">; log: (line: string) => void; }
export function executeImport(plan: Plan, manifestPath: string, deps: ExecuteDeps): Promise<{ moved: number; stopped: number; failed: number }>;
```
Verb: `ms import [--since <w>] [--dir <p>]… [--as <a>] [--dry-run] [--yes] [--include-tmux]`, `ms import --plan <file>`, `ms import --status <file>`. `--since` parser (`30m`, `2h`, `1d`, `all`; default `2h`). The confirmation reads one line from stdin (`y`/`yes`); non-TTY stdin without `--yes` refuses with exit 2. Exit 0 all moved, 1 any failed, 2 usage. Manifest path printed once. Execution order and messages exactly as the spec's Executor section; `waitReady` polls the store for the candidate's `ms` row reaching `running`/`continuing`.

- [ ] Failing tests: executor — a plan with one live row (a sleeping script as the process: `SIGTERM` handled → exit; a second variant ignoring `SIGTERM` → killed after the bound), one idle row; stub tmux records `new-session`/`new-window`/`split-window`/`select-layout`/`send-keys` in order; a `waitReady` stub returning `ready`/`timeout`; the manifest has an outcome per row after each step (read it mid-run via the injected `log`); a failing row does not stop the next; summary counts. Verb — `--dry-run` writes the manifest and touches nothing (stub tmux log empty); `--plan` executes; `--status` prints; `--since` parsing; non-TTY refusal; exit codes.
- [ ] Implement; typecheck; build (dist guard); commit `ms import: stop, move, resume — with a manifest`.

### Task 4: Wizard step

**Files:** Modify `src/setup/steps.ts` (+ `src/setup/state.ts` for the manifest path), `test/setup-import.test.ts`.

Step `import`, after `hooks` and before the opt-ins: `Move conversations that run outside tmux into it? [y/N]` → scan → numbered directory multi-select with counts (`1) <dir> — N (M live)`; input `1,3` or `all`) → window (`1) 1h 2) 2h 3) 6h 4) 24h`, default 2h) → plan table → `Proceed? [y/N]` → `executeImport` → the manifest path recorded in `setup.json` and printed. Skippable; resumable; `--yes` answers N (nothing moves without an explicit yes).

- [ ] Failing tests via `scriptedPrompter`: a scan with two dirs, choose one, choose 1h, proceed → executor called with the right plan (inject the executor); decline → nothing; `--yes` → skipped.
- [ ] Implement; typecheck; commit `ms setup: an import step`.

### Task 5: Live verification (author's Mac, then mini 1)

Stand-in terminals: start real CLIs outside tmux with a pty each, e.g. `script -q /dev/null claude --resume <existing id>` / `script -q /dev/null codex resume <id>` in background jobs from a plain shell (NOT inside tmux — use a `nohup … &` from a `bash -lc` started by `ssh localhost`, or run them from a Terminal.app window via `osascript`), in two directories (one repo with a worktree, one plain dir), 3 Claude + 3 Codex; then from inside tmux `ms import --since 1h --dir A --dir B --dry-run` (table + manifest), then the real run: originals stopped, sessions `A`/`B` created beside the anu ones, windows per worktree, four panes then a second window, every pane resumed and `ms status` running under an account with room, the manifest complete; `ms import --status`. Repeat on mini 1 with 2 + 2 from outside tmux (its tool server: `ms attach`). Record `docs/superpowers/plans/2026-09-19-live-matrix-import.md`; anu's arm paused during the run and restored.

### Task 6: Release 0.3.0

CHANGELOG `## 0.3.0` (import verb, wizard step), README, version bump, release, tap, upgrade both Macs.

## Self-review
Spec coverage: Verb → T3; Discovery → T1; Planner → T2; Executor + Manifest → T3; Wizard → T4; Tests → each task; live → T5. Types: `Candidate` (T1) consumed by T2/T3; `Plan`/`PaneSpec` (T2) by T3/T4; `executeImport` (T3) by T4. No placeholders.
