# model-switcher Plan 4 — `ms dashboard`, `ms switch --all`, and the anu port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the human one local page that shows every account's room and every managed pane's state and exposes the manual verbs as buttons ("move every pane to account X" included), a bounded `ms switch --all`, and carry the Codex mechanics learned in Plan 2 back into anu — closing the deferred list in spec §13.

**Architecture:** `ms dashboard` is a Node HTTP server alive only while the page is open (it exits when no client has polled for 30 s), serving one static HTML page and a JSON API over the same store and verbs the CLI uses (`getSnapshot`, `listSessions`, `rotate`/`switch`/`stop` via the exported verb functions). No resident process otherwise: the page polls `/api/state` every 5 s; a manual action is a POST that runs the verb in-process with the same locks. `ms switch --all --to X` walks every managed session of X's provider with bounded concurrency (the recovery's handoff slots) and per-session refusals, exactly like N separate `switch` calls. The anu port is a separate task in the anu repo: anu's `account` verbs gain a Codex branch using the rollout-record watchdog and per-home hooks, behind anu's existing arm.

**Tech Stack:** TypeScript ESM, Node ≥22.15 (`node:http`), zero runtime deps, one inline HTML page (no framework), the existing store and verbs.

**Spec:** `docs/superpowers/specs/2026-09-15-model-switcher-design.md` §13 (deferred features); the author's home dashboard (`~/src/aadarwal/data`, `app/globals.css` under `/* Usage overview */`) is the visual reference — near-black plane, one grotesque, sentence-case titles, worry-only colour.

## Global Constraints

