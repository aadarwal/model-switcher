// src/handback.ts
//
// Giving a pane back to the human (spec §7: when a session ends normally "the
// pane is not left dead … so a pane that ran `ms claude` returns to a prompt
// exactly as a pane that ran `claude` would").
//
// Two callers reach it — `ms stop` (src/manual.ts) and reconciliation's
// `settleDeadPane`, which is also tmux's `pane-died` hook (src/reconcile.ts) —
// and they must do the same two things in the same order, because the order is
// the whole of it:
//
//   1. **`remain-on-exit off` first.** The tool turned it ON so that a CLI exit
//      could never destroy a pane it might still need to respawn. Left on over
//      the human's login shell it turns their next `exit` into a corpse: the
//      pane goes dead, `pane-died` fires, finds a session that is already
//      `stopped`, returns — and the pane sits as "Pane is dead" until someone
//      kills it by hand. That was the whole of the reported defect: only
//      `ms stop` turned the option off, so every ordinary `/exit` left a pane
//      the human could not close.
//   2. **Then respawn the login shell** in the session's own cwd.
//
// What to do about a respawn that fails is the caller's business, so it is
// thrown rather than swallowed here: `ms stop` turns it into a note for the
// human (the CLI has gone either way, and recording the session as `stopping`
// would be the one untrue thing), while reconciliation ignores it — the pane
// went away between the check and the respawn, and the store row is the
// load-bearing record.

import { Tmux } from "./tmux.ts";

/** The shell a released pane is handed back to. */
export const loginShell = (): string => process.env.SHELL || "/bin/zsh";

/**
 * The pane is not the tool's any more. Best effort: a pane that has gone in
 * the meantime is still not ours, and the caller is mid-teardown either way.
 */
export function releasePane(tmux: Tmux, pane: string): void {
  try {
    tmux.remainOnExit(pane, false);
  } catch {
    /* the pane may have gone in the meantime; it is still not ours */
  }
}

/** Release the pane and put the human's login shell back in it. */
export function handBackShell(tmux: Tmux, pane: string, cwd: string): void {
  releasePane(tmux, pane);
  tmux.respawn(pane, cwd, [loginShell(), "-l"]);
}
