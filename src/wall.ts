/**
 * Wall text, read only to NAME a wall's kind — never to trigger a rotation.
 *
 * Two anchors keep a quoted phrase from reading as a real wall (a live pane
 * that merely quoted "You've hit your usage limit" was rotated twice by
 * screen scraping):
 *  - the pattern is anchored to the line start, with the TUI's own `⎿` result
 *    marker optional — prose that contains the phrase mid-line never matches;
 *  - the search is scoped to the LAST turn. With the fullscreen TUI the
 *    transcript is top-anchored and the composer sits at the bottom, so an
 *    older turn's real wall (or a resumed transcript's re-rendered one) stays
 *    on screen long after it stopped being true.
 *
 * The line-start anchor is not proof of provenance: an assistant message whose
 * own line BEGINS with a wall phrase still names a kind here. That is bounded
 * and acceptable — this function only labels a wall the provider already
 * reported, and the caller never treats the label as the trigger.
 */
export type WallKind = "session" | "weekly" | "fable";

const LEAD = String.raw`^\s*(?:⎿\s*)?`;
/**
 * Order matters: the first pattern that matches names the kind, and the
 * session clause below is a PREFIX of the Codex weekly one ("You've hit your
 * usage limit for this week"), so the weekly entry has to be tried first.
 *
 * The Codex entries come from the spike record (2026-09-16, Codex CLI
 * 0.153.4). Its default Pro wall, verbatim, is:
 *
 *   You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
 *   to purchase more credits or try again later.
 *
 * whose opening clause the existing `session` pattern already matched — it is
 * listed explicitly all the same, because the wording "varies with reset time,
 * plan, model and workspace limits" and a Codex reader should not have to
 * discover that its wall is covered by a clause written for Claude. The
 * settings URL is a second, independent anchor for the case where the TUI
 * wraps the sentence and the first line on screen is the URL.
 *
 * Text still only NAMES a wall. For Codex the trigger is the turn watchdog's
 * own usage poll reading a window at 100 (`ms _turn`); this is the gate that
 * decides whether that poll is worth making.
 */
const PATTERNS: [WallKind, RegExp][] = [
  ["fable", new RegExp(LEAD + String.raw`(?:you'?ve reached your fable limit|fable limit reached)`, "i")],
  ["weekly", new RegExp(LEAD + String.raw`(?:you'?(?:ve|\s+have) reached your weekly usage limit|weekly limit reached|you'?ve hit your (?:usage |rate )?limits? for (?:this|the) week)`, "i")],
  ["session", new RegExp(LEAD + String.raw`(?:you'?ve hit your (?:usage |session |weekly )?limit|new messages wait for your usage limit to reset|claude usage limit reached|usage limit reached)`, "i")],
  ["session", new RegExp(LEAD + String.raw`visit https?://chatgpt\.com/codex/settings/usage`, "i")],
];

/** A choice cursor in an option list (`❯ 1. Yes`). It wears the prompt glyph but
 * is neither a composer nor a user echo — reading it as one truncates the scope
 * below a wall whenever a dialog is on screen. */
const OPTION = /^\s*[❯›]\s*\d+\./;
/** A prompt glyph at the line start: the composer, or a user echo. */
const PROMPT = /^\s*[❯›]/;
/** A user echo: the prompt glyph followed by the text the human submitted. */
const ECHO = /^\s*[❯›]\s+\S/;

const isPrompt = (l: string): boolean => PROMPT.test(l) && !OPTION.test(l);
const isEcho = (l: string): boolean => ECHO.test(l) && !OPTION.test(l);

/** The last turn: from the last `❯ text` echo up to the composer (bottom-most `❯`/`›`); fallback 16 rows above it. */
export function lastTurn(screen: string): string[] {
  const lines = screen.split("\n");
  let n = lines.length;
  while (n > 0 && !lines[n - 1].trim()) n--;

  let comp = -1;
  for (let i = n - 1; i >= 0; i--) if (isPrompt(lines[i])) { comp = i; break; }

  // The bottom-most prompt line carries text, so it is the user's own echo, not
  // an empty composer: this TUI is drawing its composer in a form we do not
  // recognise as one (boxed — `│ ❯ ` — or with a `>` glyph). Anchoring `end`
  // above it would scope the search to the PREVIOUS turn and miss every real
  // wall. The turn is that echo down to the bottom of the screen instead.
  if (comp >= 0 && isEcho(lines[comp])) return lines.slice(comp, n);

  const end = comp >= 0 ? comp : n;
  let start = -1;
  for (let i = end - 1; i >= 0; i--) if (isEcho(lines[i])) { start = i; break; }
  if (start < 0) start = Math.max(0, end - 16);
  return lines.slice(start, end);
}

/** The wall kind the last turn's own rendering reports, or null. */
export function wallKindFromText(screen: string): WallKind | null {
  const scope = lastTurn(screen);
  for (const [kind, re] of PATTERNS) if (scope.some((l) => re.test(l))) return kind;
  return null;
}