- macOS only; Node `>=22.15`; zero runtime dependencies; every subprocess bounded; store 0600/0700.
- The dashboard binds `127.0.0.1` only, on an ephemeral port printed once (`ms dashboard` opens the browser with `open <url>` unless `--no-open`); no auth is needed because it is loopback-only and alive only while open; it never serves tokens or `auth.json` contents (the JSON API returns exactly `status --json`'s shape plus verb results).
- Manual verbs from the page run in-process with the same session lock discipline as the CLI; the page shows the verb's one-line result; nothing on the page ever types into a pane.
- `switch --all` is bounded: at most `HANDOFF_SLOTS` (4) concurrent handoffs, each session refused or moved with the CLI's own messages, an overall wall-clock bound (`--timeout`, default 10 min), exit 1 if any session was refused.
- Tests hermetic (temp HOME/MS_HOME, stub tmux, stubbed fetch, the HTTP server on port 0 under test); never `npm run build`; `MS_ENTRY=src npm test` and `npm run typecheck` clean; commits with the three co-author trailers.
- The anu port lands in the anu repo on a branch with tests and a PR, never by hot-patching live config.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/dashboard/server.ts` | `startDashboard({ port, open }) → { url, close }`: loopback HTTP, routes, the idle-exit timer |
| `src/dashboard/api.ts` | `GET /api/state` (status JSON + `takenAt`), `POST /api/rotate|switch|stop` (body `{ session, to?, force? }`) calling the verb functions |
| `src/dashboard/page.ts` | The single HTML page as a template string: accounts table, sessions table, per-row buttons, the "move all to…" control, 5 s polling, worry-only colour |
| `src/dashboard.ts` | `ms dashboard [--port N] [--no-open]` verb |
| `src/manual.ts` | `ms switch --all --to <account> [--force] [--timeout <s>]` |
| `~/anu` (separate repo) | `config/bash/bin/anu-account`: Codex branch; `plugins/anu/bin/pane`: Codex wall arm |

---

### Task 1: Dashboard API over the store

**Files:**
- Create: `src/dashboard/api.ts`, `test/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `status`'s JSON builder (export the pure part of `src/status.ts` that builds `{ accounts, sessions, takenAt }` as `statusJson(): Promise<StatusJson>` if it is not already separable); `rotateVerb`/`switchVerb`/`stopVerb` (`src/manual.ts`) — call them as functions with argv arrays and capture their exit code and stderr line (add a small `captureVerb(fn, argv)` helper that swaps `process.stderr.write` for the call's duration under a mutex).
- Produces: `handle(req: { method: string; path: string; body?: unknown }): Promise<{ status: number; json: unknown }>` — `GET /api/state` → 200 `{ accounts, sessions, takenAt }` (the snapshot with `maxAgeMs: 20_000`, same as `status`); `POST /api/rotate` `{ session, force? }` → `{ code, message }`; `POST /api/switch` `{ session, to, continue?, force? }`; `POST /api/stop` `{ session }`; `POST /api/switch-all` `{ to, force? }` → `{ results: [{ session, code, message }] }` (Task 3's function); anything else 404; a malformed body 400; verb exceptions 500 with the message (never a token — the verbs never print one).

- [ ] **Step 1: Failing tests** (temp store seeded with two accounts and two sessions, stub tmux, stubbed fetch): `GET /api/state` returns both tables and a numeric `takenAt` and contains no token-shaped string (seed a recognisable fixture token in a launch token file); `POST /api/stop` on a running session returns `{ code: 0 }` and the tmux log shows the exit sequence; `POST /api/switch` with an unregistered `to` returns `{ code: 1, message: /not registered/ }`; a malformed body → 400; unknown route → 404.
- [ ] **Step 2–4:** red → implement → green; typecheck.
- [ ] **Step 5: Commit** — `Dashboard API: state and the manual verbs over the store`.

---

### Task 2: The page and the server

**Files:**
- Create: `src/dashboard/page.ts`, `src/dashboard/server.ts`, `src/dashboard.ts`, `test/dashboard-server.test.ts`; Modify: `src/cli.ts` (`registerVerb("dashboard", …)`, USAGE)

**Interfaces:**
- Consumes: Task 1's `handle`.
- Produces: `startDashboard({ port = 0, open = true, idleMs = 30_000 }) → Promise<{ url: string; close(): void }>`; `ms dashboard` prints `ms dashboard: http://127.0.0.1:<port>` once, runs `open <url>` (bounded) unless `--no-open`, and exits 0 when no request has arrived for `idleMs` (the page polls every 5 s, so an open tab keeps it alive; closing the tab ends the process within 30 s — the "alive only while open" rule from the spec). The page: two tables mirroring `ms status` (accounts: NAME LABEL 5H WEEK FABLE RESETS STATE; sessions: SESSION PANE ACCOUNT NEED STATE GEN PENDING WAKEUP WALLED?), per-session buttons Rotate / Switch to ▾ / Stop, and one control "Move every <provider> pane to ▾ [Go]" wired to `/api/switch-all`; results shown inline for 10 s; colour only for worry (`walled`/`parked`/`auth` in amber, errors in coral); no framework, no external assets, inline CSS in the reference's language (near-black plane, one grotesque, sentence-case).

  Note (0.2.2): the accounts table above gained a PROVIDER column right after NAME, on the page and in `ms status`'s text table — same words the sessions table already used — so a Claude account and a Codex account sharing a name are told apart.

- [ ] **Step 1: Failing tests:** the server binds 127.0.0.1 on port 0 and reports a URL; `GET /` returns HTML containing both table headers and the move-all control; `GET /api/state` works through the real server; the process-level idle exit: with `idleMs: 200` and no requests the returned promise from `waitUntilIdle()` resolves within ~1 s (expose that helper for the test; the verb awaits it); `--no-open` skips `open` (stub `open` on PATH and assert it was not called).
- [ ] **Step 2–4:** red → implement → green; typecheck.
- [ ] **Step 5: Commit** — `ms dashboard: a loopback page over the same store and verbs, alive only while open`.

---

### Task 3: `ms switch --all`

**Files:**
- Modify: `src/manual.ts`, `test/manual.test.ts`

**Interfaces:**
- Consumes: `switchVerb`'s per-session path (factor its body into `switchOne(session, to, opts) → { code, message }` so both the CLI and the dashboard use it); `HANDOFF_SLOTS`/the handoff semaphore already in `src/recover.ts` (export the constant).
- Produces: `switchAll(to: string, opts: { force: boolean; timeoutMs: number }) → Promise<{ results: { session: string; code: number; message: string }[]; code: number }>` — candidates are every session of `to`'s provider not already on `to` and not `stopped`; runs `switchOne` with a small in-process pool of `HANDOFF_SLOTS` (the recovery's own slot lock still applies per handoff — the pool only avoids spawning more attempts than slots); stops launching new ones when `timeoutMs` elapses (the in-flight ones finish); exit code 1 if any result is non-zero; `ms switch --all --to X [--force] [--timeout <s>]` prints one line per session and the summary `moved N, refused M`.

