// WHAT DOES EACH BIDDER ACTUALLY BUY? A face-validity check on V2 against V3, before any
// championship number is quoted for either.
//
//   node --import tsx scripts/v3-roster.mjs [--seeds 5] [--book price|rank|vor]
//
// A championship rate is a summary of a roster, and a summary is exactly where a broken bidder hides:
// 0% titles is what you get from a strategy that never wins an auction AND from one that wins the
// wrong ones, and the two need completely different fixes. So this prints the roster.
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const SEEDS = Number(val("--seeds", "5"));
const BOOK = val("--book", "price");

const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
// `--season Y` drafts on season Y's ACTUALS, which is what the backtest hands the bidder as its
// no-lookahead projection for Y+1. That makes the positional shares below shares of the same drafts
// the arbiter scores, rather than of a 2026 board nobody in the backtest has ever seen. Averaged
// over `--seasons-from..--season` when both are given.
const SEASON = val("--season", null);
const points = SEASON
  ? readCsv("data/history-points.csv").filter((f) => Number(f[0]) === Number(SEASON))
    .map((f) => ({ name: f[1].trim(), pos: f[2].trim().toUpperCase(), points: Number(f[3]) }))
    .filter((p) => p.name && p.points)
  : readCsv("data/points.csv")
    .map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) }))
    .filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const cfg = { values: Object.fromEntries(ourValues), starterReserve: 4, benchReserve: 1, premium: 2, aggr: 0.7, maxShare: 0.25, maxKDst: 2, benchDiscount: 0.25, inflation: true };
const projOf = new Map(points.map((p) => [p.name, p.points]));

for (const strategy of ["v2", "v3"]) {
  let spend = 0, startPts = 0, n = 0;
  const posSpend = {};
  for (let s = 1; s <= SEEDS; s++) {
    const { picks } = draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE, { botBook: BOOK, botIdioSd: 0.2, strategy });
    const mine = picks.filter((p) => p.team === 0);
    spend += mine.reduce((a, b) => a + b.price, 0);
    for (const p of mine) posSpend[p.pos] = (posSpend[p.pos] ?? 0) + p.price;
    // Best legal starting lineup on the projection -- a crude but honest roster-quality number.
    const by = {};
    for (const p of mine) (by[p.pos] ??= []).push(projOf.get(p.name) ?? 0);
    for (const k of Object.keys(by)) by[k].sort((a, b) => b - a);
    const used = {};
    let pts = 0;
    for (const slot of SIM_LEAGUE.slots) {
      if (slot === "BE") continue;
      if (slot === "FLEX") {
        let best = null, bp = null;
        for (const pos of ["RB", "WR", "TE"]) { const i = used[pos] ?? 0; const v = (by[pos] ?? [])[i]; if (v != null && (best == null || v > best)) { best = v; bp = pos; } }
        if (bp) { used[bp] = (used[bp] ?? 0) + 1; pts += best; }
      } else {
        const i = used[slot] ?? 0; const v = (by[slot] ?? [])[i];
        if (v != null) { used[slot] = i + 1; pts += v; }
      }
    }
    startPts += pts;
    n++;
    if (s === 1) {
      console.log(`${strategy} seed 1: ` + mine.sort((a, b) => b.price - a.price)
        .map((p) => `${p.name.split(" ").slice(-1)[0]}(${p.pos},$${p.price})`).join(" "));
    }
  }
  const shares = Object.entries(posSpend).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${(100 * v / spend).toFixed(0)}%`).join("  ");
  console.log(`${strategy}: mean spend $${(spend / n).toFixed(0)} of 200, starting-lineup proj ${(startPts / n).toFixed(0)}   ${shares}\n`);
}
