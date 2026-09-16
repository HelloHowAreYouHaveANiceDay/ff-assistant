/**
 * Ingest the DynastyProcess FantasyPros ECR archive into the store.
 *
 * WHAT THIS IS. db_fpecr.csv.gz is the full public history of FantasyPros expert consensus
 * rankings -- ecr, sd, best and worst, per player, per scrape date, 2019 onward, ~1.5M rows. It is
 * the same source ffsimulator's ffs_latest_rankings reads. We had none of it: the `ranking` table
 * holds ONE row per (player, source, season), so it can answer "what is he ranked now" and nothing
 * about how rankings moved or what they looked like in a past season.
 *
 * WHY IT IS WORTH STORING even though the first hypothesis it was fetched for FAILED (expert
 * disagreement does not predict outcome dispersion once rank is held fixed -- see
 * scripts/ecr-dispersion.mjs): every backtest we run currently substitutes PRIOR-SEASON FINISHING
 * RANK for what the market actually believed preseason. That substitution is stated in three
 * different scripts as a known weakness, and it biases every feature test TOWARD finding value,
 * because finishing rank is a weaker baseline than consensus. With this table the backtests can use
 * the real preseason consensus and the measurements get honest.
 *
 * WHAT IS KEPT. Redraft and weekly lists only -- `ro`/`rp` (redraft overall/positional) and
 * `wo`/`wp` (weekly). Dynasty, best-ball and superflex rankings answer a different question than a
 * redraft league asks and would triple the row count for nothing. The filter is a deliberate scoping
 * decision, not a size optimisation, and `types` makes it overridable.
 */
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { openDb, nowIso, type DB } from "../db/db.js";
import { nameKey } from "../draft/values.js";

export const FPECR_URL = "https://github.com/DynastyProcess/data/raw/master/files/db_fpecr.csv.gz";
/** Redraft + weekly. Dynasty/best-ball/superflex describe a different game. */
export const REDRAFT_TYPES = ["ro", "rp", "wo", "wp"];

/**
 * Split one CSV line, honouring quoted fields.
 *
 * A naive split on commas is fine for the columns near the front of this file and wrong the moment a
 * quoted field contains one. Player names are the obvious risk ("Odell Beckham Jr." is safe, a
 * suffix rendered "Beckham, Odell" is not), and a mis-split silently shifts EVERY later column --
 * ecr would be read from the team field and nothing would throw.
 */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export interface IngestResult { read: number; kept: number; skippedType: number; badRow: number; seasons: number[]; types: string[] }

/**
 * THE LIVE WEEKLY CONSENSUS, RETAINED AS A POINT-IN-TIME SNAPSHOT (M2b, 2026-09-16).
 *
 * WHY THIS EXISTS. `weekly_rank` (src/data/advanced.ts `ingestWeekly`) holds FantasyPros' CURRENT
 * week positional consensus and is `DELETE`d on every ingest, keyed `(player_id, pos)` with no
 * season and no week. So the live feed carries exactly the quantity `ecr_wk_rank` needs and RETAINS
 * NONE OF IT: yesterday's opinion is gone the moment today's lands, and a stored row cannot be
 * placed in a week at all. That is the whole reason the M2a screen admitted the feature on the
 * measurement and died at the serve boundary (docs/weekly-ecr-screen-2026-09-16.md section 7).
 *
 * WHAT THIS DOES. Every ingest of the weekly feed ALSO appends the same rows into
 * `ranking_history` as `ecr_type = 'wp'`, keyed exactly like the DynastyProcess archive
 * (`source, ecr_type, scrape_date, player_id, pos`), so the archive and the live retention are ONE
 * table with one key and `ecrWeekTable` needs no change whatsoever to read 2026.
 *
 * THREE PROPERTIES, and each is a refusal rather than a convenience:
 *   - **APPEND ONLY.** `INSERT OR IGNORE`. Never DELETE, never UPDATE. Re-ingesting the same scrape
 *     is a no-op (the idempotency control in the sign-off doc asserts the row count is unchanged on
 *     a second run); a NEW scrape date is a NEW row. A point-in-time archive that any ingest can
 *     rewrite is not point-in-time, and an UPDATE here would silently re-date last week's opinion.
 *   - **THE SCRAPE'S OWN DATE, not the ingest time.** The feed publishes `scrape_date` per row; that
 *     is the as-of the whole point-in-time rule is stated against. `fallbackDate` (the ingest date)
 *     is used only where the feed carries none, and a row whose date is unusable is dropped rather
 *     than stamped with today -- dating a stale scrape "today" is the one error that would let a
 *     week-old consensus pass the freshness bound.
 *   - **`season` IS THE SCRAPE YEAR**, byte-for-byte what `ingestEcrHistory` above stamps, so a
 *     later re-load of the archive cannot disagree with a row we wrote. Redraft weekly lists stop
 *     in December (the archive holds no January `wp` date in six seasons), so the calendar year and
 *     the NFL season are the same thing on this feed.
 *
 * WHAT IS **NOT** WRITTEN: `ecr_type = 'wo'`, the weekly OVERALL list. `fp_latest_weekly.csv`
 * publishes positional pages only (qb / ppr-rb / ppr-wr / ppr-te / k / dst / dl / lb / db) and no
 * overall page, so there is no overall consensus in this feed to retain. Manufacturing one by
 * pooling the positional lists would be our number wearing FantasyPros' name. `wp` is the column
 * `ecr_wk_rank` reads anyway.
 *
 * IDP rows (DL/LB/DB) are kept, because the archive keeps them and `ecrWeekTable` drops them at
 * READ time -- one filter, in the reader, rather than two that can disagree.
 */
