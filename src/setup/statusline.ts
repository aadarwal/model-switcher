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
// is ever written.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

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

function writeAtomic(file: string, text: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/** The command text this tool installs, wrapping `original` when there is one. */
function wrapperCommand(msBin: string, original?: string): string {
  return original !== undefined ? `${msBin} _statusline -- ${original}` : `${msBin} _statusline`;
}

/** True when `cmd` is already this exact binary's wrapper. A different `ms`
 * path is a different install (mirrors `claudeHooksInstalled`'s rule), so a
 * wizard re-pointed at another binary wraps again rather than no-op'ing. */
function isOurWrapper(cmd: string, msBin: string): boolean {
  return cmd === `${msBin} _statusline` || cmd.startsWith(`${msBin} _statusline -- `);
}

/** Any `<bin> _statusline[ -- <original>]` wrapper, whoever installed it.
 * `removeStatusline` is not told which binary to look for — it only needs to
 * know a wrapper is there and, when one is, what it was wrapping — so this
 * matches the shape generically. A binary path is never spaced, so `\S+` is
 * exact rather than a guess. */
const GENERIC_WRAPPER_RE = /^\S+ _statusline(?: -- ([\s\S]*))?$/;

/**
 * Point `settingsPath`'s `statusLine.command` at `msBin`'s wrapper.
 *
 * The file is backed up (`settings.json.bak-ms-<unix seconds>`) before the
 * first change and created (0600, parents included) when missing. A second
 * call for the SAME binary is a no-op: `changed: false`, no backup, file
 * untouched — so the wizard can run it every time without piling up backups
 * or double-wrapping an already-wrapped command.
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
  const currentCmd = typeof statusLine.command === "string" ? statusLine.command : undefined;

  if (currentCmd !== undefined && isOurWrapper(currentCmd, msBin)) {
    return { changed: false, backup: null };
  }

  statusLine.command = wrapperCommand(msBin, currentCmd);
  // Claude Code only runs `statusLine.command` as a shell command when `type`
  // says so. There is nothing pre-existing to preserve when the block did not
  // exist at all, so this is the one case a fresh install sets it — every
  // other key, on a `statusLine` that already existed, is left exactly as it
  // was found.
  if (!hadStatusLine) statusLine.type = "command";
  settings.statusLine = statusLine;

  let backup: string | null = null;
  if (existing !== null) {
    backup = `${settingsPath}.bak-ms-${Math.floor(Date.now() / 1000)}`;
    copyFileSync(settingsPath, backup);
  } else {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { changed: true, backup };
}

// --- The runtime side: `ms _statusline [-- <cmd…>]` -----------------------
//
// Claude Code spawns `statusLine.command` through a shell and waits on it to
// render every prompt, so this must never be the thing that makes a prompt
// slow or a session look broken: total time is bounded, and the exit code is
// always 0 — a statusline that fails is a statusline with no badge, never a
// broken Claude Code.

/** Total budget for reading Claude Code's own stdin payload. It is a few
 * hundred bytes of JSON; anything larger is not one. */
const STDIN_MS = 3_000;
const STDIN_MAX = 1 << 20;
/** Total budget for the wrapped command. SIGKILL, not a courtesy signal: a
 * statusline has no time to wait for a hung child to notice SIGTERM. */
const WRAPPED_TIMEOUT_MS = 3_000;

/**
 * `ms _statusline [-- <cmd…>]`.
 *
 * Reads Claude Code's statusline JSON from stdin (never parsed — only
 * relayed, unchanged, to the wrapped command's stdin), prints `[<account>] `
 * when `MS_ACCOUNT` is set in this pane's environment (nothing when it is
 * not), then — when a command was given after `--` — runs it with the same
 * environment, bounded to `WRAPPED_TIMEOUT_MS`, and prints whatever it wrote
 * to stdout. Always returns 0, whatever happened to the wrapped command or
 * to reading stdin.
 */
export async function statuslineVerb(args: string[]): Promise<number> {
  try {
    const dashIdx = args.indexOf("--");
    const cmd = dashIdx === -1 ? [] : args.slice(dashIdx + 1);

    const input = process.stdin.isTTY ? "" : await readStdin(STDIN_MS);

    const account = process.env.MS_ACCOUNT;
    process.stdout.write(account ? `[${account}] ` : "");

    if (cmd.length > 0) {
      const out = await runWrapped(cmd, input, WRAPPED_TIMEOUT_MS);
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
    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // `detached: true` makes the child the leader of its own process
      // group, so a wrapped shell script's own children (a `sleep` it
      // forked, say) share that group and die with it. SIGKILL to just the
      // immediate child would otherwise orphan them — and an orphan that
      // still holds the stdout pipe open keeps the whole `ms _statusline`
      // process alive long after this timeout fired, no matter how promptly
      // `finish` below resolves this promise.
      child = spawn(cmd[0]!, cmd.slice(1), { env: process.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    } catch {
      resolve("");
      return;
    }

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      // Release our own handle on the pipe regardless of whether the group
      // kill above actually reached every descendant — the point is THIS
      // process's event loop must never wait on it past the timeout.
      child.stdout?.destroy();
      finish(out);
    }, timeoutMs);

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
 * Undo `installStatusline`: restore whatever `statusLine.command` was
 * wrapping (the part after `-- `), or — when there was nothing to wrap —
 * delete `statusLine` entirely, since that is exactly what a fresh install
 * added. A file with no wrapper installed, or none matching this shape at
 * all, is left untouched: `changed: false`, no backup.
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
  const cmd = typeof statusLine.command === "string" ? statusLine.command : undefined;
  if (cmd === undefined) return { changed: false, backup: null };
  const m = GENERIC_WRAPPER_RE.exec(cmd);
  if (!m) return { changed: false, backup: null };

  const backup = `${settingsPath}.bak-ms-${Math.floor(Date.now() / 1000)}`;
  copyFileSync(settingsPath, backup);

  if (m[1] !== undefined) {
    statusLine.command = m[1];
    settings.statusLine = statusLine;
  } else {
    delete settings.statusLine;
  }
  writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { changed: true, backup };
}
