import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, tempHome, stubDir } from "./helpers.ts";

const SAMPLE_TOKEN = "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789";
const MS_BIN = path.resolve("bin/ms");
const CWD = process.cwd();
const IDENTITY = "4242:1789000000";
const TMUX_SOCKET = "/tmp/ms-test-tmux-socket";
const PANE = "%7";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The usage endpoint's own shape (kind + percent + resets_at), per account. */
const window_ = (percent: number, resetsAt: string) => ({ percent, resets_at: resetsAt });
const GMAIL_OK = {
  limits: [
    { kind: "session", ...window_(10, "2026-09-16T00:00:00Z") },
    { kind: "weekly_all", ...window_(20, "2026-09-18T00:00:00Z") },
  ],
};
const WORK_OK = {
  limits: [
    { kind: "session", ...window_(5, "2026-09-16T00:00:00Z") },
    { kind: "weekly_all", ...window_(10, "2026-09-20T00:00:00Z") },
    { kind: "weekly_scoped", ...window_(5, "2026-09-20T00:00:00Z"), scope: { model: { display_name: "Claude Fable 5" } } },
  ],
};
const FULL = {
  limits: [
    { kind: "session", ...window_(100, "2026-09-16T00:00:00Z") },
    { kind: "weekly_all", ...window_(100, "2026-09-18T00:00:00Z") },
  ],
};

/** A `--import` module that replaces global fetch, so the usage poll answers
 *  from a table keyed by the bearer token (= the account's access token). */
function usageStub(dir: string): string {
  const f = path.join(dir, "usage-stub.mjs");
  writeFileSync(
    f,
    `const table = JSON.parse(process.env.MS_TEST_USAGE || "{}");
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const auth = String((init.headers || {}).Authorization || "");
  const entry = table[auth.replace(/^Bearer /, "")] || { status: 500 };
  if (!u.includes("/api/oauth/usage")) return new Response("unexpected " + u, { status: 500 });
  const status = entry.status || 200;
  if (status !== 200) return new Response("boom", { status });
  return new Response(JSON.stringify(entry.body || {}), { status: 200, headers: { "content-type": "application/json" } });
};
`,
  );
  return pathToFileURL(f).href;
}

/** tmux, as far as a launch drives it: logs every argv line, answers the
 *  identity query and the `-P -F #{pane_id}` spawns with a pane id.
 *
 *  It also copies the store aside the moment `respawn-pane` is issued, which
 *  is the only way a test can see what the session row said BEFORE the CLI
 *  was started (`ms` has already returned by the time the test looks). */
const TMUX_STUB = `printf '%s\\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
case "$1" in
  display-message) echo "${IDENTITY}" ;;
  new-session|new-window) echo "%42" ;;
  has-session) exit "\${MS_TMUX_HAS_SESSION:-1}" ;;
  respawn-pane)
    mkdir -p "$MS_TMUX_SNAPSHOT"
    cp "$MS_HOME/state.sqlite" "$MS_TMUX_SNAPSHOT/state.sqlite" 2>/dev/null
    cp "$MS_HOME/state.sqlite-wal" "$MS_TMUX_SNAPSHOT/state.sqlite-wal" 2>/dev/null
    for f in "$MS_HOME"/codex/*/config.toml; do
      [ -f "$f" ] || continue
      d="$MS_TMUX_SNAPSHOT/codex/$(basename "$(dirname "$f")")"
      mkdir -p "$d"
      cp "$f" "$d/config.toml"
    done
    ;;
  attach-session) exit "\${MS_TMUX_ATTACH:-0}" ;;
esac
exit 0`;

/** A literal path inside a RegExp: a temp dir can hold `.` and `+`. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type World = {
  home: string; msHome: string; log: string; atRespawn: string;
  env: (over?: Record<string, string>) => Record<string, string>;
};

/** A registry of two claude accounts with poll grants + launch tokens, a stub
 *  tmux on PATH and a stub usage endpoint. `usage` maps account → response. */
