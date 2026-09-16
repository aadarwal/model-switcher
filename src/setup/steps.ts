// src/setup/steps.ts
//
// The seven steps `ms setup` walks, and nothing else: the driver that
// sequences them, remembers which are done and turns the last one into an
// exit code is src/setup.ts.
//
// Every step here is a thin composition of verbs that already exist and are
// already tested — `cmdAdd`/`cmdLogin`/`cmdVerify` and their Codex twins, the
// two hook installers, the statusline and alias installers, `runDoctor`,
// `status`. The wizard adds no behaviour of its own to any of them; what it
// adds is ORDER, the questions that choose between them, and a record of what
// has already been answered so a closed terminal costs nothing.
//
// Three rules the whole file keeps:
//
//   * Nothing here types into a pane and nothing here runs `npm` or `brew`.
//     A missing prerequisite is reported with its remedy and the wizard stops;
//     installing someone's toolchain behind their back is not setup, it is a
//     surprise.
//   * Every line printed is one sentence in the human's language. Never a
//     token (the account book redacts, and the probes below never forward a
//     child's output at all), and never the VALUE of a settings key — a path
//     is a place the human can go and look, a value is noise they did not ask
//     for.
//   * Every child process is bounded, and every question that can be answered
//     wrongly is re-asked rather than guessed at — except under `--yes`, where
//     there is nobody to re-ask and a second pass would spin forever, so the
//     wizard stops and says which question it could not answer alone.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { cmdAdd, cmdLogin, cmdVerify } from "../accounts.ts";
import { CODEX_RESERVED_NAMES, loginCodex, verifyCodex } from "../accounts-codex.ts";
import { checkClaudeBinary, checkCodexBinary, checkNode, checkTmux, claudeSettingsPath, renderLine, runDoctor } from "../doctor.ts";
import { readEvents } from "../events.ts";
import { installCodexHooks } from "../hooks/codex-install.ts";
import { installClaudeHooks } from "../hooks/install.ts";
import { readLaunchToken } from "../launch-credentials.ts";
import { msBinary, p } from "../paths.ts";
import { ensureCodexTrust } from "../providers/codex-cli.ts";
import { findAccount, loadRegistry, NAME_PATTERN, type Provider } from "../registry.ts";
import { status } from "../status.ts";
import { installAlias, rcPathFor } from "./alias.ts";
import type { Prompter } from "./prompt.ts";
import { saveSetup, type SetupState, type SetupStep } from "./state.ts";
import { installStatusline } from "./statusline.ts";

/** The order the steps run in, and the only order. It must agree with
 *  `SetupStep` in ./state.ts — the type is what makes a typo here a compile
 *  error rather than a step silently never running. */
export const STEP_ORDER: readonly SetupStep[] = [
  "prereqs",
  "claude-accounts",
  "codex-accounts",
  "hooks",
  "statusline",
  "alias",
  "finish",
];

/** How a step is named in a sentence, for the one line the driver prints when
 *  a resume skips it. */
export const STEP_LABEL: Record<SetupStep, string> = {
  prereqs: "the prerequisite checks",
  "claude-accounts": "the Claude accounts",
  "codex-accounts": "the ChatGPT accounts",
  hooks: "the hooks",
  statusline: "the statusline",
  alias: "the shell aliases",
  finish: "the final check",
};

/** More accounts than this in one sitting is a typo, not a plan: each one is
 *  two browser flows. The cap exists so `20` does not open forty tabs. */
const MAX_ACCOUNTS = 10;

/** The headless turn each hook probe takes. Generous, because it is a real
 *  model call on a real network — and bounded, because everything here is. */
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_PROMPT = "Reply with the single word ok.";
/** The cheapest model that can answer it — src/accounts.ts's own choice. */
const PROBE_MODEL = "haiku";
/** A probe's `MS_SOCKET`/`MS_PANE`. The hooks read them only on the wall path,
 *  which a one-turn probe never reaches; they are here because the hook's gate
 *  requires all four `MS_*` variables before it will write anything at all. */
const PROBE_SOCKET = "ms-setup-probe";
const PROBE_PANE = "%ms-setup-probe";

/**
 * A step decided the run cannot go on.
 *
 * Always exit 1, and always with the state file left exactly as it is: the
 * next `ms setup` resumes at this very step. That is the difference between
 * this and a thrown Error — an abort is a decision the wizard made and
 * explained, not a failure it did not expect.
 */
