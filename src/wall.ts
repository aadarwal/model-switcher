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
 */
export type WallKind = "session" | "weekly" | "fable";

const LEAD = String.raw`^\s*(?:⎿\s*)?`;
const PATTERNS: [WallKind, RegExp][] = [
  ["fable", new RegExp(LEAD + String.raw`(?:you'?ve reached your fable limit|fable limit reached)`, "i")],
  ["weekly", new RegExp(LEAD + String.raw`(?:you'?(?:ve|\s+have) reached your weekly usage limit|weekly limit reached)`, "i")],
  ["session", new RegExp(LEAD + String.raw`(?:you'?ve hit your (?:usage )?limit|new messages wait for your usage limit to reset|claude usage limit reached|usage limit reached)`, "i")],
];

/** The last turn: from the last `❯ text` echo up to the composer (bottom-most `❯`/`›`); fallback 16 rows above it. */
export function lastTurn(screen: string): string[] {
  const lines = screen.split("\n");
  let n = lines.length;
  while (n > 0 && !lines[n - 1].trim()) n--;
  let comp = -1;
  for (let i = n - 1; i >= 0; i--) if (/^\s*[❯›]/.test(lines[i])) { comp = i; break; }
  const end = comp >= 0 ? comp : n;
  let start = -1;
  for (let i = end - 1; i >= 0; i--) if (/^\s*[❯›]\s+\S/.test(lines[i])) { start = i; break; }
  if (start < 0) start = Math.max(0, end - 16);
  return lines.slice(start, end);
}

/** The wall kind the last turn's own rendering reports, or null. */
export function wallKindFromText(screen: string): WallKind | null {
  const scope = lastTurn(screen);
  for (const [kind, re] of PATTERNS) if (scope.some((l) => re.test(l))) return kind;
  return null;
}
