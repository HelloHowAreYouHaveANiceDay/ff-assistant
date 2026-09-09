// WHERE THE ANALYTIC MARGINAL AND THE SIMULATED MARGINAL DISAGREE.
//
//   node --import tsx scripts/marginal-agreement.mjs [--seeds 8] [--trials 300] [--cands 60]
//                                                   [--out data/marginal-agreement.json]
//
// `src/draft/lineupMarginal.ts` has cited this file in its header since it was written and it did not
// exist. It is the check that module names as the one that matters: the greedy slot assignment, the
// positional baselines and the budget-path inversion are all approximations of the quantity
// `src/draft/rosterMarginal.ts` measures properly, and nobody had ever measured the gap.
//
// THE STATES ARE REAL, not invented. A marginal has no meaning without a roster, a budget, a pool and
// a field, and a hand-built state is a state whose answer the harness chose. So V2 drafts the sim's
// own auction at a set of seeds, the draft is REPLAYED pick by pick, and the state is snapshotted at
// five phases of OUR seat: empty, after 3 buys, after 6, after 9, and `late` -- the first moment our
// budget falls to $20 or we are down to one open slot. Everything at that instant -- our roster, our
// open slots, our money, the fifteen opponents as they actually stand, and the pool as what is
// actually left -- is what both books are handed.
//
// THE FILL EXCLUSION IS A FRAMING CHOICE AND IT MOVES THE ANSWER, so both framings are measured and
// the harness does not get to pick one quietly:
//
//   PER-CANDIDATE   each man is barred only from his OWN baseline. This is the honest single-player
//                   question -- "what does HE add, given the rest of the fill is what the market
//                   leaves us" -- and it is the column reported as `simulated`.
//   SHARED          the whole candidate set is barred (`MarginalBook.fillExclude`), the premise of a
//                   nomination PASS: we will win at most one of the sixty. It is what
//                   `scripts/roster-book.mjs` uses. It also strips sixty men out of the fill, so
//                   every candidate is measured against a weaker roster and the level inflates.
//
// Both come out of ONE `MarginalBook` under ONE budget curve and ONE set of random numbers, because
// measuring them in two runs of a stochastic simulator would attribute a sampling difference to a
// framing difference. The `add` arm's cache tag carries the exclusion for exactly that reason.
//
// The ANALYTIC book gets the WHOLE pool as its board in both cases, because V3 reads the board for
// its positional replacement baseline as well as for its budget path: removing the top sixty players
// moves the baseline rather than the fill, which is how the Track A harness manufactured a 27.3% QB
// share once already.
//
// The analytic numbers come from V3 ITSELF through `V3Config.onDetail` -- never from a
// reimplementation of `starterBaselines` + `lineupMarginal` in this file, which would let the harness
// drift from the bidder and then report the drift as agreement.
import { readFileSync, writeFileSync } from "node:fs";
import { loadSimContext } from "../src/draft/simContext.ts";
import { MarginalBook } from "../src/draft/rosterMarginal.ts";
import { computeValues, resolveValueLeague } from "../src/draft/values.ts";
import { loadPriceModel, priceFor } from "../src/model/price.ts";
import { buildV3Config, draftFieldSeats } from "../src/draft/sim.ts";
import { makeV3Strategy } from "../src/draft/strategyV3.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const SEEDS = Number(val("--seeds", "8"));
const TRIALS = Number(val("--trials", "300"));
const CANDS = Number(val("--cands", "60"));
// Both fill framings now come out of ONE book (see `measure`), so there is no separate control run
// and no `--control` flag: a flag that selected between them would invite two invocations.
const OUT = val("--out", "data/marginal-agreement.json");
// RE-REPORT A SAVED DUMP without re-simulating. The tables below are cheap and the measurement is
// not, so a mistake in the reporting must not cost another forty minutes of season simulations.
const FROM = val("--from", null);
const BOOK_SEED = Number(val("--book-seed", "7"));

const ctx = await loadSimContext({ schedule: "generated" });
const vm = JSON.parse(readFileSync("data/variance-model.json", "utf8"));
const priceArt = loadPriceModel(JSON.parse(readFileSync("data/price-model.json", "utf8")));

const LG = { teams: 16, budget: 200, slots: [...ctx.slots] };
const byeOf = new Map();
for (const t of ctx.teams) for (const p of t.roster) if (p.bye != null) byeOf.set(p.name, p.bye);
const board = [...ctx.board.values()].map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, bye: byeOf.get(p.name) ?? null }));
const byName = new Map(board.map((p) => [p.name, p]));
const points = board.map((p) => ({ name: p.name, pos: p.pos, points: p.proj }));

