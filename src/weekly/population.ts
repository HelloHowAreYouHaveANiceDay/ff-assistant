/**
 * THE DECISION POPULATION: the player-weeks a lineup or waiver decision in THIS league can involve.
 *
 * WHY THIS FILE EXISTS. The two-part weekly model failed clause (c) of its pre-registered gate at
 * RB (0.031), WR (0.039) and TE (0.074) against a tolerance of 0.030, and integration pass 3 found
 * the cause: the trainer fitted rows with `season_line_pg >= 3` while the harness scored EVERY
 * non-bye rostered row, including the deep bench where a zero is near-certain. The two zero rates
 * differ by 0.11 (QB), 0.11 (RB), 0.16 (WR) and 0.21 (TE) -- three to seven times the tolerance --
 * so no model fitted on the first could be calibrated for the second, and no intercept shift could
 * carry the difference (`scripts/zero-share-population.mjs` shows why: an MLE logistic with an
 * intercept is already mean-calibrated on its OWN training set, and the shifts came out at 0.0005).
 *
 * The fix is not a better filter on either side. It is ONE population, written once, called by both.
 * That is what this module is: the rule, and the flag column that carries it into SQL so the Python
 * trainer reads the SAME predicate the TypeScript harness scores rather than a Python restatement
 * of it. A rule stated twice is a rule that drifts, and the drift is exactly what sank the gate.
 *
 * THE RULE, and it is defined by the DECISION rather than by a modelling convenience:
 *
 *   A player-week is in the population if a manager in this league could have had to decide about
 *   him that week. That is true in exactly two cases:
 *
 *     (1) HE WAS ROSTERED. Somebody owned him, so somebody had to choose whether to start him.
 *         Read from Track B's `fact_roster_week` where it exists (2018-2025 in this store).
 *     (2) HE WAS A PLAUSIBLE PICKUP -- among the top `POPULATION_DEPTH[pos]` at his position by
 *         PRESEASON season line. Nobody claims a waiver on the 200th receiver.
 *
 *   Before 2018 there is no roster feed, so (1) is unavailable and the rank cut of (2) stands in
 *   for the union: the top `POPULATION_DEPTH[pos]` at the position is approximately "rostered or
 *   worth picking up", which is what the union IS. The approximation is stated rather than hidden,
 *   and `populationSource()` names which of the two produced any given season.
 *
 * A BYE WEEK IS NOT IN THE POPULATION. There is no decision to make: every model knows about a bye
 * equally, from the schedule, so scoring one hands every model the same free lunch. Both sides
 * already excluded byes; the flag folds that in so that "in_population = 1" is the WHOLE predicate
 * and neither side can restate half of it. Same for a NULL season line: the target is a ratio to
 * the line, so a row without one is not scoreable by any of these models.
 *
 * WHY THE DEPTHS ARE WHAT THEY ARE. `ROSTER_DEPTH` is MEASURED from `fact_roster_week` -- the mean
 * number of men carried at each position across a league-week, scaled from the 14-team seasons the
 * feed covers to the 16 teams the league runs now -- and `test/weekly-population.test.ts` re-measures
 * it against the table rather than trusting the constant, because a hand-typed depth is a snapshot
 * of the day it was typed. The measured per-week counts over 2018-2025 are QB 22.9, RB 48.4,
 * WR 56.1, TE 22.2, K 15.3, DST 18.4 over a mean 14.25 teams -- 183.2 men a league-week, i.e.
 * 12.86 A TEAM. Times 16/14.25 and rounded up per position they are the numbers below, and they
 * sum to 208.
 *
 * 12.86 IS MORE THAN THE 12 NOMINAL SLOTS, and the excess is not an error to round away: the feed
 * counts men parked in the injured-reserve slot. They are rostered, they occupy a real decision
 * ("do I drop him?"), and they are exactly the availability cases the two-part model's first stage
 * is about. So the MEASURED number is used and stated, not the nominal one.
 *
 * `FA_MARGIN` is the stated margin: one extra man per team at every position. It is the depth past
 * the last rostered man that a waiver claim can plausibly reach.
 */
