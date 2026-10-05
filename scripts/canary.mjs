// scripts/canary.mjs
//
// The nightly canary (.github/workflows/canary.yml): contract checks between
// `ms` and whatever Codex and Claude Code are on PATH — in CI, the newest of
// each from npm — that need no account, no login and no network beyond the
// install itself. It answers one question before a human has to: does the
// CLI that shipped today still have the things `ms` keys on?
//
//   node --import tsx scripts/canary.mjs [--json <file>]
//
// Everything `ms` code is imported from src/ (tsx), so the canary checks the
// rules this checkout actually ships — the hook event tables, the runtime-
// state classifier, the tested-version table — not a copy of them.
//
// What it checks, per CLI:
//   * `--version` parses. Newer than src/compat.ts is REPORTED (a version
//     nobody has verified yet), never by itself a failure.
//   * the CLI's own binary still contains the strings `ms` depends on: hook
//     event names, the hook input and rollout fields it reads, the wall text
//     `ms status` names a wall by. A string that disappears is the earliest
//     sign that a rename is coming — it is not proof of breakage, but it is
//     exactly the thing to look at before users do.
//   * Codex only: in a scratch HOME, an account home built by `ms`'s own code
//     (src/accounts-codex.ts `ensureCodexHome`, src/hooks/codex-install.ts)
//     on top of a base Codex has already populated; then `codex app-server
//     daemon start` / `version` / `stop` there. The daemon's socket must be
//     INSIDE the home (a socket reached through a link into the base is every
//     account running as one), and every top-level entry Codex created that
//     is runtime state by an independent reading — a socket, a .lock/.pid
//     file, a directory holding a socket — must be one `ms` already treats as
//     runtime state (`isRuntimeState`/`CODEX_HOME_OWN`), i.e. never shares.
//
// Nothing outside the scratch directory is touched: HOME, MS_HOME, the Codex
// base and every CODEX_HOME point into it, and the one process this kills is
// the scratch daemon's own `pid-update-loop` (Codex 0.160 leaves it running
// after `daemon stop`), found by the pid file in the scratch home.
//
// Filing issues is NOT done here: this script runs right after an
// `npm install -g` of code nobody has read yet, so the job it runs in holds a
// read-only token. The scheduled run's failure hands `--json`'s report to
// scripts/canary-issues.mjs, in a job of its own with `issues: write`.
//
// Exit status: 0 when every check passed, 1 when any failed.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markdown } from "./canary-issues.mjs";

// --- A scratch world, before any `ms` module reads its environment ----------

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "ms-canary-")));
const home = path.join(scratch, "home");
mkdirSync(home, { recursive: true });
const realPath = process.env.PATH;
for (const k of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "MS_ACCOUNT", "MS_SESSION", "MS_GENERATION", "MS_SOCKET", "MS_PANE"]) delete process.env[k];
Object.assign(process.env, {
  HOME: home,
  MS_HOME: path.join(home, ".config", "model-switcher"),
  MS_CODEX_BASE_DIR: path.join(home, ".codex"),
  MS_CODEX_BASE_CONFIG: path.join(home, ".codex", "config.toml"),
  MS_BIN: "/usr/local/bin/ms", // only ever written into a hook command; never run
  MS_NO_UPDATE_CHECK: "1",
});

const { COMPAT, VERIFIED_ON, compareVersions, parseVersion } = await import("../src/compat.ts");
const { resolveOnPath } = await import("../src/exec.ts");
const { EVENTS: CLAUDE_EVENTS } = await import("../src/hooks/install.ts");
const { EVENTS: CODEX_EVENTS, installCodexHooks } = await import("../src/hooks/codex-install.ts");
const { CODEX_HOME_OWN, isHomeOwn, isRuntimeState } = await import("../src/codex-share.ts");
const { ensureCodexHome } = await import("../src/accounts-codex.ts");

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

/** @type {{ tool: "codex" | "claude", version: string | null, results: { name: string, ok: boolean, detail: string }[], notes: string[] }[]} */
const reports = [];

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", timeout: 120_000, ...opts });
  return { ok: !r.error && r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}

// --- Finding the real binary behind an npm launcher -------------------------

const BIG = 5 * 1024 * 1024;

