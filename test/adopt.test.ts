// `ms adopt`: take over a Codex conversation this tool did not start.
//
// The pure halves (filename ids, the `history_base` walk, the copy) are
// exercised directly; the verb is exercised end to end through the real `ms`
// binary against a stubbed tmux, exactly as launch.test.ts does — because what
// it is answerable for is the COMMAND LINE that reaches the CLI and the FILES
// that land in the store, and neither is visible from inside the process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, stubDir, tempHome } from "./helpers.ts";

const TMUX_SOCKET = "/tmp/ms-test-adopt-socket";
const PANE = "%7";
const IDENTITY = "4242:1789000000";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MS_BIN = path.resolve("bin/ms");

const LEAF = "11111111-1111-4111-8111-111111111111";
const MID = "22222222-2222-4222-8222-222222222222";
const ROOT = "33333333-3333-4333-8333-333333333333";

const rolloutName = (date: string, id: string) => `rollout-${date}T09-15-00-${id}.jsonl`;

/** One rollout file, in Codex's own JSONL shape: a `session_meta` line whose
 *  payload carries `history_base` when this file is a continuation of another,
 *  then an ordinary record. */
function writeRollout(root: string, date: string, id: string, base: string | null): string {
  const [y, m, d] = date.split("-");
  const dir = path.join(root, y!, m!, d!);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta = {
    timestamp: `${date}T09:15:00.000Z`,
    type: "session_meta",
    payload: {
      session_id: id, id, timestamp: `${date}T09:15:00.000Z`, cwd: "/tmp",
      originator: "codex_cli_rs", cli_version: "0.153.4", history_mode: "paginated",
      ...(base ? { history_base: { thread_id: base, end_ordinal_exclusive: 12, end_byte_offset: 4096 } } : {}),
    },
  };
  const turn = { timestamp: `${date}T09:16:00.000Z`, ordinal: 1, type: "response_item", payload: { type: "message", role: "user" } };
  const file = path.join(dir, rolloutName(date, id));
  writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify(turn)}\n`, { mode: 0o600 });
  return file;
}

/** A two-level chain: LEAF's history points at MID, MID's at ROOT. This is the
 *  compacted conversation that broke the hand-rescue — resuming LEAF alone
 *  fails with `missing source rollout` until MID (and then ROOT) are there. */
function chain(sessions: string): { leaf: string; mid: string; root: string } {
  const root = writeRollout(sessions, "2026-09-15", ROOT, null);
  const mid = writeRollout(sessions, "2026-09-16", MID, ROOT);
  const leaf = writeRollout(sessions, "2026-09-17", LEAF, MID);
  return { leaf, mid, root };
}

// --- Pure helpers ----------------------------------------------------------

test("a rollout filename yields its thread id, and a reverted thread's own rollout id after the underscore", async () => {
  const { rolloutIdsFromName, datePartsFromName } = await import("../src/adopt.ts");
  assert.deepEqual(rolloutIdsFromName(rolloutName("2026-09-17", LEAF)), { threadId: LEAF, rolloutId: LEAF });
  assert.deepEqual(
    rolloutIdsFromName(`rollout-2026-09-17T09-15-00-${LEAF}_${MID}.jsonl`),
    { threadId: LEAF, rolloutId: MID },
  );
  assert.equal(rolloutIdsFromName("notes.jsonl"), null);
  assert.equal(rolloutIdsFromName("rollout-short.jsonl"), null);
  assert.deepEqual(datePartsFromName(rolloutName("2026-09-17", LEAF)), ["2026", "09", "17"]);
  assert.equal(datePartsFromName("notes.jsonl"), null);
});

test("lineageIds reads history_base.thread_id — the field codex's own resolve_rollout_lineage follows", async () => {
  const { lineageIds } = await import("../src/adopt.ts");
  const { home } = tempHome();
  const sessions = path.join(home, ".codex", "sessions");
  const c = chain(sessions);
  assert.deepEqual(lineageIds(c.leaf), [MID]);
  assert.deepEqual(lineageIds(c.mid), [ROOT]);
  assert.deepEqual(lineageIds(c.root), [], "a standalone conversation points at nothing");
});

test("copyLineage copies the whole chain into the store's own YYYY/MM/DD, 0600 under 0700, and never touches the source", async () => {
  const { copyLineage } = await import("../src/adopt.ts");
  const { home } = tempHome();
  const sessions = path.join(home, ".codex", "sessions");
  const store = path.join(home, "store", "codex", "sessions");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const c = chain(sessions);
  const before = { leaf: readFileSync(c.leaf, "utf8"), mid: readFileSync(c.mid, "utf8"), root: readFileSync(c.root, "utf8") };

  const out = copyLineage(sessions, store, c.leaf);

  assert.equal(out.copied.length, 3, `the leaf and BOTH its sources: ${JSON.stringify(out)}`);
  assert.deepEqual(out.missing, []);
  for (const [date, id] of [["2026-09-17", LEAF], ["2026-09-16", MID], ["2026-09-15", ROOT]] as const) {
    const [y, m, d] = date.split("-");
    const dest = path.join(store, y!, m!, d!, rolloutName(date, id));
    assert.ok(existsSync(dest), `${id} is not in the store`);
    assert.equal(statSync(dest).mode & 0o777, 0o600, `${id} is not 0600`);
    assert.equal(statSync(path.dirname(dest)).mode & 0o777, 0o700, `${id}'s day dir is not 0700`);
  }
  // The human's own home is left exactly as it was: copied, never moved.
  assert.equal(readFileSync(c.leaf, "utf8"), before.leaf);
  assert.equal(readFileSync(c.mid, "utf8"), before.mid);
  assert.equal(readFileSync(c.root, "utf8"), before.root);
});

