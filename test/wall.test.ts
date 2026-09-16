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
  // Seen live 2026-09-15 from a headless `claude -p` on a 5 h-walled account.
  assert.equal(wallKindFromText(plain("You've hit your session limit · resets 10:10pm (America/New_York)")), "session");
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

/** The Codex wall, verbatim from the spike record (Codex CLI 0.153.4, Pro plan,
 * no reset time). The wording "varies with reset time, plan, model and
 * workspace limits", so the variants below are the ones the record names. */
const CODEX = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.";

test("the Codex wall is named from its own default text and its wrapped variants", () => {
  assert.equal(wallKindFromText(plain(CODEX)), "session");
  // Codex's TUI is not Claude's: it draws no `⎿` result marker, and the wall
  // may arrive indented or wrapped so that the settings URL is its own line.
  assert.equal(wallKindFromText(plain(`  ${CODEX}`)), "session");
  assert.equal(wallKindFromText(plain("Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.")), "session");
  // The weekly variant the spike quoted. It must not fall through to `session`:
  // the session clause is a prefix of it, so the weekly pattern is tried first.
  assert.equal(wallKindFromText(plain("You've hit your usage limit for this week.")), "weekly");
  assert.equal(wallKindFromText(plain("Youve hit your usage limit for the week")), "weekly");
  // A Codex turn that merely worked is not a wall.
  assert.equal(wallKindFromText(plain("• Ran `npm test` — 418 passing")), null);
});

test("Codex wall text quoted in prose, or left behind by an earlier turn, is not a wall", () => {
  // The spike proved this one the hard way: the model was ASKED to echo "You've
  // hit your usage limit for this week." and it came back verbatim in Stop's
  // last_assistant_message. Text is never evidence on its own.
  assert.equal(wallKindFromText(`❯ what does codex say when it runs out\n  it says You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to buy more.\n\n❯ \n`), null);
  assert.equal(wallKindFromText(`❯ explain\n  the docs mention you've hit your usage limit for this week as the weekly wording\n\n❯ \n`), null);
  // and a real wall from a PREVIOUS turn is out of scope once a new turn starts
  assert.equal(wallKindFromText(`❯ first\n${CODEX}\n❯ second\n  Done.\n\n❯ \n`), null);
});

/**
 * The wall as the Codex TUI actually draws it, and the 429 that merely looks
 * like one.
 *
 * Both strings are verbatim from the source of `rust-v0.154.0` (commit
 * 6b9826e) and from the verified record quoted in the wall-drill research
 * (docs/superpowers/plans/2026-09-16-codex-wall-mock.md): the message text is
 * built at `codex-rs/protocol/src/error.rs:710-751` and printed as one red
 * `■ {message}` line by `codex-rs/tui/src/history_cell/notices.rs:244-250`.
 *
 * The negative matters as much as the positive. A 429 whose body is NOT
 * `{"error":{"type":"usage_limit_reached"}}` becomes `RetryLimit` instead
 * (`codex-rs/codex-api/src/api_bridge.rs:165`) and renders "exceeded retry
 * limit, last status: 429 Too Many Requests"
 * (`codex-rs/protocol/src/error.rs:628-640`) — a transient failure that must
 * never be read as being out of quota.
 */
const CODEX_TUI = "■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 11th, 2026 9:23 PM.";

test("the Codex wall is named through the TUI's own ■ error glyph, and a generic 429 is not a wall", () => {
  assert.equal(wallKindFromText(plain(CODEX_TUI)), "session");
  assert.equal(wallKindFromText(plain("■ You've hit your usage limit. Try again later.")), "session");
  // The same-day reset variant, which renders a bare clock time.
  assert.equal(wallKindFromText(plain("■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:29 PM.")), "session");
  // The glyph does not weaken the quoted-prose guard: mid-line is still no.
  assert.equal(wallKindFromText(`❯ what happens\n  it prints ■ You've hit your usage limit. and stops\n\n❯ \n`), null);

  // The generic 429. Same status upstream, different error, different text —
  // and it must not rotate an account that still has quota.
  assert.equal(wallKindFromText(plain("■ exceeded retry limit, last status: 429 Too Many Requests")), null);
  assert.equal(wallKindFromText(plain("■ exceeded retry limit, last status: 429 Too Many Requests, request id: req_123")), null);
});
