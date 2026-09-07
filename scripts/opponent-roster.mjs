// Any team's full roster with OUR valuation beside each player -- what a counterparty is deep in
// and what they would miss. A trade pitch needs their shape, not just ours.
//
//   node --import tsx scripts/opponent-roster.mjs "Jevon"    # match on team name, case-insensitive
//   node --import tsx scripts/opponent-roster.mjs --me
import { openLeague, nameKey } from "../src/league/index.ts";

const argv = process.argv.slice(2);
const wantMine = argv.includes("--me");
const match = argv.filter((a) => !a.startsWith("--"))[0] ?? "";
if (!wantMine && !match) { console.log('usage: node --import tsx scripts/opponent-roster.mjs "<team>" | --me'); process.exit(1); }

const lg = await openLeague();
const t = wantMine ? lg.me : lg.teams.find((x) => x.name.toLowerCase().includes(match.toLowerCase()));
if (!t) {
  console.log("no team matched. teams:\n  " + lg.teams.map((x) => x.name).join("\n  "));
  await lg.close(); process.exit(0);
}

// Auction value and positional rank are ours, from the value book -- not anything the platform says.
const val = new Map();
for (const r of lg.db.prepare(
  `SELECT p.name, pv.our_value, pv.pos_rank, re.overall_rank ecr
     FROM player_value pv JOIN player p USING(player_id)
     LEFT JOIN ranking re ON re.player_id = pv.player_id AND re.source='fantasypros_ecr' AND re.season = pv.season`,
).all()) val.set(nameKey(r.name), r);

const byPos = t.roster.reduce((c, p) => ({ ...c, [p.pos]: (c[p.pos] || 0) + 1 }), {});
console.log(`${t.name}${t.mine ? "  (us)" : ""} -- ${t.roster.length} players   shape ${Object.entries(byPos).map(([k, v]) => k + v).join(" ")}`);
console.log(`optimal starting lineup on our board: ${lg.score(t.roster).toFixed(0)} pts\n`);
console.log("  pos  player                     proj  ourVal  posRank  ECR");
for (const p of [...t.roster].sort((a, z) => z.proj - a.proj)) {
  const v = val.get(nameKey(p.name)) ?? {};
  console.log(`  ${p.pos.padEnd(4)} ${p.name.slice(0, 24).padEnd(25)} ${String(Math.round(p.proj)).padStart(4)}  ${("$" + (v.our_value ?? 0)).padStart(6)}  ${String(v.pos_rank ?? "").padEnd(7)} ${v.ecr ? Math.round(v.ecr) : "?"}`);
}
await lg.close();
