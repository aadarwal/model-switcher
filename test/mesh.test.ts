// The account mesh picker (src/mesh.ts): `ms claude mesh` / `ms codex mesh`.
//
// Three layers, each proved on its own:
//
//   * the pure ones — the rows (order, marks, columns), one row's text, the
//     preview, fzf's command line — over hand-built snapshots, no store;
//   * the chooser, end to end against a stub `fzf` on PATH (and against no
//     fzf at all, for the numbered menu), over a throwaway MS_HOME whose
//     snapshot file is fresh, so nothing here touches the network;
//   * `ms _mesh_rows`, ctrl-r's reload, in-process with an injected reading,
//     and through the real CLI for the refusals and for the one thing only a
//     real process group can show: fzf killing a reload mid-refresh.
//
// No test opens /dev/tty: the chooser is handed a "terminal" that is a file.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, stubDir, tempHome } from "./helpers.ts";
import { FZF_STUB } from "./fixtures/fzf-stub.ts";
import {
  chooseAccount,
  clean,
  fzfArgs,
  fzfInput,
  meshDirProblem,
  meshHeader,
  meshRows,
  meshRowsVerb,
  parseFzfVersion,
  renderPreview,
  selectedKey,
  renderRow,
  renderRows,
  rowWidths,
  writeMeshDir,
  type MeshRowsDeps,
  type MeshView,
  type Ready,
} from "../src/mesh.ts";
import type { AccountUsage, Snapshot } from "../src/snapshot.ts";
import type { Account, Provider, Registry } from "../src/registry.ts";
import { saveLaunchToken } from "../src/launch-credentials.ts";

const HOUR = 3_600_000;
const ORIGINAL_PATH = process.env.PATH ?? "";
/** Readings are stamped with the REAL clock: `toPickInputs` retires anything
 *  older than ten minutes against `Date.now()`, not against an injected one. */
const now = () => Date.now();
const inHours = (h: number | null): string | null => (h === null ? null : new Date(now() + h * HOUR).toISOString());
const ESC = "\x1b";
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

type W = { used: number; resetIn: number | null } | null;
const win = (w: W) => (w ? { usedPercent: w.used, resetsAt: inHours(w.resetIn) } : null);

/** One snapshot row. Defaults: a fresh, error-free reading with plenty of room. */
function reading(name: string, o: {
  provider?: Provider; session?: W; weekly?: W; fable?: W; error?: string; errorKind?: AccountUsage["errorKind"];
  noUsage?: boolean; stale?: boolean; observedAt?: number | null;
} = {}): AccountUsage {
  return {
    name,
    provider: o.provider ?? "claude",
    shared: false,
    usage: o.noUsage ? null : {
      session: win(o.session === undefined ? { used: 10, resetIn: 3 } : o.session),
      weeklyAll: win(o.weekly === undefined ? { used: 20, resetIn: 72 } : o.weekly),
      weeklyFable: win(o.fable === undefined ? (o.provider === "codex" ? null : { used: 20, resetIn: 72 }) : o.fable),
    },
    error: o.error ?? null,
    errorKind: o.errorKind ?? null,
    observedAt: o.observedAt === undefined ? now() : o.observedAt,
    stale: o.stale ?? false,
  };
}

const account = (name: string, o: Partial<Account> = {}): Account => ({
  name, provider: "claude", label: name, orgId: null, shared: false, identityVerified: true, ...o,
});

/**
 * The pool every pure test reads, listed in the registry in REVERSE of how it
 * should display — so a row's key (its place in the registry) and its place
 * on screen are provably two different things:
 *
 *   bravo    the chooser's pick: the soonest weekly reset           → ★
 *   alpha    room, a later reset                                    → second
 *   delta    room and a reading, but no credential on this device   → ✗, ranked
 *   charlie  a weekly window at 100                                 → ✗, out
 *   echo     a transient failure and no reading at all              → ✗, out
 */
function pool(): { registry: Registry; snapshot: Snapshot; names: string[]; ready: Ready } {
  const registry: Registry = {
    version: 1,
    accounts: [
      account("echo"),
      account("delta"),
      account("charlie"),
      account("bravo", { label: "Bravo at work", email: "bravo@example.com" }),
      account("alpha", { label: "Alpha" }),
    ],
  };
  const snapshot: Snapshot = {
    takenAt: now() - 14_000,
    registryError: null,
    accounts: [
      reading("echo", { noUsage: true, error: "fetch failed", errorKind: "transient", observedAt: null, stale: true }),
      reading("delta", { weekly: { used: 40, resetIn: 96 } }),
      reading("charlie", { weekly: { used: 100, resetIn: 30 } }),
      reading("bravo", { session: { used: 95, resetIn: 2 }, weekly: { used: 75, resetIn: 24 } }),
      reading("alpha", { weekly: { used: 20, resetIn: 72 } }),
    ],
  };
  const ready: Ready = (name) => (name === "delta" ? { error: `no launch token for account '${name}' (run: ms accounts login ${name})` } : null);
  return { registry, snapshot, names: registry.accounts.map((a) => a.name), ready };
}

function view(o: { provider?: Provider; sessions?: Parameters<typeof meshRows>[0]["sessions"] } = {}): MeshView {
  const p = pool();
  return meshRows({ provider: o.provider ?? "claude", need: "any", names: p.names, registry: p.registry, snapshot: p.snapshot, ready: p.ready, sessions: o.sessions ?? [], now: now() });
}

// --- The rows ---------------------------------------------------------------

test("meshRows: the chooser's ranking first and ★ on its pick, then the rest by name; keys stay the registry's", () => {
  const v = view();
  assert.deepEqual(v.rows.map((r) => r.name), ["bravo", "alpha", "delta", "charlie", "echo"]);
  assert.deepEqual(v.rows.map((r) => r.mark), ["★", " ", "✗", "✗", "✗"]);
  // The hidden key is the account's place in the key space — never its name,
  // and never its place on screen, which a reload is free to change.
  assert.deepEqual(v.rows.map((r) => r.key), ["3", "4", "1", "2", "0"]);
  assert.deepEqual(v.rows.map((r) => r.rank), [1, 2, 3, null, null]);
  assert.equal(v.ranked, 3);
  assert.deepEqual(v.names, ["echo", "delta", "charlie", "bravo", "alpha"]);
});

test("meshRows: a ✗ says why — out of the ranking (its reason), or no credential on this device", () => {
  const by = (n: string) => view().rows.find((r) => r.name === n)!;
  assert.equal(by("charlie").out, "weekly window at 100");
  assert.equal(by("charlie").unready, null);
  assert.equal(by("echo").out, "error: fetch failed");
  // delta has room — the chooser ranks it — and still cannot be launched here.
  assert.equal(by("delta").out, null);
  assert.match(by("delta").unready!, /^no launch token for account 'delta'/);
  assert.equal(by("delta").state, "no-token", "the STATE word is `ms status`'s own");
  assert.equal(by("bravo").state, "ok");
  assert.equal(by("charlie").state, "no room");
  assert.equal(by("bravo").label, "Bravo at work");
  assert.equal(by("bravo").email, "bravo@example.com");
  assert.equal(by("alpha").email, null);
});

