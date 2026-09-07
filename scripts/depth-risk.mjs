// What does losing ONE player actually cost us, and who on the market or on another roster insures
// him? (Was rb-risk.mjs, which hardcoded Breece Hall via /hall/i -- a substring regex that also
// matches "Brandon Marshall".)
//
//   node --import tsx scripts/depth-risk.mjs "Breece Hall"
//   node --import tsx scripts/depth-risk.mjs "Breece Hall" --vs "Jalen Hurts" "Brock Purdy"
//
// WHY THIS EXISTS. A trade finder ranks by marginal season points assuming everyone plays every
// week. That is structurally blind to CONCENTRATION: it cannot see that a slot has exactly one
// eligible body, so it prices a backup at only what he adds to a HEALTHY lineup -- which is often
// zero. This asks the two questions the optimizer cannot:
//   1. what does a replacement add in expected points (the fair comparison to any other trade)?
//   2. what do we lose in the weeks the named player is NOT available?
import { openLeague, resolvePlayer } from "../src/league/index.ts";

const argv = process.argv.slice(2);
const vsAt = argv.indexOf("--vs");
const target = (vsAt === -1 ? argv : argv.slice(0, vsAt))[0];
const compare = vsAt === -1 ? [] : argv.slice(vsAt + 1);
if (!target) { console.log('usage: node --import tsx scripts/depth-risk.mjs "<player>" [--vs "<player>" ...]'); process.exit(1); }

const lg = await openLeague();
// Throws with the candidates named if the query is ambiguous -- never silently benches the wrong man.
const at = resolvePlayer(lg.me.roster, target);
const WEEKS = lg.nflWeeks;

const base = lg.score(lg.me.roster);
const without = lg.me.roster.filter((p) => p.name !== at.name);
const baseOut = lg.score(without);

console.log(`DEPTH RISK -- ${at.name} (${at.pos}, ${Math.round(at.proj)} proj)\n`);
console.log(`  lineup with him      ${base.toFixed(0)} pts  (${(base / WEEKS).toFixed(1)}/wk)`);
console.log(`  lineup without him   ${baseOut.toFixed(0)} pts  (${(baseOut / WEEKS).toFixed(1)}/wk)`);
console.log(`  cost of losing him   ${((baseOut - base) / WEEKS).toFixed(1)}/wk\n`);

// --- who insures him: everyone on another roster at his position ------------------------------
const pool = lg.teams.filter((t) => !t.mine)
  .flatMap((t) => t.roster.filter((p) => p.pos === at.pos).map((p) => ({ ...p, from: t.name })))
  .sort((a, z) => z.proj - a.proj).slice(0, 8);

console.log(`1. EXPECTED-POINTS gain -- what each adds to a HEALTHY lineup (the trade-finder metric)`);
for (const r of pool) {
  const gain = lg.score([...lg.me.roster, r]) - base;
  console.log(`   ${r.pos} ${r.name.slice(0, 22).padEnd(23)} proj ${String(Math.round(r.proj)).padStart(4)}  +${gain.toFixed(0).padStart(3)} pts   (${r.from.slice(0, 20)})`);
}
for (const name of compare) {
  const p = { name, pos: lg.posOf(name) ?? "?", proj: lg.proj(name) };
  console.log(`   ${p.pos} ${name.slice(0, 22).padEnd(23)} proj ${String(Math.round(p.proj)).padStart(4)}  +${(lg.score([...lg.me.roster, p]) - base).toFixed(0).padStart(3)} pts   <-- comparison`);
}

console.log(`\n2. INSURANCE -- what each recovers in a week ${at.name} is OUT`);
for (const r of pool.slice(0, 5)) {
  const recovered = lg.score([...without, r]) - baseOut;
  console.log(`   ${r.name.slice(0, 22).padEnd(23)} recovers ${(recovered / WEEKS).toFixed(1)}/wk  (${recovered.toFixed(0)} over a full season out)`);
}

console.log(`\n3. THE TRADE-OFF, by how long he is out`);
const best = pool[0];
if (best) {
  const perWk = (lg.score([...without, best]) - baseOut) / WEEKS;
  const lossWk = (base - baseOut) / WEEKS;
  for (const weeks of [1, 4, 8]) {
    console.log(`   out ${String(weeks).padStart(2)} week(s): costs ${(lossWk * weeks).toFixed(0).padStart(3)} pts, ${best.name.split(" ").pop()} recovers ${(perWk * weeks).toFixed(0).padStart(3)}`);
  }
}
console.log(`\nA replacement's EXPECTED gain is certain and season-long; its INSURANCE value pays only in`);
console.log(`the weeks he is actually out. Weigh section 3 against how likely you think those are.`);
await lg.close();
