// src/mesh.ts
//
// `ms claude mesh` / `ms codex mesh`: the account, chosen by hand.
//
// The chooser (src/pick.ts) answers "which account" at every launch, every
// wall and every rebalance, and by its own rule it is right. This is the one
// place a human overrules it: the provider's accounts in an fzf picker —
// ranked exactly as a plain launch ranks them, the account that launch would
// take starred, the ones it cannot use crossed out, everything known about
// each in a preview — and the account picked is launched PINNED. The pin
// (`pinnedAccount` on the session row) keeps rebalance off the session
// (src/rebalance.ts `decide`); a wall still rotates it, and that move ends the
// pin (src/recover.ts). A hand pick is the human's answer, not the chooser's,
// so it is never remembered as a last pick either.
//
// Nothing here writes to the store, so a cancel leaves nothing behind: the
// launch turns it into exit 130 before it has checked a credential, prepared
// a home or touched tmux. The one thing the picker makes is a private temp
// directory (0700, under os.tmpdir()) of pre-rendered previews, one file per
// account, which fzf `cat`s. It is removed the moment fzf returns — before
// the launch respawns this pane or execs anything over this process, either
// of which would otherwise leak it.
//
// fzf is the human's own, found on PATH and run on their terminal (it opens
// /dev/tty itself): as a tmux popup in a real pane that someone is looking at
// on a client that can draw one, when the fzf is new enough (0.53+), full
// screen otherwise — inside a display-popup too, which has no pane of its
// own. ctrl-r runs `ms _mesh_rows`, which has a fresh reading taken (by `ms
// _mesh_poll`, in a process fzf cannot kill), re-renders the previews and
// prints the header's status line and the rows again. With no fzf on PATH, a
// numbered menu on the terminal does the same job.
//
// Everything a provider or the registry says is display text here and never
// shell text: a name is validated against the registry's own pattern before
// it becomes anything, the only words that ever reach a shell are this tool's
// own path, the picker's directory, the verb and two fixed enums (all
// quoted), and control characters are stripped before any of it reaches the
// terminal.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveOnPath } from "./exec.ts";
import { msBinary } from "./paths.ts";
import { pickAccounts, type Need, type Window } from "./pick.ts";
import { NAME_PATTERN, findAccount, loadRegistry, type Provider, type Registry } from "./registry.ts";
import { DEFAULT_MAX_AGE_MS, ageLabel, getSnapshot, lastSnapshot, toPickInputs, type AccountUsage, type Snapshot } from "./snapshot.ts";
import { openState, type SessionRow } from "./state.ts";
import { computeAccount, sessionsByAccount, type AccountState } from "./status.ts";
import { Tmux, shellQuote } from "./tmux.ts";

/** Why this device cannot launch an account, or null when it can. It is the
 *  launch's own credential check (`launchCredential`, src/launch.ts), handed
 *  in rather than imported, so this module never reads a credential of its
 *  own — and so it does not import the launch that imports it. */
export type Ready = (name: string) => { error: string } | null;

export type MeshMark = "★" | "✗" | " ";
export type MeshPane = { pane: string; state: string; cwd: string };

/** One account, as the picker shows it. Every string in it is display-safe. */
export type MeshRow = {
  /** fzf's hidden field: this account's index in the picker's key space
   *  (`MeshView.names`). Never its name, and never its place on screen,
   *  which a reload is free to change. */
  key: string;
  name: string;
  provider: Provider;
  /** The registry's label, or the name when it has none. */
  label: string;
  email: string | null;
  shared: boolean;
  /** `ms status`'s STATE word for the account. */
  state: AccountState;
  mark: MeshMark;
  /** 1-based place among the accounts with room, or null when passed over. */
  rank: number | null;
  /** Why the chooser passed it over, in `pickAccounts`'s own words. */
  out: string | null;
  /** Why this device cannot launch it, or null when it can. */
  unready: string | null;
  usage: AccountUsage["usage"];
  observedAt: number | null;
  stale: boolean;
  error: string | null;
  panes: MeshPane[];
};

export type MeshView = {
  provider: Provider;
  need: Need;
  /** The key space: account names, in the order the keys index. */
  names: string[];
  /** Display order: the chooser's ranking, then the rest by name. */
  rows: MeshRow[];
  /** How many accounts have room — the "of N" in a preview's Rank line. */
  ranked: number;
  /** Why a row carries ★: the chooser ranked it first, or — nothing ranked,
   *  because no reading could be taken — it is the launch's remembered pick,
   *  which is what a plain launch takes then. Null when there is no ★. */
  starredBy: "ranking" | "last pick" | null;
  /** When the newest of these accounts' readings was taken, or null when none
   *  has ever been read. Not the snapshot's `takenAt`: that moves on every
   *  poll, the ones that read nothing included. */
  readAt: number | null;
  /** Every account's reading failed for a transient reason: the launch's own
   *  "usage unreachable" (`usageUnreachable`, src/launch.ts). */
  unreachable: boolean;
  /** The clock everything relative ("in 2h", "14s old") is measured from. */
  now: number;
};

/** Exit codes this module hands the launch with an error. */
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const DASH = "—";
/** How long `fzf --version` gets. It answers at once; this only stops a
 *  wedged binary from hanging a launch. */
const VERSION_TIMEOUT_MS = 3_000;
/** fzf learned `--tmux` (and `--no-tmux`) in 0.53.0. */
const POPUP_SINCE: FzfVersion = [0, 53, 0];
/** fzf learned `--id-nth` — finding the item it tracks again after a
 *  reload — in 0.71.0. */
const TRACK_SINCE: FzfVersion = [0, 71, 0];
/** A preview lists this many panes, then counts the rest. */
const MAX_PANES = 6;
/** Bad answers the menu re-asks before it gives up. */
const MENU_REPROMPTS = 3;
const BAR_CELLS = 12;
const ROWS_FILE = "rows.json";
const DIR_PREFIX = "ms-mesh-";

