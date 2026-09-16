// HOW WRONG IS A REAL SNAKE ROOM? -- the `marketSd` analogue, measured instead of asserted (M2e).
//
// WHAT THIS ANSWERS. `data/formats/sc-a845f67652fb/golden.json` pins the Yahoo format's gate at 99.2%
// playoffs / 39.8% titles, and its own `_saturation` note says the whole number rests on ONE asserted
// constant: `marketSd 0.30`, swept 0.30 -> 40.0% titles, 0.15 -> 24.8%, 0.05 -> 13.4%. CLAUDE.md
// already flags that constant as "an assumption `calibrate` never measures". This measures it against
// league 129048's OWN draft, which `scripts/yahoo-draft-ingest.mjs` put in the store.
//
// WHAT `marketSd` IS, EXACTLY, in the arm the golden pins. `ff backtest --no-lookahead` sets our
// projection error to ZERO (`noLookahead ? 0 : ourSd`) and our book to the PRIOR SEASON'S ACTUALS.
// The room then drafts off `prior-season actuals x (1 + e)`, one shared draw `e ~ N(0, marketSd)` per
// player. So `marketSd` is not "how wrong is a projection" in the abstract -- it is THE DISPERSION OF
// THE ROOM'S ORDERING AROUND A PRIOR-SEASON-ACTUALS VOR BOOK, and that is a quantity a real draft log
// can be compared against directly. The estimator below is built to be that quantity and nothing else.
//
// THE ESTIMATOR: SIMULATION-BASED METHOD OF MOMENTS, not a closed form.
//   1. Compute a dispersion statistic T on the REAL draft: how far each pick landed from where our
//      book would have put it.
//   2. Compute the SAME statistic on drafts simulated by `runSnakeDraft` -- the very model the gate
//      runs -- at a grid of marketSd values.
//   3. Read off the marketSd whose simulated T matches the real T, by linear interpolation on the
//      ASCENDING branch, with an interval from the simulation's own trial-to-trial spread.
//   4. PROVE THE WHOLE PIPELINE CAN RETURN THE RIGHT ANSWER: `--self-test X` replaces the real draft
//      with a simulated one at a known X and requires X back. Measured: biased low by 0.02-0.04 over
//      0.15-0.30, and NO RESOLUTION ABOVE ~0.40 (a true 0.50 reads 0.81 / off-grid / 0.36).
// Step 2 is what makes this honest. A closed-form estimate of "the noise that produced this order"
// would have to correct for the serpentine, for positional need, for the bench rule and for the
// legality rule by hand; the simulator already contains all four, so the correction is exact by
// construction rather than approximate by argument.
//
// THREE STATISTICS, because one statistic cannot notice that it is wrong:
//   rankGap     sd of (draft position - our book's rank) over EVERY drafted pick. Reported, never
//               fitted -- the real draft is outside the range the room model can produce at all, for
//               a structural reason `stats()` explains. That is a finding, not a nuisance.
//   rankGapTop  the same gap over the POSITIVE-VOR picks, ranked among themselves -- the region the
//               room model can actually represent.
//   logGap      sd of log(V_j / v(p)), where the player taken j-th is credited with the j-th largest
//               book VALUE in the drafted set. This is the log-ratio the brief asks for and it is in
//               the same units as marketSd itself; also positive-VOR only, coverage printed.
// They are different functions of the same draft; if they disagree about marketSd, the disagreement
// is the finding.
//
//   npx tsx scripts/snake-room-error.mjs [--league 129048] [--season 2026] [--trials 40]
//         [--bot-noise 0.20] [--grid 0,0.1,...] [--json <path>] [--self-test <known marketSd>]
import { readFileSync, writeFileSync } from "node:fs";
import { openDb } from "../src/db/db.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";
import { resolveFormat } from "../src/data/formatResolve.ts";
import { filterToStartable, nameKey, resolveValueLeague } from "../src/draft/values.ts";
import { runSnakeDraft, vorBook, draftRounds } from "../src/draft/draftModel.ts";
import { mulberry32 } from "../src/draft/sim.ts";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const leagueId = arg("--league", "129048");
const season = Number(arg("--season", 2026));
const trials = Number(arg("--trials", 40));
const botNoise = Number(arg("--bot-noise", 0.20));
const grid = (arg("--grid") ?? "0,0.05,0.10,0.15,0.20,0.25,0.30,0.40,0.50,0.65,0.80,1.00").split(",").map(Number);
const jsonOut = arg("--json");

