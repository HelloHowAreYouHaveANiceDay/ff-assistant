// THE LIVE YAHOO ROSTERS AND THE REAL FREE-AGENT POOL, in one read, for the analysis scripts (WP9).
//
// WHAT THIS REPLACED. `scripts/yahoo-waiver-trade.mjs` and `scripts/yahoo-ros-analysis.mjs` each held
// an eighteen-name array of OUR roster typed into the source, and each read the free-agent pool from
// `data/formats/<key>/fa-pool.json` -- a file a person had scraped by hand, per-LEAGUE data sitting in
// a per-FORMAT directory, with no producer anywhere in the tree. Both went stale the moment anyone
// made a move (and both were stale: our team had added Mike Gesicki and dropped Michael Mayer hours
// before this was written). A number computed from a stale roster is not a stale number, it is a
// number about a team that does not exist.
//
// Both now come from the platform adaptor: `YahooLeague.teams()` and `YahooLeague.freeAgents()`, which
// read Yahoo's own all-rosters page and its `status=A` player list through the app's logged-in guest.
//
// THE POSITIVE CONTROL IS RETURNED, NOT ASSUMED. `overlap` is the number of pool members who are on
// somebody's roster, and it must be 0: "available" and "rostered" are complements on Yahoo's own
// pages, so a non-zero overlap means one of the two reads is of the wrong thing. A caller that
// ignores it gets the number anyway; `--check` prints it.
import { openDb } from "../src/db/db.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";
import { YahooLeague } from "../src/league/yahoo.ts";
import { nameKey } from "../src/draft/values.ts";

/** { ours, rostered, fa, overlap } for a Yahoo league, read live. `limit` is a player count. */
export async function liveYahooPool(leagueId, limit = 250) {
  const db = openDb();
  const ctx = resolveLeagueContext(db, leagueId);
  db.close();
  if (ctx.platformRaw !== "yahoo") throw new Error(`liveYahooPool: league ${leagueId} is on "${ctx.platformRaw}", not yahoo.`);
  const lg = YahooLeague.direct(ctx.leagueId, ctx.teamId, ctx.config);
  const teams = await lg.teams();
  const me = teams.find((t) => t.mine);
  if (!me) throw new Error(`liveYahooPool: none of league ${leagueId}'s ${teams.length} teams is ours (team_id ${ctx.teamId}).`);
  const rostered = new Set(teams.flatMap((t) => t.roster.map((p) => nameKey(p.name))));
  const fa = await lg.freeAgents(limit);
  const overlap = fa.filter((f) => rostered.has(nameKey(f.name)));
  return {
    leagueId: ctx.leagueId,
    ours: me.roster.map((p) => p.name),
    teams, rostered, fa, overlap,
  };
}

if (process.argv.includes("--check")) {
  const i = process.argv.indexOf("--league");
  const p = await liveYahooPool(i >= 0 ? process.argv[i + 1] : "129048");
  console.log(`league ${p.leagueId}: ${p.teams.length} teams, ${p.rostered.size} rostered men, ${p.fa.length} available`);
  console.log(`  our roster (${p.ours.length}): ${p.ours.join(", ")}`);
  console.log(`  pool by position: ${JSON.stringify(p.fa.reduce((a, f) => ({ ...a, [f.pos]: (a[f.pos] ?? 0) + 1 }), {}))}`);
  console.log(`  on waivers (a claim, not an add): ${p.fa.filter((f) => f.waivers).length}`);
  console.log(`  OVERLAP with rostered men (must be 0): ${p.overlap.length}${p.overlap.length ? " -- " + p.overlap.map((f) => f.name).join(", ") : ""}`);
  for (const who of process.argv.slice(process.argv.indexOf("--check") + 1).filter((a) => !a.startsWith("--") && a !== p.leagueId)) {
    const inPool = p.fa.find((f) => nameKey(f.name) === nameKey(who));
    const onRoster = [...p.teams].find((t) => t.roster.some((r) => nameKey(r.name) === nameKey(who)));
    console.log(`  "${who}": ${inPool ? `IN THE POOL (${inPool.waivers ? "on waivers" : "free agent"}, ${inPool.pctOwned}% rostered)` : onRoster ? `NOT in the pool -- rostered by team ${onRoster.id} (${onRoster.name})` : "neither in the pool nor on a roster in this league"}`);
  }
}
