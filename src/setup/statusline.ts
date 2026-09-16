// src/setup/statusline.ts
//
// The statusline badge opt-in (Plan 3 Task 3): wrap Claude Code's
// `statusLine.command` in `~/.claude/settings.json` so it prints
// `[<account>] ` ahead of whatever it already printed.
//
// This is deliberately NOT `installClaudeHooks` with a different key: that
// installer refuses (throws) on a settings file it cannot parse, because a
// hook install runs unattended from the wizard's script and a thrown error
// is the wizard's own signal to stop. The statusline install is a single,
// interactive opt-in, so it reports the same refusal as data — `{ changed:
// false, problem }` — for the caller to print and move on from, never as an
// exception that would abort the rest of setup over one malformed file.
//
// Every other key in the settings file, and every other key already inside
// `statusLine` (`type`, `padding`, …), is preserved exactly: only `command`
// (and the `msOriginal` key this tool owns) is ever written.
//
// Fix round 2: this used to detect and unwrap "ours" by PARSING the command
// text (`<bin> _statusline[ -- <orig>]`). Two real bugs came from that: a
// human's own statusline command that happened to end in `_statusline` was
// silently swallowed as if it were already our wrapper, and an older
// wrapper whose `msBin` path itself contained a space could not be told
// apart from its own `-- ` separator, so re-installing over it nested rather
// than replaced. The fix is to stop parsing command text entirely. Ownership
// is now a dedicated key, `statusLine.msOriginal`, holding the human's
// original command verbatim (or `""` when there was none) — set ONCE, on
// the first install, and never touched again by a later re-install for a
// different binary. `command` itself carries nothing but the wrapper
// invocation (`'<msBin>' _statusline`, single-quoted so a spaced path is one
// shell word); the wrapper reads the original back out of the settings file
// at RUNTIME instead of being handed it on argv, so there is no command text
// to parse on either side of the round trip.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { backupThroughLink, resolveTarget, shellQuote, writeAtomicThroughLink } from "../fsx.ts";
import { claudeSettingsPath } from "../paths.ts";

type Settings = Record<string, unknown> & { statusLine?: unknown };

/** What the installer/remover decided. `problem` is a refusal the caller
 * reports verbatim: a file this tool cannot safely parse is never written. */
export type StatuslineResult = { changed: boolean; backup: string | null; problem?: string };