async function world(usage: Record<string, unknown> = { gmail: { body: GMAIL_OK }, work: { body: WORK_OK } }): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(dir, "tmux.log");
  const atRespawn = path.join(dir, "at-respawn");
  stub("tmux", TMUX_STUB);
  const stubUrl = usageStub(dir);

  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "gmail", provider: "claude", label: "Gmail", shared: false },
        { name: "work", provider: "claude", label: "Work", shared: false },
      ],
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  const table: Record<string, unknown> = {};
  for (const name of ["gmail", "work"]) {
    saveLaunchToken(name, SAMPLE_TOKEN);
    const dirFor = path.join(msHome, "claude", name);
    mkdirSync(dirFor, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(dirFor, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() + 86_400_000 } }),
      { mode: 0o600 },
    );
    if (usage[name]) table[`at-${name}`] = usage[name];
  }

  return {
    home, msHome, log, atRespawn,
    env: (over = {}) => ({
      HOME: home, MS_HOME: msHome, MS_TMUX_LOG: log, MS_TMUX_SNAPSHOT: atRespawn,
      PATH: `${dir}:${process.env.PATH}`,
      ANTHROPIC_MODEL: "",
      MS_TEST_USAGE: JSON.stringify(table),
      NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import ${stubUrl}`,
      TMUX: TMUX_SOCKET + ",123,0", TMUX_PANE: PANE,
      ...over,
    }),
  };
}

const OUTSIDE = { TMUX: "", TMUX_PANE: "" };
const logLines = (w: World): string[] => readFileSync(w.log, "utf8").trim().split("\n");

/** The session rows as they stood at the instant tmux was told to respawn the
 *  pane into the CLI — i.e. what `ms _exec` could possibly have read. */
async function sessionsAtRespawn(w: World) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(w.atRespawn, "state.sqlite"));
  try {
    return db.prepare("SELECT id, pane, socket, serverStart, state, account FROM sessions").all() as unknown as
      { id: string; pane: string; socket: string; serverStart: string; state: string; account: string }[];
  } finally {
    db.close();
  }
}

/** The store as the launch left it, read in-process (the subprocess shares
 *  the same sqlite file on disk). */
async function readState(w: World, launchId?: string) {
  process.env.HOME = w.home; process.env.MS_HOME = w.msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  try {
    return { sessions: st.listSessions(), launch: launchId ? st.getLaunch(launchId) : null };
  } finally {
    st.close();
  }
}

// --- inside tmux -------------------------------------------------------

test("inside tmux: picks, records, and respawns the caller's own pane", async () => {
  const w = await world();
  const r = run(["claude", "--", "hello", "world"], w.env());

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ms: gmail \(any\) → pane %7$/m);
  assert.equal(r.stdout, "");

  const lines = logLines(w);
  const respawn = lines.find((l) => l.startsWith(`-S ${TMUX_SOCKET} respawn-pane`));
  assert.ok(respawn, `no respawn in:\n${lines.join("\n")}`);
  const m = respawn!.match(new RegExp(`^-S ${TMUX_SOCKET} respawn-pane -k -c (\\S+) -t %7 '(\\S+)' '_exec' '(${UUID})'$`));
  assert.ok(m, `respawn line not as expected: ${respawn}`);
  assert.equal(m![1], CWD);
  assert.equal(m![2], MS_BIN);
  const launchId = m![3]!;

  assert.ok(lines.includes(`-S ${TMUX_SOCKET} display-message -p #{pid}:#{start_time}`));
  assert.ok(lines.includes(`-S ${TMUX_SOCKET} set-option -p -t %7 remain-on-exit on`));
  const opt = lines.find((l) => l.includes("@ms_session"));
  assert.ok(opt, "no @ms_session pane option");
  const sessionId = opt!.trim().split(" ").pop()!;
  const hook = lines.find((l) => l.includes("set-hook"));
  assert.ok(hook, "no pane-died hook");
  assert.match(hook!, /set-hook -p -t %7 pane-died run-shell -b /);
  assert.ok(hook!.includes("_pane_died"), hook);
  assert.ok(hook!.includes(sessionId), hook);
  assert.ok(hook!.includes(MS_BIN), hook);

  // the hook and the option are set BEFORE the respawn that kills this process
  assert.ok(lines.indexOf(hook!) < lines.indexOf(respawn!));
  assert.ok(lines.indexOf(opt!) < lines.indexOf(respawn!));

  const st = await readState(w, launchId);
  assert.equal(st.sessions.length, 1);
  const s = st.sessions[0]!;
  assert.equal(s.id, sessionId);
  assert.equal(s.state, "launching");
  assert.equal(s.account, "gmail");
  assert.equal(s.generation, 1);
  assert.equal(s.provider, "claude");
  assert.equal(s.need, "any");
  assert.equal(s.desired, "running");
  assert.equal(s.pane, PANE);
  assert.equal(s.socket, TMUX_SOCKET);
  assert.equal(s.serverStart, IDENTITY);
  assert.equal(s.cwd, CWD);
  assert.deepEqual(s.flags, ["hello", "world"]);
  assert.match(s.cliSessionId!, new RegExp(`^${UUID}$`));

  const launch = st.launch;
  assert.ok(launch, "no launch row for the id tmux was given");
  assert.equal(launch!.sessionId, sessionId);
  assert.equal(launch!.account, "gmail");
  assert.equal(launch!.generation, 1);
  assert.deepEqual(launch!.command, ["claude", "--session-id", s.cliSessionId, "hello", "world"]);
  // nothing but the record: no environment is carried in the launch row
  assert.deepEqual(launch!.env, {});

  // the row was whole before tmux was told to start the CLI
  const early = await sessionsAtRespawn(w);
  assert.equal(early.length, 1);
  assert.equal(early[0]!.pane, PANE);
  assert.equal(early[0]!.serverStart, IDENTITY);
  assert.equal(early[0]!.account, "gmail");

  // no secret anywhere tmux can see it
  assert.equal(readFileSync(w.log, "utf8").includes(SAMPLE_TOKEN), false);

  // the successful pick is remembered, 0600
  const lastPick = path.join(w.msHome, "last-pick.json");
  assert.equal(statSync(lastPick).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(lastPick, "utf8")).any.name, "gmail");
});

test("--need fable picks the account that has a fable window", async () => {
  const w = await world();
  const r = run(["claude", "--need", "fable"], w.env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ms: work \(fable\) → pane %7$/m);
  const st = await readState(w);
  assert.equal(st.sessions[0]!.need, "fable");
  assert.equal(st.sessions[0]!.account, "work");
});

test("a --model naming fable needs fable without being told", async () => {
  const w = await world();
  const r = run(["claude", "--", "--model", "claude-fable-5"], w.env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ms: work \(fable\) → pane %7$/m);
  const st = await readState(w);
  assert.equal(st.sessions[0]!.need, "fable");
  assert.deepEqual(st.sessions[0]!.flags, ["--model", "claude-fable-5"]);
});

