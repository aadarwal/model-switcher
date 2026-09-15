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
}) {
  const account = opts.account ?? "gmail";
  process.env.HOME = opts.home; process.env.MS_HOME = opts.msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  st.createSession({ id: "s1", ...SESSION_BASE, account, generation: opts.generation ?? 2 });
  st.createLaunch({
    id: "L1", sessionId: "s1", generation: opts.generation ?? 2, account,
    command: ["claude", "--resume", "c-1", "hello"], env: opts.env ?? {}, createdAt: Math.floor(Date.now() / 1000),
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
  // the credential lives only in the environment, never in argv
  assert.equal(lines.ARGV0.includes(SAMPLE_TOKEN), false);
  assert.equal(lines.ARGS.includes(SAMPLE_TOKEN), false);
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
