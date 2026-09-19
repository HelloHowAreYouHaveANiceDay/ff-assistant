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
 * THE LAST FULLY SETTLED WEEK -- the same rule `loadSimContext` applies (D18), not a second spelling.
 *
 * `latestScoredWeek` above answers "what is the highest week with ANY scored row", which is a
 * different and much weaker question: one Thursday night game makes its whole week look finished.
 * Measured on 2026-09-18, league 462233: week 2 had 22 scored rows out of 532 -- the DET/BUF opener
 * and nothing else -- and `latestScoredWeek` returned 2, so the FAAB model advanced to week 3 on the
 * Friday, three days before the week's remaining fifteen games.
 *
 * A week is settled when its last NFL game day is strictly BEFORE today AND the store holds scored
 * rows for it. Both halves matter: the date alone would settle a week whose actuals have not synced,
 * and the rows alone settle a week on its first kickoff. Contiguous from week 1, because a gap in
 * the middle means unsynced data rather than a week that did not happen.
 *
 * Returns null when nothing has settled, which is the honest answer in week 1 and must not be
 * confused with week 0.
 */
export function lastSettledWeek(db: DB, season: number, today?: string): number | null {
  const day = today ?? new Date().toISOString().slice(0, 10);
  let last: number | null = null;
  for (const r of db.prepare(
    "SELECT week, MAX(gameday) last FROM raw_nfl_game WHERE season=? AND game_type='REG' AND gameday IS NOT NULL GROUP BY week ORDER BY week",
  ).all(season) as { week: number; last: string }[]) {
    if (!(r.last < day)) break;
    const scored = (db.prepare(
      "SELECT COUNT(*) c FROM feat_player_week WHERE season=? AND week=? AND pts IS NOT NULL",
    ).get(season, r.week) as { c: number }).c;
    if (!scored) break;
    last = r.week;
  }
  return last;
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