test("ANTHROPIC_MODEL naming fable needs fable", async () => {
  const w = await world();
  const r = run(["claude"], w.env({ ANTHROPIC_MODEL: "claude-fable-5-20260101" }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\(fable\)/);
});

test("~/.claude/settings.json naming fable needs fable", async () => {
  const w = await world();
  mkdirSync(path.join(w.home, ".claude"), { recursive: true });
  writeFileSync(path.join(w.home, ".claude", "settings.json"), JSON.stringify({ model: "fable" }));
  const r = run(["claude"], w.env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\(fable\)/);
});

// --- the ways it says no -----------------------------------------------

test("--as names an account the registry does not have: exit 1", async () => {
  const w = await world();
  const r = run(["claude", "--as", "nope"], w.env());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nope/);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  const st = await readState(w);
  assert.equal(st.sessions.length, 0);
});

test("--as an account with no launch token: exit 1, naming the account only", async () => {
  const w = await world();
  const { deleteLaunchToken } = await import("../src/launch-credentials.ts");
  process.env.MS_HOME = w.msHome;
  deleteLaunchToken("work");
  const r = run(["claude", "--as", "work"], w.env());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /work/);
  // The verb that MINTS a launch token is `login`; `add` only writes the
  // registry row, and an account named here already has one.
  assert.match(r.stderr, /ms accounts login work/);
  assert.equal(r.stderr.includes(SAMPLE_TOKEN), false);
  const st = await readState(w);
  assert.equal(st.sessions.length, 0);
});

test("every account at 100: exit 3, listing why each was passed over", async () => {
  const w = await world({ gmail: { body: FULL }, work: { body: FULL } });
  const r = run(["claude"], w.env());
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no account has room/);
  assert.match(r.stderr, /gmail: session window at 100/);
  assert.match(r.stderr, /work: session window at 100/);
  const st = await readState(w);
  assert.equal(st.sessions.length, 0);
});

test("usage unreachable and no recent pick: exit 4", async () => {
  const w = await world({ gmail: { status: 503 }, work: { status: 503 } });
  const r = run(["claude"], w.env());
  assert.equal(r.code, 4);
  assert.match(r.stderr, /usage unreachable/);
  const st = await readState(w);
  assert.equal(st.sessions.length, 0);
});

test("usage unreachable but a pick under 10 minutes old: launch on it", async () => {
  const w = await world({ gmail: { status: 503 }, work: { status: 503 } });
  writeFileSync(path.join(w.msHome, "last-pick.json"), JSON.stringify({ any: { name: "work", at: Date.now() - 60_000 } }), { mode: 0o600 });
  const r = run(["claude"], w.env());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ms: work \(any\) → pane %7$/m);
  const st = await readState(w);
  assert.equal(st.sessions[0]!.account, "work");
});

test("a pick older than 10 minutes is not a pick: exit 4", async () => {
  const w = await world({ gmail: { status: 503 }, work: { status: 503 } });
  writeFileSync(path.join(w.msHome, "last-pick.json"), JSON.stringify({ any: { name: "work", at: Date.now() - 11 * 60_000 } }), { mode: 0o600 });
  const r = run(["claude"], w.env());
  assert.equal(r.code, 4);
});

test("--session-id is ours: a user-supplied one is a usage error", async () => {
  const w = await world();
  const r = run(["claude", "--", "--session-id", "abc"], w.env());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--session-id/);
  const st = await readState(w);
  assert.equal(st.sessions.length, 0);
});

test("a bad --need, and claude args not behind --, are usage errors", async () => {
  const w = await world();
  const need = run(["claude", "--need", "sonnet"], w.env());
  assert.equal(need.code, 2);
  assert.match(need.stderr, /^ms claude: --need must be 'any' or 'fable'$/m);

  const loose = run(["claude", "--model", "x"], w.env());
  assert.equal(loose.code, 2);
  assert.match(loose.stderr, /unexpected argument "--model" — put claude's own arguments after --/);

  const dangling = run(["claude", "--as"], w.env());
  assert.equal(dangling.code, 2);
  assert.match(dangling.stderr, /^ms claude: --as needs an account name$/m);

  const st = await readState(w);
  assert.equal(st.sessions.length, 0);
});

// --- outside tmux ------------------------------------------------------

test("outside tmux: a placeholder pane first, then the CLI respawned into it", async () => {
  const w = await world();
  const r = run(["claude", "--", "hi"], w.env(OUTSIDE));
  assert.equal(r.code, 0, r.stderr);

  const sock = path.join(w.msHome, "tmux.sock");
  const lines = logLines(w);
  const at = (needle: string) => {
    const i = lines.findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `no ${needle} in:\n${lines.join("\n")}`);
    return i;
  };

  // The pane is made to exist FIRST, running something that cannot exit on
  // its own — never the CLI, which would start before the hook watching it.
  assert.ok(lines.includes(`-S ${sock} has-session -t ms`), lines.join("\n"));
  const spawn = at("new-session");
  assert.equal(lines[spawn], `-S ${sock} new-session -d -P -F #{pane_id} -s ms -c ${CWD} 'sleep' '2147483647'`);

  const remain = at("remain-on-exit on");
  const opt = at("@ms_session");
  const hook = at("pane-died");
  const respawn = at("respawn-pane");
  const attach = at("attach-session");
  assert.ok(spawn < remain && remain < respawn, lines.join("\n"));
  assert.ok(spawn < opt && opt < respawn, lines.join("\n"));
  assert.ok(spawn < hook && hook < respawn, lines.join("\n"));
  assert.ok(respawn < attach, lines.join("\n"));
  assert.equal(attach, lines.length - 1);
  assert.equal(lines[attach], `-S ${sock} attach-session -t ms`);
  assert.equal(lines[remain], `-S ${sock} set-option -p -t %42 remain-on-exit on`);

  const m = lines[respawn]!.match(
    new RegExp(`^-S ${esc(sock)} respawn-pane -k -c (\\S+) -t %42 '(\\S+)' '_exec' '(${UUID})'$`),
  );
  assert.ok(m, `respawn line not as expected: ${lines[respawn]}`);
  assert.equal(m![1], CWD);
  assert.equal(m![2], MS_BIN);
  const launchId = m![3]!;

  // The row was already whole when the CLI was started: `_exec` can never
  // read an empty pane into MS_PANE.
  const early = await sessionsAtRespawn(w);
  assert.equal(early.length, 1);
  assert.equal(early[0]!.pane, "%42");
  assert.equal(early[0]!.socket, sock);
  assert.equal(early[0]!.serverStart, IDENTITY);
  assert.equal(early[0]!.state, "launching");

  const st = await readState(w, launchId);
  const session = st.sessions[0]!;
  assert.equal(session.id, early[0]!.id);
  assert.equal(session.socket, sock);
  assert.equal(session.pane, "%42");
  assert.equal(session.serverStart, IDENTITY);
  assert.equal(session.state, "launching");
  assert.deepEqual(session.flags, ["hi"]);
  assert.deepEqual(st.launch!.command, ["claude", "--session-id", session.cliSessionId, "hi"]);
  assert.deepEqual(st.launch!.env, {});
  assert.match(r.stderr, /^ms: gmail \(any\) → pane %42$/m);
  assert.equal(readFileSync(w.log, "utf8").includes(SAMPLE_TOKEN), false);
});

