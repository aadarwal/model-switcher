// src/launch.ts
//
// `ms claude` and `ms codex` (spec §7): choose the account, write down what is
// about to run, and hand the running of it to tmux.
//
// One verb, twice. `launchWith(provider, argv)` is the whole sequence and
// `planFor(provider)` is everything the two providers do differently — which
// is four things: what a `need` can mean, what counts as a launch credential,
// what the account's own home must be told first, and the argv. Nothing else
// about a launch varies by CLI, and nothing else should learn to.
//
// Nothing of ours stays resident. The launch is a record in the store plus one
// tmux command whose argv is `ms _exec <launch-id>`; `src/exec.ts` picks that
// record up inside the pane, puts the credential in the child's ENVIRONMENT
// and `execve`s the CLI in place. So no secret is ever an argument to tmux —
// tmux command strings are readable by anything that can talk to the server.
//
// Two shapes, one spine:
//   * inside tmux — the caller's OWN pane is respawned. tmux kills this very
//     process to do it, so everything the human should see is already on
//     stderr before the respawn is issued.
//   * outside tmux — a tool-owned server (`<store>/tmux.sock`), session `ms`.
//     The pane is born holding a placeholder and the SAME respawn puts the CLI
//     in it, so both shapes start the CLI exactly one way: into a pane that is
//     already recorded, already `remain-on-exit`, already hooked. Then attach.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { ensureStore, msBinary, msHome, p } from "./paths.ts";
import { findAccount, loadRegistry, type Provider } from "./registry.ts";
import { getSnapshot, toPickInputs, type AccountUsage } from "./snapshot.ts";
import { parseNeed, pickAccounts, type Need, type PickInput } from "./pick.ts";
import { syncCodexAutorotate, syncRebalance } from "./autorotate.ts";
import { openState } from "./state.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { readCodexAuth } from "./providers/codex-probe.ts";
import { codexLaunchCommand } from "./providers/codex-cli.ts";
import { ensureCodexReady } from "./hooks/codex-install.ts";
import { CONTINUATION } from "./recover.ts";
import { Tmux, currentPane, tmuxFromEnv } from "./tmux.ts";

/** Exit codes, fixed by spec §7 so a caller can branch on them. */
const EXIT_OK = 0;
const EXIT_ACCOUNT = 1; // named account missing, or no launch token
const EXIT_USAGE_ERROR = 2; // the command line itself is wrong
const EXIT_NO_ROOM = 3; // nothing has room
const EXIT_UNREACHABLE = 4; // usage is down and there is no recent pick

/** The tool's own tmux server, for a launch with no tmux of its own. */
const TOOL_SOCKET = () => path.join(msHome(), "tmux.sock");
const TOOL_SESSION = "ms";
/** What a brand-new pane holds until the CLI is respawned into it. It must be
 *  unable to exit on its own (a shell would, and would source rc files too),
 *  because a pane that dies before the pane-died hook is set is a pane nothing
 *  ever reports. */
const PLACEHOLDER = ["sleep", "2147483647"];

/** How long a remembered pick stands in for a reading we cannot take. */
export const LAST_PICK_MAX_AGE_MS = 600_000;

const SNAPSHOT_MAX_AGE_MS = 20_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Every refusal is prefixed with the verb the human typed — which is the
 *  provider's own name, for both of them. */
function sayFor(provider: Provider) {
  return (msg: string, detail: string[] = []): void => {
    process.stderr.write(`ms ${provider}: ${msg}\n${detail.map((l) => `  ${l}\n`).join("")}`);
  };
}

// --- The command line --------------------------------------------------

type Parsed = { as: string | null; need: Need | null; continueAfter: boolean; args: string[] };

