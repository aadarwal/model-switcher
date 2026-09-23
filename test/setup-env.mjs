// Loaded before every test file (see package.json's "test" script, `--import`).
//
// The suite isolates HOME and MS_HOME per test, but four variables OUTRANK HOME
// inside `ms`, and a developer's shell may export any of them:
//
//   CLAUDE_CONFIG_DIR  Claude Code's override of ~/.claude. With it set, every
//                      test that installs hooks or the statusline wrapper wrote
//                      into the developer's REAL settings.json -- measured
//                      2026-09-18: `npm test` left four `_hook claude` entries
//                      pointing at a deleted /tmp stub in a live config shared
//                      by five running sessions, plus 25 backup files beside it.
//   MS_HOME            the real store, for any test that forgets to set its own.
//   CODEX_HOME, MS_BIN the same class: ambient state a test never asked for.
//
// Deleting them here, once, in the runner's own process covers both halves of
// the suite: in-process tests read `process.env` directly, and `run()` in
// test/helpers.ts spreads `process.env` into every child. A test that WANTS one
// of these still sets it explicitly, exactly as before.
export const SCRUBBED = ["CLAUDE_CONFIG_DIR", "MS_HOME", "CODEX_HOME", "MS_BIN", "MS_ACCOUNT", "MS_SESSION", "MS_GENERATION", "MS_SOCKET", "MS_PANE"];
for (const name of SCRUBBED) delete process.env[name];

// MS_CODEX_BASE_CONFIG is the fifth of that class and the one that cannot be
// fixed by DELETING it: unset, `ms` renders every Codex home from the
// developer's real `~/.codex/config.toml`, and HOME is not isolated for the
// in-process half of the suite. So it is PINNED at a path inside a directory
// that is never created — a base that is simply absent, which is the case
// every test renders against unless it points this at a fixture of its own.
import path from "node:path";
import { tmpdir } from "node:os";
export const ABSENT_CODEX_BASE = path.join(tmpdir(), `ms-test-no-codex-base-${process.pid}`, "config.toml");
process.env.MS_CODEX_BASE_CONFIG = ABSENT_CODEX_BASE;

// Since 0.3.6 two more cannot be left to a default, because the default is
// no longer only READ. A codex home is linked into the human's own
// `~/.codex` on every launch (src/codex-share.ts): entries are moved into it,
// merged into it, and the store at MS_HOME/codex/sessions is merged into it
// once and replaced by a link. A test that reached either real directory
// would move the developer's own conversations. So both are PINNED at temp
// directories of this process's own — MS_HOME as the store a test that
// forgets its own falls back to, MS_CODEX_BASE_DIR as the base — and a test
// that cares about either (most do) still sets its own, per test.
export const TEST_MS_HOME = path.join(tmpdir(), `ms-test-store-${process.pid}`, "model-switcher");
process.env.MS_HOME = TEST_MS_HOME;
export const TEST_CODEX_BASE = path.join(tmpdir(), `ms-test-codex-base-${process.pid}`, ".codex");
process.env.MS_CODEX_BASE_DIR = TEST_CODEX_BASE;
