// THE ROSTER-AWARE BOOK, beside the VOR book it is meant to replace.
//
//   node --import tsx scripts/roster-book.mjs [--trials 200] [--seed 7] [--cands 40] [--top 24]
//
// THE DECISION STATE, stated because a marginal has no meaning without one. Our roster is EMPTY with
// all twelve slots open and the full $200 -- "if we were drafting into this league today, what is
// each man worth to US" -- while the other fifteen teams are the REAL rosters this league currently
// has, and the POOL IS THE WHOLE BOARD. That last part is a deliberate choice and it is the
// difference between a book and a waiver list: at the start of an auction nobody owns anybody, so
// pricing against the leftovers of a completed draft is pricing a different question. The wrinkle it
// accepts is that a man can appear both in our hypothetical roster and on the opponent who really
// holds him; for a RANKING and a PRICE that is the standard framing, and the alternative was
// measured first and is degenerate -- with the studs removed the fill is so bad that every candidate
// looks enormous and a $100 change in our budget buys nothing, so the shadow price cannot be
// measured at all.
//
// THE SCHEDULE IS THE GENERATED ONE, deliberately: this script must run offline and deterministically,
// and the quantity being compared is a RANKING of players under one fixed schedule, not a
// probability to quote. `assumptions.schedule` says the same thing everywhere else in the repo.
import { readFileSync } from "node:fs";
import { loadSimContext } from "../src/draft/simContext.ts";
import { MarginalBook } from "../src/draft/rosterMarginal.ts";
import { computeValues, resolveValueLeague } from "../src/draft/values.ts";
import { loadPriceModel, priceFor } from "../src/model/price.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const TRIALS = Number(val("--trials", "200"));
const SEED = Number(val("--seed", "7"));
const CANDS = Number(val("--cands", "40"));
const TOP = Number(val("--top", "24"));

const ctx = await loadSimContext({ schedule: "generated" });
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const priceArt = loadPriceModel(JSON.parse(readFileSync("data/price-model.json", "utf8")));

// --- the state -------------------------------------------------------------------------------
const opponents = ctx.teams.filter((_, i) => i !== ctx.meIdx);
// Byes come from the same place the simulator's own rosters get them, so a bye collision is a real
// collision and not an artefact of two tables spelling a week differently.
const byeOf = new Map();
for (const t of ctx.teams) for (const p of t.roster) if (p.bye != null) byeOf.set(p.name, p.bye);
const pool = [...ctx.board.values()].map((p) => ({ ...p, bye: byeOf.get(p.name) ?? null }));

// The market price of a pool player: the fitted price model at the START of a draft (money and slots
// both whole, so the market-state terms are exactly neutral), read at his consensus positional rank.
const posRank = new Map();
{
  const seen = {};
  for (const p of [...pool].sort((a, b) => b.proj - a.proj)) { seen[p.pos] = (seen[p.pos] ?? 0) + 1; posRank.set(p.name, seen[p.pos]); }
}
const LEAGUE_MONEY = 16 * 200;
const priceOf = (p) => Math.max(1, Math.round(priceFor(priceArt, p.pos, {
  ecrPosRank: posRank.get(p.name) ?? null, ecrSd: null, moneyLeft: 1, slotsLeft: 1, pickShare: 0, leagueMoney: LEAGUE_MONEY,
})));

const state = {
  roster: [], openSlots: [...ctx.slots], budget: 200, pool, opponents,
  meId: ctx.teams[ctx.meIdx].id, meName: ctx.teams[ctx.meIdx].name,
};
const env = { weeks: ctx.weeks, vm, opts: ctx.opts, slots: ctx.slots, flexOk: ctx.flexOk, priceOf };

// --- the VOR book, for the side-by-side ------------------------------------------------------
const vorRows = computeValues(pool.map((p) => ({ name: p.name, pos: p.pos, points: p.proj })),
  resolveValueLeague({ teams: 16, budget: 200, slots: ctx.slots }), 2);
const vor = new Map(vorRows.map((r) => [r.name, r.value]));

const candidates = [...pool].sort((a, b) => (vor.get(b.name) ?? 0) - (vor.get(a.name) ?? 0) || b.proj - a.proj).slice(0, CANDS);

// --- measure ----------------------------------------------------------------------------------
const book = new MarginalBook(state, env, { trials: TRIALS, seed: SEED, fillExclude: candidates.map((c) => c.name) });
// THE FIXED COST AND THE PER-CANDIDATE COST ARE TIMED SEPARATELY, because they are paid at different
// moments: the budget curve is once per decision point and the marginal is once per player on the
// block. Reporting one number for both would answer neither "can this run inside an auction tick".
const t0 = Date.now();
book.budgetCurve();
const msCurve = Date.now() - t0;
const t1 = Date.now();
const rows = book.rank(candidates);
const ms = Date.now() - t1;

console.log(`ROSTER-AWARE BOOK -- ${CANDS} candidates, ${TRIALS} trials, seed ${SEED}, generated schedule`);
console.log(`  budget curve (once per state): ${(msCurve / 1000).toFixed(1)}s`);
console.log(`  ${book.runs} simulateSeasons calls; ${(ms / 1000).toFixed(1)}s for ${candidates.length} candidates = ${(ms / candidates.length).toFixed(0)} ms PER CANDIDATE`);
console.log(`  shadow price ${book.shadowPricePpPerDollar().toFixed(4)} pp of P(playoffs) per dollar of the best alternative use`);
console.log("");
console.log("  ROSTER-AWARE (primary = P(playoffs))                        |  VOR BOOK");
console.log(`  ${"#".padStart(3)} ${"player".padEnd(24)} ${"pos".padEnd(4)} ${"pp".padStart(6)} ${"$".padStart(5)} ${"titlePp".padStart(8)} ${"poPts".padStart(7)}  |  ${"player".padEnd(24)} ${"$".padStart(5)}`);
const byVor = [...candidates].sort((a, b) => (vor.get(b.name) ?? 0) - (vor.get(a.name) ?? 0));
for (let i = 0; i < TOP && i < rows.length; i++) {
  const r = rows[i], v = byVor[i];
  console.log(`  ${String(i + 1).padStart(3)} ${r.name.slice(0, 24).padEnd(24)} ${r.pos.padEnd(4)} ${r.playoffsPp.toFixed(2).padStart(6)} ${String(r.dollars).padStart(5)} ${r.titlePp.toFixed(2).padStart(8)} ${r.playoffWeekPts.toFixed(1).padStart(7)}  |  ${v.name.slice(0, 24).padEnd(24)} ${String(vor.get(v.name) ?? 0).padStart(5)}`);
}

// --- positional shares ------------------------------------------------------------------------
const share = (get, list) => {
  const by = {}; let tot = 0;
  for (const p of list) { const d = Math.max(0, get(p)); by[p.pos] = (by[p.pos] ?? 0) + d; tot += d; }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, tot ? (100 * v / tot) : 0]));
};
const raShare = share((r) => r.dollars, rows);
const vorShare = share((p) => vor.get(p.name) ?? 0, candidates.map((c) => ({ pos: c.pos, name: c.name })));
console.log("");
console.log(`  POSITIONAL SHARE OF THE BOOK (over the ${CANDS} candidates priced)`);
console.log(`  ${"pos".padEnd(6)} ${"roster-aware".padStart(13)} ${"VOR".padStart(8)}`);
for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
  console.log(`  ${pos.padEnd(6)} ${(raShare[pos] ?? 0).toFixed(1).padStart(12)}% ${(vorShare[pos] ?? 0).toFixed(1).padStart(7)}%`);
}
