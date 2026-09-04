// Is a lever CONNECTED? A flat backtest result means "no effect on championships" only if the lever
// actually changes what we draft. A dead lever produces the identical flat line, and the two are
// indistinguishable from the championship number alone.
//
//   node scripts/lever-connected.mjs benchNonFlex 1 0.2
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

const [, , lever, aRaw, bRaw] = process.argv;
if (!lever) { console.error("usage: lever-connected.mjs <lever> <valueA> <valueB>"); process.exit(2); }
const A = Number(aRaw), B = Number(bRaw);

const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const base = { values: Object.fromEntries(ourValues), starterReserve: 15, benchReserve: 1, premium: 2, maxShare: 0.35, maxKDst: 2, benchDiscount: 0.25 };

const N = 40;
const measure = (v) => {
  const cfg = { ...base, [lever]: v };
  const posTot = {}, spends = [];
  let rosters = 0;
  for (let s = 1; s <= N; s++) {
    const { picks } = draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE);
    const mine = picks.filter((p) => p.team === 0);
    rosters++;
    spends.push(mine.reduce((a, b) => a + b.price, 0));
    for (const p of mine) posTot[p.pos] = (posTot[p.pos] || 0) + 1;
  }
  const per = {};
  for (const k of Object.keys(posTot)) per[k] = (posTot[k] / rosters).toFixed(2);
  return { per, spend: (spends.reduce((a, b) => a + b, 0) / spends.length).toFixed(1) };
};

const a = measure(A), b = measure(B);
console.log(`${lever} = ${A}  ->  avg spend $${a.spend}  ${JSON.stringify(a.per)}`);
console.log(`${lever} = ${B}  ->  avg spend $${b.spend}  ${JSON.stringify(b.per)}`);
const changed = JSON.stringify(a.per) !== JSON.stringify(b.per) || a.spend !== b.spend;
console.log(changed
  ? `\nCONNECTED: the lever changes what we draft, so a flat championship result is a REAL null.`
  : `\nDEAD LEVER: identical rosters at both settings -- the backtest sweep measured nothing.`);
process.exit(changed ? 0 : 1);
