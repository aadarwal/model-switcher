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
// Exit codes: 0 when the run reached the end with a green doctor, 1 when a
// step stopped the run (`SetupAbort`, always after saying why), 2 for a
// mistyped command line.

import type { Verb } from "./cli.ts";
import { readlinePrompter, type Prompter } from "./setup/prompt.ts";
import { loadSetup, markDone, resetSetup } from "./setup/state.ts";
import { makeCtx, SetupAbort, STEP_LABEL, STEP_ORDER, STEP_RUNNERS } from "./setup/steps.ts";

const USAGE = `usage: ms setup [--resume] [--reset] [--yes]
  --resume  continue at the first step not finished (the default when there is one)
  --reset   forget how far setup got, keeping every account and credential
  --yes     accept every default and ask nothing (installs no opt-ins)`;

/**
 * Run the wizard against a prompter, and return the exit code.
 *
 * The prompter is injected rather than constructed here so the whole
 * conversation is scriptable: `scriptedPrompter` drives this in tests exactly
 * as a human drives `readlinePrompter` in the terminal, and a wizard that asks
 * one question more than a test scripted fails loudly on that question.
 */
export async function runSetup(prompter: Prompter, opts: { resume: boolean; reset: boolean; yes: boolean }): Promise<number> {
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

export const setupVerb: Verb = async (args) => {
  let resume = false;
  let reset = false;
  let yes = false;
  for (const a of args) {
    if (a === "--resume") resume = true;
    else if (a === "--reset") reset = true;
    else if (a === "--yes") yes = true;
    else {
      process.stderr.write(`ms setup: unknown option ${a}\n${USAGE}\n`);
      return 2;
    }
  }
  return await runSetup(readlinePrompter(), { resume, reset, yes });
};
