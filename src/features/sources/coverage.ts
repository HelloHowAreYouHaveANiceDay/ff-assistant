/**
 * COVERAGE AS DATA, written by the same run that builds the table.
 *
 * The failure this exists for: a column that silently drops to zero non-nulls for a season it should
 * cover. Nothing about a NULL is an error -- a build stays green, a fit gets a slightly different
 * training set, and the coefficient it produces is wrong for a reason no test names. Writing the
 * count per column per season makes it a row a test can assert on, and makes "the feed stopped
 * publishing this in 2025" a visible fact rather than a discovery two months later.
 *
 * It is deliberately generic (PRAGMA table_info + one COUNT per column) rather than a hand-written
 * list of columns: a hand-written list is coverage by ENUMERATION, and it rots the moment a column
 * is added, in exactly the way that makes the new column the one nobody is watching.
 */
import { nowIso, type DB } from "../../db/db.js";

const SKIP = new Set(["player_sk", "season", "week", "updated_at"]);

export function writeCoverage(db: DB, table: string, seasons: number[]): number {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name).filter((c) => !SKIP.has(c));
  const ins = db.prepare(
    `INSERT INTO feat_coverage (table_name, column_name, season, rows, non_null, updated_at)
     VALUES (@t,@c,@s,@rows,@nn,@now)
     ON CONFLICT(table_name, column_name, season) DO UPDATE SET
       rows=excluded.rows, non_null=excluded.non_null, updated_at=excluded.updated_at`,
  );
  const now = nowIso();
  let n = 0;
  db.transaction(() => {
    for (const s of seasons) {
      for (const c of cols) {
        const r = db.prepare(
          `SELECT COUNT(*) rows, SUM("${c}" IS NOT NULL) nn FROM ${table} WHERE season = ?`,
        ).get(s) as { rows: number; nn: number | null };
        ins.run({ t: table, c, s, rows: r.rows, nn: r.nn ?? 0, now });
        n++;
      }
    }
  })();
  return n;
}

/**
 * TRACK I: the two injury tables, plus the two facts a per-column non-null count CANNOT express.
 *
 * `writeCoverage` answers "is this column populated". For an injury horizon the two questions that
 * actually decide whether a fit means anything are different in kind:
 *
 *   __uncensored_episodes   episodes whose weeks_missed was OBSERVED to end. A censored episode --
 *                           the man never came back inside the season -- has a weeks_missed that is
 *                           a LOWER BOUND, and a season where most episodes are censored cannot
 *                           support a duration claim however full its columns are.
 *   __horizon_k4_observed   horizon rows with four scheduled games left, i.e. rows where miss_next_4
 *                           is a real 0/1 rather than NULL. It falls to zero at the end of every
 *                           season by construction, and a fit that quietly trains on far fewer rows
 *                           at k=4 than at k=1 should be visible as a row rather than discovered.
 *
 * They are written as SYNTHETIC COLUMN NAMES in the same table so one query answers "what did this
 * season actually support", and the leading double underscore says they are not columns.
 */
export function writeInjuryCoverage(db: DB, seasons: number[]): number {
  let n = writeCoverage(db, "fact_injury_episode", seasons) + writeCoverage(db, "feat_injury_horizon", seasons);
  const ins = db.prepare(
    `INSERT INTO feat_coverage (table_name, column_name, season, rows, non_null, updated_at)
     VALUES (@t,@c,@s,@rows,@nn,@now)
     ON CONFLICT(table_name, column_name, season) DO UPDATE SET
       rows=excluded.rows, non_null=excluded.non_null, updated_at=excluded.updated_at`,
  );
  const now = nowIso();
  db.transaction(() => {
    for (const s of seasons) {
      const e = db.prepare(
        "SELECT COUNT(*) rows, SUM(censored = 0) nn FROM fact_injury_episode WHERE season = ?",
      ).get(s) as { rows: number; nn: number | null };
      ins.run({ t: "fact_injury_episode", c: "__uncensored_episodes", s, rows: e.rows, nn: e.nn ?? 0, now });
      const h = db.prepare(
        "SELECT COUNT(*) rows, SUM(miss_next_4 IS NOT NULL) nn FROM feat_injury_horizon WHERE season = ?",
      ).get(s) as { rows: number; nn: number | null };
      ins.run({ t: "feat_injury_horizon", c: "__horizon_k4_observed", s, rows: h.rows, nn: h.nn ?? 0, now });
      n += 2;
    }
  })();
  return n;
}
