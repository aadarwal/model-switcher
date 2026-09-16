// src/setup/state.ts
//
// `ms setup` (Plan 3, Task 2) sequences existing verbs — accounts, hooks,
// statusline, alias — over what can be a long, interruptible conversation
// with a human. This is its memory: one JSON file, `MS_HOME/setup.json`,
// so ctrl-c, a closed terminal, or a crash resumes at the next undone step
// instead of replaying everything already answered.
//
// Same conventions as every other store file (src/registry.ts's
// `saveRegistry`, src/launch.ts's `writeLastPick`): atomic write via a
// per-process temp file renamed into place, 0600 — a launch token or a
// Claude/Codex account name is not secret the way a credential is, but it
// is still nobody else's business, and 0600 is free.
//
// A `setup.json` that fails to parse, or parses to the wrong shape (a
// human hand-editing it, a future version's fields, a torn write from a
// killed process), is never silently accepted or silently overwritten: it
// is renamed aside to `setup.json.corrupt-<ts>` and a fresh state is
// returned, with exactly one line on stderr saying so. The wizard then
// starts over having lost nothing but its own resume point.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureStore, msHome } from "../paths.ts";

export type SetupStep =
  | "prereqs"
  | "claude-accounts"
  | "codex-accounts"
  | "hooks"
  | "statusline"
  | "alias"
  | "finish";

const STEPS: readonly SetupStep[] = [
  "prereqs",
  "claude-accounts",
  "codex-accounts",
  "hooks",
  "statusline",
  "alias",
  "finish",
];

export type SetupState = {
  version: 1;
  done: SetupStep[];
  claude: string[];
  codex: string[];
  optIns: { statusline: boolean; alias: boolean };
  startedAt: string;
  updatedAt: string;
};

function setupFile(): string {
  return path.join(msHome(), "setup.json");
}

function freshState(): SetupState {
  const now = new Date().toISOString();
  return { version: 1, done: [], claude: [], codex: [], optIns: { statusline: false, alias: false }, startedAt: now, updatedAt: now };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Everything `loadSetup` requires of a parsed `setup.json` before it will
 * trust it. Anything else — wrong version, a `done` entry that isn't a
 * known step, a missing field, the wrong type for one — is corrupt, same as
 * unparseable JSON: `loadSetup` never hands the rest of the tool a shape it
 * did not itself write. */
function isSetupState(raw: unknown): raw is SetupState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return false;
  if (!Array.isArray(r.done) || !r.done.every((d) => STEPS.includes(d as SetupStep))) return false;
  if (!isStringArray(r.claude) || !isStringArray(r.codex)) return false;
  if (!r.optIns || typeof r.optIns !== "object") return false;
  const oi = r.optIns as Record<string, unknown>;
  if (typeof oi.statusline !== "boolean" || typeof oi.alias !== "boolean") return false;
  if (typeof r.startedAt !== "string" || typeof r.updatedAt !== "string") return false;
  return true;
}

/** Move an unreadable/malformed `setup.json` out of the way and say so.
 * Renaming (never deleting) means a human confused about where their
 * answers went can still go look; `loadSetup` itself never reads the
 * quarantined file again. */
function quarantine(file: string): SetupState {
  const dest = `${file}.corrupt-${Date.now()}`;
  renameSync(file, dest);
  process.stderr.write(`ms setup: setup.json was corrupt; moved aside to ${path.basename(dest)} and starting fresh\n`);
  return freshState();
}

/** A fresh state when `setup.json` is absent — no write. The first thing
 * that puts the file on disk is `saveSetup` (directly, or via `markDone`). */
export function loadSetup(): SetupState {
  ensureStore();
  const file = setupFile();
  if (!existsSync(file)) return freshState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return quarantine(file);
  }
  if (!isSetupState(raw)) return quarantine(file);
  return raw;
}

export function saveSetup(s: SetupState): void {
  ensureStore();
  const file = setupFile();
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Record a step as done and persist immediately — the whole point of a
 * resumable file is that "done" is durable the moment it happens, not
 * batched until some later save. Idempotent: marking an already-done step
 * again does not duplicate it in `done`, but `updatedAt` still advances. */
export function markDone(s: SetupState, step: SetupStep): SetupState {
  const done = s.done.includes(step) ? s.done : [...s.done, step];
  const next: SetupState = { ...s, done, updatedAt: new Date().toISOString() };
  saveSetup(next);
  return next;
}

/** Deletes `setup.json` only — no other file or directory under `MS_HOME`
 * is this function's business. A subsequent `loadSetup` sees an absent file
 * and returns fresh, same as a `MS_HOME` that never ran `ms setup`. */
export function resetSetup(): void {
  rmSync(setupFile(), { force: true });
}