test("copyLineage never overwrites a rollout already in the store", async () => {
  const { copyLineage } = await import("../src/adopt.ts");
  const { home } = tempHome();
  const sessions = path.join(home, ".codex", "sessions");
  const store = path.join(home, "store", "codex", "sessions");
  const c = chain(sessions);
  // MID is already there, and is the file a live CLI might be appending to.
  const midDir = path.join(store, "2026", "09", "16");
  mkdirSync(midDir, { recursive: true, mode: 0o700 });
  const midDest = path.join(midDir, rolloutName("2026-09-16", MID));
  writeFileSync(midDest, "ALREADY HERE\n", { mode: 0o600 });

  const out = copyLineage(sessions, store, c.leaf);

  assert.equal(readFileSync(midDest, "utf8"), "ALREADY HERE\n", "an existing rollout was replaced");
  assert.deepEqual(out.kept, [midDest]);
  assert.equal(out.copied.length, 2, "the leaf and the root still land");
});

test("copyLineage reports a lineage whose source rollout is nowhere, rather than copying a chain codex will refuse", async () => {
  const { copyLineage } = await import("../src/adopt.ts");
  const { home } = tempHome();
  const sessions = path.join(home, ".codex", "sessions");
  const store = path.join(home, "store", "codex", "sessions");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const leaf = writeRollout(sessions, "2026-09-17", LEAF, MID); // MID never written

  const out = copyLineage(sessions, store, leaf);

  assert.equal(out.copied.length, 1);
  assert.deepEqual(out.missing, [MID]);
});

test("parseAdoptArgs: an id, our flags, and everything after -- belongs to codex", async () => {
  const { parseAdoptArgs } = await import("../src/adopt.ts");
  assert.deepEqual(parseAdoptArgs([LEAF, "--as", "work", "--continue", "--", "--yolo"]), {
    id: LEAF, as: "work", continueAfter: true, args: ["--yolo"],
  });
  assert.deepEqual(parseAdoptArgs([LEAF]), { id: LEAF, as: null, continueAfter: false, args: [] });
  assert.ok("error" in parseAdoptArgs([]));
  assert.ok("error" in parseAdoptArgs([LEAF, "--yolo"]), "codex's own flag before -- is a mistake, not a guess");
  assert.ok("error" in parseAdoptArgs([LEAF, "extra"]));
});

// --- The verb, end to end --------------------------------------------------

const usageRow = (name: string, provider: "claude" | "codex", weekly: number) => ({
  name, provider, shared: false,
  usage: {
    session: { usedPercent: 0, resetsAt: "2026-09-18T00:00:00Z" },
    weeklyAll: { usedPercent: weekly, resetsAt: "2026-09-20T00:00:00Z" },
    weeklyFable: null,
  },
  error: null, errorKind: null, observedAt: Date.now(), stale: false,
});

/** tmux, as far as a launch drives it. `MS_TEST_PANE_CMD` is what the pane
 *  reports as its current command, which is the one thing `ms adopt` asks tmux
 *  before it writes anything. */
const TMUX_STUB = `printf '%s\\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
case "$1" in
  display-message)
    case "$*" in
      *pane_current_command*) printf '999\\t%s\\t0\\t/tmp\\t\\n' "\${MS_TEST_PANE_CMD:-bash}" ;;
      *) echo "${IDENTITY}" ;;
    esac ;;
  new-session|new-window) echo "%42" ;;
  has-session) exit 1 ;;
esac
exit 0`;

