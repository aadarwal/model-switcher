// Claude Code 2.1.288+ screens, built from lines captured off live 2.1.289
// panes on 2026-10-04.
//
// Those versions stopped printing "esc to interrupt" while they work (and
// stopped animating the title glyph), so a working pane no longer says so in
// the words `isBusy` used to look for. What a working pane DOES show is a
// spinner line just above the composer; what a pane whose own turn is over can
// still show, BELOW the composer, is the work running behind it — a workflow,
// a subagent, background shells and monitors — all of them children of the
// process a relaunch ends.
//
// Every quoted line here is a live capture. The layout around them (the
// composer's borders, the status line, the mode line) is the 2.1.289 composer
// region as it is drawn on every pane.

const BORDER = "─".repeat(80);

/** The status line, with the usage bar a status-line script draws: a `▓░`
 *  meter and a "k/M" ratio, neither of which is a workflow's progress. */
export const STATUS_LINE = "  [Fable 5.1 xhigh @account] | repo:main* | ctx (378k/1.0M) | ▓░░░░░░░░░ 10% 8h53m";

/** The mode line every pane shows. "← 1 agent" is a keyboard hint drawn on
 *  every pane, background work or not. */
export const MODE_LINE = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent";

/**
 * A whole pane: the transcript `above` the composer, the composer, and the
 * footer `below` it (the status line and mode line unless a test says
 * otherwise).
 */
export function claudeScreen(above: string[], below: string[] = [STATUS_LINE, MODE_LINE]): string {
  return ["❯ ship it", "", "● Reading the repository.", "", ...above, BORDER, "❯ ", BORDER, ...below, ""].join("\n");
}

// --- Working (mid-turn) ----------------------------------------------------

export const SPINNER_SPROUTING = "✻ Sprouting… (1m 14s · ↓ 2.8k tokens)";
export const SPINNER_CHOREOGRAPHING = "· Choreographing… (16m 21s · ↓ 45.2k tokens · thought for 4s)";
export const TIP_LINE = "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work";
export const SPINNER_RUMINATING = "✻ Ruminating… (16s · thinking with xhigh effort)";

/** The plainest working pane: the spinner, a blank row, the composer. */
export const WORKING_SCREEN = claudeScreen([SPINNER_SPROUTING, ""]);
/** A working pane with an indented tip drawn under its spinner. */
export const WORKING_TIP_SCREEN = claudeScreen([SPINNER_CHOREOGRAPHING, TIP_LINE, ""]);
/** The fullscreen layout: ~30 blank rows between the spinner and the composer. */
export const WORKING_FULLSCREEN_SCREEN = claudeScreen([SPINNER_RUMINATING, ...Array<string>(30).fill("")]);
/** A working pane with its todo list (indented) under the spinner. */
export const WORKING_TODO_SCREEN = claudeScreen([
  SPINNER_SPROUTING,
  "  ⎿  ☒ Read the failing test",
  "     ☐ Write the fix",
  "     ☐ Run the suite",
  "",
]);

// --- Not working -------------------------------------------------------------

/** A finished turn: "Worked for …", no "…" after a verb, no running clock. */
export const DONE_SCREEN = claudeScreen(["✻ Worked for 44m 6s · done 3:08 PM", ""]);
/** Spinner text quoted inside an indented tool result is not this pane's spinner. */
export const QUOTED_SPINNER_SCREEN = claudeScreen([
  "● Bash(tmux capture-pane -p -t %3 | tail -3)",
  "  ⎿  ✻ Ruminating… (1m 22s · ↓ 2.4k tokens)",
  "",
]);

// --- Background work, below the composer -------------------------------------

export const WORKFLOW_LINE = "  ◯ fix-codex-launch-v2  ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  0/3 · 43s · ↓ 164.3k tokens";
export const SUBAGENT_LINE = "  ◯ general-purpose      Footer probe: slow agent";
export const PAUSED_WORKFLOW_LINE = "  ⏸ oct04-backlog-sweep  paused · usage limit resets at 7:10pm";
export const SHELLS_MODE_LINE = "  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← 1 agent";

const FINISHED_TURN = ["✻ Worked for 3m 2s · done 4:12 PM", ""];

/** The turn is over; a workflow is still running behind it. */
export const WORKFLOW_SCREEN = claudeScreen(FINISHED_TURN, [STATUS_LINE, MODE_LINE, WORKFLOW_LINE]);
/** The turn is over; a subagent is still running behind it. */
export const SUBAGENT_SCREEN = claudeScreen(FINISHED_TURN, [STATUS_LINE, MODE_LINE, SUBAGENT_LINE, "  /tasks to see subagents"]);
/** The turn is over; a workflow is paused behind it, waiting out a limit. */
export const PAUSED_WORKFLOW_SCREEN = claudeScreen(FINISHED_TURN, [STATUS_LINE, MODE_LINE, PAUSED_WORKFLOW_LINE]);
/** The turn is over; a background shell and a monitor are still running. */
export const SHELLS_SCREEN = claudeScreen(FINISHED_TURN, [STATUS_LINE, SHELLS_MODE_LINE]);
/** Nothing behind it: the "← 1 agent" hint, the usage bar and the /tasks hint alone. */
export const QUIET_SCREEN = claudeScreen(FINISHED_TURN, [STATUS_LINE, MODE_LINE, "  /tasks to see subagents"]);
