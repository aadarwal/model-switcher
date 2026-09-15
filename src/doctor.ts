// src/doctor.ts
//
// `ms doctor [--fix]`: a fixed checklist over the things that make `ms`
// actually work end to end — the runtime, tmux, claude, the Claude hooks,
// store permissions, every Claude account's two credentials, orphaned
// session state, and the `ms` binary on PATH. Read-only by default; `--fix`
// repairs what it safely can (hooks, store permissions, orphaned state via
// Task 18's `reconcile()`) and reports the rest. The account checks and the
// PATH check are never auto-fixed — there is nothing safe to do about a dead
// credential or a stray `ms` shadowing this one except tell the human.
//
// Each check prints exactly one line: `✓ <what>` (plus ` → fixed` when this
// run just repaired it) or `✗ <what> — <why>`. Exit 1 iff any check is still
// a ✗ once fixes (if requested) have been applied.

import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { msBinary, msHome } from "./paths.ts";
import { claudeHooksInstalled, installClaudeHooks } from "./hooks/install.ts";
import { loadRegistry, type Account } from "./registry.ts";
import { AuthError, TransientError, readPollCredentials, refreshPollCredentials } from "./providers/claude-usage.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { openState } from "./state.ts";
import { Tmux } from "./tmux.ts";

export type Result = { ok: boolean; what: string; why?: string; fixed?: boolean };

const MIN_TMUX = [3, 3] as const;
/** A poll grant due to expire within this window is worth refreshing now;
 *  one further out is left alone — `ms doctor` should not spend an account's
 *  refresh token just to look at it. */
const REFRESH_DUE_MS = 60_000;
const REFRESH_TIMEOUT_MS = 10_000;

export function renderLine(r: Result): string {
  const suffix = r.fixed ? " → fixed" : "";
  return r.ok ? `✓ ${r.what}${suffix}` : `✗ ${r.what} — ${r.why ?? "failed"}${suffix}`;
}

