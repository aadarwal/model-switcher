import { test } from "node:test";
import { strict as assert } from "node:assert";
import { type LaunchExtras } from "../src/launch.ts";
import { planRestore, type RestorePlan } from "../src/restore.ts";
import { formatPlan, parseRestoreArgs, runRestore, type RestoreIo } from "../src/restore-verb.ts";
import { type Provider, type SessionRow } from "../src/state.ts";
import { ghosttyCommand, ghosttyScript, openTabs, tabCommand, detectTerminal, type TabTarget } from "../src/tabs.ts";

const DEAD = "64025:1790613772";
const SOCK = "/private/tmp/tmux-501/default";
const LOST_AT = 1_794_849_896; // 2026-11-16 17:24:56Z
const NOW = (LOST_AT + 600) * 1000;
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let seq = 0;
function lost(over: Partial<SessionRow> = {}): SessionRow {
  seq++;
  return {
    id: `s${seq}`, provider: "claude", cliSessionId: ID(seq), cwd: `/work/r${seq}`, socket: SOCK, pane: `%${seq}`,
    serverStart: DEAD, need: "any", account: "gmail", generation: 1, state: "stopped", desired: "running",
    flags: ["--model", "opus"], wakeupAt: null, createdAt: 1_000_000 + seq, updatedAt: LOST_AT, transcriptPath: null, rolloutOffset: 0,
    lastMoveAt: null, pinnedAccount: null, tmuxSession: "ms", windowIndex: seq, windowName: null, lostAt: LOST_AT,
    ...over,
  };
}

type Launch = { provider: Provider; argv: string[]; extras: LaunchExtras };
type World = { io: RestoreIo; out: string[]; err: string[]; launches: Launch[]; tabs: TabTarget[][]; asked: string[]; rows: SessionRow[] };

/** The verb with everything outside it replaced: the store is `rows`, a launch
 *  is recorded (and, like the real one, leaves a running row behind on the new
 *  server), and the terminal is whatever `tabs` collects. */
function world(rows: SessionRow[], over: { confirm?: boolean | null; fail?: string[]; throws?: string[]; activity?: (r: SessionRow) => number | null } = {}): World {
  const w: World = { out: [], err: [], launches: [], tabs: [], asked: [], rows: [...rows], io: null as unknown as RestoreIo };
  w.io = {
    out: (s) => { w.out.push(s); },
    err: (s) => { w.err.push(s); },
    confirm: over.confirm === null ? null : async (q) => { w.asked.push(q); return over.confirm ?? true; },
    now: () => NOW,
    rows: () => w.rows,
    plan: (r, o): RestorePlan => planRestore(r, { ...o, activity: over.activity ?? (() => NOW - 3_600_000), dirExists: () => true }),
    launch: async (provider, argv, extras) => {
      w.launches.push({ provider, argv, extras });
      const id = provider === "codex" ? extras.resumeId! : argv[argv.length - 1]!;
      if (over.fail?.includes(id)) return 3;
      if (over.throws?.includes(id)) throw new Error("tmux new-window failed: server exited unexpectedly");
      // Where it LANDED: at its old index, unless a test's world moves it.
      w.rows.push(lost({ id: `new-${w.launches.length}`, provider, cliSessionId: id, state: "running", lostAt: null, serverStart: "9:9",
        createdAt: LOST_AT + 5, tmuxSession: extras.place!.session, windowIndex: (extras.place!.windowIndex ?? 0) + (id === ID(772) ? 100 : 0) }));
      return 0;
    },
    tabs: (targets) => { w.tabs.push(targets); return targets.length; },
  };
  return w;
}