export class SetupAbort extends Error {
  override name = "SetupAbort";
}

/** What a step can do with the human, plus the run's own memory. Passed to
 *  every step; built by `makeCtx` and owned by the driver. */
export type Ctx = {
  /** The state as it stands. The driver replaces it on every `markDone`; a
   *  step mutates `claude`/`codex`/`optIns` and calls `persist`. */
  state: SetupState;
  /** `--yes`: accept every default, ask nothing. */
  readonly yes: boolean;
  ask(q: string, opts?: { default?: string; choices?: string[] }): Promise<string>;
  confirm(q: string, def: boolean): Promise<boolean>;
  say(line: string): void;
  /** How many ChatGPT accounts the human declared, once per RUN. `prereqs`
   *  asks it (a missing `codex` is only a fault when the answer is not zero)
   *  and `codex-accounts` reuses the answer rather than asking twice. Null
   *  when this run never ran `prereqs` — a resume that starts later asks it
   *  again, which is the honest thing: nothing on disk remembers a count. */
  codexCount: number | null;
  /** Whether Codex logins should use a device code. Asked once, in
   *  `codex-accounts`, and passed through to every `codex login`. */
  deviceAuth: boolean;
  persist(): void;
};

export function makeCtx(prompter: Prompter, state: SetupState, yes: boolean): Ctx {
  const ctx: Ctx = {
    state,
    yes,
    // `--yes` answers from the DEFAULT rather than from the prompter, so an
    // unattended run never touches stdin. A question with no default cannot be
    // answered that way and must not exist on the `--yes` path; there is none.
    ask: (q, opts) => (yes && opts?.default !== undefined ? Promise.resolve(opts.default) : prompter.ask(q, opts)),
    confirm: (q, def) => (yes ? Promise.resolve(def) : prompter.confirm(q, def)),
    say: (line) => process.stdout.write(`${line}\n`),
    codexCount: null,
    deviceAuth: false,
    persist: () => {
      ctx.state = { ...ctx.state, updatedAt: new Date().toISOString() };
      saveSetup(ctx.state);
    },
  };
  return ctx;
}

// --- Asking -------------------------------------------------------------

/** Say why an answer was unusable, and stop the run when there is nobody to
 *  give a better one: under `--yes` the next pass would get the same default
 *  back for ever. */
function reask(ctx: Ctx, why: string): void {
  ctx.say(why);
  if (ctx.yes) throw new SetupAbort(`--yes cannot answer that question, so run ms setup without it`);
}

async function askCount(ctx: Ctx, question: string, def: number): Promise<number> {
  for (;;) {
    const raw = await ctx.ask(question, { default: String(def) });
    const n = Number(raw.trim());
    if (Number.isInteger(n) && n >= 0 && n <= MAX_ACCOUNTS) return n;
    reask(ctx, `That is not a number of accounts I can use; answer with a whole number from 0 to ${MAX_ACCOUNTS}.`);
  }
}

/** The ChatGPT account count, asked at most once per run (see `Ctx`). */
async function codexCount(ctx: Ctx): Promise<number> {
  if (ctx.codexCount === null) ctx.codexCount = await askCount(ctx, "How many ChatGPT (Codex) accounts will you use?", 0);
  return ctx.codexCount;
}

/** A nickname for one account: valid as a registry name, and not one this run
 *  has already used for another account of the same provider. */
async function askName(ctx: Ctx, provider: Provider, slot: number, taken: string[]): Promise<string> {
  for (;;) {
    const name = (await ctx.ask(`Name for ${provider} account ${slot}`, { default: `${provider}-${slot}` })).trim();
    if (!NAME_PATTERN.test(name)) {
      reask(ctx, "An account name is lower-case letters, digits, '-' and '_', up to 32 characters.");
      continue;
    }
    if (provider === "codex" && CODEX_RESERVED_NAMES.includes(name)) {
      reask(ctx, `${name} is reserved: MS_HOME/codex/${name} is the shared rollout store, not an account home.`);
      continue;
    }
    if (taken.includes(name)) {
      reask(ctx, `This run already set up an account called ${name}, so pick another name.`);
      continue;
    }
    return name;
  }
}

/** A verb that answers with an EXIT CODE rather than an exception. Every one
 *  the wizard calls returns 0 or throws today, and this is what keeps that
 *  true from the wizard's side: a non-zero code is a failure, treated exactly
 *  like a throw, rather than a step that quietly reports success. */
