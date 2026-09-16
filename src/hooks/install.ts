import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { backupThroughLink, resolveTarget, shellQuote, writeAtomicThroughLink } from "../fsx.ts";

type HookCommand = { type: string; command: string };
type HookEntry = { matcher?: string; hooks: HookCommand[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookEntry[]> };

/** The events the Claude hook subscribes to, with the matcher each needs.
 * `StopFailure` matches only `rate_limit` — every other failure is somebody
 * else's problem and must not wake a recovery worker. */
const EVENTS: readonly [string, string][] = [
  ["SessionStart", ""],
  ["UserPromptSubmit", ""],
  ["StopFailure", "rate_limit"],
  ["SessionEnd", ""],
];

/** The exact command string an installed entry carries. `msBin` is quoted
 * the same way the statusline wrapper and the alias block quote it — Claude
 * Code hands this to a shell, and a path with a space in it (or, worse, a
 * quote) is otherwise two words and a broken hook on every turn. */
export function claudeHookCommand(msBin: string): string { return `${shellQuote(msBin)} _hook claude`; }

function readSettings(settingsPath: string): Settings | null {
  if (!existsSync(settingsPath)) return null;
  const text = readFileSync(settingsPath, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error(`${settingsPath}: settings file is not valid JSON (${(e as Error).message}); fix it by hand, refusing to overwrite it`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath}: settings file is not a JSON object; fix it by hand, refusing to overwrite it`);
  }
  return parsed as Settings;
}

function entriesFor(s: Settings | null, event: string): HookEntry[] {
  const list = s?.hooks?.[event];
  return Array.isArray(list) ? list : [];
}
function hasCommand(s: Settings | null, event: string, cmd: string): boolean {
  return entriesFor(s, event).some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command === cmd));
}

/** True when all four entries for THIS binary are already present. A different
 * `ms` path is a different install — the wizard re-points it deliberately. */
export function claudeHooksInstalled(settingsPath: string, msBin: string): boolean {
  let s: Settings | null;
  try { s = readSettings(settingsPath); } catch { return false; }
  if (!s) return false;
  const cmd = claudeHookCommand(msBin);
  return EVENTS.every(([event]) => hasCommand(s, event, cmd));
}

/**
 * Merge the four `ms _hook claude` entries into a Claude settings file.
 *
 * Only `hooks` is touched: every other key, and every hook entry that is not
 * ours, is preserved exactly. The file is backed up before the first change
 * and replaced atomically; a run that changes nothing writes nothing at all,
 * so the installer is idempotent and leaves one backup, not one per run.
 */
export function installClaudeHooks(settingsPath: string, msBin: string): { changed: boolean; backup: string | null } {
  const existing = readSettings(settingsPath);
  const settings: Settings = existing ?? {};
  const cmd = claudeHookCommand(msBin);

  let changed = false;
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error(`${settingsPath}: "hooks" is not an object; fix it by hand, refusing to overwrite it`);
  }
  const hooks: Record<string, HookEntry[]> = settings.hooks ?? {};
  for (const [event, matcher] of EVENTS) {
    if (hooks[event] === undefined) hooks[event] = [];
    if (!Array.isArray(hooks[event])) throw new Error(`${settingsPath}: hooks.${event} is not an array; fix it by hand, refusing to overwrite it`);
    if (hasCommand({ hooks }, event, cmd)) continue;
    hooks[event].push({ matcher, hooks: [{ type: "command", command: cmd }] });
    changed = true;
  }
  if (!changed) return { changed: false, backup: null };
  settings.hooks = hooks;

  let backup: string | null = null;
  if (existing !== null) {
    backup = backupThroughLink(settingsPath, "bak-");
  } else {
    mkdirSync(path.dirname(resolveTarget(settingsPath)), { recursive: true });
  }
  writeAtomicThroughLink(settingsPath, JSON.stringify(settings, null, 2) + "\n", { defaultMode: 0o600 });
  return { changed: true, backup };
}
