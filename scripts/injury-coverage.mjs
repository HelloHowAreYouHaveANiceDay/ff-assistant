#!/usr/bin/env node
/**
 * `node scripts/injury-coverage.mjs [--db data/ff.db]`
 *
 * WHAT THE INJURY HORIZON TABLE ACTUALLY SUPPORTS, printed rather than assumed.
 *
 * Three things a per-column non-null count cannot tell you, and all three decide whether a fitted
 * duration means anything:
 *
 *   1. CENSORING. An episode where the man never returned inside the season has a weeks_missed that
 *      is a LOWER BOUND. A group with a high censoring rate has a mean that is biased DOWN, which is
 *      the opposite of the direction intuition expects, so it is printed beside every mean.
 *   2. THE TARGET COLLAPSES WITH k. miss_next_4 is NULL wherever fewer than four games remain, so
 *      k=4 is fitted on materially fewer rows than k=1 -- by construction, every season, at the end.
 *   3. THE PLAY SIGNAL IS A JOIN, not a fact. "He missed the game" here means "no scored row in our
 *      own weekly history for a week his team played". If that join were broken -- a rekey, a
 *      history rebuild -- every target would read `missed` and nothing would fail. So the script
 *      prints P(missed | designation), which has a KNOWN shape: Out is near 1, Probable near 0. A
 *      flat column there is the tell.
 */
import Database from "better-sqlite3";
const dbPath = (() => { const i = process.argv.indexOf("--db"); return i > 0 ? process.argv[i + 1] : "data/ff.db"; })();
const db = new Database(dbPath, { readonly: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";

console.log("=== COVERAGE PER SEASON ===");
console.log("  season  episodes  horizon  censored  k=1 obs  k=2 obs  k=3 obs  k=4 obs  +snap@return");
for (const r of q(`
  SELECT h.season,
    (SELECT COUNT(*) FROM fact_injury_episode e WHERE e.season = h.season) episodes,
    (SELECT SUM(censored) FROM fact_injury_episode e WHERE e.season = h.season) censored,
    (SELECT SUM(snap_share_on_return IS NOT NULL) FROM fact_injury_episode e WHERE e.season = h.season) snaps,
    COUNT(*) rows,
    SUM(miss_next_1 IS NOT NULL) k1, SUM(miss_next_2 IS NOT NULL) k2,
    SUM(miss_next_3 IS NOT NULL) k3, SUM(miss_next_4 IS NOT NULL) k4
  FROM feat_injury_horizon h GROUP BY h.season ORDER BY h.season`)) {
  console.log(`  ${r.season}  ${String(r.episodes).padStart(8)}  ${String(r.rows).padStart(7)}  ` +
    `${String(r.censored).padStart(8)}  ${String(r.k1).padStart(7)}  ${String(r.k2).padStart(7)}  ` +
    `${String(r.k3).padStart(7)}  ${String(r.k4).padStart(7)}  ${String(r.snaps).padStart(12)}`);
}

console.log("\n=== CENSORING AND DURATION BY INJURY GROUP ===");
console.log("  group           episodes   mean weeks missed   median   censored   P(missed>=4)");
for (const r of q(`
  SELECT injury_group g, COUNT(*) n, AVG(weeks_missed) m, SUM(censored) c,
         AVG(weeks_missed >= 4) p4
  FROM fact_injury_episode GROUP BY 1 ORDER BY n DESC`)) {
  const med = q(`SELECT weeks_missed w FROM fact_injury_episode WHERE injury_group = ?
                 ORDER BY weeks_missed LIMIT 1 OFFSET ?`, r.g, Math.floor(r.n / 2))[0]?.w ?? 0;
  console.log(`  ${r.g.padEnd(14)}  ${String(r.n).padStart(8)}   ${r.m.toFixed(2).padStart(17)}   ` +
    `${String(med).padStart(6)}   ${pct(r.c / r.n)}   ${pct(r.p4)}`);
}

console.log("\n=== THE PLAY SIGNAL, CROSS-CHECKED AGAINST THE DESIGNATION ===");
console.log("  (a broken play join reads `missed` everywhere and nothing else would fail)");
console.log("  designation    rows   P(miss next 1)  P(miss next 2)  P(miss next 4)");
for (const r of q(`
  SELECT CASE WHEN designation = '' THEN '(practice only)' ELSE designation END d,
         COUNT(*) n, AVG(miss_next_1) m1, AVG(miss_next_2) m2, AVG(miss_next_4) m4
  FROM feat_injury_horizon GROUP BY 1 ORDER BY m1 DESC`)) {
  console.log(`  ${r.d.padEnd(15)} ${String(r.n).padStart(6)}  ${pct(r.m1 ?? 0).padStart(14)}  ` +
    `${pct(r.m2 ?? 0).padStart(14)}  ${pct(r.m4 ?? 0).padStart(14)}`);
}

console.log("\n=== P(miss next k) BY INJURY GROUP, AMONG THE MEN LISTED OUT ===");
console.log("  the whole thesis in one table: a hamstring and a torn Achilles both read OUT on Friday");
console.log("  group           rows   k=1     k=2     k=3     k=4");
for (const r of q(`
  SELECT injury_group g, COUNT(*) n, AVG(miss_next_1) m1, AVG(miss_next_2) m2,
         AVG(miss_next_3) m3, AVG(miss_next_4) m4
  FROM feat_injury_horizon WHERE designation = 'Out' GROUP BY 1 HAVING n >= 40 ORDER BY m4 DESC`)) {
  console.log(`  ${r.g.padEnd(14)} ${String(r.n).padStart(5)}  ${pct(r.m1 ?? 0)}  ${pct(r.m2 ?? 0)}  ${pct(r.m3 ?? 0)}  ${pct(r.m4 ?? 0)}`);
}

console.log("\n=== COVERAGE ROWS WRITTEN TO feat_coverage (the synthetic ones) ===");
for (const r of q(`SELECT table_name t, column_name c, COUNT(*) seasons, SUM(rows) rows, SUM(non_null) nn
  FROM feat_coverage WHERE column_name LIKE '\\_\\_%' ESCAPE '\\' GROUP BY 1,2`)) {
  console.log(`  ${r.t}.${r.c}: ${r.nn}/${r.rows} over ${r.seasons} seasons`);
}
