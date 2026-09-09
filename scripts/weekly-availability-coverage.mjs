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
import { openDb } from "../src/db/db.js";
import { CONTEXT_FIELDS, weeklyCoverage } from "../src/weekly/features.ts";

const i = process.argv.indexOf("--db");
const db = openDb(i >= 0 ? process.argv[i + 1] : undefined);
const rows = weeklyCoverage(db);
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