test("parseRestoreArgs: the defaults, every flag, and the refusals", () => {
  assert.deepEqual(parseRestoreArgs([]), { since: "7d", server: null, continueAfter: false, tabs: false, dryRun: false, yes: false });
  assert.deepEqual(parseRestoreArgs(["--since", "2h", "--server=1:2", "--continue", "--tabs", "--dry-run", "-y"]),
    { since: "2h", server: "1:2", continueAfter: true, tabs: true, dryRun: true, yes: true });
  assert.deepEqual(parseRestoreArgs(["--since", "--yes"]), { error: "--since needs a value" }, "a forgotten window is not one called --yes");
  assert.deepEqual(parseRestoreArgs(["--server"]), { error: "--server needs a value" });
  assert.deepEqual(parseRestoreArgs(["everything"]), { error: 'unexpected argument "everything"' });
});

test("ms restore --yes: each conversation is launched once, on its recorded id, into the window it sat in — and nothing attaches or continues", async () => {
  const claude = lost({ cliSessionId: ID(701), cwd: "/work/web", need: "fable", flags: ["--model", "opus", "--resume"], tmuxSession: "ms", windowIndex: 41, windowName: "reviewer" });
  const older = lost({ cliSessionId: ID(701), cwd: "/work/web", createdAt: 5 }); // the same conversation before a rotation
  const codex = lost({ provider: "codex", cliSessionId: ID(702), cwd: "/work/astra", flags: ["resume", ID(702), "--no-daemon"], tmuxSession: "ms", windowIndex: 73, windowName: null });
  const w = world([older, claude, codex]);

  assert.equal(await runRestore(["--yes"], w.io), 0);

  assert.deepEqual(w.asked, [], "--yes is the answer");
  assert.deepEqual(w.launches, [
    { provider: "claude", argv: ["--need", "fable", "--", "--model", "opus", "--resume", ID(701)],
      extras: { resumeId: null, place: { session: "ms", cwd: "/work/web", windowName: "reviewer", windowIndex: 41 } } },
    { provider: "codex", argv: ["--", "--no-daemon"],
      extras: { resumeId: ID(702), place: { session: "ms", cwd: "/work/astra", windowName: null, windowIndex: 73 } } },
  ]);
  assert.deepEqual(w.tabs, [], "no --tabs, no tabs");
  assert.match(w.err.join(""), /^ms restore: 2 of 2 conversations relaunched; see how each came up with: ms status\n$/);

  // Run again: both are running, so there is nothing left to bring back.
  const again = world(w.rows);
  assert.equal(await runRestore(["--yes"], again.io), 0);
  assert.deepEqual(again.launches, [], "a second restore is not a second copy of everything");
  assert.match(again.out.join(""), /not restored: 00000000-0000-4000-8000-000000000701 \(\/work\/web\): already running in pane/);
});

test("ms restore: the plan is shown before anything is asked, and the table says what, when and where", async () => {
  const a = lost({ cliSessionId: ID(710), cwd: "/work/a", windowIndex: 3, windowName: "ops" });
  const idle = lost({ cliSessionId: ID(711), cwd: "/work/old" });
  const nameless = lost({ id: "s-nameless", cliSessionId: null, cwd: "/work/x" });
  const elsewhere = lost({ serverStart: "111:1", lostAt: 1_794_000_000 });
  const w = world([a, idle, nameless, elsewhere], { confirm: false, activity: (r) => (r.id === idle.id ? Date.UTC(2026, 9, 1, 9, 30) : NOW - 3_600_000) });

  assert.equal(await runRestore([], w.io), 0);

  assert.equal(w.out.join(""), [
    `tmux server ${DEAD} on ${SOCK} went away 2026-11-16 17:24Z, with 3 managed sessions on it`,
    "PROVIDER  CONVERSATION                          LAST TURN          WINDOW      DIRECTORY",
    `claude    ${ID(710)}  2026-11-16 16:34Z  ms:3 (ops)  /work/a`,
    "not restored: session s-nameless (/work/x): no conversation id was ever recorded for it",
    `not restored: ${ID(711)} (/work/old): idle since 2026-10-01 09:30Z`,
    "other lost servers on record: 111:1 (2026-11-06 21:20Z, 1 session) — restore one with --server <identity>",
    "",
  ].join("\n"));
  assert.deepEqual(w.asked, ["Bring back 1 conversation? [y/N] "]);
  assert.deepEqual(w.launches, [], "no means no");
  assert.equal(w.err.join(""), "ms restore: nothing was launched\n");
});