/**
 * Does this command line bring an existing conversation back?
 *
 * Two things turn on the answer, and they are the same fact asked twice.
 *
 * It is the only question `--continue` may be asked, because the continuation
 * says "continue the unfinished work from this conversation" — handed to a
 * conversation that has none, it is an instruction to invent some, which is
 * the exact failure `CONTINUATION`'s own doc comment records from a live
 * rotation. So a `--continue` with nothing to continue is a refusal, not a
 * prompt sent into an empty session.
 *
 * And it is what decides whether a Claude launch may be given a
 * `--session-id` at all (`planFor` below): that flag MAKES a conversation, so
 * on a command line that already names one it is a second, contradictory
 * answer to the question the human already answered.
 *
 * Read off the CLI's own resume spelling: Codex's `resume` subcommand, and
 * Claude Code's `--resume`/`-r` (or its own `--continue`/`-c`, which is the
 * same intent said its way). `ms adopt` always qualifies — it appends
 * `resume <id>` itself.
 */
function namesAResume(provider: Provider, args: string[]): boolean {
  if (provider === "codex") return args.includes("resume");
  return args.some((a) => a === "--resume" || a === "-r" || a === "--continue" || a === "-c" || a.startsWith("--resume="));
}

/**
 * WHICH conversation a Claude command line resumes, when it says so by id.
 *
 * Null for `--continue`/`-c` and for a bare `--resume` (Claude Code's own
 * picker): those are real resumes whose id is Claude's to choose, and the row
 * learns it from the first SessionStart the hook reports — the same way a
 * Codex row learns its own (`noteSessionStart`, src/hooks/claude-hook.ts,
 * which replaces the row's id with the one the CLI reports). Inventing an id
 * for them would name a conversation the CLI never opened, and a rotation
 * would later resume THAT.
 *
 * A value that looks like a flag is not an id: `--resume --model opus` is a
 * forgotten id, and reading `--model` as one would put a word on the row that
 * names no conversation at all.
 */
export function claudeResumeId(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--resume=")) return a.slice("--resume=".length) || null;
    if (a !== "--resume" && a !== "-r") continue;
    const next = args[i + 1];
    return next !== undefined && !next.startsWith("-") ? next : null;
  }
  return null;
}

/**
 * `ms <cli> [--as name] [--need any|fable] [--continue] [-- <cli args>]`.
 *
 * `--` is the boundary, and it is a hard one: everything after it is the
 * user's own command line for the CLI and passes through untouched, and
 * anything before it that is not one of our flags is a mistake rather
 * than a guess (a mistyped `--need` must not silently become an argument to
 * the CLI). `cli` appears only in that refusal, so the human is told where
 * their own argument belongs in the command they actually typed.
 *
 * `--continue` is the launch-time half of what a rotation does for free: the
 * SAME `CONTINUATION` (src/recover.ts), submitted the SAME way — as the
 * resumed command line's own prompt argument, never typed into a composer.
 * It is for a resume a human drove themselves, where nothing else would send
 * one at all.
 */
export function parseLaunchArgs(argv: string[], cli = "claude"): Parsed | { error: string } {
  let as: string | null = null;
  let need: Need | null = null;
  let continueAfter = false;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a === "--continue") { continueAfter = true; continue; }
    if (a === "--as" || a.startsWith("--as=")) {
      const v = a.startsWith("--as=") ? a.slice("--as=".length) : argv[++i];
      if (!v) return { error: "--as needs an account name" };
      as = v;
      continue;
    }
    if (a === "--need" || a.startsWith("--need=")) {
      const v = a.startsWith("--need=") ? a.slice("--need=".length) : argv[++i];
      const parsed = v === undefined ? null : parseNeed(v);
      if (!parsed) return { error: `--need must be 'any' or 'fable'` };
      need = parsed;
      continue;
    }
    return { error: `unexpected argument ${JSON.stringify(a)} — put ${cli}'s own arguments after --` };
  }
  // `--session-id` is how the launch keeps its grip on the CLI session across
  // a rotation; a user-supplied one would break the only handle we have.
  if (args.some((a) => a === "--session-id" || a.startsWith("--session-id="))) {
    return { error: "--session-id is set by ms; remove it" };
  }
  return { as, need, continueAfter, args };
}

// --- What the run needs ------------------------------------------------

function modelFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") return args[i + 1] ?? null;
    if (a.startsWith("--model=")) return a.slice("--model=".length) || null;
  }
  return null;
}

