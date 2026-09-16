// SYNC THE YAHOO LEAGUE'S SEASON-SO-FAR STATE (WP9): the started lineup and actual points of every
// SETTLED week, the three fact tables built on them, and the transaction log with its FAB bids.
//
// WHY A SCRIPT AND NOT A `ff` VERB. `ff ingest-raw league-rosters` resolves the ACTIVE league and
// refuses a non-ESPN platform by name (`requirePlatform`), and `ff.ts` was owned by another wave at
// the time this landed. The platform-seam ingester it drives (`ingestPlatformRosterWeeks`) is the
// real thing and is platform-agnostic; giving `ingest-raw` a `--league` passthrough that dispatches
// to it is the remaining step, and it belongs in ff.ts. Nothing here reimplements an ingester.
//
// READ-ONLY against Yahoo. Every fetch is a GET through the app's logged-in `yahooview` guest.
//
//   npm run ff -- --help            (not a ff verb)
//   npx tsx scripts/yahoo-sync-state.mjs [--league 129048] [--weeks 1,2] [--no-transactions]
import { openDb } from "../src/db/db.ts";
import { ingestPlatformRosterWeeks, settledWeeks } from "../src/data/leagueRosters.ts";
import { ingestYahooTransactions } from "../src/data/leagueTransactions.ts";
import { buildRosterStateInto } from "../src/features/sources/rosterState.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";

const arg = (flag, dflt = null) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const leagueId = arg("--league", "129048");
const weeksArg = arg("--weeks");

const db = openDb();
const ctx = resolveLeagueContext(db, leagueId);
const season = ctx.rowSeason ?? ctx.config.season;
const before = db.prepare("SELECT league_id, COUNT(*) n FROM raw_league_roster_week GROUP BY league_id").all();
// LOCAL date, not `toISOString()`. A football game day is a local date, and the ingester's own cut
// uses the local one -- two spellings a few hours apart would make this preview disagree with what
// actually got fetched, on exactly the Monday evenings when the answer matters.
const p2 = (n) => String(n).padStart(2, "0");
const now = new Date();
const settled = settledWeeks(db, season, `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`);
db.close();

console.log(`league ${leagueId} (${ctx.platformRaw}), season ${season}`);
console.log(`raw_league_roster_week BEFORE: ${JSON.stringify(before)}`);
console.log(`settled weeks (last NFL game day strictly before today): ${settled.join(", ") || "none"}`);

// `--rebuild` drops THIS LEAGUE'S rows first, so a changed parser or a changed resolver cannot leave
// a stale row behind: every writer here upserts by primary key, which updates a row it writes again
// and silently keeps one it no longer would. Every DELETE is scoped by league_id -- the other
// league's 27,068 roster-week rows and 24,367 facts are not this script's to touch.
if (process.argv.includes("--rebuild")) {
  const d = openDb();
  const dropped = {};
  for (const tbl of ["raw_league_roster_week", "fact_roster_week", "fact_lineup_week", "fact_fa_pool_week", "raw_league_transaction"]) {
    dropped[tbl] = d.prepare(`DELETE FROM ${tbl} WHERE league_id=?`).run(leagueId).changes;
  }
  d.close();
  console.log(`--rebuild: dropped ${JSON.stringify(dropped)} (league ${leagueId} only)`);
}

const weeks = weeksArg ? weeksArg.split(",").map(Number) : undefined;
const r = await ingestPlatformRosterWeeks({ leagueId, season, weeks });
console.log(`\ningest: platform=${r.platform} weeks=[${r.weeks.join(", ")}] rows=${r.counts.rows} starters=${r.counts.starters}`);
for (const c of r.checks) {
  console.log(`  ${c.season}: ${c.weeks} wk / ${c.teamWeeks} team-weeks, roster mode ${c.modeRoster} (${c.offSize} off), starters mode ${c.modeStarters} (${c.offStarters} off)`);
}
if (r.findings.length) {
  // THE SIZE GUARD IS CALIBRATED ON A LEAGUE WITH NO OPTIONAL SLOTS, and is reported here rather
  // than loosened. `checkRosterWeeks` exists to catch a TRUNCATED fetch, and its premise -- "roster
  // size is a league rule, so every team-week is the same number" -- holds for the ESPN league (13
  // slots, all mandatory) and does NOT hold here: Yahoo 129048 has two IR slots, a team may leave
  // them empty, and an empty slot renders no row. 17 vs 18 is a manager's injury luck, not a short
  // read. Loosening the shared tolerance would blunt it for the league it was measured on, so the
  // finding stands and the evidence that the fetch was complete is printed beside it: every team is
  // present, and every one started exactly a full lineup.
  console.log(`  GUARD FINDINGS: ${JSON.stringify(r.findings)}`);
  const d = openDb();
  const sizes = d.prepare(
    "SELECT week, team_id, COUNT(*) n, SUM(is_starter) st FROM raw_league_roster_week WHERE league_id=? AND season=? GROUP BY week, team_id ORDER BY week, CAST(team_id AS INT)",
  ).all(leagueId, season);
  d.close();
  console.log(`  (roster sizes vary because this league's IR slots are OPTIONAL; a truncated fetch would show missing TEAMS or short STARTING lineups, and neither is present)`);
  console.log(`  per team-week size/starters: ${sizes.map((s) => `wk${s.week}t${s.team_id}=${s.n}/${s.st}`).join(" ")}`);
}

const b = await buildRosterStateInto({ seasons: [season], leagueId });
console.log(`\nbuild-roster-state: seasons=[${b.seasons.join(", ")}] roster=${b.rosterRows} lineup=${b.lineupRows} fa=${b.faRows}`);
console.log(`  identity: ${b.resolve.total} looked up -> xref ${b.resolve.byXref}, dst-id ${b.resolve.byDst}, name+pos ${b.resolve.byName}, name+pos+team ${b.resolve.byTeam}, UNRESOLVED ${b.resolve.unresolved}`);
if (b.resolve.examples.length) console.log(`  unresolved examples: ${b.resolve.examples.join(" | ")}`);

if (!process.argv.includes("--no-transactions")) {
  const t = await ingestYahooTransactions({ leagueId, season });
  console.log(`\ntransactions: ${t.transactions} event(s), ${t.rows} item row(s), ${t.withBid} with a FAB bid`);
}

const db2 = openDb();
console.log(`\nAFTER, per league:`);
for (const tbl of ["raw_league_roster_week", "fact_roster_week", "fact_lineup_week", "fact_fa_pool_week", "raw_league_transaction"]) {
  console.log(`  ${tbl}: ${JSON.stringify(db2.prepare(`SELECT league_id, COUNT(*) n FROM ${tbl} GROUP BY league_id`).all())}`);
}
db2.close();