test("ms restore --dry-run launches nothing and asks nothing; with nobody to ask and no --yes it refuses", async () => {
  const dry = world([lost()]);
  assert.equal(await runRestore(["--dry-run"], dry.io), 0);
  assert.deepEqual([dry.launches, dry.asked], [[], []]);
  assert.match(dry.out.join(""), /^tmux server /);

  const pipe = world([lost()], { confirm: null });
  assert.equal(await runRestore([], pipe.io), 2);
  assert.deepEqual(pipe.launches, []);
  assert.match(pipe.err.join(""), /^ms restore: stdin is not a terminal, so there is nobody to ask\n {2}re-run with --yes/);
});

test("ms restore --continue says so in the question and hands every launch the continuation flag", async () => {
  const w = world([lost({ cliSessionId: ID(720) })]);
  assert.equal(await runRestore(["--continue"], w.io), 0);
  assert.deepEqual(w.asked, ["Bring back 1 conversation and tell each to continue? [y/N] "]);
  assert.deepEqual(w.launches[0]!.argv, ["--continue", "--need", "any", "--", "--model", "opus", "--resume", ID(720)]);
});

test("ms restore: a launch that refuses does not stop the rest, and the exit says one did", async () => {
  const w = world([lost({ cliSessionId: ID(730), cwd: "/work/full" }), lost({ cliSessionId: ID(731) })], { fail: [ID(730)] });
  assert.equal(await runRestore(["--yes"], w.io), 1);
  assert.equal(w.launches.length, 2);
  assert.equal(w.err.join(""), `ms restore: 1 of 2 conversations relaunched\nms restore: ${ID(730)} (/work/full) was not launched (exit 3); its reason is above\n`);
});

test("ms restore: a launch that THROWS is one failed conversation — the ones after it still come back, and its error is said", async () => {
  const first = lost({ cliSessionId: ID(740), cwd: "/work/boom", windowIndex: 1 });
  const second = lost({ cliSessionId: ID(741), windowIndex: 2 });
  const w = world([first, second], { throws: [ID(740)] });
  assert.equal(await runRestore(["--yes"], w.io), 1);
  assert.deepEqual(w.launches.map((l) => l.argv.at(-1)), [ID(740), ID(741)], "the second is still launched");
  assert.equal(w.err.join(""), [
    `ms restore: ${ID(740)}: tmux new-window failed: server exited unexpectedly`,
    "ms restore: 1 of 2 conversations relaunched",
    `ms restore: ${ID(740)} (/work/boom) was not launched (exit 1); its reason is above`,
    "",
  ].join("\n"));
});

test("ms restore: nothing on record, an unknown --server, a bad --since", async () => {
  const none = world([lost({ lostAt: null })]);
  assert.equal(await runRestore([], none.io), 0);
  assert.equal(none.err.join(""), "ms restore: nothing to restore: no session has been lost with its tmux server\n");
  assert.deepEqual(none.out, []);

  const unknown = world([lost()]);
  assert.equal(await runRestore(["--server", "7:7"], unknown.io), 1);
  assert.equal(unknown.err.join(""), `ms restore: no session was lost with a tmux server 7:7\n  the ones on record: ${DEAD}\n`);

  const bad = world([lost()]);
  assert.equal(await runRestore(["--since", "soon"], bad.io), 2);
  assert.match(bad.err.join(""), /^ms restore: --since takes 30m, 2h, 1d or all, not "soon"\nusage: ms restore /);
});

