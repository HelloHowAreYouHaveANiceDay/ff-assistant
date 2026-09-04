// What does our team actually DO with TEs under the shipped weighted curve, on the real 2026 data?
// This is the offline half of Step 9c's "watch that the agent no longer chases mid-TEs" -- the sim
// runs the real draft path (draftFieldSeats) on data/points.csv + data/values.csv.
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";
import { computeValues, DEFAULT_VALUE_LEAGUE } from "../src/draft/values.ts";

const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const cfg = { values: Object.fromEntries(ourValues), starterReserve: 15, benchReserve: 1, premium: 2, maxShare: 0.35, maxKDst: 2 };

const SEEDS = 40;
const mean = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);

// A/B: the ONLY thing that differs between arms is OUR value table (the market is identical), so
// any change in what our team buys is attributable to the curve.
const evenValues = new Map(computeValues(points, DEFAULT_VALUE_LEAGUE, 2, false).map((v) => [v.name, v.value]));
const arms = [
  { label: "SHIPPED (weighted FLEX)", vals: ourValues },
  { label: "OLD (even 3-way split)  ", vals: evenValues },
];

for (const arm of arms) {
  const c = { ...cfg, values: Object.fromEntries(arm.vals) };
  const teCounts = [], teSpends = [], kdstMax = [], rows = [];
  for (let s = 1; s <= SEEDS; s++) {
    const { picks } = draftFieldSeats(points, arm.vals, c, s, SIM_LEAGUE);
    const mine = picks.filter((p) => p.team === 0);
    const tes = mine.filter((p) => p.pos === "TE");
    const kd = mine.filter((p) => p.pos === "K" || p.pos === "DST");
    teCounts.push(tes.length);
    teSpends.push(tes.reduce((a, b) => a + b.price, 0));
    kdstMax.push(Math.max(0, ...kd.map((p) => p.price)));
    if (s <= 3) rows.push(`    seed ${s}: [${tes.map((t) => `${t.name} $${t.price}`).join(", ") || "-"}]`);
  }
  console.log(`\n${arm.label}`);
  console.log(rows.join("\n"));
  console.log(`    TE count  min ${Math.min(...teCounts)} max ${Math.max(...teCounts)} mean ${mean(teCounts)}`);
  console.log(`    TE spend  min $${Math.min(...teSpends)} max $${Math.max(...teSpends)} mean $${mean(teSpends)}`);
  console.log(`    max K/DST price ever paid: $${Math.max(...kdstMax)}`);
}
