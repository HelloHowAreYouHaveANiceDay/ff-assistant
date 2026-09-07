// Is our fantasy schedule balanced -- correct in-division vs out-of-division counts, and does
// anyone draw an unfair set of opponents?
//
//   node --import tsx scripts/league-schedule.mjs
//
// Two different fairness questions, and they have different answers:
//   STRUCTURAL  does every team play the same number of division games, and is the out-of-division
//               set balanced (nobody plays a rival twice while skipping another team entirely)?
//   COMPETITIVE weighting each opponent by our projection of their roster -- structural balance
//               does not stop one team drawing the strong half of the league.
import { openLeague } from "../src/league/index.ts";

const lg = await openLeague();
if (!lg.provider.matchups) {
  console.log(`the ${lg.provider.platform} adaptor does not expose the schedule.`);
  await lg.close(); process.exit(1);
}
const { divisions, games } = await lg.provider.matchups();
const reg = games.filter((g) => g.week <= lg.regWeeks);

const nameOf = new Map(lg.teams.map((t) => [t.id, t.name]));
const divOf = new Map();
for (const d of divisions) for (const id of d.teamIds) divOf.set(id, d);

console.log(`LEAGUE SCHEDULE -- ${lg.season}, ${lg.teams.length} teams, ${lg.regWeeks}-week regular season`);
console.log(`${reg.length} regular-season games (${games.length} total incl. playoff brackets)\n`);
console.log(`DIVISIONS`);
for (const d of divisions) {
  console.log(`  ${d.name} (${d.teamIds.length})`);
  for (const id of d.teamIds) console.log(`    ${nameOf.get(id) ?? id}${id === lg.me.id ? "   <<< US" : ""}`);
}

// --- opponent counts per team -------------------------------------------------------------------
const opps = new Map(lg.teams.map((t) => [t.id, new Map()]));
for (const g of reg) {
  opps.get(g.homeId)?.set(g.awayId, (opps.get(g.homeId)?.get(g.awayId) ?? 0) + 1);
  opps.get(g.awayId)?.set(g.homeId, (opps.get(g.awayId)?.get(g.homeId) ?? 0) + 1);
}

console.log(`\nSTRUCTURAL BALANCE`);
console.log("  team                          games  in-div  out-div  twice  once  never");
const rows = [];
for (const t of lg.teams) {
  const m = opps.get(t.id) ?? new Map();
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  let inDiv = 0;
  for (const [oid, n] of m) if (divOf.get(oid)?.id === divOf.get(t.id)?.id) inDiv += n;
  const twice = [...m.values()].filter((n) => n >= 2).length;
  const once = [...m.values()].filter((n) => n === 1).length;
  const never = lg.teams.length - 1 - m.size;
  rows.push({ t, total, inDiv, outDiv: total - inDiv, twice, once, never });
}
for (const r of rows) {
  console.log(`  ${r.t.name.slice(0, 28).padEnd(29)} ${String(r.total).padStart(4)} ${String(r.inDiv).padStart(7)} ${String(r.outDiv).padStart(8)} ${String(r.twice).padStart(6)} ${String(r.once).padStart(5)} ${String(r.never).padStart(6)}${r.t.id === lg.me.id ? "  <<< US" : ""}`);
}

// --- the verdict, stated as a check that can FAIL ------------------------------------------------
const bad = [];
const totals = new Set(rows.map((r) => r.total));
if (totals.size > 1) bad.push(`teams play different numbers of games: ${[...totals].join(", ")}`);
const inDivs = new Set(rows.map((r) => r.inDiv));
if (inDivs.size > 1) bad.push(`in-division counts differ: ${rows.map((r) => `${r.t.name.split(" ")[0]}=${r.inDiv}`).join(", ")}`);
const twices = new Set(rows.map((r) => r.twice));
if (twices.size > 1) bad.push(`teams face a different number of opponents twice: ${[...twices].sort().join(", ")}`);

console.log(`\n  ${bad.length ? "IMBALANCED" : "BALANCED"} -- ${bad.length ? bad.join("; ") : "every team plays the same number of games, the same number in division, and the same repeat pattern"}`);

// --- competitive strength of schedule ------------------------------------------------------------
// Structural balance says nothing about WHO you drew. Weight each opponent by our projection of
// their optimal starting lineup -- the same measure power-rankings uses.
const strength = new Map(lg.teams.map((t) => [t.id, lg.score(t.roster)]));
const mean = [...strength.values()].reduce((a, b) => a + b, 0) / strength.size;
const sos = rows.map((r) => {
  const m = opps.get(r.t.id) ?? new Map();
  let sum = 0, n = 0;
  for (const [oid, cnt] of m) { sum += (strength.get(oid) ?? mean) * cnt; n += cnt; }
  return { ...r, avgOpp: n ? sum / n : mean };
}).sort((a, z) => a.avgOpp - z.avgOpp);

console.log(`\nCOMPETITIVE SOS -- average opponent, by our projection of their lineup (league mean ${mean.toFixed(0)})`);
console.log("  rk  team                          avg opp   vs mean");
sos.forEach((r, i) => {
  const d = r.avgOpp - mean;
  console.log(`  ${String(i + 1).padStart(2)}  ${r.t.name.slice(0, 28).padEnd(29)} ${r.avgOpp.toFixed(0).padStart(7)}   ${(d >= 0 ? "+" : "") + d.toFixed(0)}${r.t.id === lg.me.id ? "   <<< US" : ""}`);
});
console.log(`\nrank 1 = easiest slate. Opponent strength is OUR projection of their roster today, so it`);
console.log(`moves with injuries and waiver activity -- read it as the draw we got, not a forecast.`);
await lg.close();