import { createHash } from "node:crypto";
import type { Database as DB } from "better-sqlite3";

/** The league this population is about; it appears in the depth derivation above. */
export const LEAGUE_TEAMS = 16;

/**
 * MEN CARRIED AT EACH POSITION ACROSS A 16-TEAM LEAGUE-WEEK. Measured from `fact_roster_week`;
 * see the header for the arithmetic and `test/weekly-population.test.ts` for the re-measurement.
 */
export const ROSTER_DEPTH: Record<string, number> = { QB: 26, RB: 55, WR: 63, TE: 25, K: 18, DST: 21 };

/** The stated margin: one extra man per team, i.e. how far past the last rostered man a waiver
 *  claim can plausibly reach. */
export const FA_MARGIN = LEAGUE_TEAMS;

/** The rank cut, per position: roster depth plus the margin. */
export const POPULATION_DEPTH: Record<string, number> = Object.fromEntries(
  Object.entries(ROSTER_DEPTH).map(([pos, d]) => [pos, d + FA_MARGIN]),
);

/** The positions a weekly decision can be about. */
export const POPULATION_POS = ["QB", "RB", "WR", "TE", "K", "DST"];

/**
 * THE FLAG COLUMN, and the ONE predicate both sides use.
 *
 * `tools/train_weekly.py` and `tools/train_streaming.py` append this to their WHERE clause;
 * `src/weekly/evaluate.ts` and `src/weekly/streamingEvaluate.ts` filter their scored rows by the
 * same column. Neither side restates the rule -- they read the flag this module wrote.
 */
export const POPULATION_COLUMN = "in_population";
export const POPULATION_PREDICATE = `${POPULATION_COLUMN} = 1`;

/**
 * ADD THE FLAG COLUMN TO AN EXISTING STORE.
 *
 * Same shape and same reason as `ensureContextColumns`: schema.sql is CREATE TABLE IF NOT EXISTS
 * throughout, so a column added to the CREATE reaches a fresh store and never an existing one.
 * Idempotent by inspection rather than by swallowing an exception -- a duplicate-column error and a
 * malformed ALTER arrive as the same type.
 */
export function ensurePopulationColumn(db: DB): void {
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_model)").all() as { name: string }[])
    .map((c) => c.name));
  if (!have.size) return;                              // table not created yet; schema.sql owns that
  if (!have.has(POPULATION_COLUMN)) {
    db.exec(`ALTER TABLE feat_player_week_model ADD COLUMN ${POPULATION_COLUMN} INTEGER`);
  }
}

/** Which rule produced a season's flags: the roster feed, or the rank approximation that stands in
 *  for it where the feed does not reach. Named on the report so an era boundary is never silent. */
export type PopulationSource = "roster_feed" | "rank_approximation";

export interface PopulationSeason {
  season: number;
  source: PopulationSource;
  /** Non-bye rows with a season line -- what the OLD harness scored. */
  scored: number;
  /** Rows the decision population keeps. */
  inPopulation: number;
  /** `scored - inPopulation`: the deep bench nobody would start or claim. */
  excluded: number;
}

/**
 * SEASON-LEVEL RANK WITHIN POSITION, by preseason season line, 1 = best.
 *
 * POINT-IN-TIME BY CONSTRUCTION: the line is frozen at Y-09-01, so a rank computed from it says
 * nothing about how the season went. Ranking by the OUTCOME would make the population itself a
 * statement of hindsight and would quietly delete every player who busted -- which is most of the
 * zeros the gate is about.
 */