// The market price of a pool player: the fitted price model at the START of a draft, read at his
// consensus positional rank. The same function `scripts/roster-book.mjs` uses, so the two harnesses
// price the alternative use of a dollar identically.
const posRank = new Map();
{
  const seen = {};
  for (const p of [...board].sort((a, b) => b.proj - a.proj)) { seen[p.pos] = (seen[p.pos] ?? 0) + 1; posRank.set(p.name, seen[p.pos]); }
}
const LEAGUE_MONEY = LG.teams * LG.budget;
const priceOfName = (name, pos) => Math.max(1, Math.round(priceFor(priceArt, pos, {
  ecrPosRank: posRank.get(name) ?? null, ecrSd: null, moneyLeft: 1, slotsLeft: 1, pickShare: 0, leagueMoney: LEAGUE_MONEY,
})));
const priceOf = (p) => priceOfName(p.name, p.pos);

const vorRows = computeValues(points, resolveValueLeague(LG), 2);
const vor = new Map(vorRows.map((r) => [r.name, r.value]));

// --- STATE SAMPLING: replay a real V2 draft and snapshot our seat -----------------------------
const FLEX_OK = new Set(["RB", "WR", "TE"]);
const openIdxFor = (slots, pos) => {
  let i = slots.findIndex((s, k) => s === null && LG.slots[k] === pos);
  if (i >= 0) return i;
  if (FLEX_OK.has(pos)) { i = slots.findIndex((s, k) => s === null && LG.slots[k] === "FLEX"); if (i >= 0) return i; }
  return slots.findIndex((s, k) => s === null && LG.slots[k] === "BE");
};
const V2CFG = { values: Object.fromEntries(vor), starterReserve: 4, benchReserve: 1, premium: 2, aggr: 0.7, maxShare: 0.25, maxKDst: 2, benchDiscount: 0.25, inflation: true };

/** Every snapshot this seed produces, in draft order. Phases: 0/3/6/9 of OUR buys, plus `low$`. */
function statesFromSeed(seed) {
  const { picks } = draftFieldSeats(points, vor, V2CFG, seed, LG, { botBook: "price", botIdioSd: 0.2, strategy: "v2" });
  const teams = Array.from({ length: LG.teams }, () => ({ budget: LG.budget, slots: LG.slots.map(() => null) }));
  const gone = new Set();
  const out = [];
  const wantBuys = new Set([0, 3, 6, 9]);
  let lateDone = false;
  const snap = (phase) => {
    const mine = teams[0].slots.filter((s) => s != null).map((n) => byName.get(n)).filter(Boolean);
    const openSlots = LG.slots.filter((_s, k) => teams[0].slots[k] === null);
    const pool = board.filter((p) => !gone.has(p.name));
    const opponents = teams.slice(1).map((t, i) => ({
      id: `opp${i + 1}`, name: `opp${i + 1}`,
      roster: t.slots.filter((s) => s != null).map((n) => ({ ...byName.get(n) })),
    }));
    out.push({
      seed, phase, buys: mine.length, budget: teams[0].budget, mine, openSlots, pool, opponents,
      mySlotCounts: (() => { const c = {}; for (const s of openSlots) { const k = /^(BE|BENCH|IR|ER)$/i.test(s) ? "BENCH" : s; c[k] = (c[k] ?? 0) + 1; } return c; })(),
      leagueDollars: teams.reduce((a, t) => a + Math.max(0, t.budget), 0),
      leagueOpenSlots: teams.reduce((a, t) => a + t.slots.filter((s) => s === null).length, 0),
      teamsView: teams.map((t, k) => ({ name: String(k), budgetLeft: t.budget, openSlots: t.slots.filter((s) => s === null).length })),
    });
  };
  snap("empty");
  for (const pk of picks) {
    gone.add(pk.name);
    const t = teams[pk.team];
    const i = openIdxFor(t.slots, pk.pos);
    if (i >= 0) t.slots[i] = pk.name;
    t.budget -= pk.price;
    if (pk.team !== 0) continue;
    const buys = teams[0].slots.filter((s) => s != null).length;
    const open = teams[0].slots.filter((s) => s === null).length;
    if (wantBuys.has(buys)) { wantBuys.delete(buys); snap(`after${buys}`); }
    // LATE: the first moment we are down to $20 or to a single open slot, whichever comes first. V2
    // routinely finishes a draft with $60 unspent, so a budget-only rule silently produces no late
    // state at all for most seeds -- a phase that never fires reads exactly like a phase that agrees.
    else if (!lateDone && open >= 1 && (teams[0].budget <= 20 || open === 1)) { lateDone = true; snap("late"); }
  }
  return out;
}

