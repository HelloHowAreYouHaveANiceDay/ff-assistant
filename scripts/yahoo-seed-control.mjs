// THE POSITIVE CONTROL ON THE D18 SEED FOR THE YAHOO LEAGUE (WP9).
//
// The seed sums each team's STARTED LINEUP out of `raw_league_roster_week` and decides every settled
// week's matchup from those sums. That is a closed loop: the rows we wrote, scored by the points we
// wrote, compared against the schedule we wrote. Green means internally consistent and says nothing
// about whether it is RIGHT.
//
// So this compares it against a number from a DIFFERENT PAGE that we did not produce: Yahoo's own
// week scoreboard, which prints each side's final score and its record. If the lineup snapshot is
// missing a man, has him on the bench, or has the wrong week's points, the two disagree -- and there
// is no way for that to be hidden by the seed being self-consistent.
//
//   npx tsx scripts/yahoo-seed-control.mjs [--league 129048]
//
// Needs the app running and signed in to Yahoo (it fetches the scoreboard live).
import { loadSimContext } from "../src/draft/simContext.ts";
import { YahooLeague } from "../src/league/yahoo.ts";
import { openDb } from "../src/db/db.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";

const i = process.argv.indexOf("--league");
const leagueId = i >= 0 ? process.argv[i + 1] : "129048";

const db = openDb();
const ctx0 = resolveLeagueContext(db, leagueId);
db.close();
const lg = YahooLeague.direct(leagueId, ctx0.teamId, ctx0.config);

const ctx = await loadSimContext({ leagueId, schedule: "real" });
const played = ctx.opts(1, 1).played;
console.log(`league ${leagueId}: seeded weeks = ${ctx.played.weeks}, nextWeek ${ctx.played.nextWeek}, seedBlocked = ${ctx.played.seedBlocked ?? "null"}`);
console.log(`seed source: ${ctx.played.source.join("; ") || "(none)"}`);
if (!played) { console.log("NOT SEEDED -- nothing to control."); process.exit(1); }

// Yahoo's own numbers, one fetch per settled week.
const yPts = new Map(), yWin = new Map();
for (let w = 1; w <= ctx.played.weeks; w++) {
  for (const g of await lg.weekScores(w)) {
    yPts.set(g.homeId, (yPts.get(g.homeId) ?? 0) + (g.homePts ?? 0));
    yPts.set(g.awayId, (yPts.get(g.awayId) ?? 0) + (g.awayPts ?? 0));
    const homeWon = (g.homePts ?? 0) >= (g.awayPts ?? 0);
    yWin.set(g.homeId, (yWin.get(g.homeId) ?? 0) + (homeWon ? 1 : 0));
    yWin.set(g.awayId, (yWin.get(g.awayId) ?? 0) + (homeWon ? 0 : 1));
  }
}

console.log("\nteam | name                      | seed W | yahoo W | seed PF  | yahoo PF | OK");
let bad = 0;
for (let k = 0; k < ctx.teams.length; k++) {
  const t = ctx.teams[k];
  const sw = played.wins[k], sp = Math.round(played.pts[k] * 100) / 100;
  const yw = yWin.get(t.id) ?? -1, yp = Math.round((yPts.get(t.id) ?? -1) * 100) / 100;
  const ok = sw === yw && Math.abs(sp - yp) < 0.005;
  if (!ok) bad++;
  console.log(`${String(t.id).padStart(4)} | ${String(t.name).padEnd(25)} | ${String(sw).padStart(6)} | ${String(yw).padStart(7)} | ${sp.toFixed(2).padStart(8)} | ${yp.toFixed(2).padStart(8)} | ${ok ? "ok" : "MISMATCH"}`);
}
console.log(`\n${ctx.teams.length - bad}/${ctx.teams.length} teams match Yahoo's own published results.`);
process.exit(bad ? 1 : 0);