test("meshRows: the panes are this provider's live sessions on the account, finished ones left out", () => {
  const s = (id: string, o: { provider?: Provider; account?: string; state?: string; pane?: string; cwd?: string }) =>
    ({ id, provider: o.provider ?? "claude", account: o.account ?? "bravo", state: o.state ?? "running", pane: o.pane ?? "%1", cwd: o.cwd ?? "/tmp/w" });
  const v = view({
    sessions: [
      s("a", { pane: "%12", cwd: "/tmp/one" }),
      s("b", { pane: "%13", state: "walled" }),
      s("c", { pane: "%14", state: "stopped" }),
      s("d", { pane: "%15", provider: "codex" }),
      s("e", { pane: "%16", account: "alpha" }),
    ],
  });
  const bravo = v.rows.find((r) => r.name === "bravo")!;
  assert.deepEqual(bravo.panes, [{ pane: "%12", state: "running", cwd: "/tmp/one" }, { pane: "%13", state: "walled", cwd: "/tmp/w" }]);
  assert.equal(v.rows.find((r) => r.name === "alpha")!.panes.length, 1);
  assert.equal(v.rows.find((r) => r.name === "charlie")!.panes.length, 0);
});

test("meshRows: nothing with room means no ★, and every row is crossed out", () => {
  const p = pool();
  const full = { ...p.snapshot, accounts: p.snapshot.accounts.map((a) => (a.usage ? { ...a, usage: { ...a.usage, weeklyAll: { usedPercent: 100, resetsAt: inHours(5) } } } : a)) };
  const v = meshRows({ provider: "claude", need: "any", names: p.names, registry: p.registry, snapshot: full, ready: () => null, sessions: [], now: now() });
  assert.equal(v.rows.some((r) => r.mark === "★"), false);
  assert.ok(v.rows.every((r) => r.mark === "✗"));
  assert.match(meshHeader(v)[1], /no account has room/);
});

test("renderRow: columns line up, and Codex has no fable column", () => {
  const v = view();
  const lines = renderRows(v).map(plain);
  // name padded to the widest (charlie), state to the widest (transient).
  assert.match(lines[0]!, /^★ bravo {4}ok {9}5h {2}95% {2}wk {2}75% {2}fable {2}20% {2}\w{3} \d\d:\d\d$/);
  // Every row puts its 5h column in the same place.
  const at = lines.map((l) => l.indexOf(" 5h "));
  assert.ok(at.every((i) => i === at[0]), lines.join("\n"));
  assert.match(lines.find((l) => l.includes("echo"))!, /5h {4}— {2}wk {4}— {2}fable {4}—/);

  const codex = meshRows({
    provider: "codex", need: "any", names: ["home", "work"],
    registry: { version: 1, accounts: [account("home", { provider: "codex" }), account("work", { provider: "codex" })] },
    snapshot: { takenAt: now(), registryError: null, accounts: [reading("home", { provider: "codex", session: null }), reading("work", { provider: "codex" })] },
    ready: () => null, sessions: [], now: now(),
  });
  for (const line of renderRows(codex).map(plain)) assert.doesNotMatch(line, /fable/, line);
  assert.match(plain(renderRows(codex).join("\n")), /home .*5h {4}—/, "a Pro plan's missing 5h window is a dash, not a 0");
});

test("renderRow: percent colour is plain below 70, yellow from 70, red from 90; ★ bold yellow, names bold, ✗ rows dim", () => {
  const v = view();
  const w = rowWidths(v.rows);
  const bravo = renderRow(v.rows[0]!, v, w);
  assert.ok(bravo.startsWith(`${ESC}[1;33m★${ESC}[0m`), JSON.stringify(bravo));
  assert.ok(bravo.includes(`${ESC}[1mbravo${ESC}[0m`), "the name is bold");
  assert.ok(bravo.includes(`${ESC}[31m95%${ESC}[0m`), "95 is red");
  assert.ok(bravo.includes(`${ESC}[33m75%${ESC}[0m`), "75 is yellow");
  assert.ok(bravo.includes(" 20%"), "20 is plain");
  assert.ok(!bravo.includes(`m20%`), "with no colour at all");
  const charlie = renderRow(v.rows.find((r) => r.name === "charlie")!, v, w);
  assert.ok(charlie.includes(`${ESC}[2mcharlie${ESC}[0m`), "a crossed-out row is dim, name and all");
  assert.ok(charlie.includes(`${ESC}[2;31m100%${ESC}[0m`), "its numbers keep their colour under the dim");
});

test("renderRow: the resets column is the soonest reset among the windows the ranking uses, and the pane count", () => {
  const sessions = [{ id: "a", provider: "claude" as const, account: "bravo", state: "running", pane: "%1", cwd: "/x" }, { id: "b", provider: "claude" as const, account: "bravo", state: "running", pane: "%2", cwd: "/x" }];
  const v = view({ sessions });
  const bravo = plain(renderRow(v.rows[0]!, v, rowWidths(v.rows)));
  const reset = new Date(Date.parse(inHours(24)!));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][reset.getDay()];
  // The weekly reset (24 h), not the 5 h window's (2 h): the ranking reads the week.
  assert.ok(bravo.includes(`${day} ${String(reset.getHours()).padStart(2, "0")}:`), bravo);
  assert.ok(bravo.endsWith("2 panes"), bravo);
  const alpha = plain(renderRow(v.rows[1]!, v, rowWidths(v.rows)));
  assert.doesNotMatch(alpha, /pane/, "no panes, no column");
});

// --- The preview --------------------------------------------------------------

