// FACE VALIDITY: does the simulated auction reproduce how this room ACTUALLY prices players?
//
// `ff calibrate` only checks each bot's positional SPEND SHARE. That leaves the price DISTRIBUTION
// unvalidated -- and the distribution is what every strategy conclusion depends on, because shading,
// max-share and reserve are all statements about where in the price curve we should be buying. A
// field that spends its money in the right proportions but on the wrong price SHAPE would produce
// confident, wrong strategy advice.
//
// Ground truth: docs/league-tendencies.md, three real drafts (2023-2025), 16 teams x $200.
//   median $2 | 61% of picks $1-5 | top $88-106 | >$50: 22-25 players | >$30: 36-43
//   RB 1055-1292 | WR 1126-1291 | QB 192-328 | TE 199-215 | K/DST ~$20 each
//
//   node scripts/face-validity.mjs [--bot-book rank]
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

const botBook = process.argv.includes("rank") ? "rank" : process.argv.includes("price") ? "price" : "vor";
const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));

const N = 40;
const agg = { total: 0, med: [], pct15: [], top: [], over50: [], over30: [], pos: {} };
for (let s = 1; s <= N; s++) {
  // includeUs:false -> a pure BOT room, which is what we compare against a real all-human draft.
  const { picks } = draftFieldSeats(points, ourValues, {}, s, SIM_LEAGUE, { includeUs: false, botBook });
  const prices = picks.map((p) => p.price).sort((a, b) => a - b);
  agg.total += prices.reduce((a, b) => a + b, 0);
  agg.med.push(prices[Math.floor(prices.length / 2)]);
  agg.pct15.push(prices.filter((p) => p >= 1 && p <= 5).length / prices.length * 100);
  agg.top.push(prices.at(-1));
  agg.over50.push(prices.filter((p) => p > 50).length);
  agg.over30.push(prices.filter((p) => p > 30).length);
  for (const p of picks) agg.pos[p.pos] = (agg.pos[p.pos] || 0) + p.price;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// [lo, hi] observed across the three real drafts.
const REAL = {
  "total $":      [2767, 3157],
  "median price": [2, 2],
  "% picks $1-5": [61, 61],
  "top price":    [88, 106],
  "players >$50": [22, 25],
  "players >$30": [36, 43],
  "RB total":     [1055, 1292],
  "WR total":     [1126, 1291],
  "QB total":     [192, 328],
  "TE total":     [199, 215],
};
const simv = {
  "total $": agg.total / N,
  "median price": mean(agg.med),
  "% picks $1-5": mean(agg.pct15),
  "top price": mean(agg.top),
  "players >$50": mean(agg.over50),
  "players >$30": mean(agg.over30),
  "RB total": (agg.pos.RB || 0) / N,
  "WR total": (agg.pos.WR || 0) / N,
  "QB total": (agg.pos.QB || 0) / N,
  "TE total": (agg.pos.TE || 0) / N,
};

console.log(`FACE VALIDITY -- ${N} all-bot drafts, botBook=${botBook}\n`);
console.log("  metric           sim      real range      verdict");
let pass = 0, fail = 0;
for (const [k, [lo, hi]] of Object.entries(REAL)) {
  const v = simv[k];
  // Allow 25% outside the observed range: three drafts do not define the true range, and a metric
  // that lands just outside is a wide prior, not a broken model.
  const tol = Math.max(1, (hi - lo) * 0.25, Math.abs(hi) * 0.25);
  const ok = v >= lo - tol && v <= hi + tol;
  if (ok) pass++; else fail++;
  console.log(`  ${k.padEnd(15)} ${v.toFixed(1).padStart(7)}   ${String(lo + "-" + hi).padStart(11)}      ${ok ? "ok" : "OFF"}`);
}
console.log(`\n  ${pass} of ${pass + fail} metrics within tolerance of the real drafts`);
console.log(fail === 0
  ? "  The simulated market reproduces this room's price behaviour."
  : "  Metrics marked OFF are where the opponent model does NOT look like the real room --\n  strategy conclusions that depend on those parts of the price curve are the shakiest.");
