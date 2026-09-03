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

const nz = (r: Record<string, string>, k: string): number => { const v = Number(r[k]); return Number.isFinite(v) ? v : 0; };

/** One nflverse stats_player_week row -> fantasy points under `s`. Linear, so per-week sums == season. */
export function scoreWeek(r: Record<string, string>, s: ScoringRules): number {
  return nz(r, "passing_yards") * s.passYd + nz(r, "passing_tds") * s.passTD + nz(r, "passing_interceptions") * s.int
    + nz(r, "rushing_yards") * s.rushYd + nz(r, "rushing_tds") * s.rushTD
    + nz(r, "receiving_yards") * s.recYd + nz(r, "receiving_tds") * s.recTD + nz(r, "receptions") * s.rec
    + (nz(r, "rushing_fumbles_lost") + nz(r, "receiving_fumbles_lost") + nz(r, "sack_fumbles_lost")) * s.fumble;
}
