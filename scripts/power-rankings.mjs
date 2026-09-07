// Post-draft POWER RANKINGS for the real league.
//
// Pulls the completed draft through the league adaptor, maps every team's roster onto OUR
// projections, and scores each with the REAL lineup optimizer -- the same one the backtest uses --
// so the ranking is "best starting lineup by our board", not vibes.
//
// Honest framing, stated up front because it bounds everything below: this ranks teams by OUR
// projection. It is the same view that drove our bidding, so it is not an independent judge of our
// own draft -- if our board is wrong about a player, this is wrong the same way. Treat the spread
// between teams as more meaningful than any single team's absolute number.
//
//   node --import tsx scripts/power-rankings.mjs
import { readFileSync } from "node:fs";
import { openLeague, nameKey } from "../src/league/index.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";

const lg = await openLeague();
if (!lg.provider.draftPicks) {
  console.log(`the ${lg.provider.platform} adaptor does not expose draft results -- power rankings need them.`);
  await lg.close(); process.exit(1);
}

const ourVal = new Map();
for (const f of readFileSync("data/values.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")))
  ourVal.set(nameKey(f[0]), Number(f[2]));

const picks = await lg.provider.draftPicks();
const teamName = new Map(lg.teams.map((t) => [t.id, t.name]));

const byTeam = new Map();
for (const p of picks) {
  const k = nameKey(p.name);
  if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
  byTeam.get(p.teamId).push({ name: p.name, pos: p.pos !== "?" ? p.pos : (lg.posOf(p.name) ?? "?"),
    price: p.price || 1, proj: lg.proj(p.name), val: ourVal.get(k) ?? 0 });
}

const rows = [];
for (const [teamId, roster] of byTeam) {
  const starters = optimalLineup(roster.map((r) => ({ ...r, available: true })), lg.slots).starters;
  rows.push({
    teamId, name: teamName.get(teamId) ?? `Team ${teamId}`, roster,
    startPts: starters.reduce((a, s) => a + (roster.find((r) => r.name === s.name)?.proj ?? 0), 0),
    spend: roster.reduce((a, r) => a + r.price, 0),
    surplus: roster.reduce((a, r) => a + (r.val - r.price), 0),
    byPos: roster.reduce((c, r) => ({ ...c, [r.pos]: (c[r.pos] || 0) + 1 }), {}),
    top: [...roster].sort((a, b) => b.price - a.price).slice(0, 3),
  });
}
rows.sort((a, b) => b.startPts - a.startPts);

const us = lg.me.id;
console.log(`POWER RANKINGS -- ${lg.season}, ${rows.length} teams, ${picks.length} picks`);
console.log(`Scored with the real lineup optimizer on OUR projections (data/points.csv).\n`);
console.log("  #  team                        startPts  spend  surplus  QB RB WR TE  top buys");
rows.forEach((r, i) => {
  const p = r.byPos;
  console.log(`  ${String(i + 1).padStart(2)} ${r.name.slice(0, 26).padEnd(26)} ${r.startPts.toFixed(0).padStart(7)} ${("$" + r.spend).padStart(6)} ${(r.surplus >= 0 ? "+" : "") + r.surplus}`.padEnd(72) +
    `${String(p.QB || 0)} ${String(p.RB || 0).padStart(2)} ${String(p.WR || 0).padStart(2)} ${String(p.TE || 0).padStart(2)}  ` +
    r.top.map((t) => `${t.name.split(" ").slice(-1)[0]} $${t.price}`).join(", ") + (r.teamId === us ? " <<< US" : ""));
});

const ourRow = rows.find((r) => r.teamId === us);
if (ourRow) {
  const rank = rows.indexOf(ourRow) + 1;
  const mean = rows.reduce((a, r) => a + r.startPts, 0) / rows.length;
  console.log(`\nOUR TEAM: #${rank} of ${rows.length}  --  ${ourRow.startPts.toFixed(0)} projected starter pts (league mean ${mean.toFixed(0)}), spent $${ourRow.spend}, surplus ${ourRow.surplus >= 0 ? "+" : ""}${ourRow.surplus} vs our own book`);
  console.log(`  roster:`);
  for (const p of [...ourRow.roster].sort((a, b) => b.price - a.price)) {
    console.log(`    ${p.pos.padEnd(4)} ${p.name.slice(0, 24).padEnd(25)} $${String(p.price).padStart(3)}  our val $${String(p.val).padStart(3)}  proj ${p.proj.toFixed(0)}`);
  }
}
console.log(`\nCAVEAT: ranked by OUR projection -- the same board we bid from, so this is not an`);
console.log(`independent grade of our own draft. Read the SPREAD between teams, not the absolutes.`);
await lg.close();
