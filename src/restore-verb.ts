// `ms restore`: bring back the conversations that went down with a tmux server.
//
//   ms restore [--since <window>] [--server <identity>] [--continue]
//              [--tabs] [--dry-run] [--yes]
//
// The decision is `planRestore` (src/restore.ts), a pure function of the
// store. This file is the adapter around it, and the order is the one `ms
// import` taught: show the whole plan, ask ONCE, then act — and `--dry-run`
// stops after the showing, `--yes` is the only way past the asking when there
// is nobody to ask.
//
// Each conversation comes back through the ordinary launch (`launchWith`,
// src/launch.ts), so the account is chosen, the home prepared, the row written
// and the pane hooked exactly as a hand-typed `ms claude -- --resume <id>`
// would have it. Two things differ, both `LaunchExtras.place`: the pane is a
// new window in the tmux session the conversation sat in, under the window's
// old name and index, and nothing attaches. No conversation is sent a word
// unless `--continue` says so: a restore puts things back, it does not decide
// that twenty conversations should all start working again.

import * as readline from "node:readline/promises";
import { type Verb } from "./cli.ts";
import { parseSince } from "./import.ts";
import { launchWith, type LaunchExtras } from "./launch.ts";
import { msBinary } from "./paths.ts";
import { defaultActivity, defaultDirExists, launchArgv, planRestore, stamp, type RestoreItem, type RestorePlan } from "./restore.ts";
import { openState, type Provider, type SessionRow } from "./state.ts";
import { openTabs, tabsContext, type TabTarget } from "./tabs.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1; // a launch refused, or the named server is not on record
const EXIT_USAGE = 2;

const USAGE = `usage: ms restore [--since <window>] [--server <identity>] [--continue] [--tabs] [--dry-run] [--yes]
  --since <window>     only conversations whose last turn is this recent: 30m, 2h, 7d (the default) or all
  --server <identity>  restore the tmux server with this identity instead of the one lost most recently
  --continue           hand each restored conversation the continuation a rotation sends
  --tabs               afterwards, open a terminal tab per restored window (Ghostty 1.3+ on macOS)
  --dry-run            show what would be restored and stop
  --yes                do not ask`;

export type RestoreArgs = { since: string; server: string | null; continueAfter: boolean; tabs: boolean; dryRun: boolean; yes: boolean };

export function parseRestoreArgs(argv: string[]): RestoreArgs | { error: string } {
  const out: RestoreArgs = { since: "7d", server: null, continueAfter: false, tabs: false, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--continue") { out.continueAfter = true; continue; }
    if (a === "--tabs") { out.tabs = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--yes" || a === "-y") { out.yes = true; continue; }
    const valued = (["--since", "--server"] as const).find((f) => a === f || a.startsWith(`${f}=`));
    if (valued) {
      // `ms restore --since --yes` is a forgotten window, not one called `--yes`.
      const v = a.includes("=") ? a.slice(valued.length + 1) : argv[++i];
      if (!v || v.startsWith("-")) return { error: `${valued} needs a value` };
      if (valued === "--since") out.since = v; else out.server = v;
      continue;
    }
    return { error: `unexpected argument ${JSON.stringify(a)}` };
  }
  return out;
}

export interface RestoreIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Null when there is nobody to ask; the verb refuses rather than assume. */
  confirm: ((question: string) => Promise<boolean>) | null;
  now: () => number;
  rows: () => SessionRow[];
  plan: (rows: SessionRow[], opts: { server: string | null; sinceMs: number | null }) => RestorePlan;
  launch: (provider: Provider, argv: string[], extras: LaunchExtras) => Promise<number>;
  tabs: (targets: TabTarget[]) => number;
}