// --- THE TWO BOOKS ON ONE STATE ---------------------------------------------------------------
const env = { weeks: ctx.weeks, vm, opts: ctx.opts, slots: ctx.slots, flexOk: ctx.flexOk, priceOf };

/** Simulated dollars -> pp, and pp -> dollars, from the ONE budget curve this state paid for. */
function ppFromDollars(curve, budget, d) {
  if (!(d > 0)) return 0;
  const top = curve[curve.length - 1].playoffs;
  const level = Math.max(0, budget - d);
  for (let i = curve.length - 1; i > 0; i--) {
    if (curve[i - 1].dollars <= level && level <= curve[i].dollars) {
      const span = curve[i].dollars - curve[i - 1].dollars;
      const f = span > 0 ? (level - curve[i - 1].dollars) / span : 0;
      return Math.max(0, top - (curve[i - 1].playoffs + f * (curve[i].playoffs - curve[i - 1].playoffs)));
    }
  }
  return Math.max(0, top - curve[0].playoffs);
}

function measure(st) {
  const mState = {
    roster: st.mine.map((p) => ({ ...p })), openSlots: [...st.openSlots], budget: Math.max(1, st.budget),
    pool: st.pool.map((p) => ({ ...p })), opponents: st.opponents, meId: "us", meName: "us",
  };
  const candidates = [...st.pool].sort((a, b) => (vor.get(b.name) ?? 0) - (vor.get(a.name) ?? 0) || b.proj - a.proj).slice(0, CANDS);
  if (!candidates.length || !st.openSlots.length) return null;

  // ONE BOOK, ONE BUDGET CURVE, ONE SET OF RANDOM NUMBERS, TWO FRAMINGS. Measuring the shared and
  // the per-candidate exclusions in two separate `MarginalBook`s would compare two samples of a
  // stochastic simulator and read the sampling difference as a framing difference.
  const book = new MarginalBook(mState, env, { trials: TRIALS, seed: BOOK_SEED, fillExclude: candidates.map((c) => c.name) });
  const curve = book.budgetCurve();
  const sim = new Map();
  for (const r of book.rank(candidates)) sim.set(r.name, r);
  const solo = new Map();
  for (const c of candidates) solo.set(c.name, book.marginal(c, new Set([c.name])));

  // --- the analytic book, from V3 itself ---
  const detail = new Map();
  const cfg = buildV3Config(points, LG, {
    byeOf: (n) => byeOf.get(n) ?? null,
    priceOf: (n, pos) => priceOfName(n, pos),
  });
  cfg.onDetail = (o) => detail.set(o.name, o);
  const strat = makeV3Strategy(cfg);
  const ref = (p) => ({ name: p.name, pos: p.pos, team: "", espnPreDraftVal: null });
  const dstate = {
    myBudget: st.budget, mySlots: { ...st.mySlotCounts },
    myRoster: st.mine.map(ref), myPosCounts: (() => { const c = {}; for (const p of st.mine) c[p.pos] = (c[p.pos] ?? 0) + 1; return c; })(),
    onBlock: null, currentOffer: null, secondsLeft: null, iAmHighBidder: false,
    board: st.pool.map(ref), teams: st.teamsView,
    leagueDollars: st.leagueDollars, leagueOpenSlots: st.leagueOpenSlots,
  };
  const rows = [];
  for (const c of candidates) {
    const dollars = strat.value(ref(c), dstate);
    const d = detail.get(c.name);
    const s = sim.get(c.name), so = solo.get(c.name);
    rows.push({
      name: c.name, pos: c.pos, vorRank: 0,
      anaDollars: dollars, anaPoints: d?.points ?? 0,
      simDollars: so?.dollars ?? 0, simPp: so?.playoffsPp ?? 0,
      shDollars: s?.dollars ?? 0, shPp: s?.playoffsPp ?? 0,
      anaPp: ppFromDollars(curve, mState.budget, dollars),
    });
  }
  // ROSTER-STATE FEATURES, carried on every row so Step 2 can ask whether the calibration needs them
  // rather than assuming it does. `openAtPos` is the number of slots this man could still start in.
  const openAtPos = (pos) => st.openSlots.filter((s) => s === pos
    || (["FLEX", "OP", "RB/WR", "WR/TE"].includes(s) && ["RB", "WR", "TE"].includes(pos))).length;
  rows.forEach((r, i) => {
    r.vorRank = i + 1;
    r.openAtPos = openAtPos(r.pos);
    r.openSlots = st.openSlots.length;
    r.budgetShare = st.budget / LG.budget;
    r.poolShare = st.pool.length / board.length;
  });
  return { rows, runs: book.runs, curve, budget: mState.budget };
}

