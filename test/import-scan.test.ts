// test/import-scan.test.ts — the scanner (`src/import/scan.ts`).
//
// Everything here reads a FIXTURE tree under a temp dir: never `~/.claude`,
// never `~/.codex`, never the real store, never a real process table. The
// process table, `lsof`, tmux's pane ttys and the tool's own live sessions are
// all injected, so the rules the scanner is responsible for — which process
// claims which conversation, what "in tmux" means, what `--since` may and may
// not drop — are proved rather than observed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import type { ProcessRow, ScanOptions } from "../src/import/scan.ts";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 19, 12, 0, 0); // a fixed "now" for every fixture
const BELL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

/** A Claude transcript, in Claude Code's own JSONL shape: two metadata records
 *  that carry NO cwd (confirmed against a real file), then the first user
 *  record, which carries both the cwd and the text the title comes from. */
function claudeFile(
  configDir: string,
  escapedDir: string,
  id: string,
  opts: { cwd?: string | null; text?: string | unknown[] | null; mtime: number },
): string {
  const dir = path.join(configDir, "projects", escapedDir);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    JSON.stringify({ type: "last-prompt", leafUuid: "f4bb3a18", sessionId: id }),
    JSON.stringify({ type: "mode", mode: "normal", sessionId: id }),
  ];
  if (opts.text !== null) {
    lines.push(JSON.stringify({
      parentUuid: null, sessionId: id, type: "user",
      ...(opts.cwd === null ? {} : { cwd: opts.cwd }),
      message: { role: "user", content: opts.text ?? "hello" },
    }));
  } else if (opts.cwd !== null && opts.cwd !== undefined) {
    lines.push(JSON.stringify({ type: "assistant", sessionId: id, cwd: opts.cwd, message: { role: "assistant", content: "hi" } }));
  }
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  utimesSync(file, opts.mtime / 1000, opts.mtime / 1000);
  return file;
}

/** A Codex rollout, in Codex's own JSONL shape (the same one `test/adopt.test.ts`
 *  writes): a `session_meta` line whose payload carries `history_base` when the
 *  conversation is a compacted continuation of another. */
