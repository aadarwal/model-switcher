# Changelog

## 0.2.2

- PROVIDER column on the accounts table, on the page and in ms status
- MS_HOME is canonicalised at startup, so a symlinked store keeps its hooks
  and trust

## 0.2.1

- a refreshed Claude poll grant is written to the credentials file; ms 0.2.0's
  keychain write-back truncated it (re-login the affected accounts with
  `ms accounts login <name>`)
