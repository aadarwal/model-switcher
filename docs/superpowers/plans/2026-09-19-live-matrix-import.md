# Live matrix — `ms import`

## Laptop, 2026-09-19 16:33 (branch `import-int` at 2635f2f, run with `MS_ENTRY=src`)

Stand-ins for "conversations outside tmux": six real CLIs (3 Claude Code 2.1.278 with `--dangerously-skip-permissions`, 3 Codex 0.153.4 with `--yolo`) started as panes on a third tmux server (`tmux -L outside`) that neither the default server nor the tool's can see — to the scanner they are exactly what a Terminal.app tab is: a process with its own tty. Directories: `~/ms-import-live/repo` (git, branch `main`), its linked worktree `~/ms-import-live/repo-feature` (branch `feature`), and `~/ms-import-live/plain`. Each got one prompt so a transcript with a cwd existed. anu's arm paused for the run.

| Step | Result |
|---|---|
| `ms import --since 1h --dir ~/ms-import-live --dry-run` (from inside the default-server tmux) | 6 found, all live with pids; `server current`; manifest written; nothing touched. First run exposed two defects, fixed before the real run: a linked worktree became its own session (now `git rev-parse --git-common-dir`), and Codex titles showed the injected `# AGENTS.md instructions` preamble (now skipped). |
| Real run (`--yes`) | `moved 6, stopped 6, failed 0`, exit 0, 22 s wall-clock. Sessions `repo` (windows `main`, `feature`) and `plain` created on the default server beside the anu sessions; every original process exited (SIGTERM, none needed SIGKILL). |
| `ms status` | six rows `running`: Claude on `kratuvak`, Codex on `dirk` (accounts with room; kratuvak/tulp Codex were `no room`). |
| Resumed content | a Claude pane shows the earlier `Reply with the single word ok` / `ok` exchange and answered the continuation ("already answered, no unfinished work"); a Codex pane shows the same exchange and the continuation prompt. Same conversations, not new ones — the `--session-id`-on-resume fix holds. |
| `ms import --status <manifest>` | every row `resumed in <session>:<window>.<n>`; the manifest is 0600 under `MS_HOME/imports/`. |

Findings:
- Under `pane-base-index 1` (this machine's tmux config) the manifest's reported targets (`repo:main.0`) are off by one from what tmux shows; the executor addressed panes by id (`%58`…) and placed them correctly. Fix: record the pane id and tmux's own index in the outcome.
- The Claude native binary shows its version as `pane_current_command`; `ps` reports `claude`, which is what the scanner reads, so detection is unaffected.

Verdict: PASS on the laptop. Mini 1 is checked on the released 0.3.0 (see below).

## Mini 1 and the laptop again, on the released 0.3.0 / 0.3.1

**Mini 1, 0.3.0, from a plain ssh shell (no tmux around it).** Three Claude stand-ins: `moved 3, stopped 3, failed 0`, onto the tool's own server (`ms attach` hinted), `running` under `tulp`. Three Codex stand-ins: the mini's default `~/.codex` had no login (the API-key dialog), so no conversation existed and the scanner correctly skipped them. Re-run under the mini's `ms`-managed Codex home (its only login): the conversations were found and planned — and the resume failed: the pane's `ms adopt <id>` ran without `CODEX_HOME` and searched `~/.codex/sessions`; every row waited the full 60 s. The npm-installed Codex also showed a second `live, no conversation found` row per session (its native child process). All three became 0.3.1.

**0.3.1 checks.** Laptop: two Codex stand-ins under a managed home with room → `moved 2, stopped 2, failed 0`, both `running` under `dirk`, resumed by rollout path. Mini 1 (npm Codex): the scan now yields one row per conversation. Finding: a Codex session resumed after a limit may show Codex's own "rate limit reminder" modal (keep current model / switch); the continuation waits behind it until a key is pressed — Codex UI, not `ms`. Finding: the mini's stand-ins under the walled `tulp` home could not be moved there because `tulp` is that machine's only Codex login — an import needs a destination with room, as any rotation does.

Verdict: PASS on both machines for what each could exercise; the npm-Codex dedupe and descendant kill are proven by tests, not yet by a live move.
