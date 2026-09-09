// How different is the SIMULATED auction from the ESPN mock drafts we actually ran?
//
// Three markets, same metrics:
//   ESPN MOCK   -- data/draft-log-*.json, every pick+price from the 10 live practice auctions
//   SIM         -- all-bot drafts, both opponent books
//   REAL LEAGUE -- docs/league-tendencies.md, three actual drafts of THIS league (2023-2025)
//
// This matters because the two validation surfaces disagree by construction: ESPN practice rooms are
// generic AUTO teams, while the sim models THIS league's 16 real managers. Knowing HOW they differ
// says which conclusions transfer from which surface -- and whether the sim is closer to your room
// than the mock rooms are, which is the whole reason the sim exists.
import { readFileSync, readdirSync } from "node:fs";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";

// Longest usable mock prefix; every market is truncated to this many picks.
const PREFIX = Number(process.argv[2] ?? 90);

const stats = (prices, byPos) => {
  const p = [...prices].sort((a, b) => a - b);
  return {
    picks: p.length,
    total: p.reduce((a, b) => a + b, 0),
    median: p[Math.floor(p.length / 2)],
    pct15: p.filter((x) => x >= 1 && x <= 5).length / p.length * 100,
    top: p.at(-1),
    over50: p.filter((x) => x > 50).length,
    over30: p.filter((x) => x > 30).length,
    pos: byPos,
  };
};

// --- ESPN mocks: use only logs that captured a near-complete draft ---------------------------
const logs = readdirSync("data").filter((f) => /^draft-log-.*\.json$/.test(f));
const mocks = [];
for (const f of logs) {
  let d; try { d = JSON.parse(readFileSync(`data/${f}`, "utf8")); } catch { continue; }
  const picks = d.picks || [];
  // auto-draft EXITS when OUR roster fills, well before the room's 192nd pick, so these logs cover
  // only the early/mid draft (best log: 109 picks). Compare like-for-like by truncating every market
  // to the same prefix -- the first PREFIX picks -- rather than comparing 100 picks against 192.
  if (picks.length < PREFIX) continue;
  const head = picks.slice(0, PREFIX);
  const byPos = {};
  for (const p of head) byPos[p.pos] = (byPos[p.pos] || 0) + p.price;
  mocks.push(stats(head.map((p) => p.price), byPos));
}
const avg = (arr, f) => arr.reduce((a, x) => a + f(x), 0) / arr.length;
const avgPos = (arr, pos) => arr.reduce((a, x) => a + (x.pos[pos] || 0), 0) / arr.length;

// --- sim, both books -------------------------------------------------------------------------
const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
const simRuns = (book) => {
  const out = [];
  for (let s = 1; s <= 30; s++) {
    const { picks } = draftFieldSeats(points, ourValues, {}, s, SIM_LEAGUE, { includeUs: false, botBook: book });
    const head = picks.slice(0, PREFIX);
    const byPos = {};
    for (const p of head) byPos[p.pos] = (byPos[p.pos] || 0) + p.price;
    out.push(stats(head.map((p) => p.price), byPos));
  }
  return out;
};
const simVor = simRuns("vor"), simRank = simRuns("rank");
// The price book is only runnable where data/price-model.json exists; without it the script still
// reports the two books it has rather than failing, and says which one is missing.
let simPrice = null;
try { simPrice = simRuns("price"); } catch (e) { console.log("  (no price book: " + String(e.message).slice(0, 90) + ")"); }

const REAL = { picks: 192, total: 3157, median: 2, pct15: 61, top: 103, over50: 25, over30: 43,
  pos: { RB: 1292, WR: 1291, QB: 328, TE: 206 } };

const row = (label, s) => {
  const g = (f) => typeof s === "function" ? s(f) : f(s);
  console.log(`  ${label.padEnd(20)} ${String(g((x) => x.picks).toFixed(0)).padStart(5)} ${String(g((x) => x.total).toFixed(0)).padStart(7)} ${String(g((x) => x.median).toFixed(1)).padStart(7)} ${String(g((x) => x.pct15).toFixed(0)).padStart(7)} ${String(g((x) => x.top).toFixed(0)).padStart(6)} ${String(g((x) => x.over50).toFixed(0)).padStart(6)} ${String(g((x) => x.over30).toFixed(0)).padStart(6)}`);
};
console.log(`ESPN mocks used: ${mocks.length} complete drafts (of ${logs.length} logs)\n`);
console.log("  market                picks   total  median  %$1-5    top   >$50   >$30");
row("ESPN mock (live)", (f) => avg(mocks, f));
row("SIM vor book", (f) => avg(simVor, f));
row("SIM rank book", (f) => avg(simRank, f));
if (simPrice) row("SIM price book", (f) => avg(simPrice, f));
console.log("  (REAL league row omitted: we only have its FULL-draft totals, not a 90-pick prefix)");

console.log("\n  positional $ (RB / WR / QB / TE)");
const pr = (label, rb, wr, qb, te) => console.log(`  ${label.padEnd(20)} ${rb.toFixed(0).padStart(6)} ${wr.toFixed(0).padStart(6)} ${qb.toFixed(0).padStart(6)} ${te.toFixed(0).padStart(6)}`);
pr("ESPN mock (live)", avgPos(mocks, "RB"), avgPos(mocks, "WR"), avgPos(mocks, "QB"), avgPos(mocks, "TE"));
pr("SIM vor book", avgPos(simVor, "RB"), avgPos(simVor, "WR"), avgPos(simVor, "QB"), avgPos(simVor, "TE"));
pr("SIM rank book", avgPos(simRank, "RB"), avgPos(simRank, "WR"), avgPos(simRank, "QB"), avgPos(simRank, "TE"));
if (simPrice) pr("SIM price book", avgPos(simPrice, "RB"), avgPos(simPrice, "WR"), avgPos(simPrice, "QB"), avgPos(simPrice, "TE"));
pr("REAL league 2025", REAL.pos.RB, REAL.pos.WR, REAL.pos.QB, REAL.pos.TE);

// Which simulated market is closer to YOUR room? That is the one whose strategy advice transfers.
const dist = (s) => ["RB", "WR", "QB", "TE"].reduce((a, p) => a + Math.abs(avgPos(s, p) - REAL.pos[p]), 0);
const mockDist = ["RB", "WR", "QB", "TE"].reduce((a, p) => a + Math.abs(avgPos(mocks, p) - REAL.pos[p]), 0);
console.log(`\n  total positional $ distance from YOUR league's 2025 draft (lower = more like your room):`);
console.log(`    ESPN mock rooms  ${mockDist.toFixed(0)}`);
console.log(`    SIM vor book     ${dist(simVor).toFixed(0)}`);
console.log(`    SIM rank book    ${dist(simRank).toFixed(0)}`);
if (simPrice) console.log(`    SIM price book   ${dist(simPrice).toFixed(0)}`);
