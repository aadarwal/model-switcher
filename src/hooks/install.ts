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
function commandsFor(s: Settings | null, event: string): string[] {
  return entriesFor(s, event).flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks.map((h) => h?.command) : [])).filter((c): c is string => typeof c === "string");
}

/**
 * Is this hook command one of OURS — whatever `ms` path it names?
 *
 * The argv shape is unambiguous: nothing but this tool's installer ever
 * writes a command ending in `_hook claude`, and the verb is internal (it is
 * not in `ms --help`'s public list). That is what makes a re-point able to
 * REPLACE rather than append: an entry naming a binary that no longer exists
 * is still recognisably ours to remove, which is exactly the case a `brew
 * upgrade` or an abandoned checkout leaves behind.
 */
export function isMsHookCommand(command: unknown): boolean {
  return typeof command === "string" && /\s_hook\s+claude\s*$/.test(command);
}

/** True when the four entries for THIS binary are present AND no OTHER ms
 * entry is left anywhere in the file. Both halves matter: four correct
 * entries beside a fifth that names a deleted checkout means Claude Code
 * runs a dead hook on every SessionStart (or, when the checkout is still
 * there, a second, older hook build sends duplicate `started` events). A
 * stale entry is therefore a ✗ the doctor reports and `--fix` prunes, not a
 * detail this answers `true` over. */
export function claudeHooksInstalled(settingsPath: string, msBin: string): boolean {
  let s: Settings | null;
  try { s = readSettings(settingsPath); } catch { return false; }
  if (!s) return false;
  const cmd = claudeHookCommand(msBin);
  const hooks = s.hooks;
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))) return false;
  for (const event of Object.keys(hooks ?? {})) {
    if (commandsFor(s, event).some((c) => isMsHookCommand(c) && c !== cmd)) return false;
  }
  return EVENTS.every(([event]) => commandsFor(s, event).filter((c) => c === cmd).length === 1);
}

/**
 * Put the four `ms _hook claude` entries into a Claude settings file — by
 * REPLACING whatever this tool left there before, never by appending beside
 * it.
 *
 * `ms` moves: a checkout becomes a brew keg, a keg becomes the next version's
 * keg. Every move used to add four more entries and leave the old four in
 * place, so a settings file three moves along carried twelve, most of them
 * naming a binary that no longer exists. So: strip every ms-owned command
 * first (recognised by its argv shape, whatever path it names — see
 * `isMsHookCommand`), then add this binary's four.
 *
 * Only `hooks` is touched: every other key, every hook entry that is not
 * ours, and every other tool's command sharing an entry with ours, is
 * preserved exactly. The file is backed up before the first change and
 * replaced atomically; a run that changes nothing writes nothing at all, so
 * the installer is idempotent and leaves one backup, not one per run.
 */
export function installClaudeHooks(settingsPath: string, msBin: string): { changed: boolean; backup: string | null } {
  const existing = readSettings(settingsPath);
  const settings: Settings = existing ?? {};
  const cmd = claudeHookCommand(msBin);

  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error(`${settingsPath}: "hooks" is not an object; fix it by hand, refusing to overwrite it`);
  }
  // A CLONE, compared against the original at the end. `changed` cannot be
  // decided step by step here: stripping our own entries and adding them
  // straight back is what a re-run does, and that is not a change — the
  // honest answer is whether the finished `hooks` differs from the one on
  // disk, which is also what keeps "writes nothing when nothing changed"
  // true through the strip-then-add shape.
  const before = JSON.stringify(settings.hooks ?? null);
  const hooks: Record<string, HookEntry[]> = structuredClone(settings.hooks ?? {});
  const ours: HookCommand = { type: "command", command: cmd };

  // Pass 1: strip every ms-owned command from EVERY event — including one we
  // no longer subscribe to — leaving each entry's other hooks (another
  // tool's, sharing the same entry) and every non-ms entry exactly as found.
  // An entry left with no hooks at all was only ever ours, so it goes. An
  // event left with no entries at all — an event ONLY we ever subscribed to,
  // and (for one we no longer subscribe to) pass 2 will never revisit — is
  // deleted outright rather than left as a dangling `"Event": []`: litter no
  // verb ever removes, and untrue besides (the human's settings file would
  // read as still wiring an event nothing handles).
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) throw new Error(`${settingsPath}: hooks.${event} is not an array; fix it by hand, refusing to overwrite it`);
    const kept: HookEntry[] = [];
    for (const entry of list) {
      if (!entry || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
      const others = entry.hooks.filter((h) => !isMsHookCommand(h?.command));
      if (others.length === entry.hooks.length) kept.push(entry);
      else if (others.length > 0) kept.push({ ...entry, hooks: others });
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  // Pass 2: add this binary's four, each in its own entry, with its matcher.
  for (const [event, matcher] of EVENTS) {
    const list = hooks[event];
    if (list === undefined) { hooks[event] = [{ matcher, hooks: [ours] }]; continue; }
    if (!Array.isArray(list)) throw new Error(`${settingsPath}: hooks.${event} is not an array; fix it by hand, refusing to overwrite it`);
    hooks[event] = [...list, { matcher, hooks: [ours] }];
  }
  if (JSON.stringify(hooks) === before) return { changed: false, backup: null };
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
