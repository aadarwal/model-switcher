import { test } from "node:test";
import assert from "node:assert/strict";
import { run, tempHome, stubDir } from "./helpers.ts";

const SAMPLE_TOKEN = "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789";

const SESSION_BASE = {
  provider: "claude" as const, cliSessionId: "c-1", cwd: "/tmp/x",
  socket: "/private/tmp/tmux-501/default", pane: "%7", serverStart: "1789000000",
  need: "any" as const, state: "launching" as const, desired: "running" as const, flags: [],
};

/** Sets up a session + launch row directly (in-process import, so the
 * subprocess `run()` spawns later shares the same sqlite file on disk) and
 * returns the env `run()` needs to see the same store and stub PATH. */
async function seedLaunch(opts: {
  home: string; msHome: string; account?: string; generation?: number; env?: Record<string, string>;
  skipSession?: boolean; provider?: "claude" | "codex"; command?: string[];
}) {
  const account = opts.account ?? "gmail";
  const provider = opts.provider ?? "claude";
  process.env.HOME = opts.home; process.env.MS_HOME = opts.msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  if (!opts.skipSession) {
    st.createSession({
      id: "s1", ...SESSION_BASE, provider, account, generation: opts.generation ?? 2,
      // Codex has no `--session-id`; the row carries none until its hook speaks.
      cliSessionId: provider === "codex" ? null : SESSION_BASE.cliSessionId,
    });
  }
  st.createLaunch({
    id: "L1", sessionId: "s1", generation: opts.generation ?? 2, account,
    command: opts.command ?? ["claude", "--resume", "c-1", "hello"], env: opts.env ?? {}, createdAt: Math.floor(Date.now() / 1000),
  });
  st.close();
}

const STUB_SCRIPT = `echo "ARGV0=$0"
echo "ARGS=$*"
echo "TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
echo "MS_SESSION=$MS_SESSION"
echo "MS_GENERATION=$MS_GENERATION"
echo "MS_SOCKET=$MS_SOCKET"
echo "MS_PANE=$MS_PANE"
echo "MS_ACCOUNT=$MS_ACCOUNT"
echo "MS_BIN=$MS_BIN"
echo "FOO=$FOO"`;

test("_exec sets the environment and execs the CLI in place, with the token never on argv", async () => {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  await seedLaunch({ home, msHome, env: { FOO: "bar" } });
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);
  stub("claude", STUB_SCRIPT);

  const r = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}` });

  assert.equal(r.code, 0, r.stderr);
  const lines = Object.fromEntries(
    r.stdout.trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
  );
  assert.equal(lines.TOKEN, SAMPLE_TOKEN);
  assert.equal(lines.MS_SESSION, "s1");
  assert.equal(lines.MS_GENERATION, "2");
  assert.equal(lines.MS_SOCKET, SESSION_BASE.socket);
  assert.equal(lines.MS_PANE, SESSION_BASE.pane);
  assert.equal(lines.MS_ACCOUNT, "gmail");
  assert.equal(lines.ARGS, "--resume c-1 hello");
  assert.equal(lines.FOO, "bar");
  assert.match(lines.MS_BIN, /bin\/ms$/);
  // The credential lives only in the environment, never in argv. Note the stub's `$0`
  // is bash's own report of the path the kernel exec'd (not something `_exec` writes),
  // so this line only proves "no token on argv" — it says nothing about which path was
  // resolved; that's covered separately by the "not found on PATH" test below, which
  // does exercise PATH resolution end to end.
  assert.equal(lines.ARGV0.includes(SAMPLE_TOKEN), false);
  assert.equal(lines.ARGS.includes(SAMPLE_TOKEN), false);
});

test("launch.env cannot shadow the token or MS_* identity variables", async () => {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  await seedLaunch({ home, msHome, env: { MS_ACCOUNT: "evil", CLAUDE_CODE_OAUTH_TOKEN: "evil-token", MS_SESSION: "evil-session" } });
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);
  stub("claude", STUB_SCRIPT);

  const r = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}` });

  assert.equal(r.code, 0, r.stderr);
  const lines = Object.fromEntries(
    r.stdout.trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
  );
  // the real values always win, regardless of what a launch.env entry claims
  assert.equal(lines.MS_ACCOUNT, "gmail");
  assert.equal(lines.TOKEN, SAMPLE_TOKEN);
  assert.equal(lines.MS_SESSION, "s1");
});

test("a missing launch token exits 3 and stderr names only the account", async () => {
  const { home, msHome } = tempHome();
  await seedLaunch({ home, msHome, account: "gmail" });

  const r = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome });

  assert.equal(r.code, 3);
  assert.match(r.stderr, /gmail/);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.equal(r.stderr.includes(SAMPLE_TOKEN), false);
});

