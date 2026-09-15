# model-switcher — design

Status: draft for review, 2026-09-15. Platform: macOS only. Distribution: Homebrew tap. Scope: Claude Code and Codex CLI, one device.

## 1. What it is

A single command, `ms`, that runs `claude` and `codex` on whichever of the user's subscription accounts has room, and, when a running session hits a usage wall, restarts the same session in the same tmux pane on the next account with room and tells it to continue. It is the standalone, installable version of the account rotation the author runs inside anu, rebuilt around what the live rollout of that system taught (see §14).

Goals:

- Anyone can install it (`brew install aadarwal/tap/model-switcher`), run `ms setup`, walk through N Claude and M ChatGPT logins, and be rotating in ten minutes.
- Zero resident processes of the tool's own: at 60 panes the only resident processes are the 60 CLIs.
- Unattended rotation only on the provider's own report of a rate limit, never on screen text alone.
- Conversation continuation, in place: same pane, same session id, same working directory.

Non-goals (v1): Linux; cross-device sync; a hosted dashboard; taking over sessions the tool did not launch; predictive quota scheduling; exactly-once replay of interrupted tool calls; anu integration (anu keeps its own implementation; the Codex mechanics proven here get ported to it separately).

## 2. Chooser rule (fixed)

Ported verbatim from the tested rule in the author's dashboard: a usage window at 100 % makes an account ineligible (the five-hour window, the all-model weekly window, and the Fable weekly window when the session needs Fable); eligible accounts are ordered by earliest weekly reset first, then by the worst remaining weekly window, then solo before shared. No projections and no thresholds below 100. `need` is `any` or `fable`; `auto` resolves from an explicit `--model` argument, else `ANTHROPIC_MODEL`, else the CLI's settings. The rule is a pure function with fixture tests; nothing else decides.

## 3. Components

