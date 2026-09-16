# model-switcher Plan 3 — `ms setup` wizard and packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone with a Mac can `brew install aadarwal/tap/model-switcher`, run `ms setup`, answer "how many Claude accounts, how many ChatGPT accounts", click through the browser logins, choose the optional statusline badge and shell alias, and end with `ms doctor` green — the engine (Plans 1–2) wrapped so that no step in this repository's own live matrices ever has to be typed by hand again.

**Architecture:** The wizard is a resumable state machine over the verbs that already exist (`ms accounts add/login/verify`, `ms doctor --fix`, `ms status`): it never re-implements a step, it sequences them, records progress in `MS_HOME/setup.json`, and can be re-run to continue or repair. Packaging is the esbuild bundle already produced by `scripts/build.mjs`, shipped as a GitHub release tarball that a Homebrew formula in `aadarwal/homebrew-tap` installs with `depends_on "node"` and `depends_on "tmux"`; `bin/ms` on PATH makes `ms doctor`'s last check pass. The S6 gate (hook trust, custom homes, CLI upgrades, repair paths) runs on a fresh macOS user account.

**Tech Stack:** TypeScript ESM, Node ≥22.15, zero runtime deps, esbuild bundle, Homebrew formula (Ruby), GitHub releases via `gh`.

**Spec:** `docs/superpowers/specs/2026-09-15-model-switcher-design.md` §10 (wizard and install), §11 (security), §12 S6. Live facts: `docs/superpowers/plans/2026-09-15-live-matrix-claude.md` and `2026-09-16-codex-spike.md`.

## Global Constraints

- macOS only; Node `>=22.15`; zero runtime dependencies; tmux ≥ 3.3; Claude Code `2.1.27x`; Codex `0.153.x`.
- No secret ever on argv, in a tmux command, tmux environment, log line, pane, stdout/stderr (only `ms accounts token` prints) or error message; the wizard prints device codes and login URLs (never tokens).
- Store 0600/0700; every subprocess bounded; the wizard is resumable and idempotent (running it twice changes nothing the second time); it edits `~/.claude/settings.json`, the user's shell rc file and the statusline command ONLY with a backup and only after a yes; opt-ins default to no.
- Tests hermetic (temp HOME/MS_HOME, stubbed `claude`/`codex`/`tmux`/`security`/`brew`/`gh`, stubbed prompts via an injected reader, stubbed fetch); the wizard's interactive prompts read from an injectable `ask()` so tests script answers.
- Commits: `git -c commit.gpgsign=false commit`, subject, blank line, the three co-author trailers (Claude, Codex, Homi). Every task ends green on `MS_ENTRY=src npm test` and `npm run typecheck`.
- The tap repo `aadarwal/homebrew-tap` is created by the tool's author (consent given 2026-09-16) with `gh repo create --public`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/setup/state.ts` | `SetupState` (`MS_HOME/setup.json`, 0600): steps done, accounts declared, opt-ins chosen; load/save/advance |
| `src/setup/prompt.ts` | `ask(question, {default, choices})` over readline with an injectable reader; `confirm()`; `pick()` |
| `src/setup/steps.ts` | One function per step: prerequisites, accounts (claude), accounts (codex), hooks, statusline, alias, finish |
| `src/setup/statusline.ts` | Merge the badge into the existing statusline command in `~/.claude/settings.json` with a backup; remove on request |
| `src/setup/alias.ts` | Append/remove the marked alias block in the rc file (`~/.zshrc` / `~/.bashrc` by `$SHELL`) with a backup |
| `src/setup.ts` | `ms setup [--resume] [--reset] [--yes]` verb: runs steps in order from the saved state |
| `scripts/release.mjs` | `npm run release -- vX.Y.Z`: build, tarball (`dist/ms.js`, `bin/ms`, `bin/resolve-entry.mjs`, `package.json`, `LICENSE`, `README.md`), sha256, `gh release create`, prints the formula stanza |
| `packaging/model-switcher.rb` | The formula source of truth (copied into the tap by the release script) |
| `docs/superpowers/plans/2026-09-16-s6-gate.md` | The S6 record (fresh-user install, upgrade, repair) |

---

### Task 1: Setup state and prompts

**Files:**
- Create: `src/setup/state.ts`, `src/setup/prompt.ts`, `test/setup-state.test.ts`, `test/setup-prompt.test.ts`

