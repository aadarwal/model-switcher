import { test } from "node:test";
import assert from "node:assert/strict";
import { lastTurn, wallKindFromText } from "../src/wall.ts";

const FABLE = "  ⎿  You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";

/** The plain fullscreen shape: transcript, the turn's echo, its result, a bare composer. */
const plain = (body: string) => `❯ do it\n${body}\n\n❯ \n`;

test("wallKindFromText reads each wall kind from the TUI's own rendering", () => {
  assert.equal(wallKindFromText(plain(FABLE)), "fable");
  assert.equal(wallKindFromText(plain("  ⎿  You've reached your weekly usage limit. Resets Monday.")), "weekly");
  assert.equal(wallKindFromText(plain("  ⎿  You've hit your usage limit. New messages wait for your usage limit to reset.")), "session");
  assert.equal(wallKindFromText(plain("Claude usage limit reached")), "session");
  assert.equal(wallKindFromText(plain("  ⎿  Wrote 12 lines to src/wall.ts")), null);
});

test("wall text quoted in prose or left in an earlier turn never reads as a wall", () => {
  // mid-line prose: the anchor is the line start, so this is not a wall
  assert.equal(wallKindFromText("❯ explain\n  the pane said You've hit your usage limit and rotated twice\n\n❯ \n"), null);
  // an earlier turn's real wall is out of scope once a new turn starts
  const old = `❯ first\n${FABLE}\n❯ second\n  ⎿  Done.\n\n❯ \n`;
  assert.equal(wallKindFromText(old), null);
  assert.deepEqual(lastTurn(old), ["❯ second", "  ⎿  Done.", ""]);
});

test("with no user echo above the composer the scope falls back to 16 rows", () => {
  const deep = [...Array(30).keys()].map((i) => `row ${i}`);
  deep[10] = FABLE;
  assert.equal(wallKindFromText(deep.join("\n") + "\n❯ \n"), null, "row 10 is above the 16-row window");
  deep[20] = FABLE;
  assert.equal(wallKindFromText(deep.join("\n") + "\n❯ \n"), "fable", "row 20 is inside it");
});

/** A 59-row fullscreen screen whose composer is drawn INSIDE a rounded box, so
 * the bottom-most `❯` on screen is the turn's own echo, not the composer. */
function fullscreenBoxed(wall: string, composer = "│ ❯                                      │"): string {
  const rows = ["✻ Claude Code v2.1.272 — /Users/a/src/app"];
  for (let i = 0; i < 49; i++) rows.push(`  ⎿  transcript row ${i}`);
  rows.push("❯ run the migration");
  rows.push("");
  rows.push("● I'll run it.");
  rows.push(wall);
  rows.push("");
  rows.push("╭────────────────────────────────────────╮");
  rows.push(composer);
  rows.push("╰────────────────────────────────────────╯");
  rows.push("  ? for shortcuts");
  return rows.join("\n") + "\n";
}

test("a composer we cannot recognise (boxed, or a > glyph) scopes the turn to the bottom of the screen", () => {
  const boxed = fullscreenBoxed(FABLE);
  assert.equal(boxed.trimEnd().split("\n").length, 59, "the fixture is a 59-row fullscreen screen");
  // Before the guard the scope collapsed onto the PREVIOUS turn and every real
  // wall read `unknown`.
  assert.equal(wallKindFromText(boxed), "fable");
  assert.ok(lastTurn(boxed)[0].startsWith("❯ run the migration"));
  assert.ok(lastTurn(boxed).some((l) => l.includes("Fable limit")));
  // a `>` glyph composer is equally unrecognised, and equally must not hide the wall
  assert.equal(wallKindFromText(`❯ run it\n${FABLE}\n\n> \n`), "fable");
  // and the guard must not swallow an OLD wall: a later echo still wins
  assert.equal(wallKindFromText(fullscreenBoxed("  ⎿  Done.")), null);
});

test("a choice cursor in an option list is not a composer and not an echo", () => {
  // the Fable "Continue on Opus?" dialog, with a bare composer below it
  const dialog = [
    "❯ switch me to opus",
    FABLE,
    "",
    "  Continue on Opus?",
    "  ❯ 1. Yes, continue",
    "    2. No, stop here",
    "",
    "❯ ",
    "",
  ].join("\n");
  assert.equal(wallKindFromText(dialog), "fable", "the cursor must not truncate the scope below the wall");
  assert.equal(lastTurn(dialog)[0], "❯ switch me to opus");

  // the same dialog drawn inside a box, with no composer under it
  const boxedDialog = [
    "❯ switch me to opus",
    FABLE,
    "╭─ Continue on Opus? ─────────╮",
    "│ ❯ 1. Yes, continue          │",
    "│   2. No, stop here          │",
    "╰─────────────────────────────╯",
    "",
  ].join("\n");
  assert.equal(wallKindFromText(boxedDialog), "fable");

  // an unboxed option list with no composer at all: the cursor is still not an echo
  assert.equal(wallKindFromText(`❯ switch me to opus\n${FABLE}\n\n  ❯ 1. Yes\n    2. No\n`), "fable");
});