function modelFromSettings(): string | null {
  // Claude Code's own config dir, wherever the human put it — this tool runs
  // accounts out of private CLAUDE_CONFIG_DIRs itself (spec §12), so reading a
  // hardcoded `~/.claude` would answer for the wrong install.
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || homedir(), ".claude");
  const f = path.join(dir, "settings.json");
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { model?: unknown };
    return typeof j?.model === "string" ? j.model : null;
  } catch {
    return null; // absent, unreadable or not JSON — all mean "it does not say"
  }
}

/** The need nobody stated. The effective model is whichever source speaks
 *  first — the command line, the environment, then the user's settings — and
 *  a model that names fable is a run that needs fable room. */
export function autoNeed(args: string[]): Need {
  const model = modelFromArgs(args) ?? (process.env.ANTHROPIC_MODEL || null) ?? modelFromSettings();
  return model && /fable/i.test(model) ? "fable" : "any";
}

// --- The last successful pick ------------------------------------------

type LastPick = { name: string; at: number };

/**
 * The memo's key. It is per (provider, need) because an account name is only
 * unique within a provider — the registry deliberately allows `claude:work`
 * and `codex:work` — and because the two CLIs are not interchangeable: a
 * Claude account offered to `ms codex` would launch the wrong binary on a
 * credential it has no way to read.
 *
 * Claude's keys stay UNPREFIXED, exactly as they were written before there
 * was a second provider, so an upgrade keeps the fallback already on disk
 * rather than silently losing it for the next ten minutes.
 */
const lastPickKey = (provider: Provider, need: Need): string =>
  provider === "claude" ? need : `${provider}:${need}`;

/** The remembered pick for this provider and need, or null when there is none
 *  young enough to still be evidence. */
export function readLastPick(provider: Provider, need: Need): LastPick | null {
  try {
    const j = JSON.parse(readFileSync(p.lastPick, "utf8")) as Record<string, unknown>;
    const e = j?.[lastPickKey(provider, need)];
    if (!e || typeof e !== "object") return null;
    const { name, at } = e as { name?: unknown; at?: unknown };
    if (typeof name !== "string" || !name) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    const age = Date.now() - at;
    // A negative age is a clock that went backwards; trusting it would let a
    // stale pick stand forever.
    if (age < 0 || age > LAST_PICK_MAX_AGE_MS) return null;
    return { name, at };
  } catch {
    return null;
  }
}

/** Remember a real pick, per provider and need, without disturbing any other
 *  entry. This is a hint file, never a source of truth: a write that fails
 *  costs the next launch its fallback and nothing else, so it is never worth
 *  an error. */
