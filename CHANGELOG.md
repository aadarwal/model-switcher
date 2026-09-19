# Changelog

## Unreleased

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