test("outside tmux with the session already up: a new window in it", async () => {
  const w = await world();
  const r = run(["claude"], w.env({ ...OUTSIDE, MS_TMUX_HAS_SESSION: "0" }));
  assert.equal(r.code, 0, r.stderr);
  const sock = path.join(w.msHome, "tmux.sock");
  const lines = logLines(w);
  assert.equal(lines.some((l) => l.includes("new-session")), false, lines.join("\n"));
  assert.ok(lines.includes(`-S ${sock} new-window -P -F #{pane_id} -t ms -c ${CWD} 'sleep' '2147483647'`), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("respawn-pane")), lines.join("\n"));
  assert.equal(lines.at(-1), `-S ${sock} attach-session -t ms`);
  assert.equal((await sessionsAtRespawn(w))[0]!.pane, "%42");
});

test("a launch whose attach fails is still a launch: exit 0 and how to get back", async () => {
  const w = await world();
  const r = run(["claude"], w.env({ ...OUTSIDE, MS_TMUX_ATTACH: "1" }));
  const sock = path.join(w.msHome, "tmux.sock");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^ms: launched in the ms tmux server; attach with: tmux -S ${esc(sock)} attach -t ms$`, "m"));
  assert.equal(r.stderr.includes(SAMPLE_TOKEN), false);
  // and the launch really happened
  assert.ok(logLines(w).some((l) => l.includes("respawn-pane")));
  assert.equal((await readState(w)).sessions.length, 1);
});

// --- ms attach -----------------------------------------------------------

test("attach refuses when there is no tool-owned server, and otherwise attaches to it", async () => {
  // USAGE has advertised `ms attach` since the first cut; unregistered, it
  // answered "unknown verb" and exit 2. It is the only way back to a session
  // launched from outside tmux once the terminal that attached has gone.
  const w = await world();
  const sock = path.join(w.msHome, "tmux.sock");

  const absent = run(["attach"], w.env({ ...OUTSIDE, MS_TMUX_HAS_SESSION: "1" }));
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /^ms attach: no ms tmux server yet; run ms claude$/m);
  assert.equal(logLines(w).some((l) => l.includes("attach-session")), false, "nothing is attached to a server that is not there");
  assert.ok(logLines(w).some((l) => l === `-S ${sock} has-session -t ms`), logLines(w).join("\n"));

  const w2 = await world();
  const sock2 = path.join(w2.msHome, "tmux.sock");
  const r = run(["attach"], w2.env({ ...OUTSIDE, MS_TMUX_HAS_SESSION: "0" }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(logLines(w2).at(-1), `-S ${sock2} attach-session -t ms`);

  const bad = run(["attach", "ms"], w2.env({ ...OUTSIDE, MS_TMUX_HAS_SESSION: "0" }));
  assert.equal(bad.code, 2, "the verb takes no arguments; a session name is a mistake, not a target");
  assert.match(bad.stderr, /usage: ms attach/);
});

// --- the pick is only remembered once it has been acted on ---------------

test("a picked account with no launch token exits 1 and leaves no fallback", async () => {
  const w = await world();
  const { deleteLaunchToken } = await import("../src/launch-credentials.ts");
  process.env.MS_HOME = w.msHome;
  deleteLaunchToken("gmail"); // the account that wins on `any`

  const r = run(["claude"], w.env());

  assert.equal(r.code, 1);
  assert.match(r.stderr, /gmail/);
  assert.equal(r.stderr.includes(SAMPLE_TOKEN), false);
  assert.equal(existsSync(path.join(w.msHome, "last-pick.json")), false, "a pick that never ran must not become the fallback");
  assert.equal((await readState(w)).sessions.length, 0);
});

test("an empty registry is a configuration answer, not a full pool: exit 1", async () => {
  const w = await world();
  writeFileSync(path.join(w.msHome, "accounts.json"), JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
  const r = run(["claude"], w.env());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^ms claude: no claude account is registered/m);
});

// --- flag spellings and the settings read --------------------------------

test("the equals forms of --need and --as are the same flags", async () => {
  const w = await world();
  const need = run(["claude", "--need=fable"], w.env());
  assert.equal(need.code, 0, need.stderr);
  assert.match(need.stderr, /^ms: work \(fable\) → pane %7$/m);

  const w2 = await world();
  const as = run(["claude", "--as=work"], w2.env());
  assert.equal(as.code, 0, as.stderr);
  assert.match(as.stderr, /^ms: work \(any\) → pane %7$/m);
  assert.equal((await readState(w2)).sessions[0]!.account, "work");
});

test("an empty --model= does not swallow the other sources", async () => {
  const w = await world();
  const r = run(["claude", "--", "--model="], w.env({ ANTHROPIC_MODEL: "claude-fable-5" }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\(fable\)/);
});

test("the settings read follows CLAUDE_CONFIG_DIR when it is set", async () => {
  const w = await world();
  const configDir = path.join(w.home, "elsewhere");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ model: "claude-fable-5" }));
  // ~/.claude/settings.json says otherwise, and must not be the one consulted
  mkdirSync(path.join(w.home, ".claude"), { recursive: true });
  writeFileSync(path.join(w.home, ".claude", "settings.json"), JSON.stringify({ model: "claude-sonnet-4" }));

  const r = run(["claude"], w.env({ CLAUDE_CONFIG_DIR: configDir }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\(fable\)/);
});

// --- the registry itself ------------------------------------------------

test("an unreadable registry names the problem; it is never an empty pool", async () => {
  const w = await world();
  writeFileSync(path.join(w.msHome, "accounts.json"), "{ this is not json", { mode: 0o600 });

  const r = run(["claude"], w.env());
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /accounts\.json/);
  // "could not look" must never be reported as "nothing has room" or as an
  // empty registry — both would send the human looking in the wrong place.
  assert.equal(/no account has room/.test(r.stderr), false, r.stderr);
  assert.equal(/no claude account is registered/.test(r.stderr), false, r.stderr);

  // nor may --as turn it into "no such account"
  const as = run(["claude", "--as", "work"], w.env());
  assert.equal(as.code, 1, as.stderr);
  assert.match(as.stderr, /accounts\.json/);
  assert.equal(/no such account/.test(as.stderr), false, as.stderr);

  assert.equal((await readState(w)).sessions.length, 0);
});

// --- ms codex ------------------------------------------------------------
//
// A Codex account carries ONE credential, `auth.json` inside its own
// CODEX_HOME, and no launch token — so the world below is the Claude world's
// shape with that one difference, plus a usage snapshot stated on disk.
//
// The snapshot is stated rather than served because the Codex POLLER is a
// different task's: what `ms codex` is answerable for is choosing correctly
// from the numbers the snapshot holds, whoever read them. A snapshot file
// younger than the freshness window is served without a single request, so
// these tests touch the network zero times — and the stub below turns any
// attempt to into a loud failure rather than a call to chatgpt.com.

/** `codex login`'s file, as far as a launch reads it: existence only. */
const codexAuth = (name: string) =>
  JSON.stringify({
    tokens: { id_token: "x.y.z", access_token: `cat-${name}`, refresh_token: `crt-${name}`, account_id: `acc-${name}` },
  });

/** One row of the usage cache, as `src/snapshot.ts` writes it. Codex reports
 *  no Fable-scoped window, so `weeklyFable` is null — which is exactly why
 *  `--need fable` can never be answered by a Codex account. */
const usageRow = (name: string, provider: "claude" | "codex", session: number, weekly: number) => ({
  name, provider, shared: false,
  usage: {
    session: { usedPercent: session, resetsAt: "2026-09-16T00:00:00Z" },
    weeklyAll: { usedPercent: weekly, resetsAt: "2026-09-20T00:00:00Z" },
    weeklyFable: null,
  },
  error: null, errorKind: null, observedAt: Date.now(), stale: false,
});

/** The same row after a failed poll: a reading we could not take, which is
 *  what makes a remembered pick admissible at all. */
const unreachableRow = (name: string, provider: "claude" | "codex") => ({
  name, provider, shared: false,
  usage: null, error: "the usage endpoint could not be reached", errorKind: "transient",
  observedAt: null, stale: true,
});

function noFetchStub(dir: string): string {
  const f = path.join(dir, "no-fetch-stub.mjs");
  writeFileSync(f, `globalThis.fetch = async (url) => { throw new Error("test: unexpected network call to " + url); };\n`);
  return pathToFileURL(f).href;
}

type CodexSpec = { name: string; session?: number; weekly?: number; auth?: boolean; unreachable?: boolean };

/** One claude account (so the registry is mixed and the provider filter has
 *  something to filter) plus the named codex accounts. */
async function codexWorld(codex: CodexSpec[]): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(dir, "tmux.log");
  const atRespawn = path.join(dir, "at-respawn");
  stub("tmux", TMUX_STUB);
  const stubUrl = noFetchStub(dir);

  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "gmail", provider: "claude", label: "Gmail", shared: false },
        ...codex.map((c) => ({ name: c.name, provider: "codex", label: c.name, shared: false })),
      ],
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);

  for (const c of codex) {
    const h = path.join(msHome, "codex", c.name);
    mkdirSync(h, { recursive: true, mode: 0o700 });
    if (c.auth !== false) writeFileSync(path.join(h, "auth.json"), codexAuth(c.name), { mode: 0o600 });
  }

  writeFileSync(
    path.join(msHome, "snapshot.json"),
    JSON.stringify({
      takenAt: Date.now(),
      accounts: [
        usageRow("gmail", "claude", 10, 20),
        ...codex.map((c) =>
          c.unreachable ? unreachableRow(c.name, "codex") : usageRow(c.name, "codex", c.session ?? 0, c.weekly ?? 0),
        ),
      ],
      backoff: {},
    }),
    { mode: 0o600 },
  );

  return {
    home, msHome, log, atRespawn,
    env: (over = {}) => ({
      HOME: home, MS_HOME: msHome, MS_TMUX_LOG: log, MS_TMUX_SNAPSHOT: atRespawn,
      PATH: `${dir}:${process.env.PATH}`,
      ANTHROPIC_MODEL: "",
      MS_TEST_USAGE: "{}",
      NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import ${stubUrl}`,
      TMUX: TMUX_SOCKET + ",123,0", TMUX_PANE: PANE,
      ...over,
    }),
  };
}