export async function ran(what: string, code: number | Promise<number>): Promise<void> {
  const c = await code;
  if (c !== 0) throw new Error(`${what} exited ${c}`);
}

type Decision = "retry" | "skip" | "abort";

/**
 * What to do about something that failed.
 *
 * The default is `abort`, and deliberately so. Every failure that reaches here
 * is one a human has to act on — a browser flow that did not complete, a
 * config file this tool refuses to rewrite — so the answer that costs nothing
 * is to stop with the state saved and come back. It also keeps `--yes`
 * honest: an unattended run accepts the default like any other, and stops,
 * rather than retrying a browser login nobody is there to finish.
 */
async function decide(ctx: Ctx): Promise<Decision> {
  const a = await ctx.ask("Retry it, skip it, or abort setup?", { choices: ["retry", "skip", "abort"], default: "abort" });
  return a as Decision;
}

/**
 * Run `work` until it succeeds, the human skips it, or the human aborts.
 *
 * `true` means it succeeded; `false` means it was skipped and the caller
 * carries on without it. The failure's own message is printed verbatim — it is
 * the remedy, and rewording it here would lose the one thing a refusal from
 * `installCodexHooks` or a login is actually for.
 */
async function attempt(ctx: Ctx, what: string, work: () => Promise<void> | void): Promise<boolean> {
  for (;;) {
    try {
      await work();
      return true;
    } catch (e) {
      ctx.say(`${what} failed: ${(e as Error).message}.`);
      const d = await decide(ctx);
      if (d === "retry") continue;
      if (d === "skip") return false;
      throw new SetupAbort(`stopped at ${what}; ms setup will resume from this step`);
    }
  }
}

// --- Shared places --------------------------------------------------------

/** Register `name` unless it is already registered. Adopting an existing row
 *  rather than refusing is what makes an interrupted run resumable: a wizard
 *  that died between `add` and `login` left a real row behind, and the human
 *  typing that same name again means "finish it", not "start a duplicate". */
async function ensureRow(ctx: Ctx, name: string, provider: Provider): Promise<void> {
  const r = loadRegistry();
  if (r.parseError) throw new Error(r.parseError);
  if (findAccount(r.registry, name, provider)) {
    ctx.say(`${name} is already registered, so the wizard signs in to it rather than adding it again.`);
    return;
  }
  await ran(`ms accounts add ${name}`, cmdAdd(provider === "codex" ? [name, "--provider", "codex"] : [name]));
}

/**
 * One provider's accounts, end to end.
 *
 * `state.<provider>` is the list of accounts this wizard has taken all the way
 * through login and verify — it is appended to only on success, so a resume
 * picks up exactly where the work stopped, and an account the human skipped is
 * not recorded as done. Everything provider-specific is in `login`.
 */
async function accountsStep(
  ctx: Ctx,
  provider: Provider,
  count: number,
  recorded: string[],
  login: (name: string) => Promise<void>,
): Promise<void> {
  const already = recorded.length;
  if (already) ctx.say(`${already} ${provider} account${already === 1 ? "" : "s"} from an earlier run ${already === 1 ? "is" : "are"} already signed in.`);
  for (let slot = already + 1; slot <= count; slot++) {
    const name = await askName(ctx, provider, slot, recorded);
    // Registering is INSIDE the attempt: an unreadable registry, or an `add`
    // that refuses, is a failure with the same three answers as a failed
    // login — and re-running it on Retry is safe, because a row that is
    // already there is adopted rather than added twice.
    const ok = await attempt(ctx, `setting up ${name}`, async () => {
      await ensureRow(ctx, name, provider);
      await login(name);
    });
    if (ok) {
      recorded.push(name);
      ctx.persist();
    } else {
      ctx.say(`${name} stays registered but unverified; finish it later with: ms accounts login ${name}${provider === "codex" ? " --provider codex" : ""}.`);
    }
  }
}

// --- 1. prereqs -----------------------------------------------------------

/**
 * The four things that must be true before anything is installed.
 *
 * The ChatGPT count is asked FIRST, and only for this: a machine with no
 * ChatGPT accounts has no reason to have the Codex CLI at all, so a missing
 * `codex` there is not a fault — and the wizard cannot know that until the
 * human says so. Nothing is written by this step, and nothing is installed
 * for the human: a ✗ is reported with the remedy the doctor itself gives, and
 * the run stops.
 */
