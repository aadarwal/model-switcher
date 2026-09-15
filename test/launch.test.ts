import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 *  identity query and the `-P -F #{pane_id}` spawns with a pane id. */
const TMUX_STUB = `printf '%s\\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
case "$1" in
  display-message) echo "${IDENTITY}" ;;
  new-session|new-window) echo "%42" ;;
  has-session) exit "\${MS_TMUX_HAS_SESSION:-1}" ;;
esac
exit 0`;

type World = {
  home: string; msHome: string; log: string;
  env: (over?: Record<string, string>) => Record<string, string>;
};

/** A registry of two claude accounts with poll grants + launch tokens, a stub
 *  tmux on PATH and a stub usage endpoint. `usage` maps account → response. */
async function world(usage: Record<string, unknown> = { gmail: { body: GMAIL_OK }, work: { body: WORK_OK } }): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(dir, "tmux.log");
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
    home, msHome, log,
    env: (over = {}) => ({
      HOME: home, MS_HOME: msHome, MS_TMUX_LOG: log,
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

test("outside tmux: the tool's own server, session `ms`, then attach", async () => {
  const w = await world();
  const r = run(["claude", "--", "hi"], w.env(OUTSIDE));
  assert.equal(r.code, 0, r.stderr);

  const sock = path.join(w.msHome, "tmux.sock");
  const lines = logLines(w);
  assert.ok(lines.includes(`-S ${sock} has-session -t ms`), lines.join("\n"));
  const spawn = lines.find((l) => l.includes("new-session"));
  assert.ok(spawn, lines.join("\n"));
  const m = spawn!.match(new RegExp(`^-S ${sock.replace(/[/]/g, "\\/")} new-session -d -P -F #\\{pane_id\\} -s ms -c (\\S+) '(\\S+)' '_exec' '(${UUID})'$`));
  assert.ok(m, `new-session line not as expected: ${spawn}`);
  assert.equal(m![1], CWD);
  assert.equal(m![2], MS_BIN);

  assert.ok(lines.includes(`-S ${sock} set-option -p -t %42 remain-on-exit on`), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("set-option -p -t %42 @ms_session")));
  assert.ok(lines.some((l) => l.includes("set-hook -p -t %42 pane-died")));
  assert.equal(lines.at(-1), `-S ${sock} attach-session -t ms`);
  assert.ok(lines.indexOf(spawn!) < lines.indexOf(lines.at(-1)!));

  const st = await readState(w);
  const s = st.sessions[0]!;
  assert.equal(s.socket, sock);
  assert.equal(s.pane, "%42");
  assert.equal(s.serverStart, IDENTITY);
  assert.equal(s.state, "launching");
  assert.match(r.stderr, /^ms: gmail \(any\) → pane %42$/m);
});

test("outside tmux with the session already up: a new window in it", async () => {
  const w = await world();
  const r = run(["claude"], w.env({ ...OUTSIDE, MS_TMUX_HAS_SESSION: "0" }));
  assert.equal(r.code, 0, r.stderr);
  const lines = logLines(w);
  assert.equal(lines.some((l) => l.includes("new-session")), false, lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("new-window -P -F #{pane_id} -t ms")), lines.join("\n"));
  assert.equal(lines.at(-1), `-S ${path.join(w.msHome, "tmux.sock")} attach-session -t ms`);
});