const configToml = (msHome: string, name: string) => path.join(msHome, "codex", name, "config.toml");

test("ms codex launches the codex account with the most room, on its own home", async () => {
  // `work` is ALSO a claude account name in the other world; identity is
  // (provider, name), and nothing here may reach for the claude side.
  const w = await codexWorld([{ name: "home", weekly: 10 }, { name: "work", weekly: 80 }]);
  const r = run(["codex", "--", "--model", "gpt-5"], w.env());

  assert.equal(r.code, 0, r.stderr);
  // The parenthesis says what constrained the pick. Codex has one window and
  // no fable scope, so there is no need to name — the provider is the fact.
  assert.match(r.stderr, /^ms: home \(codex\) → pane %7$/m);
  assert.equal(r.stdout, "");

  const lines = logLines(w);
  const respawn = lines.find((l) => l.startsWith(`-S ${TMUX_SOCKET} respawn-pane`));
  assert.ok(respawn, `no respawn in:\n${lines.join("\n")}`);
  const m = respawn!.match(new RegExp(`^-S ${TMUX_SOCKET} respawn-pane -k -c (\\S+) -t %7 '(\\S+)' '_exec' '(${UUID})'$`));
  assert.ok(m, `respawn line not as expected: ${respawn}`);
  assert.equal(m![2], MS_BIN);
  const launchId = m![3]!;

  const st = await readState(w, launchId);
  assert.equal(st.sessions.length, 1);
  const s = st.sessions[0]!;
  assert.equal(s.provider, "codex");
  assert.equal(s.account, "home");
  assert.equal(s.need, "any");
  assert.equal(s.state, "launching");
  assert.equal(s.pane, PANE);
  assert.equal(s.cwd, CWD);
  assert.deepEqual(s.flags, ["--model", "gpt-5"]);
  // Codex has no `--session-id`: the id arrives with the hook's SessionStart.
  assert.equal(s.cliSessionId, null);

  assert.deepEqual(st.launch!.command, ["codex", "--model", "gpt-5"]);
  assert.deepEqual(st.launch!.env, {});

  // The memo is per provider: a codex pick may never be offered to claude.
  const lastPick = JSON.parse(readFileSync(path.join(w.msHome, "last-pick.json"), "utf8"));
  assert.equal(lastPick["codex:any"].name, "home");
  assert.equal(lastPick.any, undefined);
});