async function askOnce(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function readRows(): SessionRow[] {
  const st = openState();
  try { return st.listSessions(); } finally { st.close(); }
}

export function processRestoreIo(): RestoreIo {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    confirm: process.stdin.isTTY ? askOnce : null,
    now: () => Date.now(),
    rows: readRows,
    plan: (rows, o) => planRestore(rows, { ...o, activity: defaultActivity, dirExists: defaultDirExists }),
    launch: launchWith,
    tabs: (targets) => openTabs(targets, { msBin: msBinary(), shell: process.env.SHELL || "/bin/sh", ...tabsContext() }),
  };
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  return [headers, ...rows].map((cols) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n") + "\n";
}

/** Where an item's window goes, as tmux would write the target. */
const windowOf = (i: RestoreItem): string =>
  `${i.session}:${i.windowIndex ?? "+"}${i.windowName ? ` (${i.windowName})` : ""}`;

/** The plan as the human reads it: one row per conversation coming back, then
 *  one line per conversation that is not, with the reason. */
export function formatPlan(plan: RestorePlan): string {
  if (!plan.server) return "";
  const s = plan.server;
  const head = `tmux server ${s.identity} on ${s.socket || "the default socket"} went away ${stamp(s.lostAt * 1000)}, with ${s.rows} managed session${s.rows === 1 ? "" : "s"} on it\n`;
  const body = plan.items.length
    ? table(["PROVIDER", "CONVERSATION", "LAST TURN", "WINDOW", "DIRECTORY"], plan.items.map((i) => [
        i.provider, i.conversation, i.lastActivity === null ? "unknown" : stamp(i.lastActivity), windowOf(i), i.cwd,
      ]))
    : "";
  const skipped = plan.skipped.map((k) => `not restored: ${k.row.cliSessionId ?? `session ${k.row.id}`} (${k.row.cwd}): ${k.why}\n`).join("");
  const others = plan.servers.filter((o) => o.identity !== s.identity);
  const more = others.length
    ? `other lost servers on record: ${others.map((o) => `${o.identity} (${stamp(o.lostAt * 1000)}, ${o.rows} session${o.rows === 1 ? "" : "s"})`).join(", ")} — restore one with --server <identity>\n`
    : "";
  return head + body + skipped + more;
}

export async function runRestore(argv: string[], io: RestoreIo = processRestoreIo()): Promise<number> {
  const say = (msg: string, detail: string[] = []): void => io.err(`ms restore: ${msg}\n${detail.map((l) => `  ${l}\n`).join("")}`);
  const parsed = parseRestoreArgs(argv);
  if ("error" in parsed) { say(parsed.error); io.err(USAGE + "\n"); return EXIT_USAGE; }
  const since = parseSince(parsed.since, io.now());
  if ("error" in since) { say(since.error); io.err(USAGE + "\n"); return EXIT_USAGE; }

  const plan = io.plan(io.rows(), { server: parsed.server, sinceMs: since.ms });
  if (!plan.server) {
    if (parsed.server) {
      say(`no session was lost with a tmux server ${parsed.server}`, plan.servers.length
        ? [`the ones on record: ${plan.servers.map((s) => s.identity).join(", ")}`]
        : ["no session has been lost with its tmux server at all"]);
      return EXIT_FAILED;
    }
    say("nothing to restore: no session has been lost with its tmux server");
    return EXIT_OK;
  }
  io.out(formatPlan(plan));
  const n = plan.items.length;
  if (!n) { say("nothing to restore from that server", plan.skipped.length ? ["every conversation on it is accounted for above"] : []); return EXIT_OK; }
  if (parsed.dryRun) return EXIT_OK;

  if (!parsed.yes) {
    const question = `Bring back ${n} conversation${n === 1 ? "" : "s"}${parsed.continueAfter ? " and tell each to continue" : ""}? [y/N] `;
    if (!io.confirm) {
      say("stdin is not a terminal, so there is nobody to ask", ["re-run with --yes to say so out loud, or --dry-run to see the plan without launching anything"]);
      return EXIT_USAGE;
    }
    if (!(await io.confirm(question))) { say("nothing was launched"); return EXIT_OK; }
  }

  // One after another: a launch returns as soon as its pane is respawned, so
  // overlapping them would buy nothing. (The chooser ranks on usage, not on
  // how many sessions an account holds, so a large restore lands mostly on
  // the account with the most room; rebalance is what spreads it afterwards.)
  const failed: { item: RestoreItem; code: number }[] = [];
  const done: RestoreItem[] = [];
  for (const item of plan.items) {
    // A launch that THROWS (tmux refused, the store was busy) is one failed
    // conversation, not the end of the restore: left uncaught it would skip
    // every item after it, and — leaving no row — be first in line to do the
    // same on the next run.
    let code: number;
    try {
      code = await io.launch(item.provider, launchArgv(item, parsed.continueAfter), {
        resumeId: item.provider === "codex" ? item.conversation : null,
        place: { session: item.session, cwd: item.cwd, windowName: item.windowName, windowIndex: item.windowIndex },
      });
    } catch (e) {
      say(`${item.conversation}: ${e instanceof Error ? e.message : String(e)}`);
      code = EXIT_FAILED;
    }
    if (code === 0) done.push(item); else failed.push({ item, code });
  }
  // "Relaunched", not "back": the launch has respawned the pane, and whether
  // the CLI then resumed the conversation is what `ms status` goes on to show.
  say(`${done.length} of ${n} conversation${n === 1 ? "" : "s"} relaunched${failed.length ? "" : `; see how each came up with: ms status`}`);
  for (const f of failed) say(`${f.item.conversation} (${f.item.cwd}) was not launched (exit ${f.code}); its reason is above`);

  if (parsed.tabs && done.length) {
    // Where each one actually landed — an index that was taken moved it — is
    // on the row its launch just wrote.
    const now = io.rows();
    const targets: TabTarget[] = [];
    for (const item of done) {
      const row = now.filter((r) => r.provider === item.provider && r.cliSessionId === item.conversation && r.id !== item.row.id && r.state !== "stopped")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (row?.tmuxSession && row.windowIndex !== null && row.windowIndex !== undefined) targets.push({ session: row.tmuxSession, windowIndex: row.windowIndex });
    }
    if (targets.length < done.length) {
      const sessions = [...new Set(done.map((i) => i.session))];
      say(`could not tell which window ${done.length - targets.length} of them landed in; open every window with: ${sessions.map((x) => `ms attach --tabs ${x}`).join(" ; ")}`);
    }
    io.tabs(targets);
  }
  return failed.length ? EXIT_FAILED : EXIT_OK;
}

export const restoreVerb: Verb = (argv) => runRestore(argv);
