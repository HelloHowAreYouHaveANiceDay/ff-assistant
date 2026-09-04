// Does a config buy a BETTER TEAM, or just a cheaper one? Championships can move for subtle reasons;
// starting-lineup projected points is the direct question. Scores each drafted roster with the real
// lineup optimizer on the same projection the draft used, so the comparison is like-for-like.
//
//   node scripts/roster-strength.mjs '{"aggr":1}' '{"aggr":0.7}'
import { readFileSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";
import { computeValues } from "../src/draft/values.ts";

const A = JSON.parse(process.argv[2] || "{}"), B = JSON.parse(process.argv[3] || "{}");
// OUR projection error. This is the whole ballgame: with ourSd=0 our values ARE the truth we score
// by, there is no winner's curse, and shading a bid can only lose good players. Real drafting is a
// common-value auction on noisy estimates, where the winner is disproportionately whoever
// OVERestimated -- and shading is the textbook correction. Compare at a realistic error, not zero.
const OUR_SD = Number(process.argv[4] ?? 0.30);
const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ptsBy = new Map(points.map((p) => [p.name, p.points]));
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const base = { values: Object.fromEntries(ourValues), starterReserve: 15, benchReserve: 1, premium: 2, maxShare: 0.35, maxKDst: 2, benchDiscount: 0.25 };

const N = 60;
// deterministic per seed, so both arms see the SAME perturbed values
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = (r) => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const MARKET_SD = 0.30;
// Mirror runBacktest exactly: the BOTS' book is computed from a market-noisy view of the season, OUR
// book from an independently-noisy view, and everything is SCORED by the clean truth. Giving bots
// clean points (as a naive harness does) makes them omniscient and makes any shading look terrible.
const perturb = (seed, sd) => {
  const r = mulberry(seed);
  return points.map((p) => ({ ...p, points: Math.max(0, p.points * (1 + gauss(r) * sd)) }));
};

const measure = (over) => {
  const cfg = { ...base, ...over };
  let starters = 0, total = 0, spend = 0, fieldBeat = 0;
  for (let s = 1; s <= N; s++) {
    const projMarket = perturb(s * 104729 + 3, MARKET_SD);   // what the bots believe
    const projUs = perturb(s * 15485863 + 7, OUR_SD);        // what we believe
    const ov = new Map(computeValues(projUs).map((v) => [v.name, v.value]));
    const { picks } = draftFieldSeats(projMarket, ov, { ...cfg, values: Object.fromEntries(ov) }, s, SIM_LEAGUE);
    // Score EVERY team the same way, so "are we better than the room" is answered, not just "did our
    // number go up" -- an absolute points change means nothing without the field moving too.
    const byTeam = new Map();
    for (const p of picks) {
      if (!byTeam.has(p.team)) byTeam.set(p.team, []);
      byTeam.get(p.team).push({ name: p.name, pos: p.pos, proj: ptsBy.get(p.name) ?? 0, available: true });
    }
    const score = (roster) => optimalLineup(roster, SIM_LEAGUE.slots).starters.reduce((a, x) => a + (ptsBy.get(x.name) ?? 0), 0);
    const mine = byTeam.get(0) ?? [];
    const ourPts = score(mine);
    starters += ourPts;
    total += mine.reduce((a, x) => a + x.proj, 0);
    spend += picks.filter((p) => p.team === 0).reduce((a, p) => a + p.price, 0);
    const others = [...byTeam.entries()].filter(([t]) => t !== 0).map(([, r]) => score(r));
    fieldBeat += others.filter((v) => ourPts > v).length / others.length;
  }
  return {
    startersPts: (starters / N).toFixed(1),
    rosterPts: (total / N).toFixed(1),
    spend: (spend / N).toFixed(1),
    beatShare: ((fieldBeat / N) * 100).toFixed(1),
  };
};

const a = measure(A), b = measure(B);
console.log(`${N} sim drafts, scored with the real lineup optimizer on the same projection\n`);
console.log("                    starting-lineup pts   whole-roster pts   spend   % of field outscored");
for (const [label, m, cfg] of [["A", a, A], ["B", b, B]]) {
  console.log(`  ${label} ${JSON.stringify(cfg).padEnd(16)} ${String(m.startersPts).padStart(12)}   ${String(m.rosterPts).padStart(16)}   $${String(m.spend).padStart(5)}   ${String(m.beatShare).padStart(6)}%`);
}
const d = (Number(b.startersPts) - Number(a.startersPts)).toFixed(1);
console.log(`\n  starting-lineup delta (B - A): ${d > 0 ? "+" : ""}${d} pts`);
console.log(d > 0
  ? "  B fields a genuinely STRONGER starting lineup -- the saving is real, not just cheaper."
  : "  B fields a WEAKER starting lineup despite any championship gain -- treat that gain as suspect.");