function codexFile(
  codexHome: string,
  date: string,
  id: string,
  opts: {
    cwd: string; text?: string | null; base?: string | null; mtime: number;
    /** One entry per user record, in order; an array entry is one record made
     *  of several content parts. Codex writes its injected context as a user
     *  message of its own before the human's first word, so a rollout with a
     *  preamble is two records, not one. */
    users?: (string | string[])[];
  },
): string {
  const [y, m, d] = date.split("-");
  const dir = path.join(codexHome, "sessions", y!, m!, d!);
  mkdirSync(dir, { recursive: true });
  const meta = {
    timestamp: `${date}T09:15:00.000Z`, type: "session_meta",
    payload: {
      session_id: id, id, timestamp: `${date}T09:15:00.000Z`, cwd: opts.cwd,
      originator: "codex_cli_rs", cli_version: "0.153.4", history_mode: "paginated",
      ...(opts.base ? { history_base: { thread_id: opts.base, end_ordinal_exclusive: 12, end_byte_offset: 4096 } } : {}),
    },
  };
  const lines = [JSON.stringify(meta)];
  const users = opts.users ?? (opts.text === null ? [] : [opts.text ?? "codex please"]);
  users.forEach((user, i) => {
    const parts = Array.isArray(user) ? user : [user];
    lines.push(JSON.stringify({
      timestamp: `${date}T09:16:00.000Z`, ordinal: i + 1, type: "response_item",
      payload: { type: "message", role: "user", content: parts.map((text) => ({ type: "input_text", text })) },
    }));
  });
  const file = path.join(dir, `rollout-${date}T09-15-00-${id}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  utimesSync(file, opts.mtime / 1000, opts.mtime / 1000);
  return file;
}

function opts(over: Partial<ScanOptions> & Pick<ScanOptions, "claudeConfigDir" | "codexHome">): ScanOptions {
  return {
    sinceMs: null, dirs: [],
    ps: () => [], cwdOf: () => null, tmuxTtys: () => new Set(), managedIds: () => new Set(),
    ...over,
  };
}

const proc = (over: Partial<ProcessRow> & Pick<ProcessRow, "pid">): ProcessRow =>
  ({ startedAt: T0 - H, tty: "ttys004", argv: ["claude"], ...over });

// --- Pure helpers ----------------------------------------------------------

test("an escaped project directory name unescapes to a path", async () => {
  const { unescapeProjectDir } = await import("../src/import/scan.ts");
  assert.equal(unescapeProjectDir("-Users-x-y"), "/Users/x/y");
  assert.equal(unescapeProjectDir("-private-tmp"), "/private/tmp");
});

test("a tty is compared by its device name, whatever spelling it arrives in", async () => {
  const { normalizeTty } = await import("../src/import/scan.ts");
  assert.equal(normalizeTty("/dev/ttys004"), "ttys004");
  assert.equal(normalizeTty("ttys004"), "ttys004");
  assert.equal(normalizeTty("s004"), "ttys004");
  assert.equal(normalizeTty("??"), "");
  assert.equal(normalizeTty("-"), "");
});

test("a process is a CLI by its own name, or by the script a node wrapper runs", async () => {
  const { providerOfArgv } = await import("../src/import/scan.ts");
  assert.equal(providerOfArgv(["claude", "--yolo"]), "claude");
  assert.equal(providerOfArgv(["/opt/homebrew/bin/codex"]), "codex");
  assert.equal(providerOfArgv(["node", "/Users/x/.local/bin/claude", "-r"]), "claude");
  assert.equal(providerOfArgv(["node", "/Users/x/n/codex.mjs"]), "codex");
  assert.equal(providerOfArgv(["ms", "claude"]), null, "our own verb is not the CLI");
  assert.equal(providerOfArgv(["claude-code-router"]), null, "a different program that starts with the name");
  assert.equal(providerOfArgv([]), null);
});

test("`ps -axo pid,lstart,tty,command` parses into rows, header and all", async () => {
  const { parsePs } = await import("../src/import/scan.ts");
  const rows = parsePs([
    "  PID STARTED                      TTY      COMMAND",
    "    1 Thu Sep 17 21:31:04 2026     ??       /sbin/launchd",
    " 4321 Fri Sep 18 09:05:00 2026     s004     claude --yolo --model sonnet",
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.pid, 4321);
  assert.equal(rows[1]!.tty, "s004");
  assert.deepEqual(rows[1]!.argv, ["claude", "--yolo", "--model", "sonnet"]);
  assert.equal(new Date(rows[1]!.startedAt).getFullYear(), 2026);
  assert.ok(rows[1]!.startedAt > rows[0]!.startedAt);
});

test("`lsof -Fn` yields the one path it was asked for", async () => {
  const { parseLsofCwd } = await import("../src/import/scan.ts");
  assert.equal(parseLsofCwd("p4321\nfcwd\nn/Users/x/src/data\n"), "/Users/x/src/data");
  assert.equal(parseLsofCwd(""), null);
  assert.equal(parseLsofCwd("p4321\nfcwd\n"), null);
});

// --- Transcripts -----------------------------------------------------------

test("every Claude transcript under the config dir becomes one candidate, newest first", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const a = path.join(home, "src", "data");
  const b = path.join(home, "src", "anu");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd: a, text: "older in data", mtime: T0 - 3 * H });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000002", { cwd: a, text: "newest in data", mtime: T0 - H });
  claudeFile(cfg, "-b", "bbbbbbbb-0000-4000-8000-000000000003", { cwd: b, text: "in anu", mtime: T0 - 2 * H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({ claudeConfigDir: cfg, codexHome: path.join(home, ".codex") }));
  assert.deepEqual(got.map((c) => c.title), ["newest in data", "in anu", "older in data"]);
  assert.deepEqual(got.map((c) => c.provider), ["claude", "claude", "claude"]);
  assert.deepEqual(got.map((c) => c.cwd), [a, b, a]);
  assert.equal(got[0]!.id, "aaaaaaaa-0000-4000-8000-000000000002");
  assert.equal(got[0]!.transcriptPath, path.join(cfg, "projects", "-a", `${got[0]!.id}.jsonl`));
  assert.equal(got[0]!.lastActivity, T0 - H);
  assert.deepEqual(
    got.map((c) => [c.pid, c.argv, c.startedAt, c.inTmux, c.managed, c.compacted]),
    got.map(() => [null, null, null, false, false, false]),
  );
});

test("the cwd comes from the record that carries one, not from the first record", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const real = path.join(home, "src", "some.dotted.dir");
  mkdirSync(real, { recursive: true });
  // The escaped name would unescape to `/…/some/dotted/dir` — the escaping
  // eats `.` as well as `/`, so the recorded cwd is the only honest one.
  claudeFile(cfg, "-escaped-nonsense", "cccccccc-0000-4000-8000-000000000001", { cwd: real, text: "hi", mtime: T0 });
  const { scanConversations } = await import("../src/import/scan.ts");
  const [c] = scanConversations(opts({ claudeConfigDir: cfg, codexHome: path.join(home, ".codex") }));
  assert.equal(c!.cwd, real);
});

test("with no cwd in any record, the escaped directory name is unescaped instead", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  claudeFile(cfg, "-Users-x-y", "dddddddd-0000-4000-8000-000000000001", { cwd: null, text: "no cwd anywhere", mtime: T0 });
  const { scanConversations } = await import("../src/import/scan.ts");
  const [c] = scanConversations(opts({ claudeConfigDir: cfg, codexHome: path.join(home, ".codex") }));
  assert.equal(c!.cwd, "/Users/x/y");
  assert.equal(c!.title, "no cwd anywhere");
});

test("a title is the first user line: one line, 80 characters, no control characters", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const cwd = path.join(home, "w");
  mkdirSync(cwd, { recursive: true });
  claudeFile(cfg, "-w", "eeeeeeee-0000-4000-8000-000000000001", { cwd, text: "first line\nsecond line", mtime: T0 });
  claudeFile(cfg, "-w", "eeeeeeee-0000-4000-8000-000000000002", { cwd, text: `x${"y".repeat(200)}`, mtime: T0 - H });
  claudeFile(cfg, "-w", "eeeeeeee-0000-4000-8000-000000000003", { cwd, text: `bell${BELL} and ${ESC}[31mcolour${ESC}[0m`, mtime: T0 - 2 * H });
  claudeFile(cfg, "-w", "eeeeeeee-0000-4000-8000-000000000004", {
    cwd, mtime: T0 - 3 * H,
    text: [{ type: "text", text: "from an array part" }, { type: "text", text: "and another" }],
  });
  claudeFile(cfg, "-w", "eeeeeeee-0000-4000-8000-000000000005", { cwd, text: null, mtime: T0 - 4 * H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const byId = new Map(
    scanConversations(opts({ claudeConfigDir: cfg, codexHome: path.join(home, ".codex") })).map((c) => [c.id.slice(-1), c]),
  );
  assert.equal(byId.get("1")!.title, "first line");
  assert.equal(byId.get("2")!.title.length, 80);
  assert.equal(byId.get("3")!.title, "bell and [31mcolour[0m");
  assert.equal(byId.get("4")!.title, "from an array part and another");
  assert.equal(byId.get("5")!.title, "", "a transcript with no user message has no title, not a guess");
});

test("Codex rollouts are read from their session_meta, and a continuation reads as compacted", async () => {
  const { home } = tempHome();
  const codexHome = path.join(home, ".codex");
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const plain = "11111111-1111-4111-8111-111111111111";
  const cont = "22222222-2222-4222-8222-222222222222";
  codexFile(codexHome, "2026-09-17", plain, { cwd, text: "plain rollout", mtime: T0 - 2 * H });
  const contFile = codexFile(codexHome, "2026-09-18", cont, { cwd, text: "compacted rollout", base: plain, mtime: T0 - H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({ claudeConfigDir: path.join(home, ".claude"), codexHome }));
  assert.deepEqual(got.map((c) => c.id), [cont, plain]);
  assert.deepEqual(got.map((c) => c.provider), ["codex", "codex"]);
  assert.deepEqual(got.map((c) => c.compacted), [true, false]);
  assert.equal(got[0]!.transcriptPath, contFile);
  assert.equal(got[0]!.cwd, cwd);
  assert.equal(got[0]!.title, "compacted rollout");
});

test("a Codex title is the human's first word, not the context Codex injected ahead of it", async () => {
  // The live dry-run's second defect: every Codex row read `# AGENTS.md
  // instructions`, because Codex writes its injected context as a user
  // message of its own before the human has said anything. Markers confirmed
  // against this machine's own rollouts — `# AGENTS.md instructions` (with
  // and without a trailing path) leads five of the twelve most recent, and
  // `<recommended_plugins>` leads another.
  const { home } = tempHome();
  const codexHome = path.join(home, ".codex");
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  codexFile(codexHome, "2026-09-18", ids[0]!, {
    cwd, mtime: T0,
    users: ["# AGENTS.md instructions\n\n<INSTRUCTIONS>\nread the guide\n</INSTRUCTIONS>", "port the parser to the new shape"],
  });
  codexFile(codexHome, "2026-09-18", ids[1]!, {
    cwd, mtime: T0 - H,
    users: ["# AGENTS.md instructions for /Users/x/src/data\n\nstuff", "why is the build slow?"],
  });
  codexFile(codexHome, "2026-09-18", ids[2]!, {
    cwd, mtime: T0 - 2 * H,
    users: ["<environment_context>\n  <cwd>/x</cwd>\n</environment_context>", "<user_instructions>\nbe terse\n</user_instructions>", "rename the flag"],
  });
  codexFile(codexHome, "2026-09-18", ids[3]!, {
    cwd, mtime: T0 - 3 * H,
    users: ["<recommended_plugins>\n  none\n</recommended_plugins>", "add the missing test"],
  });
  // The preamble and the prompt arriving as two PARTS of one record: the
  // preamble part goes, the prompt part stays.
  codexFile(codexHome, "2026-09-18", ids[4]!, {
    cwd, mtime: T0 - 4 * H,
    users: [["# AGENTS.md instructions\n\nread this", "and then do the thing"]],
  });
  // Nothing but preamble: no title at all, rather than Codex's own boilerplate.
  codexFile(codexHome, "2026-09-18", ids[5]!, { cwd, mtime: T0 - 5 * H, users: ["<environment_context>\n</environment_context>"] });

  const { scanConversations, isCodexPreamble } = await import("../src/import/scan.ts");
  const byId = new Map(
    scanConversations(opts({ claudeConfigDir: path.join(home, ".claude"), codexHome })).map((c) => [c.id, c]),
  );
  assert.equal(byId.get(ids[0]!)!.title, "port the parser to the new shape");
  assert.equal(byId.get(ids[1]!)!.title, "why is the build slow?");
  assert.equal(byId.get(ids[2]!)!.title, "rename the flag");
  assert.equal(byId.get(ids[3]!)!.title, "add the missing test");
  assert.equal(byId.get(ids[4]!)!.title, "and then do the thing");
  assert.equal(byId.get(ids[5]!)!.title, "");

  assert.equal(isCodexPreamble("# AGENTS.md instructions\n…"), true);
  assert.equal(isCodexPreamble("  <user_instructions>"), true, "leading whitespace does not hide a marker");
  // A marker MENTIONED is a prompt; only a marker that leads is preamble.
  assert.equal(isCodexPreamble("make the header read # AGENTS.md instructions verbatim"), false);
  assert.equal(isCodexPreamble("wrap it in <user_instructions> tags"), false);
});

test("a Claude title keeps the human's first message whatever it opens with", async () => {
  // The preamble rule is Codex's alone: Claude Code's first user record IS
  // the human's prompt, so nothing there may be skipped on a marker.
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const cwd = path.join(home, "w");
  mkdirSync(cwd, { recursive: true });
  claudeFile(cfg, "-w", "aaaaaaaa-0000-4000-8000-000000000001", { cwd, text: "<user_instructions> are what I want to talk about", mtime: T0 });
  const { scanConversations } = await import("../src/import/scan.ts");
  const [c] = scanConversations(opts({ claudeConfigDir: cfg, codexHome: path.join(home, ".codex") }));
  assert.equal(c!.title, "<user_instructions> are what I want to talk about");
});

// --- Live processes --------------------------------------------------------

test("a live process claims the newest conversation in its own cwd; one with none is returned with an empty id", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const withConv = path.join(home, "src", "data");
  const without = path.join(home, "src", "empty");
  mkdirSync(withConv, { recursive: true });
  mkdirSync(without, { recursive: true });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd: withConv, text: "older", mtime: T0 - 3 * H });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000002", { cwd: withConv, text: "newest", mtime: T0 - H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({
    claudeConfigDir: cfg, codexHome: path.join(home, ".codex"),
    ps: () => [
      proc({ pid: 4321, startedAt: T0 - 2 * H, tty: "s004", argv: ["claude", "--yolo"] }),
      proc({ pid: 4322, startedAt: T0 - 2 * H, tty: "s005", argv: ["node", "/x/bin/claude"] }),
      proc({ pid: 99, startedAt: T0 - 2 * H, tty: "s006", argv: ["vim"] }),
    ],
    cwdOf: (pid) => (pid === 4321 ? withConv : pid === 4322 ? without : "/nowhere"),
  }));

  const live = got.filter((c) => c.pid !== null);
  assert.equal(live.length, 2, "only the two CLIs are processes; vim is not one");
  const matched = got.find((c) => c.pid === 4321)!;
  assert.equal(matched.id, "aaaaaaaa-0000-4000-8000-000000000002", "the NEWEST conversation in that cwd");
  assert.deepEqual(matched.argv, ["claude", "--yolo"]);
  assert.equal(matched.startedAt, T0 - 2 * H);
  const orphan = got.find((c) => c.pid === 4322)!;
  assert.equal(orphan.id, "", "nothing on disk to claim");
  assert.equal(orphan.cwd, without);
  assert.equal(orphan.transcriptPath, "");
  assert.equal(got.find((c) => c.id === "aaaaaaaa-0000-4000-8000-000000000001")!.pid, null, "the older one stays idle");
});

