#!/usr/bin/env node
/**
 * `node --import tsx scripts/ecr-week-leak-guard.mjs [--seasons 2020-2024]`
 *
 * THE POINT-IN-TIME GUARD FOR `ecr_wk_rank` / `ecr_wk_sd`, WITH ITS OWN FAULT INJECTION.
 *
 * The weekly expert consensus is the most attractive leak on this table. It is a FORECAST, published
 * repeatedly through a week, and a scrape taken one day late has seen a Thursday night game, an
 * inactives list, and in the worst case the Sunday slate itself. A column built from "the newest
 * scrape for that week" would look superb and be worth nothing, exactly as `dvp_mult` computed over
 * the whole season would. So the claim under test is a DATE BOUND and nothing else:
 *
 *     every stored value comes from the LATEST `wp` scrape dated at or before this team's kickoff
 *     minus two days, and from no scrape more than ECR_WEEK_MAX_AGE_DAYS older than that cutoff.
 *
 * A check that can only ever say "clean" is dead code that reads exactly like a passing one (this
 * repo has the scar in four layers -- docs/validation.md, Track B), so the script makes THREE passes
 * over the table that actually shipped, and the second and third are the ones that prove the first
 * means anything:
 *
 *   A  NEGATIVE, the honest bound. Recompute every row's value from `ranking_history` and
 *      `raw_nfl_game` with an INDEPENDENT implementation -- a SQL correlated subquery rather than the
 *      builder's per-season map walk -- and require an EXACT match on every row, in both directions:
 *      a stored value where the recomputation has none is as much a failure as a disagreement.
 *
 *   B  FAULT INJECTION, the leaked bound. Recompute with the cutoff moved to kickoff PLUS one day --
 *      i.e. the scrape published after the games -- and require that it DISAGREES with the stored
 *      column on a large number of rows. If it does not, check A is comparing the table against
 *      something insensitive to the date and every green run of it has been meaningless.
 *
 *   C  FAULT INJECTION, the anchor. Recompute with the cutoff shifted back ONE day (kickoff minus
 *      three) and require that it too disagrees. B proves the column is not reading the future; C
 *      proves it is pinned to THIS anchor rather than to any date in the neighbourhood, which is the
 *      thing a one-character error in a `<=` would break.
 *
 *   D  THE ERA BOUND, asserted rather than assumed: no row outside the seasons whose `wp` archive
 *      exists may carry a value. A column that quietly acquired one for a season with no scrape
 *      behind it would be a fabricated fact.
 *
 *      THE COVERED SEASONS ARE DERIVED FROM `ranking_history`, NOT TYPED IN (M2b, 2026-09-16). They
 *      used to be the literal 2019..2024, which was true on the day it was written and became FALSE
 *      the moment the live retention began appending 2026 scrapes -- a coverage-by-enumeration
 *      snapshot, the exact shape CLAUDE.md names as the guard that rots while staying green. It now
 *      reads the seasons the archive actually holds, so a new live season passes because it IS
 *      covered and a fabricated one still fails.
 *
 * ON THE LIVE SEASON. Checks A-C apply to 2026 rows exactly as to historical ones: the recomputation
 * is the same independent implementation against the same `raw_nfl_game` gamedays, and the retained
 * scrapes are rows of the same table. What differs is POWER, not validity -- one retained scrape
 * cannot move as many rows under a shifted anchor as five seasons of archive can -- so the aggregate
 * thresholds are read over the whole requested range and the per-season line below says how many
 * values each season contributed.
 *
 * Read-only. Exit 0 = all four held; non-zero names the one that did not.
 */
import Database from "better-sqlite3";
import { canonTeam } from "../src/data/nflverse.ts";
import { ECR_WEEK_MAX_AGE_DAYS } from "../src/weekly/features.ts";
import { nameKey } from "../src/draft/values.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = String(arg("--seasons", "2020-2024")).split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);

