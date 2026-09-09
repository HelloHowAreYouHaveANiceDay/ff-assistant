// IS THE SAMPLER'S RNG INDEPENDENT ACROSS PLAYERS, AND ACROSS SEEDS?
//
//   node --import tsx scripts/winprob-rng-check.mjs [--sims 50000]
//
// The copula is the ONLY thing allowed to make two players co-move. A keyed hash that leaks
// correlation between adjacent player indices would produce the same output shape -- teammates
// co-moving -- from a completely different cause, and the coupling calibration would then be fitting
// a hash artifact. So this measures the UNCOUPLED correlation between every pair of the first N
// player indices over several seeds, and reports the worst one. Nothing here should exceed the
// sampling error of the sample size, ~1/sqrt(sims).
import { sampleWeek } from "../src/inseason/winprob.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i < 0 ? d : process.argv[i + 1]; };
const sims = Number(arg("--sims", 50000));
const N = Number(arg("--players", 12));

const players = Array.from({ length: N }, (_, i) => ({
  name: `P${i}`, pos: "WR", available: true, team: null, proj: 12,
  band: { mean: 12, p10: 2, p50: 10, p90: 26, pZero: 0.15 },
}));

const pearson = (a, b) => {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
};

const se = 1 / Math.sqrt(sims);
console.log(`${N} independent players, ${sims} sims, sampling error ~${se.toFixed(4)}`);
console.log("");
console.log("      seed   worst |r|   pair          pairs");
let worstAll = 0;
for (const seed of [1, 5, 7, 11, 99, 4242, 20260909]) {
  const m = sampleWeek(players, { sims, seed });
  let worst = 0, at = "";
  let n = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const r = Math.abs(pearson(m.pts[i], m.pts[j]));
    n++;
    if (r > worst) { worst = r; at = `${i}-${j}`; }
  }
  worstAll = Math.max(worstAll, worst);
  console.log(`${String(seed).padStart(10)}${worst.toFixed(4).padStart(11)}   ${at.padEnd(12)}${String(n).padStart(6)}`);
}
console.log("");
console.log(`WORST OVER EVERY SEED AND PAIR: ${worstAll.toFixed(4)}  (${(worstAll / se).toFixed(1)} sampling errors)`);
console.log(worstAll < 4 * se
  ? "OK -- nothing above four sampling errors, so the copula is the only source of dependence."
  : "PROBLEM -- an uncoupled pair is correlated. The coupling calibration would be fitting this.");
process.exit(worstAll < 4 * se ? 0 : 1);
