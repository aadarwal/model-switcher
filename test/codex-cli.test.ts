import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { classifyCodexInvocation, isCodexTuiCommand, codexExecutionCommand, codexExitSequence, codexHome, codexLaunchCommand, codexResumeCommand, ensureCodexTrust, withNoDaemon } = await import("../src/providers/codex-cli.ts");

// Resolved: `os.tmpdir()` is `/tmp` on macOS, itself a symlink to `/private/tmp`,
// and `src/paths.ts`'s `msHome()` now resolves `MS_HOME` the same way — so an
// unresolved temp dir here would diverge from what the tool derives internally.
const tempDir = (prefix: string) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
const configOf = (home: string) => path.join(home, "config.toml");
const read = (home: string) => readFileSync(configOf(home), "utf8");
/** How many times a pattern occurs — the test for "one table, one key". */
const count = (s: string, re: RegExp) => s.match(new RegExp(re.source, `${re.flags.replace("g", "")}g`))?.length ?? 0;
/** A literal path inside a RegExp: a temp dir can hold `.` and `+`. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- the command -------------------------------------------------------

test("codexLaunchCommand is the CLI's own name and nothing else", () => {
  // Codex has no `--session-id`: the session's identity arrives from the
  // hook's SessionStart, so a launch adds no argument of its own.
  assert.deepEqual(codexLaunchCommand([]), ["codex"]);
  assert.deepEqual(codexLaunchCommand(["--model", "gpt-5", "hi"]), ["codex", "--model", "gpt-5", "hi"]);
});

test("codexResumeCommand carries the continuation as an argument, never as keystrokes", () => {
  // Verified live: `codex resume <id> "<prompt>"` resumes the conversation AND
  // submits the prompt. Sending it as keys instead loses it to the TUI's paste
  // detection, which is why the continuation is argv here as it is for Claude.
  assert.deepEqual(codexResumeCommand("cx-1", "carry on", ["--model", "gpt-5"]), [
    "codex", "resume", "cx-1", "carry on", "--model", "gpt-5",
  ]);
  // A move the human asked for without a continuation: resumed, and left alone.
  assert.deepEqual(codexResumeCommand("cx-1", null, ["--model", "gpt-5"]), ["codex", "resume", "cx-1", "--model", "gpt-5"]);
  assert.deepEqual(codexResumeCommand("cx-1", null, []), ["codex", "resume", "cx-1"]);
  // An empty string is not a prompt: submitting one would be an empty turn.
  assert.deepEqual(codexResumeCommand("cx-1", "", []), ["codex", "resume", "cx-1"]);
});

test("codexExitSequence is Ctrl-C twice, and never text", () => {
  // Spike G1, Codex 0.153.4: `/exit` and `/quit` did nothing at all in ~10 s;
  // Ctrl-C twice ended the TUI in about two seconds and fired SessionEnd.
  const { keys, settleMs } = codexExitSequence();
  assert.deepEqual(keys, [["C-c"], ["C-c"]]);
  assert.equal(settleMs, 2_000, "the observed exit takes ~2 s; past it the pane is signalled instead");
  assert.ok(keys.flat().every((k) => k === "C-c"), "nothing here may be text typed into the composer");
});

test("codexHome is the account's own CODEX_HOME under MS_HOME", () => {
  const ms = tempDir("ms-codex-home-");
  // Put back the pinned store (test/setup-env.mjs), never delete it: an unset
  // MS_HOME is the developer's real one.
  const saved = process.env.MS_HOME;
  process.env.MS_HOME = ms;
  try {
    assert.equal(codexHome("work"), path.join(ms, "codex", "work"));
  } finally {
    process.env.MS_HOME = saved;
  }
});

// --- directory trust ---------------------------------------------------

test("a home with no config.toml gets one, 0600, naming the cwd as trusted", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  assert.match(text, new RegExp(`^\\[projects\\.${JSON.stringify(real).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`, "m"));
  assert.match(text, /^trust_level = "trusted"$/m);
  assert.equal(statSync(configOf(home)).mode & 0o777, 0o600);
});

test("the trust table is written once: a second launch changes nothing", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });
  const first = read(home);
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: false });
  assert.equal(read(home), first, "an idempotent writer leaves the file byte-for-byte");
  assert.equal(count(first, /^\[projects\./m), 1);
  assert.equal(count(first, /^trust_level/m), 1);
});

test("the cwd is symlink-resolved: the link and its target are one project", () => {
  const home = tempDir("ms-codex-trust-");
  const base = tempDir("ms-codex-cwd-");
  const real = path.join(realpathSync(base), "project");
  mkdirSync(real);
  const link = path.join(base, "link");
  symlinkSync(real, link, "dir");

  assert.deepEqual(ensureCodexTrust(home, link), { changed: true });
  const text = read(home);
  assert.ok(text.includes(`[projects.${JSON.stringify(real)}]`), text);
  assert.equal(text.includes(`[projects.${JSON.stringify(link)}]`), false, "the link must not become a second project");
  // Codex records trust against the directory it actually resolved.
  assert.deepEqual(ensureCodexTrust(home, real), { changed: false });
});

test("every other table survives untouched — the hook tables above all", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const hooks = [
    `model = "gpt-5"`,
    ``,
    `[[hooks.SessionStart]]`,
    `matcher = "*"`,
    `hooks = [{ type = "command", command = "/opt/ms _hook codex" }]`,
    ``,
    `[[hooks.Stop]]`,
    `hooks = [{ type = "command", command = "/opt/ms _hook codex" }]`,
    ``,
    `[hooks.state."/x/config.toml:session_start:0:0"]`,
    `trusted_hash = "sha256:abc"`,
    ``,
  ].join("\n");
  writeFileSync(configOf(home), hooks, { mode: 0o600 });

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  assert.ok(text.startsWith(hooks), "existing tables are never rewritten, only added to");
  assert.match(text, /^trust_level = "trusted"$/m);
  assert.equal(count(text, /^trusted_hash = "sha256:abc"$/m), 1);
  assert.equal(count(text, /^\[\[hooks\.SessionStart\]\]$/m), 1);
  assert.equal(count(text, /^\[\[hooks\.Stop\]\]$/m), 1);
});

test("an existing project table is added to, never duplicated", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  writeFileSync(
    configOf(home),
    `[projects.${JSON.stringify(real)}]\napproval_policy = "on-request"\n\n[[hooks.Stop]]\nhooks = []\n`,
    { mode: 0o600 },
  );

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  // A second [projects."…"] header for the same path would make the file
  // invalid TOML, and Codex would then read no config at all.
  assert.equal(count(text, /^\[projects\./m), 1);
  assert.match(text, /^trust_level = "trusted"$/m);
  assert.match(text, /^approval_policy = "on-request"$/m);
  // the key landed inside the project table, not in the hooks table below it
  assert.ok(text.indexOf("trust_level") < text.indexOf("[[hooks.Stop]]"), text);
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: false });
});

test("a project the human marked untrusted is honoured, not overruled", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  const before = `[projects.${JSON.stringify(real)}]\ntrust_level = "untrusted"\n`;
  writeFileSync(configOf(home), before, { mode: 0o600 });

  // A `trust_level` a human set is an ANSWER about their own directory. The
  // tool reports it and launches nothing; it does not quietly promote itself.
  assert.deepEqual(ensureCodexTrust(home, cwd), {
    changed: false,
    problem: `${real} is marked untrusted in ${configOf(home)}; edit it or launch elsewhere`,
  });
  assert.equal(read(home), before, "a refusal writes nothing at all");
});

test("the refusal names the value as written, whatever it is", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  writeFileSync(configOf(home), `[projects.${JSON.stringify(real)}]\ntrust_level = 'ask'  # for now\n`, { mode: 0o600 });

  const r = ensureCodexTrust(home, cwd);
  assert.equal(r.changed, false);
  assert.match(r.problem!, /is marked ask in /);
});

test("a header with a trailing comment is the SAME table, not a second one", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  writeFileSync(
    configOf(home),
    `[projects.${JSON.stringify(real)}]   # trusted by hand, 2026-09-01\ntrust_level = "trusted"\n`,
    { mode: 0o600 },
  );

  // Before the comment was stripped, this header did not match and a SECOND
  // [projects."…"] table was appended — a duplicate table, invalid TOML, and
  // Codex answers an invalid config.toml by dropping the whole file: the hook
  // tables and every trust already granted, gone.
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: false });
  assert.equal(count(read(home), /^\[projects\./m), 1);
});

test("a comment is not stripped out of a path that contains a #", () => {
  const home = tempDir("ms-codex-trust-");
  const base = realpathSync(tempDir("ms-codex-cwd-"));
  const hashed = path.join(base, "a#b");
  mkdirSync(hashed);

  assert.deepEqual(ensureCodexTrust(home, hashed), { changed: true });
  assert.ok(read(home).includes(`[projects.${JSON.stringify(hashed)}]`), read(home));
  assert.deepEqual(ensureCodexTrust(home, hashed), { changed: false });
});

// --- the refusals ------------------------------------------------------
//
// Each of these is a `projects` definition the scanner cannot attribute.
// Appending beside one would define the same table twice; the whole config
// then fails to parse and Codex reads NONE of it.

for (const [what, body] of [
  ["a root-level inline table", `projects = { "/a/b" = { trust_level = "trusted" } }\n`],
  ["a root-level dotted assignment", `projects."/a/b".trust_level = "trusted"\n`],
  ["a bare [projects] super-table", `[projects]\n"/a/b" = { trust_level = "trusted" }\n`],
  ["an array of projects tables", `[[projects."/a/b"]]\ntrust_level = "trusted"\n`],
  ["a header with an unreadable key", `[projects.somebarekey]\ntrust_level = "trusted"\n`],
  ["a header with two key segments", `[projects."/a"."b"]\ntrust_level = "trusted"\n`],
] as const) {
  test(`${what} is refused, and nothing is written`, () => {
    const home = tempDir("ms-codex-trust-");
    const cwd = tempDir("ms-codex-cwd-");
    // The definition comes FIRST: a `projects = { … }` written after a table
    // header would belong to that table, not to the root, and this writer is
    // right to ignore one that does.
    const before = `${body}\n[[hooks.Stop]]\nhooks = []\n`;
    writeFileSync(configOf(home), before, { mode: 0o600 });

    const r = ensureCodexTrust(home, cwd);
    assert.equal(r.changed, false, what);
    assert.match(r.problem!, new RegExp(`^${esc(configOf(home))} already defines 'projects'`), what);
    assert.match(r.problem!, /this tool will not edit/, what);
    assert.equal(read(home), before, `${what}: a refusal writes nothing at all`);
  });
}

test("a hooks table named like a project is not mistaken for one", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  writeFileSync(configOf(home), `[hooks.state."/x/config.toml:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n`, { mode: 0o600 });

  // Only `projects` tables concern this writer; everything else is a boundary.
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });
  assert.match(read(home), /^trust_level = "trusted"$/m);
});

test("another project's table is not mistaken for this one", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  writeFileSync(configOf(home), `[projects."/somewhere/else"]\ntrust_level = "trusted"\n`, { mode: 0o600 });

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  assert.equal(count(text, /^\[projects\./m), 2);
  assert.equal(count(text, /^trust_level = "trusted"$/m), 2);
});

test("a 'projects' key inside somebody else's table is not a projects definition", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  // `projects` here is `hooks.Stop.projects`, which has nothing to do with
  // the root table this writer adds to — refusing on it would be a launch
  // lost to a word.
  writeFileSync(configOf(home), `[[hooks.Stop]]\nprojects = { x = 1 }\n`, { mode: 0o600 });

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });
  assert.match(read(home), /^trust_level = "trusted"$/m);
});

// --- in-process: `--no-daemon` ---------------------------------------------

test("shared Codex classifier excludes daemon workers and preserves actual TUI option boundaries", () => {
  for (const command of [
    ["codex", "app-server", "--listen", "unix://", "--analytics-default-enabled", "--managed-daemon"],
    ["codex", "app-server", "daemon", "pid-update-loop"], ["codex", "exec", "resume"],
    ["codex", "--profile", "resume", "app-server", "--managed-daemon"],
  ]) assert.equal(isCodexTuiCommand(command), false, JSON.stringify(command));
  for (const command of [
    ["codex", "--model", "app-server"], ["codex", "--profile=resume"],
    ["codex", "--image", "-", "app-server"], ["codex", "--", "app-server"],
    ["codex", "resume", "review"], ["codex", "fork", "app-server"],
  ]) assert.equal(isCodexTuiCommand(command), true, JSON.stringify(command));
  assert.equal(classifyCodexInvocation(["codex", "--profile", "resume"]).subcommand, null);
  assert.equal(classifyCodexInvocation(["codex", "--model", "resume", "resume", "--profile", "review", "thread"]).subcommandIndex, 3);
  assert.equal(isCodexTuiCommand(["codex", "app"], "linux"), true);
  assert.equal(isCodexTuiCommand(["codex", "app"], "darwin"), false);
});

test("legacy full-auto uses its original workspace-write/on-request policy on verified rejecting versions", () => {
  for (const version of ["0.157.0", "0.163.0"]) {
    assert.deepEqual(codexExecutionCommand(["codex", "--full-auto", "--model", "gpt-6.1-sol"], version),
      ["codex", "--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--model", "gpt-6.1-sol"]);
    assert.deepEqual(codexExecutionCommand(["codex", "resume", "conversation", "--full-auto"], version),
      ["codex", "resume", "--no-daemon", "conversation", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  }
  for (const version of [null, "0.156.9"]) {
    const command = ["codex", "--full-auto"];
    assert.deepEqual(codexExecutionCommand(command, version), command);
  }
});

test("legacy full-auto does not reinterpret model/profile/config values, image paths or prompt boundaries", () => {
  for (const args of [["--profile", "--full-auto"], ["--config", "--full-auto"], ["--model=--full-auto"], ["-i--full-auto"], ["--image", "-", "resume"], ["--", "--full-auto"]]) {
    const command = ["codex", ...args];
    assert.deepEqual(codexExecutionCommand(command, "0.163.0"), withNoDaemon(command, "0.163.0"));
  }
  const exec = ["codex", "exec", "--full-auto"];
  assert.deepEqual(codexExecutionCommand(exec, "0.163.0"), exec);
  assert.throws(() => codexExecutionCommand(["codex", "--future-option", "--full-auto"], "0.163.0"), /unknown option's value/);
});

test("mixed or repeated legacy permission selectors refuse instead of changing approval semantics", () => {
  for (const selector of [["--sandbox", "read-only"], ["-sread-only"], ["--ask-for-approval=never"], ["-a", "on-request"], ["--yolo"], ["--dangerously-bypass-approvals-and-sandbox"], ["--approve-for-me"], ["--not-so-yolo"], ["--full-auto"]]) {
    for (const command of [["codex", "--full-auto", ...selector], ["codex", ...selector, "resume", "conversation", "--full-auto"]]) {
      assert.throws(() => codexExecutionCommand(command, "0.163.0"), /cannot safely adapt --full-auto/);
    }
  }
});

test("remote TUI argv stays untouched by daemon adaptation and refuses managed account ownership", () => {
  for (const command of [["codex", "--remote", "unix:///private/server.sock"], ["codex", "resume", "thread", "--remote=unix:///private/server.sock"]]) {
    assert.deepEqual(withNoDaemon(command, "0.163.0"), command);
    assert.throws(() => codexExecutionCommand(command, "0.163.0"), /cannot use --remote.*use plain codex/);
  }
  for (const command of [["codex", "agents", "--remote", "unix:///private/server.sock"], ["codex", "queue", "thread", "--remote=unix:///private/server.sock"]]) {
    assert.deepEqual(codexExecutionCommand(command, "0.163.0"), command);
  }
  const value = ["codex", "--profile=--remote"];
  assert.deepEqual(codexExecutionCommand(value, "0.163.0"), withNoDaemon(value, "0.163.0"));
});
//
// A pane that runs its conversation in its own process lets go of it the
// instant it exits, and its hooks run with ITS environment — never with the
// environment of whichever pane happened to start the account's shared
// background server. Added at exec time, for a CLI that has the flag.

const ID = "01a10951-a81b-7a52-9a37-6c3f1d1f0c11";

test("a resume runs in-process: --no-daemon goes right after the subcommand", () => {
  assert.deepEqual(
    withNoDaemon(["codex", "resume", ID, "continue", "--model", "gpt-5"], "0.160.0"),
    ["codex", "resume", "--no-daemon", ID, "continue", "--model", "gpt-5"],
  );
  assert.deepEqual(withNoDaemon(["codex", "--yolo", "resume", ID], "0.160.0"), ["codex", "--yolo", "resume", "--no-daemon", ID]);
  assert.deepEqual(withNoDaemon(["codex", "fork", ID], "0.160.0"), ["codex", "fork", "--no-daemon", ID]);
});

test("a new conversation runs in-process too: --no-daemon at the top level", () => {
  assert.deepEqual(withNoDaemon(["codex", "--model", "gpt-5"], "0.157.0"), ["codex", "--no-daemon", "--model", "gpt-5"]);
  assert.deepEqual(withNoDaemon(["codex"], "0.160.0"), ["codex", "--no-daemon"]);
  // Past `--` everything is the prompt: a `resume` there is a word, not a subcommand.
  assert.deepEqual(withNoDaemon(["codex", "--", "resume"], "0.160.0"), ["codex", "--no-daemon", "--", "resume"]);
});

test("resume and fork session names and prompts are not subcommands", () => {
  for (const sub of ["resume", "fork"]) {
    for (const prompt of ["review", "exec", "help", "app"]) {
      assert.deepEqual(
        withNoDaemon(["codex", sub, ID, prompt], "0.160.0"),
        ["codex", sub, "--no-daemon", ID, prompt],
      );
    }
    assert.deepEqual(
      withNoDaemon(["codex", sub, "review"], "0.160.0"),
      ["codex", sub, "--no-daemon", "review"],
    );
  }
});

test("option values do not select a subcommand or suppress in-process launches", () => {
  for (const args of [
    ["--profile", "review"], ["--cd", "app"], ["--model", "resume"],
    ["--enable", "exec"], ["--disable", "help"], ["--add-dir", "review"],
    ["-p", "review"], ["-C", "app"], ["-m", "resume"],
    ["--profile=review"], ["--model=resume"], ["-preview"], ["-mresume"],
  ]) {
    assert.deepEqual(
      withNoDaemon(["codex", ...args], "0.160.0"),
      ["codex", "--no-daemon", ...args],
    );
    assert.deepEqual(
      withNoDaemon(["codex", ...args, "resume", ID], "0.160.0"),
      ["codex", ...args, "resume", "--no-daemon", ID],
    );
    // A real non-interactive command is still left alone after options.
    const exec = ["codex", ...args, "exec", "hello"];
    assert.deepEqual(withNoDaemon(exec, "0.160.0"), exec);
  }
});

test("image values follow Codex's variable arity without becoming subcommands", () => {
  assert.deepEqual(
    withNoDaemon(["codex", "--image", "review", "resume"], "0.160.0"),
    ["codex", "--no-daemon", "--image", "review", "resume"],
  );
  assert.deepEqual(
    withNoDaemon(["codex", "-i", "review", "--model", "gpt-5", "resume", ID], "0.160.0"),
    ["codex", "-i", "review", "--model", "gpt-5", "resume", "--no-daemon", ID],
  );
  for (const image of ["--image=review", "-ireview"]) {
    assert.deepEqual(
      withNoDaemon(["codex", image, "resume", ID], "0.160.0"),
      ["codex", image, "resume", "--no-daemon", ID],
    );
  }
});

test("only an explicit flag before -- suppresses the added --no-daemon", () => {
  assert.deepEqual(
    withNoDaemon(["codex", "resume", "--", ID, "--no-daemon"], "0.160.0"),
    ["codex", "resume", "--no-daemon", "--", ID, "--no-daemon"],
  );
  for (const option of ["--profile=--no-daemon", "--image=--no-daemon", "-i--no-daemon"]) {
    assert.deepEqual(withNoDaemon(["codex", option], "0.160.0"), ["codex", "--no-daemon", option]);
  }
  const explicit = ["codex", "--image", "review", "--no-daemon", "resume", ID];
  assert.deepEqual(withNoDaemon(explicit, "0.160.0"), explicit, "an explicit flag ends the variadic image values");
});

test("a lone dash is an image value, so later paths named like subcommands stay image values", () => {
  // Both Codex 0.157.0 and 0.162.1 show root TUI help for these shapes.
  for (const option of ["--image", "-i"]) {
    for (const images of [["-", "review"], ["-", "resume", ID]]) {
      const args = [option, ...images, "--help"];
      assert.deepEqual(withNoDaemon(["codex", ...args], "0.160.0"), ["codex", "--no-daemon", ...args]);
    }
  }
});

test("noninteractive aliases and internal subcommands are left alone from the oldest supported daemon version", () => {
  // These help routes exist in installed Codex 0.157.0 and 0.162.1, and in
  // rust-v0.160.0's CLI enum. They must never acquire a TUI-only flag.
  for (const version of ["0.157.0", "0.160.0", "0.162.1"]) {
    for (const sub of ["cloud-tasks", "tcp-tunnel", "execpolicy", "responses-api-proxy", "stdio-to-uds"]) {
      const command = ["codex", "--profile", "review", sub, "--help"];
      assert.deepEqual(withNoDaemon(command, version), command, `${version}: ${sub}`);
    }
  }
});

test("a former command name remains a prompt, and the desktop app is a command only where Codex compiles it", () => {
  for (const version of ["0.157.0", "0.160.0", "0.162.1"]) {
    assert.deepEqual(withNoDaemon(["codex", "mcp-server"], version), ["codex", "--no-daemon", "mcp-server"]);
    assert.deepEqual(withNoDaemon(["codex", "app"], version, "linux"), ["codex", "--no-daemon", "app"]);
    for (const platform of ["darwin", "win32"] as const) {
      const command = ["codex", "app", "--help"];
      assert.deepEqual(withNoDaemon(command, version, platform), command);
    }
  }
});

test("--no-daemon is never added twice, never to a CLI without it, and never to a non-interactive subcommand", () => {
  // Codex refuses the flag given twice ("cannot be used multiple times").
  const own = ["codex", "resume", ID, "--no-daemon"];
  assert.deepEqual(withNoDaemon(own, "0.160.0"), own);
  // 0.157.0 is the oldest Codex seen with the flag; older ones refuse it.
  const cmd = ["codex", "resume", ID];
  assert.deepEqual(withNoDaemon(cmd, "0.156.9"), cmd);
  assert.deepEqual(withNoDaemon(cmd, null), cmd, "a version we could not read is not one we know has it");
  for (const sub of ["exec", "e", "review", "login", "app-server", "mcp"]) {
    const c = ["codex", sub, "x"];
    assert.deepEqual(withNoDaemon(c, "0.160.0"), c, sub);
  }
});
