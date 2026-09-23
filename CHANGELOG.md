# Changelog

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
