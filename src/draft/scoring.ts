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
  /** per 2-point conversion, passing/rushing/receiving alike (2). ESPN ids 19/26/44.
   *  Omitting this was worth a flat -2.0 on any player-week containing one, and it was invisible
   *  until our totals were compared against ESPN's own applied points. */
  twoPt: number;
}

// Default = seacaptaindate.com half-PPR (also a sane generic default until league_sync runs).
export const DEFAULT_SCORING: ScoringRules = { passYd: 1 / 25, passTD: 4, int: -2, rushYd: 0.1, rushTD: 6, recYd: 0.1, recTD: 6, rec: 0.5, fumble: -2, twoPt: 2 };

// ESPN scoringItems statId -> our ScoringRules key (for league_sync to build the rules from a league).
export const ESPN_STAT_TO_RULE: Record<number, keyof ScoringRules> = {
  3: "passYd", 4: "passTD", 20: "int", 24: "rushYd", 25: "rushTD", 42: "recYd", 43: "recTD", 53: "rec", 72: "fumble",
  19: "twoPt", 26: "twoPt", 44: "twoPt",
};

/**
 * The COMPLETE league scoring model: offence, kicking and defence together.
 *
 * These were split before, and only the offensive third was league-driven. `history.ts` called
 * scoreKickerWeek/scoreDefenseWeek with NO rules argument, so they silently used constants baked to
 * this one league -- meaning a different league (or this one changing its DST rules) would adapt its
 * QB/RB/WR/TE scoring and keep scoring K and DST by the old league's book, with nothing failing.
 * Bundling them makes the whole model one object that is either synced or not.
 */
export interface LeagueScoring {
  rules: ScoringRules;
  kicker: KickerRules;
  defense: DefenseRules;
}
export const DEFAULT_LEAGUE_SCORING = (): LeagueScoring => ({
  rules: { ...DEFAULT_SCORING },
  kicker: { ...DEFAULT_KICKER },
  defense: { ...DEFAULT_DEFENSE, paLadder: DEFAULT_DEFENSE.paLadder.map((p) => [...p] as [number, number]) },
});

/** ESPN kicking statId -> KickerRules key. Confirmed against ESPN's own appliedStats. */
export const ESPN_STAT_TO_KICKER: Record<number, keyof KickerRules> = {
  80: "fg0_39", 77: "fg40_49", 198: "fg50_59", 201: "fg60", 86: "pat", 88: "patMiss", 82: "fgMiss",
};
/** ESPN defense statId -> DefenseRules key. Values live under the "16" position override. */
export const ESPN_STAT_TO_DEFENSE: Record<number, keyof Omit<DefenseRules, "paLadder">> = {
  99: "sack", 95: "interception", 96: "fumbleRec", 106: "forcedFumble",
  97: "blockedKick", 98: "safety", 113: "passDefended", 112: "tacklesForLoss",
  101: "td", 102: "td", 103: "td", 104: "td",
};

/**
 * Build the full scoring model from an ESPN scoringItems array.
 *
 * Only the PA ladder cannot be read this way: ESPN spreads points-allowed across ids whose tier
 * BOUNDARIES are absent from the settings payload, so the ladder stays at its derived default (see
 * DEFAULT_DEFENSE) and is the one part of the model that is not league-synced. Everything else is.
 */