test("ms restore --tabs opens a tab per restored window, at the index each one LANDED on, and none for a launch that failed", async () => {
  const a = lost({ cliSessionId: ID(771), windowIndex: 4 });
  const moved = lost({ cliSessionId: ID(772), windowIndex: 7 });   // its old index was taken: the world lands it at 107
  const failed = lost({ cliSessionId: ID(773), windowIndex: 9 });
  const w = world([a, moved, failed], { fail: [ID(773)] });
  assert.equal(await runRestore(["--yes", "--tabs"], w.io), 1);
  assert.deepEqual(w.tabs, [[{ session: "ms", windowIndex: 4 }, { session: "ms", windowIndex: 107 }]]);
});

test("formatPlan: a window with no recorded index is shown as the next free one", () => {
  const plan = planRestore([lost({ cliSessionId: ID(780), tmuxSession: null, windowIndex: null })], { sinceMs: null, activity: () => null, dirExists: () => true });
  assert.match(formatPlan(plan), new RegExp(`claude {4}${ID(780)}  unknown {4}ms:\\+ {4}/work/`));
});

// --- tabs --------------------------------------------------------------------

test("tabCommand: one pasteable line per window; an override socket travels as the variable ms attach reads", () => {
  assert.equal(tabCommand("/opt/ms/bin/ms", { session: "ms", windowIndex: 41 }, null), "/opt/ms/bin/ms attach --window 41 ms");
  assert.equal(tabCommand("/opt/my tools/ms", { session: "night shift", windowIndex: 2 }, "/tmp/my sock"),
    "MS_TMUX_SOCKET='/tmp/my sock' '/opt/my tools/ms' attach --window 2 'night shift'");
});

test("ghosttyScript: a NEW window for the first command, a tab in it for each of the rest, strings escaped for AppleScript", () => {
  assert.equal(ghosttyScript(["ms attach --window 0 ms", `ms attach --window 1 'a "b" \\ c'`]), [
    'tell application "Ghostty"',
    "  activate",
    "  set cfg to new surface configuration",
    '  set command of cfg to "ms attach --window 0 ms"',
    "  set w to new window with configuration cfg",
    `  set command of cfg to "ms attach --window 1 'a \\"b\\" \\\\ c'"`,
    "  new tab in w with configuration cfg",
    "end tell",
  ].join("\n"));
});