// --- statistics --------------------------------------------------------------------------------
const rankOf = (xs) => {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
};
const pearson = (a, b) => {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
};
const spearman = (a, b) => pearson(rankOf(a), rankOf(b));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const BANDS = [["1-12", 1, 12], ["13-36", 13, 36], ["37-60", 37, CANDS]];

// The LEVEL, two ways, because a ratio of means is fragile exactly where the simulated marginal is
// smallest. `level` is the ratio of the sums (what a positional SHARE is made of); `levelMed` is the
// median of the per-candidate ratios among men the simulator prices at $5 or more, which cannot be
// carried by one state whose baseline happened to land badly. A conclusion should survive both.
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// A RATIO WHOSE DENOMINATOR IS AT THE NOISE FLOOR IS NOT A LEVEL, so it is refused rather than
// printed. A late state can price every candidate at zero dollars -- which is a real answer about
// that state, and dividing by it produces a number in the billions that reads like a finding.
const levelOf = (rows, key) => { const d = mean(rows.map((r) => r[key])); return d >= 1 ? mean(rows.map((r) => r.anaDollars)) / d : NaN; };
const levelMedOf = (rows, key) => median(rows.filter((r) => r[key] >= 5).map((r) => r.anaDollars / r[key]));
const f3 = (x, w) => (Number.isFinite(x) ? x.toFixed(3) : "n/a").padStart(w);
const f2 = (x, w) => (Number.isFinite(x) ? x.toFixed(2) : "n/a").padStart(w);
const f1 = (x, w) => (Number.isFinite(x) ? x.toFixed(1) : "n/a").padStart(w);
/** A state whose simulated book is flat at zero measures the TRIAL COUNT, not the surrogate. */
const usable = (rows) => rows.filter((r) => r.simDollars >= 1).length >= 8;

// --- run ---------------------------------------------------------------------------------------
const t0 = Date.now();
const states = [];
for (let s = 1; s <= SEEDS; s++) for (const st of statesFromSeed(s)) states.push(st);
console.log(`MARGINAL AGREEMENT -- ${states.length} roster states from ${SEEDS} V2 drafts, ` +
  `${CANDS} candidates each, simulated at ${TRIALS} trials (seed ${BOOK_SEED}), generated schedule`);
console.log(`  phases: ${[...new Set(states.map((s) => s.phase))].join(", ")}`);
console.log(`  the SIMULATED column is the PER-CANDIDATE exclusion (each man barred only from his own`);
console.log(`  baseline); the shared-exclusion book is carried alongside as the control.\n`);