test("renderPreview: who it is, where it stands, the bars, the resets, what is here, and the pin", () => {
  const v = view({ sessions: [{ id: "a", provider: "claude", account: "bravo", state: "running", pane: "%12", cwd: path.join(process.env.HOME ?? "/nohome", "src", "foo") }] });
  const text = plain(renderPreview(v.rows[0]!, v));
  assert.match(text, /^ bravo {2}· {2}Bravo at work {2}· {2}bravo@example\.com {2}· {2}claude$/m);
  assert.match(text, /^ Status {4}ok — ★ what `ms claude` would pick now$/m);
  assert.match(text, /^ Rank {6}1 of 3 with room \(need: any\)$/m);
  // The reading was stamped a moment ago, maybe in this same millisecond.
  assert.match(text, /^ 5h {8}\[█{11}░\] {2}95% {2}resets (\w{3} )?\d\d:\d\d \(in (1h 59m|2h 0m)\)$/m);
  assert.match(text, /^ Week {6}\[█{9}░{3}\] {2}75% {2}resets \w{3} \d\d:\d\d \(in (23h 59m|1d 0h)\)$/m);
  assert.match(text, /^ Fable {5}\[█{2}░{10}\] {2}20% {2}resets /m);
  assert.match(text, /^ Here {6}launch token on this device ✓$/m);
  assert.match(text, /^ Panes {5}%12 running (~|\/nohome)\/src\/foo$/m);
  assert.match(text, /^ Reading {3}\d+s old$/m);
  assert.match(text, /enter launches here and pins this pane to bravo: rebalance won't move it;\n a usage wall still will \(and ends the pin\)\./);
});

test("renderPreview: nulls everywhere — no reading, no e-mail, an error, a window with no reset — and no throw", () => {
  const v = view();
  const echo = plain(renderPreview(v.rows.find((r) => r.name === "echo")!, v));
  assert.match(echo, /^ echo {2}· {2}claude$/m, "no label worth showing, no e-mail");
  assert.match(echo, /^ Status {4}error: fetch failed$/m);
  assert.match(echo, /^ Rank {6}not ranked \(need: any\)$/m);
  assert.match(echo, /^ 5h {8}—$/m);
  assert.match(echo, /^ Reading {3}fetch failed$/m);
  assert.match(echo, /^ Panes {5}none$/m);
  assert.match(echo, /launches it anyway; the first wall rotates it/);

  const charlie = plain(renderPreview(v.rows.find((r) => r.name === "charlie")!, v));
  assert.match(charlie, /^ Status {4}out — weekly window at 100$/m);

  const delta = plain(renderPreview(v.rows.find((r) => r.name === "delta")!, v));
  assert.match(delta, /^ Here {6}✗ no launch token for account 'delta'/m);
  assert.doesNotMatch(delta, /pins this pane/, "an account this device cannot launch is not offered a pin");

  // A window that names no reset, and a codex home that is logged in here.
  const codex = meshRows({
    provider: "codex", need: "any", names: ["home"],
    registry: { version: 1, accounts: [account("home", { provider: "codex", shared: true })] },
    snapshot: { takenAt: null, registryError: null, accounts: [reading("home", { provider: "codex", session: null, weekly: { used: 12.5, resetIn: null } })] },
    ready: () => null, sessions: [], now: now(),
  });
  const home = plain(renderPreview(codex.rows[0]!, codex));
  assert.match(home, /^ home {2}· {2}codex, shared$/m);
  assert.match(home, /^ Week {6}\[█{2}░{10}\] {2}12% *$/m, "no reset, no reset text");
  assert.match(home, /^ 5h {8}— {2}\(not reported\)$/m);
  assert.doesNotMatch(home, /Fable/, "codex has no fable window to show");
  assert.match(home, /^ Here {6}codex home logged in here ✓$/m);
});

test("clean: control characters from a label, an e-mail or an error never reach the terminal", () => {
  assert.equal(clean("ok\x1b[2J\x07\r\nthere\x7f\u009b"), "ok[2Jthere");
  const p = pool();
  p.registry.accounts[3]!.label = "Bravo\x1b]0;pwned\x07";
  p.snapshot.accounts[0]!.error = "bad\x1b[31m news\n";
  const v = meshRows({ provider: "claude", need: "any", names: p.names, registry: p.registry, snapshot: p.snapshot, ready: p.ready, sessions: [], now: now() });
  for (const row of v.rows) {
    const text = renderPreview(row, v).replace(/\x1b\[[0-9;]*m/g, "");
    assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f]/, `${row.name}: ${JSON.stringify(text)}`);
  }
});

// --- The header and fzf's command line ----------------------------------------

test("meshHeader: the keys, then ★ and how old the newest reading is — or the banner when usage is unreachable", () => {
  const p = pool();
  // The file was written a moment ago by a poll that read nothing new: the
  // age is the newest READING's (14 s), not the file's.
  const aged = { ...p.snapshot, takenAt: now(), accounts: p.snapshot.accounts.map((a) => (a.observedAt === null ? a : { ...a, observedAt: now() - (a.name === "alpha" ? 14_000 : 95_000) })) };
  const v = meshRows({ provider: "claude", need: "any", names: p.names, registry: p.registry, snapshot: aged, ready: p.ready, sessions: [], now: now() });
  const [keys, status] = meshHeader(v);
  assert.equal(keys, "enter: launch here (pinned) · ctrl-r: refresh usage · esc: cancel");
  assert.match(plain(status), /^★ what plain `ms claude` would pick · usage 1[45]s old$/);

  const down = {
    ...p.snapshot,
    accounts: p.snapshot.accounts.map((a) => ({ ...a, usage: null, error: "fetch failed", errorKind: "transient" as const, observedAt: null, stale: true })),
  };
  const u = meshRows({ provider: "claude", need: "any", names: p.names, registry: p.registry, snapshot: down, ready: () => null, sessions: [], now: now() });
  assert.match(plain(meshHeader(u)[1]), /^usage unreachable — no account could be read just now · nothing read yet$/);
});

/** Every reading failed in passing, the last good ones twenty minutes ago:
 *  usage is unreachable, and a plain launch takes its remembered pick. */
function unreachablePool(): { registry: Registry; snapshot: Snapshot; names: string[] } {
  const p = pool();
  const twentyMinutesAgo = now() - 20 * 60_000;
  return {
    ...p,
    snapshot: {
      takenAt: now() - 6_000,
      registryError: null,
      accounts: p.snapshot.accounts.map((a) => ({ ...a, error: "the usage endpoint could not be reached", errorKind: "transient" as const, observedAt: a.usage ? twentyMinutesAgo : null, stale: true })),
    },
  };
}

test("meshRows: usage unreachable, the ★ is the remembered pick a plain launch takes — first, so enter takes it", () => {
  const p = unreachablePool();
  const v = meshRows({ provider: "claude", need: "any", names: p.names, registry: p.registry, snapshot: p.snapshot, ready: () => null, lastPick: "echo", sessions: [], now: now() });
  assert.equal(v.unreachable, true);
  assert.equal(v.starredBy, "last pick");
  assert.deepEqual(v.rows.map((r) => r.name), ["echo", "alpha", "bravo", "charlie", "delta"]);
  assert.deepEqual(v.rows.map((r) => r.mark), ["★", "✗", "✗", "✗", "✗"]);
  // Picking it still says why it was out: the reading failed.
  assert.equal(v.rows[0]!.out, "error: the usage endpoint could not be reached");
  // The header names it, and the age is the newest READING's, not the 6 s
  // old file a failed poll wrote.
  assert.match(plain(meshHeader(v)[1]), /^usage unreachable — ★ the last pick, what plain `ms claude` launches now · newest reading 20m old$/);
  assert.match(plain(renderPreview(v.rows[0]!, v)), /^ Status {4}transient — ★ the last pick: what `ms claude` launches while usage is unreachable$/m);
  assert.match(plain(fzfInput(v)).split("\n")[1]!, /^\d\t★ echo /, "the first row fzf shows, the cursor's");

  // No remembered pick, or one that is no longer registered: no ★, as a
  // plain launch would refuse (exit 4).
  for (const lastPick of [null, "zulu"]) {
    const w = meshRows({ provider: "claude", need: "any", names: p.names, registry: p.registry, snapshot: p.snapshot, ready: () => null, lastPick, sessions: [], now: now() });
    assert.equal(w.starredBy, null, String(lastPick));
    assert.ok(w.rows.every((r) => r.mark === "✗"));
    assert.match(plain(meshHeader(w)[1]), /^usage unreachable — no account could be read just now · newest reading 20m old$/);
  }
  // With room somewhere, the ranking's ★ stands and the remembered pick is
  // nobody's business.
  const q = pool();
  const ranked = meshRows({ provider: "claude", need: "any", names: q.names, registry: q.registry, snapshot: q.snapshot, ready: q.ready, lastPick: "alpha", sessions: [], now: now() });
  assert.equal(ranked.starredBy, "ranking");
  assert.equal(ranked.rows[0]!.name, "bravo");
});