function lineRanks(db: DB, season: number): Map<string, { pos: string; rank: number }> {
  const rows = db.prepare(
    `SELECT feat_key, pos, MAX(season_line_pg) AS line FROM feat_player_week_model
      WHERE season = ? AND season_line_pg IS NOT NULL GROUP BY feat_key, pos`,
  ).all(season) as { feat_key: string; pos: string; line: number }[];
  const byPos = new Map<string, { key: string; line: number }[]>();
  for (const r of rows) (byPos.get(r.pos) ?? byPos.set(r.pos, []).get(r.pos)!).push({ key: r.feat_key, line: r.line });
  const out = new Map<string, { pos: string; rank: number }>();
  for (const [pos, list] of byPos) {
    list.sort((a, b) => b.line - a.line);
    list.forEach((p, i) => out.set(p.key, { pos, rank: i + 1 }));
  }
  return out;
}

/** True where `fact_roster_week` exists AND has rows for this season. An empty table is not a
 *  league in which nobody was rostered; it is a feed that does not reach that season. */
export function hasRosterFeed(db: DB, season: number): boolean {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact_roster_week'").get();
  if (!t) return false;
  const n = db.prepare("SELECT COUNT(*) AS n FROM fact_roster_week WHERE season = ?").get(season) as { n: number };
  return n.n > 0;
}

/** Which rule a season's flags came from. */
export function populationSource(db: DB, season: number): PopulationSource {
  return hasRosterFeed(db, season) ? "roster_feed" : "rank_approximation";
}

/**
 * MATERIALISE THE FLAG for one or more seasons, and report what it kept.
 *
 * Every row of the season is written -- 1 or 0, never left NULL -- so a store that has been through
 * this function has no row whose membership is unknown, and a NULL is therefore unambiguously "this
 * season was never built" rather than "this row fell through a branch".
 */
export function buildPopulation(db: DB, seasons: number[]): PopulationSeason[] {
  ensurePopulationColumn(db);
  const out: PopulationSeason[] = [];
  const upd = db.prepare(
    `UPDATE feat_player_week_model SET ${POPULATION_COLUMN} = ? WHERE season = ? AND week = ? AND feat_key = ?`,
  );
  for (const season of seasons) {
    const source = populationSource(db, season);
    const rostered = new Set<string>();
    if (source === "roster_feed") {
      for (const r of db.prepare(
        "SELECT week, player_sk FROM fact_roster_week WHERE season = ? AND player_sk IS NOT NULL",
      ).all(season) as { week: number; player_sk: string }[]) rostered.add(`${r.week}|${r.player_sk}`);
    }
    const rank = lineRanks(db, season);
    const rows = db.prepare(
      `SELECT feat_key, player_sk, week, pos, season_line_pg, COALESCE(is_bye, 0) AS is_bye
         FROM feat_player_week_model WHERE season = ?`,
    ).all(season) as {
      feat_key: string; player_sk: string | null; week: number; pos: string;
      season_line_pg: number | null; is_bye: number;
    }[];
    let scored = 0, inPop = 0;
    db.transaction(() => {
      for (const r of rows) {
        const scoreable = !r.is_bye && r.season_line_pg != null && POPULATION_POS.includes(r.pos);
        if (scoreable) scored++;
        const byRoster = r.player_sk != null && rostered.has(`${r.week}|${r.player_sk}`);
        const rk = rank.get(r.feat_key)?.rank ?? Number.POSITIVE_INFINITY;
        const byRank = rk <= (POPULATION_DEPTH[r.pos] ?? 0);
        const flag = scoreable && (byRoster || byRank) ? 1 : 0;
        if (flag) inPop++;
        upd.run(flag, season, r.week, r.feat_key);
      }
    })();
    out.push({ season, source, scored, inPopulation: inPop, excluded: scored - inPop });
  }
  return out;
}

/** Zero rate and row count per position over the population, for one set of seasons. The number
 *  gate clause (c) compares a model against, and the number step 1 asserts is the SAME on both
 *  sides. */
