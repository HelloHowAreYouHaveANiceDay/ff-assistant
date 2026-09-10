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
  idp: IdpRules;
}
export const DEFAULT_LEAGUE_SCORING = (): LeagueScoring => ({
  rules: { ...DEFAULT_SCORING },
  kicker: { ...DEFAULT_KICKER },
  defense: { ...DEFAULT_DEFENSE, paLadder: DEFAULT_DEFENSE.paLadder.map((p) => [...p] as [number, number]) },
  idp: { ...DEFAULT_IDP },
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
 * BOTH REMAINING APPROXIMATIONS WERE CHASED DOWN ON 2026-09-07, and one of them was recorded WRONG.
 *
 * Points allowed: this comment used to say ESPN "excludes points the opponent scored on defense or
 * special teams". Half right, and the wrong half was harmful -- excluding special teams made
 * accuracy WORSE. Measured against ESPN's credited tier over 203 scored DST weeks, the definition is
 * the final score minus SIX points per opponent DEFENSIVE touchdown, special teams included in the
 * total and the PAT after a pick-six still counting: 97.0% vs 93.6% for the plain final score. See
 * espnPointsAllowed().
 *
 * Stat 112: still a proxy, but now a CALIBRATED one. It is tackle-for-loss-shaped and matches no
 * nflverse column exactly, because ESPN counts from play-by-play we cannot see. Over 203 team-weeks
 * it correlates 0.456 with `def_tackles_for_loss` and runs ~15% lower in the mean (4.50 vs 5.30), so
 * `tflProviderScale` corrects the LEVEL. The per-game noise is irreducible from our side; the
 * seasonal total, which is what the projection curve consumes, is now unbiased.
 */
export interface DefenseRules {
  sack: number; interception: number; fumbleRec: number; forcedFumble: number;
  blockedKick: number; safety: number; passDefended: number; tacklesForLoss: number; td: number;
  /**
   * ESPN counts stat 112 (a tackles-for-loss-shaped stat) about 15% LOWER than nflverse's
   * `def_tackles_for_loss`: means 4.50 vs 5.30 over 203 scored team-weeks, correlation 0.456. Same
   * concept, different provider counting. Scaling by the measured ratio fixes the LEVEL, which is
   * what matters when the number is summed over a season -- without it a season's TFL contribution
   * is ~15% too high. The per-game correlation cannot be fixed from our side; ESPN does not publish
   * the underlying play-by-play it counts from.
   */
  tflProviderScale: number;
  /**
   * [maxPointsAllowed, points] ascending; first match wins. Derived from 175 scored DST weeks.
   *
   * THE LAST TIER'S BOUND MAY BE `null`, AND MUST BE READ AS "no upper bound". The in-code default
   * writes `Infinity`, which is the honest value -- but this object is stored in `settings.config`
   * as JSON, and `JSON.stringify(Infinity)` is `null`. So a ladder that has been round-tripped
   * through the store ends `[null, -7]` while the one built in memory ends `[Infinity, -7]`, and
   * `pointsAllowed <= null` is FALSE for every real score: the worst tier silently stops applying
   * and a defence that shipped 46 points scores 0 instead of -7.
   *
   * Nothing failed when that happened. The ladder still had eight tiers, the seven that fire most
   * often were untouched, and only the tail -- the blowouts -- went quietly missing.
   */
  paLadder: [number | null, number][];
}

/**
 * The points-allowed figure ESPN actually scores a DST on: the final score MINUS the opponent's
 * DEFENSIVE touchdowns, at 6 points each.
 *
 * Every part of that was measured against ESPN's own credited tier over 203 scored DST weeks, and
 * every part contradicted a plausible guess:
 *
 *   final score                       93.6%   <- what we shipped, and what the code comment claimed
 *   minus 6 x opponent DEF tds        97.0%   <- this
 *   minus 7 x opponent DEF tds        95.1%   so the PAT after a pick-six still counts against you
 *   minus 6 x opponent ST tds         88.7%   special-teams returns are NOT excluded
 *   minus 6 x (def + ST)              91.1%   which is why excluding both made it WORSE
 *
 * The earlier code comment asserted ESPN "excludes points the opponent scored on defense or special
 * teams". Half right, and the wrong half was actively harmful: adjusting for special teams cost
 * accuracy. Defensive TDs only, at 6.
 */
export function espnPointsAllowed(finalScore: number, opponentRow: Record<string, string> | null | undefined): number {
  const oppDefTds = Number(opponentRow?.def_tds ?? 0) || 0;
  return Math.max(0, finalScore - 6 * oppDefTds);
}
export const DEFAULT_DEFENSE: DefenseRules = {
  sack: 1, interception: 2, fumbleRec: 1, forcedFumble: 1,
  blockedKick: 3, safety: 4, passDefended: 0.25, tacklesForLoss: 0.5, td: 8,
  tflProviderScale: 0.85,   // measured: ESPN 4.50 vs nflverse 5.30 per team-week
  paLadder: [[6, 0], [13, -1], [17, -2], [21, -3], [27, -4], [34, -5], [45, -6], [Infinity, -7]],
};

const nz = (r: Record<string, string>, k: string): number => { const v = Number(r[k]); return Number.isFinite(v) ? v : 0; };

/**
 * INDIVIDUAL DEFENSIVE PLAYER scoring -- a BENCHMARK surface, not a league requirement.
 *
 * Our league does not use IDP, so there is nothing to sync and these defaults cannot be validated
 * against an ESPN applied-points feed the way the offensive rules were. That is exactly why it is
 * worth building: IDP is a completely different stat vocabulary (tackles, passes defended, TFL)
 * driven by columns the rest of the pipeline never touches, so if the projection curve, the value
 * book and the simulator all handle it without special-casing, the generality is real rather than
 * asserted. If they do not, the special cases surface here instead of on the day someone changes
 * league format.
 *
 * The values below are a widely-used baseline IDP ruleset (solo 1 / assist 0.5 / sack 2 / INT 6 /
 * forced fumble 3 / recovery 3 / TD 6 / pass defended 1 / safety 2 / TFL 1). They are DEFAULTS, not
 * measurements -- unlike DEFAULT_DEFENSE, no line of this was ground-truthed, and it should not be
 * quoted as though it were.
 */
export interface IdpRules {
  soloTackle: number; assistTackle: number; sack: number; interception: number;
  forcedFumble: number; fumbleRec: number; td: number; passDefended: number;
  safety: number; tacklesForLoss: number;
}
export const DEFAULT_IDP: IdpRules = {
  soloTackle: 1, assistTackle: 0.5, sack: 2, interception: 6,
  forcedFumble: 3, fumbleRec: 3, td: 6, passDefended: 1, safety: 2, tacklesForLoss: 1,
};

/** nflverse position -> the IDP fantasy group it is rostered as. Returns null for non-IDP. */
export function idpGroup(pos: string): "DL" | "LB" | "DB" | null {
  const p = pos.toUpperCase();
  if (["DE", "DT", "NT", "DL"].includes(p)) return "DL";
  if (["LB", "OLB", "ILB", "MLB"].includes(p)) return "LB";
  if (["CB", "SAF", "S", "DB", "FS", "SS"].includes(p)) return "DB";
  return null;
}

/** One nflverse stats_player_week row for a defender -> IDP fantasy points. */
export function scoreIdpWeek(r: Record<string, string>, d: IdpRules = DEFAULT_IDP): number {
  return nz(r, "def_tackles_solo") * d.soloTackle
    + nz(r, "def_tackle_assists") * d.assistTackle
    + nz(r, "def_sacks") * d.sack
    + nz(r, "def_interceptions") * d.interception
    + nz(r, "def_fumbles_forced") * d.forcedFumble
    + nz(r, "fumble_recovery_opp") * d.fumbleRec
    + nz(r, "def_tds") * d.td
    + nz(r, "def_pass_defended") * d.passDefended
    + nz(r, "def_safeties") * d.safety
    + nz(r, "def_tackles_for_loss") * d.tacklesForLoss;
}


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
    + nz(r, "def_tackles_for_loss") * (d.tflProviderScale ?? 1) * d.tacklesForLoss
    + tds * d.td;
  // `max == null` is the open-ended top tier -- see DefenseRules.paLadder. Written as an explicit
  // null check rather than `<= (max ?? Infinity)` so the intent survives the next reader.
  const pa = d.paLadder.find(([max]) => max == null || pointsAllowed <= max)?.[1] ?? 0;
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
