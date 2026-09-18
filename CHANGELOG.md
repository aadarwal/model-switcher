# Changelog

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
