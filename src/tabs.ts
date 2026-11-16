// One terminal tab per tmux window.
//
// tmux keeps the sessions; what a dead server (or a closed terminal) also
// takes is the arrangement on screen — twenty tabs, each looking at its own
// window. This module puts that back: for each window, a tab running
// `ms attach --window <n> <session>`, which attaches through a session of its
// own in the target's GROUP (`Tmux.attachWindow`, src/tmux.ts) so tabs share
// the windows without sharing a current one, and closing a tab only detaches.
//
// Opening a tab is the terminal's business, and only a terminal that can be
// told to do it by a documented interface is driven: Ghostty 1.3+ on macOS,
// through its AppleScript dictionary (`new window`, `new tab in <window>`,
// each `with configuration` carrying a `command`). For anything else the
// commands are printed, one per window, and the human pastes them.

import { spawnSync } from "node:child_process";
import { shellQuote, shellWord, Tmux } from "./tmux.ts";

export type TabTarget = { session: string; windowIndex: number };

/** The command one tab runs, as argv. `socket` is the `MS_TMUX_SOCKET`
 *  override the windows are on, or null for the default server. */
export function tabArgv(msBin: string, target: TabTarget): string[] {
  return [msBin, "attach", "--window", String(target.windowIndex), target.session];
}

/** The same command as one line a human can paste, or a terminal can hand to
 *  `sh -c`. The override socket travels as the variable `ms attach` reads. */
export function tabCommand(msBin: string, target: TabTarget, socket: string | null): string {
  const words = tabArgv(msBin, target).map(shellWord).join(" ");
  return socket ? `MS_TMUX_SOCKET=${shellQuote([socket])} ${words}` : words;
}

export type Terminal = "ghostty";

/**
 * The terminal this process can open tabs in, or null.
 *
 * Outside tmux, Ghostty names itself in `TERM_PROGRAM`. Inside tmux every
 * variable is the tmux server's — it says where the SERVER was started, not
 * what is looking at it now — so the question is put to tmux: `clientTerm` is
 * the attached client's `$TERM`, which for Ghostty is `xterm-ghostty`.
 *
 * Null over ssh whatever either says: the terminal is on another machine, and
 * a tab opened here would open on a screen nobody is at. macOS only: the
 * scripting dictionary is the macOS app's.
 */
export function detectTerminal(env: NodeJS.ProcessEnv, platform: string, clientTerm: string | null): Terminal | null {
  if (platform !== "darwin" || env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (env.TMUX) return clientTerm !== null && clientTerm.includes("ghostty") ? "ghostty" : null;
  return env.TERM_PROGRAM === "ghostty" ? "ghostty" : null;
}

/**
 * What a tab needs to know about where it is being opened from: the terminal,
 * and the socket `ms attach` must be told when the windows are not on the
 * server it would find by itself (`MS_TMUX_SOCKET`, or — inside tmux — a
 * server that is not the default one).
 */
export function tabsContext(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): { socket: string | null; terminal: Terminal | null } {
  const here = env.TMUX ? env.TMUX.split(",")[0]! : null;
  if (!here) return { socket: env.MS_TMUX_SOCKET || null, terminal: detectTerminal(env, platform, null) };
  return {
    socket: Tmux.defaultServer().ownSocketPath() === here ? null : here,
    terminal: detectTerminal(env, platform, new Tmux(here).clientTermname()),
  };
}

/**
 * A tab's command as Ghostty is given it: run by the human's login shell.
 * Ghostty starts a surface's `command` without their profile, so `tmux` and
 * `node` are found only if the shell that knows where they are is asked.
 */
export function ghosttyCommand(line: string, shell: string): string {
  return `${shellWord(shell)} -lc ${shellQuote([line])}`;
}

/** A string as an AppleScript literal. */
const appleString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The AppleScript that opens one NEW Ghostty window holding a tab per command,
 * in order. A new window, never the front one: the tabs are a set, and the
 * window the human is typing in is not ours to fill.
 */
export function ghosttyScript(commands: string[]): string {
  const lines = ['tell application "Ghostty"', "  activate", "  set cfg to new surface configuration"];
  commands.forEach((command, i) => {
    lines.push(`  set command of cfg to ${appleString(command)}`);
    lines.push(i === 0 ? "  set w to new window with configuration cfg" : "  new tab in w with configuration cfg");
  });
  lines.push("end tell");
  return lines.join("\n");
}

export type TabsIo = {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Run one AppleScript; `ok` false with tmux-style `why` when it failed. */
  osascript: (script: string) => { ok: boolean; why: string };
};

export function processTabsIo(): TabsIo {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    osascript: (script) => {
      const r = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 60_000 });
      return { ok: r.status === 0, why: (r.stderr ?? "").trim() || (r.error ? r.error.message : `exit ${r.status}`) };
    },
  };
}

/**
 * Open a tab per target, or say how to.
 *
 * Returns the number of tabs opened: `targets.length` when the terminal did
 * it, 0 when the commands were printed instead — an unscriptable terminal, or
 * a scriptable one that refused (an older Ghostty with no dictionary, macOS
 * declining to let this process script it). Printing is the answer in every
 * such case and never a failure: the sessions are up either way, and the
 * lines are what the human needs next.
 */
export function openTabs(
  targets: TabTarget[],
  opts: { msBin: string; socket: string | null; terminal: Terminal | null; shell: string },
  io: TabsIo = processTabsIo(),
): number {
  if (!targets.length) return 0;
  const commands = targets.map((t) => tabCommand(opts.msBin, t, opts.socket));
  if (opts.terminal === "ghostty") {
    const r = io.osascript(ghosttyScript(commands.map((c) => ghosttyCommand(c, opts.shell))));
    if (r.ok) {
      io.err(`ms: opened ${targets.length} Ghostty tab${targets.length === 1 ? "" : "s"}, one per window\n`);
      return targets.length;
    }
    io.err(`ms: Ghostty would not open the tabs (${r.why}); it needs Ghostty 1.3 or later and permission to be scripted\n`);
  } else {
    io.err("ms: this terminal cannot be told to open tabs (Ghostty 1.3+ on macOS can)\n");
  }
  io.err("ms: run one of these in each tab you open:\n");
  for (const c of commands) io.out(`${c}\n`);
  return 0;
}
