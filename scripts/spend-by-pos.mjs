// Where do the dollars go? A championship delta is only trustworthy once you can see the mechanism
// that produced it. Compares average SPEND per position (not counts -- counts can rise while spend
// falls, which is exactly what a discount does) between two posMult settings.
//
//   node scripts/spend-by-pos.mjs '{"QB":1}' '{"QB":0.6}'
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

const A = JSON.parse(process.argv[2] || "{}"), B = JSON.parse(process.argv[3] || "{}");
const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const base = { values: Object.fromEntries(ourValues), starterReserve: 15, benchReserve: 1, premium: 2, maxShare: 0.35, maxKDst: 2, benchDiscount: 0.25 };

const N = 60;
const measure = (posMult) => {
  const cfg = { ...base, posMult };
  const spend = {}, count = {};
  let total = 0;
  for (let s = 1; s <= N; s++) {
    for (const p of draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE).picks.filter((x) => x.team === 0)) {
      spend[p.pos] = (spend[p.pos] || 0) + p.price;
      count[p.pos] = (count[p.pos] || 0) + 1;
      total += p.price;
    }
  }
  const out = {};
  for (const k of Object.keys(spend)) out[k] = { $: (spend[k] / N).toFixed(1), n: (count[k] / N).toFixed(2) };
  return { out, total: (total / N).toFixed(1) };
};

const a = measure(A), b = measure(B);
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
console.log(`per draft, ${N} seeds\n`);
console.log("  pos   A:$/n            B:$/n            delta $");
for (const p of POS) {
  const x = a.out[p] || { $: "0.0", n: "0" }, y = b.out[p] || { $: "0.0", n: "0" };
  const d = (Number(y.$) - Number(x.$)).toFixed(1);
  console.log(`  ${p.padEnd(4)} $${String(x.$).padStart(6)} / ${x.n}    $${String(y.$).padStart(6)} / ${y.n}    ${d > 0 ? "+" : ""}${d}`);
}
console.log(`\n  total spend  A $${a.total}   B $${b.total}`);
console.log(`  A = ${JSON.stringify(A)}   B = ${JSON.stringify(B)}`);
