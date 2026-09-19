# model-switcher

`ms` runs `claude` (Claude Code) and `codex` (OpenAI Codex CLI) on whichever of your
subscription accounts still has usage room, and when a running session hits a usage wall it
moves that tmux pane onto another account and resumes the same conversation there. It is for
people who hold several Claude or ChatGPT subscriptions and lose working time to a limit.
Nothing stays resident: the CLIs' own hooks are the trigger, tmux supervises, and every `ms`
invocation reads its state, does one job and exits. All state is one directory, `MS_HOME`.

## Requirements

macOS. Node ≥ 22.15 (for `process.execve` and `node:sqlite`). tmux ≥ 3.3. `claude`
and `codex` are installed separately; `ms` needs only the ones your accounts name.

## Quick start

```bash
brew tap aadarwal/tap
brew install model-switcher
ms setup
```

`ms setup` asks how many accounts of each provider you have, checks the prerequisites,
signs each account in, installs the hooks, offers two opt-ins (both default to no), and
ends with `ms doctor`. It marks each step as it finishes, so a run that stops resumes there.

Then launch a CLI from any tmux pane:

```bash
ms claude
ms codex
```

## Commands

### Launch

```
ms claude [--as <account>] [--need any|fable] [--continue] [-- <claude args>]
ms codex  [--as <account>] [--need any|fable] [--continue] [-- <codex args>]
ms adopt  <rollout-id|path> [--as <account>] [--continue] [-- <codex args>]
ms attach
```