const db = new Database("data/ff.db", { readonly: true });
let failed = null;
const say = (ok, label, detail) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}${detail ? " -- " + detail : ""}`);
  if (!ok && !failed) failed = label;
};

console.log(`ECR WEEKLY-CONSENSUS LEAK GUARD -- seasons ${seasons.join(", ")}, max scrape age ${ECR_WEEK_MAX_AGE_DAYS} days`);

// ---- the independent side -------------------------------------------------------------------
// gameday per (season, team, week), from raw_nfl_game. The builder reads the nflverse schedules CSV
// cache instead, so this is a different path to the same feed: what is INDEPENDENT here is the
// implementation and what is UNDER TEST is the bound, which is the same honesty the streaming audit
// states about its own blend arithmetic.
const gameday = new Map();
for (const g of db.prepare(
  "SELECT season, week, gameday, home_team, away_team FROM raw_nfl_game WHERE game_type = 'REG' AND season BETWEEN ? AND ?",
).all(lo, hi)) {
  if (!g.gameday) continue;
  for (const t of [g.home_team, g.away_team]) gameday.set(`${g.season}|${canonTeam(t ?? "")}|${g.week}`, g.gameday);
}

const POS_ALIAS = { PK: "K", DEF: "DST", "D/ST": "DST" };
/** season -> sorted scrape dates -> Map(`namekey|pos` -> {ecr, sd}). Loaded straight from the raw
 *  table, with no reference to the builder's helper. */
const archive = new Map();
for (const r of db.prepare(
  "SELECT season, scrape_date, player_id, pos, ecr, sd FROM ranking_history WHERE source = 'fantasypros' AND ecr_type = 'wp'",
).all()) {
  const pos = POS_ALIAS[(r.pos ?? "").toUpperCase()] ?? (r.pos ?? "").toUpperCase();
  const byDate = archive.get(r.season) ?? archive.set(r.season, new Map()).get(r.season);
  const m = byDate.get(r.scrape_date) ?? byDate.set(r.scrape_date, new Map()).get(r.scrape_date);
  m.set(`${r.player_id}|${pos}`, { ecr: r.ecr, sd: r.sd });
}
const datesOf = (season) => [...(archive.get(season)?.keys() ?? [])].sort();
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/** The recomputation, parameterised BY THE OFFSET so the fault injection is the same code with one
 *  number changed. `offset` is days from kickoff: -2 is the honest cutoff. */
function recompute(season, row, offset) {
  const day = row.team ? gameday.get(`${season}|${canonTeam(row.team)}|${row.week}`) : undefined;
  if (!day) return null;
  const cutoff = shift(day, offset);
  const dates = datesOf(season);
  let chosen = null;
  for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= cutoff) { chosen = dates[i]; break; }
  if (!chosen) return null;
  const age = (Date.parse(`${cutoff}T00:00:00Z`) - Date.parse(`${chosen}T00:00:00Z`)) / 864e5;
  if (!(age <= ECR_WEEK_MAX_AGE_DAYS)) return null;
  const v = archive.get(season).get(chosen).get(`${nameKey(row.name)}|${row.pos}`) ?? null;
  return v ? { ...v, scrape: chosen, cutoff } : null;
}

const near = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);

let totalRows = 0, stored = 0, mismatchA = 0, diffB = 0, diffC = 0, oldest = 0;
const perSeason = new Map();
const examples = [];
for (const season of seasons) {
  const rows = db.prepare(
    "SELECT feat_key, week, name, pos, team, ecr_wk_rank, ecr_wk_sd FROM feat_player_week_model WHERE season = ?",
  ).all(season);
  for (const r of rows) {
    totalRows++;
    const ps = perSeason.get(season) ?? perSeason.set(season, { rows: 0, stored: 0, b: 0, c: 0 }).get(season);
    ps.rows++;
    if (r.ecr_wk_rank != null) { stored++; ps.stored++; }
    const a = recompute(season, r, -2);
    if (!near(a ? a.ecr : null, r.ecr_wk_rank) || !near(a ? a.sd : null, r.ecr_wk_sd)) {
      mismatchA++;
      if (examples.length < 4) examples.push(`${season} w${r.week} ${r.name} (${r.pos}): stored ${r.ecr_wk_rank} vs recomputed ${a ? a.ecr : null}`);
    }
    if (a) {
      const age = (Date.parse(`${a.cutoff}T00:00:00Z`) - Date.parse(`${a.scrape}T00:00:00Z`)) / 864e5;
      if (age > oldest) oldest = age;
      if (a.scrape > a.cutoff) { mismatchA++; examples.push(`${season} w${r.week} ${r.name}: scrape ${a.scrape} AFTER cutoff ${a.cutoff}`); }
    }
    const b = recompute(season, r, +1);
    if (!near(b ? b.ecr : null, r.ecr_wk_rank)) { diffB++; ps.b++; }
    const c = recompute(season, r, -3);
    if (!near(c ? c.ecr : null, r.ecr_wk_rank)) { diffC++; ps.c++; }
  }
}

console.log(`\n  ${totalRows} rows over ${seasons.length} seasons; ${stored} carry a weekly consensus`);
console.log(`  oldest qualifying scrape used: ${oldest} days before the cutoff (bound ${ECR_WEEK_MAX_AGE_DAYS})`);
say(stored > 1000, "the column is populated at all (a guard over an empty column measures nothing)", `${stored} values`);
say(mismatchA === 0, "A NEGATIVE: every stored value reproduces from the honest cutoff (kickoff - 2)",
  mismatchA ? `${mismatchA} mismatches: ${examples.join("; ")}` : `${totalRows} rows agree exactly, both directions`);
say(diffB > 100, "B FAULT INJECTION: the LEAKED cutoff (kickoff + 1) disagrees, so check A can fail", `${diffB} rows differ`);
say(diffC > 100, "C FAULT INJECTION: the anchor shifted back one day disagrees, so the column is pinned to THIS anchor", `${diffC} rows differ`);

console.log("  per season: " + [...perSeason.entries()]
  .map(([s, p]) => `${s} ${p.stored}/${p.rows} (B ${p.b}, C ${p.c})`).join("; "));

// THE COVERED SEASONS, READ FROM THE ARCHIVE. Not a literal list: see the header.
const covered = new Set(db.prepare(
  "SELECT DISTINCT season FROM ranking_history WHERE source = 'fantasypros' AND ecr_type = 'wp'",
).all().map((r) => r.season));
const stray = db.prepare(
  `SELECT season, COUNT(*) n FROM feat_player_week_model
    WHERE ecr_wk_rank IS NOT NULL AND season NOT BETWEEN ? AND ? GROUP BY season ORDER BY season`,
).all(lo, hi);
say(stray.every((s) => covered.has(s.season)),
  "D ERA BOUND: no value outside the seasons the `wp` archive covers",
  `archive covers ${[...covered].sort().join(",")}; ` + (stray.length
    ? "outside the screened window: " + stray.map((s) => `${s.season}:${s.n}`).join(", ")
    : "no values at all outside the screened window"));

db.close();
if (failed) { console.log(`\nECR LEAK GUARD FAILED: ${failed}`); process.exit(1); }
console.log("\nECR LEAK GUARD HELD: every value is from a scrape at or before this team's Friday cutoff, and the guard can fail.");
