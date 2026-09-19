// test/import-verb.test.ts — the verb (`src/import.ts`).
//
// Two halves, on purpose.
//
// The command line and the confirmation are driven IN PROCESS, through
// `runImport`'s injectable io, because the one thing that must be provable
// about a verb that stops other people's processes is what it does when there
// is nobody to ask: a stdin that is not a terminal is a refusal, never an
// assumed yes, and no subprocess test can tell those two apart (a piped stdin
// is exactly the case under test).
//
// The end-to-end runs go through `bin/ms` against a temp HOME/MS_HOME, with
// `ps`, `lsof`, `git` and `tmux` all stubbed on PATH — so a scan sees the
// fixture transcripts this file wrote and nothing of the developer's own
// machine: never their `~/.claude`, never their process table, never their
// tmux server.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, stubDir, tempHome } from "./helpers.ts";
import type { ImportIo } from "../src/import.ts";

const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);

/** tmux, for a verb that mostly must NOT call it: every call logged, panes
 *  answered with fresh ids, no server anybody has a session on. */
const TMUX_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
case "$1" in
  new-session|new-window|split-window)
    n=$(cat "$MS_TMUX_PANES" 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" > "$MS_TMUX_PANES"
    printf '%%%s\n' "$n" ;;
  has-session) exit 1 ;;
  list-sessions) : ;;
  # "could not ask", never "there is nothing there": reconciliation must not
  # repair rows in a store whose tmux this test is only pretending to have.
  list-panes) exit 1 ;;
  display-message) printf '0\n' ;;
