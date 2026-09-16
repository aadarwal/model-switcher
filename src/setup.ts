// src/setup.ts
//
// `ms setup` — the wizard, which is a driver and nothing else.
//
// Every step is in ./setup/steps.ts and every verb those steps call already
// existed and was already tested before this file did. What this file owns is
// the sequence, the resume, and the exit code:
//
//   * the seven steps run in one fixed order (`STEP_ORDER`);
//   * a step is marked done in `MS_HOME/setup.json` the moment it completes,
//     so the answer to a question is durable before the next question is
//     asked — a closed terminal, a ctrl-c or a crash costs the current step
//     and nothing before it;
//   * `--resume` is therefore the DEFAULT whenever a state file carries
//     progress; the flag exists so a human can say it out loud, and says one
//     line when there was nothing to resume;
//   * `--reset` deletes that one file. Never an account, never a credential,
//     never a hook: only the wizard's memory of how far it got;
//   * `--yes` accepts every default, which is how the smoke script runs it —
//     and because every opt-in defaults to No, `--yes` installs none of them.
//
// Two paths are NOT the seven steps, and this file owns them too because
// they are the other half of "the wizard edited my machine":
//
//   * `--repair` re-runs the hooks and the final check against the accounts
//     that are already registered, with no login and no questions about
//     counts. `--resume` cannot do this — it SKIPS every step already in
//     `done`, which after a finished run is all of them — and `--reset` would
//     re-run a full browser login for every account. Repair is the answer to
//     "something deleted my hooks", which is exactly what a CLI upgrade, a
//     dotfiles restore or a hand edit does.
//   * `--remove statusline|alias` undoes the two opt-ins. They write into the
//     human's own `settings.json` and rc file, and the removers existed from
//     the start but were reachable from no verb at all, so the only undo was
//     hand-editing an undocumented key and an unexplained marker block.
//
// Exit codes: 0 when the run reached the end with a green doctor, 1 when a
// step stopped the run (`SetupAbort`, always after saying why) or a removal
// refused, 2 for a mistyped command line.

import { homedir } from "node:os";
import type { Verb } from "./cli.ts";
import { claudeSettingsPath } from "./paths.ts";
import { rcPathFor, removeAlias } from "./setup/alias.ts";
import { readlinePrompter, type Prompter } from "./setup/prompt.ts";
import { loadSetup, markDone, resetSetup, saveSetup } from "./setup/state.ts";
import { removeStatusline } from "./setup/statusline.ts";
import { makeCtx, registeredAccounts, SetupAbort, STEP_LABEL, STEP_ORDER, STEP_RUNNERS } from "./setup/steps.ts";

const USAGE = `usage: ms setup [--resume] [--reset] [--yes] [--repair] [--remove statusline|alias]
  --resume            continue at the first step not finished (the default when there is one)
  --reset             forget how far setup got, keeping every account and credential
  --yes               accept every default and ask nothing (installs no opt-ins)
  --repair            re-install the hooks for the accounts already registered, without logging in again
  --remove <what>     undo an opt-in: 'statusline' or 'alias' (both may be given)`;

export type RemovableOptIn = "statusline" | "alias";
export type SetupOpts = { resume: boolean; reset: boolean; yes: boolean; repair?: boolean; remove?: RemovableOptIn[] };

/**
 * Run the wizard against a prompter, and return the exit code.
 *
 * The prompter is injected rather than constructed here so the whole
 * conversation is scriptable: `scriptedPrompter` drives this in tests exactly
 * as a human drives `readlinePrompter` in the terminal, and a wizard that asks
 * one question more than a test scripted fails loudly on that question.
 */
export async function runSetup(prompter: Prompter, opts: SetupOpts): Promise<number> {
  if (opts.remove?.length) return removeOptIns(opts.remove, (l) => process.stdout.write(`${l}\n`));
  if (opts.repair) return await runRepair(prompter, opts);

  if (opts.reset) resetSetup();
  const state = loadSetup();
  const ctx = makeCtx(prompter, state, opts.yes);

  if (state.done.length) ctx.say(`Resuming the setup that started at ${state.startedAt}.`);
  else if (opts.resume) ctx.say("There was nothing to resume, so this is a fresh setup.");

  try {
    for (const step of STEP_ORDER) {
      if (ctx.state.done.includes(step)) {
        ctx.say(`Skipping ${STEP_LABEL[step]}, which an earlier run already finished.`);
        continue;
      }
      await STEP_RUNNERS[step](ctx);
      // The moment it completes, and not one step later: a `done` that is
      // only durable at the end of the run is not a resume point at all.
      ctx.state = markDone(ctx.state, step);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof SetupAbort)) throw e;
    process.stderr.write(`ms setup: ${e.message}.\n`);
    return 1;
  }
}

/**
 * `--repair`: the hooks and the final check, over the accounts that are
 * already there.
 *
 * It reads the accounts from the REGISTRY, never from `setup.json`'s memory
 * of some past run — the rows with credentials are the durable fact, and a
 * human repairing an install months later may be running a wizard that never
 * met them. Nothing here logs in, asks for a count, or asks about an opt-in:
 * the two steps it runs are the ones a CLI upgrade, a dotfiles restore or a
 * hand edit breaks.
 *
 * `setup.json` is only READ (for the opt-in record and the timestamps) and
 * is not advanced: repair is not progress through the wizard, and a machine
 * that has never run `ms setup` at all can still repair hooks for accounts
 * added with `ms accounts add`.
 */