// ------------------------------------------------------------------------------------------------
// The pool and our book -- built the way `ff backtest --no-lookahead` builds them, from the same file.
// ------------------------------------------------------------------------------------------------
const db = openDb();
const ctx = resolveLeagueContext(db, leagueId);
const fmt = resolveFormat(db, leagueId);
const cfg = ctx.config;
const lg = { teams: Number(cfg.teams), budget: Number(cfg.budget ?? 0), slots: cfg.slots };
const valueLeague = resolveValueLeague(lg);
const rounds = draftRounds(lg.slots);

const priorSeason = season - 1;
const pointsPath = fmt.model.require("history-points");
const pool0 = [];
for (const line of readFileSync(pointsPath, "utf8").trim().split(/\r?\n/).slice(1)) {
  const f = line.split(",");
  if (Number(f[0]) !== priorSeason) continue;
  pool0.push({ name: f[1].trim(), pos: f[2].trim().toUpperCase(), points: Number(f[3]) });
}
if (!pool0.length) throw new Error(`${pointsPath} holds no ${priorSeason} rows -- the no-lookahead book for ${season} cannot be built.`);
// The same pool filter `runBacktest` applies before anything else: a position the league has no slot
// for never enters the harness.
const pool = filterToStartable(pool0, valueLeague);
const ourBook = vorBook(pool, valueLeague);
const byKey = new Map();
for (const p of pool) byKey.set(nameKey(p.name), p);

// ------------------------------------------------------------------------------------------------
// The real draft.
// ------------------------------------------------------------------------------------------------
const real = db.prepare("SELECT pick_no, team_id, name, pos FROM raw_league_pick WHERE league_id=? AND season=? ORDER BY pick_no").all(leagueId, season);
db.close();
if (!real.length) throw new Error(`raw_league_pick holds no ${season} picks for league ${leagueId} -- run scripts/yahoo-draft-ingest.mjs first.`);
if (real.length !== lg.teams * rounds) console.log(`  NOTE: ${real.length} real picks against ${lg.teams} x ${rounds} = ${lg.teams * rounds} simulated ones.`);

// COVERAGE, and it is a real limit rather than a footnote. Our book for season Y is season Y-1's
// actuals, so a player with no Y-1 season -- every rookie, and anyone who missed the year -- is not
// in it at all. The backtest handles that with draft-capital rookie injection; this estimator cannot
// (the injection prices a rookie from the season's own actuals, which for a season in progress do not
// exist yet), so those picks are DROPPED and the drop rate is printed. The statistic is computed on
// the covered picks' order among THEMSELVES, which is why dropping them shifts nothing: it is a rank
// correlation between two orderings of the same set.
const covered = [];
for (const r of real) { const p = byKey.get(nameKey(r.name)); if (p) covered.push({ ...r, pos: p.pos, points: p.points, value: ourBook.get(p.name) ?? 0 }); }
console.log(`league ${leagueId} season ${season}: ${real.length} real picks, ${covered.length} in the ${priorSeason}-actuals pool (${(100 * covered.length / real.length).toFixed(0)}%), ${real.length - covered.length} dropped (no ${priorSeason} season).`);

// THE POSITIVE CONTROL. `--self-test X` throws the real draft away and puts a SIMULATED draft at a
// KNOWN marketSd X in its place, so the whole pipeline -- statistic, thinning, grid, inversion --
// has to hand X back. Without it a fit near 0.30 proves nothing: an estimator that always answers
// "about 0.3" whatever it is shown is indistinguishable from one that measured something, and this
// repo has shipped that shape of defect before (a guard that can only ever say one thing). The
// control runs on a seed OUTSIDE the grid's own seed block so it is not scoring itself on a draft
// the curve was built from.
const selfTest = arg("--self-test");

/** VOR POINTS BELOW WHICH OUR BOOK IS THE FLOORED TAIL. `vorBook` floors a sub-replacement player at
 *  0 and orders that tail only by a 1e-4-per-point tie-break, so anything under a point of VOR is a
 *  player our book has no real opinion about. Both the log statistic and the `Top` rank statistic are
 *  restricted to players above it -- see `rankGapTop` for why that restriction is not optional. */
const FLOOR = 1.0;

/** `sd` of a list, and the count, in one pass. */
function sdOf(xs) {
  const n = xs.length || 1;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n);
}

/** The gap sd between two orderings of the same list: position in `order` vs rank by book value. */
function gapSd(order) {
  const rankOf = new Map();
  [...order].sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name)))
    .forEach((x, i) => rankOf.set(x, i + 1));
  return sdOf(order.map((x, j) => (j + 1) - rankOf.get(x)));
}

