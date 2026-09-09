/**
 * THE PUBLISHED DICTIONARY OF STREAMING COLUMNS, in a module that imports NOTHING.
 *
 * It lives on its own for a mechanical reason rather than an aesthetic one. `src/weekly/features.ts`
 * needs these names to extend `WEEKLY_FEATURE_FIELDS` (the list the artifact loader validates
 * against), and `src/weekly/streamingFeatures.ts` needs `WEEKLY_POS` and `ScheduleInfo` from
 * features.ts to build them. Putting the list in either file makes the two import each other, and a
 * circular ESM import between two modules whose top level evaluates a `const` array is the failure
 * that reads as `Cannot access 'X' before initialization` at a random call site and as nothing at all
 * in a typecheck. One leaf module, imported by both, cannot cycle.
 *
 * Each entry carries its AS-OF RULE beside it. The rules are enforced by `buildStreamInto` and
 * checked by `test/streaming-leakage.test.ts` and `scripts/streaming-leak-audit.mjs`, which recompute
 * them independently -- a comment is a claim, and the guards are what make it a fact.
 */
export const STREAM_FIELDS: { name: string; sql: string; asOf: string }[] = [
  { name: "opp_pa_pos", sql: "REAL",
    asOf: "fantasy points the OPPONENT defence allowed per game to THIS player's position, weeks < w of Y, blended with all of Y-1 and shrunk toward the league mean over the same window" },
  { name: "opp_pa_pos_n", sql: "INTEGER",
    asOf: "team-games of season-Y evidence behind opp_pa_pos; 0 in week 1, and never more than w-1" },
  { name: "opp_def_sacks_pg", sql: "REAL",
    asOf: "sacks the OPPONENT'S DEFENCE made per game, same window and same blend" },
  { name: "opp_def_takeaways_pg", sql: "REAL",
    asOf: "interceptions + opponent fumbles recovered by the OPPONENT'S DEFENCE per game, same window" },
  { name: "opp_pass_yds_allowed_pg", sql: "REAL",
    asOf: "passing yards the OPPONENT'S DEFENCE allowed per game, same window" },
  { name: "opp_rush_yds_allowed_pg", sql: "REAL",
    asOf: "rushing yards the OPPONENT'S DEFENCE allowed per game, same window" },
  { name: "opp_off_sacks_allowed_pg", sql: "REAL",
    asOf: "sacks the OPPONENT'S OFFENCE suffered per game -- what a DST feeds on, same window" },
  { name: "opp_off_giveaways_pg", sql: "REAL",
    asOf: "interceptions thrown + fumbles lost by the OPPONENT'S OFFENCE per game, same window" },
  { name: "opp_implied_total", sql: "REAL",
    asOf: "total_line - implied_team_total for this game, i.e. the market's expected points for the OTHER side. Pre-kickoff, exactly as published; NULL where either line is missing" },
  { name: "roof_dome", sql: "INTEGER",
    asOf: "1 where raw_nfl_game.roof is dome/closed/indoors for this game. Knowable when the schedule is published -- unlike temp and wind on the same table, which are OBSERVED and are therefore NOT built" },
  { name: "team_fga_pg", sql: "REAL",
    asOf: "field goals attempted per game by THIS PLAYER'S OWN team, weeks < w of Y, same blend. The kicker's opportunity, standing in for a red-zone drive rate this store has no feed for" },
  { name: "team_pat_pg", sql: "REAL",
    asOf: "extra points attempted per game by this player's own team, same window and blend" },
];

/** Just the names, for every consumer that needs the list rather than the rules. */
export const STREAM_FIELD_NAMES: string[] = STREAM_FIELDS.map((f) => f.name);

/**
 * Which streaming columns THIS store actually has.
 *
 * Same reasoning as `presentContextFields` one file over: naming a column a table does not have is a
 * hard SQLite error rather than a NULL, so a fixture store or an old copy that has never been built
 * would take down every caller instead of reading "this store does not carry that". It lives in this
 * leaf module, with a TYPE-ONLY import, because `loadWeeklyRows` in features.ts calls it and
 * streamingFeatures.ts imports features.ts -- a value import the other way would close the cycle this
 * file exists to keep open.
 */
export function presentStreamFields(db: { prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } }): string[] {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feat_player_week_stream'").get();
  if (!t) return [];
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_stream)").all() as { name: string }[])
    .map((c) => c.name));
  return STREAM_FIELD_NAMES.filter((n) => have.has(n));
}
