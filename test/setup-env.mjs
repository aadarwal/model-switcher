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