test("a conversation last touched before the process started is not that process's conversation", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd, text: "from this morning", mtime: T0 - 5 * H });
  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({
    claudeConfigDir: cfg, codexHome: path.join(home, ".codex"),
    ps: () => [proc({ pid: 4321, startedAt: T0 - H, argv: ["claude"] })],
    cwdOf: () => cwd,
  }));
  assert.equal(got.find((c) => c.pid === 4321)!.id, "", "a stale transcript is not evidence of this process");
  assert.equal(got.length, 2);
});

test("two processes in one cwd take one conversation each, newest to newest", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd, text: "one", mtime: T0 - 2 * H });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000002", { cwd, text: "two", mtime: T0 - H });
  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({
    claudeConfigDir: cfg, codexHome: path.join(home, ".codex"),
    ps: () => [
      // Two conversations in one directory is two terminal tabs, so two
      // ttys. Two CLIs on ONE tty is the npm wrapper and its own child (the
      // test below), and those are one conversation, not two.
      proc({ pid: 1, startedAt: T0 - 4 * H, tty: "s004", argv: ["claude"] }),
      proc({ pid: 2, startedAt: T0 - 3 * H, tty: "s005", argv: ["claude"] }),
    ],
    cwdOf: () => cwd,
  }));
  assert.deepEqual(got.map((c) => [c.title, c.pid]), [["two", 2], ["one", 1]]);
});

