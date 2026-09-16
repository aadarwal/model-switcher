# Live matrix (Codex) — 2026-09-16, author's laptop

Engine: `codex` branch @ de6d32f (Plan 2 T3–T9 merged; 582 tests). Codex 0.153.4, tmux 3.7b, Node v22.23.0. Five ChatGPT Pro accounts (aadarwal, dirk, kratuvak, qpaig, tulp) registered from the dashboard host's profiles; Codex hooks installed into each account home by `ms doctor --fix` (computed trust, 4 hashes per home); Claude hooks re-pointed at this worktree's `bin/ms`; anu arm paused for the run.

| # | Case | Result | Evidence |
|---|------|--------|----------|
| 0 | first `ms codex` | FAIL → fixed | `no account has room … no weekly window ×5`: the provider mapped windows by position; Pro's only window (168 h) arrives as `primary_window`. Fixed de6d32f (classify by `limit_window_seconds`). |
| 1 | `ms codex` fresh pane → picked account, `started`, `running` | PASS (with C2) | %64 kratuvak (earliest weekly reset); no trust modal (pre-written table); the TUI fires SessionStart only with the FIRST PROMPT — after one prompt: started/activity/stop, id + transcriptPath adopted, `running`, watchdog armed (kv `codexWatchArmedUntil`). Until then the row reads `launching` → C2 |
| 3 | two `ms rotate` at once | PASS | one `another recovery holds`, the other kratuvak → dirk via `codex resume <id> "<continuation>"`; the continuation answered "no unfinished work" (B4 wording) |
| 5 | `ms stop` | PASS | `stopped`, pane back to bash |
| 6 | quoted wall text | PASS | the echoed wall sentence → Stop hook `stop` event; no `rate_limited`; watchdog pass recorded nothing extra |
| 4 | `ms switch --to tulp` idle → no continuation | FAIL (C1) | `codex resume <id>` (no prompt) relaunched on tulp, TUI up, but `no resume report within 60s → parked`: without a submitted prompt the TUI emits no SessionStart |
| 7 | never-prompted session rotate → fresh `codex` | FAIL (C1) | correct command (`codex`, no continuation), TUI up, parked after 60 s for the same reason |

## Bugs
- **C1** Codex readiness for a relaunch WITHOUT a continuation (manual switch/rotate on an idle session, or a fresh relaunch) must not wait for a hook event: the TUI reports SessionStart lazily at the first prompt. Ruling: for a Codex relaunch with no prompt argument, readiness = the pane alive (not dead, process present) after a 5 s settle → `running`; the hook's later `started`/`resumed` merely confirms (and adopts the id).
- **C2** A freshly launched Codex pane sits in `launching` (null id) until the human's first prompt; reconcile's stuck rule (launching/resuming past its threshold) would park a healthy idle pane. Ruling: for Codex sessions, `launching`/`resuming` with a live pane past the threshold becomes `running` (never parked); `ms status` may show `launching` meanwhile — acceptable.