test("parseFzfVersion reads what fzf --version prints, and nothing else", () => {
  assert.deepEqual(parseFzfVersion("0.73.1 (Homebrew)"), [0, 73, 1]);
  assert.deepEqual(parseFzfVersion("0.53.0 (c4a9ccd)\n"), [0, 53, 0]);
  assert.deepEqual(parseFzfVersion("0.29"), [0, 29, 0]);
  assert.equal(parseFzfVersion("fzf: unknown option"), null);
});

const BASE = { provider: "claude" as const, need: "any" as const, self: "/opt/ms/bin/ms" };

test("fzfArgs: the fixed flags, the prompt, the header (keys, then the input's status line), the preview and ctrl-r", () => {
  const args = fzfArgs({ ...BASE, dir: "/tmp/ms-mesh-abc123", inPane: false, fzfVersion: [0, 53, 0] });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  for (const flag of ["--layout=reverse", "--ansi", "--no-sort"]) assert.ok(args.includes(flag), flag);
  assert.equal(value("--delimiter"), "\t");
  assert.equal(value("--with-nth"), "2..");
  assert.equal(value("--prompt"), "claude account> ");
  assert.equal(value("--header"), "enter: launch here (pinned) · ctrl-r: refresh usage · esc: cancel");
  // Line 2 is the first line of fzf's input, so a reload rewrites it too.
  assert.equal(value("--header-lines"), "1");
  assert.equal(value("--preview"), "cat '/tmp/ms-mesh-abc123'/{1}");
  assert.equal(value("--preview-window"), "right,50%,wrap,<80(down,50%,wrap)");
  assert.equal(value("--bind"), "ctrl-r:reload('/opt/ms/bin/ms' '_mesh_rows' 'claude' 'any' '/tmp/ms-mesh-abc123')+refresh-preview");
  assert.equal(args.includes("--tmux"), false);
  assert.equal(fzfArgs({ ...BASE, provider: "codex", dir: "/tmp/d", inPane: false, fzfVersion: null })[args.indexOf("--prompt") + 1], "codex account> ");
});

test("fzfInput: the header's status line first (a key no row has), then the rows", () => {
  const v = view();
  const lines = fzfInput(v).split("\n");
  assert.equal(lines[0], `-\t${meshHeader(v)[1]}`);
  assert.deepEqual(lines.slice(1, -1).map((l) => l.split("\t")[0]), v.rows.map((r) => r.key));
  assert.equal(lines.at(-1), "", "newline-terminated");
  assert.equal(selectedKey(`${lines[0]}\n`), null, "the status line can never be read as a selection");
});

test("fzfArgs: with fzf 0.71+, ctrl-r keeps the cursor on its account (tracked by the hidden key), not on its place", () => {
  const bindOf = (v: [number, number, number] | null) => {
    const args = fzfArgs({ ...BASE, dir: "/tmp/ms-mesh-abc123", inPane: false, fzfVersion: v });
    return { bind: args[args.indexOf("--bind") + 1], idNth: args.includes("--id-nth") ? args[args.indexOf("--id-nth") + 1] : null };
  };
  const reload = "reload('/opt/ms/bin/ms' '_mesh_rows' 'claude' 'any' '/tmp/ms-mesh-abc123')+refresh-preview";
  assert.deepEqual(bindOf([0, 71, 0]), { bind: `ctrl-r:track-current+${reload}`, idNth: "1" });
  assert.deepEqual(bindOf([0, 73, 1]), { bind: `ctrl-r:track-current+${reload}`, idNth: "1" });
  // Older fzf has no --id-nth, and its tracking does not survive a reload.
  assert.deepEqual(bindOf([0, 70, 9]), { bind: `ctrl-r:${reload}`, idNth: null });
  assert.deepEqual(bindOf(null), { bind: `ctrl-r:${reload}`, idNth: null });
});

test("fzfArgs: a tmux popup only in a real pane, and only with an fzf that has --tmux (0.53+)", () => {
  const popup = (inPane: boolean, v: [number, number, number] | null) => {
    const args = fzfArgs({ ...BASE, dir: "/tmp/d", inPane, fzfVersion: v });
    const i = args.indexOf("--tmux");
    return i < 0 ? null : args[i + 1];
  };
  assert.equal(popup(true, [0, 73, 1]), "center,80%,60%");
  assert.equal(popup(true, [0, 53, 0]), "center,80%,60%");
  assert.equal(popup(true, [1, 0, 0]), "center,80%,60%");
  assert.equal(popup(true, [0, 52, 9]), null, "older fzf has no --tmux");
  assert.equal(popup(true, null), null, "an fzf that would not say its version is not trusted with it");
  assert.equal(popup(false, [0, 73, 1]), null, "outside a pane — or in a display-popup — plain fzf");
});

test("fzfArgs: no popup is said out loud (--no-tmux), so a --tmux in FZF_DEFAULT_OPTS cannot open one anyway", () => {
  // Measured with fzf 0.73.1 in a session no client is attached to:
  // FZF_DEFAULT_OPTS=--tmux alone fails with "no current client" (exit 1,
  // which the picker would read as a cancel); with --no-tmux, plain fzf.
  const has = (inPane: boolean, v: [number, number, number] | null) => fzfArgs({ ...BASE, dir: "/tmp/d", inPane, fzfVersion: v }).includes("--no-tmux");
  assert.equal(has(false, [0, 73, 1]), true);
  assert.equal(has(false, [0, 53, 0]), true, "0.53 knows --no-tmux: its own popups run the inner fzf with it");
  assert.equal(has(true, [0, 73, 1]), false, "a popup is asked for instead");
  assert.equal(has(false, [0, 52, 9]), false, "an fzf from before --tmux would reject the flag");
  assert.equal(has(false, null), false);
});