/**
 * THE THREE STATISTICS, over one ordered list of drafted players (`order` is the draft order, each
 * entry carrying the book `value` of that player).
 *
 *   rankGap     over EVERY covered pick. Reported and deliberately NOT used to fit -- see below.
 *   rankGapTop  the same gap, over the positive-VOR picks only, ranked among themselves.
 *   logGap      sd of log(V_j / v(p)): the player taken j-th is credited with the j-th largest book
 *               value in the set, so this is the implied log error, in marketSd's own units.
 *
 * WHY `rankGap` CANNOT BE FITTED, AND WHY THAT IS A FINDING RATHER THAN A NUISANCE. The real draft's
 * full-set rankGap (44.3) is HIGHER than the simulated room produces at ANY marketSd -- it is still
 * above the value at 1.00, where the room is nearly drafting at random. The reason is structural, not
 * statistical: `vorBook` prices every sub-replacement player at exactly 0 plus a tie-break, and the
 * room's error is MULTIPLICATIVE on points, so a noised zero is still a zero. The model therefore
 * drafts the last five rounds in almost book order however large marketSd is, while the real room
 * drafts them in an order our book has no opinion about at all. No value of the constant can close
 * that gap; it is a limit of the room model, and it is reported instead of being fitted away.
 */
function stats(order) {
  const n = order.length;
  const sorted = [...order].map((x) => x.value).sort((a, b) => b - a);
  const rankGap = gapSd(order);
  const top = order.filter((x) => x.value > FLOOR);
  const rankGapTop = top.length > 2 ? gapSd(top) : NaN;
  const ls = [];
  for (let j = 0; j < n; j++) {
    const v = order[j].value, V = sorted[j];
    if (v > FLOOR && V > FLOOR) ls.push(Math.log(V / v));
  }
  return { rankGap, rankGapTop, logGap: sdOf(ls), logN: ls.length, topN: top.length, n };
}

