# Rebalance — keep every session on the best account, at idle moments

Status: approved 2026-09-19 (the author, after the observation that a running session never re-asks "which account is best" between launch and a wall). Ships in 0.3.1 behind a switch, on by default one release later.

## Problem

The chooser answers "best account" at launch and at a wall only. Between them a session stays where it started while budgets change: an account's week resets (its budget won't refresh for seven days, so by the chooser's own rule it is now the worst place to spend), or the current account creeps toward a wall that will hit mid-turn. The rule "only a wall moves work" avoided churn and surprise; it also leaves value on the table.

## What "best" means

Unchanged: not walled, soonest weekly reset first, then most room, solo before shared (`src/pick.ts`).

## When a session moves on its own

Only at a turn end (the session is idle), only when ONE of these holds:
1. **Imminent wall**: a window the chooser gates on is at ≥ 85 % on the current account, and the best account has ≥ 30 % room in every gating window.
2. **Clearly better budget**: the best account's weekly reset is ≥ 24 h earlier than the current one's, and the current account's week is ≥ 50 % used.

And ALL of these guards pass:
- the session's pane reads idle (no turn in flight; the turn-end hook is the trigger, and the pane is re-read before acting);
- no move of this session (automatic or manual) in the last 6 h, and no wall-driven rotation of it in the last 30 min;
- the destination passes the same preflight a rotation runs (credentials, trust for the pane's cwd, room);
- the gate is on: kv `rebalance` = "1" (mirrored from `MS_REBALANCE`, like `codexAutorotate`); default off in 0.3.1, on in 0.3.2.

Never mid-turn; never for a `parked`, `waiting`, `stopped` or `gone` row; at most one move per hook run.

## How, with no resident process

- The turn-end hook (`Stop` for Claude, the Codex watchdog's `stop` record) calls `maybeRebalance(sessionId)`:
  1. read the cached snapshot from the store; if it is older than 15 min, or a `resetsAt` in it has passed since it was taken, refresh once (one usage round for every account, written back for everyone);
  2. compute the best account (`pick`) and the two conditions against the current account;
  3. if a condition and every guard hold, dispatch the existing switch transaction for this session to the best account, through tmux like a recovery (outside the CLI's process tree), with NO continuation (the pane is idle);
  4. record `rebalance` in the session's events (from, to, reason) and `lastMoveAt` on the row.
- Cost when nothing moves: one SQLite read and a few comparisons per turn end; the network at most every 15 min fleet-wide.

## Visibility

- `ms status` and `/api/state` carry `better: <account>` (or null) per session — what the rule would choose right now — and `ms status` shows it as a BETTER column (`—` when the current is best). The dashboard chip shows it quietly (not a worry colour).
- `ms rebalance [--dry-run] [--session <id>]`: the same decision for every idle session, printed as a table (SESSION, ACCOUNT, BETTER, REASON, WOULD MOVE / MOVED); without `--dry-run` it moves them, ignoring the 6 h guard for an explicit human run but never mid-turn. The dashboard gets a "Rebalance" control on the same row as "Move every pane".
- `ms doctor` prints the gate's state like the Codex gate.

## Not in this spec

Predictive moves (projections of when a wall will hit); moving a mid-turn session; cross-provider moves (a Claude session stays Claude).

## Tests

Pure decision function with a fixed clock over snapshot fixtures: each condition, each guard, the 15-min/reset refresh rule (a fake fetcher counts calls), hysteresis; the hook wiring (a turn-end event with the gate off does nothing; on, dispatches once); the switch transaction called with no continuation; `ms status` BETTER column and JSON; `ms rebalance --dry-run` moves nothing; the dashboard control's body. Hermetic as always.
