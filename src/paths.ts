import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function msHome(): string {
  return process.env.MS_HOME || path.join(process.env.HOME || homedir(), ".config", "model-switcher");
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
  /** The ONE rollout store every Codex home of this tool links its own
   *  `sessions` at. Codex records a session's rollout under `$CODEX_HOME/
   *  sessions`, so a per-account CODEX_HOME would give every account its own
   *  island and a rotation could not resume a session started under another
   *  account. Sharing the directory — and never an account's name — is what
   *  lets `codex resume <id>` cross accounts. */
  codexSessions: () => sub("codex", "sessions"),
  /** Where that store is reached from inside ONE account's home: the symlink
   *  `add` creates and `remove` unlinks. Named here so the two sides of the
   *  link are one edit, and so nothing has to rebuild the path by hand. */
  codexSessionsLink: (name: string) => sub("codex", name, "sessions"),
  hooksDir: () => sub("hooks"),
};
export function ensureStore(): void {
  // Locks live in one file, MS_HOME/locks.sqlite (src/lock.ts) — there is
  // no locks/ subdirectory to create; the mkdir-lock design that once used
  // one is gone.
  // `codex/sessions` is the SHARED rollout store (p.codexSessions), not an
  // account home: it is created here, once, so the first `accounts add
  // --provider codex` has something to point its `sessions` symlink at.
  for (const d of [msHome(), sub("claude"), sub("codex"), sub("codex", "sessions"), sub("launch"), sub("sessions"), sub("hooks")]) {
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