**Interfaces:**
- Produces: `type SetupStep = "prereqs" | "claude-accounts" | "codex-accounts" | "hooks" | "statusline" | "alias" | "finish"`; `SetupState = { version: 1; done: SetupStep[]; claude: string[]; codex: string[]; optIns: { statusline: boolean; alias: boolean }; startedAt: string; updatedAt: string }`; `loadSetup(): SetupState` (fresh state when absent; 0600 on save), `saveSetup(s)`, `markDone(s, step)`, `resetSetup()`; `Prompter = { ask(q: string, opts?: { default?: string; choices?: string[] }): Promise<string>; confirm(q: string, def: boolean): Promise<boolean> }`, `readlinePrompter(): Prompter` (stdin/stdout, bounded by nothing — it is the human), `scriptedPrompter(answers: string[]): Prompter` (tests; throws when answers run out, so a wizard that asks one question too many fails the test).

- [ ] **Step 1: Failing tests.** `loadSetup()` on an empty MS_HOME returns the fresh shape and does not write; `saveSetup` writes 0600 and `loadSetup` round-trips; `markDone` is idempotent; a corrupt `setup.json` is renamed aside (`setup.json.corrupt-<ts>`) and a fresh state returned with a warning line; `scriptedPrompter(["2"]).ask("How many?")` returns `"2"`; `ask` with `choices` re-asks on an answer outside the choices (scripted `["x","1"]` → `"1"`); `confirm` maps `y/yes/n/no/""` (default) and re-asks otherwise.
- [ ] **Step 2: Run, expect module-not-found.**
- [ ] **Step 3: Implement** as specified (`node:readline/promises` for the real prompter; no deps).
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `Setup: resumable state and an injectable prompter`.

---

### Task 2: The wizard's steps

**Files:**
- Create: `src/setup/steps.ts`, `src/setup.ts`, `test/setup.test.ts`; Modify: `src/cli.ts` (`registerVerb("setup", setupVerb)`, USAGE)

**Interfaces:**
- Consumes: Task 1; `runDoctor`/`checkNode`/`checkTmux`/`checkClaudeBinary`/the Codex version check (`src/doctor.ts`); `accountsVerb` internals — call the exported command functions directly (`cmdAdd`/`cmdLogin`/`cmdVerify` for Claude, `addCodex`/`loginCodex`/`verifyCodex` for Codex — export them from `src/accounts.ts`/`src/accounts-codex.ts` if they are not yet exported); `installClaudeHooks`/`installCodexHooks`; `status` (`src/status.ts`).
- Produces: `runSetup(prompter, opts: { resume: boolean; reset: boolean; yes: boolean }): Promise<number>` and the verb `ms setup`.

Step semantics (spec §10):
1. **prereqs** — print the doctor's first three lines (Node, tmux, `claude`), plus the Codex version line; any ✗ stops with exit 1 and the remedy (a missing `codex` is allowed when the human declares zero ChatGPT accounts — ask that question first).
2. **claude-accounts** — `How many Claude accounts? [1]`; per account `Name for account N [claude-N]:` (validated against `NAME_PATTERN`, unique), then `ms accounts add <name>` and `ms accounts login <name>` (the browser flows; the wizard prints one line before each: `Sign in as the SAME account in both browser tabs.`), then `verify`; a failed login offers `Retry / Skip / Abort`; a duplicate organisation is refused by `login` itself and reported. State records the names as they succeed so a resume skips them.
3. **codex-accounts** — the same with `--provider codex` (`codex login` device-auth when stdin is not a TTY; the wizard passes `--device-auth` through when the human asks).
4. **hooks** — `ms doctor --fix` for the Claude hooks (backup kept) and `installCodexHooks` for every declared Codex home; then a throwaway verification: launch `claude -p "Reply ok" --model haiku` under the FIRST Claude account's token in a scratch `CLAUDE_CONFIG_DIR` with `MS_SESSION`/`MS_PANE`/`MS_LAUNCH` set to a probe session row, and assert a `started` event lands in that session's events (delete the probe row after); for Codex, `codex exec --skip-git-repo-check "Reply ok"` under the first Codex home the same way. Print `hooks verified (claude, codex)`.
5. **statusline** — `Show the account name in Claude Code's statusline? [y/N]`; on yes call `installStatusline()` (Task 3).
6. **alias** — `Add shell aliases so plain \`claude\`/\`codex\` go through ms? [y/N]`; on yes `installAlias()` (Task 3).
7. **finish** — run `runDoctor(false)` and `status()`; exit 0 only if doctor is green.