test("two matching processes on one tty are one conversation: the npm wrapper's child makes no row of its own", async () => {
  // Live, mini 1, 0.3.0: an npm-installed Codex is TWO processes per session —
  // `node …/codex --yolo` and the native binary it execs, on the same tty, in
  // the same cwd. One claimed the conversation and the other, having nothing
  // left to claim, was printed as its own row: `skipped: live, no conversation
  // found`. Three sessions, three noise rows. The tty is what says they are one
  // session, and the lowest pid on it is the parent.
  const { home } = tempHome();
  const codexHome = path.join(home, ".codex");
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const id = "11111111-1111-4111-8111-111111111111";
  codexFile(codexHome, "2026-09-19", id, { cwd, text: "the one conversation", mtime: T0 });

  const { scanConversations, dedupeByTty } = await import("../src/import/scan.ts");
  assert.deepEqual(
    dedupeByTty([{ pid: 9, tty: "??" }, { pid: 8, tty: "??" }, { pid: 7, tty: "s004" }, { pid: 6, tty: "s004" }]).map((r) => r.pid),
    [9, 8, 6],
    "no controlling terminal is not a SHARED terminal: two of those are two unrelated processes, and neither is dropped",
  );
  const got = scanConversations(opts({
    claudeConfigDir: path.join(home, ".claude"), codexHome,
    ps: () => [
      proc({ pid: 5100, startedAt: T0 - H, tty: "s004", argv: ["node", "/x/lib/node_modules/@openai/codex/bin/codex.js", "--yolo"] }),
      proc({ pid: 5101, startedAt: T0 - H + 1000, tty: "s004", argv: ["/x/lib/node_modules/@openai/codex/bin/codex-aarch64-apple-darwin/codex", "--yolo"] }),
    ],
    cwdOf: () => cwd,
  }));

  assert.equal(got.length, 1, `one conversation, one row: ${JSON.stringify(got.map((c) => [c.id, c.pid]))}`);
  assert.equal(got[0]!.id, id);
  assert.equal(got[0]!.pid, 5100, "the parent — the lowest pid on that tty — is the process an import stops");
  assert.deepEqual(got[0]!.argv, ["node", "/x/lib/node_modules/@openai/codex/bin/codex.js", "--yolo"]);
});

