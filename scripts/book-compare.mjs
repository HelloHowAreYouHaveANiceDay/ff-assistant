// Is the bots' "independent" book actually independent? A rank book that came out nearly identical
// to our VOR book would leave the self-reference intact while LOOKING like it had been removed --
// and every downstream robustness claim would be false. Check before trusting any result from it.
import { readFileSync } from "node:fs";
import { rankBook, SIM_LEAGUE } from "../src/draft/sim.ts";
import { computeValues, DEFAULT_VALUE_LEAGUE } from "../src/draft/values.ts";

const rows = readFileSync("data/points.csv", "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = rows.map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);

const vor = new Map(computeValues(points, DEFAULT_VALUE_LEAGUE).map((v) => [v.name, v.value]));
const rank = rankBook(points, SIM_LEAGUE);
const names = [...vor.keys()];
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);

console.log(`book totals    vor $${sum(vor)}    rank $${sum(rank)}`);
let same = 0; for (const n of names) if (vor.get(n) === rank.get(n)) same++;
console.log(`identical prices: ${same}/${names.length}`);

const rk = (m) => { const s = [...m.entries()].sort((a, b) => b[1] - a[1]); const o = new Map(); s.forEach(([n], i) => o.set(n, i)); return o; };
const rv = rk(vor), rr = rk(rank);
let d2 = 0; for (const n of names) d2 += (rv.get(n) - rr.get(n)) ** 2;
const N = names.length;
const rho = 1 - (6 * d2) / (N * (N * N - 1));
console.log(`spearman rho (ordering agreement): ${rho.toFixed(3)}`);

const byPos = (m) => { const o = {}; for (const p of points) o[p.pos] = (o[p.pos] || 0) + (m.get(p.name) || 0); return o; };
console.log(`vor  by pos: ${JSON.stringify(byPos(vor))}`);
console.log(`rank by pos: ${JSON.stringify(byPos(rank))}`);
const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, v]) => `${n} $${v}`).join("  ");
console.log(`top6 vor : ${top(vor)}`);
console.log(`top6 rank: ${top(rank)}`);

// The books must be on the same dollar scale (else "cheaper book" alone looks like an edge) but
// must NOT price players the same way (else nothing was made independent).
const scaleOk = Math.abs(sum(vor) - sum(rank)) / sum(vor) < 0.15;
const independentOk = rho < 0.95 && same / names.length < 0.5;
console.log(`\nsame dollar scale (within 15%): ${scaleOk ? "PASS" : "FAIL"}`);
console.log(`genuinely different pricing:    ${independentOk ? "PASS" : "FAIL"}`);
process.exit(scaleOk && independentOk ? 0 : 1);
