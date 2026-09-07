// Find trades where BOTH teams' optimal starting lineups improve, across the whole league.
//
//   node --import tsx scripts/trade-finder.mjs
//
// The mechanism that makes such a trade possible is positional SURPLUS meeting positional NEED: a
// team starting 3 of its 6 WRs gains nothing from the 4th, so trading him for a scarce RB adds
// points on both sides. Nobody has to be fleeced.
//
// HONEST LIMIT, and it bounds every number below: both sides are scored on OUR projections. The
// other manager values his roster on his own board, so a trade this ranks as mutual may look bad to
// him -- and one he offers may be better than this thinks. Use it to find STRUCTURALLY sane targets
// (who is deep where we are thin), never to predict whether he says yes.
import { openLeague } from "../src/league/index.ts";

const lg = await openLeague();
const tradeable = (p) => p.pos !== "K" && p.pos !== "DST";
const myBase = lg.score(lg.me.roster);
const swap = (roster, out, inn) => roster.filter((p) => p.name !== out.name).concat([inn]);

const shape = (r) => Object.entries(r.reduce((c, p) => ({ ...c, [p.pos]: (c[p.pos] || 0) + 1 }), {}))
  .map(([k, v]) => k + v).join(" ");
console.log(`TRADE FINDER -- ${lg.season}, ${lg.teams.length} teams`);
console.log(`our lineup now: ${myBase.toFixed(0)} pts   shape: ${shape(lg.me.roster)}\n`);

// --- 1-for-1 ------------------------------------------------------------------------------------
const finds = [];
for (const opp of lg.teams.filter((t) => !t.mine)) {
  const oppBase = lg.score(opp.roster);
  for (const give of lg.me.roster.filter(tradeable)) {
    for (const get of opp.roster.filter(tradeable)) {
      const mine = lg.score(swap(lg.me.roster, give, get)) - myBase;
      const theirs = lg.score(swap(opp.roster, get, give)) - oppBase;
      if (mine > 0 && theirs > 0) finds.push({ opp: opp.name, give, get, mine, theirs });
    }
  }
}
finds.sort((a, z) => z.mine - a.mine || (z.mine + z.theirs) - (a.mine + a.theirs));
if (!finds.length) {
  console.log("No 1-for-1 swap improves BOTH sides on our board.");
  console.log("That usually means our starters already fit our slots -- the gain would have to come");
  console.log("from a 2-for-1 (consolidating depth) or a manager who values a position differently.");
} else {
  console.log("  we gain  they gain  counterparty              we give                  we get");
  for (const f of finds.slice(0, 15)) {
    console.log(`  ${("+" + f.mine.toFixed(0)).padStart(7)} ${("+" + f.theirs.toFixed(0)).padStart(9)}  ${f.opp.slice(0, 24).padEnd(25)} ${(f.give.name + " (" + f.give.pos + ")").slice(0, 23).padEnd(24)} ${(f.get.name + " (" + f.get.pos + ")").slice(0, 23)}`);
  }
}

// --- 2-for-1: the only realistic route to a scarce position --------------------------------------
// A 1-for-1 rarely pries a running back loose -- RBs are scarce, so giving one up costs the other
// side more than any single WR of ours returns. Consolidating TWO surplus pass-catchers into one RB
// can clear that bar: they fill two lineup holes, we fill the one that matters.
const two = [];
for (const opp of lg.teams.filter((t) => !t.mine)) {
  const oppBase = lg.score(opp.roster);
  const spare = lg.me.roster.filter((p) => ["WR", "TE"].includes(p.pos));
  for (let i = 0; i < spare.length; i++) for (let k = i + 1; k < spare.length; k++) {
    const g1 = spare[i], g2 = spare[k];
    for (const get of opp.roster.filter((p) => p.pos === "RB")) {
      const mine = lg.score(lg.me.roster.filter((p) => p.name !== g1.name && p.name !== g2.name).concat([get])) - myBase;
      const theirs = lg.score(opp.roster.filter((p) => p.name !== get.name).concat([g1, g2])) - oppBase;
      if (mine > 0 && theirs > 0) two.push({ opp: opp.name, g1, g2, get, mine, theirs });
    }
  }
}
two.sort((a, z) => z.mine - a.mine);
console.log(`\n=== 2-for-1: two of our pass-catchers for one RB ===`);
if (!two.length) console.log("  none clear the bar on our board -- an RB costs more than two of our spare WRs.");
else {
  console.log("  we gain  they gain  counterparty          we give                             we get");
  for (const t of two.slice(0, 12)) {
    console.log(`  ${("+" + t.mine.toFixed(0)).padStart(7)} ${("+" + t.theirs.toFixed(0)).padStart(9)}  ${t.opp.slice(0, 20).padEnd(21)} ${(t.g1.name + " + " + t.g2.name).slice(0, 34).padEnd(35)} ${t.get.name}`);
  }
}
console.log(`\nBoth sides scored on OUR projections -- see the header caveat.`);
await lg.close();