test("fzfArgs: the preview and ctrl-r commands survive a directory with spaces, quotes and shell syntax", (t) => {
  // Run both commands the way fzf does — `{1}` replaced by the quoted key,
  // then a shell — and check they reach exactly the file and the argv meant.
  const base = mkdtempSync(path.join(tmpdir(), "ms-mesh-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, `it's a "dir" $(touch pwned) \`x\` (with) [brackets]`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "0"), "PREVIEW-0");
  const argvFile = path.join(base, "argv");
  const self = path.join(base, "fake ms");
  writeFileSync(self, `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(argvFile)}\n`, { mode: 0o755 });

  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"].filter(existsSync)) {
    const args = fzfArgs({ ...BASE, self, dir, inPane: false, fzfVersion: [0, 73, 1] });
    const preview = args[args.indexOf("--preview") + 1]!.replace("{1}", "'0'");
    const shown = spawnSync(shell, ["-c", preview], { encoding: "utf8", cwd: base });
    assert.equal(shown.stdout, "PREVIEW-0", `${shell}: ${shown.stderr}`);

    const bind = args[args.indexOf("--bind") + 1]!;
    const m = /^ctrl-r:track-current\+reload(.)(.*)(.)\+refresh-preview$/s.exec(bind);
    assert.ok(m, bind);
    // The delimiter fzf would end the argument at is not in the argument.
    assert.ok(!m![2]!.includes(m![3]!), `the argument contains its own closing ${m![3]}: ${bind}`);
    rmSync(argvFile, { force: true });
    const reload = spawnSync(shell, ["-c", m![2]!], { encoding: "utf8", cwd: base });
    assert.equal(reload.status, 0, `${shell}: ${reload.stderr}`);
    assert.deepEqual(readFileSync(argvFile, "utf8").split("\0").slice(0, -1), ["_mesh_rows", "claude", "any", dir]);
    assert.equal(existsSync(path.join(base, "pwned")), false, "nothing in the path was ever run");
  }
  // `(` would end at the path's own `)`: some other delimiter was chosen.
  assert.match(fzfArgs({ ...BASE, self, dir, inPane: false, fzfVersion: null })[fzfArgs({ ...BASE, self, dir, inPane: false, fzfVersion: null }).indexOf("--bind") + 1]!, /^ctrl-r:reload~/);
});

test("fzfArgs: a path holding every closing delimiter falls back on reload's open-ended form", () => {
  const dir = "/tmp/x)]~!@#%^&*;|";
  const args = fzfArgs({ ...BASE, dir, inPane: false, fzfVersion: null });
  // The `:` form runs to the end of the binding, so nothing may follow it.
  assert.equal(args[args.indexOf("--bind") + 1], `ctrl-r:reload:'/opt/ms/bin/ms' '_mesh_rows' 'claude' 'any' '${dir}'`);
  // Tracking goes in front of it, where it can.
  const tracked = fzfArgs({ ...BASE, dir, inPane: false, fzfVersion: [0, 73, 1] });
  assert.equal(tracked[tracked.indexOf("--bind") + 1], `ctrl-r:track-current+reload:'/opt/ms/bin/ms' '_mesh_rows' 'claude' 'any' '${dir}'`);
});

test("selectedKey: the selected row's key, whatever FZF_DEFAULT_OPTS adds around it", () => {
  assert.equal(selectedKey("3\t★ bravo  ok\n"), 3);
  assert.equal(selectedKey("my query\n2\t  alpha  ok\n"), 2, "--print-query puts the query first");
  assert.equal(selectedKey("enter\n0\t✗ echo\n"), 0, "--expect puts the key first");
  assert.equal(selectedKey(""), null);
  assert.equal(selectedKey("alpha\n"), null, "a line with no key is not a selection");
});

// --- The chooser, against a stub fzf --------------------------------------------

type ChooserWorld = { msHome: string; tty: string; log: string; previewOut: string; rowsOut: string };

/**
 * A throwaway store: three claude accounts with launch tokens (charlie at 100
 * in its week), one codex account so the provider filter has something to
 * filter, and a snapshot file written this instant — fresh, so the chooser's
 * reading is the file and no request is ever made. A stub fzf is first on
 * PATH and a plain file stands in for the terminal.
 */
function chooserWorld(t: TestContext, o: { tokens?: string[] } = {}): ChooserWorld {
  const { home, msHome } = tempHome();
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const { dir, stub } = stubDir();
  stub("fzf", FZF_STUB);
  // tmux, as far as the picker asks it anything: the clients attached to the
  // pane's session, one control-mode flag each (MS_TEST_TMUX_CLIENTS,
  // space-separated; default one terminal client, "0"; empty: none).
  stub("tmux", `[ "$1" != "-S" ] || shift 2
case "$1" in list-clients) for m in \${MS_TEST_TMUX_CLIENTS-0}; do echo "$m"; done ;; esac`);
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  t.after(() => {
    process.env.PATH = ORIGINAL_PATH;
    for (const k of Object.keys(process.env)) if (k.startsWith("MS_TEST_FZF_") || k === "MS_TEST_TMUX_CLIENTS") delete process.env[k];
  });
  writeFileSync(path.join(msHome, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [
      { name: "alpha", provider: "claude", label: "Alpha", shared: false, email: "alpha@example.com" },
      { name: "bravo", provider: "claude", label: "Bravo", shared: false },
      { name: "charlie", provider: "claude", label: "Charlie", shared: false },
      { name: "alpha", provider: "codex", label: "Alpha (codex)", shared: false },
    ],
  }), { mode: 0o600 });
  for (const name of o.tokens ?? ["alpha", "bravo", "charlie"]) saveLaunchToken(name, `sk-ant-oat01-${name}0123456789abcdefghij`);
  writeFileSync(path.join(msHome, "snapshot.json"), JSON.stringify({
    takenAt: now(),
    accounts: [
      reading("alpha", { weekly: { used: 20, resetIn: 72 } }),
      reading("bravo", { weekly: { used: 30, resetIn: 24 } }),
      reading("charlie", { weekly: { used: 100, resetIn: 12 } }),
      reading("alpha", { provider: "codex" }),
    ],
    backoff: {},
  }), { mode: 0o600 });
  const tty = path.join(dir, "tty");
  writeFileSync(tty, "");
  const log = path.join(dir, "fzf.args");
  process.env.MS_TEST_FZF_ARGS = log;
  return { msHome, tty, log, previewOut: path.join(dir, "preview.out"), rowsOut: path.join(dir, "rows.out") };
}

const claudeReady: Ready = (name) => (["alpha", "bravo", "charlie"].includes(name) ? null : { error: `no launch token for account '${name}'` });
const fzfArgv = (w: ChooserWorld): string[] => readFileSync(w.log, "utf8").split("\0").slice(0, -1);
const meshDirOf = (args: string[]): string => /^cat '(.*)'\/\{1\}$/.exec(args[args.indexOf("--preview") + 1]!)![1]!;

test("chooseAccount: fzf's selection is the account launched, and the picker's directory is gone when it returns", async (t) => {
  const w = chooserWorld(t);
  process.env.MS_TEST_FZF_PICK = "alpha";
  process.env.MS_TEST_FZF_PREVIEW = w.previewOut;
  process.env.MS_TEST_FZF_ROWS = w.rowsOut;
  const headerOut = `${w.rowsOut}.header`;
  process.env.MS_TEST_FZF_HEADER = headerOut;

  const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty, env: { ...process.env, TMUX: "", TMUX_PANE: "" } });
  assert.deepEqual(r, { name: "alpha", out: null });

  // What fzf was shown: the claude accounts only, in the chooser's order,
  // under the status line that says what the ★ is.
  const shown = readFileSync(w.rowsOut, "utf8").trim().split("\n").map((l) => plain(l.split("\t").slice(1).join("\t")));
  assert.deepEqual(shown.map((l) => l.slice(2).split(" ")[0]), ["bravo", "alpha", "charlie"]);
  assert.ok(shown[0]!.startsWith("★ bravo"));
  assert.match(plain(readFileSync(headerOut, "utf8")), /^-\t★ what plain `ms claude` would pick · usage \d+s old\n$/);
  // The preview fzf ran for the row it selected was that row's.
  assert.match(plain(readFileSync(w.previewOut, "utf8")), /^ alpha {2}· {2}alpha@example\.com {2}· {2}claude$/m);

  const args = fzfArgv(w);
  const dir = meshDirOf(args);
  assert.match(path.basename(dir), /^ms-mesh-/);
  assert.equal(existsSync(dir), false, "removed the moment fzf returned, before anything is launched");
  assert.equal(args.includes("--tmux"), false, "not a pane: plain fzf");
});

