// The league's SCORING MODEL -- the per-stat point values that convert raw production into fantasy
// points. This is what makes our rankings league-tailored: a half-PPR league values a 90-catch WR
// +45 pts a Standard league ignores. ONE source, used by BOTH the projection curve (projections.ts)
// and the last-year actuals (assemble.ts), so our value and our vsECR/vsADP are internally consistent.
// Populated from ESPN's real scoringItems by league_sync; defaults to this league's half-PPR.

export interface ScoringRules {
  passYd: number;  // points per passing yard   (0.04 = 1/25)
  passTD: number;  // per passing TD             (4)
  int: number;     // per interception thrown    (-2)
  rushYd: number;  // per rushing yard           (0.1)
  rushTD: number;  // per rushing TD             (6)
  recYd: number;   // per receiving yard         (0.1)
  recTD: number;   // per receiving TD           (6)
  rec: number;     // per reception (PPR knob)   (0.5 half-PPR / 1 full / 0 standard)
  fumble: number;  // per fumble lost            (-2)
}

// Default = seacaptaindate.com half-PPR (also a sane generic default until league_sync runs).
export const DEFAULT_SCORING: ScoringRules = { passYd: 1 / 25, passTD: 4, int: -2, rushYd: 0.1, rushTD: 6, recYd: 0.1, recTD: 6, rec: 0.5, fumble: -2 };

// ESPN scoringItems statId -> our ScoringRules key (for league_sync to build the rules from a league).
export const ESPN_STAT_TO_RULE: Record<number, keyof ScoringRules> = {
  3: "passYd", 4: "passTD", 20: "int", 24: "rushYd", 25: "rushTD", 42: "recYd", 43: "recTD", 53: "rec", 72: "fumble",
};

/**
 * KICKER scoring. Distance-tiered, which is why a flat "points per FG" cannot express it.
 *
 * Read from this league's real ESPN scoringItems (2026-09-07). The stat ids are ESPN's documented
 * kicking block -- 80 = FG made 0-39, 77 = FG made 40-49, 82 = FG missed, 86 = PAT made,
 * 88 = PAT missed -- plus the newer long-range ids 198 (50-59) and 201 (60+), both 5 in this league.
 */
export interface KickerRules { fg0_39: number; fg40_49: number; fg50_59: number; fg60: number; pat: number; patMiss: number; fgMiss: number }
export const DEFAULT_KICKER: KickerRules = { fg0_39: 3, fg40_49: 4, fg50_59: 5, fg60: 5, pat: 1, patMiss: -1, fgMiss: -1 };

/**
 * TEAM DEFENSE scoring.
 *
 * The event values are read straight from the league (sack 1, INT 2, fumble recovery 1, safety 3,
 * defensive/return TD 8 -- ESPN ids 99/95/96/97 and 101-104, all under the "16" position override).
 *
 * The POINTS-ALLOWED ladder is INFERRED, and that is worth stating plainly rather than burying.
 * ESPN spreads it across ids 91/92/93 and 121-125 whose tier boundaries it does not publish in the
 * settings payload; the values we can read are +8 at the top and -1,-2,-3,-4,-5,-6,-7 descending.
 * The ladder below uses the standard ESPN boundaries that those values fit. If a DST season total
 * looks wrong, this is the first thing to check -- and `scripts/dst-face-validity.mjs` exists to
 * make that checkable rather than a matter of opinion.
 */
export interface DefenseRules {
  sack: number; interception: number; fumbleRec: number; safety: number; td: number;
  /** [maxPointsAllowed, points] ascending; first match wins. */
  paLadder: [number, number][];
}
export const DEFAULT_DEFENSE: DefenseRules = {
  sack: 1, interception: 2, fumbleRec: 1, safety: 3, td: 8,
  paLadder: [[0, 8], [6, 5], [13, 3], [17, 1], [21, 0], [27, -1], [34, -2], [45, -3], [Infinity, -7]],
};

const nz = (r: Record<string, string>, k: string): number => { const v = Number(r[k]); return Number.isFinite(v) ? v : 0; };

/** One nflverse stats_player_week row for a KICKER -> fantasy points. */
export function scoreKickerWeek(r: Record<string, string>, k: KickerRules = DEFAULT_KICKER): number {
  return nz(r, "fg_made_0_19") * k.fg0_39 + nz(r, "fg_made_20_29") * k.fg0_39 + nz(r, "fg_made_30_39") * k.fg0_39
    + nz(r, "fg_made_40_49") * k.fg40_49 + nz(r, "fg_made_50_59") * k.fg50_59 + nz(r, "fg_made_60_") * k.fg60
    + nz(r, "fg_missed") * k.fgMiss + nz(r, "pat_made") * k.pat + nz(r, "pat_missed") * k.patMiss;
}

/** One nflverse stats_team_week row + the points that team ALLOWED -> DST fantasy points. */
export function scoreDefenseWeek(r: Record<string, string>, pointsAllowed: number, d: DefenseRules = DEFAULT_DEFENSE): number {
  const tds = nz(r, "def_tds") + nz(r, "special_teams_tds");
  const base = nz(r, "def_sacks") * d.sack
    + nz(r, "def_interceptions") * d.interception
    + nz(r, "def_fumbles") * d.fumbleRec        // recoveries; verified against the feed's column list
    + nz(r, "def_safeties") * d.safety
    + tds * d.td;
  const pa = d.paLadder.find(([max]) => pointsAllowed <= max)?.[1] ?? 0;
  return base + pa;
}

/** One nflverse stats_player_week row -> fantasy points under `s`. Linear, so per-week sums == season. */
export function scoreWeek(r: Record<string, string>, s: ScoringRules): number {
  return nz(r, "passing_yards") * s.passYd + nz(r, "passing_tds") * s.passTD + nz(r, "passing_interceptions") * s.int
    + nz(r, "rushing_yards") * s.rushYd + nz(r, "rushing_tds") * s.rushTD
    + nz(r, "receiving_yards") * s.recYd + nz(r, "receiving_tds") * s.recTD + nz(r, "receptions") * s.rec
    + (nz(r, "rushing_fumbles_lost") + nz(r, "receiving_fumbles_lost") + nz(r, "sack_fumbles_lost")) * s.fumble;
}
