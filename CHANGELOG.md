# Changelog

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

## 0.2.1

- a refreshed Claude poll grant is written to the credentials file; ms 0.2.0's
  keychain write-back truncated it (re-login the affected accounts with
  `ms accounts login <name>`)
