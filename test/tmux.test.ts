import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

function setup() {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(home, "tmux.log");
  stub("tmux", `printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *"#{pid}:#{start_time}"*) echo "4242:1789000000" ;;
  *"#{pane_pid}"*) echo "777	2.1.272	0	/tmp/work	$MS_TMUX_DEAD_STATUS" ;;
  *"#{pane_dead_status}"*) printf '%s\\n' "$MS_TMUX_DEAD_STATUS" ;;
  *"#{pane_dead}"*) printf '%s\\n' "$MS_TMUX_DEAD" ;;
  *"show-options -p"*) printf '%s\\n' '@ms_session s1' '@ms_generation 3' '@ms_note "has \\"quotes\\" inside"' '@ms_path "/tmp/a b"' '@ms_bs "x\\\\"' ;;
  *capture-pane*) printf 'line one\\nline two\\n' ;;
  *"list-panes"*) echo "%5" ;;
esac
exit 0`);
  process.env.HOME = home; process.env.MS_HOME = msHome; process.env.PATH = `${dir}:${process.env.PATH}`;
  return { log };
}

test("every call carries -S when a socket is set; respawn and run-shell quote safely", async () => {
  const { log } = setup();
  const { Tmux, shellQuote } = await import("../src/tmux.ts");
  const t = new Tmux("/private/tmp/tmux-501/default");
  assert.equal(t.serverIdentity(), "4242:1789000000");
  t.respawn("%5", "/tmp/w d", ["ms", "_exec", "L1"]);
  t.runShell(["ms", "_recover", "s1"], { delaySeconds: 30 });
  t.setPaneDiedHook("%5", ["ms", "_pane_died", "s1"]);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("-S /private/tmp/tmux-501/default ")));
  // -c's value is a plain start-directory (man tmux: "-c specifies a new working
  // directory for the pane"), never shell-parsed — unlike shell-command, which tmux
  // hands to sh -c. respawn() is exec'd directly (spawnSync, no shell), so quoting
  // cwd here would inject literal quote characters into the real working directory.
  // Only the trailing shell-command is shellQuote()'d into one argv element.
  assert.ok(lines.some((l) => l.includes("respawn-pane -k -c /tmp/w d -t %5 'ms' '_exec' 'L1'")));
  assert.ok(lines.some((l) => l.includes("run-shell -b -d 30 'ms' '_recover' 's1'")));
  assert.ok(lines.some((l) => l.includes("set-hook -p -t %5 pane-died")));
  assert.equal(shellQuote(["a b", "it's"]), "'a b' 'it'\\''s'");
});

test("paneInfo and paneOptions parse the stub's answers", async () => {
  setup();
  const { Tmux } = await import("../src/tmux.ts");
  const t = new Tmux(null);
  // A LIVE pane's `#{pane_dead_status}` is empty, and it rides along with the
  // rest rather than costing a second round-trip.
  delete process.env.MS_TMUX_DEAD_STATUS;
  assert.deepEqual(t.paneInfo("%5"), { pid: 777, command: "2.1.272", dead: false, cwd: "/tmp/work", deadStatus: null });
  process.env.MS_TMUX_DEAD_STATUS = "1";
  assert.equal(t.paneInfo("%5")!.deadStatus, 1, "one read answers both questions");
  delete process.env.MS_TMUX_DEAD_STATUS;
  assert.deepEqual(t.paneOptions("%5"), {
    "@ms_session": "s1",
    "@ms_generation": "3",
    "@ms_note": 'has "quotes" inside',
    "@ms_path": "/tmp/a b",
    "@ms_bs": "x\\",
  });
  assert.equal(t.capture("%5"), "line one\nline two\n");
});

test("tmuxFromEnv reads the socket from $TMUX", async () => {
  setup();
  process.env.TMUX = "/private/tmp/tmux-501/default,123,0";
  const { tmuxFromEnv } = await import("../src/tmux.ts");
  assert.equal(tmuxFromEnv().socket, "/private/tmp/tmux-501/default");
  delete process.env.TMUX;
  assert.equal(tmuxFromEnv().socket, null);
});

