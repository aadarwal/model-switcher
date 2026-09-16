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
  *"#{pane_pid}"*) echo "777	2.1.272	0	/tmp/work" ;;
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
  assert.deepEqual(t.paneInfo("%5"), { pid: 777, command: "2.1.272", dead: false, cwd: "/tmp/work" });
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