// --- Display text ---------------------------------------------------------

/**
 * Text from anywhere outside this process — a label, an e-mail, a provider's
 * error, a cwd — with every control character removed, so none of it can
 * move the cursor, recolour the screen or open an escape sequence on the
 * human's terminal. C1 (U+0080–U+009F) goes too: some terminals read U+009B
 * as the start of a sequence on its own.
 */
export function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

const SGR = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33", star: "1;33" } as const;
const paint = (text: string, sgr: string | null): string => (sgr ? `\x1b[${sgr}m${text}\x1b[0m` : text);

/** Below 70 plain, 70 to 89 yellow, 90 and up red: one scale for the rows'
 *  numbers and the preview's bars. */
function severity(used: number | null): string | null {
  if (used === null) return null;
  return used >= 90 ? SGR.red : used >= 70 ? SGR.yellow : null;
}

const usedOf = (w: Window | null | undefined): number | null => (w && Number.isFinite(w.usedPercent) ? w.usedPercent : null);
/** Whole percent, rounded DOWN: 99.6 is not full — the chooser still ranks it
 *  — and must not read as 100. */
const percentText = (used: number | null): string => (used === null ? DASH : `${Math.floor(used)}%`);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number): string => String(n).padStart(2, "0");
const clockAt = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
/** `%a %H:%M`, local. */
const weekdayAt = (ms: number): string => `${WEEKDAYS[new Date(ms).getDay()]} ${clockAt(ms)}`;
/** Today's reset is a clock time; any other day's carries its weekday. */
function resetClock(ms: number, now: number): string {
  return new Date(ms).toDateString() === new Date(now).toDateString() ? clockAt(ms) : weekdayAt(ms);
}
function untilText(ms: number, now: number): string {
  const minutes = Math.floor((ms - now) / 60_000);
  if (minutes < 0) return "passed";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The soonest reset among the windows the RANKING reads — the week, and the
 *  Fable week for a run that needs it — not the 5 h window, which resets four
 *  times a day and orders nothing. */
function rankingReset(row: MeshRow, need: Need): number | null {
  const u = row.usage;
  const windows = need === "fable" ? [u?.weeklyAll, u?.weeklyFable] : [u?.weeklyAll];
  const times = windows.map((w) => (w?.resetsAt ? Date.parse(w.resetsAt) : Number.NaN)).filter((t) => Number.isFinite(t));
  return times.length ? Math.min(...times) : null;
}

function tilde(cwd: string): string {
  const home = process.env.HOME;
  return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

// --- The rows -------------------------------------------------------------

export type MeshInput = {
  provider: Provider;
  need: Need;
  /** The key space: account names, a row's key is its index here. */
  names: string[];
  registry: Registry;
  snapshot: Snapshot;
  ready: Ready;
  /** The launch's remembered pick for this provider and need (`readLastPick`,
   *  src/launch.ts), or null. A plain launch takes it when usage is
   *  unreachable, so then it is the ★. Handed in, like `ready`. */
  lastPick?: string | null;
  /** The store's sessions, any state: the finished ones are left out here,
   *  by `ms status`'s own rule (`sessionsByAccount`). */
  sessions: { id: string; provider: string; account: string; state: string; pane: string; cwd: string }[];
  now: number;
};

/**
 * Every account in the key space as a row: ordered, marked, and carrying all
 * a row or a preview shows. Pure.
 *
 * The ranking is the launch's own call, word for word — this provider's
 * registered rows, the whole snapshot around them (`toPickInputs` reads more
 * than the rows), the same need — so ★ is exactly what a plain `ms claude`
 * would launch on right now, and every ✗ carries the reason the chooser
 * would give. An account it ranks but this device holds no credential for is
 * crossed out too, while keeping its place in the ranking: it has room, and
 * cannot be launched here.
 *
 * With nothing ranked because no reading could be taken (usage unreachable),
 * a plain launch takes its remembered pick, and so the ★ is that, leading the
 * list: the default row is always what a plain launch would run.
 */
export function meshRows(input: MeshInput): MeshView {
  const { provider, need, registry, snapshot } = input;
  const wanted = new Set(input.names);
  const rows = snapshot.accounts.filter((a) => a.provider === provider && wanted.has(a.name));
  const inputs = toPickInputs({ ...snapshot, accounts: rows });
  const ranking = pickAccounts(inputs, need);
  const rankOf = new Map(ranking.picks.map((p, i) => [p.name, i + 1]));
  const outOf = new Map(ranking.out.map((o) => [o.name, o.why]));
  const usageOf = new Map(rows.map((a) => [a.name, a]));
  // The launch's own test (`usageUnreachable`): every reading failed in
  // passing, and none of them is recent enough to stand in for one.
  const unreachable = rows.length > 0 && rows.every((a) => a.errorKind === "transient") && inputs.every((i) => i.error !== null);
  // And the launch's own answer to it: the remembered pick, while it is still
  // registered (`launchWith`, src/launch.ts).
  const last = input.lastPick ?? null;
  const remembered = !ranking.picks.length && unreachable && last !== null && wanted.has(last) && findAccount(registry, last, provider) ? last : null;
  const star = ranking.picks[0]?.name ?? remembered;
  const seen = rows.map((a) => a.observedAt).filter((t): t is number => t !== null);
  const live = sessionsByAccount(input.sessions);
  const cwdOf = new Map(input.sessions.map((s) => [s.id, s.cwd]));

  const all = input.names.map((name, i): MeshRow => {
    const registered = findAccount(registry, name, provider);
    // A name with no reading at all is an account registered since the
    // snapshot was last written; it reads exactly as `toPickInputs` reads it.
    const a: AccountUsage = usageOf.get(name)
      ?? { name, provider, shared: registered?.shared ?? false, usage: null, error: null, errorKind: null, observedAt: null, stale: true };
    const unready = registered ? (input.ready(name)?.error ?? null) : "it is no longer registered";
    const words = computeAccount(a, registry, unready === null);
    const rank = rankOf.get(name) ?? null;
    const out = rank !== null ? null : (outOf.get(name) ?? "no usage reading yet");
    return {
      key: String(i),
      name,
      provider,
      label: clean(words.label),
      email: words.email === null ? null : clean(words.email),
      // The registry says whether an account is shared; a reading only copies it.
      shared: registered?.shared ?? a.shared,
      state: words.state,
      mark: name === star ? "★" : out !== null || unready !== null ? "✗" : " ",
      rank,
      out: out === null ? null : clean(out),
      unready: unready === null ? null : clean(unready),
      usage: a.usage,
      observedAt: a.observedAt,
      stale: a.stale,
      error: a.error === null ? null : clean(a.error),
      panes: (live.get(`${provider}:${name}`) ?? []).map((s) => ({ pane: clean(s.pane), state: clean(s.state), cwd: clean(cwdOf.get(s.id) ?? "") })),
    };
  });
  const ranked = all.filter((r) => r.rank !== null).sort((x, y) => x.rank! - y.rank!);
  // A ★ the ranking did not give (the remembered pick) heads the rest.
  const rest = all.filter((r) => r.rank === null)
    .sort((x, y) => Number(y.name === star) - Number(x.name === star) || x.name.localeCompare(y.name));
  return {
    provider,
    need,
    names: [...input.names],
    rows: [...ranked, ...rest],
    ranked: ranked.length,
    starredBy: ranking.picks.length ? "ranking" : remembered !== null ? "last pick" : null,
    readAt: seen.length ? Math.max(...seen) : null,
    unreachable,
    now: input.now,
  };
}

export type RowWidths = { name: number; state: number };

export function rowWidths(rows: MeshRow[]): RowWidths {
  return { name: Math.max(0, ...rows.map((r) => r.name.length)), state: Math.max(0, ...rows.map((r) => r.state.length)) };
}

/**
 * One row as fzf shows it (everything after the hidden key):
 * `<mark> <name> <state> 5h NN% wk NN% [fable NN%] <resets> [N panes]`.
 *
 * Padding is counted on the text and kept OUTSIDE the colour codes, so the
 * columns line up whatever is painted. A ✗ row is dim throughout, its numbers
 * keeping their colour under the dim; ★ is bold yellow; names are bold.
 */
export function renderRow(row: MeshRow, view: Pick<MeshView, "provider" | "need">, widths: RowWidths): string {
  const crossed = row.mark === "✗";
  const tone = (sgr: string | null): string | null => (crossed ? (sgr ? `${SGR.dim};${sgr}` : SGR.dim) : sgr);
  const cell = (text: string, width: number, sgr: string | null): string => paint(text, tone(sgr)) + " ".repeat(Math.max(0, width - text.length));
  const percent = (label: string, w: Window | null | undefined): string => {
    const used = usedOf(w);
    const text = percentText(used);
    return `${paint(label, tone(null))} ${" ".repeat(Math.max(0, 4 - text.length))}${paint(text, tone(severity(used)))}`;
  };
  const reset = rankingReset(row, view.need);
  const parts = [
    row.mark === "★" ? paint("★", SGR.star) : paint(row.mark, crossed ? SGR.dim : null),
    " ",
    cell(row.name, widths.name, crossed ? null : SGR.bold),
    "  ",
    cell(row.state, widths.state, null),
    "  ",
    percent("5h", row.usage?.session),
    "  ",
    percent("wk", row.usage?.weeklyAll),
    // Codex reports no Fable-scoped window at all (src/providers/codex-usage.ts).
    ...(view.provider === "claude" ? ["  ", percent("fable", row.usage?.weeklyFable)] : []),
    "  ",
    cell(reset === null ? DASH : weekdayAt(reset), 9, null),
    ...(row.panes.length ? ["  ", paint(`${row.panes.length} pane${row.panes.length === 1 ? "" : "s"}`, tone(null))] : []),
  ];
  return parts.join("").trimEnd();
}

export function renderRows(view: MeshView): string[] {
  const widths = rowWidths(view.rows);
  return view.rows.map((r) => renderRow(r, view, widths));
}

/** The hidden key of the header's status line: never a row's (those are
 *  digits), so nothing can mistake it for one. */
const STATUS_KEY = "-";

/**
 * What fzf reads on stdin: the header's status line first (★ and the
 * reading's age, `meshHeader`), which `--header-lines 1` keeps out of the
 * list, then `<key>\t<row>`, one line per account. ctrl-r's reload prints the
 * same, so the status line is redrawn with the rows it describes; a fixed
 * `--header` would go on promising a ★ the new rows no longer have.
 */
export function fzfInput(view: MeshView): string {
  const lines = renderRows(view);
  return `${STATUS_KEY}\t${meshHeader(view)[1]}\n` + view.rows.map((r, i) => `${r.key}\t${lines[i]}\n`).join("");
}

// --- The preview and the header ---------------------------------------------

const field = (name: string, text: string): string => ` ${name.padEnd(10)}${text}`;

function windowText(read: boolean, w: Window | null | undefined, now: number): string {
  // No reading at all: the Reading line says why, once, rather than three
  // windows each saying "unknown".
  if (!read) return DASH;
  if (!w) return `${DASH}  (not reported)`;
  const used = usedOf(w);
  const filled = used === null ? 0 : Math.max(0, Math.min(BAR_CELLS, Math.round((used / 100) * BAR_CELLS)));
  const bar = `[${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}]`;
  const text = percentText(used);
  const at = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
  const reset = Number.isFinite(at) ? `  resets ${resetClock(at, now)} (${untilText(at, now)})` : "";
  return `${paint(bar, severity(used))} ${" ".repeat(Math.max(0, 4 - text.length))}${paint(text, severity(used))}${reset}`;
}

function statusText(row: MeshRow, view: MeshView): string {
  const star = paint("★", SGR.star);
  if (row.mark === "★" && view.starredBy === "last pick") {
    return `${row.state} — ${star} the last pick: what \`ms ${view.provider}\` launches while usage is unreachable`;
  }
  if (row.mark === "★") return `${row.state} — ${star} what \`ms ${view.provider}\` would pick now`;
  if (row.rank !== null) return `${row.state} — has room`;
  const why = row.out ?? "not ranked";
  // `pickAccounts` already says "error: …" for a reading that failed.
  return why.startsWith("error: ") ? why : `out — ${why}`;
}

function readingText(row: MeshRow, now: number): string {
  const age = row.observedAt === null ? null : ageLabel(now - row.observedAt);
  if (row.error) return age === null ? row.error : `${row.error} (last good reading ${age} old)`;
  if (age === null) return "no reading yet";
  return row.stale ? `stale (read at ${clockAt(row.observedAt!)}, ${age} ago)` : `${age} old`;
}

/**
 * One account's preview: who it is, where the chooser puts it, its windows,
 * whether this device can launch it, what already runs on it, how old the
 * reading is, and what enter does. Plain text with light colour; every field
 * may be missing, and says so rather than failing.
 */
export function renderPreview(row: MeshRow, view: MeshView): string {
  const who = [paint(row.name, SGR.bold)];
  // The label only when it says more than the name does.
  if (row.label && row.label.toLowerCase() !== row.name.toLowerCase()) who.push(row.label);
  if (row.email) who.push(row.email);
  who.push(row.shared ? `${row.provider}, shared` : row.provider);
  const read = row.usage !== null;
  const lines = [
    ` ${who.join("  ·  ")}`,
    ` ${"─".repeat(42)}`,
    field("Status", statusText(row, view)),
    field("Rank", row.rank !== null ? `${row.rank} of ${view.ranked} with room (need: ${view.need})` : `not ranked (need: ${view.need})`),
    field("5h", windowText(read, row.usage?.session, view.now)),
    field("Week", windowText(read, row.usage?.weeklyAll, view.now)),
    ...(view.provider === "claude" ? [field("Fable", windowText(read, row.usage?.weeklyFable, view.now))] : []),
    field("Here", row.unready !== null
      ? paint(`✗ ${row.unready}`, SGR.red)
      : `${row.provider === "codex" ? "codex home logged in here" : "launch token on this device"} ${paint("✓", SGR.green)}`),
  ];
  if (!row.panes.length) lines.push(field("Panes", "none"));
  else {
    const shown = row.panes.slice(0, MAX_PANES).map((p) => `${p.pane} ${p.state} ${tilde(p.cwd)}`.trimEnd());
    if (row.panes.length > MAX_PANES) shown.push(`+${row.panes.length - MAX_PANES} more`);
    shown.forEach((text, i) => lines.push(field(i === 0 ? "Panes" : "", text)));
  }
  lines.push(field("Reading", readingText(row, view.now)), "");
  if (row.unready !== null) {
    lines.push(` this device cannot launch ${row.name}: enter would be refused.`);
  } else {
    if (row.out !== null) lines.push(` ${row.name} is out of the ranking — enter launches it anyway; the first wall rotates it.`);
    lines.push(
      ` enter launches here and pins this pane to ${row.name}: rebalance won't move it;`,
      " a usage wall still will (and ends the pin).",
    );
  }
  return lines.join("\n") + "\n";
}

const HEADER_KEYS = "enter: launch here (pinned) · ctrl-r: refresh usage · esc: cancel";

/** fzf's two header lines: the keys, then what ★ means and how old the
 *  newest reading behind it is — or why there is no ★. The first is fixed
 *  (`--header`); the second travels with the rows (`fzfInput`). */
export function meshHeader(view: MeshView): [string, string] {
  const cmd = `ms ${view.provider}`;
  const age = view.readAt === null ? null : ageLabel(view.now - view.readAt);
  const star = paint("★", SGR.star);
  if (view.unreachable) {
    const newest = age === null ? "nothing read yet" : `newest reading ${age} old`;
    return [HEADER_KEYS, view.starredBy === "last pick"
      ? `usage unreachable — ${star} the last pick, what plain \`${cmd}\` launches now · ${newest}`
      : `usage unreachable — no account could be read just now · ${newest}`];
  }
  const reading = age === null ? "no usage reading yet" : `usage ${age} old`;
  return [HEADER_KEYS, view.starredBy !== null
    ? `${star} what plain \`${cmd}\` would pick · ${reading}`
    : `no account has room — plain \`${cmd}\` would refuse · ${reading}`];
}

// --- fzf -------------------------------------------------------------------

export type FzfVersion = readonly [number, number, number];

export function parseFzfVersion(out: string): FzfVersion | null {
  const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

function atLeast(v: FzfVersion | null, min: FzfVersion): boolean {
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! > min[i]!;
  return true;
}

const versions = new Map<string, FzfVersion | null>();

/** `fzf --version`, asked once per binary per process, and bounded. */
export function fzfVersion(fzf: string): FzfVersion | null {
  if (!versions.has(fzf)) {
    const r = spawnSync(fzf, ["--version"], { encoding: "utf8", timeout: VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    versions.set(fzf, r.status === 0 ? parseFzfVersion(r.stdout ?? "") : null);
  }
  return versions.get(fzf)!;
}

/**
 * fzf ends an action's argument at its closing delimiter and allows no
 * escaping, so `reload(...)` breaks on a path holding a `)`. Any of these
 * pairs is the same action to fzf; the first whose closer the argument does
 * not contain is used.
 */
const ACTION_DELIMITERS: readonly (readonly [string, string])[] = [
  ["(", ")"], ["[", "]"], ["~", "~"], ["!", "!"], ["@", "@"], ["#", "#"], ["%", "%"], ["^", "^"], ["&", "&"], ["*", "*"], [";", ";"], ["|", "|"],
];

export type FzfArgsInput = {
  provider: Provider;
  need: Need;
  /** The picker's private directory: the previews, and ctrl-r's target. */
  dir: string;
  /** This tool's own binary, for ctrl-r (`msBinary()`). */
  self: string;
  /** A real tmux pane (`$TMUX` and `$TMUX_PANE` both set) whose session is
   *  watched only by clients that can draw a popup (`paneWatched`). */
  inPane: boolean;
  fzfVersion: FzfVersion | null;
};

/**
 * fzf's command line.
 *
 * The two commands fzf will hand to `$SHELL -c` — the preview and ctrl-r's
 * reload — are made of nothing but this tool's path, the picker's directory
 * and three fixed words (`_mesh_rows`, the provider, the need), every one
 * single-quoted: no label, e-mail or error ever reaches a shell. fzf substitutes `{1}`, the row's hidden key (digits
 * only), already quoted. The human's FZF_DEFAULT_OPTS still applies; the
 * flags here are explicit, so they win.
 */
export function fzfArgs(i: FzfArgsInput): string[] {
  const reload = shellQuote([i.self, "_mesh_rows", i.provider, i.need, i.dir]);
  const pair = ACTION_DELIMITERS.find(([, close]) => !reload.includes(close));
  // A reload re-ranks the rows, and fzf keeps the cursor's PLACE across one,
  // not its row: enter straight after a refresh would launch, and pin,
  // whichever account moved under it. Tracked by its hidden key (field 1)
  // for that one reload, the cursor stays on the account. An older fzf keeps
  // the place, and its preview shows which account that now is.
  const track = atLeast(i.fzfVersion, TRACK_SINCE);
  const args = [
    "--layout=reverse", "--ansi", "--no-sort", "--delimiter", "\t", "--with-nth", "2..",
    "--prompt", `${i.provider} account> `,
    // The keys. The status line under them is the input's first line
    // (`fzfInput`), so a reload redraws it with the rows.
    "--header", HEADER_KEYS, "--header-lines", "1",
    "--preview", `cat ${shellQuote([i.dir])}/{1}`,
    "--preview-window", "right,50%,wrap,<80(down,50%,wrap)",
    // The `:` form needs no closing delimiter, but nothing may follow it — so
    // it is only the fallback for a path that holds every closer above.
    "--bind", `ctrl-r:${track ? "track-current+" : ""}${pair ? `reload${pair[0]}${reload}${pair[1]}+refresh-preview` : `reload:${reload}`}`,
    ...(track ? ["--id-nth", "1"] : []),
  ];
  // A popup only from a real pane. A display-popup has `$TMUX` but no pane
  // of its own, and a popup cannot open another one. No popup is said out
  // loud to an fzf that knows the flag: a `--tmux` in the human's
  // FZF_DEFAULT_OPTS would otherwise open one anyway, where nobody can see it
  // — and fail ("no current client", which reads as a cancel) or never return.
  if (atLeast(i.fzfVersion, POPUP_SINCE)) args.push(...(i.inPane ? ["--tmux", "center,80%,60%"] : ["--no-tmux"]));
  return args;
}

/** The selected row's key: the first output line that is `<digits>\t…`, so a
 *  `--print-query` or `--expect` in FZF_DEFAULT_OPTS cannot be misread. */
export function selectedKey(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    const m = /^(\d+)\t/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

// --- The picker's directory ----------------------------------------------------

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Everything fzf and ctrl-r read from the picker's directory: one preview per
 * key (the file is named by the key, never by the account), and `rows.json`
 * — the key space and each account's latest reason for being out of the
 * ranking. ctrl-r rewrites both, so once fzf returns, the reason the launch
 * warns with is the one on the human's screen when they pressed enter.
 */
export function writeMeshDir(dir: string, view: MeshView): void {
  for (const row of view.rows) writeAtomic(path.join(dir, row.key), renderPreview(row, view));
  const out = view.names.map((n) => view.rows.find((r) => r.name === n)?.out ?? null);
  writeAtomic(path.join(dir, ROWS_FILE), JSON.stringify({ names: view.names, out }) + "\n");
}

/** `rows.json`, or null for anything that is not exactly what
 *  `writeMeshDir` writes: every name must still pass the registry's own
 *  pattern before it is used as anything. */
function readMeshDir(dir: string): { names: string[]; out: (string | null)[] } | null {
  try {
    const j = JSON.parse(readFileSync(path.join(dir, ROWS_FILE), "utf8")) as { names?: unknown; out?: unknown };
    const names = j?.names;
    if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === "string" && NAME_PATTERN.test(n))) return null;
    const out = Array.isArray(j.out) ? j.out : [];
    return { names: names as string[], out: names.map((_, i) => (typeof out[i] === "string" ? clean(out[i] as string) : null)) };
  } catch {
    return null;
  }
}

/**
 * Why `dir` is not a picker's directory, or null when it is: an existing
 * directory (not a link to one) directly under os.tmpdir(), named `ms-mesh-*`,
 * owned by this user and 0700. ctrl-r writes into it, so anything else —
 * whatever put that path on its command line — is refused before a byte is
 * written.
 */
export function meshDirProblem(dir: string): string | null {
  if (!path.isAbsolute(dir)) return "not an absolute path";
  if (!new RegExp(`^${DIR_PREFIX}[A-Za-z0-9]+$`).test(path.basename(dir))) return `not named ${DIR_PREFIX}*`;
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return "no such directory";
  }
  if (!st.isDirectory()) return "not a directory";
  try {
    if (realpathSync(path.dirname(dir)) !== realpathSync(tmpdir())) return "not directly under the temp directory";
  } catch {
    return "not directly under the temp directory";
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "owned by another user";
  if ((st.mode & 0o777) !== 0o700) return "not mode 0700";
  return null;
}

// --- Gathering ----------------------------------------------------------------

type ViewOptions = {
  provider: Provider;
  need: Need;
  ready: Ready;
  /** Read after the snapshot, so it is as current as the reading beside it. */
  lastPick: () => string | null;
  /** The key space; the registry's accounts for this provider when absent. */
  names?: string[];
  snapshot: () => Promise<Snapshot>;
  now: number;
};

async function meshView(o: ViewOptions): Promise<MeshView | { error: string }> {
  const { registry, parseError } = loadRegistry();
  if (parseError) return { error: `cannot read the registry: ${parseError}` };
  const names = o.names ?? registry.accounts.filter((a) => a.provider === o.provider).map((a) => a.name);
  const snapshot = await o.snapshot();
  // The registry can break between our read and the snapshot's own.
  if (snapshot.registryError) return { error: `cannot read the registry: ${snapshot.registryError}` };
  let sessions: SessionRow[] = [];
  try {
    const st = openState();
    try { sessions = st.listSessions(); } finally { st.close(); }
  } catch {
    /* the panes column is a courtesy; a store we cannot read costs only that */
  }
  return meshRows({ provider: o.provider, need: o.need, names, registry, snapshot, ready: o.ready, lastPick: o.lastPick(), sessions, now: o.now });
}

// --- Choosing ------------------------------------------------------------------

export type ChooseResult =
  | { name: string; out: string | null }
  /** `signal`: what ended the picker when it was not the human's esc — the
   *  terminal closing, a kill. Nothing is launched either way. */
  | { cancelled: true; signal?: NodeJS.Signals }
  | { error: string; exit: number };

export type FzfRun = (fzf: string, args: string[], input: string, env: NodeJS.ProcessEnv) =>
  { status: number | null; signal: NodeJS.Signals | null; stdout: string; error?: Error };

/** fzf, unbounded — it is waiting on a person. Rows go in on stdin, the
 *  selection comes back on stdout, and fzf draws on the terminal itself. */
const runFzf: FzfRun = (fzf, args, input, env) => {
  const r = spawnSync(fzf, args, { input, stdio: ["pipe", "pipe", "inherit"], encoding: "utf8", env });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", error: r.error };
};

export type ChooseDeps = {
  provider: Provider;
  need: Need;
  ready: Ready;
  /** The launch's remembered pick (`readLastPick`, src/launch.ts): the ★ when
   *  usage is unreachable, as it is a plain launch's choice then. Default:
   *  none. */
  lastPick?: () => string | null;
  /** The terminal: fzf opens /dev/tty itself, and this is checked first and
   *  read by the menu. `MS_MESH_TTY` points it elsewhere (the tests). */
  tty?: string;
  /** fzf's path, or null for none. Default: the first `fzf` on PATH. */
  fzf?: string | null;
  run?: FzfRun;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** This tool's binary, for ctrl-r. Default `msBinary()`. */
  self?: string;
  /** Where the menu prints. Default: the terminal. */
  write?: (s: string) => void;
  /** The usage reading. Default: the coalesced snapshot, cache first. */
  snapshot?: () => Promise<Snapshot>;
};

/**
 * Can a popup reach whoever is looking at this pane? fzf draws its popup on
 * the client tmux picks for the pane's session. With no client attached — a
 * command typed into a detached session by something other than a person —
 * `fzf --tmux` fails or never returns (fzf 0.73.1: still running 20 s later),
 * where plain fzf sits on the pane for whoever attaches. A control-mode
 * client (`tmux -C`: iTerm2's tmux integration, scripts) is attached but
 * draws nothing, so a popup handed to it hangs the same way; and tmux hands
 * the popup to the client most recently active, which with a terminal beside
 * it can still be the control client. So: at least one client, and none in
 * control mode. One bounded tmux call; any other answer is not a yes.
 */
function paneWatched(env: NodeJS.ProcessEnv): boolean {
  const socket = (env.TMUX ?? "").split(",")[0];
  if (!socket || !env.TMUX_PANE) return false;
  const r = new Tmux(socket).run(["list-clients", "-t", env.TMUX_PANE, "-F", "#{client_control_mode}"]);
  const modes = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return r.code === 0 && modes.length > 0 && modes.every((m) => m === "0");
}

function opens(file: string): boolean {
  try {
    closeSync(openSync(file, "r"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the human which account. Resolves to the name (with the chooser's
 * reason it was passed over, when it was), a cancel, or an error — and never
 * writes anything but the picker's own temp directory, gone by the time this
 * returns.
 */
export async function chooseAccount(deps: ChooseDeps): Promise<ChooseResult> {
  const env = deps.env ?? process.env;
  const tty = deps.tty ?? (env.MS_MESH_TTY || "/dev/tty");
  // First, before a reading is taken: without a terminal there is nobody to
  // ask, and fzf would only fail on it later.
  if (!opens(tty)) return { error: "mesh needs a terminal", exit: EXIT_USAGE };
  const view = await meshView({
    provider: deps.provider,
    need: deps.need,
    ready: deps.ready,
    lastPick: deps.lastPick ?? (() => null),
    snapshot: deps.snapshot ?? (() => getSnapshot({ maxAgeMs: DEFAULT_MAX_AGE_MS })),
    now: (deps.now ?? Date.now)(),
  });
  if ("error" in view) return { error: view.error, exit: EXIT_FAILED };
  if (!view.rows.length) return { error: `no ${deps.provider} account is registered`, exit: EXIT_FAILED };
  const fzf = deps.fzf !== undefined ? deps.fzf : resolveOnPath("fzf");
  return fzf ? await pickWithFzf(fzf, view, deps, env) : pickFromMenu(view, tty, deps.write);
}

/** What ends a terminal program without asking it: the terminal going away
 *  (SIGHUP — the pane killed, the window closed), ctrl-c arriving as a
 *  signal, and kill's default. */
const ENDING_SIGNALS: readonly NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

/**
 * fzf, with the signals that would end this process held for as long as it
 * runs.
 *
 * Unheld, any of them kills node inside spawnSync, before the `finally` that
 * removes the picker's directory — which then stays in $TMPDIR with every
 * account's name, e-mail, usage and pane directories in it. Held, node lives
 * on: fzf dies of the same hangup (or finishes, when the signal was ours
 * alone), spawnSync returns, the directory goes, and only then is the signal
 * answered: as a cancel, whatever fzf printed, so nothing is ever launched on
 * the far side of one.
 */
async function pickWithFzf(fzf: string, view: MeshView, deps: ChooseDeps, env: NodeJS.ProcessEnv): Promise<ChooseResult> {
  const held: { signal: NodeJS.Signals | null } = { signal: null };
  const hold = (signal: NodeJS.Signals) => { held.signal ??= signal; };
  for (const s of ENDING_SIGNALS) process.on(s, hold);
  try {
    const result = pickInDir(fzf, view, deps, env);
    // A signal that came while spawnSync held the thread is caught but not
    // yet handed over: node delivers it on the event loop's next turn.
    await new Promise((resolve) => setImmediate(resolve));
    return held.signal ? { cancelled: true, signal: held.signal } : result;
  } finally {
    for (const s of ENDING_SIGNALS) process.off(s, hold);
  }
}

/** fzf over the picker's own directory, which is gone again by the time this
 *  returns or throws. */
function pickInDir(fzf: string, view: MeshView, deps: ChooseDeps, env: NodeJS.ProcessEnv): ChooseResult {
  const self = deps.self ?? msBinary();
  const dir = mkdtempSync(path.join(tmpdir(), DIR_PREFIX));
  try {
    chmodSync(dir, 0o700);
    // fzf reads `{…}` as a placeholder anywhere in a command and has no way
    // to escape one; a path that holds a brace would be mangled.
    const braced = [self, dir].find((p) => /[{}]/.test(p));
    if (braced) return { error: `the picker cannot run from a path with { or } in it: ${braced}`, exit: EXIT_FAILED };
    writeMeshDir(dir, view);
    const args = fzfArgs({
      provider: view.provider,
      need: view.need,
      dir,
      self,
      inPane: !!env.TMUX && !!env.TMUX_PANE && paneWatched(env),
      fzfVersion: fzfVersion(fzf),
    });
    const r = (deps.run ?? runFzf)(fzf, args, fzfInput(view), env);
    if (r.error) return { error: `could not run ${fzf}: ${r.error.message}`, exit: EXIT_FAILED };
    // 130 is esc or ctrl-c; 1 is "nothing matched". Both are the human saying no.
    if (r.status === 130 || r.status === 1) return { cancelled: true };
    if (r.status !== 0) return { error: `fzf failed (${r.status === null ? `killed by ${r.signal}` : `exit ${r.status}`})`, exit: EXIT_FAILED };
    // A reload may have rewritten the reasons; the key space never changes.
    const latest = readMeshDir(dir);
    const names = latest?.names ?? view.names;
    const key = selectedKey(r.stdout);
    if (key === null || key >= names.length) return { error: "fzf returned no account", exit: EXIT_FAILED };
    return { name: names[key]!, out: latest ? (latest.out[key] ?? null) : (view.rows.find((x) => x.key === String(key))?.out ?? null) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Lines from a file descriptor, read synchronously: a terminal in canonical
 *  mode hands over one line per read, a file several. Null is end of input. */
function lineReader(fd: number): () => string | null {
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(1024);
  let buf = "";
  let ended = false;
  return () => {
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        return line;
      }
      if (ended) {
        if (!buf) return null;
        const last = buf;
        buf = "";
        return last;
      }
      let n = 0;
      try {
        n = readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        n = 0; // a terminal that has gone away reads as the end of input
      }
      if (n === 0) {
        ended = true;
        buf += decoder.end();
      } else {
        buf += decoder.write(chunk.subarray(0, n));
      }
    }
  };
}

/**
 * The picker without fzf: the same rows, numbered, and one question on the
 * terminal. Enter alone is row 1, which is ★ whenever there is one; `q` or
 * the end of input cancels; anything else is asked again, three times, and
 * then taken as a no.
 */
function pickFromMenu(view: MeshView, tty: string, write?: (s: string) => void): ChooseResult {
  let fd: number;
  try {
    fd = openSync(tty, "r");
  } catch {
    return { error: "mesh needs a terminal", exit: EXIT_USAGE };
  }
  let outFd = -1;
  const say = write ?? ((s: string) => {
    if (outFd < 0) outFd = openSync(tty, "a");
    writeSync(outFd, s);
  });
  try {
    const lines = renderRows(view);
    const width = String(lines.length).length;
    say(`${paint(`ms ${view.provider} mesh`, SGR.bold)}: no fzf on PATH, so a numbered list (brew install fzf for the picker)\n${meshHeader(view)[1]}\n`);
    lines.forEach((line, i) => say(`${String(i + 1).padStart(width)}  ${line}\n`));
    const next = lineReader(fd);
    for (let asked = 0; asked <= MENU_REPROMPTS; asked++) {
      say(`pick 1-${lines.length} [1], q to cancel: `);
      const answer = next();
      if (answer === null) {
        say("\n");
        return { cancelled: true };
      }
      const a = answer.trim();
      if (a === "q" || a === "Q") return { cancelled: true };
      const n = a === "" ? 1 : /^\d+$/.test(a) ? Number(a) : 0;
      if (n >= 1 && n <= lines.length) {
        const row = view.rows[n - 1]!;
        return { name: row.name, out: row.out };
      }
    }
    return { cancelled: true };
  } finally {
    closeSync(fd);
    if (outFd >= 0) closeSync(outFd);
  }
}

// --- ctrl-r: `ms _mesh_rows <provider> <need> <dir>` ------------------------------

const ROWS_USAGE = "usage: ms _mesh_rows <claude|codex> <any|fable> <dir>";
const POLL_USAGE = "usage: ms _mesh_poll <account>...";

/** What the reload needs from the launch, handed in by src/cli.ts as the
 *  picker gets it from the launch itself: which accounts this device can
 *  launch (`launchCredential`), and the remembered pick (`readLastPick`). */
export type LaunchFacts = {
  ready: (provider: Provider, name: string) => { error: string } | null;
  lastPick: (provider: Provider, need: Need) => string | null;
};

export type MeshRowsDeps = {
  /** A fresh reading of these accounts. Default: `pollApart`. */
  poll?: (names: string[]) => Promise<Snapshot>;
  now?: () => number;
  /** Where the rows go (fzf reads them) and where a refusal is said. Default:
   *  this process's stdout and stderr. A test hands in its own rather than
   *  replacing those streams: node:test reports through the same stdout, and
   *  a report written while the verb awaits would land in the capture. */
  out?: (s: string) => void;
  err?: (s: string) => void;
};

/**
 * ctrl-r's fresh reading, taken where fzf cannot reach it.
 *
 * fzf SIGKILLs the reload's whole process group when ctrl-r is pressed again
 * and when the picker closes with a reload still running — and a forced poll
 * refreshes every grant within a minute of its expiry. The token endpoint
 * spends the old refresh token as it answers, so a poll killed between that
 * answer and the write-back leaves the account holding a dead grant until
 * `ms accounts login`. So the poll is `ms _mesh_poll`, detached: a process
 * group (and session) of its own, which fzf's kill misses — killing this
 * process now costs the rows and never a grant. Scoped to the picker's
 * accounts: a Claude picker has no business refreshing Codex grants.
 *
 * Resolves to the snapshot file as that poll left it. Rejects when the poll
 * did not run or failed; the caller then serves the last file.
 */
async function pollApart(names: string[]): Promise<Snapshot> {
  const since = Date.now();
  const code = await new Promise<number | null>((resolve) => {
    try {
      const child = spawn(msBinary(), ["_mesh_poll", ...names], { detached: true, stdio: "ignore" });
      child.on("error", () => resolve(null));
      child.on("exit", (c) => resolve(c));
    } catch {
      resolve(null);
    }
  });
  if (code !== 0) throw new Error(code === null ? "the usage poll did not run" : `the usage poll exited ${code}`);
  // A file that poll did not rewrite (another process held the snapshot lock
  // throughout) is an old file, and is read as one.
  return lastSnapshot(since);
}

/**
 * `ms _mesh_poll <account>...`: a forced reading of these accounts, written
 * to the snapshot file, and nothing else — `pollApart` runs it detached so
 * that a token refresh, once begun, is always written back.
 */
export async function meshPollVerb(argv: string[]): Promise<number> {
  if (!argv.length || !argv.every((n) => NAME_PATTERN.test(n))) {
    process.stderr.write(`${POLL_USAGE}\n`);
    return EXIT_USAGE;
  }
  await getSnapshot({ maxAgeMs: 0, only: argv });
  return 0;
}

/**
 * fzf's ctrl-r: a FRESH reading of the same key space, the previews in the
 * picker's directory re-rendered from it, and on stdout exactly what fzf
 * reads — the header's status line and the rows (`fzfInput`), nothing else.
 * A reading that cannot be taken falls back on the last one on disk rather
 * than leaving the human an empty list.
 *
 * Internal (the `_` keeps reconciliation and the startup notices off it), and
 * careful with its one argument that is a path: a directory that is not
 * exactly a picker's own is refused, exit 2, before anything is written.
 */
export async function meshRowsVerb(argv: string[], launch: LaunchFacts, deps: MeshRowsDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => { process.stdout.write(s); });
  const err = deps.err ?? ((s: string) => { process.stderr.write(s); });
  const [provider, need, dir, ...extra] = argv;
  if ((provider !== "claude" && provider !== "codex") || (need !== "any" && need !== "fable") || !dir || extra.length
    || (provider === "codex" && need === "fable")) {
    err(`${ROWS_USAGE}\n`);
    return EXIT_USAGE;
  }
  const problem = meshDirProblem(dir);
  const keys = problem ? null : readMeshDir(dir);
  if (!keys) {
    err(`ms _mesh_rows: ${dir}: ${problem ?? `no ${ROWS_FILE} a picker wrote`}\n`);
    return EXIT_USAGE;
  }
  const poll = deps.poll ?? pollApart;
  const view = await meshView({
    provider,
    need,
    names: keys.names,
    ready: (name) => launch.ready(provider, name),
    lastPick: () => launch.lastPick(provider, need),
    snapshot: async () => {
      try {
        return await poll(keys.names);
      } catch {
        // Every row of it stale (`lastSnapshot`): an errorless reading from
        // days ago says `stale: false` too, and would rank as current.
        return lastSnapshot();
      }
    },
    now: (deps.now ?? Date.now)(),
  });
  if ("error" in view) {
    err(`ms _mesh_rows: ${view.error}\n`);
    return EXIT_FAILED;
  }
  writeMeshDir(dir, view);
  out(fzfInput(view));
  return 0;
}