function noFetchStub(dir: string): string {
  const f = path.join(dir, "no-fetch-stub.mjs");
  writeFileSync(f, `globalThis.fetch = async (url) => { throw new Error("test: unexpected network call to " + url); };\n`);
  return pathToFileURL(f).href;
}

const codexAuth = (name: string) =>
  JSON.stringify({ tokens: { id_token: "x.y.z", access_token: `cat-${name}`, refresh_token: `crt-${name}`, account_id: `acc-${name}` } });

type World = { home: string; msHome: string; log: string; sessions: string; env: (o?: Record<string, string>) => Record<string, string> };

async function adoptWorld(): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(dir, "tmux.log");
  stub("tmux", TMUX_STUB);
  const stubUrl = noFetchStub(dir);

  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ name: "home", provider: "codex", label: "home", shared: false }] }),
    { mode: 0o600 },
  );
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const h = path.join(msHome, "codex", "home");
  mkdirSync(h, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(h, "auth.json"), codexAuth("home"), { mode: 0o600 });
  writeFileSync(
    path.join(msHome, "snapshot.json"),
    JSON.stringify({ takenAt: Date.now(), accounts: [usageRow("home", "codex", 10)], backoff: {} }, null, 0),
    { mode: 0o600 },
  );

  const sessions = path.join(home, ".codex", "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });

  return {
    home, msHome, log, sessions,
    env: (o = {}) => ({
      HOME: home, MS_HOME: msHome, MS_TMUX_LOG: log,
      PATH: `${dir}:${process.env.PATH}`,
      CODEX_HOME: "",
      NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import ${stubUrl}`,
      TMUX: TMUX_SOCKET + ",123,0", TMUX_PANE: PANE,
      ...o,
    }),
  };
}

async function readLaunch(w: World, id: string) {
  process.env.HOME = w.home; process.env.MS_HOME = w.msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  try {
    return { launch: st.getLaunch(id), sessions: st.listSessions() };
  } finally {
    st.close();
  }
}

function launchIdFrom(log: string): string {
  const line = readFileSync(log, "utf8").split("\n").find((l) => l.includes("respawn-pane"));
  assert.ok(line, `no respawn in:\n${readFileSync(log, "utf8")}`);
  const m = line!.match(new RegExp(`'_exec' '(${UUID})'$`));
  assert.ok(m, `respawn line not as expected: ${line}`);
  return m![1]!;
}

test("ms adopt copies the lineage and relaunches this pane on `codex <args> resume <id>`", async () => {
  const w = await adoptWorld();
  chain(w.sessions);

  const r = run(["adopt", LEAF, "--", "--yolo"], w.env());

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^ms adopt: 11111111-1111-4111-8111-111111111111 → .*\(3 copied, 0 already there\)$/m);
  assert.match(r.stderr, /^ms: home \(codex\) → pane %7$/m);

  // The whole chain is in the SHARED store, where every ms codex home links.
  const store = path.join(w.msHome, "codex", "sessions");
  assert.ok(existsSync(path.join(store, "2026", "09", "17", rolloutName("2026-09-17", LEAF))));
  assert.ok(existsSync(path.join(store, "2026", "09", "16", rolloutName("2026-09-16", MID))));
  assert.ok(existsSync(path.join(store, "2026", "09", "15", rolloutName("2026-09-15", ROOT))));

  const { launch, sessions } = await readLaunch(w, launchIdFrom(w.log));
  // The human's own `--yolo` reaches the CLI, and the resume is appended.
  assert.deepEqual(launch!.command, ["codex", "--yolo", "resume", LEAF]);
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;
  assert.equal(s.provider, "codex");
  assert.equal(s.account, "home");
  assert.equal(s.state, "launching");
  // The id is on the row from the start: normally Codex mints one and the hook
  // reports it, but an adopted conversation already HAS one, and a row without
  // it is a row no rotation could resume.
  assert.equal(s.cliSessionId, LEAF);
  // `resume <id>` is not a flag and is never re-applied: the row records only
  // what the human's own command line asked for.
  assert.deepEqual(s.flags, ["--yolo"]);
});

test("ms adopt --continue sends the rotation's own continuation, once, as the resumed command line's prompt", async () => {
  const w = await adoptWorld();
  chain(w.sessions);

  const r = run(["adopt", LEAF, "--continue", "--", "--yolo"], w.env());
  assert.equal(r.code, 0, r.stderr);

  const { CONTINUATION } = await import("../src/recover.ts");
  const { launch } = await readLaunch(w, launchIdFrom(w.log));
  assert.deepEqual(launch!.command, ["codex", "--yolo", "resume", LEAF, CONTINUATION]);
  assert.equal(launch!.command.filter((a) => a === CONTINUATION).length, 1, "the continuation is sent once");
});

test("ms adopt refuses an id it cannot find, and writes nothing", async () => {
  const w = await adoptWorld();
  chain(w.sessions);

  const r = run(["adopt", "44444444-4444-4444-8444-444444444444"], w.env());

  assert.equal(r.code, 1);
  assert.match(r.stderr, /no rollout for '44444444-4444-4444-8444-444444444444' under .*\.codex\/sessions/);
  assert.ok(!existsSync(path.join(w.msHome, "state.sqlite")) || (await readLaunch(w, "none")).sessions.length === 0);
  assert.ok(!existsSync(path.join(w.msHome, "codex", "sessions", "2026")), "nothing was copied");
});

test("ms adopt refuses a pane that is still running codex, before it copies anything", async () => {
  const w = await adoptWorld();
  chain(w.sessions);

  const r = run(["adopt", LEAF], w.env({ MS_TEST_PANE_CMD: "codex" }));

  assert.equal(r.code, 1);
  assert.match(r.stderr, /codex is still running in pane %7/);
  assert.match(r.stderr, /exit it first/);
  assert.ok(!existsSync(path.join(w.msHome, "codex", "sessions", "2026")), "a refusal leaves nothing behind");
});

test("ms adopt reads CODEX_HOME when the caller's codex runs out of another home", async () => {
  const w = await adoptWorld();
  const other = path.join(w.home, "elsewhere");
  chain(path.join(other, "sessions"));

  const r = run(["adopt", LEAF], w.env({ CODEX_HOME: other }));

  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(w.msHome, "codex", "sessions", "2026", "09", "17", rolloutName("2026-09-17", LEAF))));
});

// --- ms codex --continue (the same continuation, for a resume you drove) ----

test("ms codex --continue -- resume <id> hands the resumed conversation the rotation's continuation", async () => {
  const w = await adoptWorld();
  const r = run(["codex", "--continue", "--", "resume", LEAF], w.env());
  assert.equal(r.code, 0, r.stderr);

  const { CONTINUATION } = await import("../src/recover.ts");
  const { launch, sessions } = await readLaunch(w, launchIdFrom(w.log));
  assert.deepEqual(launch!.command, ["codex", "resume", LEAF, CONTINUATION]);
  // `resume`/`<id>` are positionals, which a rotation's `flagsForResume` drops
  // — so the row's flags carry neither them nor the continuation.
  assert.deepEqual(sessions[0]!.flags, ["resume", LEAF]);
});

test("ms codex --continue with nothing to continue is a refusal, not a prompt into an empty conversation", async () => {
  const w = await adoptWorld();
  const r = run(["codex", "--continue"], w.env());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--continue needs something to continue/);
  assert.ok(!existsSync(w.log) || !readFileSync(w.log, "utf8").includes("respawn-pane"), "nothing was launched");
});

test("ms claude --continue -- --resume <id> is accepted, and refused without a resume", async () => {
  const w = await adoptWorld();
  // The refusal is reached before any account is chosen, so this world's
  // codex-only registry is enough to prove the parse.
  const r = run(["claude", "--continue"], w.env());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--continue needs something to continue/);
  assert.match(r.stderr, /ms claude --continue -- --resume <id>/);
});

test("ms adopt takes a path, and still finds that rollout's sources under its own sessions root", async () => {
  const w = await adoptWorld();
  // Deliberately NOT under the caller's codex home: a file someone moved
  // aside, whose lineage still lives beside it rather than in ~/.codex.
  const elsewhere = path.join(w.home, "kept", "sessions");
  const c = chain(elsewhere);

  const r = run(["adopt", c.leaf], w.env());

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\(3 copied, 0 already there\)/);
  const store = path.join(w.msHome, "codex", "sessions");
  assert.ok(existsSync(path.join(store, "2026", "09", "15", rolloutName("2026-09-15", ROOT))), "the chain's root came too");
  const { launch } = await readLaunch(w, launchIdFrom(w.log));
  assert.deepEqual(launch!.command, ["codex", "resume", LEAF], "the id comes from the file's own name");
});