test("a process whose tty is a tmux pane's tty is in tmux; its neighbour is not", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const cwd = path.join(home, "src", "data");
  const other = path.join(home, "src", "anu");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(other, { recursive: true });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd, text: "in a pane", mtime: T0 });
  claudeFile(cfg, "-b", "bbbbbbbb-0000-4000-8000-000000000002", { cwd: other, text: "in a tab", mtime: T0 });
  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({
    claudeConfigDir: cfg, codexHome: path.join(home, ".codex"),
    ps: () => [
      proc({ pid: 1, startedAt: T0 - H, tty: "s004", argv: ["claude"] }),
      proc({ pid: 2, startedAt: T0 - H, tty: "s009", argv: ["claude"] }),
    ],
    cwdOf: (pid) => (pid === 1 ? cwd : other),
    // tmux spells it `/dev/ttys004`; ps spells it `s004`.
    tmuxTtys: () => new Set(["/dev/ttys004"]),
  }));
  assert.equal(got.find((c) => c.pid === 1)!.inTmux, true);
  assert.equal(got.find((c) => c.pid === 2)!.inTmux, false);
});

// --- Filters ---------------------------------------------------------------

test("--since drops an idle conversation and never a live one", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const idleDir = path.join(home, "src", "data");
  const liveDir = path.join(home, "src", "anu");
  mkdirSync(idleDir, { recursive: true });
  mkdirSync(liveDir, { recursive: true });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd: idleDir, text: "fresh and idle", mtime: T0 - H });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000002", { cwd: idleDir, text: "old and idle", mtime: T0 - 10 * H });
  claudeFile(cfg, "-b", "bbbbbbbb-0000-4000-8000-000000000003", { cwd: liveDir, text: "old but live", mtime: T0 - 9 * H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const base = {
    claudeConfigDir: cfg, codexHome: path.join(home, ".codex"),
    ps: () => [proc({ pid: 4321, startedAt: T0 - 11 * H, argv: ["claude"] })],
    cwdOf: () => liveDir,
  };
  const all = scanConversations(opts(base));
  assert.equal(all.length, 3);
  assert.equal(all.find((c) => c.pid === 4321)!.title, "old but live");

  const since = scanConversations(opts({ ...base, sinceMs: T0 - 2 * H }));
  assert.deepEqual(
    since.map((c) => c.title).sort(),
    ["fresh and idle", "old but live"],
    "the live one survives the window it falls outside; the idle one older than the window does not",
  );
  assert.equal(since.find((c) => c.title === "old but live")!.pid, 4321);
  assert.equal(since.find((c) => c.title === "old and idle"), undefined);
});