test("chooseAccount: in a real pane, fzf 0.53+ opens as a tmux popup", async (t) => {
  const w = chooserWorld(t);
  process.env.MS_TEST_FZF_PICK = "bravo";
  const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty, env: { ...process.env, TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3" } });
  assert.deepEqual(r, { name: "bravo", out: null });
  const args = fzfArgv(w);
  assert.equal(args[args.indexOf("--tmux") + 1], "center,80%,60%");
});

test("chooseAccount: a pane nobody is attached to gets plain fzf, not a popup that would wait for ever", async (t) => {
  // fzf 0.73.1's --tmux in a session with no client never returns (measured:
  // still running after 20 s). Plain fzf sits on the pane for whoever attaches.
  const w = chooserWorld(t);
  process.env.MS_TEST_FZF_PICK = "bravo";
  process.env.MS_TEST_TMUX_CLIENTS = "";
  const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty, env: { ...process.env, TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3" } });
  assert.deepEqual(r, { name: "bravo", out: null });
  assert.equal(fzfArgv(w).includes("--tmux"), false);
  assert.equal(fzfArgv(w).includes("--no-tmux"), true);
});

test("chooseAccount: a control-mode client (tmux -C, iTerm2's integration) draws no popup, so it gets plain fzf", async (t) => {
  // Measured on a private server with only `tmux -C attach` on the session:
  // #{session_attached} is 1, and `fzf --tmux` in the pane never returned.
  // Beside a terminal client it may still be the one tmux hands the popup.
  const w = chooserWorld(t);
  process.env.MS_TEST_FZF_PICK = "bravo";
  for (const clients of ["1", "0 1", "1 0"]) {
    process.env.MS_TEST_TMUX_CLIENTS = clients;
    const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty, env: { ...process.env, TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3" } });
    assert.deepEqual(r, { name: "bravo", out: null });
    assert.equal(fzfArgv(w).includes("--tmux"), false, `clients ${clients}`);
  }
  process.env.MS_TEST_TMUX_CLIENTS = "0 0";
  await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty, env: { ...process.env, TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3" } });
  assert.equal(fzfArgv(w).includes("--tmux"), true, "two terminals: the popup");
});

test("chooseAccount: esc (130) and nothing-matched (1) both cancel; any other exit is an error", async (t) => {
  const w = chooserWorld(t);
  const ask = () => chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty });
  process.env.MS_TEST_FZF_EXIT = "130";
  assert.deepEqual(await ask(), { cancelled: true });
  process.env.MS_TEST_FZF_EXIT = "1";
  assert.deepEqual(await ask(), { cancelled: true });
  delete process.env.MS_TEST_FZF_EXIT;
  process.env.MS_TEST_FZF_PICK = "nobody";
  assert.deepEqual(await ask(), { cancelled: true }, "the stub's own no-match is fzf's exit 1");
  process.env.MS_TEST_FZF_EXIT = "2";
  const broken = await ask();
  assert.ok("error" in broken && /fzf/.test(broken.error) && broken.exit === 1, JSON.stringify(broken));
  // Every one of them left no directory behind.
  const leftover = readdirSync(tmpdir()).filter((n) => n === path.basename(meshDirOf(fzfArgv(w))));
  assert.deepEqual(leftover, []);
});

test("chooseAccount: picking an account with no room says why, so the launch can warn", async (t) => {
  const w = chooserWorld(t);
  process.env.MS_TEST_FZF_PICK = "charlie";
  assert.deepEqual(await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty }), { name: "charlie", out: "weekly window at 100" });
});

test("chooseAccount: a path with a brace in it is refused, not handed to fzf to mangle as a placeholder", async (t) => {
  const w = chooserWorld(t);
  process.env.MS_TEST_FZF_PICK = "alpha";
  const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty, self: "/opt/{weird}/bin/ms" });
  assert.ok("error" in r && /\{ or \}/.test(r.error) && r.exit === 1, JSON.stringify(r));
  assert.equal(existsSync(w.log), false, "fzf never ran");
});

test("chooseAccount: no terminal to open is a refusal before anything is read or run", async (t) => {
  const w = chooserWorld(t);
  const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: path.join(w.msHome, "no-such-tty") });
  assert.deepEqual(r, { error: "mesh needs a terminal", exit: 2 });
  assert.equal(existsSync(w.log), false, "fzf never ran");
});

test("chooseAccount: an unreadable registry is said, not shown as an empty picker", async (t) => {
  const w = chooserWorld(t);
  writeFileSync(path.join(w.msHome, "accounts.json"), "{ not json");
  const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty });
  assert.ok("error" in r && /cannot read the registry/.test(r.error), JSON.stringify(r));
  assert.equal(existsSync(w.log), false);
});

// --- No fzf: the numbered menu ---------------------------------------------------

async function menu(t: TestContext, input: string) {
  const w = chooserWorld(t);
  writeFileSync(w.tty, input);
  let shown = "";
  const r = await chooseAccount({ provider: "claude", need: "any", ready: claudeReady, tty: w.tty, fzf: null, write: (s) => { shown += s; } });
  return { r, shown: plain(shown) };
}

test("menu: the same rows, numbered; a number picks that row and an empty answer is row 1, the ★", async (t) => {
  const two = await menu(t, "2\n");
  assert.deepEqual(two.r, { name: "alpha", out: null });
  assert.match(two.shown, /^1 {2}★ bravo /m);
  assert.match(two.shown, /^2 {4}alpha /m);
  assert.match(two.shown, /^3 {2}✗ charlie /m);
  assert.match(two.shown, /pick 1-3 \[1\], q to cancel: $/);
  assert.match(two.shown, /★ what plain `ms claude` would pick/);

  assert.deepEqual((await menu(t, "\n")).r, { name: "bravo", out: null });
  assert.deepEqual((await menu(t, "3\n")).r, { name: "charlie", out: "weekly window at 100" });
});