export async function runRepair(prompter: Prompter, opts: { yes: boolean }): Promise<number> {
  const state = loadSetup();
  let accounts: { claude: string[]; codex: string[] };
  try {
    accounts = registeredAccounts();
  } catch (e) {
    process.stderr.write(`ms setup: ${(e as Error).message}\n`);
    return 1;
  }

  const ctx = makeCtx(prompter, { ...state, claude: accounts.claude, codex: accounts.codex }, opts.yes);
  const total = accounts.claude.length + accounts.codex.length;
  if (total === 0) {
    ctx.say("No accounts are registered yet, so there are no hooks to repair — run ms setup without --repair.");
    return 1;
  }
  ctx.say(`Repairing the hooks for ${total} registered account${total === 1 ? "" : "s"}, without signing in to anything again.`);

  try {
    await STEP_RUNNERS.hooks(ctx);
    await STEP_RUNNERS.finish(ctx);
    return 0;
  } catch (e) {
    if (!(e instanceof SetupAbort)) throw e;
    process.stderr.write(`ms setup: ${e.message}.\n`);
    return 1;
  }
}

/**
 * `--remove statusline|alias`: undo an opt-in, and say exactly what happened.
 *
 * Each remover already refuses anything it does not recognise as its own (a
 * hand-edited block, a `statusLine` this tool never wrote), reporting it as a
 * `problem` rather than throwing — so this prints that verbatim and answers
 * 1. The backup path is printed whenever one was made, because the point of
 * an undo the human can trust is that they can see what it undid.
 *
 * `setup.json`'s `optIns` record is cleared for whatever was actually
 * removed, so a later `ms setup` asks about it again rather than believing a
 * thing that is no longer installed.
 */
export function removeOptIns(what: RemovableOptIn[], say: (line: string) => void): number {
  const state = loadSetup();
  let failed = false;
  let touched = false;

  for (const one of what) {
    if (one === "statusline") {
      const settings = claudeSettingsPath();
      const r = removeStatusline(settings);
      if (r.problem) {
        say(`The statusline was left alone: ${r.problem}.`);
        failed = true;
        continue;
      }
      say(r.changed ? `The account name is no longer in Claude Code's statusline (${settings}).` : `Claude Code's statusline was not this tool's to remove (${settings}).`);
      if (r.backup) say(`The previous settings file was kept as ${r.backup}.`);
      if (r.changed) {
        state.optIns.statusline = false;
        touched = true;
      }
    } else {
      const shell = process.env.SHELL ?? "";
      const rc = rcPathFor(shell, process.env.HOME || homedir());
      if (!rc) {
        say(`There is no rc file this tool knows how to edit for ${shell || "your shell"}, so remove the two alias lines by hand.`);
        failed = true;
        continue;
      }
      const r = removeAlias(rc);
      if (r.problem) {
        say(`The aliases were left alone: ${r.problem}.`);
        failed = true;
        continue;
      }
      say(r.changed ? `The ms aliases are gone from ${rc}, so open a new shell to stop using them.` : `There were no ms aliases in ${rc}.`);
      if (r.backup) say(`The previous file was kept as ${r.backup}.`);
      if (r.changed) {
        state.optIns.alias = false;
        touched = true;
      }
    }
  }

  if (touched) saveSetup({ ...state, updatedAt: new Date().toISOString() });
  return failed ? 1 : 0;
}

export const setupVerb: Verb = async (args) => {
  let resume = false;
  let reset = false;
  let yes = false;
  let repair = false;
  const remove: RemovableOptIn[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--resume") resume = true;
    else if (a === "--reset") reset = true;
    else if (a === "--yes") yes = true;
    else if (a === "--repair") repair = true;
    else if (a === "--remove") {
      const what = args[++i];
      if (what !== "statusline" && what !== "alias") {
        process.stderr.write(`ms setup: --remove takes 'statusline' or 'alias', not ${what ?? "(nothing)"}\n${USAGE}\n`);
        return 2;
      }
      if (!remove.includes(what)) remove.push(what);
    } else {
      process.stderr.write(`ms setup: unknown option ${a}\n${USAGE}\n`);
      return 2;
    }
  }
  if (remove.length && (repair || reset)) {
    process.stderr.write(`ms setup: --remove does one thing only; run it on its own\n${USAGE}\n`);
    return 2;
  }

  const prompter = readlinePrompter();
  try {
    return await runSetup(prompter, { resume, reset, yes, repair, remove });
  } finally {
    // On EVERY exit path, including a throw: `readlinePrompter` attaches to
    // the process's real stdin at its first question and holds it — and
    // therefore the event loop — open for ever. Without this the verb
    // computed its exit code and then simply never returned, so an
    // interactive run ended in ctrl-C (130) and the answer was lost.
    prompter.close?.();
  }
};