async function prereqs(ctx: Ctx): Promise<void> {
  ctx.say("First, the tools ms needs, before anything at all is installed or changed.");
  const n = await codexCount(ctx);
  const results = [checkNode(), checkTmux(), checkClaudeBinary(), checkCodexBinary(n > 0)];
  for (const r of results) ctx.say(renderLine(r));
  if (results.some((r) => !r.ok)) {
    throw new SetupAbort("install what the ✗ lines above name, then run ms setup again");
  }
}

// --- 2. claude-accounts ---------------------------------------------------

/**
 * Register, log in and verify each Claude account.
 *
 * The one sentence printed before every login is load-bearing: `login` opens
 * TWO browser flows (`claude auth login` for the poll grant, then `claude
 * setup-token` for the launch grant) and this tool has no way to check that
 * the same account answered both. A human who signs into one account and then
 * another gets a row whose two credentials belong to two subscriptions, and
 * nothing downstream can tell. Saying so before the tabs open is the only
 * defence there is.
 */
async function claudeAccounts(ctx: Ctx): Promise<void> {
  const n = await askCount(ctx, "How many Claude accounts?", 1);
  if (n === 0) {
    ctx.say("No Claude accounts, so there is nothing to sign in to here.");
    return;
  }
  await accountsStep(ctx, "claude", n, ctx.state.claude, async (name) => {
    ctx.say("Sign in as the SAME account in both browser tabs.");
    await ran(`ms accounts login ${name}`, cmdLogin(name));
    await ran(`ms accounts verify ${name}`, cmdVerify(name));
  });
}

// --- 3. codex-accounts ----------------------------------------------------

/**
 * The same for ChatGPT, with one extra question.
 *
 * `codex login`'s default is a browser redirect back to localhost, which only
 * works when the browser is on this machine; a device code works anywhere and
 * is what `loginCodex` already forces when stdin is not a TTY. The human is
 * asked once, for the whole step, because it is a fact about where their
 * browser is and not about any one account.
 */
async function codexAccounts(ctx: Ctx): Promise<void> {
  const n = await codexCount(ctx);
  if (n === 0) {
    ctx.say("No ChatGPT accounts, so the Codex steps have nothing to do.");
    return;
  }
  ctx.deviceAuth = await ctx.confirm("Sign in to Codex with a device code instead of a browser redirect?", false);
  await accountsStep(ctx, "codex", n, ctx.state.codex, async (name) => {
    await ran(`ms accounts login ${name} --provider codex`, loginCodex(name, { deviceAuth: ctx.deviceAuth }));
    await ran(`ms accounts verify ${name} --provider codex`, verifyCodex(name));
  });
}

// --- 4. hooks -------------------------------------------------------------

/** A probe's session id. Unique per probe so two wizards never read each
 *  other's events, and prefixed so a leftover directory says what left it. */
function probeId(provider: Provider): string {
  return `ms-setup-probe-${provider}-${randomBytes(4).toString("hex")}`;
}

/** The `MS_*` identity a hook requires before it writes anything, exactly as
 *  `ms _exec` exports it into a real pane. Without all four of SESSION,
 *  GENERATION, SOCKET and PANE both hooks return 0 having done nothing —
 *  which is how a pane the tool did not launch stays untouched, and why a
 *  probe has to set them. */
function probeEnv(session: string): Record<string, string> {
  return { MS_SESSION: session, MS_GENERATION: "1", MS_SOCKET: PROBE_SOCKET, MS_PANE: PROBE_PANE, MS_BIN: msBinary() };
}

/** A throwaway working directory for one probe turn. The human's own project
 *  directory is not this tool's to take a turn in: it carries project-scoped
 *  settings, and for Codex it is a directory whose TRUST is a decision the
 *  human owns. An empty temp directory carries neither. */
function probeCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "ms-setup-probe-"));
}

/**
 * Did the hook actually fire?
 *
 * The probe leaves NO row in the session store on purpose. The event log is
 * what proves a hook ran — the hooks append to it whether or not a row exists
 * — and a row is a managed session: the store has no delete, so one created
 * here would outlive the probe and show up in `ms status` for ever. So the
 * probe's whole footprint is one session directory, and this removes it.
 *
 * The child's own output is never forwarded, on any path. It is a real CLI
 * turn under a real credential, and the wizard has no business relaying what
 * it says; the exit status is not read either, because a usage wall is an
 * authenticated answer that still fires SessionStart.
 */