/** The stored gate row `ms codex` is supposed to mirror on the way past
 *  (src/launch.ts:449) — `ms _recover`/`ms _codex_watch` are dispatched by
 *  `tmux run-shell` and only ever see the tmux SERVER's environment, never
 *  the shell that typed `export MS_CODEX_AUTOROTATE=1`, so something that
 *  DOES run in that shell has to carry it into the store. */
async function codexAutorotateKv(w: World): Promise<string | null> {
  process.env.HOME = w.home; process.env.MS_HOME = w.msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  try {
    return st.getKv("codexAutorotate");
  } finally {
    st.close();
  }
}

test("ms codex mirrors an exported MS_CODEX_AUTOROTATE into the stored kv row", async () => {
  const on = await codexWorld([{ name: "home", weekly: 10 }]);
  assert.equal(run(["codex"], on.env({ MS_CODEX_AUTOROTATE: "1" })).code, 0);
  assert.equal(await codexAutorotateKv(on), "1");

  // Exactly "1" is on: a variable somebody exported as "0" to turn this OFF
  // must mirror as off, never as "nothing was said".
  const off = await codexWorld([{ name: "home", weekly: 10 }]);
  assert.equal(run(["codex"], off.env({ MS_CODEX_AUTOROTATE: "0" })).code, 0);
  assert.equal(await codexAutorotateKv(off), "0");
});

test("ms codex leaves the stored kv row untouched when MS_CODEX_AUTOROTATE is not exported", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  assert.equal(run(["codex"], w.env()).code, 0);
  assert.equal(await codexAutorotateKv(w), null, "no export means no write, not 'off'");
});