export function writeLastPick(provider: Provider, need: Need, name: string): void {
  ensureStore();
  let j: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(p.lastPick, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
  } catch {
    /* absent or torn: start a fresh one */
  }
  j[lastPickKey(provider, need)] = { name, at: Date.now() };
  const tmp = `${p.lastPick}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(j) + "\n", { mode: 0o600 });
    renameSync(tmp, p.lastPick);
  } catch {
    rmSync(tmp, { force: true });
  }
}

/**
 * "We could not read usage", as distinct from "nothing has room".
 *
 * Every account the chooser could have used was passed over for a TRANSIENT
 * failure — the network, a 429, a timeout. An account that is genuinely full,
 * or whose grant is dead, is an answer; this is the absence of one, and it is
 * the only case where a remembered pick may stand in for a reading.
 */
export function usageUnreachable(rows: AccountUsage[], inputs: PickInput[]): boolean {
  if (!rows.length) return false;
  const errorOf = new Map(inputs.map((i) => [i.name, i.error]));
  return rows.every((a) => a.errorKind === "transient" && errorOf.get(a.name) != null);
}

// --- The verb ----------------------------------------------------------

/**
 * `ms attach` (spec §4): get back to the tool-owned tmux server.
 *
 * A launch from OUTSIDE tmux puts the session in `<store>/tmux.sock`, session
 * `ms`, and attaches — but a detach, a closed terminal or an attach that could
 * not run (a script, no tty) leaves the CLI running there with no way back that
 * the tool itself offers. This is that way back, and the only thing it is: one
 * bounded `has-session` and then tmux's own attach, which is deliberately
 * unbounded because an interactive attach lives as long as the session does.
 *
 * A server that is not there is a refusal, not an error to interpret: nothing
 * of ours is resident, so "no session" means no launch has happened yet.
 */
export const attachVerb: Verb = async (argv) => {
  if (argv.length) {
    process.stderr.write(`ms attach: unexpected argument ${JSON.stringify(argv[0])}\nusage: ms attach\n`);
    return EXIT_USAGE_ERROR;
  }
  const tmux = new Tmux(TOOL_SOCKET());
  if (!tmux.hasSession(TOOL_SESSION)) {
    process.stderr.write("ms attach: no ms tmux server yet; run ms claude\n");
    return EXIT_ACCOUNT;
  }
  return tmux.attach(TOOL_SESSION);
};

/**
 * What one provider's launch does differently, and nothing else.
 *
 * The spine below is identical for both CLIs — parse, choose, record, respawn,
 * attach — and everything that is not identical is in here, so a third
 * provider is a third entry rather than a second copy of the verb.
 */
type ProviderPlan = {
  /** The need this run is choosing for, or a refusal to state at all. */
  need: Need | { error: string };
  /** Existence of the account's launch credential, checked before anything is
   *  written. The VALUE never leaves the module that reads it. */
  credential(account: string): { error: string } | null;
  /** Anything the account's own home must say before the CLI starts. */
  prepare(account: string, cwd: string): { error: string } | null;
  /** The session id this tool hands the CLI, when the CLI can be told one. */
  cliSessionId(): string | null;
  /** The argv tmux is told to run. */
  command(cliSessionId: string | null, args: string[]): string[];
  /** What the status line says in parentheses. */
  label(need: Need): string;
};

/**
 * What a caller that is not the human's own `ms claude`/`ms codex` adds to a
 * launch. Today there is one: `ms adopt`, which knows the conversation the
 * pane is being started on before the CLI does.
 */
export type LaunchExtras = {
  /** The CLI conversation this launch RESUMES. It does two things nothing
   *  else can do for a Codex launch: it appends `resume <id>` to the command
   *  line, and it puts the id on the session row at creation — where Codex
   *  normally leaves null until its hook first reports, which is a row no
   *  rotation could resume in the meantime. */
  resumeId?: string | null;
};

function planFor(provider: Provider, parsed: Parsed, extras: LaunchExtras = {}): ProviderPlan {
  if (provider === "codex") {
    return {
      // Codex reports ONE subscription's windows and no model-scoped window
      // at all (src/providers/codex-usage.ts maps `weeklyFable` to null), so
      // `--need fable` is not a preference this provider can fail to meet —
      // it is a question about a window that does not exist.
      need: parsed.need === "fable" ? { error: "codex has no fable window" } : "any",
      credential: (account) =>
        // Existence of a USABLE credential, and nothing more: the value stays
        // in the module that read it, and `_exec` hands the CLI the
        // DIRECTORY, never a byte of the file. A present-but-empty `auth.json`
        // — a login that was interrupted, a file someone truncated — is not a
        // credential, and answering "yes" for it would put the modal-free
        // launch in front of a CLI that cannot authenticate.
        readCodexAuth(p.codexHome(account))?.accessToken
          ? null
          : { error: `no codex credential for account '${account}' (run: ms accounts login ${account} --provider codex)` },
      prepare: (account, cwd) => {
        // Trust (a modal an unattended launch must never meet) and the hooks
        // (a home with none starts fine and reports NOTHING — see
        // `ensureCodexReady`'s own doc comment) — both answered by the one
        // call a rotation's `prepareCandidate` also makes, so a home good
        // enough to launch into and a home good enough to rotate into can
        // never drift apart. Verified on Codex 0.153.4.
        // The same call also links the home to the human's own ~/.codex
        // (src/codex-share.ts); what that changed or could not change is
        // said here, on the human's terminal, rather than kept from them.
        const refusal = ensureCodexReady(p.codexHome(account), cwd, msBinary(), (line) =>
          process.stderr.write(`ms codex: ${account}: ${line}\n`),
        );
        return refusal ? { error: refusal.problem } : null;
      },
      // There is no `--session-id`: normally the hook reports the id Codex
      // chose. A launch that RESUMES is the one case the id is known first.
      cliSessionId: () => extras.resumeId ?? null,
      command: (_id, args) => codexLaunchCommand(args),
      label: () => "codex",
    };
  }
  // A Claude launch normally MAKES a conversation and names it itself, so the
  // tool can hand the CLI the id (`--session-id`) and have a handle on the
  // session from the first instant — before any hook has run.
  //
  // A launch that RESUMES one is the opposite case, and was wrong until
  // 2026-09-19: `ms claude -- --resume <id>` built `claude --session-id <fresh
  // uuid> --resume <id>`, two contradictory answers to which conversation this
  // is, and a row whose `cliSessionId` named neither — a uuid Claude Code was
  // never going to use. `ms import` resumes every Claude conversation it moves
  // through exactly this path, so the whole verb rode on it. Now the command
  // line the human wrote passes through untouched, the row is created on the
  // id that command line names, and the CLI's own SessionStart (`source:
  // resume`) confirms it — the same confirmation a rotation's `--resume`
  // relaunch gets, where the row already carries the id and the hook's report
  // is what proves the conversation came back (`waitForReady`, src/recover.ts).
  const resumes = namesAResume("claude", parsed.args);
  return {
    need: parsed.need ?? autoNeed(parsed.args),
    credential: (account) =>
      readLaunchToken(account)
        ? null
        : { error: `no launch token for account '${account}' (run: ms accounts login ${account})` },
    prepare: () => null,
    cliSessionId: () => (resumes ? claudeResumeId(parsed.args) : randomUUID()),
    command: (id, args) => (resumes ? ["claude", ...args] : ["claude", "--session-id", id!, ...args]),
    label: (need) => need,
  };
}

