# Changelog

## Unreleased

- Codex 0.161.0 moved the usage page its wall links to from chatgpt.com/codex/settings/usage to
  chatgpt.com/settings/usage. The link anchor `ms status` names a Codex wall by, when the link is
  the first line of the wall on screen, matches both again. The nightly canary now looks for the
  link inside the wall's own sentence, because Codex's /status card links the same page (#39,
  #42). Rotation never depended on it: a Codex wall is read from the rollout record, not the
  screen

## 0.3.13

- `ms claude mesh` / `ms codex mesh` (with the launcher's usual arguments after it): choose
  the account by hand. An fzf picker — a tmux popup in a pane with fzf 0.53+ that a terminal
  client is watching, full screen otherwise (outside tmux, in a display-popup, or in a pane
  with no client or only a control-mode one, which cannot draw a popup) — lists the
  provider's accounts in the chooser's own ranking, `★` on what a plain launch would pick
  (its remembered pick when usage is unreachable) and `✗` on what it cannot use, with a
  preview per account (e-mail, rank, window bars and resets, whether this device can launch
  it, the panes on it, the reading's age). ctrl-r takes a fresh reading and redraws the rows,
  the previews and the status line; with fzf 0.71+ the cursor stays on its account. Without
  fzf, a numbered menu on the terminal. A hand pick is never written as the last pick
- ctrl-r's reading (`ms _mesh_rows`) is taken by a detached `ms _mesh_poll` of the picker's
  own accounts: fzf kills a reload's process group when ctrl-r is pressed again or the
  picker closes, and a token refresh cut off there would have left the account's grant spent
- the chosen account is launched pinned (`pinnedAccount` on the session row, added to an
  existing store when it is opened — two processes doing that at once no longer fail the
  second): rebalance refuses the session ("pinned to <account> by hand"), `ms status`'s
  BETTER and the dashboard's chip read `pinned`, and `--json` carries `pinnedAccount`. A wall
  still rotates it, and every account change (a rotation, `ms rotate`, `ms switch`) ends the
  pin
- picking an account with no room launches it anyway after one warning line; one with no
  credential on this device keeps the launch's usual refusal. `mesh` is refused beside `--as`,
  twice, or without a terminal (exit 2)
- new exit code 130 for `ms claude` / `ms codex`: the picker was cancelled, and nothing was
  launched or written. A signal while it is open (its pane or terminal closing, a kill) is a
  cancel too, exiting 128 + the signal's number, and still removes the picker's directory

## 0.3.12

- Codex 0.160 lets one process write a conversation, and an account's background server keeps
  a conversation it loaded for ~60 s after the pane's window closed, so a rotation, `ms switch`,
  rebalance or `ms adopt`/`import` resume in that minute opened a read-only view ("This
  conversation is open in another app") with the continuation unsent, then parked after 60 s.
  Now:
  - a handoff ends only the pane's own CLI, then waits (up to 75 s) for the conversation's
    writer lock to be free before relaunching. Nothing is stopped or signalled, because the
    server hosts other panes' conversations. A conversation that stays open is parked with
    the reason
  - a relaunch that still lands on the lock card is ended, waited for and respawned once, which
    sends the continuation as its argument (R in the TUI would only restore it as a draft). A
    second lock card parks with the reason. The card counts only when the pane's own process
    does not hold the conversation's lock file: a resumed conversation whose history quotes the
    card's words is still its writer, and is never ended or sent the continuation twice
  - `ms codex -- resume <id>` (and adopt/import) waits the same way and refuses if the lock stays
    held, launching nothing
  - Codex ≥ 0.157 panes run in-process (`--no-daemon`, added at exec time). The lock is released
    when the pane exits, and hooks report with the pane's own `MS_*` environment, not that of
    whichever pane started the account's shared server
  - `flagsForResume` drops a stored resume id even when flags stand between `resume` and the id
    (`resume --no-daemon <id>`)

## 0.3.11

- Claude Code 2.1.288+ panes read as busy again: it no longer prints "esc to interrupt", so
  a live spinner line above the prompt (`✻ Sprouting… (1m 14s · …)`) now counts, while a
  finished `✻ Worked for …` line and spinner text quoted in a tool result do not (PR #32)
- a Claude pane still running background work (a workflow, a subagent, background shells
  or monitors) is never relaunched: rotate/switch and the recovery transaction refuse it
  (naming what they saw; `--force` overrides), rebalance skips it as `background-work`, and
  a pane in copy-mode is refused too; walled panes and `ms stop` are unchanged (PR #32)
- `src/compat.ts` names the newest verified CLIs (Codex 0.160.0, Claude Code 2.1.289);
  `ms doctor` prints both against it, and a user-facing verb prints one stderr line when a
  newer, not-yet-verified CLI is on `PATH` (PR #31)
- at most once a day a user-facing verb checks GitHub for a newer `ms` in the background
  (one unauthenticated GET) and the next verb prints `ms X.Y.Z is available`;
  `MS_NO_UPDATE_CHECK=1` or `CI` turns it off (PR #31)
- CI runs typecheck, tests and build on every pull request (macOS and Ubuntu); a nightly
  canary installs the newest Codex and Claude Code and checks what `ms` keys on, opening an
  issue per CLI version when it fails (PR #31)
- `ms _statusline` no longer exits 1 with EPIPE when the wrapped command never reads stdin
  (PR #31)
- `scripts/release.mjs` commits the tap formula with the Com8 co-author trailer in place of
  the pre-rename Homi one — exactly the three standard trailers, once each

## 0.3.10

- codex homes inherit the hook trust `~/.codex/config.toml` already granted (plugin keys
  verbatim, linked hooks re-keyed to the home with the same hash), follow the base when it
  re-trusts, and keep trust Codex wrote in the home on every re-render — no more
  "Hooks need review" on every launch and rotation (#24)
- `ms stop`, `ms rotate`/`switch`, recovery and reconciliation never act on a pane a later
  session took over; a launch or adopt into a pane closes out any older row on it (#22)
- a tmux server that has exited (e.g. the pre-0.3.8 `MS_HOME/tmux.sock`) is gone, not
  unreadable: its rows are stopped by the next verb, `ms doctor` flags exactly what
  `--fix` repairs, and a failing repair is reported instead of swallowed (#21)
- `ms claude --continue` with a bare `--resume`/`-r` (the picker, no id) is refused with a usage
  error: the appended continuation became `--resume`'s value, i.e. the picker's search text,
  leaving the pane in the picker with no conversation and the row with no cliSessionId (#26)

## 0.3.9

- Codex 0.157's per-home daemon state (app-server-control, app-server-daemon, sockets, locks)
  stays per account and is never shared — sharing it would make every account run as one

## 0.3.8

- outside tmux, import and launch use the default tmux server (sessions show in `tmux ls`);
  the private socket is now only the `MS_TMUX_SOCKET` override
- `ms attach [session]` attaches to the default server's `ms` session or the named one
  (an import's repo session); with no such session it prints the `tmux ls` to run
- import manifests record `server` as `default`, `current` or `socket:<path>`, and
  `--status` prints it; an older manifest's `ms` reads as `socket:MS_HOME/tmux.sock`
- migration: a private-socket server started before 0.3.8 keeps running with its sessions;
  reach it with `MS_TMUX_SOCKET=~/.config/model-switcher/tmux.sock ms attach` (or your
  `MS_HOME`'s `tmux.sock`), or `tmux -S <that path> attach`

## 0.3.7

- e-mails backfill on their own (doctor, status, the poll) for accounts signed in before
  0.2.6 — one profile read per account per process, and a read that fails leaves `-`
- `ms status` shows EMAIL, the last column of the accounts table
- `ms accounts label <name> <text>` names a row (LABEL in `ms status` and `ms accounts ls`);
  a label equal to the name is the default

## 0.3.6

- codex accounts share your own ~/.codex conversations, memories and history — only
  auth.json and the rendered config differ per account; existing per-account stores are
  merged in and kept as backups

## 0.3.5

- codex accounts run with your own `~/.codex/config.toml` (model, reasoning
  effort, MCP servers) plus the hooks — rendered on every launch

## 0.3.4

- rebalance: a sooner weekly reset is reason enough to move an idle session
  (the half-used clause is gone), and it is on by default (MS_REBALANCE=0
  disables)

## 0.3.3

- the statusline wrapper no longer drops output a wrapped command wrote just
  before it was killed for hanging; its bound is tunable (`MS_STATUSLINE_TIMEOUT_MS`)
  and the wrapper tests no longer depend on wall-clock timing

## 0.3.2

- rebalance: at the end of a turn, an idle session moves to the account the
  chooser would pick for it now — when a window it gates on is at 85 % or
  more and the destination has 30 % room, or when the best account's week
  resets 24 h earlier and this one's is half spent. Never mid-turn, never a
  parked/waiting/stopped session, at most one move per hook run, and under
  the 6 h / 30 min hysteresis guards; the move is the `ms switch`
  transaction with no continuation. Off unless `MS_REBALANCE=1`
- `ms status` ends its sessions table with BETTER — where that rule would
  put each session right now, `—` when it is already there — and
  `--json` / `/api/state` carry it as `better` (additive)
- `ms rebalance [--dry-run] [--session <id>]` asks the same question for the
  whole fleet and prints SESSION, ACCOUNT, BETTER, REASON, OUTCOME; without
  `--dry-run` it makes the moves, one at a time, waiving the 6 h cooldown for
  an explicit run but never the wall guard or the mid-turn refusal
- the dashboard gains a Rebalance control beside "Move every pane" (the plan
  first, then the run) and a quiet `better:` chip on each session row
- `ms doctor` prints the rebalance gate's state, like the Codex one
## 0.3.1
- `ms import` adopts a Codex conversation by its rollout's own path, not by its id: the
  pane runs a fresh shell that inherits no `CODEX_HOME`, so an id from a conversation
  running under an `ms`-managed Codex home was looked up under `~/.codex` and not found.
  `ms adopt` takes a path, and resolves that file's lineage from its own sessions tree
- an imported pane whose command has returned to a shell fails now rather than at the
  sixty-second bound, with the line the command printed: the wait watches the pane's
  `#{pane_current_command}` as well as the store, and three shell readings after the pane
  has been something else (or five seconds in, if it never was) is a resume that has
  already refused
- `ms import` lists a conversation once when its CLI is two processes: an npm-installed
  Codex is `node …/codex` plus its native child on one tty, and the one that did not claim
  the conversation was reported as its own `live, no conversation found` row. Matching
  processes sharing a tty collapse to the lowest pid — the parent
- and when stopping that parent needs the SIGKILL fallback, its descendants go with it,
  leaves first: a wrapper forwards a SIGTERM but nothing forwards a SIGKILL, so the native
  child used to be orphaned still holding the conversation. The row says
  `killed pid <pid> and N children`
## 0.3.0
- `ms import` brings conversations running outside tmux into it: it finds every Claude
  Code and Codex conversation on the machine (`--since 30m|2h|1d|all`, `--dir <path>`),
  plans a tmux layout of one session per repo root and one window per worktree, stops each
  original process, and resumes the same conversation in a pane under `ms`
- every run writes a manifest (`MS_HOME/imports/<timestamp>.json`, 0600) that records what
  became of each row and can be re-run (`--plan`) or printed back (`--status`);
  `--dry-run` plans without moving anything, and without a terminal to confirm in the verb
  refuses rather than assuming yes
- flags are carried into an imported pane by whitelist, so a credential on the original
  command line reaches neither the new command line nor the manifest
- an import never signals a pid it cannot re-identify: the manifest records when each
  process started, and `--plan` re-reads the process table and refuses (`stop refused: …`)
  when the pid has since been re-used, so a manifest run hours later cannot kill a stranger
- a conversation is reported resumed only on the store row that names it, so two
  conversations in one directory can never be reported back on one row
- a Claude launch that RESUMES is no longer given a `--session-id`: `ms claude --
  --resume <id>` now runs `claude --resume <id>` and records that conversation's own id,
  instead of running two contradictory answers to which conversation it is and recording
  a uuid the CLI never used. This is the path `ms import` resumes every Claude
  conversation through
- `ms setup` gains a step, after the hooks and before the opt-ins, offering to move
  conversations running outside tmux into it (default no): it scans, offers a numbered
  choice of directories and an activity window, shows the plan, and on confirmation runs
  the same executor `ms import` does, recording the manifest path in `setup.json`

## 0.2.6

- `npm test` scrubs `CLAUDE_CONFIG_DIR`, `MS_HOME`, `CODEX_HOME` and `MS_BIN` from its own environment, so a developer's real Claude config is never written by the suite
- an account's e-mail, as the provider's own profile reports it, is kept in
  the registry at `ms accounts login`/`verify` and shown by `ms accounts ls`
  (EMAIL, last column), in `ms status --json` and under the name on the page;
  accounts signed in before this show `-` until their next verify
- the pool says what runs on each account: a SESS count closes the `ms status`
  accounts table, and each card on the page lists its live sessions by pane
- `ms calendar` lists every account's upcoming limit resets (5h, week, Fable)
  by local day; `--ics` writes an iCalendar file, `--json` adds an "Add to
  Google Calendar" link per event, `--days N` sets the horizon, `--all` keeps
  windows with nothing used
- the dashboard gains a Calendar section with the same events, a Google
  Calendar link on each, and `/calendar.ics`

## 0.2.5

- `ms adopt <rollout-id>` takes over a Codex conversation ms did not start: it
  copies the rollout and everything its history points at into the shared
  store, then relaunches the pane on `codex … resume <id>`
- `ms claude`/`ms codex`/`ms adopt --continue` hand a resume you drove
  yourself the same continuation a rotation sends
- an account whose 5h or weekly window reads 100 is `no room`, not `ok`, in
  ms status and on the page
- a session launched on a resume reads `running` once its hook reports, rather
  than sitting in `launching` until reconciliation parks it

## 0.2.4

- Automatic Codex recovery is on by default (MS_CODEX_AUTOROTATE=0 disables):
  the wall record is verified against real rollouts and the full handoff was
  observed live
- at most three account changes per session per ten minutes, then the session
  parks
- task_complete and turn_complete both read as the end of a turn
- scripts/codex-wall-mock.mjs reproduces a Codex usage wall locally

## 0.2.3

- ms dashboard wears the home dashboard's language: provider groups, account
  cards with window lanes, a session ledger

## 0.2.2

- PROVIDER column on the accounts table, on the page and in ms status
- MS_HOME is canonicalised at startup, so a symlinked store keeps its hooks
  and trust
- a refused sign-in is discarded: when the login's identity check turns a browser
  login away, the grant it just wrote is removed and the account is left as it was;
  a pre-existing credential is never touched (proved by content, not assumed)
- `ms accounts login <name> --relogin` forces a fresh sign-in even when a usable
  grant exists; the old grant is replaced only after the new one passes the check
- `ms doctor` runs `verify`'s organisation check on the grant itself, and says
  `identity verified at login (not re-checked)` when it could not run
- ms switch --all --provider, and the page's provider select reaches the
  fleet move
- ms status and the page hide finished sessions by default (ms status
  --all)
- ms dashboard: a wake-up time, a weekly reset and every other date on the
  page rendered nothing — the compiler had inserted a `__name` helper into
  the embedded client function, which the browser's script scope does not
  have

## 0.2.1

- a refreshed Claude poll grant is written to the credentials file; ms 0.2.0's
  keychain write-back truncated it (re-login the affected accounts with
  `ms accounts login <name>`)
