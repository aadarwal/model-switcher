# Rebalance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** at every turn end, an idle session moves to the best account when a wall is imminent or a clearly better budget exists, under strict guards and behind a gate; `ms status` shows what the rule would choose; `ms rebalance` does it for the fleet on demand.

**Architecture:** one pure decision module `src/rebalance.ts` (`decide(...)`) fed by the store's cached snapshot (with a bounded refresh rule), wired into the turn-end hooks; execution reuses the manual switch transaction (`src/manual.ts`, no continuation) dispatched through tmux like a recovery.

**Tech Stack:** TypeScript ESM, Node ≥ 22.15, zero deps, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-19-rebalance-design.md` (binding).

## Global Constraints
- No resident process; no timers; the only trigger is the turn-end hook and the manual verb. The network is touched only by the refresh rule (snapshot older than 15 min or a passed `resetsAt`), one round for all accounts.
- Never mid-turn; never a `parked`/`waiting`/`stopped`/`gone` row; one move per hook run; the 6 h / 30 min guards; the gate (kv `rebalance`, env `MS_REBALANCE`, default off).
- No secret anywhere; tests hermetic (stub tmux, stubbed fetch, fixed clock); the three co-author trailers; `env -u CLAUDE_CONFIG_DIR -u MS_HOME -u CODEX_HOME -u MS_BIN MS_ENTRY=src npm test`, typecheck, build.

## Files
| File | Responsibility |
|---|---|
| `src/rebalance.ts` | `decide(input) → Decision`, `refreshIfStale(deps)`, `maybeRebalance(sessionId, deps)`, `REBALANCE_RULES` constants |
| `src/hooks/claude-hook.ts`, `src/hooks/codex-hook.ts` | call `maybeRebalance` at turn end (Claude `Stop`; Codex watchdog `stop` record) |
| `src/status.ts`, `src/dashboard/*` | BETTER column / `better` field / chip; the Rebalance control |
| `src/rebalance-verb.ts` (or in `src/manual.ts`) | `ms rebalance [--dry-run] [--session <id>]` |
| `src/autorotate.ts` | the `rebalance` gate beside `codexAutorotate`; doctor line |

### Task 1: The decision (pure) and the refresh rule
- Produces: `interface DecisionInput { session: SessionRow; accounts: AccountUsage[]; now: number; lastMoveAt: number | null; lastWallAt: number | null; gate: boolean; paneIdle: boolean }`, `type Decision = { move: false; better: string | null; reason: string } | { move: true; to: string; better: string; reason: "imminent-wall" | "better-budget" }`, `decide(input)`; `refreshIfStale({ snapshotTakenAt, resetsAt: number[], now, refresh: () => Promise<void> })` with the 15-min / passed-reset rule. Tests: each condition true/false at the boundaries (85/30, 24 h/50 %), each guard, `better` computed even when `move: false`, the refresh rule with a counting fake.
- [ ] failing tests → implement → commit `rebalance: the decision`.

### Task 2: Hook wiring, execution, gate
- `maybeRebalance(sessionId, deps)`: reads the row + snapshot, re-reads the pane's idleness (the repo's pane-state reader), runs `decide`, and on `move: true` dispatches the manual switch transaction to `to` with no continuation through tmux (reuse the recovery's dispatch helper), records the `rebalance` event and `lastMoveAt` (new column, additive). Wire into both hooks' turn-end paths behind the gate; `src/autorotate.ts` gains `rebalance` (env `MS_REBALANCE`, kv, doctor line `rebalance: off (export MS_REBALANCE=1 …)`). Tests: gate off → no dispatch; on + condition → one dispatch with the expected argv and no continuation; a second turn end within 6 h → none; wall within 30 min → none; parked row → none.
- [ ] failing tests → implement → commit `rebalance: move at idle, behind a gate`.

### Task 3: Visibility and the verb
- `statusJson()` adds `better` per session (additive); `ms status` BETTER column (last); dashboard chip + a Rebalance control posting `/api/rebalance` `{ dryRun?: boolean }` → `{ rows: [{ session, account, better, reason, outcome }] }`; `ms rebalance [--dry-run] [--session <id>]` prints the table, moves idle sessions that meet a condition (the 6 h guard waived for an explicit run, never mid-turn). README (a "Rebalance" section + the env var row), CHANGELOG `## Unreleased`. Tests: JSON additive, column, dry-run inert, the API body shapes, the page's control body.
- [ ] failing tests → implement → build (dist guard) → commit `rebalance: see it, run it`.

### Task 4: Live check (laptop)
- Two Claude sessions on an account that is ≥ 85 % in a gating window (or make one so with a synthetic snapshot in a scratch `MS_HOME` — a fixture snapshot with `resetsAt` in the past for another account is enough to trigger "better budget"), gate on, one prompt each → at turn end one moves to the best account with no continuation, the other waits (one per hook run), `ms status` shows BETTER; a second turn end within 6 h moves nothing; `ms rebalance --dry-run` table; record `docs/superpowers/plans/2026-09-19-live-matrix-rebalance.md`.

### Task 5: Release 0.3.1 (gate default off); a follow-up commit flips the default in 0.3.2 after observation.

## Self-review
Spec sections → tasks: conditions/guards/gate → T1/T2; no-resident-process + refresh rule → T1/T2; visibility + verb → T3; live → T4. Types: `Decision` (T1) consumed by T2/T3. No placeholders.
