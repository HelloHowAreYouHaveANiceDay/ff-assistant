import type { DB } from "../db/db.js";

// One home for two week-boundary lookups the in-season code leans on. The regWeeks fallback chain
// below was a byte-identical multi-line block in three backtest files (harness, streaming, trades);
// duplicated flow like that is where "fix two of three" drift starts.

/** The last week of `season` with any settled points, or null if none has been played yet. */
export function latestScoredWeek(db: DB, season: number): number | null {
  return (db.prepare("SELECT MAX(week) w FROM feat_player_week_model WHERE season = ? AND pts IS NOT NULL")
    .get(season) as { w: number | null }).w;
}

/** Regular-season week count for `season`: the league's own reg_weeks, else the last scored week,
 *  else 14. The exact fallback chain the backtest harness/streaming/trades each rebuilt inline. */
export function regWeeksFor(db: DB, season: number): number {
  const rw = (db.prepare("SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season = ?")
    .get(season) as { rw: number | null }).rw;
  return rw ?? latestScoredWeek(db, season) ?? 14;
}