test("detectTerminal: Ghostty on macOS by its own variable; inside tmux by what the attached CLIENT is, never by where the server was started; never over ssh", () => {
  assert.equal(detectTerminal({ TERM_PROGRAM: "ghostty" }, "darwin", null), "ghostty");
  assert.equal(detectTerminal({ TERM_PROGRAM: "ghostty" }, "linux", null), null);
  assert.equal(detectTerminal({ TERM_PROGRAM: "iTerm.app" }, "darwin", null), null);
  assert.equal(detectTerminal({}, "darwin", null), null);
  // Inside tmux: the server was started from Ghostty and still says so in its
  // environment, but the client attached now is another terminal.
  const fromGhostty = { TMUX: "/tmp/s,1,0", TERM_PROGRAM: "tmux", GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty" };
  assert.equal(detectTerminal(fromGhostty, "darwin", "xterm-256color"), null);
  assert.equal(detectTerminal(fromGhostty, "darwin", null), null, "tmux did not say");
  assert.equal(detectTerminal(fromGhostty, "darwin", "xterm-ghostty"), "ghostty");
  assert.equal(detectTerminal({ TMUX: "/tmp/s,1,0", TERM_PROGRAM: "ghostty" }, "darwin", "xterm-256color"), null, "an inherited TERM_PROGRAM is the server's too");
  // The terminal is on another machine: a tab opened here opens on a screen nobody is at.
  assert.equal(detectTerminal({ TERM_PROGRAM: "ghostty", SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" }, "darwin", null), null);
  assert.equal(detectTerminal({ ...fromGhostty, SSH_TTY: "/dev/ttys004" }, "darwin", "xterm-ghostty"), null);
});

test("ghosttyCommand: the tab's line is run by the login shell, so tmux and node are on PATH and a socket prefix is a shell's to read", () => {
  assert.equal(ghosttyCommand("ms attach --window 3 ms", "/bin/zsh"), "/bin/zsh -lc 'ms attach --window 3 ms'");
  assert.equal(ghosttyCommand("MS_TMUX_SOCKET=/tmp/s ms attach --window 3 ms", "/opt/my shells/fish"), "'/opt/my shells/fish' -lc 'MS_TMUX_SOCKET=/tmp/s ms attach --window 3 ms'");
});

test("ms restore --tabs says so when it cannot tell where a restored window landed, and names the command that opens them all", async () => {
  const w = world([lost({ cliSessionId: ID(775), windowIndex: 4 })]);
  const real = w.io.launch;
  // A launch whose layout note failed: the row it leaves has no window on it.
  w.io.launch = async (p, a, e) => { const code = await real(p, a, e); w.rows.at(-1)!.windowIndex = null; return code; };
  assert.equal(await runRestore(["--yes", "--tabs"], w.io), 0);
  assert.deepEqual(w.tabs, [[]]);
  assert.match(w.err.join(""), /^ms restore: could not tell which window 1 of them landed in; open every window with: ms attach --tabs ms$/m);
});

test("openTabs: Ghostty is scripted once; a terminal it cannot drive, or a Ghostty that refuses, gets the commands printed and that is not a failure", () => {
  const targets = [{ session: "ms", windowIndex: 0 }, { session: "ms", windowIndex: 5 }];
  const run = (terminal: "ghostty" | null, ok = true) => {
    const seen = { out: [] as string[], err: [] as string[], scripts: [] as string[] };
    const n = openTabs(targets, { msBin: "ms", socket: null, terminal, shell: "/bin/zsh" }, {
      out: (s) => { seen.out.push(s); }, err: (s) => { seen.err.push(s); },
      osascript: (script) => { seen.scripts.push(script); return { ok, why: "execution error: Not authorised to send Apple events to Ghostty. (-1743)" }; },
    });
    return { n, ...seen };
  };

  const scripted = run("ghostty");
  assert.equal(scripted.n, 2);
  assert.equal(scripted.scripts.length, 1, "one script for the whole set");
  assert.match(scripted.scripts[0]!, /set command of cfg to "\/bin\/zsh -lc 'ms attach --window 5 ms'"\n {2}new tab in w with configuration cfg/);
  assert.deepEqual(scripted.out, []);
  assert.equal(scripted.err.join(""), "ms: opened 2 Ghostty tabs, one per window\n");

  const other = run(null);
  assert.equal(other.n, 0);
  assert.deepEqual(other.scripts, [], "a terminal that was not named is not scripted");
  assert.deepEqual(other.out, ["ms attach --window 0 ms\n", "ms attach --window 5 ms\n"]);
  assert.match(other.err.join(""), /^ms: this terminal cannot be told to open tabs \(Ghostty 1\.3\+ on macOS can\)\nms: run one of these in each tab you open:\n$/);

  const refused = run("ghostty", false);
  assert.equal(refused.n, 0);
  assert.deepEqual(refused.out, ["ms attach --window 0 ms\n", "ms attach --window 5 ms\n"]);
  assert.match(refused.err.join(""), /^ms: Ghostty would not open the tabs \(execution error: Not authorised to send Apple events to Ghostty\. \(-1743\)\); it needs Ghostty 1\.3 or later and permission to be scripted\n/);

  assert.equal(openTabs([], { msBin: "ms", socket: null, terminal: "ghostty", shell: "/bin/zsh" }, { out: () => {}, err: () => {}, osascript: () => { throw new Error("never"); } }), 0);
});