export function scoringFromEspn(items: { statId: number; points?: number; pointsOverrides?: Record<string, number> }[]): LeagueScoring {
  const out = DEFAULT_LEAGUE_SCORING();
  for (const it of items ?? []) {
    const val = () => Number(it.points || it.pointsOverrides?.["16"] || it.pointsOverrides?.["14"] || 0);
    const rk = ESPN_STAT_TO_RULE[it.statId];
    if (rk) { out.rules[rk] = val(); continue; }
    const kk = ESPN_STAT_TO_KICKER[it.statId];
    if (kk) { out.kicker[kk] = val(); continue; }
    const dk = ESPN_STAT_TO_DEFENSE[it.statId];
    if (dk) out.defense[dk] = val();
  }
  return out;
}

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
 * TEAM DEFENSE scoring -- every value below is GROUND-TRUTHED against ESPN's own `appliedStats`,
 * which publishes the points it actually credited per stat id per week. Nothing here is inferred.
 *
 * An earlier version of this block was inferred, and it was wrong in ways that a plausible-looking
 * season total completely hid:
 *   - the PA ladder had 0-6 points allowed worth +8/+5 and 13 worth +3. The real ladder credits
 *     ZERO down to 6 and -1 by 7. That is a uniform ~4-5 point per game overstatement.
 *   - id 97 was read as SAFETY (3). It is BLOCKED KICK. The real safety is id 98, worth 4.
 *   - ids 106 (forced fumble, 1), 112 (0.5/unit) and 113 (pass defended, 0.25) were missing
 *     entirely, and 112+113 appear in EVERY DST week.
 *   - fumble recoveries were read from `def_fumbles`; the column that matches ESPN 57/57 is
 *     `fumble_recovery_opp`.
 *
 * Face validity on ORDERING passed the whole time -- 2024 came out DEN, MIN, ... CAR last, which is
 * correct -- because a uniform level error shifts every team equally. Ranking checks cannot catch a
 * level bug; only comparing against the other side's own numbers can.
 *
 * Column identifications, by matching ESPN's raw per-week values against nflverse over 57-175
 * team-weeks: 95 -> def_interceptions, 96 -> fumble_recovery_opp, 97 -> the SUM of def_punt_blocks
 * + def_pat_blocks + def_fg_blocks (57/57 exact), 98 -> def_safeties, 99 -> def_sacks,
 * 106 -> def_fumbles_forced (55/57), 113 -> def_pass_defended.
 *
 * ONE APPROXIMATION REMAINS, and it is deliberate. Id 112 (0.5/unit) is a tackle-for-loss-shaped
 * stat that matches NO nflverse column exactly -- ESPN and nflverse count TFL differently, so
 * `def_tackles_for_loss` agrees only 19% of the time. It is used as the best available proxy.
 *
 * Also approximate: ESPN's points-allowed EXCLUDES points the opponent scored on defense or special
 * teams, while we read the final score. That is visible in the derivation as tier disagreements at
 * boundaries (PA 19 crediting -3 or -1) and costs at most one tier in games with a pick-six.
 */
export interface DefenseRules {
  sack: number; interception: number; fumbleRec: number; forcedFumble: number;
  blockedKick: number; safety: number; passDefended: number; tacklesForLoss: number; td: number;
  /** [maxPointsAllowed, points] ascending; first match wins. Derived from 175 scored DST weeks. */
  paLadder: [number, number][];
}
export const DEFAULT_DEFENSE: DefenseRules = {
  sack: 1, interception: 2, fumbleRec: 1, forcedFumble: 1,
  blockedKick: 3, safety: 4, passDefended: 0.25, tacklesForLoss: 0.5, td: 8,
  paLadder: [[6, 0], [13, -1], [17, -2], [21, -3], [27, -4], [34, -5], [45, -6], [Infinity, -7]],
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
  const blocks = nz(r, "def_punt_blocks") + nz(r, "def_pat_blocks") + nz(r, "def_fg_blocks");
  const base = nz(r, "def_sacks") * d.sack
    + nz(r, "def_interceptions") * d.interception
    + nz(r, "fumble_recovery_opp") * d.fumbleRec
    + nz(r, "def_fumbles_forced") * d.forcedFumble
    + blocks * d.blockedKick
    + nz(r, "def_safeties") * d.safety
    + nz(r, "def_pass_defended") * d.passDefended
    + nz(r, "def_tackles_for_loss") * d.tacklesForLoss
    + tds * d.td;
  const pa = d.paLadder.find(([max]) => pointsAllowed <= max)?.[1] ?? 0;
  return base + pa;
}

/** One nflverse stats_player_week row -> fantasy points under `s`. Linear, so per-week sums == season. */
export function scoreWeek(r: Record<string, string>, s: ScoringRules): number {
  return nz(r, "passing_yards") * s.passYd + nz(r, "passing_tds") * s.passTD + nz(r, "passing_interceptions") * s.int
    + nz(r, "rushing_yards") * s.rushYd + nz(r, "rushing_tds") * s.rushTD
    + nz(r, "receiving_yards") * s.recYd + nz(r, "receiving_tds") * s.recTD + nz(r, "receptions") * s.rec
    + (nz(r, "rushing_fumbles_lost") + nz(r, "receiving_fumbles_lost") + nz(r, "sack_fumbles_lost")) * s.fumble
    + (nz(r, "passing_2pt_conversions") + nz(r, "rushing_2pt_conversions") + nz(r, "receiving_2pt_conversions")) * (s.twoPt ?? 2);
}
