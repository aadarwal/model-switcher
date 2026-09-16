# Codex spikes G1 / G2 — record (2026-09-16, author's laptop, Codex CLI 0.153.4)

Scratch homes under `~/.config/model-switcher/codex/spike-<name>/` (0700) hold copies of the author's ChatGPT Pro profiles from the dashboard host (aadarwal, dirk, kratuvak, qpaig, tulp). All five are Pro plans with ONLY a weekly (168 h) window; none was at a limit (0–28 % used), so a real Codex wall could not be produced tonight.

## Facts (each verified live)

| Fact | How | Value |
|------|-----|-------|
| Hooks live in the home's `config.toml`, not in any JSON file | `hooks.json` and `hooks/hooks.json` in `$CODEX_HOME`: 0 installed in `/settings`; TOML tables: installed | `[[hooks.<Event>]]` with `hooks = [{ type = "command", command = "…" }]`; events SessionStart, UserPromptSubmit, Stop, SessionEnd (also PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Interrupt) |
| Hooks feature | `codex features list` | `hooks stable true` (on by default) |
| New hooks need trust | `/settings` → Hooks: "⚠ 4 hooks need review before they can run"; `t` = trust all | trust is recorded as `[hooks.state."<config path>:<event_snake>:<matcher idx>:<hook idx>"]` `trusted_hash = "sha256:<64 hex>"`; the hash recipe was NOT reproduced from the hook text (15 candidate serialisations tried) — the tool must obtain trust through the TUI (`/settings`, `t`) or by writing the hash Codex itself computed |
| Hook commands run OUTSIDE the sandbox | a hook wrote to `/tmp` and to the workspace | payload on stdin, one JSON object |
| SessionStart payload | captured | `{session_id, transcript_path, cwd, hook_event_name, model, permission_mode, source}`; `source` = `startup` on a new session, `resume` on `codex resume` |
| UserPromptSubmit payload | captured | `{session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, prompt}` |
| Stop payload | captured | `{session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, stop_hook_active, last_assistant_message}` — NO error/quota field |
| SessionEnd payload | captured after Ctrl-C ×2 | `{…, reason: "other"}` |
| Quoted wall text | asked the model to echo "You've hit your usage limit for this week." | it arrives VERBATIM in Stop's `last_assistant_message` → text is never evidence on its own |
| Session identity | rollout `payload.id` vs hook `session_id` | equal; rollouts at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` |
| Cross-home resume | home B with `sessions` symlinked to home A's store: `codex resume <id> "<prompt>"` | resumed the conversation (prior turns re-rendered, including the old quoted wall text), the prompt argument was submitted automatically, SessionStart `source: resume`, same session id |
| Directory trust is per home | first launch in a new home | modal "Do you trust the contents of this directory?"; recorded as `[projects."<cwd>"] trust_level = "trusted"` in the home's `config.toml` → the launcher/recovery pre-writes it |
| Resume from another cwd | `codex resume` launched with cwd ≠ session cwd | modal "Choose working directory to resume this session" → always relaunch in the session's cwd |
| Exit sequence | `/exit` and `/quit` did nothing in ~10 s; Ctrl-C twice ended the TUI in ~2 s and fired SessionEnd | `["C-c"], ["C-c"]` |
| Fast typing | `tmux send-keys "text" Enter` left the text unsubmitted (paste detection) | deliver prompts with anu's `pane send` (or a pause before Enter) |
| Refresh (G2) | `auth.json` `last_refresh` unchanged across all runs (token still valid) | no refresh observed; rotation semantics of the refresh token unverified |

## Verdicts

- **G1: PARTIAL.** Everything except the wall is verified. Because no exhausted account exists and Pro plans expose only a weekly window, the wall's screen text and its hook signal remain unknown, and Stop carries no quota field — so per spec §12, **Codex automatic rotation ships disabled**: the hook records events, `ms status` flags a Codex pane whose screen shows a wall as `unreported`, and the manual verbs (`ms rotate`/`switch`/`stop`) move Codex sessions. A one-line switch (`MS_CODEX_AUTOROTATE=1`, documented off) enables the automatic path once a live wall shows what evidence Stop (or another event) carries.
- **G2: INCONCLUSIVE → conservative rule.** The tool refreshes a Codex credential only when no managed session for that account is alive (Task 4's `codexRefreshAllowed`), and never writes `auth.json` otherwise; one managed Codex session per account is NOT enforced (no evidence it is needed).

## Consequences for Tasks 6–9
- Installer (T6): write the four `[[hooks.<Event>]]` tables into `$CODEX_HOME/config.toml` for EACH account home (hooks are per home), preserving other tables; trust cannot be pre-computed → `ms doctor` reports "N Codex hooks need trust — open `codex` once in that home and press `t` in /settings" and the wizard walks the human through it; verify by a `started` event.
- Launcher/recovery (T7/T8): pre-write `[projects."<cwd>"] trust_level = "trusted"` into the account home's `config.toml` before every launch/relaunch; relaunch in the session's cwd; exit sequence Ctrl-C ×2 then SIGTERM/SIGKILL fallback; `codex resume <id> "<continuation>"` with the shared sessions store (`MS_HOME/codex/sessions`, every home's `sessions` a symlink to it).
- Hook (T6): Stop with a wall-like `last_assistant_message` opens NO recovery while `MS_CODEX_AUTOROTATE` is unset; it appends a `wall_text` note event so `status` can show `unreported`.

## Addendum (from the Codex CLI's own account of 0.153.4, with source links; hash recipe verified against the four hashes above)

- **Trusted hash recipe (VERIFIED, all four match):** `sha256:` + sha256 of the compact JSON, keys sorted recursively, no trailing newline, of `{"event_name": "<event_snake>", "hooks": [{"async": false, "command": "<cmd>", "timeout": <t>, "type": "command"}]}` where `t` = 600 by default and 1 for SessionEnd/Interrupt (capped at 3); optional `statusMessage`/`additionalContextLimit` only when set; `matcher` only for SessionStart. Key = `<config path>:<event_snake>:<matcher idx>:<hook idx>`. → The installer pre-trusts by writing `[hooks.state."<key>"] trusted_hash = "sha256:<hex>"` itself. `codex --dangerously-bypass-hook-trust` exists for one invocation (not used).
- **A usage-limit turn fires NO Stop hook.** The quota error path emits an internal `EventMsg::Error` (`UsageLimitExceeded`) and exits the turn; Stop runs only on successful completion. No lifecycle hook carries the quota error; `Interrupt` is user interruption only. The app-server exposes it (`error` notification with `codexErrorInfo: "usageLimitExceeded"`, `turn/completed status: failed`; `account/rateLimits/read` with `rateLimitReachedType`), but the TUI is what runs in the pane.
- **Wall text (default Pro, no reset time):** "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later." — wording varies with reset time, plan, model and workspace limits.

### Ruling for Tasks 6 and 8 (supersedes the plan text)
Hooks remain the only trigger, but the signal is the ABSENCE of Stop: the Codex hook, on `UserPromptSubmit`, records `activity` with the `turn_id` and arms a bounded turn watchdog (`tmux run-shell -b -d 45 "<ms> _turn <session> <turn_id>"`). `ms _turn` exits at once if a `Stop` for that turn (or a later `activity`/`ended`) was recorded; otherwise it captures the pane: if the last turn shows the Codex wall text (`src/wall.ts` pattern from the text above) AND a fresh usage poll for that account reads a window at 100 (the quota evidence the spec demands — never text alone), it appends `rate_limited` (kind `session` or `weekly` by the window) and opens a recovery exactly as the Claude hook does; else it re-arms itself every 45 s until Stop arrives or 30 minutes pass (then it stops silently; `ms status` still shows `unreported` from the screen). `MS_CODEX_AUTOROTATE` defaults to on only after the Codex live matrix observes a real wall; until then the watchdog records the `rate_limited` event and `status` shows it, but no recovery is opened unless `MS_CODEX_AUTOROTATE=1`.