esac
exit 0`;

type World = {
  home: string;
  msHome: string;
  env: Record<string, string>;
  project: string;
  tmuxLog: () => string[];
  manifests: () => string[];
};

/** A machine: a temp HOME, a temp MS_HOME, a project directory, one Claude
 *  transcript in it, and stubs for everything the scan shells out to. */
function machine(t: TestContext, opts: { mtime?: number } = {}): World {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", TMUX_STUB);
  stub("ps", 'echo "  PID STARTED TT  COMMAND"');
  stub("lsof", "exit 1");
  stub("git", "exit 1"); // not a repo: every directory is its own root
  const tmuxLog = path.join(dir, "tmux.log");
  writeFileSync(tmuxLog, "");

  const project = path.join(home, "src", "data");
  mkdirSync(project, { recursive: true });
  const claudeConfig = path.join(home, ".claude");
  const escaped = project.replace(/[/.]/g, "-");
  const transcripts = path.join(claudeConfig, "projects", escaped);
  mkdirSync(transcripts, { recursive: true });
  const file = path.join(transcripts, "conv-1.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "last-prompt", leafUuid: "f4bb", sessionId: "conv-1" }),
    JSON.stringify({ parentUuid: null, sessionId: "conv-1", type: "user", cwd: project, message: { role: "user", content: "fix the tests" } }),
  ].join("\n") + "\n");
  const mtime = (opts.mtime ?? Date.now()) / 1000;
  utimesSync(file, mtime, mtime);

  const env: Record<string, string> = {
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    HOME: home,
    MS_HOME: msHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: path.join(home, ".codex"),
    MS_TMUX_LOG: tmuxLog,
    MS_TMUX_PANES: path.join(dir, "panes"),
    MS_BIN: path.resolve("bin/ms"),
    // No TMUX: the import lands on the tool's own server, which is where a
    // launch from outside tmux already goes.
    TMUX: "",
  };
  t.after(() => {
    /* temp dirs are the OS's to clean */
  });
  return {
    home, msHome, env, project,
    tmuxLog: () => readFileSync(tmuxLog, "utf8").split("\n").filter((l) => l !== ""),
    manifests: () => {
      try {
        return readdirSync(path.join(msHome, "imports"));
      } catch {
        return [];
      }
    },
  };
}

// --- The command line ------------------------------------------------------

test("--since takes 30m, 2h, 1d and all, and refuses a number with no unit", async () => {
  const { parseSince } = await import("../src/import.ts");
  const now = T0;
  assert.deepEqual(parseSince("30m", now), { ms: now - 1_800_000 });
  assert.deepEqual(parseSince("2h", now), { ms: now - 7_200_000 });
  assert.deepEqual(parseSince("1d", now), { ms: now - 86_400_000 });
  assert.deepEqual(parseSince("all", now), { ms: null }, "all means no floor at all, not a very old one");
  for (const bad of ["2", "2w", "", "h", "-1h", "2 h"]) {
    const r = parseSince(bad, now);
    assert.ok("error" in r, `${JSON.stringify(bad)} should not parse`);
  }
});

test("the flags parse, and a flag that swallowed the next one is a mistake", async () => {
  const { parseImportArgs } = await import("../src/import.ts");
  const ok = parseImportArgs(["--since", "1d", "--dir", "/a", "--dir=/b", "--as", "work", "--continue", "--include-tmux", "--dry-run", "--yes"]);
  assert.ok(!("error" in ok));
  assert.deepEqual(
    { since: ok.since, dirs: ok.dirs, as: ok.as, continueFor: ok.continueFor, includeTmux: ok.includeTmux, dryRun: ok.dryRun, yes: ok.yes },
    { since: "1d", dirs: ["/a", "/b"], as: "work", continueFor: "all", includeTmux: true, dryRun: true, yes: true },
  );
  assert.equal(parseImportArgs([]).valueOf() && (parseImportArgs([]) as { since: string }).since, "2h", "the default window");
  for (const bad of [["--dir"], ["--dir", "--yes"], ["--as="], ["--nope"], ["conv-1"]]) {
    assert.ok("error" in parseImportArgs(bad), `${bad.join(" ")} should not parse`);
  }
  assert.ok("error" in parseImportArgs(["--plan", "a.json", "--status", "b.json"]));
  assert.ok("error" in parseImportArgs(["--plan", "a.json", "--since", "1d"]), "a manifest was already scanned; the scan's flags do not apply");
});

// --- The confirmation ------------------------------------------------------

async function io(over: Partial<ImportIo> = {}): Promise<ImportIo & { stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { out: (s) => stdout.push(s), err: (s) => stderr.push(s), confirm: null, stdout, stderr, ...over };
}

test("without a terminal and without --yes, the verb refuses rather than assuming yes", async (t) => {
  const w = machine(t);
  const restore = withEnv(t, w.env);
  const { runImport } = await import("../src/import.ts");
  const channel = await io({ confirm: null });
  const code = await runImport(["--dir", w.project], channel);
  assert.equal(code, 2, "a refusal, with the usage exit code the spec gives it");
  const said = channel.stderr.join("");
  assert.match(said, /stdin is not a terminal/);
  assert.match(said, /--yes/);
  assert.match(said, /--plan /, "and it names the plan it already wrote, so the human can run it");
  assert.deepEqual(w.tmuxLog().filter((l) => /new-session|send-keys|split-window/.test(l)), [], "nothing was moved");
  restore();
});

test("a confirmation that is not yes moves nothing and is not an error", async (t) => {
  const w = machine(t);
  const restore = withEnv(t, w.env);
  const { runImport } = await import("../src/import.ts");
  const asked: string[] = [];
  const channel = await io({ confirm: async (q) => { asked.push(q); return false; } });
  const code = await runImport(["--dir", w.project], channel);
  assert.equal(code, 0);
  assert.equal(asked.length, 1, "asked once, and only once");
  assert.match(asked[0]!, /^Move 1 conversation\? \[y\/N\] $/);
  assert.match(channel.stderr.join(""), /nothing was moved/);
  assert.deepEqual(w.tmuxLog().filter((l) => /new-session|send-keys/.test(l)), []);
  restore();
});

test("the question says how many live processes it is about to stop", async (t) => {
  const w = machine(t);
  const restore = withEnv(t, w.env);
  // A process table with a claude in the project directory, and an lsof that
  // says where it is: the scan now has one LIVE conversation.
  const stubs = stubDir();
  stubs.stub("tmux", TMUX_STUB);
  stubs.stub("ps", `printf '%s\\n' "  PID STARTED TT  COMMAND" "  4242 Fri Sep 19 11:00:00 2026 s001 claude"`);
  stubs.stub("lsof", `printf 'p4242\\nn${w.project}\\n'`);
  stubs.stub("git", "exit 1");
  const restore2 = withEnv(t, { ...w.env, PATH: `${stubs.dir}:${process.env.PATH ?? ""}` });
  const { runImport } = await import("../src/import.ts");
  const asked: string[] = [];
  const code = await runImport(["--dir", w.project], await io({ confirm: async (q) => { asked.push(q); return false; } }));
  assert.equal(code, 0);
  assert.match(asked[0]!, /Move 1 conversation, stopping 1 live process\?/);
  restore2();
  restore();
});

function withEnv(t: TestContext, env: Record<string, string>): () => void {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  const restore = (): void => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  };
  t.after(restore);
  return restore;
}

// --- End to end ------------------------------------------------------------

test("--dry-run writes the manifest, prints the table, and touches nothing", async (t) => {
  const w = machine(t);
  const r = run(["import", "--dry-run", "--dir", w.project], w.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 conversation to move/);
  assert.match(r.stdout, /fix the tests/);
  assert.match(r.stdout, /data:data\.0/, "no git here, so the window takes the directory's own name");
  assert.match(r.stdout, /planned/);
  assert.match(r.stderr, /ms import: manifest /);

  const files = w.manifests();
  assert.equal(files.length, 1, "exactly one manifest");
  const m = JSON.parse(readFileSync(path.join(w.msHome, "imports", files[0]!), "utf8"));
  assert.equal(m.rows.length, 1);
  assert.equal(m.rows[0].id, "conv-1");
  assert.equal(m.rows[0].outcome, "planned");
  assert.equal(m.since, "2h");
  assert.deepEqual(m.rows[0].command, ["ms", "claude", "--", "--resume", "conv-1"]);
  assert.deepEqual(
    w.tmuxLog().filter((l) => /new-session|new-window|split-window|send-keys/.test(l)),
    [],
    "a dry run asks tmux what sessions exist and nothing else",
  );
});

test("--since drops a conversation older than the window, and --since all keeps it", async (t) => {
  const w = machine(t, { mtime: Date.now() - 5 * 3_600_000 });
  const tight = run(["import", "--dry-run", "--dir", w.project], w.env);
  assert.equal(tight.code, 0, tight.stderr);
  assert.match(tight.stdout, /0 conversations to move/);
  assert.match(tight.stderr, /nothing to import/);

  const wide = run(["import", "--dry-run", "--since", "all", "--dir", w.project], w.env);
  assert.match(wide.stdout, /1 conversation to move/);
  const bad = run(["import", "--since", "2", "--dir", w.project], w.env);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--since takes 30m, 2h, 1d or all/);
});

test("--status prints a manifest's own table and changes nothing", async (t) => {
  const w = machine(t);
  assert.equal(run(["import", "--dry-run", "--dir", w.project], w.env).code, 0);
  const file = path.join(w.msHome, "imports", w.manifests()[0]!);
  const before = readFileSync(file, "utf8");

  const r = run(["import", "--status", file], w.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 conversation to move/);
  assert.match(r.stdout, /conv-1|fix the tests/);
  assert.equal(readFileSync(file, "utf8"), before, "--status is a read");
  assert.equal(run(["import", "--status", path.join(w.msHome, "nope.json")], w.env).code, 1);
});

test("--plan runs a manifest written earlier, with no scan and no question", async (t) => {
  const w = machine(t);
  assert.equal(run(["import", "--dry-run", "--dir", w.project], w.env).code, 0);
  const file = path.join(w.msHome, "imports", w.manifests()[0]!);

  // The conversation reports itself the way a real one does: a session row in
  // the store, under this conversation's id, that has reached `running`.
  const prev = { ...process.env };
  Object.assign(process.env, w.env);
  const { openState } = await import("../src/state.ts");
  const st = openState();
  st.createSession({
    id: "row-1", provider: "claude", cliSessionId: "conv-1", cwd: w.project, socket: "s", pane: "%1",
    serverStart: "1:1", need: "any", account: "work", generation: 1, state: "running", desired: "running", flags: [],
  });
  st.close();
  for (const k of Object.keys(w.env)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k]!;
  }

  const r = run(["import", "--plan", file], w.env);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /moved 1, stopped 0, failed 0/);
  const sent = w.tmuxLog().filter((l) => l.includes("send-keys"));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /send-keys -t %1 /);
  assert.ok(sent[0]!.includes("'claude' '--' '--resume' 'conv-1'"), sent[0]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).rows[0].outcome, "resumed in data:data.0");
});

test("a run whose rows all fail exits 1 and says so in the manifest", async (t) => {
  const w = machine(t);
  assert.equal(run(["import", "--dry-run", "--dir", w.project], w.env).code, 0);
  const file = path.join(w.msHome, "imports", w.manifests()[0]!);
  // Nothing ever reports itself: no session row is written at all.
  const r = run(["import", "--plan", file], { ...w.env, MS_IMPORT_READY_MS: "300" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /moved 0, stopped 0, failed 1/);
  assert.match(JSON.parse(readFileSync(file, "utf8")).rows[0].outcome, /^resume failed: no report within/);
});

test("--yes moves without asking, and `ms import` is a verb the CLI knows", async (t) => {
  const w = machine(t);
  const r = run(["import", "--yes", "--dir", w.project], { ...w.env, MS_IMPORT_READY_MS: "300" });
  assert.equal(r.code, 1, "the resume never reported in this stub world");
  assert.ok(!r.stderr.includes("stdin is not a terminal"), "--yes is the answer, so nothing is asked");
  assert.match(r.stderr, /moved 0, stopped 0, failed 1/);
  assert.equal(w.tmuxLog().filter((l) => l.includes("send-keys")).length, 1);

  const help = run(["--help"], w.env);
  assert.match(help.stderr, /import/);
});

test("a conversation already in tmux is not imported, and --include-tmux only lists it", async (t) => {
  const w = machine(t);
  const stubs = stubDir();
  // The pane tty of the tmux server this scan asks, and a claude sitting on it.
  stubs.stub("tmux", `printf '%s\\n' "$*" >> "$MS_TMUX_LOG"\nif [ "$1" = "-S" ]; then shift 2; fi\ncase "$1" in *list-panes*) printf '/dev/ttys001\\n' ;; esac\nexit 0`);
  stubs.stub("ps", `printf '%s\\n' "  PID STARTED TT  COMMAND" "  4242 Fri Sep 19 11:00:00 2026 s001 claude"`);
  stubs.stub("lsof", `printf 'p4242\\nn${w.project}\\n'`);
  stubs.stub("git", "exit 1");
  const env = { ...w.env, PATH: `${stubs.dir}:${process.env.PATH ?? ""}` };

  const plain = run(["import", "--dry-run", "--dir", w.project], env);
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /in tmux/, "a pane that is already rotatable is not an import, and not a row");

  const listed = run(["import", "--dry-run", "--include-tmux", "--dir", w.project], env);
  assert.match(listed.stdout, /skipped: in tmux/);
  assert.match(listed.stdout, /0 conversations to move/, "listing it is not moving it");
});