// ------------------------------------------------------------------------------------------------
// The simulated room, at a grid of shared-error values.
// ------------------------------------------------------------------------------------------------
//
// A HOMOGENEOUS ROOM ON PURPOSE. `runSnakeDraft` gives seat 0 OUR book with no idiosyncratic noise;
// that is the edge the backtest measures, and it is not part of the room. The real draft's twelve
// seats are twelve real managers, so the simulated draft's twelve seats are given the room's book
// too -- `ours.values` is set to the room's own book. What is being measured here is the ROOM, and a
// seat playing our strategy inside it would bias the dispersion down by exactly our edge.
function gauss(rng) { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function simulate(sd, seed) {
  const rngM = mulberry32(seed * 104729 + 3);
  const projMarket = pool.map((p) => ({ ...p, points: Math.max(0, p.points * (1 + gauss(rngM) * sd)) }));
  const roomValues = vorBook(projMarket, valueLeague);
  const log = [];
  runSnakeDraft(projMarket, lg, { botBook: "vor", botIdioSd: botNoise }, { values: roomValues, cfg: {}, slot: 0 }, seed, { log });
  // Scored against OUR book (the un-noised pool), exactly as the real draft is.
  return log.sort((a, b) => a.pick - b.pick).map((p) => ({ name: p.name, value: ourBook.get(p.name) ?? 0 }));
}

// SAME-SIZE COMPARISON. The real statistic is computed on `covered.length` picks and a simulated
// draft has `teams x rounds`; a rank-gap sd grows with the number of items, so the simulated draft is
// thinned to the same count before the statistic is taken. Thinning is UNIFORM over the draft (every
// k-th pick), not "the first M": dropping the tail would delete exactly the region where the room is
// most disorderly and would bias every estimate down. It is deterministic, so it adds no variance of
// its own to the curve. What it does NOT model is that the real draft's missing picks are ROOKIES,
// which cluster by round rather than spreading evenly -- a second-order effect on a rank statistic
// computed within the surviving set, and stated rather than assumed away.
function thin(order, m) {
  if (order.length <= m) return order;
  const step = order.length / m;
  const out = [];
  for (let i = 0; i < m; i++) out.push(order[Math.floor(i * step)]);
  return out;
}

// THE DRAFT BEING FITTED: the real one, or -- under `--self-test X` -- a simulated one at a KNOWN X,
// thinned the same way, so the control exercises the identical pipeline end to end.
const subject = selfTest == null
  ? covered.map((c) => ({ name: c.name, value: c.value }))
  : thin(simulate(Number(selfTest), 987654), covered.length);
const realStats = stats(subject);
console.log(selfTest == null
  ? `REAL draft: rankGap sd = ${realStats.rankGap.toFixed(2)} over ${realStats.n} picks;`
  : `SELF-TEST on a SIMULATED draft at a known marketSd ${selfTest} (seed 987654, outside the grid's seed block):\n            rankGap sd = ${realStats.rankGap.toFixed(2)} over ${realStats.n} picks;`);
console.log(`            rankGapTop sd = ${realStats.rankGapTop.toFixed(2)} over ${realStats.topN} positive-VOR picks;`);
console.log(`            logGap sd = ${realStats.logGap.toFixed(3)} over ${realStats.logN} positive-VOR picks.`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const curve = [];
for (const sd of grid) {
  const rg = [], rgt = [], lgp = [], topN = [];
  for (let t = 0; t < trials; t++) {
    const s = stats(thin(simulate(sd, 1000 + t), covered.length));
    rg.push(s.rankGap); rgt.push(s.rankGapTop); lgp.push(s.logGap); topN.push(s.topN);
  }
  curve.push({
    sd, rankGap: mean(rg), rankGapSd: sdOf(rg), rankGapTop: mean(rgt), rankGapTopSd: sdOf(rgt),
    logGap: mean(lgp), logGapSd: sdOf(lgp), topN: mean(topN),
  });
  console.log(`  marketSd ${sd.toFixed(2)}: rankGap ${mean(rg).toFixed(2)} (+/-${sdOf(rg).toFixed(2)})  ` +
    `rankGapTop ${mean(rgt).toFixed(2)} (+/-${sdOf(rgt).toFixed(2)}, n~${mean(topN).toFixed(0)})  ` +
    `logGap ${mean(lgp).toFixed(3)} (+/-${sdOf(lgp).toFixed(3)})`);
}

/**
 * Invert by linear interpolation, ON THE ASCENDING BRANCH ONLY. Returns null when the target is off
 * the grid -- an extrapolated answer here would be a number with no simulation behind it.
 *
 * THE BRANCH RESTRICTION IS NOT COSMETIC. `rankGapTop` is NOT monotone in marketSd: it rises to a
 * maximum near 0.50 and then FALLS, because past that point the noise starts pushing sub-replacement
 * players above the floor and the "positive-VOR" set the statistic is computed on stops being the
 * same set (`topN` in the printout drops from ~107 to ~80). A statistic with two roots has two
 * answers, and the upper one corresponds to a room so noisy it drafts kickers in round 2. The fit is
 * taken on the branch below the maximum and the maximum is printed so the restriction is visible.
 */
function invert(key, target) {
  let top = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i][key] > curve[top][key]) top = i;
  for (let i = 1; i <= top; i++) {
    const a = curve[i - 1], b = curve[i];
    if ((a[key] - target) * (b[key] - target) <= 0 && a[key] !== b[key]) {
      return a.sd + (target - a[key]) * (b.sd - a.sd) / (b[key] - a[key]);
    }
  }
  return null;
}

const fitRank = invert("rankGap", realStats.rankGap);
const fitRankTop = invert("rankGapTop", realStats.rankGapTop);
const fitLog = invert("logGap", realStats.logGap);
// The interval comes from the SIMULATION's own trial-to-trial spread at the fitted point: the grid
// point nearest the fit, +/- one sd of its statistic, inverted. It is a "how precisely can this
// estimator locate the constant" interval, NOT a sampling interval over drafts -- there is one draft.
function band(key, target) {
  const near = curve.reduce((a, b) => (Math.abs(b[key] - target) < Math.abs(a[key] - target) ? b : a));
  const w = near[`${key}Sd`];
  return [invert(key, target + w), invert(key, target - w)].sort((a, b) => (a ?? -1e9) - (b ?? -1e9));
}
const show = (k, fit) => {
  const b = band(k, realStats[k]).map((x) => (x == null ? null : Number(x.toFixed(3))));
  console.log(`FITTED marketSd (${k.padEnd(10)}) = ${fit == null ? "OFF GRID -- the real draft is outside the range this statistic can reach" : fit.toFixed(3)}   band ${JSON.stringify(b)}`);
};
console.log("");
show("rankGap", fitRank);
show("rankGapTop", fitRankTop);
show("logGap", fitLog);
console.log(`ASSERTED marketSd = 0.30 (data/formats/sc-a845f67652fb/golden.json)`);

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ leagueId, season, priorSeason, botNoise, trials, realPicks: real.length, covered: covered.length, realStats, curve, fitRank, fitRankTop, fitLog, band: { rankGapTop: band("rankGapTop", realStats.rankGapTop), logGap: band("logGap", realStats.logGap) } }, null, 2)}\n`);
  console.log(`  wrote ${jsonOut}`);
}
