// THE ONE READER for the point-in-time feature table, shared by every script that used to derive
// prior rank, prior usage and the rank curve for itself.
//
// Before this, five scripts each rebuilt prior-year finish rank from history-points.csv and three
// re-downloaded the whole nflverse player-week feed to aggregate usage -- each with its own season
// range, its own floor, and its own name-keyed join. They disagreed, quietly, and a fit script that
// disagrees with the shipped model does not fail: it reports a number.
//
// So: `ff build-features` writes the table, this reads it, and nothing else derives these columns.
import Database from "better-sqlite3";

export const POS = ["QB", "RB", "WR", "TE"];

/**
 * Rows from feat_player_season, already carrying prior rank, prior usage per game, age, the
 * point-in-time curve value and the target.
 *
 * `maxRank` mirrors the screen every one of those scripts applied by hand: beyond rank 60 the
 * curve has no honest value and the rows are mostly players who did not play.
 */
export function loadFeatures({ db = "data/ff.db", from = 2007, to = 2025, pos = POS, maxRank = 60, ranked = true, scored = true } = {}) {
  const d = new Database(db, { readonly: true });
  const where = ["season BETWEEN ? AND ?"];
  const args = [from, to];
  if (scored) where.push("pts IS NOT NULL");
  if (ranked) { where.push("prior_pos_rank IS NOT NULL"); where.push("prior_pos_rank <= ?"); args.push(maxRank); }
  const rows = d.prepare(
    `SELECT feat_key, player_sk, season, as_of, name, pos, team, prior_pos_rank, prior_pts, prior_games,
            age, prior_fd, prior_ts, prior_attempts, prior_rush_yards, prior_air_yards_share, prior_wopr,
            team_changed, draft_year, draft_round, draft_pick, ecr_pos_rank, ecr_sd,
            curve_value_prior, curve_value_ecr, curve_value_orderstat, pts, games
       FROM feat_player_season WHERE ${where.join(" AND ")}`,
  ).all(...args);
  d.close();
  const want = new Set(pos);
  return rows.filter((r) => want.has(r.pos)).map((r) => ({
    ...r,
    // The names the older scripts used, so a migration is a change of SOURCE and not a rewrite of
    // every expression that reads a row.
    y: r.pts,
    rank: r.prior_pos_rank,
    priorPts: r.prior_pts ?? 0,
    use: r.prior_fd == null && r.prior_ts == null ? null : {
      fd: r.prior_fd ?? 0, ts: r.prior_ts ?? 0,
      attempts: r.prior_attempts ?? 0, rushYards: r.prior_rush_yards ?? 0,
    },
  }));
}

/** The seasons actually present, so a caller never assumes a range the table does not hold. */
export const seasonsOf = (rows) => [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