export function populationZeroRates(
  db: DB, seasons: number[], opts: { predicate?: string } = {},
): Record<string, { n: number; zero: number }> {
  const ins = seasons.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT pos, COUNT(*) AS n, SUM(CASE WHEN COALESCE(pts, 0.0) <= 0 THEN 1 ELSE 0 END) AS z
       FROM feat_player_week_model
      WHERE season IN (${ins}) AND ${opts.predicate ?? POPULATION_PREDICATE}
      GROUP BY pos`,
  ).all(...seasons) as { pos: string; n: number; z: number }[];
  return Object.fromEntries(rows.map((r) => [r.pos, { n: r.n, zero: r.n ? r.z / r.n : NaN }]));
}

/**
 * THE POPULATION FLAGS FOR ONE SEASON, keyed `feat_key|week` -- what the harness filters its scored
 * rows by.
 *
 * Returns null where the column does not exist or the season was never built, so a caller can say
 * "this store has no population" rather than silently scoring nothing. An empty Set and an unbuilt
 * season are NOT the same fact and must not arrive as the same value.
 */
export function populationKeys(db: DB, season: number): Set<string> | null {
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_model)").all() as { name: string }[])
    .map((c) => c.name));
  if (!have.has(POPULATION_COLUMN)) return null;
  const built = db.prepare(
    `SELECT COUNT(*) AS n FROM feat_player_week_model WHERE season = ? AND ${POPULATION_COLUMN} IS NOT NULL`,
  ).get(season) as { n: number };
  if (!built.n) return null;
  const rows = db.prepare(
    `SELECT feat_key, week FROM feat_player_week_model WHERE season = ? AND ${POPULATION_PREDICATE}`,
  ).all(season) as { feat_key: string; week: number }[];
  return new Set(rows.map((r) => `${r.feat_key}|${r.week}`));
}

/**
 * A SIGNATURE FOR THE POPULATION CURRENTLY IN THE STORE.
 *
 * WHAT IT IS FOR. An artifact is fitted on one set of rows and scored against another, and the whole
 * of Track F is the story of what happens when those two sets differ: the trainer cut at
 * `season_line_pg >= 3`, the harness kept every non-bye row, and the resulting 0.11-0.21 gap in zero
 * rate failed the gate at three positions for a reason that had nothing to do with the model. The
 * column fixed that for one build. It does NOT fix the case where the population is REBUILT -- a
 * different `ROSTER_DEPTH`, another season of roster feed, a re-run of `buildPopulation` -- and an
 * artifact fitted on the old one is still sitting on disk saying `rowFilter: "in_population"`.
 *
 * WHAT IT IS NOT. It is a cheap identity, not a cryptographic one: the count of flagged rows per
 * season plus the depth cuts the rule was built with. Two genuinely different populations could
 * collide on a count; the point is to catch a REBUILD, which moves counts, not to resist an
 * adversary. `depth` is included because a depth change that happened to leave the total unchanged
 * is exactly the silent case a count alone would miss.
 */
export interface PopulationSignature {
  hash: string;
  rows: number;
  perSeason: { season: number; rows: number }[];
  depth: Record<string, number>;
}

export function populationSignature(db: DB): PopulationSignature | null {
  const have = new Set((db.prepare("PRAGMA table_info(feat_player_week_model)").all() as { name: string }[])
    .map((c) => c.name));
  if (!have.has(POPULATION_COLUMN)) return null;
  const perSeason = db.prepare(
    `SELECT season, COUNT(*) AS n FROM feat_player_week_model
      WHERE ${POPULATION_PREDICATE} GROUP BY season ORDER BY season`,
  ).all() as { season: number; n: number }[];
  if (!perSeason.length) return null;
  const rows = perSeason.reduce((a, r) => a + r.n, 0);
  const body = JSON.stringify({
    depth: POPULATION_DEPTH,
    seasons: perSeason.map((r) => [r.season, r.n]),
  });
  return {
    hash: createHash("sha256").update(body).digest("hex").slice(0, 16),
    rows,
    perSeason: perSeason.map((r) => ({ season: r.season, rows: r.n })),
    depth: { ...POPULATION_DEPTH },
  };
}
