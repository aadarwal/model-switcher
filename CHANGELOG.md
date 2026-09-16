# Changelog

## 0.2.2

- a refused sign-in is discarded: when `ms accounts login`'s identity check
  turns a browser login away, the grant that login just wrote — the keychain
  item, the credentials file, or both — goes with it, so the account is left
  as it was instead of polling an organisation it does not own. A launch token
  minted for a refused identity is discarded too, and the one it replaced comes
  back. A credential that was there before and was not replaced is never touched.
- `ms accounts login <name> --relogin` signs in again even when a usable poll
  grant is already in place — the way past a grant that works but belongs to
  the wrong account. The grant it replaces is only let go once the new one has
  passed the identity check.
- `ms doctor` runs `verify`'s organisation check on the grant itself, so the
  two can no longer disagree about one credential; `--fix` never touches an
  identity.

## 0.2.1

- a refreshed Claude poll grant is written to the credentials file; ms 0.2.0's
  keychain write-back truncated it (re-login the affected accounts with
  `ms accounts login <name>`)