test("--dir keeps only conversations under one of the given paths", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const keep = path.join(home, "src", "data");
  const deep = path.join(keep, "packages", "web");
  const drop = path.join(home, "src", "datastore"); // shares a prefix, is not under it
  for (const d of [keep, deep, drop]) mkdirSync(d, { recursive: true });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd: keep, text: "at the root", mtime: T0 });
  claudeFile(cfg, "-b", "aaaaaaaa-0000-4000-8000-000000000002", { cwd: deep, text: "below it", mtime: T0 - H });
  claudeFile(cfg, "-c", "aaaaaaaa-0000-4000-8000-000000000003", { cwd: drop, text: "beside it", mtime: T0 - 2 * H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({ claudeConfigDir: cfg, codexHome: path.join(home, ".codex"), dirs: [keep] }));
  assert.deepEqual(got.map((c) => c.title), ["at the root", "below it"]);
});

test("--dir and a recorded cwd meet as real paths, whichever of them went through a symlink", async () => {
  // A `--dir` a human typed comes from their shell, where `~/src` may well be
  // a symlink; a transcript's own `cwd` is whatever the CLI was started in,
  // which may be the other spelling of the same directory. Both sides are
  // resolved, so the two always meet — the literal strings never would.
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const real = path.join(home, "real");
  const realData = path.join(real, "data");
  const link = path.join(home, "link"); // -> home/real
  const outside = path.join(home, "elsewhere");
  mkdirSync(realData, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(real, link);

  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000001", { cwd: realData, text: "recorded real", mtime: T0 });
  claudeFile(cfg, "-b", "aaaaaaaa-0000-4000-8000-000000000002", { cwd: path.join(link, "data"), text: "recorded through the link", mtime: T0 - H });
  claudeFile(cfg, "-c", "aaaaaaaa-0000-4000-8000-000000000003", { cwd: outside, text: "somewhere else", mtime: T0 - 2 * H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const base = { claudeConfigDir: cfg, codexHome: path.join(home, ".codex") };

  // A `--dir` given through the symlink still finds both conversations…
  const viaLink = scanConversations(opts({ ...base, dirs: [path.join(link, "data")] }));
  assert.deepEqual(viaLink.map((c) => c.title), ["recorded real", "recorded through the link"]);
  // …and so does the same `--dir` spelled as the real path.
  const viaReal = scanConversations(opts({ ...base, dirs: [realData] }));
  assert.deepEqual(viaReal.map((c) => c.title), ["recorded real", "recorded through the link"]);
  // Whichever way it arrived, the cwd a candidate reports is the real one —
  // it is what the pane will be opened in, and what `lsof` would say.
  assert.deepEqual(new Set(viaLink.map((c) => c.cwd)), new Set([realData]));
  assert.equal(viaLink.find((c) => c.title === "somewhere else"), undefined, "the filter still filters");
});

test("a transcript whose cwd and title sit past the header budget falls back, and does so fast", async () => {
  // The constraint is that a transcript is read as far as its header and first
  // user line and NO further. The guard is the FALLBACK: a reader that took
  // the whole file (readFileSync, say) would find the buried cwd and title,
  // so finding them is the regression. The time bound is the constraint's
  // other half — a scan must not cost the size of the store.
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const dir = path.join(cfg, "projects", "-Users-x-y");
  mkdirSync(dir, { recursive: true });
  const id = "ffffffff-0000-4000-8000-000000000001";
  const buried = path.join(dir, `${id}.jsonl`);
  writeFileSync(buried, [
    // A real transcript's own opening records: no cwd on either of them.
    JSON.stringify({ type: "last-prompt", leafUuid: "f4bb3a18", sessionId: id }),
    // 4 MiB on ONE line, eight times the 512 KiB budget, so the reader runs
    // out of budget in the middle of it and never reaches what follows.
    JSON.stringify({ type: "assistant", sessionId: id, message: { role: "assistant", content: "z".repeat(4 << 20) } }),
    JSON.stringify({ type: "user", sessionId: id, cwd, message: { role: "user", content: "buried out of reach" } }),
  ].join("\n") + "\n", { mode: 0o600 });
  utimesSync(buried, T0 / 1000, T0 / 1000);
  assert.ok(statSync(buried).size > 4 << 20, "the fixture has to be bigger than the budget to test it");

  // A small transcript beside it, to show the budget is a bound and not a ban.
  claudeFile(cfg, "-w", "aaaaaaaa-0000-4000-8000-000000000002", { cwd, text: "read in full", mtime: T0 - H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const started = Date.now();
  const got = scanConversations(opts({ claudeConfigDir: cfg, codexHome: path.join(home, ".codex") }));
  const elapsed = Date.now() - started;

  const big = got.find((c) => c.id === id)!;
  assert.equal(big.cwd, "/Users/x/y", "past the budget there is no recorded cwd, so the directory name is unescaped");
  assert.equal(big.title, "", "and no title, rather than one bought by reading four megabytes");
  assert.equal(got.find((c) => c.title === "read in full")!.cwd, cwd, "its small neighbour is still read normally");
  assert.ok(elapsed < 1000, `a bounded scan is fast; took ${elapsed}ms`);
});

test("a conversation the tool already runs is marked managed, not hidden", async () => {
  const { home } = tempHome();
  const cfg = path.join(home, ".claude");
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const mine = "aaaaaaaa-0000-4000-8000-000000000001";
  claudeFile(cfg, "-a", mine, { cwd, text: "already ours", mtime: T0 });
  claudeFile(cfg, "-a", "aaaaaaaa-0000-4000-8000-000000000002", { cwd, text: "not ours", mtime: T0 - H });
  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({
    claudeConfigDir: cfg, codexHome: path.join(home, ".codex"), managedIds: () => new Set([mine]),
  }));
  assert.deepEqual(got.map((c) => [c.title, c.managed]), [["already ours", true], ["not ours", false]]);
});

test("a missing store is an empty scan, not a throw", async () => {
  const { home } = tempHome();
  const { scanConversations } = await import("../src/import/scan.ts");
  assert.deepEqual(
    scanConversations(opts({ claudeConfigDir: path.join(home, "nope"), codexHome: path.join(home, "also-nope") })),
    [],
  );
});

// --- The shared store (0.3.6) ----------------------------------------------

test("the shared store is walked too — a conversation there is found whatever CODEX_HOME the scan runs under", async () => {
  // Since 0.3.6 `p.codexSessions()` is a link to ~/.codex/sessions. A scan
  // run under some other codex home still finds what is in the store.
  const { home } = tempHome();
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const other = path.join(home, "other-codex-home");
  const base = path.join(home, ".codex");
  const inOther = "11111111-1111-4111-8111-111111111111";
  const inBase = "22222222-2222-4222-8222-222222222222";
  codexFile(other, "2026-09-17", inOther, { cwd, text: "under the other home", mtime: T0 - 2 * H });
  codexFile(base, "2026-09-18", inBase, { cwd, text: "in ~/.codex", mtime: T0 - H });
  const store = path.join(home, "ms", "codex", "sessions");
  mkdirSync(path.dirname(store), { recursive: true });
  symlinkSync(path.join(base, "sessions"), store);

  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({ claudeConfigDir: path.join(home, ".claude"), codexHome: other, codexStore: store }));
  assert.deepEqual(got.map((c) => c.id), [inBase, inOther]);
  assert.equal(got[0]!.title, "in ~/.codex");
});

test("the store and a CODEX_HOME that are one directory are walked once — no conversation twice", async () => {
  const { home } = tempHome();
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const base = path.join(home, ".codex");
  const id = "11111111-1111-4111-8111-111111111111";
  codexFile(base, "2026-09-17", id, { cwd, text: "once", mtime: T0 - H });
  // An ms account home: its `sessions` links to the base's, as the store does.
  const acct = path.join(home, "ms", "codex", "work");
  mkdirSync(acct, { recursive: true });
  symlinkSync(path.join(base, "sessions"), path.join(acct, "sessions"));
  const store = path.join(home, "ms", "codex", "sessions");
  symlinkSync(path.join(base, "sessions"), store);

  const { scanConversations } = await import("../src/import/scan.ts");
  for (const codexHome of [base, acct]) {
    const got = scanConversations(opts({ claudeConfigDir: path.join(home, ".claude"), codexHome, codexStore: store }));
    assert.deepEqual(got.map((c) => c.id), [id], codexHome);
  }
});

test("one conversation under both roots — a copy ms adopt once made — is one candidate, the copy written last", async () => {
  const { home } = tempHome();
  const cwd = path.join(home, "src", "data");
  mkdirSync(cwd, { recursive: true });
  const other = path.join(home, "other-codex-home");
  const storeHome = path.join(home, "store-home");
  const id = "11111111-1111-4111-8111-111111111111";
  codexFile(other, "2026-09-17", id, { cwd, text: "older copy", mtime: T0 - 3 * H });
  const newer = codexFile(storeHome, "2026-09-17", id, { cwd, text: "newer copy", mtime: T0 - H });

  const { scanConversations } = await import("../src/import/scan.ts");
  const got = scanConversations(opts({ claudeConfigDir: path.join(home, ".claude"), codexHome: other, codexStore: path.join(storeHome, "sessions") }));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.transcriptPath, newer);
});
