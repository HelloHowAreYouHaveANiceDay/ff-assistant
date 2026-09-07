// Every trade worth proposing to ONE named counterparty: 1-for-1, 2-for-1 both directions, and a
// "what if we acquire X first" scenario -- because an asset we cannot spare today can become
// surplus after another trade, and a one-shot search never sees that.
//
//   node --import tsx scripts/trade-with.mjs "elevator"
//   node --import tsx scripts/trade-with.mjs "elevator" --assume "Jalen Hurts"
import { openLeague } from "../src/league/index.ts";

const argv = process.argv.slice(2);
const assumeAt = argv.indexOf("--assume");
const match = (assumeAt === -1 ? argv : argv.slice(0, assumeAt))[0];
const assume = assumeAt === -1 ? null : argv[assumeAt + 1];
if (!match) { console.log('usage: node --import tsx scripts/trade-with.mjs "<team>" [--assume "<player>"]'); process.exit(1); }

const lg = await openLeague();
const opp = lg.teams.find((t) => !t.mine && t.name.toLowerCase().includes(match.toLowerCase()));
if (!opp) {
  console.log("no match. teams:\n  " + lg.teams.filter((t) => !t.mine).map((t) => t.name).join("\n  "));
  await lg.close(); process.exit(0);
}

let myRoster = lg.me.roster;
if (assume) {
  const p = { name: assume, pos: lg.posOf(assume) ?? "?", proj: lg.proj(assume) };
  if (!p.proj) { console.log(`no projection for "${assume}" -- check the spelling.`); await lg.close(); process.exit(1); }
  myRoster = [...myRoster, p];
  console.log(`SCENARIO: assuming we have already acquired ${assume} (${p.pos}, ${Math.round(p.proj)} proj)\n`);
}

const tradeable = (p) => p.pos !== "K" && p.pos !== "DST";
const myBase = lg.score(myRoster), oppBase = lg.score(opp.roster);
const shape = (r) => Object.entries(r.reduce((c, p) => ({ ...c, [p.pos]: (c[p.pos] || 0) + 1 }), {})).map(([k, v]) => k + v).join(" ");
console.log(`US   ${myBase.toFixed(0)} pts   ${shape(myRoster)}`);
console.log(`THEM ${oppBase.toFixed(0)} pts   ${shape(opp.roster)}   (${opp.name})\n`);

const out = [];
const mineT = myRoster.filter(tradeable), oppT = opp.roster.filter(tradeable);
const without = (r, ...names) => r.filter((p) => !names.includes(p.name));

for (const give of mineT) for (const get of oppT) {
  const mine = lg.score(without(myRoster, give.name).concat([get])) - myBase;
  const theirs = lg.score(without(opp.roster, get.name).concat([give])) - oppBase;
  if (mine > 0 && theirs > 0) out.push({ kind: "1-1", give: give.name, get: get.name, mine, theirs });
}
for (let i = 0; i < mineT.length; i++) for (let k = i + 1; k < mineT.length; k++) for (const get of oppT) {
  const g1 = mineT[i], g2 = mineT[k];
  const mine = lg.score(without(myRoster, g1.name, g2.name).concat([get])) - myBase;
  const theirs = lg.score(without(opp.roster, get.name).concat([g1, g2])) - oppBase;
  if (mine > 0 && theirs > 0) out.push({ kind: "2-1", give: `${g1.name} + ${g2.name}`, get: get.name, mine, theirs });
}
for (const give of mineT) for (let i = 0; i < oppT.length; i++) for (let k = i + 1; k < oppT.length; k++) {
  const t1 = oppT[i], t2 = oppT[k];
  const mine = lg.score(without(myRoster, give.name).concat([t1, t2])) - myBase;
  const theirs = lg.score(without(opp.roster, t1.name, t2.name).concat([give])) - oppBase;
  if (mine > 0 && theirs > 0) out.push({ kind: "1-2", give: give.name, get: `${t1.name} + ${t2.name}`, mine, theirs });
}

out.sort((a, z) => z.mine - a.mine || z.theirs - a.theirs);
if (!out.length) console.log("No trade with this team improves BOTH sides on our board.");
else {
  console.log("  type  we gain  they gain  we give                              we get");
  const seen = new Set();
  for (const t of out) {
    const key = t.kind + t.get + t.mine.toFixed(0);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${t.kind}  ${("+" + t.mine.toFixed(0)).padStart(7)} ${("+" + t.theirs.toFixed(0)).padStart(10)}  ${t.give.slice(0, 35).padEnd(36)} ${t.get}`);
    if (seen.size >= 14) break;
  }
}
console.log(`\nBoth sides scored on OUR projections.`);
await lg.close();
