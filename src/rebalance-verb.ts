// src/rebalance-verb.ts
//
// `ms rebalance [--dry-run] [--session <id>]` — the rule (src/rebalance.ts),
// asked on purpose instead of waited for.
//
// The automatic half only ever runs at a turn end, at most one session per
// hook run, behind a gate (`MS_REBALANCE=0` disables it). This is the verb a human uses to
// see the whole fleet's answer at once and, without `--dry-run`, to act on
// it. It is the same decision function, over the same snapshot, so the table
// it prints is not a second opinion — `ms status`'s BETTER column, the
// dashboard's chip and this table are one rule seen three ways.
//
// Two things differ from the hook, both because a person is asking:
//
//   * the SIX-HOUR cooldown is waived (`lastMoveAt: null`). That guard exists
//     so the rule cannot thrash a session on its own; a human who types the
//     verb has already decided. The THIRTY-MINUTE wall guard is not waived —
//     a session that just rotated off a wall is mid-settle, and moving it
//     again is how a rotation gets second-guessed into a loop;
//   * the GATE is not consulted. `kv rebalance` gates what happens WITHOUT
//     anybody asking; running this verb is the asking. (`ms doctor` still
//     prints the gate's state, and it still governs every automatic move.)
//
// Nothing else is softened. The pane is re-read here and re-read again inside
// the transaction, so a session that is mid-turn is never moved; the
// transaction is `switchOne` with no continuation and no force, exactly what
// the hook's worker dispatches.

import type { Verb } from "./cli.ts";
import { appendEvent } from "./events.ts";
import { switchOne } from "./manual.ts";
import { decide, lastWallAtMs, readPane, type Decision, type Switcher } from "./rebalance.ts";
import { DEFAULT_MAX_AGE_MS, getSnapshot, toPickInputs } from "./snapshot.ts";
import { openState, type SessionRow } from "./state.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const DASH = "—"; // matches status.ts's own DASH exactly
const USAGE = "usage: ms rebalance [--dry-run] [--session <id>]";

/**
 * The states a session has to be in for this question to mean anything.
 *
 * `running` and `continuing` are the two that describe a live conversation
 * somebody is spending budget on. Everything else is either not started
 * (`launching`, `resuming`), already somebody else's problem (`walled`,
 * `parked`, `waiting`), or over (`stopping`, `stopped`) — and `decide` would
 * refuse most of them anyway. They are skipped BY NAME rather than silently
 * dropped: a human who asks about the fleet and gets four rows for six
 * sessions is owed the other two.
 */
const LIVE_STATES: ReadonlySet<string> = new Set(["running", "continuing"]);

/** One line of the table. `outcome` is the only cell that differs between a
 *  dry run and a real one. */
export type RebalanceRow = { session: string; account: string; better: string | null; reason: string; outcome: string };
/** A session the rule was not asked about, and why not. */
export type RebalanceSkip = { session: string; why: string };
export type RebalanceReport = { rows: RebalanceRow[]; skipped: RebalanceSkip[]; failed: number };

export type FleetOptions = {
  /** Decide and print; move nothing. */
  dryRun?: boolean;
  /** One session instead of the fleet. */
  session?: string | null;
  /** The switch transaction, injectable so a test can prove WHAT this verb
   *  asks for without running a handoff (test/manual.test.ts already proves
   *  what `switchOne` does with it). */
  switcher?: Switcher;
  /** The clock, in milliseconds. */
  now?: () => number;
};

/** The word a dry run puts in the OUTCOME cell. Exported because the
 *  dashboard page reads it back off the wire to decide whether its control
 *  has anything to arm (`rebalanceWouldMove`, src/dashboard/client-logic.ts)
 *  — one string, named once, pinned by test/dashboard-client.test.ts. */
export const WOULD_MOVE = "would move";

const OUTCOME = { would: WOULD_MOVE, moved: "moved", none: DASH } as const;

/**
 * The whole verb, minus the printing and the exit code — so `/api/rebalance`
 * (src/dashboard/api.ts) runs the identical thing the command line does
 * rather than a second implementation of it.
 *
 * The order matters: every decision is taken FIRST, from one snapshot, and
 * only then are the moves run, one at a time. Deciding row-by-row while
 * moving would judge later sessions against a pool the earlier moves had
 * already changed — on a reading that is, by construction, no longer the one
 * the human saw.
 */