- `ms claude` / `ms codex` — pick an account with room and start that CLI in the current tmux pane under the account's credential. Everything after `--` goes to the CLI unchanged.
- `--as <account>` — use the named account instead of choosing one. `--need fable` — also require room in the Fable window; `ms codex` rejects it, because Codex reports no such window.
- `--continue` — for a resume you drove yourself (`ms codex --continue -- resume <id>`, `ms claude --continue -- --resume <id>`): hand the resumed conversation the same continuation a rotation sends, as the command line's own prompt. Refused when there is nothing to continue.
- **A launch that resumes is given no `--session-id`.** `--session-id` makes a conversation, so on a command line that already names one (`--resume <id>`, `-r <id>`, `--resume=<id>`, `--continue`/`-c`) `ms` passes your command line through untouched and records the id it names — Claude Code's own SessionStart confirms it, exactly as it does after a rotation's `--resume` relaunch. `ms claude --continue -- --resume <id>` is the path **`ms import`** resumes every Claude conversation through. Still to be checked against a live Claude Code; if that pairing misbehaves, `ms rotate` / `ms switch --continue` remain the verified way to move a Claude session `ms` already manages.
- `ms adopt` — take over a **Codex** conversation `ms` did not start, so it can be rotated like any other. See [rescuing a pane you didn't start with ms](#rescuing-a-pane-you-didnt-start-with-ms).
- `ms attach` — re-attach to the tool's own tmux server (`MS_HOME/tmux.sock`, session `ms`), where a launch from outside tmux puts the pane.

### Import

```
ms import [--since <window>] [--dir <path>]… [--as <account>] [--continue] [--include-tmux] [--dry-run] [--yes]
ms import --plan <manifest>
ms import --status <manifest>
```

- `ms import` — find the Claude Code and Codex conversations running outside tmux, stop
  each original, and resume the same conversation in a tmux pane under `ms`. See
  [bringing conversations into tmux](#bringing-conversations-into-tmux).
- `--since <window>` — `30m`, `2h` (default), `1d` or `all`. It filters **idle**
  conversations by last activity; a live one is always a candidate, however long ago its
  last turn was.
- `--dir <path>` — repeatable; keep only conversations whose working directory is under
  it. Default: everywhere the scan looks.
- `--as <account>` — put every imported pane on the named account instead of choosing one
  per pane.
- `--continue` — hand every resumed conversation the rotation's continuation. By default
  only a conversation whose process `ms` actually stopped gets one: an idle transcript has
  no unfinished turn to continue.
- `--include-tmux` — list the conversations already in a tmux pane (they are skipped
  either way — a pane `ms` can reach is a pane it can already rotate).
- `--dry-run` — scan, plan, print the table, write the manifest, move nothing.
- `--yes` — skip the confirmation. Without a terminal to ask in, `ms import` refuses
  rather than assuming yes.
- `--plan <manifest>` — run a manifest written earlier: no scan, no question.
- `--status <manifest>` — print that manifest's table, with what became of each row.

Exit codes: 0 everything moved (or nothing had to), 1 at least one row failed, 2 the
command line itself, or a confirmation nobody could answer.

### Running sessions

```
ms status [--watch] [--json] [--all]
ms rotate [<session|pane>] [--force]
ms switch [<session|pane>] --to <account> [--continue] [--force]
ms switch --all --to <account> [--provider claude|codex] [--continue] [--force] [--timeout <seconds>]
ms stop [<session|pane>]
ms dashboard [--port N] [--no-open]
```

- `ms status` — two tables: the account pool as usage sees it, and every managed session. The accounts table ends in SESS, the number of live sessions on that account; `--json` lists them per account (`sessions`) and carries each account's `email`. `--watch` reprints every 5 s; `--json` prints the same rows as JSON. Sessions in state `gone` or `stopped` are hidden by default; `--all` shows them too.
- `ms rotate` — move a session to the next account with room: the move a wall would have made, on demand. Always carries the unfinished work over.
- `ms switch` — move a session to a named account. It carries the work over only when the pane reads as walled; `--continue` always carries it over.
- `ms switch --all` — move every session of that account's provider that is not already on it, four at a time. `--timeout` bounds how long new moves are *started* (default 600 s); a move in flight is never cut off. `--provider` is needed only when the destination name is registered under both providers, same rule as `ms accounts`' own `--provider`.
- `ms stop` — stop managing a session. The CLI in the pane keeps running.
- `ms dashboard` — serve the `ms status` tables on `127.0.0.1`, with rotate, switch and stop buttons. It prints its URL, opens it (unless `--no-open`), and exits about 90 s after the last request, so it is alive only while a tab polls it.
- `--force` moves a session that is mid-turn; without it a busy session is refused. With no `<session|pane>`, `rotate`, `switch` and `stop` act on the current pane.

### Calendar

```
ms calendar [--days N] [--all] [--ics | --json]
```

- `ms calendar` — every account's upcoming limit resets (5h, week, Fable), grouped by local day, soonest first. It reads the same snapshot `ms status` does and never polls on its own. Windows that reset together are one line (`week + fable`); a window with nothing used is left out unless `--all`. `--days` sets the horizon, 1 to 60 (default 8).
- `--ics` — the same events as an iCalendar file: `ms calendar --ics > resets.ics`, then import it. Event UIDs depend only on what resets and when, so importing a newer file updates the events rather than duplicating them. Events are marked free, not busy.
- `--json` — the events with a `googleUrl` each: Google Calendar's own "create event" link, prefilled. `ms` never talks to Google; the link is only a URL, and nothing leaves the machine until you open it.
- `ms dashboard` shows the same list under **Calendar**, with a `+ Google Calendar` link per reset and `Download .ics`. A calendar app on the same machine can subscribe to `http://127.0.0.1:<port>/calendar.ics` while the dashboard is up. Google Calendar cannot subscribe to it — Google fetches feeds from its own servers, and the dashboard listens on `127.0.0.1` only — so for Google use the per-event links or import the file.

### Accounts

```
ms accounts add <name> [--provider claude|codex] [--label L] [--shared]
ms accounts login <name> [--provider P] [--device-auth] [--relogin]
ms accounts verify <name> [--provider P]
ms accounts remove <name> [--provider P]
ms accounts token <name>
ms accounts ls
```

- `ls` — every account under one set of columns. EMAIL, the last one, is the login behind the name as the provider's own profile reported it at `login` or `verify`; it is display only (identity is still decided by the organisation), and an account signed in before this shows `-` until its next `ms accounts verify <name>`.
- `add` — register a name with no credentials yet. `--label` sets the display label; `--shared` marks an account other people also use, which loses ties in the chooser.
- `login` — mint the credentials and record the account's identity. Claude opens two browser flows; `--device-auth` (Codex only) prints a device code instead of redirecting to localhost, which is what you want over SSH. `--relogin` forces a fresh sign-in even when a usable grant is already in place.
- `verify` — re-check an account's credentials and the identity behind them. `remove` — delete the registry row and every credential it names.
- `token` — print the Claude launch token on stdout. `ls` — one row per account: provider, label, org, poll grant, launch token, verified.
- `--provider` is needed only when one name is registered under both. Names are unique per provider, so a Claude `work` and a Codex `work` are two accounts.

### Setup and health

```
ms setup [--resume] [--reset] [--yes] [--repair] [--remove statusline|alias]
ms doctor [--fix]
ms --version
```

`ms doctor` checks the install and `--fix` repairs what is safe; see [Troubleshooting](#troubleshooting). `ms --help` prints the verb list.

| `ms setup` flag | What it does |
|---|---|
| `--resume` | Continue at the first unfinished step. Already the default when there is progress. |
| `--reset` | Forget how far setup got. Touches no account, credential or hook. |
| `--yes` | Take every default and ask nothing. Both opt-ins default to no, so this installs neither. |
| `--repair` | Re-install the hooks for the accounts already registered, then re-run the check. No login, no questions. |
| `--remove statusline` / `--remove alias` | Undo an opt-in. Both may be given in one run. Not combinable with `--repair` or `--reset`. |

## Concepts

### A Claude account holds two credentials

- **Launch grant** — a one-year `claude setup-token`, stored 0600 at `MS_HOME/launch/<name>.token`. It runs Claude Code as that account. It is inference-scope only and cannot read usage limits.
- **Poll grant** — OAuth profile credentials for `MS_HOME/claude/<name>`. They read the account's remaining usage, which is what lets the chooser rank accounts. On macOS `claude auth login` writes them to the login keychain under a service derived from that directory. When `ms` refreshes them it writes the result to `MS_HOME/claude/<name>/.credentials.json` (0600) and deletes the keychain item whose refresh token it just spent.

One `ms accounts login` mints both, in two browser tabs. **Sign in as the same account
in both.** Nothing downstream can detect that you did not, and an account whose two
credentials belong to two subscriptions reports one's limits while running as the other.

A Codex account has one credential and no such split: `codex login` writes `auth.json`
into that account's own `CODEX_HOME` (`MS_HOME/codex/<name>`), and `ms` hands the CLI the
directory, never the credential. No secret is ever passed on a command line, put into a
tmux command, logged or printed.

### Credentials are per device

The token endpoints rotate refresh tokens, so the first refresh on either machine
invalidates a grant copied to the other. Never copy `MS_HOME` between machines; run
`ms accounts login <name>` once per device.

### A wall

A wall is a usage limit reported by the provider itself, never text read off a screen.
For Claude it is Claude Code's `StopFailure` hook firing with `error: "rate_limit"`. For
Codex it is the `task_complete` record in the session's rollout file carrying
`codex_error_info: "usage_limit_exceeded"`, which `ms` tails. A pane that merely quotes
wall text is not a wall.

### What rotation does to a pane

A short-lived worker, dispatched by tmux so it lives outside the walled CLI's process
tree, takes the session lock and rechecks that the wall is still true, the generation has
not moved and the pane still exists. It picks the next account with room, sends the CLI its
own way out (`Escape` then `/exit` for Claude Code, Ctrl-C twice for Codex), and respawns
the *same* pane on the new account running `claude --resume <id> "<continuation>"` (or
`codex resume <id>`). The continuation is an argument to that invocation, never keystrokes
typed into a shell. Four handoffs run at a time across the whole tmux server.

Automatic recovery for Codex is **on**: the wall record was checked against 85 real walled
rollouts and the whole handoff was watched end to end, so `ms` moves a walled Codex session
the way it moves a Claude one — bounded by the caps that make an unattended rotation safe:
one recovery per fresh turn, an exclusive session lock, each candidate account tried at most
once per wall, at most three account changes per session per ten minutes (the fourth parks
it for a human), and a pause until the earliest reset when nothing has room, never a spin.
Export `MS_CODEX_AUTOROTATE=0` in the shell that runs `codex` to turn it off; `ms rotate`,
`ms switch` and `ms stop` move a Codex session either way. Their moves DO count towards the
three-changes window — what is capped is how often a conversation is torn down and brought
back, not who asked — but the cap never refuses a person: it parks only the automatic path.

### Rescuing a pane you didn't start with ms

A `codex` you launched yourself — plain `codex --yolo`, in your own `~/.codex` — has no
session row, no account of ours, and no rollout in the shared store that lets a resume
cross accounts, so `ms rotate` has nothing to move. When such a pane hits a wall, exit the
CLI (Ctrl-C twice) and run **`ms adopt <rollout-id>`** in that same pane. It finds the
rollout under `$CODEX_HOME`/`~/.codex` by id (or takes a path), copies it into
`MS_HOME/codex/sessions` keeping Codex's own `YYYY/MM/DD` layout — together with every
rollout its history points at, because a compacted conversation's file carries only a
`history_base` pointer at the one holding the prefix, and resuming without it fails with
`invalid paginated history lineage for <id>: missing source rollout` — and then launches
the pane exactly as `ms codex [--as <account>] -- <your codex args> resume <id>`. Nothing
in your own Codex home is moved, modified, or overwritten, and a rollout already in the
store is left as it is. Add `--continue` to hand the conversation the rotation's own
continuation; a resume you type yourself sends none. The id is the one `codex resume`
takes: `ls ~/.codex/sessions/*/*/*/` — each file is `rollout-<date>-<id>.jsonl`. Codex
only in this release, and it refuses while a `codex` is still running in the pane, because
it respawns that pane.

### Bringing conversations into tmux

A conversation in a plain terminal tab cannot rotate: there is no pane to respawn and no
row to rotate. A running process cannot be moved into tmux on macOS either — but both CLIs
keep every conversation on disk, keyed by working directory, so the conversation can be
moved even though the process cannot. That is what **`ms import`** does, in one pass:

1. **Find them.** Claude Code's transcripts under `~/.claude/projects` and Codex's rollouts
   under `~/.codex/sessions`, each matched against the process table (`ps`, and `lsof` for
   each process's directory) so a live one is known to be live. Reading only; nothing past
   a transcript's header and first user line is ever read.
2. **Plan the layout.** One tmux session per repo root, one window per worktree (named for
   its branch), four panes to a window; a fifth conversation opens `<window>-2`. Each pane
   gets a command line — `ms claude … --resume <id>`, or `ms adopt <id>` for Codex, which
   copies the rollout and its lineage into the shared store first. Flags are carried over
   from the original process **by whitelist** (`--model`, `--dangerously-…`, `--yolo`, …),
   so a credential you typed on your own command line never reaches the new one.
3. **Show it and ask once.** The table, then `Move N conversations, stopping M live
   processes? [y/N]`. `--dry-run` stops before the question; `--yes` answers it; a stdin
   that is not a terminal is a refusal.
4. **Move them.** Per row: SIGTERM the original (SIGKILL after ten seconds), make the pane,
   type the command, and wait up to a minute for the conversation to report itself through
   the CLI's own hook. A row that fails never stops the next one.

Every run writes a manifest — `MS_HOME/imports/<timestamp>.json`, 0600, rewritten after
every step — and that file is the record to fall back on: each row names the conversation,
its directory, where it went and what became of it (`resumed in data:main.2`,
`stop failed: …`, `resume failed: …`). Your conversations are on disk whatever happened, so
a row that failed can be resumed by hand from what the manifest says. `ms import --status
<file>` prints it back; `ms import --plan <file>` runs it again.

Two things it deliberately does not do: it does not touch a conversation already in a tmux
pane (that one can already be rotated — `--include-tmux` only lists them), and it does not
carry your original prompt over, only the whitelisted flags.

### The chooser

An account is out if its reading failed, if it has no weekly window, or if any window it
needs is at 100 percent. The rest rank by earliest weekly reset, then most remaining, then
solo before shared. No projections, no thresholds below 100.

### What the wizard changes on your machine

Every file below is backed up first (a timestamped copy beside it, never overwriting an
earlier one), is idempotent on re-run, keeps every key and line `ms` does not own, is
written through a symlink so a dotfiles-managed file stays a symlink, and is refused if it
does not look like something `ms` wrote.

| What | Where | Undo |
|---|---|---|
| Claude hooks: `SessionStart`, `UserPromptSubmit`, `StopFailure` (`rate_limit`), `SessionEnd` | `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` | Delete the four entries whose command ends in `_hook claude` |
| Codex hook tables and their computed trust hashes | `MS_HOME/codex/<account>/config.toml`, between `# ms-hooks-begin` and `# ms-hooks-end` | Delete that block |
| Statusline wrapper (opt-in, default no) | `statusLine` in the same `settings.json` | `ms setup --remove statusline` |
| Shell aliases for `claude` and `codex` (opt-in, default no) | `~/.zshrc`, or `~/.bash_profile` / `~/.bashrc`, between `# ms-alias-begin` and `# ms-alias-end` | `ms setup --remove alias` |
| The wizard's own progress | `MS_HOME/setup.json` | `ms setup --reset` |

The hooks are how a wall is noticed at all, so removing them turns rotation off. Put them
back with `ms setup --repair` or `ms doctor --fix`; neither re-runs a login. A re-point
after `brew upgrade` replaces this tool's hook entries rather than adding a second set
beside them, and never touches another tool's hooks in the same file.

## Configuration

`MS_HOME` (default `~/.config/model-switcher`) holds everything: `accounts.json`,
`state.sqlite`, `locks.sqlite`, `snapshot.json`, `last-pick.json`, launch tokens under
`launch/`, per-account Claude config dirs under `claude/`, per-account Codex homes under
`codex/` (each linked to the one shared rollout store `codex/sessions/`, so a resumed
conversation can cross accounts), per-session event logs under `sessions/`, one manifest
per `ms import` run under `imports/`, and the tool's own tmux socket. Directories are 0700 and files 0600. `accounts.json` now also holds each
account's e-mail, as the provider's own profile reported it at `login`/`verify` — display
only, and stored at rest in that same 0600 file.

| Variable | Meaning |
|---|---|
| `MS_HOME` | Where all state lives. Default `~/.config/model-switcher`. |
| `MS_BIN` | The absolute `ms` path written into hook commands, Codex trust hashes, the statusline wrapper and the alias block. The Homebrew shim sets it to `/opt/homebrew/opt/model-switcher/bin/ms` — the stable path, so everything the wizard wrote survives an upgrade. Set it yourself only when running `ms` from somewhere unusual. |
| `MS_CODEX_AUTOROTATE` | Automatic recovery for Codex sessions. Unset, empty, or exactly `1` is **on**; **every other value reads as off** — `0`, but `false`, `no` and a typo too, because only `1` is read as yes. Export it in the shell that runs `codex`: an `ms` that sees it mirrors the answer into the store, so the tmux-dispatched watchdog and worker read it too. A mirrored `off` is a stored row and outlives the variable — unsetting it later does not turn recovery back on; export `MS_CODEX_AUTOROTATE=1` (and run an `ms codex`, which mirrors) to do that. `ms doctor` prints the state it will act on. Ships on. |
| `CLAUDE_CONFIG_DIR` | Claude Code's own override of `~/.claude`. Honoured everywhere `ms` reads or writes that settings file. |
| `MS_VERBOSE` | `1` prints what each invocation's start-of-run repair did. |
| `MS_ENTRY` | `src` or `dist` — which entry point `bin/ms` runs. For development; the brew shim sets `dist`. |

`MS_SESSION`, `MS_GENERATION`, `MS_SOCKET`, `MS_PANE` and `MS_ACCOUNT` are exported by `ms`
into a managed pane, to identify the session to the hooks.

## How it works

1. `ms claude` / `ms codex` reads every account's usage, ranks the pool, and picks one.
2. It records the session, then `execve`s the CLI into the pane. No `ms` process stays running.
3. The CLI's own hooks call `ms _hook <cli>` on session start, on each prompt, and when a turn fails.
4. A first-party rate-limit report is written to the session's event log as a wall.
5. The hook dispatches `ms _recover <session>` through tmux, outside the CLI's process tree.
6. That worker takes the session lock, rechecks the wall, and picks the next account with room.
7. It asks the CLI to exit, then respawns the same pane resuming the same conversation on the new account.
8. If nothing has room, the session waits and a wake-up is scheduled.
9. Every public verb first repairs stale state — a closed pane, a restarted tmux server, a dead worker.
10. `ms status` and `ms dashboard` read that same store. No daemon, no background poller.

## Troubleshooting

Start here. `ms doctor` checks the runtime, tmux, the CLIs, the hooks, store permissions,
the registry, every account's credentials and usage reachability, orphaned session state,
and whether the `ms` on your PATH is the one the hooks name.

```bash
ms doctor
ms doctor --fix
```

`--fix` repairs only what is safe: hooks that name an `ms` that moved, a Claude poll grant
due for refresh, store paths whose mode drifted, a missing Codex `sessions` link or shared
store, and orphaned session state. It never repairs a dead credential, a malformed
`accounts.json`, a symlink inside the store, or an `ms` on PATH that shadows this one.

```bash
ms setup --repair                     # hooks removed by a CLI upgrade or a dotfiles restore
ms accounts login <name> --relogin    # a grant that is dead rather than stale
ms setup --remove statusline          # undo the statusline opt-in
ms setup --remove alias               # undo the shell aliases
MS_VERBOSE=1 ms status                # show what the start-of-run repair did
```

A Claude account with no poll grant can launch but cannot be ranked; one with no launch
token can be ranked but cannot be run. Both come from `ms accounts login`.

The doctor's identity line runs the same organisation check `ms accounts verify` runs, on
the grant itself, so the two never disagree; a grant that resolves to another registered
account's organisation is reported with the `--relogin` that fixes it. When the check could
not run this time, the line says `identity verified at login (not re-checked)`.

## Development

```bash
npm test          # node:test over test/*.test.ts, against src/
npm run typecheck # tsc --noEmit
npm run build     # esbuild bundle to dist/ms.js, then verify it
npm run release -- vX.Y.Z --dry-run
npm run release -- vX.Y.Z --publish [--tap <path>]
```

The release script refuses a dirty tree, a version that does not match `package.json`, an
existing tag, or a HEAD on no remote branch. It builds the tarball and prints its sha256;
`--publish` also creates the GitHub release and commits the rendered formula into a local
tap checkout. It never pushes.

## Licence

MIT. See [LICENSE](LICENSE).