test("menu: q or end of input cancels; bad answers re-ask three times, then cancel", async (t) => {
  assert.deepEqual((await menu(t, "q\n")).r, { cancelled: true });
  assert.deepEqual((await menu(t, "")).r, { cancelled: true }, "EOF (ctrl-d) is a cancel");
  const patient = await menu(t, "x\n0\n9\n1\n");
  assert.deepEqual(patient.r, { name: "bravo", out: null }, "three bad answers, then a good one");
  assert.equal(patient.shown.match(/pick 1-3/g)!.length, 4);
  const done = await menu(t, "x\n0\n9\nnope\n1\n");
  assert.deepEqual(done.r, { cancelled: true }, "a fourth bad answer is a cancel");
});

// --- ctrl-r: `ms _mesh_rows` ---------------------------------------------------------

/** A directory exactly as the chooser makes one: under the temp dir, named
 *  `ms-mesh-*`, 0700, holding the key space and the first previews. */
function pickerDir(t: TestContext, v: MeshView): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ms-mesh-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeMeshDir(dir, v);
  return dir;
}

/** `_mesh_rows`'s output, through the writers it is handed — never by swapping
 *  process.stdout, which node:test's own reporter writes to as well: a report
 *  landing while the verb awaits would be read as the verb's (seen on CI, as
 *  the serialized `test:complete` of the test before). */
async function captured(fn: (io: Required<Pick<MeshRowsDeps, "out" | "err">>) => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await fn({ out: (s) => { out.push(s); }, err: (s) => { err.push(s); } });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** What `_mesh_rows` is handed by src/cli.ts, for these tests. */
const LAUNCH = { ready: (_p: Provider, n: string) => claudeReady(n), lastPick: () => null };

test("_mesh_rows: a fresh reading of the picker's accounts, the previews re-rendered, and on stdout the status line and the rows", async (t) => {
  chooserWorld(t);
  const p = pool();
  // Opened while every week was full: no ★, and the status line said so.
  const full = { ...p.snapshot, accounts: p.snapshot.accounts.map((a) => (a.usage ? { ...a, usage: { ...a.usage, weeklyAll: { usedPercent: 100, resetsAt: inHours(5) } } } : a)) };
  const before = meshRows({ provider: "claude", need: "any", names: ["alpha", "bravo", "charlie"], registry: p.registry, snapshot: full, ready: claudeReady, sessions: [], now: now() });
  assert.match(plain(meshHeader(before)[1]), /^no account has room/);
  const dir = pickerDir(t, before);
  const asked: string[][] = [];
  // Since then the weeks have reset, charlie's soonest.
  const fresh: Snapshot = {
    takenAt: now(), registryError: null,
    accounts: [reading("alpha", { weekly: { used: 20, resetIn: 72 } }), reading("bravo", { weekly: { used: 30, resetIn: 24 } }), reading("charlie", { weekly: { used: 1, resetIn: 12 } }), reading("alpha", { provider: "codex" })],
  };
  const r = await captured((io) => meshRowsVerb(["claude", "any", dir], LAUNCH, { ...io, poll: async (names) => { asked.push(names); return fresh; } }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(asked, [["alpha", "bravo", "charlie"]], "one fresh reading, of the picker's own accounts and no others");
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 4);
  // The status line comes first and is the NEW one: fzf's header changes with
  // the rows it describes.
  assert.match(plain(lines[0]!), /^-\t★ what plain `ms claude` would pick · usage \ds old$/);
  for (const l of lines.slice(1)) assert.match(l, /^[0-2]\t/, `then only rows: ${JSON.stringify(l)}`);
  const charlie = lines[1]!;
  assert.match(plain(charlie), /^2\t★ charlie /, "charlie has room again, the soonest reset, and the ★");
  assert.match(plain(readFileSync(path.join(dir, "2"), "utf8")), /^ Week {6}\[░{12}\] {3}1%/m, "its preview was re-rendered from the new reading");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "rows.json"), "utf8")).out, [null, null, null]);
});

test("_mesh_rows: a reading that throws falls back on the cached snapshot", async (t) => {
  chooserWorld(t);
  const p = pool();
  const dir = pickerDir(t, meshRows({ provider: "claude", need: "any", names: ["alpha", "bravo", "charlie"], registry: p.registry, snapshot: p.snapshot, ready: claudeReady, sessions: [], now: now() }));
  const r = await captured((io) => meshRowsVerb(["claude", "any", dir], LAUNCH, { ...io, poll: async () => { throw new Error("locks.sqlite is busy"); } }));
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n").map(plain);
  assert.equal(lines.length, 4);
  assert.match(lines.find((l) => l.includes("charlie"))!, /✗ charlie .*wk 100%/, "the cached file's numbers");
  assert.match(lines.find((l) => l.includes("bravo"))!, /^\d\t★ bravo /, "a cached reading this young still ranks");
});

test("_mesh_rows: the cached fallback is read as old — a reading from days ago never ranks as if it were current", async (t) => {
  // Every successful poll writes its rows `stale: false`, and the file keeps
  // saying so however long nobody polls again.
  const w = chooserWorld(t);
  const threeDaysAgo = now() - 3 * 24 * HOUR;
  writeFileSync(path.join(w.msHome, "snapshot.json"), JSON.stringify({
    takenAt: threeDaysAgo,
    accounts: [
      reading("alpha", { weekly: { used: 30, resetIn: 72 }, observedAt: threeDaysAgo }),
      reading("bravo", { weekly: { used: 100, resetIn: 24 }, observedAt: threeDaysAgo }),
    ],
    backoff: {},
  }), { mode: 0o600 });
  const p = pool();
  const dir = pickerDir(t, meshRows({ provider: "claude", need: "any", names: ["alpha", "bravo"], registry: p.registry, snapshot: p.snapshot, ready: claudeReady, sessions: [], now: now() }));
  const r = await captured((io) => meshRowsVerb(["claude", "any", dir], LAUNCH, { ...io, poll: async () => { throw new Error("disk I/O error"); } }));
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n").map(plain);
  assert.equal(lines.some((l) => l.includes("★")), false, `no ★ on a three-day-old reading:\n${lines.join("\n")}`);
  assert.match(lines.find((l) => l.includes("alpha"))!, /✗ alpha /);
  // bravo's week has long since reset: what it is out for is the age of the
  // reading, so picking it never warns "weekly window at 100".
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "rows.json"), "utf8")).out, ["error: usage stale (3d)", "error: usage stale (3d)"]);
});

