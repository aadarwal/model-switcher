# model-switcher

A single command, `ms`, that runs `claude` and `codex` on whichever of your
subscription accounts has room, and — when a running session hits a usage wall
— restarts that same session in the same tmux pane on the next account with
room and tells it to continue. Nothing stays resident: every invocation reads
its state, does its work, and exits.

Requires macOS, Node ≥ 22.15 (for `process.execve` and `node:sqlite`) and
tmux ≥ 3.3. `ms doctor` checks all of it.

## Install

```
brew install aadarwal/tap/model-switcher
ms setup
```

`ms setup` is a resumable wizard: it registers your accounts, signs them in,
installs the hooks that notice a usage wall, offers two optional integrations,
and finishes with `ms doctor`. Everything it writes is listed under
[What `ms setup` changes](#what-ms-setup-changes), and everything it writes can
be undone.

## Commands

### Launching

```
ms claude [--as <account>] [--need any|fable] [-- <claude args>]
ms codex  [--as <account>] [--need any|fable] [-- <codex args>]
```

Picks an account with room and launches that CLI in the current tmux pane,
under that account's credential. `--as` names an account instead of choosing
one; `--need fable` requires headroom in the Fable window as well; Codex refuses it,
because it reports no such window. Anything after `--` goes to the CLI itself.

```
ms attach
```

Adopt the CLI already running in this pane as a managed session, so a wall in
it triggers a rotation.

### While a session is running

```
ms status [--watch] [--json]
ms rotate [<session|pane>] [--force]
ms switch [<session|pane>] --to <account> [--continue] [--force]
ms switch --all --to <account> [--continue] [--force] [--timeout <seconds>]
ms stop   [<session|pane>]
ms dashboard [--port N] [--no-open]
```

`rotate` moves a session to the next account with room — the same move the
wall would have triggered, on demand. `switch` moves it to one you name;
`--continue` tells the resumed session to carry on with what it was doing.
`--force` moves a session that is mid-turn. `stop` un-manages a session
without touching the CLI running in it. `dashboard` serves a local page and
exits about 90 s after the last request.

With no argument, `rotate`/`switch`/`stop` act on the session in the current
pane.

### Accounts

```
ms accounts add <name> [--provider claude|codex] [--label L] [--shared]
ms accounts login <name> [--provider P] [--device-auth]
ms accounts verify <name> [--provider P]
ms accounts remove <name> [--provider P]
ms accounts token <name>
ms accounts ls
```

`add` registers a name with no credentials; `login` mints them; `verify`
re-checks them and the identity behind them. `--device-auth` uses a device
code instead of a browser redirect back to localhost, which is what you want
over SSH. `--provider` is needed only when one name is held by both providers
— names are unique per provider, so a Claude `work` and a Codex `work` are two
different accounts.

### Setup and health

```
ms setup [--resume] [--reset] [--yes] [--repair] [--remove statusline|alias]
ms doctor [--fix]
```

| Flag | What it does |
|---|---|
| `--resume` | Continue at the first step not finished. The default whenever there is progress to resume. |
| `--reset` | Forget how far setup got. Never an account, never a credential, never a hook — only the wizard's own memory. |
| `--yes` | Accept every default and ask nothing. Both opt-ins default to No, so `--yes` installs neither. |
| `--repair` | Re-install the hooks for the accounts already registered, and re-run the final check. No login, no questions. This is the one to run when something (a CLI upgrade, a dotfiles restore, a hand edit) has removed your hooks. |
| `--remove statusline` / `--remove alias` | Undo an optional integration. Both may be given. Each prints what it removed and where the backup went. |

`ms doctor` checks the runtime, tmux, the CLIs, the hooks, file permissions,
the registry, every account's credentials, orphaned session state and the `ms`
on your PATH. `--fix` repairs what is safe to repair — including re-pointing
hooks that name an `ms` that has moved. A dead credential, a malformed
registry and a stray `ms` shadowing this one are reported, never auto-fixed.

## The two credentials a Claude account needs

A Claude account carries two independent credentials, and they are not
interchangeable:

* the **launch grant** — a `claude setup-token`, stored 0600 under
  `MS_HOME/launch/<name>.token`. It runs Claude Code as that account. It is
  inference-scope only and cannot read usage limits.
* the **poll grant** — OAuth profile credentials in that account's own config
  directory (`MS_HOME/claude/<name>`), which is what reads the account's
  remaining usage so the chooser can rank accounts. On macOS `claude auth
  login` puts it in your login keychain, under a service derived from that
  directory; `ms` reads it there. When `ms` refreshes it, the refreshed grant
  is written to `MS_HOME/claude/<name>/.credentials.json` (0600) — which is
  where `ms` looks first — and the keychain item it came from, whose refresh
  token the refresh has just spent, is deleted.

`ms accounts login` mints both, in two browser flows. **Sign in as the same
account in both tabs** — nothing downstream can tell that you did not, and an
account whose two credentials belong to two subscriptions reports one
subscription's limits while running as another.

A Codex account has one credential and no such split: `codex login` writes an
`auth.json` inside that account's own `CODEX_HOME`
(`MS_HOME/codex/<name>`), and `ms` points the CLI at the directory rather than
ever reading the credential itself.

No secret is ever passed on a command line, put in a tmux command, written to
a log, or printed — including in an error message.

## What `ms setup` changes

Everything below is backed up before it is changed (a timestamped copy beside
the file it copied, never overwriting a previous backup), is idempotent on re-run,
keeps every key and line it does not own, is written through a symlink so a
dotfiles-managed file stays a symlink, and is refused outright if it does not
look like something this tool wrote.

| What | Where | Undo |
|---|---|---|
| Claude hooks (4 entries) | `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` | Delete the four entries whose command ends in `_hook claude` |
| Codex hooks + their trust hashes | `MS_HOME/codex/<account>/config.toml`, between `# ms-hooks-begin` and `# ms-hooks-end` | Delete that block |
| Statusline badge (opt-in, default No) | `statusLine` in the same `settings.json` | `ms setup --remove statusline` |
| Shell aliases (opt-in, default No) | `~/.zshrc`, or `~/.bash_profile`/`~/.bashrc`, between `# ms-alias-begin` and `# ms-alias-end` | `ms setup --remove alias` |
| Its own progress | `MS_HOME/setup.json` | `ms setup --reset` |

The hooks are how a usage wall is noticed at all, so removing them turns
rotation off. Re-install them with `ms setup --repair` or `ms doctor --fix`.

Note that a re-point — after `brew upgrade`, or after moving from a checkout
to a brew install — **replaces** this tool's hook entries rather than adding a
second set beside them. Another tool's hooks in the same file, and another
tool's command sharing an entry with ours, are never touched.

## Environment

| Variable | Meaning |
|---|---|
| `MS_HOME` | Where all state lives. Default `~/.config/model-switcher`. Directories 0700, files 0600. Holds `accounts.json`, `state.sqlite`, `snapshot.json`, the per-account Claude config dirs and Codex homes, the launch tokens, and per-session event logs. |
| `MS_BIN` | The absolute path to `ms` that gets written into hook commands, Codex trust hashes, the statusline wrapper and the alias block. The Homebrew shim sets it to `/opt/homebrew/opt/model-switcher/bin/ms` — the stable path, so everything written survives an upgrade. Set it yourself only if you are running `ms` from somewhere unusual. |
| `MS_CODEX_AUTOROTATE` | `1` turns on unattended recovery for Codex sessions. Export it in the shell that runs `codex` (or `ms codex`): `ms` stores the gate from there, so the tmux-dispatched watchdog and recovery worker read it too, and `ms doctor` prints its state. It ships off until a real Codex wall handoff has been observed live. |
| `CLAUDE_CONFIG_DIR` | Claude Code's own override of `~/.claude`. Honoured everywhere this tool reads or writes that settings file. |
| `MS_VERBOSE` | `1` prints what each invocation's start-of-run repair did. |

`MS_ACCOUNT`, `MS_SESSION`, `MS_GENERATION`, `MS_SOCKET` and `MS_PANE` are set
by `ms` inside a managed pane. They identify the session to the hooks; setting
them by hand is not useful.

## How rotation works

1. `ms claude`/`ms codex` picks an account, records a session, and `execve`s
   the CLI in the pane. Nothing of `ms` stays running.
2. The CLI's own hooks call `ms _hook <cli>` on session start, on each prompt,
   and when a turn fails.
3. A failure that reads as a usage wall dispatches a short-lived recovery
   worker, which picks the next account with room, exits the CLI cleanly,
   relaunches it in the same pane resuming the same session, and tells it to
   continue.
4. Every public verb repairs stale state (a closed pane, a restarted tmux
   server, a worker that died) before it does anything else.

## License

MIT. See `LICENSE`.
