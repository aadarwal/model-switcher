// src/setup/prompt.ts
//
// The wizard's only channel to a human: `ask`/`confirm` on an injectable
// `Prompter`. `readlinePrompter()` is the real one — `node:readline/promises`
// over the process's own stdin/stdout, unbounded, because it is waiting on a
// person. `scriptedPrompter(answers)` is the test double the wizard's own
// tests script against: it hands out `answers` in order and throws
// `SetupPromptExhausted` the moment more are asked for than were given, so a
// wizard test that asks one question too many fails loud, on that question,
// rather than quietly resolving `undefined`.
//
// Both share one contract, implemented once (`resolveAsk`/`resolveConfirm`)
// over an abstract "get the next raw answer" step: `ask` re-asks (getting
// another raw answer) until it sees one inside `choices` — or, absent
// `choices`, returns whatever came back; an empty answer stands in for
// `opts.default` when one was given. `confirm` maps `y`/`yes`/`n`/`no`
// (case-insensitive) to booleans, `""` to `def`, and re-asks otherwise.

import * as readline from "node:readline/promises";

export type Prompter = {
  ask(q: string, opts?: { default?: string; choices?: string[] }): Promise<string>;
  confirm(q: string, def: boolean): Promise<boolean>;
  /** Release whatever the prompter is holding open. `readlinePrompter`
   * attaches to the process's real stdin on its first question, and a
   * readline interface keeps stdin — and therefore the event loop — alive
   * for ever: `ms setup` computed its exit code and then simply never
   * returned, so every interactive run ended in a ctrl-C (exit 130) with
   * the 0-or-1 the doctor decided thrown away. The caller closes it on
   * EVERY exit path, which is why this is part of the contract rather than
   * a detail of the real implementation. A prompter with nothing to release
   * (the test double) may leave it out. */
  close?(): void;
};

/** A wizard asked for an answer `scriptedPrompter` had none left to give —
 * always a test-authoring bug (too few scripted answers, or a wizard path
 * that asks more than the test expected), never something to swallow. */
export class SetupPromptExhausted extends Error {
  constructor(question: string) {
    super(`setup prompt exhausted: no scripted answer for "${question}"`);
    this.name = "SetupPromptExhausted";
  }
}

async function resolveAsk(nextRaw: () => Promise<string>, opts?: { default?: string; choices?: string[] }): Promise<string> {
  for (;;) {
    const raw = (await nextRaw()).trim();
    const answer = raw === "" && opts?.default !== undefined ? opts.default : raw;
    if (!opts?.choices || opts.choices.includes(answer)) return answer;
  }
}

async function resolveConfirm(nextRaw: () => Promise<string>, def: boolean): Promise<boolean> {
  for (;;) {
    const raw = (await nextRaw()).trim().toLowerCase();
    if (raw === "") return def;
    if (raw === "y" || raw === "yes") return true;
    if (raw === "n" || raw === "no") return false;
  }
}

function formatAsk(q: string, opts?: { default?: string; choices?: string[] }): string {
  const choices = opts?.choices ? ` [${opts.choices.join("/")}]` : "";
  const def = opts?.default !== undefined ? ` (default: ${opts.default})` : "";
  return `${q}${choices}${def}: `;
}

function formatConfirm(q: string, def: boolean): string {
  return `${q} [${def ? "Y/n" : "y/N"}]: `;
}

/** The real prompter. `readline.createInterface` is created lazily, on the
 * first actual question — constructing it eagerly would attach to the
 * process's real stdin the moment a wizard is built, whether or not it ever
 * asks anything, which is exactly the side effect a test importing this
 * module must never trigger. */
export function readlinePrompter(): Prompter {
  let rl: readline.Interface | undefined;
  const iface = (): readline.Interface => (rl ??= readline.createInterface({ input: process.stdin, output: process.stdout }));
  return {
    ask: (q, opts) => resolveAsk(() => iface().question(formatAsk(q, opts)), opts),
    confirm: (q, def) => resolveConfirm(() => iface().question(formatConfirm(q, def)), def),
    close: () => {
      // Both halves matter: `rl.close()` alone leaves the underlying stdin
      // stream flowing and referenced (readline resumed it to read), so the
      // process still does not exit. A run that never asked anything created
      // no interface at all and has nothing to release.
      rl?.close();
      rl = undefined;
      try {
        process.stdin.pause();
        process.stdin.unref();
      } catch {
        /* already gone */
      }
    },
  };
}

/** The test double: `answers` are consumed in order, across both `ask` and
 * `confirm` (they share one queue — a wizard test scripts the whole
 * conversation as one flat list, in the order it expects to be asked). */
export function scriptedPrompter(answers: string[]): Prompter {
  const queue = [...answers];
  const nextRaw = (question: string) => async (): Promise<string> => {
    if (queue.length === 0) throw new SetupPromptExhausted(question);
    return queue.shift() as string;
  };
  return {
    ask: (q, opts) => resolveAsk(nextRaw(q), opts),
    confirm: (q, def) => resolveConfirm(nextRaw(q), def),
  };
}