export async function rebalanceFleet(opts: FleetOptions = {}): Promise<RebalanceReport> {
  const dryRun = opts.dryRun === true;
  const now = (opts.now ?? Date.now)();
  const switcher: Switcher = opts.switcher ?? ((id, to, o) => switchOne(id, to, o));
  const accounts = toPickInputs(await getSnapshot({ maxAgeMs: DEFAULT_MAX_AGE_MS }));

  const skipped: RebalanceSkip[] = [];
  const plan: { row: SessionRow; decision: Decision }[] = [];
  const st = openState();
  try {
    let candidates = st.listSessions();
    if (opts.session) {
      const one = candidates.find((s) => s.id === opts.session);
      if (!one) return { rows: [], skipped: [{ session: opts.session, why: "no such session" }], failed: 1 };
      candidates = [one];
    }
    for (const row of candidates) {
      if (!LIVE_STATES.has(row.state)) {
        skipped.push({ session: row.id, why: `the session is ${row.state}` });
        continue;
      }
      plan.push({
        row,
        decision: decide({
          session: row,
          accounts,
          now,
          // Waived: see this file's header. The wall guard below is not.
          lastMoveAt: null,
          lastWallAt: lastWallAtMs(row.id),
          gate: true,
          pane: readPane(row.socket, row.pane),
        }),
      });
    }
  } finally {
    // Closed BEFORE any move: the transaction takes the session's own lock
    // and opens its own store, and a connection held open across it is a
    // writer queueing behind a handoff for no reason.
    st.close();
  }

  const rows: RebalanceRow[] = [];
  let failed = 0;
  for (const { row, decision } of plan) {
    const base = { session: row.id, account: row.account, better: decision.better, reason: decision.reason };
    if (!decision.move) {
      rows.push({ ...base, outcome: OUTCOME.none });
      continue;
    }
    if (dryRun) {
      rows.push({ ...base, outcome: OUTCOME.would });
      continue;
    }
    const r = await switcher(row.id, decision.to, { continueAfter: false, force: false });
    if (r.code === 0) {
      try {
        appendEvent({
          t: Math.floor(now / 1000), kind: "rebalance", session: row.id, generation: row.generation,
          cliSessionId: row.cliSessionId, kindDetail: decision.reason, from: row.account, to: decision.to,
        });
      } catch { /* the move happened; a lost log line is not worth failing it */ }
      rows.push({ ...base, outcome: OUTCOME.moved });
    } else {
      failed++;
      rows.push({ ...base, outcome: `failed: ${r.message}` });
    }
  }
  return { rows, skipped, failed };
}

// --- The command line -----------------------------------------------------

type Args = { dryRun: boolean; session: string | null } | { error: string };

export function parseRebalanceArgs(argv: string[]): Args {
  let dryRun = false;
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") { dryRun = true; continue; }
    if (a === "--session" || a.startsWith("--session=")) {
      const joined = a.startsWith("--session=");
      const v = joined ? a.slice("--session=".length) : argv[i + 1];
      // `ms rebalance --session --dry-run` is a forgotten id, not a session
      // called "--dry-run": swallowing the next flag would ask about a
      // session nobody named and report "no such session" for a typo.
      if (!v || (!joined && v.startsWith("-"))) return { error: "--session needs a session id" };
      if (!joined) i++;
      session = v;
      continue;
    }
    return { error: `unexpected argument ${JSON.stringify(a)}` };
  }
  return { dryRun, session };
}

/** The same two-space column rule `ms status` uses, so the two tables read
 *  as one tool. */
function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cols: string[]) => cols.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function renderRebalance(report: RebalanceReport): string {
  const lines = table(
    ["SESSION", "ACCOUNT", "BETTER", "REASON", "OUTCOME"],
    report.rows.map((r) => [r.session, r.account, r.better ?? DASH, r.reason, r.outcome]),
  );
  // Named, not counted: "skipped 2" tells a human nothing they can act on.
  for (const s of report.skipped) lines.push(`skipped ${s.session}: ${s.why}`);
  return lines.join("\n") + "\n";
}

export const rebalanceVerb: Verb = async (argv) => {
  const parsed = parseRebalanceArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`ms rebalance: ${parsed.error}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const report = await rebalanceFleet({ dryRun: parsed.dryRun, session: parsed.session });
  process.stdout.write(renderRebalance(report));
  return report.failed ? EXIT_FAILED : EXIT_OK;
};