export interface WeeklyRankSnapshotRow {
  name: string;
  pos: string;
  team?: string | null;
  ecr: number;
  sd?: number | null;
  best?: number | null;
  worst?: number | null;
  /** The feed's own scrape date for this row. Falls back to `fallbackDate` when absent. */
  scrapeDate?: string | null;
}

export interface WeeklySnapshotResult {
  /** Rows the archive did not already hold -- i.e. what this scrape actually added. */
  inserted: number;
  /** Rows already present under the same key: a re-ingest of a scrape we have. */
  ignored: number;
  /** Rows with no usable date or no name/ecr. Dropped, never stamped with today. */
  badRow: number;
  /** The scrape dates written, ascending. Reported so an empty append is never silent. */
  dates: string[];
}

export function appendWeeklyRankSnapshot(
  db: DB, rows: WeeklyRankSnapshotRow[], fallbackDate: string,
): WeeklySnapshotResult {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO ranking_history
       (source, ecr_type, season, scrape_date, player_id, name, pos, team, ecr, sd, best, worst, fetched_at)
     VALUES ('fantasypros','wp',@season,@date,@pid,@name,@pos,@team,@ecr,@sd,@best,@worst,@now)`,
  );
  const now = nowIso();
  const res: WeeklySnapshotResult = { inserted: 0, ignored: 0, badRow: 0, dates: [] };
  const dates = new Set<string>();
  const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const run = db.transaction(() => {
    for (const r of rows) {
      const date = (r.scrapeDate ?? "").trim() || fallbackDate;
      const name = (r.name ?? "").trim();
      const pos = (r.pos ?? "").trim().toUpperCase();
      if (!isDate(date) || !name || !pos || !Number.isFinite(r.ecr)) { res.badRow++; continue; }
      const info = ins.run({
        season: Number(date.slice(0, 4)), date, pid: nameKey(name), name, pos,
        team: r.team ?? "", ecr: r.ecr,
        sd: Number.isFinite(r.sd as number) ? r.sd : null,
        best: Number.isFinite(r.best as number) ? r.best : null,
        worst: Number.isFinite(r.worst as number) ? r.worst : null,
        now,
      });
      if (info.changes) res.inserted++; else res.ignored++;
      dates.add(date);
    }
  });
  run();
  res.dates = [...dates].sort();
  return res;
}

export async function ingestEcrHistory(opts: {
  dbPath?: string; file?: string; url?: string; types?: string[]; onProgress?: (n: number) => void;
} = {}): Promise<IngestResult> {
  const db: DB = openDb(opts.dbPath);
  const keep = new Set(opts.types ?? REDRAFT_TYPES);

  const source = opts.file
    ? createReadStream(opts.file)
    : Readable.fromWeb((await fetch(opts.url ?? FPECR_URL)).body as never);
  const rl = createInterface({ input: source.pipe(createGunzip()), crlfDelay: Infinity });

  const ins = db.prepare(
    `INSERT INTO ranking_history (source, ecr_type, season, scrape_date, player_id, name, pos, team, ecr, sd, best, worst, fetched_at)
     VALUES (@src,@type,@season,@date,@pid,@name,@pos,@team,@ecr,@sd,@best,@worst,@now)
     ON CONFLICT(source, ecr_type, scrape_date, player_id, pos) DO UPDATE SET
       ecr=excluded.ecr, sd=excluded.sd, best=excluded.best, worst=excluded.worst, fetched_at=excluded.fetched_at`,
  );
  const now = nowIso();
  let idx: Record<string, number> | null = null;
  const res: IngestResult = { read: 0, kept: 0, skippedType: 0, badRow: 0, seasons: [], types: [] };
  const seasons = new Set<number>(), types = new Set<string>();

  // Batched transactions: one commit per row is ~100x slower and this is half a million rows.
  let batch: Record<string, unknown>[] = [];
  const flush = db.transaction((rows: Record<string, unknown>[]) => { for (const r of rows) ins.run(r); });

  for await (const line of rl) {
    if (!idx) {
      idx = {};
      splitCsv(line).forEach((h, i) => (idx![h.trim()] = i));
      for (const need of ["ecr_type", "scrape_date", "player", "pos", "ecr", "sd", "best", "worst"]) {
        if (idx[need] === undefined) { db.close(); throw new Error(`db_fpecr is missing column '${need}' -- format changed; columns: ${Object.keys(idx).join(",")}`); }
      }
      continue;
    }
    res.read++;
    const f = splitCsv(line);
    const type = f[idx.ecr_type];
    if (!keep.has(type)) { res.skippedType++; continue; }
    const date = f[idx.scrape_date] ?? "";
    const name = (f[idx.player] ?? "").trim();
    const ecr = Number(f[idx.ecr]);
    if (!name || !/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(ecr)) { res.badRow++; continue; }
    const season = Number(date.slice(0, 4));
    const num = (v: string) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
    batch.push({
      src: "fantasypros", type, season, date, pid: nameKey(name), name,
      pos: (f[idx.pos] ?? "").toUpperCase(), team: f[idx.team] ?? "",
      ecr, sd: num(f[idx.sd]), best: num(f[idx.best]), worst: num(f[idx.worst]), now,
    });
    seasons.add(season); types.add(type);
    res.kept++;
    if (batch.length >= 5000) { flush(batch); batch = []; opts.onProgress?.(res.kept); }
  }
  if (batch.length) flush(batch);
  res.seasons = [...seasons].sort();
  res.types = [...types].sort();
  db.close();
  return res;
}