/** Files of at least BIG bytes under `dir`, at any depth (links not followed). */
function bigFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) bigFiles(p, out, depth + 1);
    else if (d.isFile()) {
      try {
        if (statSync(p).size >= BIG) out.push(p);
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/**
 * The native binaries a CLI on PATH runs. Both npm packages are a small
 * launcher (`codex.js`, `claude.exe`'s stand-in) over a platform package that
 * holds the real executable, nested or hoisted beside it; a standalone install
 * is the executable itself. So: the file itself when it is big, else every big
 * file in its package and in the platform packages beside that package.
 */
function nativeBinaries(bin) {
  const real = realpathSync(bin);
  if (statSync(real).size >= BIG) return [real];
  let root = path.dirname(real);
  while (root !== path.dirname(root) && !existsSync(path.join(root, "package.json"))) root = path.dirname(root);
  const found = bigFiles(root);
  const scope = path.dirname(root);
  for (const d of readdirSync(scope)) {
    if (d.startsWith(`${path.basename(root)}-`)) bigFiles(path.join(scope, d), found);
  }
  return found;
}

/** Each needle: a name, and the spellings any one of which counts. */
function stringChecks(report, bins, needles) {
  if (!bins.length) {
    report.results.push({ name: "native binary found", ok: false, detail: "no executable of 5 MB or more beside the launcher" });
    return;
  }
  report.notes.push(`searched ${bins.map((b) => `${b} (${Math.round(statSync(b).size / 1e6)} MB)`).join(", ")}`);
  const blobs = bins.map((b) => readFileSync(b));
  for (const [name, spellings] of needles) {
    const hit = spellings.find((s) => blobs.some((buf) => buf.includes(Buffer.from(s, "utf8"))));
    report.results.push({ name: `binary contains ${name}`, ok: !!hit, detail: hit ? `found "${hit}"` : `none of ${spellings.map((s) => `"${s}"`).join(", ")}` });
  }
}

function versionCheck(tool, bin) {
  const report = { tool, version: null, results: [], notes: [] };
  reports.push(report);
  const r = run(bin, ["--version"], { env: { ...process.env, PATH: realPath } });
  const version = r.ok ? parseVersion(r.stdout) : null;
  report.version = version;
  report.results.push({ name: "--version parses", ok: !!version, detail: version ? r.stdout.trim() : `exit ${r.status}: ${r.stdout.trim()} ${r.stderr.trim()}`.trim() });
  if (version) {
    const c = COMPAT[tool];
    const cmp = compareVersions(version, c.testedUpTo);
    report.notes.push(
      cmp > 0
        ? `NEWER than tested: ${c.name} ${version}; src/compat.ts is tested up to ${c.testedUpTo} (verified ${VERIFIED_ON}) — if every check below passes, bump it`
        : `${c.name} ${version} is within the tested version (${c.testedUpTo})`,
    );
  }
  return report;
}

// --- Claude Code --------------------------------------------------------------

function claudeCanary() {
  const bin = resolveOnPath("claude");
  if (!bin) {
    reports.push({ tool: "claude", version: null, results: [{ name: "claude on PATH", ok: false, detail: "not found" }], notes: [] });
    return;
  }
  const report = versionCheck("claude", bin);
  // What `ms` depends on in Claude Code (find each in src/):
  //   hook events and the StopFailure matcher   src/hooks/install.ts EVENTS
  //   hook input fields                         src/hooks/claude-hook.ts
  //   wall phrases (`ms status` names a wall)   src/wall.ts PATTERNS
  //   per-account config dirs, credentials      src/paths.ts, src/providers/claude-usage.ts
  //   the launch's own id, the statusline key   src/launch.ts, src/setup/statusline.ts
  // The statusline wrapper passes Claude Code's JSON through untouched and
  // reads none of its fields (rate limits included), so there is nothing of
  // the statusline payload to check.
  const needles = [
    ...CLAUDE_EVENTS.map(([event]) => [`hook event ${event}`, [event]]),
    ...CLAUDE_EVENTS.filter(([, m]) => m).map(([event, m]) => [`${event} matcher ${m}`, [`"${m}"`, `'${m}'`, m]]),
    ["hook field hook_event_name", ["hook_event_name"]],
    ["hook field session_id", ["session_id"]],
    ["wall: You've hit your … limit", ["You've hit your"]],
    ["wall: You've reached your Fable limit", ["You've reached your Fable limit"]],
    ["wall: new messages wait for your usage limit to reset", ["new messages wait for your usage limit to reset"]],
    ["wall: usage limit reached", ["Usage limit reached", "usage limit reached"]],
    ["CLAUDE_CONFIG_DIR", ["CLAUDE_CONFIG_DIR"]],
    [".credentials.json", [".credentials.json"]],
    ["--session-id", ["--session-id", "session-id"]],
    ["statusLine setting", ["statusLine"]],
  ];
  stringChecks(report, nativeBinaries(bin), needles);
}

// --- Codex ----------------------------------------------------------------

function codexCanary() {
  const bin = resolveOnPath("codex");
  if (!bin) {
    reports.push({ tool: "codex", version: null, results: [{ name: "codex on PATH", ok: false, detail: "not found" }], notes: [] });
    return;
  }
  const report = versionCheck("codex", bin);
  // What `ms` depends on in Codex (find each in src/):
  //   hook TOML tables and trust-key events   src/hooks/codex-install.ts EVENTS
  //   the trust entry                          `[hooks.state."…"] trusted_hash`
  //   hook input fields                        src/hooks/codex-hook.ts
  //   the rollout record of a wall             src/hooks/codex-hook.ts (`task_complete`, `codex_error_info`)
  //   the wall's settings URL                  src/wall.ts PATTERNS
  const needles = [
    ...CODEX_EVENTS.flatMap((e) => [
      [`hook table ${e.table}`, [e.table]],
      [`trust-key event ${e.snake}`, [e.snake]],
    ]),
    ["trusted_hash", ["trusted_hash"]],
    ["hook field hook_event_name", ["hook_event_name"]],
    ["hook field turn_id", ["turn_id"]],
    ["hook field transcript_path", ["transcript_path"]],
    ["rollout task_complete", ["task_complete"]],
    ["rollout codex_error_info", ["codex_error_info"]],
    ["usage_limit_exceeded", ["usage_limit_exceeded"]],
    ["wall: chatgpt.com/codex/settings/usage", ["chatgpt.com/codex/settings/usage"]],
  ];
  stringChecks(report, nativeBinaries(bin), needles);
  daemonCheck(report, bin);
}

/** Every top-level entry of `dir` that is runtime state by a reading of its
 *  own: a socket (or a link to one), a .lock/.pid file, or a directory with a
 *  socket anywhere in its first three levels — one level deeper than the rule
 *  in src/codex-share.ts, so a socket Codex moves down a directory is caught
 *  here first. */
function runtimeEntries(dir) {
  const isSocket = (p) => {
    try {
      return statSync(p).isSocket();
    } catch {
      return false;
    }
  };
  const holdsSocket = (p, depth) => {
    if (depth > 3) return false;
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((d) => {
      const q = path.join(p, d.name);
      if (d.isSocket() || isSocket(q)) return true;
      return d.isDirectory() && holdsSocket(q, depth + 1);
    });
  };
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue; // a link `ms` made into the base: classified when it was made
    if (st.isSocket() || isSocket(p)) out.push(`${name} (socket)`);
    else if (st.isFile() && /\.(?:lock|pid)$/.test(name)) out.push(`${name} (${path.extname(name)} file)`);
    else if (st.isDirectory() && holdsSocket(p, 1)) out.push(`${name}/ (holds a socket)`);
  }
  return out;
}

/** The scratch daemon's `pid-update-loop`, which Codex 0.160 leaves running
 *  after `daemon stop`. Only a pid named in THIS home's pid file, and only if
 *  that process really is the loop. */
function killUpdater(codexHome) {
  const file = path.join(codexHome, "app-server-daemon", "daemon-updater.pid");
  let pid;
  try {
    pid = Number(JSON.parse(readFileSync(file, "utf8")).pid);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const ps = run("ps", ["-o", "command=", "-p", String(pid)]);
  if (!ps.ok || !ps.stdout.includes("pid-update-loop")) return null;
  try {
    process.kill(pid, "SIGTERM");
    return pid;
  } catch {
    return null;
  }
}

function daemon(bin, codexHome, verb) {
  const r = run(bin, ["app-server", "daemon", verb], { env: { ...process.env, PATH: realPath, CODEX_HOME: codexHome }, cwd: home });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "");
  } catch {
    /* not JSON: reported below */
  }
  return { ...r, json };
}

