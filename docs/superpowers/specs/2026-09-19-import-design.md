# `ms import` — bring conversations that run outside tmux under `ms`

Status: approved 2026-09-19 (brainstormed with the author). Ships in 0.3.0.

## Problem

People run dozens of Claude Code and Codex conversations in plain terminal tabs. None of them can rotate on a usage wall (no tmux pane to respawn, no `ms` hooks), and none is visible to `ms status` or the dashboard. A running process cannot be moved into tmux on macOS, but both CLIs keep every conversation on disk keyed by working directory, so a conversation can be found, its original stopped, and the same conversation resumed in a tmux pane under an account with room.

## Verb

```
ms import [--since <window>] [--dir <path>]… [--as <account>] [--dry-run]
ms import --plan <manifest>
ms import --status <manifest>
```

- `--since` (default `2h`; forms `30m`, `2h`, `1d`, `all`) filters idle conversations by last activity. Live processes are always candidates.
- `--dir` (repeatable; default: every directory the scan finds) restricts to conversations whose working directory is under the path.
- `--dry-run` scans, plans, prints the table, writes the manifest, exits 0 without touching anything.
- Without `--dry-run`: the same, then ONE confirmation (`Move N conversations, stopping M live processes? [y/N]`), then execution.
- `--plan <file>` executes a manifest written earlier (no scan, no prompt — the confirmation happened when the human chose to run it).
- `--status <file>` prints a manifest's table with outcomes.
- `--yes` skips the confirmation (for the wizard, which confirmed already).

## Discovery

- Claude: `<claudeConfigDir>/projects/<escaped-cwd>/<sessionId>.jsonl` (default `~/.claude`, honouring `CLAUDE_CONFIG_DIR`). Fields: `sessionId` (filename), `cwd` (from the file's first record, falling back to the unescaped directory name), `lastActivity` (file mtime), `title` (first user message, first line, 80 chars), `provider: "claude"`.
- Codex: `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` (default `~/.codex`, honouring `CODEX_HOME`). Fields from the `session_meta` line: `id`, `cwd`; `lastActivity` = mtime; `title` = first `user` message; `provider: "codex"`; `compacted` when `history_base` is present.
- Process table: `ps -axo pid,lstart,tty,command` filtered to `claude`/`codex` executables (argv[0] basename, or a `node …/claude` wrapper); cwd via `lsof -a -p <pid> -d cwd -Fn`. A process is matched to the newest conversation in its cwd whose file was modified after the process started; an unmatched process is listed as `live, no conversation found` and skipped.
- Already in tmux: a process whose tty equals a `pane_tty` on the default tmux server or the tool's server is marked `in tmux` and skipped unless `--include-tmux`.
- Already managed: a conversation whose id is a live `ms` session is skipped.

Everything the scanner reads is read-only. It never opens a transcript beyond the bytes needed for the header and the first user line.

## Planner (pure)

Input: candidates (provider, id, cwd, lastActivity, title, live pid or null, argv or null). Output: a plan.

- Group by repo root (`git -C <cwd> rev-parse --show-toplevel`; a non-repo directory is its own root). Session name = basename of the root; a collision appends the parent's basename (`data`, `data (aadarwal)`); an existing tmux session of that name is reused, windows appended.
- Within a root, group by worktree (`git worktree list --porcelain` of the root; a cwd under a worktree path belongs to it). Window name = the worktree's branch (`main`, `codex-rotation`), else the directory's basename.
- Four panes per window, `tiled`. Conversations ordered by `lastActivity` descending; the fifth opens `<window>:2`, and so on.
- Each pane's command: Claude `ms claude [--as X] -- <kept flags> --resume <id>`; Codex `ms adopt <id> [--as X] --continue -- <kept flags>` (the adopt path copies the rollout and its lineage). Kept flags are the launch whitelist already used by rotation (`--model`, `--yolo`, `--sandbox`, `--ask-for-approval`, `--full-auto`, `--dangerously-*`, `--profile`; Claude: `--model`, `--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`), taken from the live process's argv when there is one.
- Target server: the server of the `$TMUX` the command runs in; otherwise the tool's own (`MS_HOME/tmux.sock`, printed as `ms attach`).

## Executor

For each row, in plan order:
1. If the row has a live pid: send `SIGTERM`; wait up to 10 s for exit; then `SIGKILL`; wait 2 s. Both CLIs write their transcript continuously, so the conversation on disk is complete at this point. Record `stopped` (or `stop failed: <reason>` and skip the row).
2. Create the session/window/pane as planned (`tmux new-session -d`, `new-window`, `split-window`, `select-layout tiled`), with the pane's cwd set to the conversation's cwd.
3. Run the pane's command via `send-keys` of the command line only (the resume id and flags are argv of `ms`, never a prompt typed into a CLI); wait for the `ms` row to reach `running`/`continuing` (the hook), bounded at 60 s; record `resumed in <session>:<window>.<pane>` or `resume failed: <reason>`.
4. Write the manifest after every row.

A failure never stops the run. The summary prints `moved N, stopped M, failed K` and the manifest path; exit 1 if any row failed.

## Manifest

`MS_HOME/imports/<ISO timestamp>.json` (0600):
```json
{ "createdAt": "...", "server": "default|ms", "since": "2h", "dirs": ["..."],
  "rows": [{ "provider": "codex", "id": "...", "cwd": "...", "root": "...", "worktree": "...",
             "lastActivity": "...", "title": "...", "pid": 1234, "argv": ["codex","--yolo"],
             "target": { "session": "data", "window": "main", "pane": 2 },
             "outcome": "planned|stopped|resumed in data:main.2|stop failed: …|resume failed: …" }] }
```
The manifest is the rollback record: the conversations still exist on disk whatever happened, and each row says where to resume it by hand.

## Wizard step

After the accounts and hooks steps: `Move conversations that run outside tmux into it? [y/N]`. On yes: the scan; a numbered multi-select of directories with counts (`1) ~/src/aadarwal/data — 6 (2 live)`); the window (`1h/2h/6h/24h`); the plan table; `Proceed? [y/N]`; then the executor with `--yes`. The step is resumable like the others and records the manifest path in `setup.json`.

## Not in this spec

The dashboard's workspace view (sessions → windows → panes with their conversations) and bringing anu's own tmux panes under `ms` (`--include-tmux` semantics beyond listing) are follow-ups.

## Tests

Scanner over fixture trees (both providers, escaped cwd names, a compacted rollout) and a fake process table + fake `lsof`; planner unit tests (grouping, worktree windows, four-per-window overflow, name collisions, session reuse, flag whitelist); executor against the stub tmux and a sleeping script as the "CLI" (stopped on SIGTERM, killed after the bound, resume reported from a stub hook), failure isolation, manifest written after every row; `--dry-run`/`--plan`/`--status` round-trip; the wizard step scripted through the prompter. Hermetic: temp HOME/MS_HOME/CLAUDE_CONFIG_DIR/CODEX_HOME, never the real stores.