function readSettings(settingsPath: string): Settings | null {
  if (!existsSync(settingsPath)) return null;
  const text = readFileSync(settingsPath, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${settingsPath}: settings file is not valid JSON (${(e as Error).message}); fix it by hand, refusing to overwrite it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath}: settings file is not a JSON object; fix it by hand, refusing to overwrite it`);
  }
  return parsed as Settings;
}

/** The command text this tool installs: `msBin`, single-quoted so a path
 * containing a space is still one shell word, followed by the verb. Never
 * carries the original command any more — the runtime side reads that back
 * out of `statusLine.msOriginal` itself. */
function wrapperCommand(msBin: string): string {
  return `${shellQuote(msBin)} _statusline`;
}

/** Ownership is this key's presence, never the shape of `command` — the
 * whole point of fix round 2. A `statusLine` this tool has ever installed
 * into carries `msOriginal` (a string, `""` when there was nothing to
 * preserve); anything else, however its `command` happens to read, is not
 * ours to unwrap or guess about. */
function isOurs(statusLine: Record<string, unknown>): boolean {
  return typeof statusLine.msOriginal === "string";
}

/**
 * Point `settingsPath`'s `statusLine.command` at `msBin`'s wrapper.
 *
 * The file is backed up (`settings.json.bak-ms-<unix seconds>`) before the
 * first change and created (0600, parents included) when missing. A second
 * call for the SAME binary is a no-op: `changed: false`, no backup, file
 * untouched. A second call for a DIFFERENT binary (a brew-shim move, a
 * re-pointed wizard run) rewrites ONLY `command` — `msOriginal` was set once,
 * on the first install, and is never touched again, so there is nothing left
 * to nest: whatever was there before this tool ever ran is still exactly
 * what a later `removeStatusline` restores, however many binaries this ran
 * between.
 */
export function installStatusline(settingsPath: string, msBin: string): StatuslineResult {
  let existing: Settings | null;
  try {
    existing = readSettings(settingsPath);
  } catch (e) {
    return { changed: false, backup: null, problem: (e as Error).message };
  }

  const settings: Settings = existing ?? {};
  const rawStatusLine = settings.statusLine;
  if (rawStatusLine !== undefined && (typeof rawStatusLine !== "object" || rawStatusLine === null || Array.isArray(rawStatusLine))) {
    return { changed: false, backup: null, problem: `${settingsPath}: "statusLine" is not an object; fix it by hand, refusing to overwrite it` };
  }
  const hadStatusLine = rawStatusLine !== undefined;
  const statusLine: Record<string, unknown> = hadStatusLine ? { ...(rawStatusLine as Record<string, unknown>) } : {};
  const newCommand = wrapperCommand(msBin);

  if (isOurs(statusLine)) {
    if (statusLine.command === newCommand) return { changed: false, backup: null };
    statusLine.command = newCommand;
  } else {
    // First install: whatever `command` reads right now — a human's own
    // script, or nothing at all — is captured VERBATIM, never parsed or
    // interpreted, before it is overwritten. `""` is the explicit marker
    // for "there was none", not "we forgot to look".
    statusLine.msOriginal = typeof statusLine.command === "string" ? statusLine.command : "";
    statusLine.command = newCommand;
    // Claude Code only runs `statusLine.command` as a shell command when
    // `type` says so. There is nothing pre-existing to preserve when the
    // block did not exist at all, so this is the one case a fresh install
    // sets it — every other key, on a `statusLine` that already existed, is
    // left exactly as it was found.
    if (!hadStatusLine) statusLine.type = "command";
  }
  settings.statusLine = statusLine;

  let backup: string | null = null;
  if (existing !== null) {
    backup = backupThroughLink(settingsPath, "bak-ms-");
  } else {
    mkdirSync(path.dirname(resolveTarget(settingsPath)), { recursive: true });
  }
  writeAtomicThroughLink(settingsPath, JSON.stringify(settings, null, 2) + "\n", { defaultMode: 0o600 });
  return { changed: true, backup };
}

// --- The runtime side: `ms _statusline` ------------------------------------
//
// Claude Code spawns `statusLine.command` through a shell and waits on it to
// render every prompt, so this must never be the thing that makes a prompt
// slow or a session look broken: total time is bounded, and the exit code is
// always 0 — a statusline that fails is a statusline with no badge, never a
// broken Claude Code.
//
// Fix round 2 dropped the `-- <cmd>` argv form entirely: the wrapper takes
// NO arguments now (`command` is just `'<msBin>' _statusline`) and instead
// reads the original command back out of the settings file at runtime — the
// same file, and the same `statusLine.msOriginal` key, `installStatusline`
// wrote. That file lives at `$CLAUDE_CONFIG_DIR/settings.json` when that
// variable is set (Claude Code's own override), else `~/.claude/settings.json`.

/** Total budget for reading Claude Code's own stdin payload. It is a few
 * hundred bytes of JSON; anything larger is not one. */
const STDIN_MS = 3_000;
const STDIN_MAX = 1 << 20;
/** Total budget for the wrapped command. SIGKILL, not a courtesy signal: a
 * statusline has no time to wait for a hung child to notice SIGTERM. */
const WRAPPED_TIMEOUT_MS = 3_000;

/** The original command `installStatusline` captured into
 * `statusLine.msOriginal`, or `""` for "nothing to run" — a missing file, a
 * file this tool never touched, an unreadable or unparseable one, all read
 * the same way here: never worth a diagnostic, only ever a badge with
 * nothing after it. */
function readOriginalCommand(): string {
  try {
    const text = readFileSync(claudeSettingsPath(), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return "";
    const statusLine = (parsed as Settings).statusLine;
    if (!statusLine || typeof statusLine !== "object") return "";
    const original = (statusLine as Record<string, unknown>).msOriginal;
    return typeof original === "string" ? original : "";
  } catch {
    return "";
  }
}

/**
 * `ms _statusline` — takes no arguments; everything it needs comes from the
 * environment and the settings file.
 *
 * Reads Claude Code's statusline JSON from stdin (never parsed — only
 * relayed, unchanged, to the wrapped command's stdin), prints `[<account>] `
 * when `MS_ACCOUNT` is set in this pane's environment (nothing when it is
 * not), then — when `statusLine.msOriginal` names a real command — runs it
 * through a shell (exactly how Claude Code itself would have), bounded to
 * `WRAPPED_TIMEOUT_MS`, and prints whatever it wrote to stdout. Always
 * returns 0, whatever happened to the wrapped command or to reading stdin.
 */
export async function statuslineVerb(_args: string[]): Promise<number> {
  try {
    const input = process.stdin.isTTY ? "" : await readStdin(STDIN_MS);

    const account = process.env.MS_ACCOUNT;
    process.stdout.write(account ? `[${account}] ` : "");

    const original = readOriginalCommand();
    if (original !== "") {
      const out = await runWrapped(["/bin/sh", "-c", original], input, WRAPPED_TIMEOUT_MS);
      process.stdout.write(out);
    }
  } catch {
    // The badge or the wrapped output may be incomplete; the exit code below
    // is the promise that Claude Code's turn is never held up over it.
  }
  return 0;
}

/** Every byte of stdin, capped: a statusline that waits forever hangs
 * Claude's render. Mirrors `hooks/claude-hook.ts`'s `readStdin`. */
function readStdin(ms: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = (v: string) => {
      clearTimeout(timer);
      try {
        process.stdin.pause();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(buf), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      if (buf.length > STDIN_MAX) done(buf);
    });
    process.stdin.on("end", () => done(buf));
    process.stdin.on("error", () => done(buf));
  });
}

/** Run `cmd` with `input` on its stdin and the current process's own
 * environment, capturing stdout only (stderr is not this tool's to show —
 * Claude Code renders the statusline's stdout verbatim). Resolves with
 * whatever stdout arrived, however the child ended: a normal exit, a
 * non-zero one, an error spawning it, or a SIGKILL at the timeout. Never
 * rejects. */
function runWrapped(cmd: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      // `detached: true` makes the child the leader of its own process
      // group, so a wrapped shell script's own children — a `sleep` it
      // forked, or backgrounded with `&` — share that group rather than
      // ours, and `killGroup` below reaches every one of them by pgid.
      // Without it, SIGKILL to just the immediate child orphans them: an
      // orphan that still holds the stdout pipe open keeps the whole
      // `ms _statusline` process alive long past any timeout, and one that
      // does not is still a process this tool spawned, left running on the
      // human's machine well after `ms _statusline` itself has returned.
      child = spawn(cmd[0]!, cmd.slice(1), { env: process.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    } catch {
      resolve("");
      return;
    }

    /** SIGKILL the whole process group, not just `child` itself. Safe to
     * call after the immediate child has already exited (`close` already
     * fired): a pgid stays alive as long as ANY member of it does, which is
     * exactly the case a backgrounded grandchild leaves behind. Never
     * throws — "no such process/group" is the common, successful case. */
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* the group is already empty — nothing left to reach */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever ended this — a normal exit, a failure, or the timeout below
      // — nothing the wrapped command spawned is allowed to outlive it.
      killGroup();
      // Release our own handle on the pipe regardless of whether the kill
      // above actually reached every descendant — the point is THIS
      // process's event loop must never wait on it past this moment.
      child.stdout?.destroy();
      resolve(v);
    };

    const timer = setTimeout(() => finish(out), timeoutMs);

    child.stdout?.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.on("error", () => finish(out));
    child.on("close", () => finish(out));

    try {
      child.stdin?.write(input);
      child.stdin?.end();
    } catch {
      /* the child may already be gone; the timeout or close handler finishes this */
    }
  });
}

/**
 * Undo `installStatusline`: restore `statusLine.command` from
 * `statusLine.msOriginal` and drop that key.
 *
 * When `msOriginal` is `""` there was no command before this tool ever ran —
 * but that does NOT mean there was no `statusLine`. A human can perfectly
 * well have had `{ "type": "command", "padding": 0 }` and no command, and
 * deleting the whole object (which this used to do) took their keys with it.
 * So the removal is always the exact inverse of the install: drop the two
 * keys this tool owns, put `command` back only when there was one, and
 * delete `statusLine` itself only when what remains is nothing — or nothing
 * but the `type: "command"` a fresh install added alongside its own keys.
 */
export function removeStatusline(settingsPath: string): StatuslineResult {
  let existing: Settings | null;
  try {
    existing = readSettings(settingsPath);
  } catch (e) {
    return { changed: false, backup: null, problem: (e as Error).message };
  }
  if (existing === null) return { changed: false, backup: null };

  const settings = existing;
  const rawStatusLine = settings.statusLine;
  if (!rawStatusLine || typeof rawStatusLine !== "object" || Array.isArray(rawStatusLine)) return { changed: false, backup: null };
  const statusLine = { ...(rawStatusLine as Record<string, unknown>) };
  if (!isOurs(statusLine)) return { changed: false, backup: null };
  const original = statusLine.msOriginal as string;

  const backup = backupThroughLink(settingsPath, "bak-ms-");

  delete statusLine.msOriginal;
  if (original === "") delete statusLine.command;
  else statusLine.command = original;
  const remaining = Object.keys(statusLine);
  const onlyWhatWeAdded = remaining.length === 0 || (remaining.length === 1 && statusLine.type === "command");
  if (original === "" && onlyWhatWeAdded) delete settings.statusLine;
  else settings.statusLine = statusLine;
  writeAtomicThroughLink(settingsPath, JSON.stringify(settings, null, 2) + "\n", { defaultMode: 0o600 });
  return { changed: true, backup };
}
