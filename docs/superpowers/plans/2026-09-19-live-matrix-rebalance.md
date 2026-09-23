# Live matrix — rebalance

Date: 2026-09-22 23:19 local, laptop, branch `rebalance-ui` at 0801ac2 (hooks pointed at the worktree for the run, restored to the brew shim afterwards).

No real account was near a wall after the week's resets, so the "imminent wall" condition was staged: the store's cached snapshot (backed up, restored after) was edited to read `dirk` at 92 % of its Fable window and `gmail` at 0 %, both fresh. `MS_REBALANCE=1`, `ms claude --as dirk --need fable`, one prompt.

| t | Observed |
|---|---|
| turn end (+~5 s) | events: `rebalance` (`imminent-wall`), `ended`, then `resumed` at generation 2; `ms status`: the row on `gmail`, `running`, BETTER `—`; the pane shows the same conversation resumed, no continuation sent (the pane was idle). |
| second turn on the moved session | `activity` at generation 2, no second `rebalance` (the 6 h guard). |
| `ms rebalance --dry-run` | the moved row: `already on the best account`; an idle Codex row names a better account with `neither condition holds` (visible, not moved); stopped rows listed as skipped. |
| `ms doctor` | `rebalance: on (export MS_REBALANCE=0 to disable)` while the gate was mirrored on; off again after cleanup. |

Verdict: PASS. Ships in 0.3.2 with the gate OFF by default; the default flips after a few days of watching `BETTER` on real sessions.

Note from the same day: Codex auto-updated to 0.156.0; `ms`'s own Codex hooks (absolute binary paths) still fire under it — verified with a real session's `started`/`activity`/`stop` events.
