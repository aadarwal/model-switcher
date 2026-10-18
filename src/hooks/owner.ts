import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Provider } from "../state.ts";
import { Tmux } from "../tmux.ts";

type Process = { parent: number; command: string };
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);
const RUNTIMES = new Set(["node", "nodejs", "bun"]);

/** A hook may have shell wrappers, but never another conversation between
 * it and the launched CLI. Merely finding the launch somewhere in the tree
 * would accept every headless child that inherited its MS_* environment.
 *
 * Codex's npm launcher is the one exception: its Node process stays alive
 * while its direct native `codex` child runs the conversation. A native
 * launch has no such exception, nor does a second nested npm launcher. */
export function ownsHook(provider: Provider, owner: number, parent: number, processes: Map<number, Process>): boolean {
  if (!Number.isSafeInteger(owner) || owner <= 1) return false;
  const seen = new Set<number>();
  for (let pid = parent; pid > 1 && !seen.has(pid);) {
    if (pid === owner) return true;
    seen.add(pid);
    const proc = processes.get(pid);
    if (!proc) return false;
    const command = path.basename(proc.command).replace(/^-/, "");
    if (SHELLS.has(command)) { pid = proc.parent; continue; }
    const root = processes.get(owner);
    return provider === "codex" && command === "codex" && proc.parent === owner
      && !!root && RUNTIMES.has(path.basename(root.command));
  }
  return false;
}

/** Only process names are read, never argv (which can contain prompts or
 * credentials). One bounded snapshot avoids asking `ps` once per ancestor. */
function processes(): Map<number, Process> {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], {
    encoding: "utf8", timeout: 1_000, maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "ignore"],
  });
  const out = new Map<number, Process>();
  if (result.status !== 0) return out;
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) out.set(Number(match[1]), { parent: Number(match[2]), command: match[3] });
  }
  return out;
}

/** Called before every hook effect, including event logging and gate writes.
 * `execve` preserves `_exec`'s PID. Its pin is inherited by descendants too,
 * so it must be compared with the hook's actual process ancestry.
 *
 * Existing panes from before the pin was introduced use tmux's pane PID.
 * Check the recorded server identity too: `%7` on a restarted server is a
 * different pane and must never vouch for an old row. */
export async function hookOwnedByLaunch(provider: Provider, session: string, gen: number, socket: string, pane: string): Promise<boolean> {
  let owner: number;
  const pin = process.env.MS_CLI_PID;
  if (pin !== undefined) {
    if (process.env.MS_CLI_PROVIDER !== provider || !/^\d+$/.test(pin)) return false;
    owner = Number(pin);
  } else {
    const { openState } = await import("../state.ts");
    const st = openState();
    try {
      const row = st.getSession(session);
      if (!row || row.provider !== provider || row.generation !== gen || row.socket !== socket || row.pane !== pane || !row.serverStart) return false;
      const answer = new Tmux(socket).run(["display-message", "-p", "-t", pane, "#{pane_pid}\t#{pid}:#{start_time}"]);
      const [pid, identity] = answer.stdout.trim().split("\t");
      if (answer.code !== 0 || identity !== row.serverStart || !/^\d+$/.test(pid ?? "")) return false;
      owner = Number(pid);
    } finally { st.close(); }
  }
  if (!Number.isSafeInteger(owner) || owner <= 1) return false;
  if (process.ppid === owner) return true;
  return ownsHook(provider, owner, process.ppid, processes());
}
