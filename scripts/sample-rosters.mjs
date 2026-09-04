// Print a few complete sim rosters so the aggregate expectation numbers can be sanity-checked
// against something a human can read. Aggregates hide shape: "QB count median 3" only means
// something once you can see which three QBs and at what price.
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const cfg = { values: Object.fromEntries(ourValues), starterReserve: 15, benchReserve: 1, premium: 2, maxShare: 0.35, maxKDst: 2 };

for (const s of [1, 2, 3, 4, 5]) {
  const { picks } = draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE);
  const mine = picks.filter((p) => p.team === 0).sort((a, b) => b.price - a.price);
  const byPos = {};
  for (const p of mine) byPos[p.pos] = (byPos[p.pos] || 0) + 1;
  console.log(`\nseed ${s} -- $${mine.reduce((a, b) => a + b.price, 0)} across ${mine.length} slots  ${JSON.stringify(byPos)}`);
  console.log("  " + mine.map((p) => `${p.name} (${p.pos}) $${p.price}`).join("\n  "));
}
