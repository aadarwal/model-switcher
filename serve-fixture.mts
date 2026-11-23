// Serves a repo's real dashboard page over fixture /api/state (no ms store).
// usage: tsx serve-fixture.ts <repo-dir> <port>
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, port] = [process.argv[2]!, Number(process.argv[3])];
const imp = (f: string) => import(pathToFileURL(path.join(repo, f)).href);
const { renderDashboardPage } = await imp("src/dashboard/page.ts");
const { poolSummaries } = await imp("src/pool-summary.ts");
const att = existsSync(path.join(repo, "src/attention.ts")) ? await imp("src/attention.ts") : null;
const now = Date.now();
const DAY = 86_400_000;
const oct = (d: number, h = 20) => new Date(2026, 9, d, h, 0).getTime();
const w = (p: number, resetsAt: number | null, secs = 604800) => ({ usedPercent: p, resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(), windowSeconds: secs });
type Row = Record<string, any>;
const rows: Row[] = [
  { name: "claude-1", email: "dirk@photonfoundries.com", state: "auth", error: "refresh rejected: invalid_grant", errorKind: "auth", observedAt: oct(16), usage: { session: null, weeklyAll: w(100, oct(17)), weeklyFable: w(100, oct(17)) } },
  { name: "claude-4", email: "mitdre-six@vvuq.ai", state: "no-grant", error: "no poll grant (run: ms accounts login claude-4)", errorKind: "auth", observedAt: oct(12), usage: { session: null, weeklyAll: w(100, oct(17)), weeklyFable: null } },
  { name: "claude-5", email: "julian@vvuq.ai", state: "no-token", error: null, errorKind: null, observedAt: oct(15), usage: { session: null, weeklyAll: w(97, oct(18)), weeklyFable: w(40, oct(18)) } },
  { name: "claude-11", email: "qpaig.gpt@gmail.com", state: "no-grant", error: "no poll grant", errorKind: "auth", observedAt: null, usage: null, identityVerified: false },
  { name: "mit-englund-max", email: "englund@mit.edu", state: "ok", error: null, errorKind: null, observedAt: now - 20_000, usage: { session: null, weeklyAll: w(38, now + 3 * DAY), weeklyFable: w(12, now + 3 * DAY) } },
  { name: "claude-9", email: "mit-dre-008@vvuq.ai", state: "stale", error: "502 from /api/oauth/usage", errorKind: null, observedAt: now - 9 * 3_600_000, usage: { session: null, weeklyAll: w(64, now + 2 * DAY), weeklyFable: null } },
].map((r) => ({ provider: "claude", shared: false, stale: r.state !== "ok", label: r.name, reservePercent: 0, sessions: [], identityVerified: true, ...r }));
rows.push({ name: "codex-1", provider: "codex", email: "dirk@vvuq.ai", state: "ok", error: null, errorKind: null, observedAt: now - 20_000, stale: false, shared: false, label: "codex-1", reservePercent: 0, sessions: [], identityVerified: true,
  usage: { session: w(22, now + 3 * 3_600_000, 18000), weeklyAll: w(51, now + 4 * DAY), weeklyFable: null, planType: "pro" } });
const accounts = rows.map(({ identityVerified, ...r }) => ({ ...r, ...(att ? { attention: att.accountAttention({ ...r, identityVerified }, now, att.staleAfterMs()) } : {}) }));
const state = { takenAt: now - 5_000, accounts, sessions: [], pools: poolSummaries(accounts, now) };
createServer((req, res) => {
  if (req.url === "/api/state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(state)); return; }
  if (req.url === "/api/calendar") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ events: [] })); return; }
  res.setHeader("content-type", "text/html; charset=utf-8"); res.end(renderDashboardPage());
}).listen(port, "127.0.0.1", () => console.log("listening", port));
