// What SHOULD a completed draft look like? Printed from the offline sim so the numbers exist before
// the live mocks finish -- otherwise "within expectation" is decided after seeing the answer.
//
// IMPORTANT: two classes of expectation, and only one transfers to an ESPN practice room.
//   MECHANICS  -- roster completion, K/DST discipline, slot legality. These MUST hold anywhere:
//                 they are properties of our engine, not of the opponents.
//   SPEND/MIX  -- how much we spend and who we get. These are a JOINT property of our strategy and
//                 the ROOM. The sim models this league's 16 real managers (data/managers.json);
//                 ESPN practice rooms are generic AUTO teams that overpay vs our values, so low
//                 spend in a mock is evidence about the OPPONENTS, not about us.
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const cfg = { values: Object.fromEntries(ourValues), starterReserve: 15, benchReserve: 1, premium: 2, maxShare: 0.35, maxKDst: 2 };

const N = Number(process.argv[2] || 60);
const rows = [];
for (let s = 1; s <= N; s++) {
  const { picks } = draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE);
  const mine = picks.filter((p) => p.team === 0);
  const byPos = {};
  for (const p of mine) byPos[p.pos] = (byPos[p.pos] || 0) + 1;
  rows.push({
    n: mine.length,
    spent: mine.reduce((a, b) => a + b.price, 0),
    byPos,
    te: byPos.TE || 0,
    kdstMax: Math.max(0, ...mine.filter((p) => p.pos === "K" || p.pos === "DST").map((p) => p.price)),
    kdstN: (byPos.K || 0) + (byPos.DST || 0),
    top: Math.max(0, ...mine.map((p) => p.price)),
  });
}
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)]; };
const col = (f) => rows.map(f);
const stat = (label, f, fmt = (v) => v) => {
  const a = col(f);
  console.log(`  ${label.padEnd(22)} min ${String(fmt(Math.min(...a))).padStart(5)}  p10 ${String(fmt(q(a, 0.1))).padStart(5)}  median ${String(fmt(q(a, 0.5))).padStart(5)}  p90 ${String(fmt(q(a, 0.9))).padStart(5)}  max ${String(fmt(Math.max(...a))).padStart(5)}`);
};

console.log(`OFFLINE EXPECTATION -- ${N} sim drafts vs THIS league's 16 modelled managers`);
console.log(`(weighted-FLEX curve, reserve 15 / maxShare 0.35 / premium 2 / maxKDst 2)\n`);
stat("roster size", (r) => r.n);
stat("spent $", (r) => r.spent);
stat("top price $", (r) => r.top);
stat("TE count", (r) => r.te);
stat("K+DST count", (r) => r.kdstN);
stat("max K/DST $", (r) => r.kdstMax);
for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) stat(`${pos} count`, (r) => r.byPos[pos] || 0);

console.log(`\nMECHANICS invariants (must hold in ANY room, including ESPN practice):`);
console.log(`  - roster completes 12/12`);
console.log(`  - exactly 2 K/DST, never more (no bench K/DST)`);
console.log(`  - no K/DST ever costs more than $2`);
console.log(`  - every bid on a player in our table logs src=ours (name join intact)`);
console.log(`  - one agent per seat; no repeated nomination of the same player`);
console.log(`\nNOT transferable to an ESPN practice room: spent $, top price, positional mix.`);
console.log(`ESPN AUTO teams bid ESPN's pre-draft values, which run well above ours, so expect LOW`);
console.log(`spend and a cheap roster there. That is a statement about the bots, not about us --`);
console.log(`do NOT retune strategy dials on it (docs/validation.md: the backtest is the arbiter).`);