- [ ] **Step 1: Failing tests** (the manual tests' world with four sessions on two accounts): `--all --to home` moves the three not on `home`, leaves the fourth untouched, prints three lines and the summary, exit 0; a busy session without `--force` is refused and the exit is 1 while the others still move; the pool never exceeds `HANDOFF_SLOTS` concurrent respawns (assert from the stub tmux's timestamps or an in-flight counter injected via env in tests); `--timeout 0` moves nothing and reports it; `--all` without `--to` → exit 2.
- [ ] **Step 2–4:** red → implement → green; typecheck.
- [ ] **Step 5: Commit** — `ms switch --all: bounded fleet move with per-session refusals`.

---

### Task 4: Dashboard live check (author's laptop)

- [ ] `ms dashboard` on this Mac with the real store: the page opens, shows the four Claude and five Codex accounts and any live sessions; Stop on a test session hands the pane back; "Move every claude pane to kratuvak" on two test sessions moves both; closing the tab ends the process within 30 s (`pgrep -f "ms dashboard"` empty). Record in `docs/superpowers/plans/2026-09-16-live-matrix-dashboard.md`; commit.

---

### Task 5: Port the Codex mechanics into anu (anu repo)

**Files (anu repo, branch `codex-rotation`):**
- Modify: `config/bash/bin/anu-account` (Codex branch of `launch`/`rotate`/`switch`: `CODEX_HOME` per account under `~/.local/state/anu/accounts/codex/<name>`, the shared sessions symlink, `codex resume <id> "<prompt>"`, Ctrl-C ×2 exit), `plugins/anu/bin/pane` (`_wall_kind` gains the Codex wall text; the `limited` arm for codex panes uses the rollout `task_complete`/`usage_limit_exceeded` record read by a `pane watchd` tick instead of a hook stamp), `config/codex/config.toml` template (the four hook tables + computed trust written by `anu account add --provider codex`), tests under `tests/`.
- Interfaces: reuse the hash recipe and rollout-record facts from `docs/superpowers/plans/2026-09-16-codex-spike.md` (copy the recipe into anu's `anu-account` as a shell function using `shasum -a 256` over the exact JSON string; a test pins the `session_start`/`echo ok` vector).
- [ ] Steps: failing tests for the hash vector, the config template writer, the wall-kind matcher, and the watchd tick reading a fixture rollout; implement; anu's own live check (one Codex pane, manual `anu account rotate`); PR with the three trailers; deploy to laptop and mini per anu's deploy checklist. This task is executed with the anu skills (`anu recurse` for rough edges), never by hot-patching live config.

---

## Self-review

- **Spec coverage.** §13 `ms dashboard` (localhost page over the same store and verbs) → T1, T2, T4; bounded `ms switch --all` → T3; anu adoption of the Codex mechanics → T5. Linux, capacity caps and a keep-warm service remain deferred (not in scope).
- **Placeholders.** Each code task names its inputs, outputs, tests and the exact routes/flags; the two live tasks are procedures with pass criteria.
- **Type consistency.** `handle()` (T1) served by T2; `switchOne`/`switchAll` (T3) used by T1's `/api/switch-all` — T1 may land first with `switchAll` imported from `src/manual.ts` once T3 exports it; if T1 lands first, it registers `/api/switch-all` as 501 until T3 merges (say so in the test); `HANDOFF_SLOTS` exported from `src/recover.ts` in T3.

---

## Deviations

- **Idle exit and result lifetime.** The idle window is **90 s**, not the 30 s written above (review round 1, finding 4: a hidden tab's own JS timers throttle from around 60 s, so a 30 s default could exit under a human's nose while the tab was merely backgrounded); a fleet move's result stays on the page for **10–15 s**, not 10 s flat — it expires after 10 s and is cleared by the next 5 s render.
