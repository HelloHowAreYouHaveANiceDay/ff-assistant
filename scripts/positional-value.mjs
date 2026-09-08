// WHAT IS A FREE PLAYER WORTH, BY POSITION? The diagnostic behind "no good RB trades".
//
//   node --import tsx scripts/positional-value.mjs [trials]
//
// The trade sweep keeps returning QB deals and almost no running backs, and "nobody will sell an RB"
// is a convenient explanation that happens to also be what a broken model would produce. The two are
// distinguishable: a trade result mixes what we GAIN with what it COSTS us and what it costs the
// partner, so a low score can come from any of the three. Giving a player away FREE -- no drop, no
// counterparty -- isolates the first.
//
// MATCHED ON PROJECTION, not on rank. RB rank-20 outprojects WR rank-20, so a rank-matched comparison
// partly measures points -- the one thing a positional question has to hold constant.
import { loadSimContext } from "../src/draft/simContext.ts";

const TRIALS = Number(process.argv[2] ?? 3000);
const SEEDS = [7, 101, 202, 303];
const ctx = await loadSimContext();
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const title = (teams, seed) => 100 * ctx.run(teams, TRIALS, seed)[ctx.meIdx].champion;

const baseBySeed = SEEDS.map((s) => title(ctx.teams, s));
const us = ctx.teams[ctx.meIdx].roster;
const shape = {};
for (const p of us) shape[p.pos] = (shape[p.pos] ?? 0) + 1;
console.log(`OUR ROSTER: ${Object.entries(shape).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`SCHEDULE: ${ctx.syntheticSchedule ? "GENERATED (app unreachable) -- absolute odds not comparable to a live run" : "real"}`);
console.log(`BASE: ${mean(baseBySeed).toFixed(2)}% title\n`);
console.log("Adding one FREE player of each position+calibre. No drop, no counterparty -- pure");
console.log("positional marginal value, with the trade cost stripped out.\n");
console.log("  add               proj   title after    delta    +/-SE");

const nearest = (pool, target) => pool.reduce((best, p) => Math.abs(p.proj - target) < Math.abs(best.proj - target) ? p : best, pool[0]);
for (const pos of ["RB", "WR", "TE", "QB"]) {
  const pool = [...ctx.board.values()].filter((p) => p.pos === pos).sort((a, b) => b.proj - a.proj);
  for (const [label, target] of [["~240 pts", 240], ["~190 pts", 190], ["~140 pts", 140]]) {
    const p = nearest(pool, target);
    if (!p) continue;
    // Flag a band the position cannot actually fill: no tight end projects near 240, so that row
    // silently compares a 272-point player against a 235-point one and is not a matched comparison
    // at all. Printed rather than dropped, because the number is still interesting -- just not
    // comparable to the row beside it.
    const off = Math.abs(p.proj - target) > 25 ? " *" : "";
    const ds = SEEDS.map((s, i) => {
      const teams = ctx.clone();
      teams[ctx.meIdx].roster = teams[ctx.meIdx].roster.concat([{ ...p }]);
      return title(teams, s) - baseBySeed[i];
    });
    console.log(`  ${(pos + " " + label + off).padEnd(20)} ${p.proj.toFixed(0).padStart(4)}  ` +
      `${(mean(baseBySeed) + mean(ds)).toFixed(2)}%`.padStart(11) + `  ${(mean(ds) >= 0 ? "+" : "") + mean(ds).toFixed(2)}pp`.padStart(9) +
      `  +/-${(sd(ds) / Math.sqrt(SEEDS.length)).toFixed(2)}`);
  }
}
console.log(`
  * = no player of that position projects near the target, so the row is NOT matched and its delta
      is not comparable to the rows beside it.

  We roster ONE running back and the RB slot is mandatory, so if the simulator sees the hole at all,
  RB must lead its matched band. If it does not, the trade conclusions in this repo rest on a model
  that cannot see the thing it was asked about.`);