/**
 * The launch, for either CLI.
 *
 * Everything provider-shaped is in `planFor` above; what is left is the
 * sequence that must not vary — because it is the sequence that keeps a pane
 * accounted for before anything can run in it.
 */
export async function launchWith(provider: Provider, argv: string[], extras: LaunchExtras = {}): Promise<number> {
  const say = sayFor(provider);
  const parsed = parseLaunchArgs(argv, provider);
  if ("error" in parsed) { say(parsed.error); return EXIT_USAGE_ERROR; }
  const plan = planFor(provider, parsed, extras);
  if (typeof plan.need !== "string") { say(plan.need.error); return EXIT_USAGE_ERROR; }
  const need = plan.need;

  // The command line the CLI actually gets: the human's own arguments, then
  // the resume this launch is (when a caller knew one), then the
  // continuation. That order is the rotation's own — `codexResumeCommand`
  // puts the prompt straight after the id — and it is why `resume <id>` is
  // NOT folded into `parsed.args`: `args` becomes the row's `flags`, which a
  // later rotation re-applies through `flagsForResume`, and a stray `resume`
  // positional there would be re-appended to a command line that already has
  // one.
  const resumeId = extras.resumeId ?? null;
  const cliArgs = [
    ...parsed.args,
    ...(resumeId ? ["resume", resumeId] : []),
    ...(parsed.continueAfter ? [CONTINUATION] : []),
  ];
  if (parsed.continueAfter && !resumeId && !namesAResume(provider, parsed.args)) {
    say(
      "--continue needs something to continue",
      provider === "codex"
        ? ["it carries the unfinished work of a conversation you are resuming", `try: ms codex --continue -- resume <id>`]
        : ["it carries the unfinished work of a conversation you are resuming", `try: ms claude --continue -- --resume <id>`],
    );
    return EXIT_USAGE_ERROR;
  }

  // An unreadable accounts.json is "could not look", never "nothing is
  // there": reporting it as an empty pool would send the human hunting for a
  // missing account instead of a broken file. It is checked once, before
  // either branch, so `--as` cannot report it as "no such account" either.
  const { registry, parseError } = loadRegistry();
  if (parseError) { say(`cannot read the registry: ${parseError}`); return EXIT_ACCOUNT; }
  let account: string;
  // A pick is only worth remembering once it has actually been launched: a
  // fallback the tool never managed to run is a trap for the next launch.
  let remember: (() => void) | null = null;

  if (parsed.as) {
    const named = findAccount(registry, parsed.as, provider);
    if (!named) { say(`no such account '${parsed.as}'`); return EXIT_ACCOUNT; }
    account = named.name;
  } else {
    const mine = new Set(registry.accounts.filter((a) => a.provider === provider).map((a) => a.name));
    // Not "the pool is full" — there is no pool. A configuration answer.
    if (!mine.size) {
      const how = provider === "claude" ? "" : ` --provider ${provider}`;
      say(`no ${provider} account is registered (run: ms accounts add <name>${how})`);
      return EXIT_ACCOUNT;
    }
    const snapshot = await getSnapshot({ maxAgeMs: SNAPSHOT_MAX_AGE_MS });
    // The registry can break between our read and the snapshot's own.
    if (snapshot.registryError) { say(`cannot read the registry: ${snapshot.registryError}`); return EXIT_ACCOUNT; }
    // Only this provider's accounts. Identity is (provider, name), so the
    // provider is part of the match — an account of the same name under the
    // other provider is a DIFFERENT account, not this one, and letting it
    // into the set would make "every account transient" unsayable.
    const rows = snapshot.accounts.filter((a) => a.provider === provider && mine.has(a.name));
    // The whole snapshot travels, only its rows narrowed: `toPickInputs` reads
    // more than `accounts` (an unreadable registry yields no inputs at all),
    // and a hand-built partial would silently drop whatever it learns next.
    const inputs = toPickInputs({ ...snapshot, accounts: rows });
    const { picks, out } = pickAccounts(inputs, need);
    const reasons = out.map((o) => `${o.name}: ${o.why}`);
    const first = picks[0];
    if (first) {
      account = first.name;
      remember = () => writeLastPick(provider, need, first.name);
    } else if (usageUnreachable(rows, inputs)) {
      const last = readLastPick(provider, need);
      if (!last) { say("usage unreachable", reasons); return EXIT_UNREACHABLE; }
      if (!findAccount(registry, last.name, provider)) {
        say(`usage unreachable, and the last pick '${last.name}' is no longer registered`, reasons);
        return EXIT_UNREACHABLE;
      }
      account = last.name;
    } else {
      say("no account has room", reasons);
      return EXIT_NO_ROOM;
    }
  }

  // Existence only: the value belongs in the pane's environment (src/exec.ts),
  // never here, and never in a message.
  const missing = plan.credential(account);
  if (missing) { say(missing.error); return EXIT_ACCOUNT; }

  const msBin = msBinary();
  const cwd = process.cwd();

  // The account's own home, made ready for THIS directory, before a row is
  // written or a pane is touched: a launch that cannot prepare the home has
  // not started, and must leave nothing behind saying it did.
  const unprepared = plan.prepare(account, cwd);
  if (unprepared) { say(unprepared.error); return EXIT_ACCOUNT; }

  const sessionId = randomUUID();
  const cliSessionId = plan.cliSessionId();
  const launchId = randomUUID();
  const command = plan.command(cliSessionId, cliArgs);
  const label = plan.label(need);
  const inside = !!process.env.TMUX && !!process.env.TMUX_PANE;
  const tmux = inside ? tmuxFromEnv() : new Tmux(TOOL_SOCKET());
  const socket = tmux.socket ?? "";

  const st = openState();
  try {
    // `ms codex` runs in the human's own shell, which is where
    // `MS_CODEX_AUTOROTATE` is exported — and where the processes that READ
    // the gate (`ms _recover`, `ms _codex_watch`, both dispatched by `tmux
    // run-shell`) never run. Carry it into the store on the way past, so
    // exporting it works inside an existing tmux server too, not only when
    // this launch happened to start the server itself.
    if (provider === "codex") {
      try { syncCodexAutorotate(st); } catch { /* the gate is not worth failing a launch over */ }
    }
    // The rebalance gate travels the same road, for both providers: `ms
    // claude` and `ms codex` are the two commands that reliably run in the
    // human's own shell, which is where `MS_REBALANCE` is exported and where
    // `_rebalance` (dispatched by tmux) will never run.
    try { syncRebalance(st); } catch { /* the gate is not worth failing a launch over */ }
    if (inside) {
      const pane = currentPane()!;
      const serverStart = tmux.serverIdentity();
      st.createSession({
        id: sessionId, provider, cliSessionId, cwd, socket, pane, serverStart,
        need, account, generation: 1, state: "launching", desired: "running",
        // The pass-through arguments verbatim: a rotation re-applies exactly
        // what this launch was asked for.
        flags: parsed.args,
      });
      st.createLaunch({ id: launchId, sessionId, generation: 1, account, command, env: {}, createdAt: nowSeconds() });

      tmux.remainOnExit(pane, true);
      tmux.setPaneOption(pane, "@ms_session", sessionId);
      tmux.setPaneDiedHook(pane, [msBin, "_pane_died", sessionId]);
      // The respawn below replaces the shell this process is running in, so
      // tmux kills us the moment it is issued: everything else happens first.
      remember?.();
      process.stderr.write(`ms: ${account} (${label}) → pane ${pane}\n`);
      tmux.respawn(pane, cwd, [msBin, "_exec", launchId]);
      return EXIT_OK;
    }

    // Outside tmux the pane has to be made before it can be described, so it
    // is born holding a placeholder — `sleep` forever, which cannot exit on
    // its own and sources no rc files — and the CLI is respawned into it only
    // once the pane is fully accounted for. That ordering is the point:
    //   * the session row is written with a REAL pane and server identity
    //     before anything can read it, so `_exec` never carries an empty
    //     MS_PANE for the life of the CLI (src/exec.ts copies it once);
    //   * `remain-on-exit` and the pane-died hook are in place before the CLI
    //     starts, so an `_exec` that fails immediately leaves a dead pane the
    //     hook can report, rather than a vanished pane and an orphaned row.
    const pane = tmux.hasSession(TOOL_SESSION)
      ? tmux.newWindow(TOOL_SESSION, cwd, PLACEHOLDER)
      : tmux.newSession(TOOL_SESSION, cwd, PLACEHOLDER);
    const serverStart = tmux.serverIdentity();
    st.createSession({
      id: sessionId, provider, cliSessionId, cwd, socket, pane, serverStart,
      need, account, generation: 1, state: "launching", desired: "running", flags: parsed.args,
    });
    st.createLaunch({ id: launchId, sessionId, generation: 1, account, command, env: {}, createdAt: nowSeconds() });

    tmux.remainOnExit(pane, true);
    tmux.setPaneOption(pane, "@ms_session", sessionId);
    tmux.setPaneDiedHook(pane, [msBin, "_pane_died", sessionId]);
    tmux.respawn(pane, cwd, [msBin, "_exec", launchId]);
    remember?.();
    process.stderr.write(`ms: ${account} (${label}) → pane ${pane}\n`);
    st.close(); // the attach below lasts as long as the session does

    // The launch has already happened. An attach that fails — no terminal, a
    // caller that is a script — is not a failed launch, so it must not become
    // one of the 1/2/3/4 answers; it is a line telling the human the way back.
    if (tmux.attach(TOOL_SESSION) !== 0) {
      process.stderr.write(`ms: launched in the ms tmux server; attach with: tmux -S ${socket} attach -t ms\n`);
    }
    return EXIT_OK;
  } finally {
    st.close(); // idempotent
  }
}

/** `ms claude` (spec §7). */
export const launchClaude: Verb = (argv) => launchWith("claude", argv);

/** `ms codex` — the same launch, on a ChatGPT subscription. */
export const launchCodex: Verb = (argv) => launchWith("codex", argv);