function probe(session: string, cmd: string, args: string[], cwd: string, env: Record<string, string>): void {
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, ...env, ...probeEnv(session) },
    });
    if (r.error) throw new Error(`${cmd} could not be run (${r.error.message})`);
    if (!readEvents(session).some((e) => e.kind === "started")) {
      throw new Error(`the ${cmd} probe turn fired no SessionStart hook, so nothing was written to ${p.eventsFile(session)}`);
    }
  } finally {
    rmSync(p.sessionDir(session), { recursive: true, force: true });
  }
}

/** How a hook check ended: proved, declined by the human, or never run at all
 *  because there was nothing to run it with. The three are different things to
 *  say, and saying "nothing was ready" over a check the human SKIPPED would be
 *  the wizard telling them something they know to be untrue. */
type CheckResult = "ok" | "skipped" | "unavailable";

/**
 * The Claude probe: one headless turn under the account's launch token, run
 * the way `ms _exec` runs a real session.
 *
 * In particular it does NOT point the CLI at a scratch `CLAUDE_CONFIG_DIR`.
 * That was the bug this check existed to catch and could not: Claude Code
 * reads its hooks from the config dir it is given, so a turn in an empty one
 * has no hooks to fire and the check could only ever have failed (or, worse,
 * passed against a stub). The hooks just installed live in the config dir the
 * HUMAN uses, so that is the one the probe must read — the token in the
 * environment is what makes the turn the account's, exactly as in a pane.
 */
