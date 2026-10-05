import { spawnSync } from "node:child_process";

export function shellQuote(args: string[]): string {
  return args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

/**
 * Which tmux server a launch or an import from this shell lands on — one rule,
 * asked by `ms claude`/`ms codex`, `ms import` and `ms attach` alike:
 *
 *   * inside tmux (`$TMUX`) — the server the human is standing in (`current`);
 *   * outside tmux — the DEFAULT server, the one plain `tmux`, `tmux ls` and
 *     `tmux attach` talk to. It need not be running: the first
 *     `new-session -d` starts it, as tmux always does;
 *   * `MS_TMUX_SOCKET=<path>`, outside tmux only — an explicit private server
 *     on that socket (`socket:<path>`). This was the default before 0.3.8
 *     (`MS_HOME/tmux.sock`); it is now only ever an override.
 */
export type ServerKind = "default" | "current" | `socket:${string}`;
export type ServerTarget = { server: ServerKind; socket: string | null };

export function targetServer(env: NodeJS.ProcessEnv = process.env): ServerTarget {
  const t = env.TMUX;
  if (t) return { server: "current", socket: t.split(",")[0]! };
  return outsideServer(env);
}

/** The server for a shell that is NOT in tmux (or a verb that ignores `$TMUX`,
 *  like `ms attach`): the override socket if one is set, else the default. */
export function outsideServer(env: NodeJS.ProcessEnv = process.env): ServerTarget {
  const o = env.MS_TMUX_SOCKET;
  return o ? { server: `socket:${o}`, socket: o } : { server: "default", socket: null };
}

/** A tmux client for one server target. The default server gets a client that
 *  never inherits `$TMUX`: tmux resolves a bare command through `$TMUX` first,
 *  so without that a `--plan` replayed from inside some other tmux would land
 *  on the wrong server. */
export function tmuxFor(t: ServerTarget): Tmux {
  return t.server === "default" ? Tmux.defaultServer() : new Tmux(t.socket);
}

/** One word a human can paste into a shell: bare when it is safe, else quoted. */
export function shellWord(w: string): string {
  return /^[\w.,:@%+=/-]+$/.test(w) ? w : shellQuote([w]);
}

/** `tmux ls` as the human should type it for one server. */
export function tmuxCommandFor(socket: string | null, rest: string): string {
  return socket ? `tmux -S ${shellWord(socket)} ${rest}` : `tmux ${rest}`;
}

export class Tmux {
  constructor(public socket: string | null, private readonly ignoreTmuxEnv = false) {}
  /** The default server — no `-S`, no `-L`, and no `$TMUX` inherited. */
  static defaultServer(): Tmux { return new Tmux(null, true); }
  private base(): string[] { return this.socket ? ["-S", this.socket] : []; }
  private env(): NodeJS.ProcessEnv | undefined {
    if (!this.ignoreTmuxEnv || this.socket || !process.env.TMUX) return undefined;
    const { TMUX: _drop, ...rest } = process.env;
    return rest;
  }
  run(args: string[], input = ""): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("tmux", [...this.base(), ...args], { encoding: "utf8", input, timeout: 10_000, env: this.env() });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  private must(args: string[]): string {
    const r = this.run(args);
    if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim() || r.code}`);
    return r.stdout;
  }
  /** The server's own socket path, read off the server itself — how a pane on
   *  the default server gets a socket recorded that stays right whatever
   *  `$TMUX`/`TMUX_TMPDIR` a later hook runs under. Null when tmux did not say. */
  socketPath(target: string): string | null {
    const r = this.run(["display-message", "-p", "-t", target, "#{socket_path}"]);
    const v = r.stdout.trim();
    return r.code === 0 && v ? v : null;
  }
  serverIdentity(): string { return this.must(["display-message", "-p", "#{pid}:#{start_time}"]).trim(); }
  /**
   * Is a server listening on this socket, and if so which one — as a THREE-way
   * answer, because "it is gone" and "I could not ask" are different facts and
   * only the first licenses anything (src/reconcile.ts, rule 2).
   *
   *   * `{ up: "<pid>:<start_time>" }` — the server answered and named itself;
   *   * `"gone"` — nothing is listening, so no pane recorded on this socket can
   *     still exist. tmux 3.x says so in two ways, both exit 1 (checked against
   *     tmux 3.7c): `no server running on <path>` for a socket FILE with no
   *     listener (the file a server leaves behind when it exits — the pre-0.3.8
   *     `MS_HOME/tmux.sock` that issue #21 found holding rows nobody could
   *     repair), and `error connecting to <path> (No such file or directory)`
   *     for a path with no socket at all. `Connection refused` is the same fact
   *     in errno's words, and is read the same way;
   *   * `"unreadable"` — everything else: a timeout (a hung server is still a
   *     server), `Permission denied`, a path that is not a socket, a tmux that is
   *     not on PATH, or a server that answered with nothing.
   *
   * The socket path itself is never stat'ed here: tmux's own answer is the
   * evidence, and it is the same answer `tmux -S <path> ls` gives the human.
   */
  serverState(): { up: string } | "gone" | "unreadable" {
    const r = this.run(["display-message", "-p", "#{pid}:#{start_time}"]);
    if (r.code === 0) {
      const id = r.stdout.trim();
      return id ? { up: id } : "unreadable";
    }
    if (r.code !== 1) return "unreadable"; // -1: timed out, or no tmux to run
    const err = r.stderr.trim();
    if (/^no server running on /m.test(err)) return "gone";
    if (/^error connecting to .*\((No such file or directory|Connection refused)\)$/m.test(err)) return "gone";
    return "unreadable";
  }
  paneExists(pane: string): boolean { return this.run(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.split("\n").includes(pane); }
  /**
   * One pane, one read. `deadStatus` rides along with `dead` on purpose: asked
   * separately, the two answers can come from two different moments, and a pane
   * that was respawned between them reports dead-with-no-status — which a
   * caller then has to read as "no evidence" and fall back on something weaker.
   * A live pane's status field is empty, which parses to null.
   */
  paneInfo(pane: string): { pid: number; command: string; dead: boolean; cwd: string; deadStatus: number | null } | null {
    const r = this.run(["display-message", "-p", "-t", pane, "#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{pane_current_path}\t#{pane_dead_status}"]);
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const [pid, command, dead, cwd, status] = r.stdout.trim().split("\t");
    const n = Number(status);
    return { pid: Number(pid), command, dead: dead === "1", cwd, deadStatus: status && Number.isInteger(n) ? n : null };
  }
  /**
   * `#{pane_dead}` for one pane: true when the pane's command has exited and
   * `remain-on-exit` is holding the corpse open, false when something is
   * running in it, and **null when tmux did not answer** — no server, no such
   * pane, a timeout, or a tmux that is not on PATH.
   *
   * The null is the point. A caller deciding whether to respawn over a pane
   * must be able to tell "it is dead" from "I could not ask"; collapsing the
   * two into a boolean is how a live pane gets killed.
   */
  paneDead(pane: string): boolean | null {
    const r = this.run(["display-message", "-p", "-t", pane, "#{pane_dead}"]);
    if (r.code !== 0) return null;
    const v = r.stdout.trim();
    return v === "1" ? true : v === "0" ? false : null;
  }
  /**
   * `#{pane_current_command}` — the program tmux sees running in one pane now.
   *
   * Null when there is no answer to read (no server, no such pane, a timeout,
   * a tmux that is not on PATH), and never the empty string: the same rule
   * `paneDead` follows, for the same reason. A caller watching a pane to see
   * whether its command has finished must be able to tell "it is at a shell"
   * from "I could not ask".
   */
  paneCurrentCommand(pane: string): string | null {
    const r = this.run(["display-message", "-p", "-t", pane, "#{pane_current_command}"]);
    if (r.code !== 0) return null;
    const v = r.stdout.trim();
    return v === "" ? null : v;
  }
  /**
   * `#{pane_dead_status}` — the exit status of the command whose corpse a dead
   * pane is holding. Null means "no number to read": tmux did not answer, or
   * the pane is alive and the field is empty. Only a number is evidence, and
   * only a NON-ZERO one says the thing that died did so by failing.
   *
   * A CLI that exits 1 a second after a respawn (`--resume` on an id with no
   * transcript, a credential the CLI refuses) still fires its own SessionEnd
   * hook on the way out, so the event log alone reads that crash as the human
   * typing `/exit`. This is the field that tells the two apart.
   */
  paneDeadStatus(pane: string): number | null {
    const r = this.run(["display-message", "-p", "-t", pane, "#{pane_dead_status}"]);
    if (r.code !== 0) return null;
    const v = r.stdout.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  }
  /**
   * `#{pane_in_mode}`: true while the pane is in copy-mode (or another mode),
   * when the human is scrolled back through it and what a capture shows is no
   * longer simply the CLI's own live screen. Null when tmux did not answer,
   * the same three-way rule `paneDead` follows.
   */
  paneInMode(pane: string): boolean | null {
    const r = this.run(["display-message", "-p", "-t", pane, "#{pane_in_mode}"]);
    if (r.code !== 0) return null;
    const v = r.stdout.trim();
    return v === "1" ? true : v === "0" ? false : null;
  }
  setPaneOption(pane: string, name: string, value: string): void { this.must(["set-option", "-p", "-t", pane, name, value]); }
  unsetPaneOption(pane: string, name: string): void { this.run(["set-option", "-pu", "-t", pane, name]); }
  paneOptions(pane: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of this.run(["show-options", "-p", "-t", pane]).stdout.split("\n")) {
      const i = line.indexOf(" "); if (i < 0) continue;
      const name = line.slice(0, i);
      let value = line.slice(i + 1);
      // tmux 3.7b quotes a value that needs it and backslash-escapes embedded
      // `"` and `\` (e.g. `"has \"quotes\" inside"`); unescape after stripping
      // the outer pair. An unquoted value is returned untouched.
      const m = value.match(/^"(.*)"$/);
      if (m) value = m[1].replace(/\\(["\\])/g, "$1");
      out[name] = value;
    }
    return out;
  }
  remainOnExit(pane: string, on: boolean): void { this.must(["set-option", "-p", "-t", pane, "remain-on-exit", on ? "on" : "off"]); }
  capture(pane: string, lines = 200): string { return this.run(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", pane]).stdout; }
  // respawn/newWindow/newSession pass shellQuote(command) as the single trailing argv element, always starting with `'`, so no `--` separator is needed.
  respawn(pane: string, cwd: string, command: string[]): void { this.must(["respawn-pane", "-k", "-c", cwd, "-t", pane, shellQuote(command)]); }
  runShell(command: string[], opts: { delaySeconds?: number } = {}): void {
    const args = ["run-shell", "-b"]; if (opts.delaySeconds) args.push("-d", String(opts.delaySeconds));
    this.must([...args, shellQuote(command)]);
  }
  setPaneDiedHook(pane: string, command: string[]): void {
    this.must(["set-hook", "-p", "-t", pane, "pane-died", `run-shell -b ${shellQuote([shellQuote(command)])}`]);
  }
  sendKeys(pane: string, keys: string[]): void { this.must(["send-keys", "-t", pane, ...keys]); }
  /**
   * A new window, and the id of the pane it was born with.
   *
   * `target` is a tmux target-window: a bare session name works, and
   * `"<session>:"` is the unambiguous spelling of "that session, next free
   * index" — worth using whenever the name is one we chose rather than one
   * tmux gave us, because a bare name is looked up as a WINDOW of the current
   * session first. `command` may be empty, which is how a pane is born
   * holding the human's own shell (`ms import` types into that shell).
   */
  newWindow(target: string, cwd: string, command: string[], name?: string): string {
    return this.must([
      "new-window", "-P", "-F", "#{pane_id}", "-t", target, "-c", cwd,
      ...(name ? ["-n", name] : []), ...(command.length ? [shellQuote(command)] : []),
    ]).trim();
  }
  hasSession(name: string): boolean { return this.run(["has-session", "-t", name]).code === 0; }
  newSession(name: string, cwd: string, command: string[], windowName?: string): string {
    return this.must([
      "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "-c", cwd,
      ...(windowName ? ["-n", windowName] : []), ...(command.length ? [shellQuote(command)] : []),
    ]).trim();
  }
  /** A new pane beside `target` (a `%id`), and its own id. */
  splitWindow(target: string, cwd: string, command: string[]): string {
    return this.must([
      "split-window", "-P", "-F", "#{pane_id}", "-t", target, "-c", cwd,
      ...(command.length ? [shellQuote(command)] : []),
    ]).trim();
  }
  selectLayout(target: string, layout: string): void { this.must(["select-layout", "-t", target, layout]); }
  /** Every session name on this server; empty when there is no server at all,
   *  which is not an error — it is a server nobody has started yet. */
  sessionNames(): string[] {
    const r = this.run(["list-sessions", "-F", "#{session_name}"]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  }
  // The one deliberately unbounded call: an interactive attach lives as long as the session.
  attach(name: string): number {
    const r = spawnSync("tmux", [...this.base(), "attach-session", "-t", name], { stdio: "inherit", env: this.env() });
    return r.status ?? 1;
  }
}

export function tmuxFromEnv(): Tmux {
  const t = process.env.TMUX;
  return new Tmux(t ? t.split(",")[0] : null);
}
export function currentPane(): string | null { return process.env.TMUX_PANE || null; }
