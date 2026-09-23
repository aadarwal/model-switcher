import { mkdirSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The one place `MS_HOME` is resolved — canonicalised here so every derived
 * path (the registry, CODEX_HOME, the Codex hook's trust-hash key, …) is the
 * real path, not a symlink to it. Codex keys hook trust on the config path
 * IT sees, which is the real path; deriving ours from an un-canonicalised
 * `MS_HOME` (e.g. a symlink to the real store) would silently disagree with
 * Codex about that path, so `ms doctor` reports hooks as not installed and
 * Codex can refuse hooks `ms` believes it installed.
 *
 * `realpathSync` only when the target exists — before the first `ms setup`
 * creates it, there is nothing to resolve, so the literal path is used (and
 * `ensureStore` below creates that same literal path, 0700, as today).
 */
export function msHome(): string {
  const raw = process.env.MS_HOME || path.join(process.env.HOME || homedir(), ".config", "model-switcher");
  return existsSync(raw) ? realpathSync(raw) : raw;
}
const sub = (...s: string[]) => path.join(msHome(), ...s);
export const p = {
  get registry() { return sub("accounts.json"); },
  get state() { return sub("state.sqlite"); },
  get snapshot() { return sub("snapshot.json"); },
  get lastPick() { return sub("last-pick.json"); },
  sessionDir: (id: string) => sub("sessions", id),
  eventsFile: (id: string) => sub("sessions", id, "events.jsonl"),
  recoverLog: (id: string) => sub("sessions", id, "recover.log"),
  launchToken: (name: string) => sub("launch", `${name}.token`),
  claudeConfigDir: (name: string) => sub("claude", name),
  codexHome: (name: string) => sub("codex", name),
  /** The rollout store as this tool reads it: `MS_HOME/codex/sessions`, a
   *  symlink to the base's own `sessions` (`codexBaseDir()`, `~/.codex`).
   *
   *  Until 0.3.6 this was a real directory, and every account home linked its
   *  `sessions` here — a store of this tool's own, which is why an `ms` pane
   *  could never resume a conversation started in a plain `codex`. Now the
   *  store IS the human's, every home links straight to it
   *  (src/codex-share.ts), and this path survives as the link that turns it
   *  into one: `ms adopt`, `ms import` and a rotation's rollout search all
   *  read the store through it, so none of them has to know where the base
   *  is, and a machine that has not been re-linked yet still reads the old
   *  store here rather than nothing. */
  codexSessions: () => sub("codex", "sessions"),
  /** An account home's own `sessions` entry — since 0.3.6 a symlink to the
   *  base's `sessions`, like every other entry the home shares. Named here so
   *  nothing has to rebuild the path by hand. */
  codexSessionsLink: (name: string) => sub("codex", name, "sessions"),
  hooksDir: () => sub("hooks"),
};
export function ensureStore(): void {
  // Locks live in one file, MS_HOME/locks.sqlite (src/lock.ts) — there is
  // no locks/ subdirectory to create; the mkdir-lock design that once used
  // one is gone.
  // `codex/sessions` is deliberately NOT here any more. Since 0.3.6 it is a
  // symlink to the base's own `sessions` (src/codex-share.ts makes it), and
  // creating it here as a directory would rebuild the very store that
  // release retired — while chmod'ing through the link would change the mode
  // of the human's own `~/.codex/sessions`.
  for (const d of [msHome(), sub("claude"), sub("codex"), sub("launch"), sub("sessions"), sub("hooks")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}
export function ensureSessionDir(id: string): string {
  const d = p.sessionDir(id);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Absolute path to the `ms` binary, for callers (e.g. hooks) that need one
 * regardless of cwd. `MS_BIN` overrides; otherwise resolved relative to this
 * module's own location (`<repo>/bin/ms`). */
export function msBinary(): string {
  return process.env.MS_BIN || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ms");
}

/**
 * The human's OWN Codex home — `~/.codex`, the directory a plain `codex`
 * runs out of — and, since 0.3.6, the directory every account home of this
 * tool is a VIEW of (src/codex-share.ts): each home keeps its own `auth.json`
 * and a rendered `config.toml`, and every other entry is a symlink into this
 * one.
 *
 * Deliberately NOT `$CODEX_HOME`. Inside a pane this tool launched, that
 * variable names the ACCOUNT home, and a base that resolved to the home would
 * have the home link its entries at themselves.
 *
 * `MS_CODEX_BASE_DIR` overrides it, and the test suite pins it at a temp
 * directory (test/setup-env.mjs) so that no test can ever link, move or merge
 * anything in the developer's real `~/.codex`.
 */
export function codexBaseDir(): string {
  const override = process.env.MS_CODEX_BASE_DIR;
  if (override && override.length > 0) return override;
  return path.join(process.env.HOME || homedir(), ".codex");
}

/**
 * The user's OWN Codex configuration — the base every account home's
 * `config.toml` is rendered from (`src/hooks/codex-install.ts`).
 *
 * Codex 0.156 has no way to layer a home's config on top of another file:
 * `CODEX_HOME` is the only path variable, and `-p/--profile` layers
 * `$CODEX_HOME/<name>.config.toml` over `$CODEX_HOME/config.toml` — both
 * inside the home `ms` gives the account, so neither can reach the human's
 * own `~/.codex/config.toml`. So the model, the reasoning effort and the MCP
 * servers are COPIED into each home instead, and this is where that source
 * is named. It is only ever READ; nothing in this tool writes to it.
 *
 * `MS_CODEX_BASE_CONFIG` overrides it. The test suite pins it at a path that
 * does not exist (see test/setup-env.mjs), which is how the suite renders
 * homes without ever reading the developer's real `~/.codex/config.toml`.
 * Unset, it is `config.toml` in `codexBaseDir()` — the one base directory —
 * so `MS_CODEX_BASE_DIR` alone moves both.
 */
export function codexBaseConfigPath(): string {
  const override = process.env.MS_CODEX_BASE_CONFIG;
  if (override && override.length > 0) return override;
  return path.join(codexBaseDir(), "config.toml");
}

/**
 * Claude Code's own settings file — where its hooks and its statusline live.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's OWN override of where `~/.claude`
 * is, so anything that writes into that file (the hook installer, the
 * statusline installer), anything that checks it (`ms doctor`) and the
 * statusline wrapper that reads it back at runtime must all honour it — an
 * installer and its check that disagree about the path are an install that
 * never takes effect and a doctor that cannot say why. Defined here, beside
 * the other paths, so there is exactly one spelling of it.
 */
export function claudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = configDir && configDir.length > 0 ? configDir : path.join(process.env.HOME || homedir(), ".claude");
  return path.join(dir, "settings.json");
}