function runBounded(cmd: string, args: string[], timeoutMs: number): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  if (r.error || r.status !== 0) {
    return { ok: false, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() || r.error?.message || `exit ${r.status ?? "timeout"}` };
  }
  return { ok: true, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// --- Runtime -------------------------------------------------------------

export function checkNode(): Result {
  const what = "Node ≥ 22.15 with process.execve";
  return typeof process.execve === "function"
    ? { ok: true, what }
    : { ok: false, what, why: `running ${process.version}, no process.execve` };
}

export function checkTmux(): Result {
  const what = "tmux ≥ 3.3";
  const r = runBounded("tmux", ["-V"], 5_000);
  if (!r.ok) return { ok: false, what, why: r.stderr };
  const m = r.stdout.match(/(\d+)\.(\d+)/);
  if (!m) return { ok: false, what, why: `could not parse a version from "${r.stdout.trim()}"` };
  const found: [number, number] = [Number(m[1]), Number(m[2])];
  const ok = found[0] > MIN_TMUX[0] || (found[0] === MIN_TMUX[0] && found[1] >= MIN_TMUX[1]);
  return ok ? { ok: true, what: `${what} (found ${r.stdout.trim()})` } : { ok: false, what, why: `found ${r.stdout.trim()}` };
}

export function checkClaudeBinary(): Result {
  const what = "claude --version";
  const r = runBounded("claude", ["--version"], 10_000);
  return r.ok ? { ok: true, what: `${what} (${r.stdout.trim() || "ok"})` } : { ok: false, what, why: r.stderr };
}

// --- Claude hooks ----------------------------------------------------------

function claudeSettingsPath(): string {
  return path.join(process.env.HOME || homedir(), ".claude", "settings.json");
}

export function checkHooks(fix: boolean): Result {
  const what = "Claude hooks installed";
  const settingsPath = claudeSettingsPath();
  const msBin = msBinary();
  if (claudeHooksInstalled(settingsPath, msBin)) return { ok: true, what };
  if (!fix) return { ok: false, what, why: `not all four present in ${settingsPath} for ${msBin}` };
  try {
    installClaudeHooks(settingsPath, msBin);
  } catch (e) {
    return { ok: false, what, why: `not installed in ${settingsPath} — --fix failed: ${(e as Error).message}` };
  }
  return claudeHooksInstalled(settingsPath, msBin)
    ? { ok: true, what, fixed: true }
    : { ok: false, what, why: `still not installed in ${settingsPath} after --fix` };
}

// --- Store permissions -----------------------------------------------------

type PermIssue = { path: string; wantMode: number; foundMode: number };

function octal(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}

function walkStore(dir: string, out: PermIssue[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // does not exist (yet) — nothing to check
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never followed, never touched
    const found = st.mode & 0o777;
    if (st.isDirectory()) {
      if (found !== 0o700) out.push({ path: full, wantMode: 0o700, foundMode: found });
      walkStore(full, out);
    } else if (st.isFile() && found !== 0o600) {
      out.push({ path: full, wantMode: 0o600, foundMode: found });
    }
  }
}

export function checkStorePermissions(fix: boolean): Result[] {
  const home = msHome();
  const issues: PermIssue[] = [];
  try {
    const st = lstatSync(home);
    if (!st.isSymbolicLink() && st.isDirectory() && (st.mode & 0o777) !== 0o700) {
      issues.push({ path: home, wantMode: 0o700, foundMode: st.mode & 0o777 });
    }
  } catch {
    // the store does not exist yet — the next command to touch it creates
    // it correctly (ensureStore); nothing to flag here.
  }
  walkStore(home, issues);

  if (issues.length === 0) return [{ ok: true, what: "store permissions (0700 dirs, 0600 files) under MS_HOME" }];

  return issues.map((iss): Result => {
    const rel = path.relative(home, iss.path) || ".";
    const what = `store permission: ${rel}`;
    const why = `is 0${octal(iss.foundMode)}, want 0${octal(iss.wantMode)}`;
    if (!fix) return { ok: false, what, why };
    try {
      chmodSync(iss.path, iss.wantMode);
      return { ok: true, what, fixed: true };
    } catch (e) {
      return { ok: false, what, why: `${why} — --fix failed: ${(e as Error).message}` };
    }
  });
}

// --- Claude accounts ---------------------------------------------------

export async function checkClaudeAccount(a: Account): Promise<Result[]> {
  const tag = `claude account ${a.name}`;
  const out: Result[] = [];

  const cred = readPollCredentials(a.name);
  if (!cred) {
    out.push({ ok: false, what: `${tag}: poll grant readable`, why: "no credentials file or keychain entry (npm run add-claude on the serving host)" });
  } else {
    out.push({ ok: true, what: `${tag}: poll grant readable` });
    const dueInMs = cred.expiresAt - Date.now();
    if (dueInMs > REFRESH_DUE_MS) {
      out.push({ ok: true, what: `${tag}: poll grant refresh not due` });
    } else {
      try {
        await refreshPollCredentials(a.name, cred, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
        out.push({ ok: true, what: `${tag}: poll grant refreshable` });
      } catch (e) {
        const why =
          e instanceof AuthError ? `auth: ${e.message}` : e instanceof TransientError ? `transient: ${e.message}` : (e as Error).message;
        out.push({ ok: false, what: `${tag}: poll grant refreshable`, why });
      }
    }
  }

  out.push(
    readLaunchToken(a.name)
      ? { ok: true, what: `${tag}: launch token present` }
      : { ok: false, what: `${tag}: launch token present`, why: "no launch token (anu account add)" },
  );

  out.push(
    a.identityVerified
      ? { ok: true, what: `${tag}: identity verified` }
      : { ok: false, what: `${tag}: identity verified`, why: "identityVerified is false in the registry" },
  );

  return out;
}

// --- Orphaned session state -------------------------------------------

function isOrphaned(s: { socket: string; pane: string; state: string }): boolean {
  if (s.state === "stopped") return false;
  return !new Tmux(s.socket || null).paneExists(s.pane);
}

export async function checkOrphaned(fix: boolean): Promise<Result[]> {
  const st = openState();
  let sessions;
  try {
    sessions = st.listSessions();
  } finally {
    st.close();
  }
  let orphaned = sessions.filter(isOrphaned);
  if (orphaned.length === 0) return [{ ok: true, what: "orphaned session state" }];

  if (fix) {
    // Task 18's reconciler, imported dynamically and only here: this branch
    // must not break before that module lands, and must never be a static
    // dependency of this one either way. The specifier is built at runtime
    // (not a string literal at the call site) so `tsc` does not try to
    // resolve a module that may not exist yet.
    try {
      const reconcileModule: string = [".", "reconcile.ts"].join("/");
      const mod = (await import(reconcileModule)) as { reconcile: () => string[] };
      mod.reconcile();
      const st2 = openState();
      try {
        sessions = st2.listSessions();
      } finally {
        st2.close();
      }
      orphaned = sessions.filter(isOrphaned);
      if (orphaned.length === 0) return [{ ok: true, what: "orphaned session state", fixed: true }];
    } catch {
      // reconcile.ts not available yet, or it threw — fall through and
      // report whatever is still orphaned, unfixed.
    }
  }

  return orphaned.map((s) => ({ ok: false, what: `orphaned session ${s.id}`, why: `pane ${s.pane} is gone on ${s.socket || "(no socket)"}` }));
}

// --- ms on PATH ----------------------------------------------------------

/** Walk PATH the way a shell would (first executable regular file named
 *  `name` wins), following symlinks — a private copy of `src/exec.ts`'s
 *  `resolveOnPath`: that one is not exported, and this task touches only its
 *  own files. */
function resolveOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function checkPathBinary(): Result {
  const what = "ms on PATH is msBinary()";
  const onPath = resolveOnPath("ms");
  const wanted = msBinary();
  if (!onPath) return { ok: false, what, why: `ms not found on PATH; msBinary() is ${wanted}` };
  let realOnPath: string;
  let realWanted: string;
  try {
    realOnPath = realpathSync(onPath);
  } catch (e) {
    return { ok: false, what, why: `could not resolve ${onPath}: ${(e as Error).message}` };
  }
  try {
    realWanted = realpathSync(wanted);
  } catch (e) {
    return { ok: false, what, why: `could not resolve ${wanted}: ${(e as Error).message}` };
  }
  if (realOnPath === realWanted) return { ok: true, what };
  // Never "fixed": there is no safe automatic repair for a PATH that shadows
  // this binary with another one — just show both paths.
  return { ok: false, what, why: `PATH gives ${onPath} (${realOnPath}); msBinary() is ${wanted} (${realWanted})` };
}

// --- Putting it together -------------------------------------------------

export async function runDoctor(fix: boolean): Promise<{ results: Result[]; lines: string[]; exitCode: number }> {
  const results: Result[] = [];
  results.push(checkNode());
  results.push(checkTmux());
  results.push(checkClaudeBinary());
  results.push(checkHooks(fix));
  results.push(...checkStorePermissions(fix));

  const { registry } = loadRegistry();
  for (const a of registry.accounts.filter((a) => a.provider === "claude")) {
    results.push(...(await checkClaudeAccount(a)));
  }

  results.push(...(await checkOrphaned(fix)));
  results.push(checkPathBinary());

  const lines = results.map(renderLine);
  const exitCode = results.some((r) => !r.ok) ? 1 : 0;
  return { results, lines, exitCode };
}

export const doctor: Verb = async (args) => {
  const fix = args.includes("--fix");
  const { lines, exitCode } = await runDoctor(fix);
  for (const l of lines) process.stdout.write(l + "\n");
  return exitCode;
};
