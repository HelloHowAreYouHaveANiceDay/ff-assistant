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
import Database from "better-sqlite3";
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

// [lo, hi] observed across the room's REAL drafts -- DERIVED from fact_draft_pick rather than
// retyped. The hardcoded table this replaces was three drafts (2023-2025) copied out of
// docs/league-tendencies.md, and a hand-copied range is a snapshot of the day it was written: the
// store now holds NINE seasons, 2018-2026, through a reproducible ingest.
//
// EVERY DOLLAR FIGURE IS A SHARE OF THE ROOM'S MONEY, scaled to the simulated room. Six of the nine
// seasons are 14-team ($2,800) and three are 16-team ($3,200); comparing raw dollars across them
// compares two currencies, and the same is true of a count like "players >$50" -- $50 is 1.79% of a
// 14-team room and 1.56% of a 16-team one. The thresholds are converted to shares of the SIM room
// and applied to each season's own share distribution.
//
// The old hardcoded ranges are kept in the comment as a cross-check, not as an input:
//   median $2 | 61% $1-5 | top $88-106 | >$50: 22-25 | >$30: 36-43
//   RB 1055-1292 | WR 1126-1291 | QB 192-328 | TE 199-215
const REAL = (() => {
  const db = new Database("data/ff.db", { readonly: true });
  let picks;
  try {
    picks = db.prepare(
      "SELECT season, pos, price, season_total_money FROM fact_draft_pick WHERE season_total_money > 0",
    ).all();
  } catch { picks = []; } finally { db.close(); }
  if (!picks.length) {
    console.error("face-validity: fact_draft_pick has no season_total_money -- run `ff build-picks`");
    process.exit(1);
  }
  const SIM_MONEY = SIM_LEAGUE.teams * SIM_LEAGUE.budget;
  const bySeason = new Map();
  for (const p of picks) {
    const s = bySeason.get(p.season) ?? { shares: [], pos: {}, money: p.season_total_money };
    s.shares.push(p.price / p.season_total_money);
    s.pos[p.pos] = (s.pos[p.pos] ?? 0) + p.price / p.season_total_money;
    bySeason.set(p.season, s);
  }
  const per = { "total $": [], "median price": [], "% picks $1-5": [], "top price": [], "players >$50": [], "players >$30": [], "RB total": [], "WR total": [], "QB total": [], "TE total": [] };
  for (const s of bySeason.values()) {
    const sh = s.shares.slice().sort((a, b) => a - b);
    const money = s.money;
    per["total $"].push(sh.reduce((a, b) => a + b, 0) * SIM_MONEY);
    per["median price"].push(sh[Math.floor(sh.length / 2)] * SIM_MONEY);
    // "$1-5" is a DOLLAR band in the room it was observed in, so it converts through that room's
    // own money, not through the sim's.
    per["% picks $1-5"].push(100 * sh.filter((x) => x * money >= 1 && x * money <= 5).length / sh.length);
    per["top price"].push(sh.at(-1) * SIM_MONEY);
    per["players >$50"].push(sh.filter((x) => x > 50 / SIM_MONEY).length);
    per["players >$30"].push(sh.filter((x) => x > 30 / SIM_MONEY).length);
    for (const p of ["RB", "WR", "QB", "TE"]) per[`${p} total`].push((s.pos[p] ?? 0) * SIM_MONEY);
  }
  const out = {};
  for (const [k, v] of Object.entries(per)) out[k] = [Math.min(...v), Math.max(...v)];
  return out;
})();
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
  // THE PAD SHRANK WITH THE EVIDENCE. It used to be 25% of the range OR 25% of the upper bound,
  // whichever was larger -- and that second term dominated, because three drafts give a narrow
  // observed range and a wide true one. Nine seasons estimate the range far better, so the pad is
  // now 10% of the observed range and nothing else: a check whose tolerance is a quarter of the
  // quantity being checked cannot fail for any reason a reader would care about.
  const tol = Math.max(1, (hi - lo) * 0.1);
  const ok = v >= lo - tol && v <= hi + tol;
  if (ok) pass++; else fail++;
  const range = `${lo.toFixed(0)}-${hi.toFixed(0)}`;
  console.log(`  ${k.padEnd(15)} ${v.toFixed(1).padStart(7)}   ${range.padStart(11)}      ${ok ? "ok" : "OFF"}`);
}
console.log(`\n  ${pass} of ${pass + fail} metrics within tolerance of the real drafts`);
console.log(fail === 0
  ? "  The simulated market reproduces this room's price behaviour."
  : "  Metrics marked OFF are where the opponent model does NOT look like the real room --\n  strategy conclusions that depend on those parts of the price curve are the shakiest.");