test("paneDead answers 1/0, and null when tmux could not say", async () => {
  setup();
  const { Tmux } = await import("../src/tmux.ts");
  const t = new Tmux(null);
  // The stub's display-message answers the pane_dead query from $MS_TMUX_DEAD.
  process.env.MS_TMUX_DEAD = "1";
  assert.equal(t.paneDead("%5"), true);
  process.env.MS_TMUX_DEAD = "0";
  assert.equal(t.paneDead("%5"), false);
  // An answer tmux did not give (no such pane, no server, a timeout) is not
  // "alive" and not "dead" — it is "we could not ask", and callers that would
  // kill or respawn on the strength of it must be able to tell.
  process.env.MS_TMUX_DEAD = "";
  assert.equal(t.paneDead("%5"), null);
  process.env.MS_TMUX_DEAD = "boom";
  assert.equal(t.paneDead("%5"), null);
  delete process.env.MS_TMUX_DEAD;
});

test("paneDeadStatus answers the exit status, and null when there is none to read", async () => {
  setup();
  const { Tmux } = await import("../src/tmux.ts");
  const t = new Tmux(null);
  process.env.MS_TMUX_DEAD_STATUS = "1";
  assert.equal(t.paneDeadStatus("%5"), 1);
  process.env.MS_TMUX_DEAD_STATUS = "0";
  assert.equal(t.paneDeadStatus("%5"), 0, "zero is an answer: whatever died did so cleanly");
  // A LIVE pane's field is empty, and so is the answer of a tmux that could not
  // be asked. Neither is evidence about how anything exited, and a caller that
  // parks a session on the strength of it must be able to tell.
  process.env.MS_TMUX_DEAD_STATUS = "";
  assert.equal(t.paneDeadStatus("%5"), null);
  process.env.MS_TMUX_DEAD_STATUS = "boom";
  assert.equal(t.paneDeadStatus("%5"), null);
  delete process.env.MS_TMUX_DEAD_STATUS;
});

// Issue #21: "the server has gone" and "I could not ask" are different facts,
// and only the first licenses reconciliation to stop a row. The messages are
// tmux 3.7c's own, read off a real `tmux -S`.
test("serverState tells a server that has gone apart from one it could not read", async () => {
  const { dir, stub } = stubDir();
  stub("tmux", `if [ -n "$MS_TMUX_ERR" ]; then printf '%s\\n' "$MS_TMUX_ERR" >&2; exit "\${MS_TMUX_RC:-1}"; fi
printf '%s\\n' "$MS_TMUX_OUT"
exit 0`);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const { Tmux } = await import("../src/tmux.ts");
  const t = new Tmux("/tmp/ms-old/tmux.sock");
  const ask = (err: string, out = "", rc = "1") => {
    process.env.MS_TMUX_ERR = err; process.env.MS_TMUX_OUT = out; process.env.MS_TMUX_RC = rc;
    try { return t.serverState(); } finally { delete process.env.MS_TMUX_ERR; delete process.env.MS_TMUX_OUT; delete process.env.MS_TMUX_RC; }
  };
  assert.deepEqual(ask("", "4242:1789000000"), { up: "4242:1789000000" });
  assert.equal(ask("", ""), "unreadable", "a server that answers with nothing has not named itself");
  // Gone: a socket file nobody listens on, a path with no socket, a refused connect.
  assert.equal(ask("no server running on /tmp/ms-old/tmux.sock"), "gone");
  assert.equal(ask("error connecting to /tmp/ms-old/tmux.sock (No such file or directory)"), "gone");
  assert.equal(ask("error connecting to /tmp/ms-old/tmux.sock (Connection refused)"), "gone");
  // Not gone: a socket we may not open, a path that is not a socket, any other
  // failure, and a failure that is not tmux's exit 1 (a kill, a timeout).
  assert.equal(ask("error connecting to /tmp/ms-old/tmux.sock (Permission denied)"), "unreadable");
  assert.equal(ask("error connecting to /tmp/ms-old/tmux.sock (Socket operation on non-socket)"), "unreadable");
  assert.equal(ask("lost server"), "unreadable");
  assert.equal(ask("no server running on /tmp/ms-old/tmux.sock", "", "2"), "unreadable");
});

test("serverState is unreadable, never gone, when there is no tmux to ask", async () => {
  const { dir } = stubDir();
  const saved = process.env.PATH;
  process.env.PATH = dir; // an empty directory: no tmux anywhere
  try {
    const { Tmux } = await import("../src/tmux.ts");
    assert.equal(new Tmux("/tmp/ms-old/tmux.sock").serverState(), "unreadable");
  } finally {
    process.env.PATH = saved;
  }
});
