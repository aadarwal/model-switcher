// src/dashboard.ts
//
// `ms dashboard [--port N] [--no-open]` (Plan 4, Task 2): a loopback web page
// over the same store and verbs `ms status`/`ms rotate`/`ms switch`/`ms stop`
// use. It prints its own URL exactly once, opens it (unless told not to —
// `startDashboard`'s own `open` gate, src/dashboard/server.ts), and then
// stays up for exactly as long as the page keeps polling it: `waitUntilIdle()`
// resolves the moment nobody has asked the server anything for `idleMs`, and
// this verb exits 0 the moment it does. Alive only while open.

import type { Verb } from "./cli.ts";
import { startDashboard } from "./dashboard/server.ts";

const USAGE = "usage: ms dashboard [--port N] [--no-open]";
const DEFAULT_IDLE_MS = 30_000;

/** Test-tunable the same way manual.ts's `settleMs()`/`lockWaitMs()` and
 *  status.ts's `MS_WATCH_MS` are — a real 30 s wait would make a CLI-level
 *  test of "the process exits once idle" unbearably slow. */
function idleMs(): number {
  return Number(process.env.MS_DASHBOARD_IDLE_MS) || DEFAULT_IDLE_MS;
}

type Parsed = { port: number; open: boolean } | { error: string };

function parseArgs(argv: string[]): Parsed {
  let port = 0;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-open") { open = false; continue; }
    if (a === "--port") {
      const raw = argv[++i];
      const n = raw !== undefined ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 65_535) return { error: "--port needs a port number" };
      port = n;
      continue;
    }
    return { error: `unexpected argument ${JSON.stringify(a)}` };
  }
  return { port, open };
}

export const dashboard: Verb = async (argv) => {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`ms dashboard: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }

  const dash = await startDashboard({ port: parsed.port, open: parsed.open, idleMs: idleMs() });
  // Exactly one line — the whole point is a human (or a script) can read the
  // URL off stderr and go, with nothing else to scroll past.
  process.stderr.write(`ms dashboard: ${dash.url}\n`);
  await dash.waitUntilIdle();
  dash.close();
  return 0;
};
