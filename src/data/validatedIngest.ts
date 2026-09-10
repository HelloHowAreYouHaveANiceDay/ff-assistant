/**
 * THE INGEST CONTRACT: pull -> write -> VALIDATE THE WRITE LANDED, recorded durably in the DB.
 *
 * Every external source (ESPN, nflverse, ECR, the app's league session, ...) is a datasource we pull
 * from and write to the ONE store. The failure this file exists to make impossible is the SILENT one:
 * a pull that returns nothing -- a session expired, a payload shape drifted, a 200 with an empty
 * array -- writes zero rows, the verb prints a cheerful grand total and exits 0, and the store is
 * quietly emptier than it was. CLAUDE.md records this exact shape more than once ("a sweep run
 * against a closed app reported '3/3 steps ok' having synced nothing"). So a write is not finished
 * until it has been READ BACK from the store and proven non-degenerate, and every such check is
 * written to `ingest_audit` so "we validated it" is a row in the DB, not a log line that scrolled by.
 *
 * TWO GUARANTEES, and they are different:
 *   - `assertPulled` refuses a DESTRUCTIVE write (a full-refresh DELETE) when the pull came back
 *     empty. It runs BEFORE the delete, so an empty pull can never wipe good rows.
 *   - `auditIngest` runs AFTER the write, re-counts the table, and fails loudly if the rows are not
 *     there -- proving the write landed rather than trusting the writer's own returned count.
 */
import { nowIso, type DB } from "../db/db.js";

export interface IngestPolicy {
  /** The write must leave at least this many rows in the table. Default 1: a sync that wrote nothing
   *  is a failure, never a success. Set 0 ONLY for a source that can legitimately be empty. */
  minRows?: number;
  /** If a prior OK audit for this source exists, the new readback must be at least this fraction of
   *  it -- catches a COLLAPSE (200 rows last week, 3 today) that `minRows` alone waves through.
   *  Default 0 (off), because a first sync or a legitimately growing feed has no stable prior. */
  minFractionOfPrev?: number;
}

export interface IngestVerdict {
  source: string;
  season: number | null;
  ok: boolean;
  rowsWritten: number;
  rowsReadback: number;
  reason: string;
}

/**
 * Refuse to proceed with a DESTRUCTIVE write (a full-refresh DELETE) when the pull came back empty.
 * Call this with the pulled row count BEFORE the delete/insert, so an empty pull cannot wipe good
 * rows. Throws -- the caller's verb then fails loudly instead of committing the deletion.
 *
 * This is the guard the ownership sync did not have: `DELETE FROM ownership` then insert nothing on
 * an empty ESPN read left the table wiped and the run green.
 */
export function assertPulled(count: number, source: string): void {
  if (count > 0) return;
  throw new Error(
    `${source}: the pull returned 0 rows -- refusing to overwrite the store with nothing. An empty ` +
    "pull is a session/endpoint failure, not 'the data is now empty', so the existing rows are kept. " +
    "Re-run once the source is reachable.",
  );
}

/** Count a table's rows, filtered by season when the table has a `season` column and a season is
 *  given. Table names come from the ingest registry (trusted), never user input. */
export function countTable(db: DB, table: string, season?: number | null): number {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.length) return 0; // table absent -> definitively nothing landed
  const hasSeason = season != null && cols.some((c) => c.name === "season");
  const row = hasSeason
    ? db.prepare(`SELECT count(*) AS c FROM ${table} WHERE season = ?`).get(season)
    : db.prepare(`SELECT count(*) AS c FROM ${table}`).get();
  return (row as { c: number }).c;
}

/**
 * Read back what a write landed and record the verdict in `ingest_audit`. The single validation
 * chokepoint: a caller runs its pull + write, then calls this with the count it MEANT to write and a
 * `readback` closure that re-counts what is actually in the store now. Returns the verdict; the
 * caller decides whether a failing verdict is fatal (a sync verb throws; a best-effort refresh may
 * only warn). Nothing here throws -- recording a failed audit is itself the point, so the failure is
 * never lost.
 */
export function auditIngest(
  db: DB,
  args: { source: string; season?: number | null; rowsWritten: number; readback: () => number; policy?: IngestPolicy },
): IngestVerdict {
  const season = args.season ?? null;
  const policy = args.policy ?? {};
  const minRows = policy.minRows ?? 1;
  const rowsReadback = args.readback();
  const reasons: string[] = [];
  if (rowsReadback < minRows) reasons.push(`readback ${rowsReadback} < required minimum ${minRows}`);
  if (policy.minFractionOfPrev && policy.minFractionOfPrev > 0) {
    const prev = (season == null
      ? db.prepare(`SELECT rows_readback AS r FROM ingest_audit WHERE source = ? AND ok = 1 AND season IS NULL ORDER BY id DESC LIMIT 1`).get(args.source)
      : db.prepare(`SELECT rows_readback AS r FROM ingest_audit WHERE source = ? AND ok = 1 AND season = ? ORDER BY id DESC LIMIT 1`).get(args.source, season)
    ) as { r: number } | undefined;
    if (prev && rowsReadback < prev.r * policy.minFractionOfPrev) {
      reasons.push(`readback ${rowsReadback} collapsed below ${(policy.minFractionOfPrev * 100).toFixed(0)}% of the last good sync's ${prev.r}`);
    }
  }
  const ok = reasons.length === 0;
  const reason = ok ? `${rowsReadback} rows present` : reasons.join("; ");
  db.prepare(
    `INSERT INTO ingest_audit (source, season, ran_at, rows_written, rows_readback, ok, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(args.source, season, nowIso(), args.rowsWritten, rowsReadback, ok ? 1 : 0, reason);
  return { source: args.source, season, ok, rowsWritten: args.rowsWritten, rowsReadback, reason };
}

export interface AuditRow extends IngestVerdict { ranAt: string }

/** The latest audit row per source -- for a freshness report or the sync orchestrator's "did the last
 *  pull land?" check. */
export function lastAudits(db: DB): AuditRow[] {
  const rows = db.prepare(
    `SELECT a.source, a.season, a.ok, a.rows_written AS rw, a.rows_readback AS rr, a.note, a.ran_at
       FROM ingest_audit a
       JOIN (SELECT source, MAX(id) AS mid FROM ingest_audit GROUP BY source) m ON m.mid = a.id
      ORDER BY a.source`,
  ).all() as { source: string; season: number | null; ok: number; rw: number; rr: number; note: string; ran_at: string }[];
  return rows.map((r) => ({
    source: r.source, season: r.season, ok: !!r.ok, rowsWritten: r.rw, rowsReadback: r.rr, reason: r.note, ranAt: r.ran_at,
  }));
}

/** A convenience for the common case: run a write, then audit it by counting one table. Returns the
 *  verdict. `throwOnFail` makes a degenerate write fatal (what a sync VERB wants); leave it false for
 *  a best-effort background refresh that should only record the failure. */
export function auditTable(
  db: DB,
  args: { source: string; table: string; season?: number | null; rowsWritten: number; policy?: IngestPolicy; throwOnFail?: boolean },
): IngestVerdict {
  const v = auditIngest(db, {
    source: args.source, season: args.season, rowsWritten: args.rowsWritten,
    readback: () => countTable(db, args.table, args.season), policy: args.policy,
  });
  if (!v.ok && args.throwOnFail) {
    throw new Error(`${args.source}: ingest validation FAILED -- ${v.reason}. The write did not land; the store was not updated as reported.`);
  }
  return v;
}