test("a missing launch row exits 3 with a one-line message", async () => {
  const { home, msHome } = tempHome();
  const r = run(["_exec", "no-such-launch"], { HOME: home, MS_HOME: msHome });

  assert.equal(r.code, 3);
  assert.equal(r.stderr.trim().split("\n").length, 1);
});

test("a missing session row exits 3 naming the launch/session id, no token anywhere", async () => {
  const { home, msHome } = tempHome();
  await seedLaunch({ home, msHome, account: "gmail", skipSession: true });
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);

  const r = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome });

  assert.equal(r.code, 3);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.match(r.stderr, /L1/);
  assert.match(r.stderr, /s1/);
  assert.equal(r.stderr.includes(SAMPLE_TOKEN), false);
});

test("a CLI not found on PATH exits 3 naming the binary", async () => {
  const { home, msHome } = tempHome();
  await seedLaunch({ home, msHome });
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);

  const r = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome, PATH: "/nonexistent-empty-dir" });

  assert.equal(r.code, 3);
  assert.match(r.stderr, /claude/);
});

test("without process.execve, _exec exits 1 and never touches state or the CLI", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { execLaunch } = await import("../src/exec.ts");
  const original = process.execve;
  delete process.execve; // simulate a Node build without process.execve
  try {
    const code = await execLaunch(["whatever-id"]);
    assert.equal(code, 1);
  } finally {
    if (original) process.execve = original;
  }
});

// --- a codex launch ------------------------------------------------------
//
// A Codex account's ONE credential is the `auth.json` inside its own
// CODEX_HOME, so `_exec` hands the child a DIRECTORY, not a token: nothing
// secret is put in the environment at all, and the two variables that could
// make the CLI answer as somebody else are removed.

const CODEX_STUB = `echo "ARGS=$*"
echo "CODEX_HOME=$CODEX_HOME"
echo "CLAUDE_TOKEN=\${CLAUDE_CODE_OAUTH_TOKEN-<unset>}"
echo "OPENAI_API_KEY=\${OPENAI_API_KEY-<unset>}"
echo "MS_SESSION=$MS_SESSION"
echo "MS_ACCOUNT=$MS_ACCOUNT"
echo "FOO=$FOO"`;

const envOf = (stdout: string) =>
  Object.fromEntries(stdout.trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));

test("_exec for a codex launch points the CLI at the account's home, with no token", async () => {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  await seedLaunch({ home, msHome, account: "work", provider: "codex", command: ["codex", "--model", "gpt-5"], env: { FOO: "bar" } });
  stub("codex", CODEX_STUB);

  const r = run(["_exec", "L1"], {
    HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}`,
    // Both would otherwise be inherited straight into the CLI: one would make
    // codex bill an API key instead of the subscription this tool is choosing
    // between, the other is another provider's credential entirely.
    OPENAI_API_KEY: "sk-openai-should-not-survive",
    CLAUDE_CODE_OAUTH_TOKEN: SAMPLE_TOKEN,
  });

  assert.equal(r.code, 0, r.stderr);
  const lines = envOf(r.stdout);
  assert.equal(lines.CODEX_HOME, `${msHome}/codex/work`);
  assert.equal(lines.OPENAI_API_KEY, "<unset>");
  assert.equal(lines.CLAUDE_TOKEN, "<unset>");
  assert.equal(lines.ARGS, "--model gpt-5");
  assert.equal(lines.MS_SESSION, "s1");
  assert.equal(lines.MS_ACCOUNT, "work");
  assert.equal(lines.FOO, "bar");
  assert.equal(r.stdout.includes(SAMPLE_TOKEN), false);
});

test("a codex launch needs no launch token: the absence of one is not an error", async () => {
  // The claude path exits 3 here. A codex account never has one to read.
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  await seedLaunch({ home, msHome, account: "work", provider: "codex", command: ["codex"] });
  stub("codex", CODEX_STUB);

  const r = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}` });

  assert.equal(r.code, 0, r.stderr);
  assert.equal(envOf(r.stdout).CODEX_HOME, `${msHome}/codex/work`);
});

test("a codex launch.env cannot shadow CODEX_HOME or the MS_* identity", async () => {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  await seedLaunch({
    home, msHome, account: "work", provider: "codex", command: ["codex"],
    env: { CODEX_HOME: "/tmp/evil", OPENAI_API_KEY: "sk-evil", MS_ACCOUNT: "evil" },
  });
  stub("codex", CODEX_STUB);

  const r = run(["_exec", "L1"], { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}` });

  assert.equal(r.code, 0, r.stderr);
  const lines = envOf(r.stdout);
  assert.equal(lines.CODEX_HOME, `${msHome}/codex/work`);
  assert.equal(lines.OPENAI_API_KEY, "<unset>");
  assert.equal(lines.MS_ACCOUNT, "work");
});