test("the cwd is trusted in the account's own home before the CLI is started", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  const r = run(["codex"], w.env());
  assert.equal(r.code, 0, r.stderr);

  const real = realpathSync(CWD);
  const expected = `[projects.${JSON.stringify(real)}]`;
  // What tmux was told to run the CLI with — i.e. the file as it stood at the
  // instant the modal would otherwise have appeared.
  const atRespawn = readFileSync(path.join(w.atRespawn, "codex", "home", "config.toml"), "utf8");
  assert.ok(atRespawn.includes(expected), atRespawn);
  assert.match(atRespawn, /^trust_level = "trusted"$/m);
  // and it is only ever this account's home
  assert.equal(existsSync(configToml(w.msHome, "home")), true);

  // A second launch adds nothing: the table is written if absent, never again.
  const before = readFileSync(configToml(w.msHome, "home"), "utf8");
  const again = run(["codex"], w.env());
  assert.equal(again.code, 0, again.stderr);
  assert.equal(readFileSync(configToml(w.msHome, "home"), "utf8"), before);
});

test("the hook tables in the same config.toml survive a launch untouched", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  const hooks = `[[hooks.SessionStart]]\nmatcher = "*"\nhooks = [{ type = "command", command = "/opt/ms _hook codex" }]\n\n[hooks.state."/x:session_start:0:0"]\ntrusted_hash = "sha256:deadbeef"\n`;
  writeFileSync(configToml(w.msHome, "home"), hooks, { mode: 0o600 });

  const r = run(["codex"], w.env());
  assert.equal(r.code, 0, r.stderr);

  const text = readFileSync(configToml(w.msHome, "home"), "utf8");
  assert.ok(text.startsWith(hooks), `the hook tables were rewritten:\n${text}`);
  assert.match(text, /^trust_level = "trusted"$/m);
});

test("a codex home with no hooks gets them installed before the pane is launched", async () => {
  // A-I4. A hook-less Codex home starts fine and reports NOTHING: no
  // SessionStart, so the row never learns its conversation id or its rollout
  // path; reconcile adopts it as `running` after five minutes, so `ms status`
  // reads healthy; the watchdog never arms. The bill arrives at the first
  // `ms rotate`, which finds no conversation to resume and respawns a plain
  // `codex` over the human's own. So no Codex pane is ever launched blind.
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  assert.equal(existsSync(configToml(w.msHome, "home")), false, "nothing has written this home's config yet");

  const r = run(["codex"], w.env());
  assert.equal(r.code, 0, r.stderr);

  const { codexHooksInstalled } = await import("../src/hooks/codex-install.ts");
  assert.equal(codexHooksInstalled(path.join(w.msHome, "codex", "home"), MS_BIN), true);
  // And they were there at the instant tmux was told to run the CLI, not a
  // moment after it: the snapshot is the file as the respawn saw it. (It is
  // compared as TEXT, because a trust key names the config's own path and a
  // copy at another path can never read as installed.)
  const atRespawn = readFileSync(path.join(w.atRespawn, "codex", "home", "config.toml"), "utf8");
  assert.ok(atRespawn.includes("[[hooks.SessionStart]]"), atRespawn);
  assert.ok(atRespawn.includes(`command = "${MS_BIN} _hook codex"`), atRespawn);
  assert.ok(atRespawn.includes(`[hooks.state."${configToml(w.msHome, "home")}:session_start:0:0"]`), atRespawn);

  // A second launch installs nothing again: the file does not move.
  const before = readFileSync(configToml(w.msHome, "home"), "utf8");
  assert.equal(run(["codex"], w.env()).code, 0);
  assert.equal(readFileSync(configToml(w.msHome, "home"), "utf8"), before);
});

test("a config.toml the hook installer will not touch refuses the launch, naming the doctor", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  // A `hooks` table this tool cannot classify — the installer's own refusal.
  writeFileSync(configToml(w.msHome, "home"), "[hooks]\nSessionStart = []\n", { mode: 0o600 });

  const r = run(["codex"], w.env());
  assert.equal(r.code, 1, r.stderr); // EXIT_ACCOUNT: a home that is not ready
  assert.match(r.stderr, /a 'hooks' table this tool cannot read/);
  assert.match(r.stderr, /ms doctor --fix/);
  assert.equal(existsSync(w.log), false, "tmux was never invoked at all: no pane was launched blind");
});

test("ms codex --need fable is a usage error: there is no such window", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  const r = run(["codex", "--need", "fable"], w.env());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^ms codex: codex has no fable window$/m);
  assert.equal((await readState(w)).sessions.length, 0);

  // `--need any` is the only thing there is, and it is allowed to be said
  const ok = run(["codex", "--need=any"], w.env());
  assert.equal(ok.code, 0, ok.stderr);
});

test("--as an account whose auth.json is missing: exit 1, naming the login", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }, { name: "work", weekly: 80, auth: false }]);
  const r = run(["codex", "--as", "work"], w.env());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /work/);
  assert.match(r.stderr, /ms accounts login work/);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.equal((await readState(w)).sessions.length, 0);
  assert.equal(existsSync(configToml(w.msHome, "work")), false, "an account that cannot launch trusts nothing");
});

test("a claude fallback pick is never reused for a codex launch", async () => {
  const w = await codexWorld([{ name: "home", unreachable: true }]);
  // A remembered CLAUDE pick, of an account name that does not even exist on
  // the codex side of the registry: taking it would launch the wrong CLI on
  // the wrong credential.
  writeFileSync(
    path.join(w.msHome, "last-pick.json"),
    JSON.stringify({ any: { name: "home", at: Date.now() - 60_000 } }),
    { mode: 0o600 },
  );

  const r = run(["codex"], w.env());
  assert.equal(r.code, 4);
  assert.match(r.stderr, /^ms codex: usage unreachable$/m);
  assert.equal((await readState(w)).sessions.length, 0);

  // ...and the codex memo, written by a codex launch, IS its fallback
  writeFileSync(
    path.join(w.msHome, "last-pick.json"),
    JSON.stringify({ "codex:any": { name: "home", at: Date.now() - 60_000 } }),
    { mode: 0o600 },
  );
  const again = run(["codex"], w.env());
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stderr, /^ms: home \(codex\) → pane %7$/m);
});

