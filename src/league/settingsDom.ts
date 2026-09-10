/**
 * THE LEAGUE SETTINGS THAT ONLY THE RENDERED PAGE KNOWS.
 *
 * `scoringFromEspn` reads the mSettings API and gets every scoring VALUE. Two things are not in that
 * payload at all, and both were discovered by reading the page rather than by reading the docs:
 *
 *   POSITION MAXIMUMS -- how many of a position a roster may hold (QB 4, RB 8, WR 8, TE 3 here).
 *     Nothing in this repo modelled them. `rosterGaps` validates the STARTING lineup, which is a
 *     different question: a roster can be perfectly startable and still illegal. Measured against
 *     the real trade candidates, 2 of 95 breached a maximum -- both sending a third-string tight end
 *     to the one team already holding three.
 *
 *   THE POINTS-ALLOWED LADDER'S BOUNDARIES. ESPN spreads the ladder across statIds whose VALUES the
 *     API returns (-1 .. -7) but whose TIER EDGES it does not. `src/draft/scoring.ts` says so at the
 *     parser and falls back to a derived default. That default turns out to be exactly right for
 *     this league, which is worth knowing but is not something you can assume for the next one.
 *
 * The parser is separated from the page-driving so it can be tested on captured text. The DOM shape
 * it depends on is one row per setting, with the label, its abbreviation in parentheses, and the
 * value(s) separated by whitespace -- e.g. "Quarterback (QB)\n\t\n1\n\t\n4".
 */

/** How many of each position a roster may hold. Absent from the map = ESPN said "No Limit"/"N/A". */
export type PositionMaximums = Record<string, number>;

export interface ParsedSettings {
  /** Position code -> maximum rostered. Only positions ESPN gives a finite limit for. */
  posMax: PositionMaximums;
  /** Position code -> starting slots, for cross-checking the slot template we already store. */
  starters: Record<string, number>;
  /** [maxPointsAllowed, points]; the open top tier carries `null`. Empty when the page had no tiers. */
  paLadder: [number | null, number][];
  /** Every `(CODE) -> value` scoring pair the page listed, for cross-checking the API. */
  scoring: Record<string, number>;
  /** Flat facts worth storing verbatim; keys are the page's own labels. */
  misc: Record<string, string>;
}

const NUM = /^-?\d+(?:\.\d+)?$/;

/** Split a row's innerText into its label and the cells after it. */
function cells(line: string): string[] {
  return line.split(/[\n\t]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse the settings page's row text. Input is one string per table row, in document order.
 *
 * WHY THIS TOLERATES MISSING ROWS RATHER THAN THROWING. ESPN omits a scoring item whose value is
 * zero -- this league's page lists no "0 points allowed" or "1-6 points allowed" row at all, because
 * both score nothing. A parser that required all eight tiers would refuse a correct page. So the
 * ladder is built from what IS listed and the gap below the lowest listed tier is filled with a zero
 * tier, which is what the omission means.
 */
export function parseSettingsRows(rows: string[]): ParsedSettings {
  const out: ParsedSettings = { posMax: {}, starters: {}, paLadder: [], scoring: {}, misc: {} };
  const paTiers: { upTo: number | null; pts: number }[] = [];

  for (const raw of rows) {
    const c = cells(raw);
    if (c.length < 2) continue;
    const label = c[0];
    const code = label.match(/\(([A-Z0-9/]+)\)\s*$/)?.[1];

    // --- position rows: "<name> (CODE)  <starters>  <maximum>" -------------------------------------
    // The maximum is "No Limit" or "N/A" for the flex-ish slots, which is not a number and must not
    // become one. Only a finite integer is stored, so a consumer can tell "unlimited" from "zero".
    if (code && c.length >= 3 && NUM.test(c[1])) {
      out.starters[code] = Number(c[1]);
      if (NUM.test(c[2])) out.posMax[code] = Number(c[2]);
      continue;
    }

    // --- points-allowed tiers: "7-13 points allowed (PA7)  -1" / "46+ points allowed (PA46)  -7" ---
    if (code && /^PA\d+$/.test(code) && NUM.test(c[1])) {
      const pts = Number(c[1]);
      const range = label.match(/(\d+)\s*[-–]\s*(\d+)\s*points?\s+allowed/i);
      const open = label.match(/(\d+)\s*\+\s*points?\s+allowed/i);
      if (range) paTiers.push({ upTo: Number(range[2]), pts });
      else if (open) paTiers.push({ upTo: null, pts });
      continue;
    }

    // --- any other scoring row: "<name> (CODE)  <value>" -------------------------------------------
    if (code && NUM.test(c[1])) { out.scoring[code] = Number(c[1]); continue; }

    // --- flat settings: "Roster Size  12" ----------------------------------------------------------
    if (!code && c.length === 2) out.misc[label] = c[1];
  }

  // Order the ladder and close it at the bottom. A tier ESPN omitted scores zero, so the span below
  // the lowest listed edge becomes an explicit [edge-1, 0] rather than an implicit hole -- `find`
  // takes the first match, and a hole would let a shutout fall through to the next tier's penalty.
  paTiers.sort((a, b) => (a.upTo == null ? Infinity : a.upTo) - (b.upTo == null ? Infinity : b.upTo));
  if (paTiers.length) {
    const lowest = paTiers[0].upTo;
    if (lowest != null && lowest > 0) {
      // TWO capture groups: the tier's start AND its end. Matching on the END identifies the lowest
      // listed tier; the zero tier then runs up to its START minus one. Written with one group the
      // first time, so `m[2]` was undefined, the lookup never matched, and it silently fell back to
      // `lowest - 1` -- giving [12, 0] instead of [6, 0]. A fallback that produces a plausible
      // number is the worst kind: only the fixture test told them apart.
      const lowestRow = rows
        .map((r) => r.match(/(\d+)\s*[-–]\s*(\d+)\s*points?\s+allowed/i))
        .find((m) => m && Number(m[2]) === lowest);
      const zeroUpTo = lowestRow ? Number(lowestRow[1]) - 1 : lowest - 1;
      if (zeroUpTo >= 0) out.paLadder.push([zeroUpTo, 0]);
    }
    for (const t of paTiers) out.paLadder.push([t.upTo, t.pts]);
  }
  return out;
}

/** The JS evaluated inside the ESPN webview. Returns one string per settings row, in order. */
export const SETTINGS_ROWS_JS =
  `(() => Array.from(document.querySelectorAll('tr')).map((tr) => tr.innerText || '').filter(Boolean))()`;