| Component | Runs when | Responsibility |
|---|---|---|
| `ms` CLI (TypeScript on Node) | on demand | every verb below; exits when done |
| `ms _exec <launch-id>` | as the pane's command | loads the launch credential from the store and `exec`s the CLI in place; no process of ours stays resident, and tmux never stores a secret in a pane's command or environment |
| hooks (installed into `~/.claude/settings.json` and Codex's hooks file) | per CLI event | append one event, and on a rate limit ask tmux to dispatch a worker; never block the CLI |
| worker (`ms _recover <session>`) | dispatched by `tmux run-shell -b` | one recovery transaction: drain pending events, pick, hand off, acknowledge |
| tmux server (the user's, or a tool-owned one) | always, already | pane ownership, `respawn-pane`, `run-shell -b` dispatch, `run-shell -b -d` timers for reset wake-ups and reconciliation |
| store (`~/.config/model-switcher/`) | files | registry, credentials (0600), a SQLite state file, per-session audit logs |
| chooser + pollers | inside `ms` | the rule in §2; Claude usage via the poll grant; Codex usage via its own credential |

There is no runner, watcher, poller service or launchd agent. Everything the tool does happens inside a CLI invocation that ends.

## 4. CLI surface

```
ms setup                                    the wizard (§10)
ms claude [claude args…]                    launch on the best account (or --as <name>, --need any|fable)
ms codex  [codex args…]                     same for Codex
ms status [--watch]                         pool table, sessions and their state, pending recoveries, next wake-ups
ms accounts add|login|verify|remove <name>  manage accounts (both credentials for Claude, one for Codex)
ms accounts token <name>                    print a launch token (the only place a secret is ever printed)
ms rotate <session> [--force]               manual: move a walled session now
ms switch <session> --to <account> [--continue]   manual: move an idle or walled session to a named account
ms stop <session>                           end a session and cancel its pending recovery
ms doctor [--fix]                           hooks, versions, credential health, orphaned state
ms attach                                   attach to the tool-owned tmux server (when not launched from inside tmux)
```

Deferred until the live matrix passes (§13): `ms dashboard` (localhost page over the same store and verbs) and bounded `ms switch --all --to <account>`.

## 5. Store

```
~/.config/model-switcher/
  accounts.json           registry: name, provider, label, organisation id (identity), credential refs
  claude/<name>/          the poll grant's config dir (CLAUDE_CONFIG_DIR for `claude auth login`)
  codex/<name>/           CODEX_HOME for that account
  launch/<name>.token     Claude setup-token, 0600 (or in the keychain; default on)
  state.sqlite            sessions, generations, pending recovery, attempts, wake-ups, continuation ack
  sessions/<id>/events.jsonl   audit log written by hooks and workers
  sessions/<id>/recover.log    worker output (never shown in the pane)
  hooks/                  the hook scripts the wizard installed, at stable absolute paths
```

Files are 0600 and directories 0700. The registry is validated on every load; a malformed file is never rewritten from a state that could not be parsed (an instance of this destroyed launch metadata in the dashboard before its final review).

## 6. Credentials and identity

**Claude: two credentials per account.** A `claude setup-token` (one year, inference only) launches the CLI; a normal `claude auth login` run with `CLAUDE_CONFIG_DIR=~/.config/model-switcher/claude/<name>` mints a profile-scoped grant that can read usage. Both are minted by Claude Code itself; the tool carries no OAuth client code. The tool refreshes only the poll grant; the running CLI owns the launch token; they never race. On macOS a custom config dir keeps its credentials in the keychain under a dir-specific item, so the poller reads them via `security` (bounded) with the credentials file as the fallback.

**Codex: one credential per account.** `codex login` into the account's `CODEX_HOME`. The same credential launches and polls. Codex refreshes it itself while a session runs; the tool refreshes only when no managed Codex session is on that account, coordinated through the per-account lock in §9. Whether several concurrent Codex processes on one account tolerate each other's refreshes is unproven and is release gate G2 (§12).

**Identity is the organisation id.** After both logins the wizard resolves the poll grant's organisation through the profile endpoint and the launch token's identity through a headless one-shot, and refuses to register an account whose credentials disagree or whose organisation is already registered. Nicknames never establish identity.

**Keep-alive.** Poll grants die if unused for weeks. Every launch and every `ms status` refreshes them; `ms doctor` names any that died and re-runs that login. No background service exists to keep them warm, and the docs say so.

## 7. Launch

`ms claude …`:

1. Resolve the account: `--as`, else a fresh pick (§2) from a usage snapshot no older than 20 s, coalesced across concurrent launches. Verify the launch credential resolves locally before anything else.
2. Record a launch in the state file: session id (minted, `--session-id`), account, need, cwd, tmux socket, generation 1, whitelisted CLI flags.
3. Inside tmux (`$TMUX` set): the current pane becomes the session's pane and its command is replaced with `ms _exec <launch-id>` (an owned pane, so the CLI is the pane's root process). Outside tmux: create or reuse the tool-owned server (`tmux -L ms`), open a window in the session's cwd running the same command, and attach. `remain-on-exit` is set on the pane so a CLI exit never destroys the pane the tool may need to respawn.
4. `ms _exec` loads the credential, sets `MS_SESSION`, `MS_GENERATION`, `MS_SOCKET`, `MS_PANE`, and the provider's credential variables, unsets conflicting provider variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, cloud switches), and `exec`s the CLI.
5. The CLI's SessionStart hook reports the session id and source; the launch is `running` only when that report matches the launch record. A wrong id (a `--resume` that fell back to a new session) is a failed launch.

The cwd must already be trusted by the CLI; the trust dialog is a modal the tool does not answer (verified: an untrusted cwd blocks `--resume` behind it).

When a session ends normally (the user exits the CLI, or `ms stop`), the pane is not left dead: the `ended` event, or tmux's pane-exit with `remain-on-exit`, makes `ms` respawn the user's login shell in that pane, so a pane that ran `ms claude` returns to a prompt exactly as a pane that ran `claude` would.

## 8. Events

Hooks write one JSON line each and exit; they never block the CLI and never print. Every event carries the hook's inherited `MS_SESSION` and `MS_GENERATION` (never a looked-up latest generation), the tmux socket and pane, the CLI's own session id, and the turn id where the provider gives one.

| Provider | Hook | Event | Notes |
|---|---|---|---|
| Claude | SessionStart | started / resumed / cleared / compacted | `source` field; a `/clear` changes the conversation within one process |
| Claude | UserPromptSubmit | activity | makes any earlier failure for this generation obsolete |
| Claude | StopFailure (`error: rate_limit`) | rate_limited | the trigger; fires within a second of a real wall, not on quoted text |
| Claude | SessionEnd | ended | a late `ended` from an old generation never marks its replacement stopped |
| Codex | SessionStart / UserPromptSubmit / Stop / SessionEnd | as above | trust for hooks must be granted; the failed-turn evidence path is gate G1 |
| tmux | pane exit (`remain-on-exit`) | died | the CLI stopped without reporting |

Screen text (`tmux capture-pane`) is read only to name the wall's kind (session, weekly, fable) and, by `ms status`, to flag "walled, unreported" for manual handling. It never triggers a rotation. Patterns are anchored to the TUI's own rendering (line start, optional `⎿`), never matched inside prose or a user echo.

## 9. Recovery

**State per session** (in SQLite): `launching → running → walled → stopping → resuming → continuing → running`, plus `parked` (out of attempts), `waiting` (all accounts out; next wake-up recorded), `stopped`. Every transition names the generation, account, session id and turn it belongs to.

**Trigger.** A `rate_limited` event for the current generation, with no later `activity` event, becomes a pending recovery in the store (append before dispatch; reconciliation repairs a crash between the two). The hook then asks tmux to dispatch `ms _recover <session>` with `run-shell -b`; the worker runs outside the CLI's process tree, so the CLI's death cannot kill it.

**Worker, one transaction:**

1. Take the session's mutation lock. If another worker holds it, exit; the holder drains all pending events before finishing, so nothing is lost.
2. Re-read state. If the failure is obsolete (newer activity, a stop request, the pane gone), acknowledge and exit.
3. Poll usage for the candidates through the shared, coalesced snapshot. Pick (§2) excluding the walled account and any account whose earlier attempt in this transaction failed. Verify the candidate's credential resolves locally.
4. Mark the handoff in the store and on the pane (a visible one-line title change; input is not intercepted).
5. Graceful exit: the provider-specific sequence tested for the state the CLI is in (Claude at a prompt: `/exit`; never typed into a modal), bounded wait, confirm the pane's root process is gone. If it is not, terminate it, verify, and record that it was forced.
6. `tmux respawn-pane -k -c <cwd> -t <pane> 'ms _exec <new-launch-id>'` with the new generation, on the recorded socket. The new launch's command is `<cli> --resume <session-id> "<continuation>"` (Claude) or `codex resume <session-id> "<continuation>"`; the continuation is submitted by the CLI itself, never typed.
7. Readiness: the SessionStart hook's `resumed` event for the same session id under the new generation. `resumed` means the conversation started resuming; authentication success and continuation acceptance are tracked as their own states (`continuing` → `running` on the first `activity`/turn event of the new generation).
8. Acknowledge the pending recovery. If the replacement fails immediately, its own hook event is pending; the same worker drains it before releasing the lock.

**Continuation text.** "Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions." A manual switch of a conversation that had finished resumes without a continuation.

**Bounds.** Each candidate at most once per transaction. Failure classes have separate budgets: account exhaustion (try the next), authentication failure (mark the credential, try the next), infrastructure failure (back off 2 min, keep the session), broken resume (park with the last screen lines and one notification). After three failed transactions for one wall the session is parked. When every account is out, the session enters `waiting` with `next_attempt_at` = the earliest eligible reset; a tmux timer (`run-shell -b -d`) wakes a worker then, and any `ms` command run earlier reconciles it. Reconciliation runs at the start of every `ms` invocation: abandoned locks, workers that died after launching a replacement (reconcile, never launch a second copy), stale wake-ups after a tmux server restart.

**Races, required behaviour.** Automatic worker vs manual `ms rotate`: serialised by the lock, the loser rechecks. Duplicate failures for one turn: one transaction. User starts a new turn during polling: the failure is obsolete, nothing is killed. User closes the pane: pending work is cancelled, never recreated. `ms stop` during polling: the intent is recorded first and checked before every destructive step. Worker dies after the respawn: reconcile the existing launch.

**Pool coordination at scale.** A per-session mutation lock, a per-account credential lock (poll-grant refreshes serialised; Codex refreshes only with no managed session on the account), and a short allocation transaction for picks so 60 simultaneous walls do not stampede the usage endpoints or herd onto one account: the snapshot is shared and coalesced, and simultaneous handoffs are bounded (start at 4, measure). Earliest-reset-first packs sessions onto one account by design; a capacity cap per account is an explicit eligibility rule, off by default.

## 10. Wizard (`ms setup`) and install

- `brew install aadarwal/tap/model-switcher` (formula: bundled JS, `depends_on "node"`, `depends_on "tmux"`); `ms setup` is resumable.
- Prerequisites check: `claude` and `codex` versions against the tested range; tmux version; the hooks' absolute paths.
- Accounts: "How many Claude accounts?" then per account: a name, the poll login (browser), the launch token (`claude setup-token`, captured, never shown), identity verification, and a headless one-shot to prove the launch works. Then "How many ChatGPT accounts?" and per account `codex login` (device-auth offered when headless). Duplicate organisations are refused.
- Hooks: merge only the `hooks` entries into `~/.claude/settings.json` (backup first; a plain file whose other keys are preserved) and install the Codex hooks file, then obtain Codex's trust for them; verify with a throwaway session that a `started` event arrives.
- Options, each yes/no, off by default: a statusline badge showing the account (merged into the existing statusline command with a backup); a shell alias (`alias claude='ms claude'`, `codex` likewise) appended to the user's rc file; keychain storage for launch tokens (on by default).
- Finish with `ms doctor` and `ms status`.

## 11. Security

No secret on argv, in a tmux command, in a tmux environment, in a log, or in the pane. `ms _exec` reads the credential from the store or the keychain and puts it only in the CLI's environment. Rotation logs may contain pane screen text; the store is 0700. `ms accounts token` is the one verb that prints a secret.

## 12. Release gates and spikes (in this order, each with pass/fail)

- **G1 Codex failure contract.** A real exhausted account on the first turn and on a later turn; quoted wall text in a healthy turn; a transient error; a modal; `codex resume <id> "<prompt>"`. Pass: an event exists that identifies the failed turn with quota evidence (hooks or app-server) and no false event for quoted text. Fail: Codex auto-rotation ships disabled, flagged for manual rotate.
- **G2 Shared Codex authentication.** Several concurrent Codex processes on one account crossing a refresh boundary while `ms status` polls. Pass: no process loses its credential. Fail: one managed Codex session per account, enforced.
- **S3 Shutdown and resume (Claude).** Graceful vs forced termination at a wall, delayed persistence, surviving child processes, exact conversation and cwd, one continuation. (Partially verified today: `respawn-pane -k` on a parked Claude preserved the transcript and `--resume <id> "<prompt>"` submitted the prompt in about 4 s.)
- **S4 Delivery and timers.** Worker death before and after the event commit, lock contention, immediate replacement failure, no attached client, a reset wake-up, and sleep/wake of the Mac.
- **S5 Race and scale harness.** A synthetic 60-pane workload with stubbed CLIs: manual stop, pane closure, typing during a handoff, duplicate and reordered events, bounded polling; measure burst process count, memory and hook latency.
- **S6 Wizard and packaging.** Hook trust, custom homes, an upgrade of either CLI, repair paths.

## 13. Deferred

`ms dashboard` (localhost page over the same store and verbs; the author's home dashboard is the visual reference), bounded `ms switch --all`, Linux, capacity caps, a keep-warm service, anu adoption.

## 14. Verified facts this design rests on (2026-09-15)

- `tmux respawn-pane -k` sends SIGHUP to the pane's process group; a child in its own session or under `nohup` survives it; macOS has no `setsid` binary (Node's `detached: true` with disconnected stdio and `unref()` is the detach). tmux 3.7b's `run-shell -b -d` holds a delay inside the server.
- Claude Code 2.1.272: SessionStart's field is `source`; hooks inherit the pane's environment; StopFailure's matcher field is `error` with `rate_limit` in its enum; it fires within a second of a real Fable wall and does not fire on quoted wall text; `claude --resume <id> "<prompt>"` submits the prompt; a parked Claude killed by `respawn-pane -k` kept its transcript; the folder-trust dialog is a modal that also blocks `--resume`; with `tui: fullscreen` the transcript is top-anchored and a resumed transcript re-renders the old wall text.
- Codex 0.153.4: `codex resume [SESSION_ID] [PROMPT]`, `codex queue --thread <id> --message`, an app-server with thread ids; sessions under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` with `session_meta.session_id` and `cwd`; wall text "You've hit your usage limit for …"; hooks with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `last_assistant_message` and no StopFailure (event set and hooks-file path to be confirmed in G1); hooks require trust.
- Claude keychain: service `Claude Code-credentials`, account = macOS username for the default config dir; a custom `CLAUDE_CONFIG_DIR` gets its own entry keyed to the dir.
- ChatGPT usage: `https://chatgpt.com/backend-api/wham/usage` with the Codex credential; refresh at `https://auth.openai.com/oauth/token`.
- The author's live incident: a pane that merely quoted "You've hit your usage limit" was rotated twice by screen scraping while no account was near a limit; the fix requires the provider's own report.
