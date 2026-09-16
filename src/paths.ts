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
  hooksDir: () => sub("hooks"),
};
export function ensureStore(): void {
  // Locks live in one file, MS_HOME/locks.sqlite (src/lock.ts) — there is
  // no locks/ subdirectory to create; the mkdir-lock design that once used
  // one is gone.
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