function daemonCheck(report, bin) {
  const add = (name, ok, detail) => report.results.push({ name, ok, detail });
  const base = process.env.MS_CODEX_BASE_DIR;
  mkdirSync(base, { recursive: true });
  // 1. The base, as a human's own `~/.codex` is: populated by Codex itself.
  for (const verb of ["start", "stop"]) {
    const r = daemon(bin, base, verb);
    if (!r.ok) {
      add(`daemon ${verb} in the base`, false, `exit ${r.status}: ${r.stderr.trim().slice(0, 400)}`);
      return;
    }
  }
  const killedBase = killUpdater(base);
  if (killedBase) report.notes.push(`killed the base daemon's stray pid-update-loop (${killedBase})`);
  // 2. An account home, built by ms's own code over that base.
  let codexHome;
  try {
    codexHome = ensureCodexHome("canary", () => {}, (line) => report.notes.push(`ensureCodexHome: ${line}`));
    const hooks = installCodexHooks(codexHome, process.env.MS_BIN);
    if (hooks.problem) throw new Error(hooks.problem);
  } catch (e) {
    add("ms builds an account home", false, String(e?.message ?? e));
    return;
  }
  const shared = readdirSync(codexHome).filter((n) => lstatSync(path.join(codexHome, n)).isSymbolicLink());
  report.notes.push(`home links ${shared.length} base entries: ${shared.join(", ")}`);
  const before = new Set(readdirSync(codexHome));
  // 3. The daemon, in the home.
  const start = daemon(bin, codexHome, "start");
  add("daemon start in an ms account home", start.ok, start.ok ? String(start.json?.status ?? start.stdout.trim()) : `exit ${start.status}: ${start.stderr.trim().slice(0, 400)}`);
  if (start.ok) {
    const v = daemon(bin, codexHome, "version");
    const socket = v.json?.socketPath;
    add("daemon version answers with a socketPath", v.ok && typeof socket === "string", v.ok ? `socketPath ${socket}` : `exit ${v.status}: ${v.stderr.trim().slice(0, 400)}`);
    if (typeof socket === "string") {
      // Inside the home as named, and still inside it once every link on the
      // way is resolved — a directory reached through a link into the base
      // would be the base's daemon. (The socket file itself may be a link to
      // a short path under /tmp: Codex's own, and inside the home's own dir.)
      const realHome = realpathSync(codexHome);
      let dir = null;
      try {
        dir = realpathSync(path.dirname(socket));
      } catch {
        /* reported below */
      }
      const named = socket.startsWith(codexHome + "/") || socket.startsWith(realHome + "/");
      add("socketPath is inside the home, not the base", named && !!dir && dir.startsWith(realHome + "/"), `${socket} (its directory resolves to ${dir})`);
    }
  }
  // 4. Classification, while the daemon's state is all there.
  const created = [...new Set(readdirSync(codexHome))].filter((n) => !before.has(n));
  report.notes.push(`Codex created in the home: ${created.join(", ") || "(nothing)"}`);
  const runtime = runtimeEntries(codexHome);
  for (const entry of runtime) {
    const name = entry.replace(/\/? \(.*$/, "");
    const ok = isRuntimeState(path.join(codexHome, name)) || CODEX_HOME_OWN.includes(name) || isHomeOwn(name);
    add(`runtime entry ${entry} is never shared by ms`, ok, ok ? "classified as runtime state" : "isRuntimeState/CODEX_HOME_OWN miss it: ms would link it into the base, and every account would share it");
  }
  if (!runtime.length) report.notes.push("no top-level runtime entries found in the home");
  const stop = daemon(bin, codexHome, "stop");
  add("daemon stop in the home", stop.ok, stop.ok ? String(stop.json?.status ?? "") : `exit ${stop.status}: ${stop.stderr.trim().slice(0, 400)}`);
  const killed = killUpdater(codexHome);
  if (killed) report.notes.push(`killed the home daemon's stray pid-update-loop (${killed})`);
}

// --- Run and report ----------------------------------------------------------

try {
  codexCanary();
} catch (e) {
  reports.push({ tool: "codex", version: null, results: [{ name: "canary ran", ok: false, detail: String(e?.stack ?? e) }], notes: [] });
}
try {
  claudeCanary();
} catch (e) {
  reports.push({ tool: "claude", version: null, results: [{ name: "canary ran", ok: false, detail: String(e?.stack ?? e) }], notes: [] });
}

const text = reports.map(markdown).join("\n\n");
process.stdout.write(text + "\n");
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## ms canary\n\n${text}\n`, { flag: "a" });
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(reports, null, 2) + "\n");

const failing = reports.filter((r) => r.results.some((x) => !x.ok));
try {
  rmSync(scratch, { recursive: true, force: true });
} catch {
  /* a runner is thrown away anyway */
}
process.exit(failing.length ? 1 : 0);
