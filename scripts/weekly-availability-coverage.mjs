// PER-COLUMN COVERAGE OF THE AVAILABILITY BLOCK, BY SEASON.
//
//   node --import tsx scripts/weekly-availability-coverage.mjs [--db path]
//
// A model report that does not say which seasons a column exists in is a report that implies the
// model saw everything. Three separate feeds start at three different times -- injuries 2009 (dated
// from 2010), snap counts 2013, participation 2016 -- and one of them STOPS: from 2025 the injury
// feed no longer publishes a report date, so `feat_player_week_context` correctly drops every 2025
// filing and every injury column reads NULL. That is a coverage fact and not a healthy league, which
// is what `inj_feed` exists to say out loud.
//
// The columns are read from src/weekly/features.ts CONTEXT_FIELDS rather than retyped, so a column
// added there appears here without anyone remembering to add it.
import { openDb, getConfig } from "../src/db/db.js";
import { CONTEXT_FIELDS, weeklyCoverage, liveWeekCoverage } from "../src/weekly/features.ts";

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const db = openDb(arg("--db"));
const rows = weeklyCoverage(db);

// THE LIVE-WEEK TRIPWIRE (WP17). The season table above is the wrong resolution to see a live
// outage: a live season is mostly future weeks that legitimately carry nothing, so a column that
// went 100% dark at the serve reads as an ordinary partially-built season. `--week` overrides; by
// default the live week is the first week of the configured season with no scored rows.
const liveSeason = Number(arg("--season") ?? getConfig(db).season);
// The live week is the first with NO scored row AT ALL -- not the first with a missing one. Every
// week has rows for men who did not play, so `pts IS NULL` alone resolves to week 1 forever, which
// is the degenerate week where every to-date column is legitimately empty in every season.
const liveWeek = Number(arg("--week") ?? (db.prepare(
  `SELECT MIN(week) AS w FROM feat_player_week_model WHERE season = ? AND week NOT IN
     (SELECT week FROM feat_player_week_model WHERE season = ? AND pts IS NOT NULL)`)
  .get(liveSeason, liveSeason)?.w ?? 1));
const tripwire = liveWeekCoverage(db, liveSeason, liveWeek);
db.close();

const cols = CONTEXT_FIELDS.map((c) => c.name);
const pad = (s, n) => String(s).padStart(n);
console.log("AVAILABILITY COVERAGE -- share of feat_player_week_model rows carrying each column\n");
console.log("  " + "as-of rules");
for (const c of CONTEXT_FIELDS) console.log(`    ${c.name.padEnd(22)} ${c.asOf}`);
console.log("");
console.log("  season   rows " + cols.map((c) => pad(c.slice(0, 8), 9)).join(""));
for (const r of rows) {
  const pct = (k) => pad(r.rows ? `${((100 * r.cols[k]) / r.rows).toFixed(0)}%` : "-", 9);
  console.log(`  ${r.season}  ${pad(r.rows, 5)} ` + cols.map(pct).join(""));
}
console.log(`
READING THIS
  2010-2012  the extension table does not cover them at all: feat_player_week_context starts in 2013.
  2013-2015  no participation feed, so prior_route_share is absent by construction.
  2025+      the injury feed publishes no report DATE, so every filing is undated and cannot be
             placed on either side of a cutoff. inj_feed is 0 for those league-weeks and the five
             injury indicators are NULL -- not 0. A model that read them as 0 would be asserting
             that nobody in the league was hurt, which is worse than missing data.
  depth_rank and prior_snap_share survive 2025 because the depth-chart and snap feeds still carry
  dates; the injury block is the only one that goes dark.`);

// ---------------------------------------------------------------------------------------------
console.log(`\nLIVE-WEEK TRIPWIRE -- ${liveSeason} week ${liveWeek}, decision population, against the`);
console.log("same week in the 3 prior seasons. A column DARK here with a healthy band is a live feed");
console.log("outage: it is the shape M2h measured at -0.71 points per lineup per week, and the season");
console.log("table above cannot show it.\n");
console.log("  column                    live    band (prior seasons, same week)   status");
let bad = 0;
for (const r of tripwire) {
  const pc = (x) => `${(100 * x).toFixed(0)}%`.padStart(5);
  const band = r.prior.length ? `${pc(r.bandLo)} - ${pc(r.bandHi)}  [${r.prior.map((p) => `${p.season} ${pc(p.share)}`).join("  ")}]` : "(no prior coverage)";
  if (r.status === "dark" || r.status === "below") bad++;
  console.log(`  ${r.column.padEnd(22)} ${pc(r.live)}    ${band.padEnd(46)} ${r.status.toUpperCase()}`);
}
console.log(`\n  ${bad} column(s) below band.` + (bad
  ? " A DARK column with a live feed is a bug; a DARK column whose upstream file 404s is a\n  coverage fact and the serve caveat must NAME it (see docs/weekly.md, 'live-season feeds')."
  : " The live week is inside the band every prior season set at this point."));