async function verifyClaudeHooks(ctx: Ctx, account: string): Promise<CheckResult> {
  const token = readLaunchToken(account);
  if (!token) {
    ctx.say(`There is no launch token for ${account}, so the Claude hooks could not be proved by a real turn.`);
    return "unavailable";
  }
  const ok = await attempt(ctx, "the Claude hook check", () => {
    const cwd = probeCwd();
    try {
      probe(probeId("claude"), "claude", ["-p", PROBE_PROMPT, "--model", PROBE_MODEL], cwd, {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        MS_ACCOUNT: account,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  return ok ? "ok" : "skipped";
}

/**
 * The Codex probe: `codex exec`, which fires SessionStart eagerly — unlike the
 * TUI, which fires it lazily on the first turn and would prove nothing here.
 *
 * The probe's cwd is trusted first, exactly as `src/launch.ts` trusts a pane's
 * cwd before launching into it: Codex's trust dialog is a MODAL, so an
 * unattended turn in an untrusted directory does not fail, it waits for ever.
 * A refusal from the trust writer is raised so the human gets its own words
 * and the Retry/Skip/Abort choice.
 */
async function verifyCodexHooks(ctx: Ctx, account: string): Promise<CheckResult> {
  const ok = await attempt(ctx, "the Codex hook check", () => {
    const home = p.codexHome(account);
    const cwd = probeCwd();
    try {
      const { problem } = ensureCodexTrust(home, cwd);
      if (problem) throw new Error(problem);
      probe(probeId("codex"), "codex", ["exec", "--skip-git-repo-check", PROBE_PROMPT], cwd, {
        CODEX_HOME: home,
        MS_ACCOUNT: account,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  return ok ? "ok" : "skipped";
}

/**
 * Install both providers' hooks, then prove them with a real turn.
 *
 * Installing is not the same as working: a settings file can carry four
 * perfect hook entries that never run, and every recovery this tool performs
 * starts with a hook firing. So the step ends with one throwaway turn per
 * provider, under a probe session identity, asserting that a `started` event
 * landed where it should.
 */
async function hooks(ctx: Ctx): Promise<void> {
  const msBin = msBinary();
  const settings = claudeSettingsPath();
  await attempt(ctx, "installing the Claude hooks", () => {
    const r = installClaudeHooks(settings, msBin);
    ctx.say(r.changed ? `The Claude hooks are now in ${settings}.` : `The Claude hooks were already in ${settings}.`);
    if (r.backup) ctx.say(`The previous settings file was kept as ${r.backup}.`);
  });

  for (const name of ctx.state.codex) {
    const home = p.codexHome(name);
    await attempt(ctx, `installing the Codex hooks for ${name}`, () => {
      const r = installCodexHooks(home, msBin);
      // A refusal is data, not an exception — turn it into one here so the
      // human gets the installer's own words and the Retry/Skip/Abort choice.
      if (r.problem) throw new Error(r.problem);
      ctx.say(r.changed ? `The Codex hooks for ${name} are now in ${home}.` : `The Codex hooks for ${name} were already in ${home}.`);
      if (r.backup) ctx.say(`The previous Codex configuration was kept as ${r.backup}.`);
    });
  }

  const results: [Provider, CheckResult][] = [];
  if (ctx.state.claude.length) results.push(["claude", await verifyClaudeHooks(ctx, ctx.state.claude[0])]);
  if (ctx.state.codex.length) results.push(["codex", await verifyCodexHooks(ctx, ctx.state.codex[0])]);
  const verified = results.filter(([, r]) => r === "ok").map(([n]) => n);
  const skipped = results.filter(([, r]) => r === "skipped").map(([n]) => n);
  if (verified.length) ctx.say(`hooks verified (${verified.join(", ")})`);
  if (skipped.length) ctx.say(`hook check skipped (${skipped.join(", ")})`);
  if (!verified.length && !skipped.length) {
    ctx.say("No account was ready to run a hook check, so the hooks are installed but unproven.");
  }
}

// --- 5. statusline --------------------------------------------------------

/** Opt-in, default no: this rewrites a key in the human's own Claude Code
 *  settings, and a refusal from the installer is reported and moved past
 *  rather than treated as a failed setup. */
async function statusline(ctx: Ctx): Promise<void> {
  if (!(await ctx.confirm("Show the account name in Claude Code's statusline?", false))) {
    ctx.say("Leaving Claude Code's statusline as it is.");
    return;
  }
  const r = installStatusline(claudeSettingsPath(), msBinary());
  if (r.problem) {
    ctx.say(`The statusline was left alone: ${r.problem}.`);
    return;
  }
  ctx.say(r.changed ? "The statusline now shows the account name." : "The statusline already showed the account name.");
  if (r.backup) ctx.say(`The previous settings file was kept as ${r.backup}.`);
  ctx.state.optIns.statusline = true;
  ctx.persist();
}

// --- 6. alias -------------------------------------------------------------

/** Opt-in, default no. A shell with no rc-file convention this tool can
 *  safely append to (fish, anything unusual) is told so and left alone, which
 *  is `rcPathFor` returning null. */
async function alias(ctx: Ctx): Promise<void> {
  if (!(await ctx.confirm("Add shell aliases so plain claude and codex go through ms?", false))) {
    ctx.say("Leaving your shell aliases alone.");
    return;
  }
  const shell = process.env.SHELL ?? "";
  const rc = rcPathFor(shell, process.env.HOME || homedir());
  if (!rc) {
    ctx.say(`There is no rc file this tool knows how to append to for ${shell || "your shell"}, so add the two alias lines by hand.`);
    return;
  }
  const r = installAlias(rc, msBinary());
  if (r.problem) {
    ctx.say(`The aliases were left alone: ${r.problem}.`);
    return;
  }
  ctx.say(r.changed ? `The aliases are now in ${rc}, so open a new shell to pick them up.` : `The aliases were already in ${rc}.`);
  if (r.backup) ctx.say(`The previous file was kept as ${r.backup}.`);
  ctx.state.optIns.alias = true;
  ctx.persist();
}

// --- 7. finish ------------------------------------------------------------

/** The full doctor and the status table. Green is the only ending that counts
 *  as done: a wizard that said "all set" over a ✗ would have taught the human
 *  to ignore the one command that tells them the truth. */
async function finish(ctx: Ctx): Promise<void> {
  ctx.say("Last, the full doctor and what ms can see right now.");
  const { lines, exitCode } = await runDoctor(false);
  for (const l of lines) ctx.say(l);
  await status([]);
  if (exitCode !== 0) throw new SetupAbort("ms doctor is not green yet, so fix the ✗ lines above and run ms setup again");
  ctx.say("Setup is complete, and ms is ready to run claude and codex for you.");
}

export const STEP_RUNNERS: Record<SetupStep, (ctx: Ctx) => Promise<void>> = {
  prereqs,
  "claude-accounts": claudeAccounts,
  "codex-accounts": codexAccounts,
  hooks,
  statusline,
  alias,
  finish,
};