test("a registry with no codex account is a configuration answer: exit 1", async () => {
  const w = await world(); // claude accounts only
  const r = run(["codex"], w.env());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^ms codex: no codex account is registered/m);
  assert.match(r.stderr, /--provider codex/);
});

test("every codex account at 100: exit 3, and the claude accounts are not consulted", async () => {
  const w = await codexWorld([{ name: "home", weekly: 100 }, { name: "work", session: 100 }]);
  const r = run(["codex"], w.env());
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no account has room/);
  assert.match(r.stderr, /home: weekly window at 100/);
  assert.match(r.stderr, /work: session window at 100/);
  // gmail has plenty of room and is the wrong provider: it is not even a
  // candidate, so it never appears among the reasons.
  assert.equal(/gmail/.test(r.stderr), false, r.stderr);
});

test("codex's own arguments go after --, and the message says so", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  const loose = run(["codex", "--model", "x"], w.env());
  assert.equal(loose.code, 2);
  assert.match(loose.stderr, /unexpected argument "--model" — put codex's own arguments after --/);
  assert.equal((await readState(w)).sessions.length, 0);
});

test("outside tmux, ms codex takes the same tool-owned server path", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  const r = run(["codex"], w.env(OUTSIDE));
  assert.equal(r.code, 0, r.stderr);
  const sock = path.join(w.msHome, "tmux.sock");
  const lines = logLines(w);
  assert.ok(lines.includes(`-S ${sock} new-session -d -P -F #{pane_id} -s ms -c ${CWD} 'sleep' '2147483647'`), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("respawn-pane")), lines.join("\n"));
  assert.equal(lines.at(-1), `-S ${sock} attach-session -t ms`);
  assert.match(r.stderr, /^ms: home \(codex\) → pane %42$/m);
  const st = await readState(w);
  assert.equal(st.sessions[0]!.provider, "codex");
  assert.equal(st.sessions[0]!.cliSessionId, null);
  // the trust table was in place before the CLI was respawned into the pane
  assert.match(readFileSync(path.join(w.atRespawn, "codex", "home", "config.toml"), "utf8"), /^trust_level = "trusted"$/m);
});

test("a home that cannot be written is a named refusal, not a silent modal", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  // A directory where config.toml must be a file: the write cannot succeed.
  mkdirSync(configToml(w.msHome, "home"), { recursive: true });
  const r = run(["codex"], w.env());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /trust/i);
  assert.equal((await readState(w)).sessions.length, 0);
  rmSync(configToml(w.msHome, "home"), { recursive: true, force: true });
});

test("an auth.json with no access token is no credential: exit 1, and no fallback", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  // A login that was interrupted, or a file someone truncated. It parses; it
  // authenticates nothing.
  writeFileSync(path.join(w.msHome, "codex", "home", "auth.json"), "{}", { mode: 0o600 });

  const r = run(["codex"], w.env());

  assert.equal(r.code, 1);
  assert.match(r.stderr, /^ms codex: no codex credential for account 'home' \(run: ms accounts login home --provider codex\)$/m);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.equal((await readState(w)).sessions.length, 0);
  assert.equal(existsSync(path.join(w.msHome, "last-pick.json")), false, "a pick that never ran must not become the fallback");
  assert.equal(existsSync(configToml(w.msHome, "home")), false, "an account that cannot launch trusts nothing");
});

test("a cwd the human marked untrusted stops the launch; the tool does not overrule them", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  const config = configToml(w.msHome, "home");
  const before = `[projects.${JSON.stringify(realpathSync(CWD))}]\ntrust_level = "untrusted"\n`;
  writeFileSync(config, before, { mode: 0o600 });

  const r = run(["codex"], w.env());

  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`^ms codex: ${esc(realpathSync(CWD))} is marked untrusted in ${esc(config)}; edit it or launch elsewhere$`, "m"));
  assert.equal(readFileSync(config, "utf8"), before);
  assert.equal((await readState(w)).sessions.length, 0);
  // The refusal comes before the first tmux call, so there is not even a log:
  // nothing was created, respawned or recorded on the human's behalf.
  assert.equal(existsSync(w.log), false, "nothing was started");
});

test("a config.toml this tool cannot add to safely stops the launch, naming the file", async () => {
  const w = await codexWorld([{ name: "home", weekly: 10 }]);
  const config = configToml(w.msHome, "home");
  // Appending beside this would define `projects` twice — invalid TOML, at
  // which point Codex drops the WHOLE file: the hook tables and every
  // directory already trusted with them.
  const before = `projects = { "/a/b" = { trust_level = "trusted" } }\n\n[[hooks.Stop]]\nhooks = []\n`;
  writeFileSync(config, before, { mode: 0o600 });

  const r = run(["codex"], w.env());

  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`^ms codex: ${esc(config)} already defines 'projects'`, "m"));
  assert.equal(readFileSync(config, "utf8"), before, "a refusal writes nothing at all");
  assert.equal((await readState(w)).sessions.length, 0);
});
