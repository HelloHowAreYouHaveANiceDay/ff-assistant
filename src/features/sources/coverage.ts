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