`--resume` continues from the first step not in `done` (default when a `setup.json` exists); `--reset` deletes the state (never the accounts); `--yes` accepts every default (for the S6 script).

- [ ] **Step 1: Failing tests** with `scriptedPrompter`, stub `claude`/`codex`/`tmux`/`security` on PATH (reuse the accounts tests' stubs: a stub `claude` whose `auth login` writes a keychain item via the stub `security`, `setup-token` prints a token line, `auth status --json` returns `{orgId,email}`; a stub `codex` whose `login` writes an `auth.json`), stubbed fetch: a full run with 1 Claude + 1 Codex account and both opt-ins declined ends with `done` = all seven steps and exit 0; a run interrupted after `claude-accounts` (scripted prompter runs out) leaves that step done and `--resume` continues at `codex-accounts` without re-asking the account count; `--reset` clears the state; a failed login with the answer `Skip` marks the account unverified and continues; zero ChatGPT accounts skips the Codex steps and tolerates a missing `codex`; the hooks step verifies via a `started` event; nothing token-shaped in the transcript of stdout/stderr (assert on the fixture token string).
- [ ] **Step 2: Run, expect unknown verb.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `ms setup: the resumable wizard over the account, hook and doctor verbs`.

---

### Task 3: Statusline badge and shell alias opt-ins

**Files:**
- Create: `src/setup/statusline.ts`, `src/setup/alias.ts`, `test/setup-optins.test.ts`

**Interfaces:**
- Produces: `installStatusline(settingsPath, msBin) → { changed, backup }` and `removeStatusline(settingsPath)`: reads `~/.claude/settings.json` (a plain file whose other keys are preserved; refuse an unparseable file), and sets `statusLine.command` to a wrapper `"<msBin> _statusline -- <original command>"` when a command exists, or to `"<msBin> _statusline"` when none; `ms _statusline [-- <cmd…>]` (registered) prints `[<account>] ` (from `MS_ACCOUNT` in the pane's env, else nothing) followed by the original command's output when one is given (spawned bounded 3 s, stdin passed through, exit 0 always — a statusline must never break Claude Code); `installAlias(rcPath, msBin) → { changed, backup }` and `removeAlias(rcPath)`: append a block between `# ms-alias-begin` / `# ms-alias-end` containing `alias claude='<msBin> claude'` and `alias codex='<msBin> codex'`, idempotent, backup on change; `rcPathFor(shell)`: `zsh` → `~/.zshrc`, `bash` → `~/.bash_profile` if present else `~/.bashrc`, else refuse with a message.
- [ ] **Step 1: Failing tests:** install/remove round-trips on a settings file with other keys and with/without an existing statusline command; the wrapper prints the badge before the wrapped output and exits 0 when the wrapped command fails or hangs (stub a sleeping command, 3 s bound); alias block idempotent, backup made, removal leaves the rest of the file byte-identical; `rcPathFor` for zsh/bash/fish (refused).
- [ ] **Step 2–4:** red → implement → green; typecheck.
- [ ] **Step 5: Commit** — `Setup opt-ins: statusline badge and shell aliases, both reversible`.

---

### Task 4: Release script and formula

**Files:**
- Create: `scripts/release.mjs`, `packaging/model-switcher.rb`, `test/release.test.ts`; Modify: `package.json` (`"release": "node scripts/release.mjs"`, `"files"`), `README.md` (install section)

**Interfaces:**
- Produces: `npm run release -- vX.Y.Z` which: refuses a dirty tree or a version not matching `package.json`; runs `npm run build`; creates `model-switcher-vX.Y.Z.tar.gz` containing `dist/ms.js`, `bin/ms`, `bin/resolve-entry.mjs`, `package.json`, `LICENSE`, `README.md` (paths under `model-switcher-vX.Y.Z/`); prints its sha256; with `--publish` runs `gh release create vX.Y.Z <tarball> --title … --notes-file <generated notes>` and then writes the formula into a local checkout of the tap (`--tap <path>`, default `../homebrew-tap`) with `url`/`sha256`/`version` substituted, commits it there with the three trailers, and prints the `git push` command (it never pushes by itself). The formula: `class ModelSwitcher < Formula`, `desc`, `homepage`, `url` (the release tarball), `sha256`, `license`, `depends_on "node"`, `depends_on "tmux"`, `def install` copying `dist`, `bin/resolve-entry.mjs` and `package.json` into `libexec` and writing `bin/ms` as `bin.install` of a shim that `exec`s `node "#{libexec}/dist/ms.js" "$@"` with `MS_ENTRY=dist`, and a `test do` that runs `ms --version`.
- [ ] **Step 1: Failing tests:** the tarball contents and layout (run the script with `--dry-run` against a temp copy of the repo; assert the file list and that no `src/`, `test/`, `.superpowers/` or `node_modules` entries exist); the formula render substitutes the three fields; a dirty tree is refused; a version mismatch is refused.
- [ ] **Step 2–4:** red → implement → green; typecheck.
- [ ] **Step 5: Commit** — `Release: tarball + formula rendering, publish through gh`.

---

### Task 5: The tap and the first release (live, author's machine)

**Files:**
- Create (in the tap repo): `Formula/model-switcher.rb`, `README.md`

- [ ] **Step 1:** `gh repo create aadarwal/homebrew-tap --public --description "Homebrew tap for model-switcher" --clone` into `~/src/aadarwal/homebrew-tap` (consent given).
- [ ] **Step 2:** in the engine repo on `main` (after Plan 2's PR lands): bump `package.json` to `0.2.0`, commit, `npm run release -- v0.2.0 --publish --tap ~/src/aadarwal/homebrew-tap`, push the tap.
- [ ] **Step 3:** on THIS Mac: `brew tap aadarwal/tap && brew install model-switcher`; `which ms` → the brew shim; `ms --version`; `ms doctor` → the PATH check passes (the shim resolves to `msBinary()`); `ms status` reads the existing store. Record in `docs/superpowers/plans/2026-09-16-s6-gate.md`.
- [ ] **Step 4:** commit the record.

---

### Task 6: S6 gate — fresh user, upgrade, repair (live)

**Files:**
- Modify: `docs/superpowers/plans/2026-09-16-s6-gate.md`

- [ ] **Cases** (on a fresh macOS user account on this Mac, or a clean `HOME` under a temp dir with `brew --prefix` shared): (1) `brew install` then `ms setup --yes`-driven run with one Claude and one Codex account (the human clicks the browser tabs); (2) `ms doctor` green; (3) `ms claude` and `ms codex` each launch and rotate once (manual `ms rotate`); (4) hook trust for Codex survives a `codex` restart and a `config.toml` edit by the human (the hash recomputes only for our block); (5) a custom `MS_HOME`; (6) upgrade: bump to `0.2.1`, release, `brew upgrade model-switcher` → hooks still point at the brew shim (`ms doctor` clean), no re-login; (7) repair: delete `~/.claude/settings.json`'s ms entries and the Codex hook block, run `ms setup --resume` → re-installed; remove the statusline and alias with the wizard's removal path. Exit criteria: 1–3, 6, 7 PASS; 4, 5 PASS or documented.
- [ ] Commit the record — `S6 gate: results`.

---

## Self-review

- **Spec coverage.** §10 prerequisites → T2 step 1; accounts (Claude, Codex, duplicate-org refusal) → T2 steps 2–3 (refusal lives in `login`); hooks + Codex trust + a `started` verification → T2 step 4 (trust computed by Plan 2's installer); statusline/alias opt-ins off by default with backups → T3; finish with doctor/status → T2 step 7; brew formula with `node`/`tmux` deps and `ms setup` resumable → T4/T5, T1; §12 S6 → T6.
- **Placeholders.** Every code task has test lists with concrete inputs and an implementation description naming the functions and files; the two live tasks are procedures with exact commands.
- **Type consistency.** `SetupState`/`Prompter` (T1) used by T2; `installStatusline`/`installAlias` (T3) called by T2 steps 5–6 (T2 may stub them if T3 lands later: define the two names in T2 as imports and let T3 own the files); `installCodexHooks`/`installClaudeHooks`/`runDoctor`/`status` from Plans 1–2; `_statusline` verb registered in T3.
