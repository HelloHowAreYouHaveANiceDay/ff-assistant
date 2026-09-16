import type { DB } from "../db/db.js";

// One home for two week-boundary lookups the in-season code leans on. The regWeeks fallback chain
// below was a byte-identical multi-line block in three backtest files (harness, streaming, trades);
// duplicated flow like that is where "fix two of three" drift starts.

/** The last week of `season` with any settled points, or null if none has been played yet. */
export function latestScoredWeek(db: DB, season: number): number | null {
  return (db.prepare("SELECT MAX(week) w FROM feat_player_week_model WHERE season = ? AND pts IS NOT NULL")
    .get(season) as { w: number | null }).w;
}

/**
 * Regular-season week count for `season` IN ONE LEAGUE: that league's own reg_weeks, else the last
 * scored week, else 14. The exact fallback chain the backtest harness/streaming/trades each rebuilt
 * inline.
 *
 * `MAX(reg_weeks)` USED TO SPAN EVERY LEAGUE IN THE STORE (I-7). With a 13-week ESPN league and a
 * 14-week Yahoo one that returns 14 for BOTH, and the number is a divisor and a loop bound -- so the
 * shorter league silently scores a week it never plays.
 */
export function regWeeksFor(db: DB, leagueId: string | null, season: number): number {
  const rw = (db.prepare("SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE league_id = ? AND season = ?")
    .get(leagueId, season) as { rw: number | null }).rw;
  return rw ?? latestScoredWeek(db, season) ?? 14;
}
