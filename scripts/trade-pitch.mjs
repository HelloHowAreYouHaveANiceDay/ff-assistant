// Both sides of a trade conversation with ONE counterparty. (Replaces ask-for.mjs + offer-for.mjs,
// which were the same script pointed in opposite directions and both hardcoded Breece Hall.)
//
//   node --import tsx scripts/trade-pitch.mjs "elevator"
//   node --import tsx scripts/trade-pitch.mjs "elevator" --cover "Breece Hall"
//
// Drops the "both sides gain" constraint that trade-finder enforces: when a manager is known to be
// motivated, the useful question is what to ASK for and what we can bear to GIVE. Their side of the
// value is theirs to judge on their own board.
//
// Three numbers, because they answer different questions:
//   lineup +   marginal points added to our optimal starting lineup -- a season-long upgrade
//   cover  +   points recovered in a week the --cover player is OUT -- insurance a season total cannot see
//   their +    what it does to THEIR lineup, ON OUR BOARD -- an estimate of their interest, not their valuation
import { openLeague, resolvePlayer } from "../src/league/index.ts";

const argv = process.argv.slice(2);
const coverAt = argv.indexOf("--cover");
const match = (coverAt === -1 ? argv : argv.slice(0, coverAt))[0];
const coverName = coverAt === -1 ? null : argv[coverAt + 1];
if (!match) { console.log('usage: node --import tsx scripts/trade-pitch.mjs "<team>" [--cover "<player>"]'); process.exit(1); }

const lg = await openLeague();
const opp = lg.teams.find((t) => !t.mine && t.name.toLowerCase().includes(match.toLowerCase()));
if (!opp) {
  console.log("no team matched. teams:\n  " + lg.teams.filter((t) => !t.mine).map((t) => t.name).join("\n  "));
  await lg.close(); process.exit(0);
}

const tradeable = (p) => p.pos !== "K" && p.pos !== "DST";
const myBase = lg.score(lg.me.roster);
const oppBase = lg.score(opp.roster);

// insurance baseline: our lineup with the named player removed
let cover = null;
if (coverName) {
  const at = resolvePlayer(lg.me.roster, coverName);   // throws on ambiguity, never guesses
  const without = lg.me.roster.filter((p) => p.name !== at.name);
  cover = { at, without, base: lg.score(without) };
}

const shape = (r) => Object.entries(r.reduce((c, p) => ({ ...c, [p.pos]: (c[p.pos] || 0) + 1 }), {}))
  .map(([k, v]) => k + v).join(" ");
console.log(`US   ${myBase.toFixed(0)} pts   ${shape(lg.me.roster)}`);
console.log(`THEM ${oppBase.toFixed(0)} pts   ${shape(opp.roster)}   (${opp.name})`);
if (cover) console.log(`without ${cover.at.name}: ${cover.base.toFixed(0)} pts  (${(cover.base - myBase).toFixed(0)})`);

// --- what to ASK for ---------------------------------------------------------------------------
console.log(`\n=== WHAT TO ASK FOR -- their players, valued on our roster ===`);
console.log("  pos  player                     proj  lineup +" + (cover ? "   cover +" : "") + "   note");
const asks = opp.roster.filter(tradeable).map((p) => ({
  ...p,
  lineup: lg.score([...lg.me.roster, p]) - myBase,
  cover: cover ? lg.score([...cover.without, p]) - cover.base : 0,
})).sort((a, z) => z.lineup - a.lineup || z.cover - a.cover);
for (const r of asks) {
  const note = r.lineup > 20 ? "real upgrade" : r.cover > 8 ? "injury cover only" : r.lineup > 0 ? "marginal" : "no use to us";
  console.log(`  ${r.pos.padEnd(4)} ${r.name.slice(0, 24).padEnd(25)} ${String(Math.round(r.proj)).padStart(4)}  ${("+" + r.lineup.toFixed(0)).padStart(8)}` +
    (cover ? `  ${("+" + r.cover.toFixed(0)).padStart(8)}` : "") + `   ${note}`);
}

// --- what we can bear to GIVE -------------------------------------------------------------------
console.log(`\n=== WHAT WE CAN GIVE -- our cost, and what it does for them ===`);
console.log("  pos  player                    our cost   their gain");
const gives = lg.me.roster.filter(tradeable).map((p) => ({
  ...p,
  cost: myBase - lg.score(lg.me.roster.filter((x) => x.name !== p.name)),
  gain: lg.score([...opp.roster, p]) - oppBase,
})).sort((a, z) => a.cost - z.cost || z.gain - a.gain);
for (const r of gives) {
  console.log(`  ${r.pos.padEnd(4)} ${r.name.slice(0, 24).padEnd(25)} ${r.cost.toFixed(0).padStart(8)}   ${("+" + r.gain.toFixed(0)).padStart(10)}`);
}

const free = gives.filter((g) => g.cost === 0);
const wanted = free.filter((g) => g.gain > 0).sort((a, z) => z.gain - a.gain);
console.log(`\nFREE CHIPS (cost us nothing): ${free.length ? free.map((f) => f.name).join(", ") : "none"}`);
if (wanted.length) console.log(`...of which they actually want: ${wanted.map((f) => `${f.name} (+${f.gain.toFixed(0)})`).join(", ")}`);
else console.log(`...none of which improves their lineup on our board -- any pitch has to be sold on THEIR`);
if (!wanted.length) console.log(`   board (name value, depth behind a starter), not on measured lineup gain.`);
console.log(`\n"their gain" is scored on OUR projections. It estimates their interest; it is not their valuation.`);
await lg.close();