test("_mesh_rows: the remembered pick is the ★ when the reload finds usage unreachable, as the launch's own would be", async (t) => {
  chooserWorld(t);
  const p = pool();
  const dir = pickerDir(t, meshRows({ provider: "claude", need: "any", names: ["alpha", "bravo", "charlie"], registry: p.registry, snapshot: p.snapshot, ready: claudeReady, sessions: [], now: now() }));
  const down: Snapshot = {
    takenAt: now(), registryError: null,
    accounts: ["alpha", "bravo", "charlie"].map((n) => reading(n, { noUsage: true, error: "fetch failed", errorKind: "transient", observedAt: null, stale: true })),
  };
  const asked: [Provider, string][] = [];
  const r = await captured((io) => meshRowsVerb(["claude", "any", dir], { ...LAUNCH, lastPick: (provider, need) => { asked.push([provider, need]); return "charlie"; } }, { ...io, poll: async () => down }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(asked, [["claude", "any"]]);
  const lines = r.stdout.trimEnd().split("\n").map(plain);
  assert.match(lines[0]!, /^-\tusage unreachable — ★ the last pick/);
  assert.match(lines[1]!, /^2\t★ charlie /);
});

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("_mesh_rows: fzf killing the reload mid-refresh cannot cost the account its grant — the poll runs apart from it", async (t) => {
  // fzf SIGKILLs a reload's whole process group when ctrl-r is pressed again
  // and when the picker closes mid-reload. A forced poll refreshes a grant
  // that is due, and the token endpoint spends the old refresh token as it
  // answers: killed before the write-back, the account was left holding a
  // spent one (`invalid_grant`) until a fresh login.
  const { home, msHome } = tempHome();
  writeFileSync(path.join(msHome, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [{ name: "alpha", provider: "claude", label: "Alpha", shared: false, email: "alpha@example.com" }],
  }), { mode: 0o600 });
  const grantDir = path.join(msHome, "claude", "alpha");
  mkdirSync(grantDir, { recursive: true, mode: 0o700 });
  const grant = path.join(grantDir, ".credentials.json");
  writeFileSync(grant, JSON.stringify({ claudeAiOauth: { accessToken: "at-spent", refreshToken: "rt-old", expiresAt: Date.now() - 1_000 } }), { mode: 0o600 });
  // The token endpoint, rotating: it notes the refresh token it was handed
  // the moment the request lands, and answers 1.5 s later.
  const endpointLog = path.join(home, "endpoint.log");
  const stub = path.join(home, "endpoint-stub.mjs");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";
const log = ${JSON.stringify(endpointLog)};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("/oauth/token")) {
    appendFileSync(log, "token " + JSON.parse(init.body).refresh_token + "\\n");
    await new Promise((r) => setTimeout(r, 1500));
    return new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }), { status: 200 });
  }
  if (u.includes("/api/oauth/usage")) {
    return new Response(JSON.stringify({ limits: [{ kind: "session", percent: 10, resets_at: "2026-09-16T00:00:00Z" }, { kind: "weekly_all", percent: 20, resets_at: "2026-09-18T00:00:00Z" }] }), { status: 200 });
  }
  return new Response("unexpected " + u, { status: 500 });
};
`);
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const p = pool();
  const dir = pickerDir(t, meshRows({ provider: "claude", need: "any", names: ["alpha"], registry: p.registry, snapshot: p.snapshot, ready: () => null, sessions: [], now: now() }));

  // The reload exactly as fzf starts it: a process group of its own.
  const reload = spawn(process.execPath, ["--import", "tsx", path.resolve("bin/ms"), "_mesh_rows", "claude", "any", dir], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HOME: home, MS_HOME: msHome, NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import ${pathToFileURL(stub).href}` },
  });
  const gone = new Promise((resolve) => reload.on("exit", resolve));
  t.after(() => { try { process.kill(-reload.pid!, "SIGKILL"); } catch { /* already gone */ } });
  await until("the refresh to reach the token endpoint", () => existsSync(endpointLog) && readFileSync(endpointLog, "utf8").includes("token rt-old"));
  process.kill(-reload.pid!, "SIGKILL"); // ctrl-r again, or enter, mid-reload
  await gone;

  // The rotated grant still lands on disk, and the reading with it.
  await until("the refreshed grant to be written back", () => JSON.parse(readFileSync(grant, "utf8")).claudeAiOauth.refreshToken === "rt-new");
  assert.equal(readFileSync(endpointLog, "utf8"), "token rt-old\n", "the grant was spent exactly once");
  await until("the poll to write its reading", () => {
    try {
      return (JSON.parse(readFileSync(path.join(msHome, "snapshot.json"), "utf8")) as { accounts: AccountUsage[] }).accounts.some((a) => a.name === "alpha" && a.usage !== null);
    } catch {
      return false;
    }
  });
});

test("_mesh_rows refuses any directory that is not a picker's own, and writes nothing", async (t) => {
  chooserWorld(t);
  const p = pool();
  const v = meshRows({ provider: "claude", need: "any", names: ["alpha"], registry: p.registry, snapshot: p.snapshot, ready: claudeReady, sessions: [], now: now() });
  const good = pickerDir(t, v);
  assert.equal(meshDirProblem(good), null);

  const scratch = mkdtempSync(path.join(tmpdir(), "ms-test-scratch-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const nested = path.join(scratch, "ms-mesh-abcdef");
  mkdirSync(nested, { mode: 0o700 });
  const open = mkdtempSync(path.join(tmpdir(), "ms-mesh-"));
  chmodSync(open, 0o755);
  const other = mkdtempSync(path.join(tmpdir(), "ms-other-"));
  chmodSync(other, 0o700);
  const link = path.join(tmpdir(), `ms-mesh-link${process.pid}`);
  symlinkSync(good, link);
  const empty = mkdtempSync(path.join(tmpdir(), "ms-mesh-"));
  chmodSync(empty, 0o700);
  t.after(() => { for (const d of [open, other, link, empty]) rmSync(d, { recursive: true, force: true }); });

  const nothing = { ready: () => null, lastPick: () => null };
  for (const dir of [nested, open, other, link, path.join(tmpdir(), "ms-mesh-nope"), "relative/ms-mesh-x", empty]) {
    const before = existsSync(dir) && !dir.endsWith("link" + process.pid) ? readdirSync(dir) : [];
    const r = await captured((io) => meshRowsVerb(["claude", "any", dir], nothing, { ...io, poll: async () => { throw new Error("must not be read"); } }));
    assert.equal(r.code, 2, `${dir}: ${r.stderr}`);
    assert.equal(r.stdout, "", "nothing on stdout for fzf to show");
    if (existsSync(dir) && !dir.endsWith("link" + process.pid)) assert.deepEqual(readdirSync(dir), before, `${dir} was written to`);
  }
  for (const argv of [[], ["claude"], ["claude", "any"], ["gemini", "any", good], ["claude", "most", good], ["codex", "fable", good], ["claude", "any", good, "extra"]]) {
    const r = await captured((io) => meshRowsVerb(argv, nothing, io));
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.stderr, /usage: ms _mesh_rows/);
  }
});

test("ms _mesh_rows and ms _mesh_poll are registered verbs, and through the real CLI bad arguments are exit 2 with nothing on stdout", () => {
  const { home, msHome } = tempHome();
  const r = run(["_mesh_rows", "claude", "any", path.join(tmpdir(), "ms-mesh-missing")], { HOME: home, MS_HOME: msHome });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^ms _mesh_rows: /m);
  for (const argv of [["_mesh_poll"], ["_mesh_poll", "../alpha"], ["_mesh_poll", "alpha", "-x"]]) {
    const p = run(argv, { HOME: home, MS_HOME: msHome });
    assert.equal(p.code, 2, `${argv.join(" ")}: ${p.stderr}`);
    assert.equal(p.stdout, "");
    assert.match(p.stderr, /^usage: ms _mesh_poll <account>\.\.\.$/m);
  }
});
