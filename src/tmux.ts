import { spawnSync } from "node:child_process";

export function shellQuote(args: string[]): string {
  return args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
}

export class Tmux {
  constructor(public socket: string | null) {}
  private base(): string[] { return this.socket ? ["-S", this.socket] : []; }
  run(args: string[], input = ""): { code: number; stdout: string; stderr: string } {
    const r = spawnSync("tmux", [...this.base(), ...args], { encoding: "utf8", input, timeout: 10_000 });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  private must(args: string[]): string {
    const r = this.run(args);
    if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim() || r.code}`);
    return r.stdout;
  }
  serverIdentity(): string { return this.must(["display-message", "-p", "#{pid}:#{start_time}"]).trim(); }
  paneExists(pane: string): boolean { return this.run(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.split("\n").includes(pane); }
  paneInfo(pane: string): { pid: number; command: string; dead: boolean; cwd: string } | null {
    const r = this.run(["display-message", "-p", "-t", pane, "#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{pane_current_path}"]);
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const [pid, command, dead, cwd] = r.stdout.trim().split("\t");
    return { pid: Number(pid), command, dead: dead === "1", cwd };
  }
  setPaneOption(pane: string, name: string, value: string): void { this.must(["set-option", "-p", "-t", pane, name, value]); }
  unsetPaneOption(pane: string, name: string): void { this.run(["set-option", "-pu", "-t", pane, name]); }
  paneOptions(pane: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of this.run(["show-options", "-p", "-t", pane]).stdout.split("\n")) {
      const i = line.indexOf(" "); if (i < 0) continue;
      out[line.slice(0, i)] = line.slice(i + 1).replace(/^"(.*)"$/, "$1");
    }
    return out;
  }
  remainOnExit(pane: string, on: boolean): void { this.must(["set-option", "-p", "-t", pane, "remain-on-exit", on ? "on" : "off"]); }
  capture(pane: string, lines = 200): string { return this.run(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", pane]).stdout; }
  respawn(pane: string, cwd: string, command: string[]): void { this.must(["respawn-pane", "-k", "-c", cwd, "-t", pane, shellQuote(command)]); }
  runShell(command: string[], opts: { delaySeconds?: number } = {}): void {
    const args = ["run-shell", "-b"]; if (opts.delaySeconds) args.push("-d", String(opts.delaySeconds));
    this.must([...args, shellQuote(command)]);
  }
  setPaneDiedHook(pane: string, command: string[]): void {
    this.must(["set-hook", "-p", "-t", pane, "pane-died", `run-shell -b ${shellQuote([shellQuote(command)])}`]);
  }
  sendKeys(pane: string, keys: string[]): void { this.must(["send-keys", "-t", pane, ...keys]); }
  newWindow(session: string, cwd: string, command: string[]): string {
    return this.must(["new-window", "-P", "-F", "#{pane_id}", "-t", session, "-c", cwd, shellQuote(command)]).trim();
  }
  hasSession(name: string): boolean { return this.run(["has-session", "-t", name]).code === 0; }
  newSession(name: string, cwd: string, command: string[]): string {
    return this.must(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "-c", cwd, shellQuote(command)]).trim();
  }
  attach(name: string): number {
    const r = spawnSync("tmux", [...this.base(), "attach-session", "-t", name], { stdio: "inherit" });
    return r.status ?? 1;
  }
}

export function tmuxFromEnv(): Tmux {
  const t = process.env.TMUX;
  return new Tmux(t ? t.split(",")[0] : null);
}
export function currentPane(): string | null { return process.env.TMUX_PANE || null; }