const results = [];
let runs = 0;
// THE EMPTY STATE IS THE SAME STATE IN EVERY SEED -- no roster, the whole board, the full $200, and
// fifteen opponents who have bought nobody. Measuring it once per seed produces ten byte-identical
// copies, which would weight one state ten times over in the pooled tables and, worse, put the SAME
// rows on both sides of a train/test split that believes it is splitting by draft. It is measured
// once and said. Every other phase is genuinely different per seed, because the draft diverged.
const seen = new Set();
const distinct = states.filter((st) => {
  const k = `${st.phase}|${st.buys}|${st.budget}|${st.mine.map((p) => p.name).sort().join(",")}|${st.pool.length}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
if (distinct.length !== states.length) {
  console.log(`  ${states.length - distinct.length} duplicate states dropped (the empty state is identical in every seed)
`);
}
for (const st of (FROM ? [] : distinct)) {
  const m = measure(st);
  if (!m) { console.log(`  [skip] seed ${st.seed} ${st.phase}: no open slots or empty pool`); continue; }
  runs += m.runs;
  const sp = spearman(m.rows.map((r) => r.anaDollars), m.rows.map((r) => r.simDollars));
  const spSh = spearman(m.rows.map((r) => r.anaDollars), m.rows.map((r) => r.shDollars));
  const top3a = new Set([...m.rows].sort((x, y) => y.anaDollars - x.anaDollars).slice(0, 3).map((r) => r.name));
  const top3s = new Set([...m.rows].sort((x, y) => y.simDollars - x.simDollars).slice(0, 3).map((r) => r.name));
  const same = [...top3a].every((n) => top3s.has(n));
  const ok = usable(m.rows);
  results.push({ seed: st.seed, phase: st.phase, buys: st.buys, budget: st.budget, spearman: sp, spearmanShared: spSh, top3: same, usable: ok, rows: m.rows });
  console.log(`  seed ${String(st.seed).padStart(2)} ${st.phase.padEnd(7)} buys ${String(st.buys).padStart(2)} $${String(st.budget).padStart(3)}  ` +
    `rho ${f3(sp, 6)} (shared ${f3(spSh, 6)})  top3 ${same ? "same" : "diff"}  ` +
    `mean|d$| ${f1(mean(m.rows.map((r) => Math.abs(r.anaDollars - r.simDollars))), 5)}  ` +
    `level ${f3(levelOf(m.rows, "simDollars"), 6)}  ${ok ? "" : " DEGENERATE (simulated book flat at $0)"}` +
    `  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
// A state whose simulated book cannot separate anybody measures the trial count rather than the
// surrogate, so it is EXCLUDED and SAID -- never silently dropped, and never averaged in as agreement.
if (FROM) {
  const prior = JSON.parse(readFileSync(FROM, "utf8"));
  const k = (r) => `${r.phase}|${r.buys}|${r.budget}|${r.rows.map((x) => x.name).join(",")}`;
  const kept = new Set();
  for (const r of prior.states) { const key = k(r); if (!kept.has(key)) { kept.add(key); results.push(r); } }
  runs = prior.meta.runs;
  console.log(`  re-reported from ${FROM}: ${prior.states.length} states in, ${results.length} distinct
`);
}
const dead = results.filter((r) => !r.usable);
if (dead.length) console.log(`
  ${dead.length} of ${results.length} states excluded as degenerate: ` +
  dead.map((r) => `${r.seed}/${r.phase}`).join(", "));
const live = results.filter((r) => r.usable);

const all = live.flatMap((r) => r.rows.map((x) => ({ ...x, phase: r.phase, seed: r.seed })));
const byKey = (rows, key) => {
  const m = new Map();
  for (const r of rows) (m.get(r[key]) ?? m.set(r[key], []).get(r[key])).push(r);
  return [...m.entries()];
};
const table = (label, groups) => {
  console.log(`\n  ${label}`);
  console.log(`  ${"group".padEnd(10)} ${"n".padStart(5)} ${"rho".padStart(7)} ${"mean|d$|".padStart(9)} ${"mean d$".padStart(8)} ${"mean|dpp|".padStart(10)} ${"level".padStart(7)} ${"levelMed".padStart(9)}`);
  for (const [g, rows] of groups) {
    if (!rows.length) continue;
    console.log(`  ${g.padEnd(10)} ${String(rows.length).padStart(5)} ` +
      `${f3(spearman(rows.map((r) => r.anaDollars), rows.map((r) => r.simDollars)), 7)} ` +
      `${f1(mean(rows.map((r) => Math.abs(r.anaDollars - r.simDollars))), 9)} ` +
      `${f1(mean(rows.map((r) => r.anaDollars - r.simDollars)), 8)} ` +
      `${f2(mean(rows.map((r) => Math.abs(r.anaPp - r.simPp))), 10)} ` +
      `${f3(levelOf(rows, "simDollars"), 7)} ${f3(levelMedOf(rows, "simDollars"), 9)}`);
  }
};

const phaseOrder = ["empty", "after3", "after6", "after9", "late"];
// Per-STATE rho averaged, never a pooled one: pooling across states mixes the level differences
// BETWEEN states into a statistic that is supposed to be a within-state ranking.
console.log(`\n  BY PHASE (rho is the MEAN of the per-state rank correlations)`);
console.log(`  ${"phase".padEnd(8)} ${"states".padStart(6)} ${"mean rho".padStart(9)} ${"min rho".padStart(8)} ${"top3".padStart(6)} ${"mean|d$|".padStart(9)} ${"level".padStart(7)} ${"levelMed".padStart(9)}`);
for (const ph of phaseOrder) {
  const rs = live.filter((r) => r.phase === ph);
  if (!rs.length) continue;
  const rows = rs.flatMap((r) => r.rows);
  console.log(`  ${ph.padEnd(8)} ${String(rs.length).padStart(6)} ${f3(mean(rs.map((r) => r.spearman)), 9)} ` +
    `${f3(Math.min(...rs.map((r) => r.spearman)), 8)} ` +
    `${`${rs.filter((r) => r.top3).length}/${rs.length}`.padStart(6)} ` +
    `${f1(mean(rows.map((r) => Math.abs(r.anaDollars - r.simDollars))), 9)} ` +
    `${f3(levelOf(rows, "simDollars"), 7)} ${f3(levelMedOf(rows, "simDollars"), 9)}`);
}

table("BY POSITION (pooled)", byKey(all, "pos").sort((a, b) => b[1].length - a[1].length));
table("BY VOR RANK BAND (pooled)", BANDS.map(([g, lo, hi]) => [g, all.filter((r) => r.vorRank >= lo && r.vorRank <= hi)]));
table("BY PHASE (pooled -- read rho from the per-state table above)",
  phaseOrder.filter((p) => all.some((r) => r.phase === p)).map((p) => [p, all.filter((r) => r.phase === p)]));

// --- THE CONTROL: how much of this is the FRAMING rather than the surrogate? --------------------
// Same states, same random numbers, same analytic column -- only the simulated book's fill exclusion
// changes. If the two columns disagree the level number is a property of the harness, not of V3.
console.log(`\n  CONTROL -- the SHARED-exclusion book (the whole candidate set barred from the fill),`);
console.log(`  measured in the SAME invocation from the SAME random numbers`);
console.log(`  ${"group".padEnd(10)} ${"n".padStart(5)} ${"rho".padStart(7)} ${"level".padStart(7)} ${"levelMed".padStart(9)}`);
for (const [g, rows] of [["ALL", all], ...byKey(all, "pos").sort((a, b) => b[1].length - a[1].length)]) {
  console.log(`  ${g.padEnd(10)} ${String(rows.length).padStart(5)} ` +
    `${f3(spearman(rows.map((r) => r.anaDollars), rows.map((r) => r.shDollars)), 7)} ` +
    `${f3(levelOf(rows, "shDollars"), 7)} ${f3(levelMedOf(rows, "shDollars"), 9)}`);
}

// --- P56 ---------------------------------------------------------------------------------------
const phaseRho = phaseOrder.filter((p) => live.some((r) => r.phase === p))
  .map((p) => ({ phase: p, rho: mean(live.filter((r) => r.phase === p).map((r) => r.spearman)) }));
const posLevels = byKey(all, "pos").map(([pos, rows]) => ({
  pos, n: rows.length, level: levelOf(rows, "simDollars"), levelMed: levelMedOf(rows, "simDollars"),
  levelShared: levelOf(rows, "shDollars"),
}));
const worstPhase = phaseRho.reduce((a, b) => (b.rho < a.rho ? b : a));
const core = posLevels.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos));
const p56a = worstPhase.rho < 0.8;
const p56b = core.every((p) => p.level < 0.85);
console.log(`\n  P56 -- registered before this run. Recorded as measured; not tuned to.`);
console.log(`    (a) rank correlation below 0.8 in at least one roster-state phase: ${p56a ? "HELD" : "FAILED"}`);
console.log(`        worst phase ${worstPhase.phase} rho ${f3(worstPhase.rho, 0)}; by phase ` +
  phaseRho.map((p) => `${p.phase} ${f2(p.rho, 0)}`).join(", "));
console.log(`    (b) level ratio analytic/simulated below 0.85 at EVERY position: ${p56b ? "HELD" : "FAILED"}`);
console.log(`        ${core.map((p) => `${p.pos} ${f2(p.level, 0)}`).join(", ")}`);
console.log(`    P56 overall: ${p56a && p56b ? "HELD" : "FAILED"}`);

console.log(`\n  ${runs} simulateSeasons calls, ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min total`);
writeFileSync(OUT, JSON.stringify({
  meta: { seeds: SEEDS, trials: TRIALS, cands: CANDS, bookSeed: BOOK_SEED, states: results.length, runs, generatedAt: new Date().toISOString() },
  states: results, degenerate: dead.map((r) => `${r.seed}/${r.phase}`), p56: { a: p56a, b: p56b, worstPhase, phaseRho, posLevels },
}, null, 1));
console.log(`  wrote ${OUT}`);
