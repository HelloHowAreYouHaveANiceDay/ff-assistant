// DOES THE HANDCUFF BOARD'S EXPECTED VALUE PREDICT WHAT A HANDCUFF ACTUALLY DELIVERED?
//
// THE GAP THIS FILLS. `scripts/season-calibration.mjs` gates the season simulator, and it is
// STRUCTURALLY BLIND to the availability table: the served path resamples real weekly trajectories
// (`bootstrap`), which already carry the weeks a player missed, so `variance-model.json`'s `avail`
// is never consulted for the regular season. Proven by positive control -- forcing every `avail` to
// 0.50 leaves the playoff Brier identical to six decimals in all eight seasons.
//
// But `avail` IS the whole input to `leadMissProb`, which sets `missProb`, which multiplies straight
// into every handcuff EV and every depth-risk insurance number. So the number that drives "should I
// roster this backup" had no gate at all. This is that gate.
//
// WHAT IT SCORES. For each held-out season, the board predicts `expectedPts = lift x missed`. The
// season then says what the backup actually delivered: his points in the weeks the lead was absent,
// minus what he was scoring anyway. Predicted against realised, per pair.
//
// EVERY INPUT IS HINDSIGHT-FREE. Depth order, the projection proxy and the pool rank all come from
// the PRIOR season; the variance model is refit with the scored season EXCLUDED. A gate that ranked
// leads by what they went on to score would be grading the model on the answer sheet.
//
// THE TWO ARMS DIFFER IN EXACTLY ONE THING: the `avail` table behind `missProb`. `lift`, the pairs,
// the ordering of everything else are shared, so a difference in the result is attributable.
//
// Usage: node --import tsx scripts/handcuff-gate.mjs [--from 2005] [--to 2025] [--top 20]
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDCUFF_MODEL } from "../src/inseason/handcuff.js";
import { leadMissProb } from "../src/inseason/handcuff.js";
import { loadHistory, byeIndex, buildPairs, POS } from "./lib/handcuff-pairs.mjs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", 2005)), TO = Number(arg("--to", 2025)), TOPK = Number(arg("--top", 20));
/**
 * THE LEAD MUST BE A MAN SOMEBODY WOULD ACTUALLY ROSTER.
 *
 * The first cut of this gate called every team's best-by-prior-total at a position a "lead", and the
 * diagnostic caught it: 99.7% of those leads missed a week and they averaged 3.91 absences of 16, a
 * 24.4% miss rate against a model that says 7.4% for tier 0. That population is not elite starters,
 * it is "the least bad WR on this roster" -- marginal players who vanish from a week for a dozen
 * reasons that have nothing to do with injury.
 *
 * Scored that way the shipped arm looked beautifully calibrated (bias -0.03) via two large errors
 * that happened to cancel: a lift ~3.3x too high multiplied by a miss rate ~0.30x too low. A gate
 * whose sample does not match the decision produces exactly that kind of confident nonsense.
 *
 * `--lead-max-rank` restricts leads to the top N at their position by PRIOR-season rank -- the men a
 * handcuff question is ever asked about. 36 is three per fantasy roster in a 12-team league.
 */
const LEAD_MAX_RANK = Number(arg("--lead-max-rank", 36));
/**
 * THE PAIRS COME FROM `lib/handcuff-pairs.mjs` -- the SAME builder `handcuff-lift-screen.mjs` uses.
 *
 * They used to be built here, inline, and duplicated there. Two copies of a sample definition is how
 * two experiments come to disagree about QB and leave nobody able to say which one is wrong -- the
 * exact failure this repo keeps paying for. The docstrings for the two corrections that matter (the
 * rosterable-lead cut and the derived bye) now live with the builder, next to the code that applies
 * them, rather than being restated in each caller and drifting.
 *
 * VERIFIED BY CONTROL: swapping to the shared builder reproduced this gate's entire report
 * byte-for-byte. An extraction that changed a number would have been a silent resample.
 */
const H = loadHistory();
const BYE = byeIndex(H);

const tmp = mkdtempSync(join(tmpdir(), "hc-gate-"));
const fit = (mode, exclude) => {
  const out = join(tmp, `v-${mode}-${exclude}.json`);
  if (!existsSync(out)) {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/fit-variance.mjs"], {
      env: { ...process.env, TIER_MODE: mode, FIT_OUT_OVERRIDE: out, FIT_EXCLUDE: String(exclude) }, stdio: "pipe",
    });
  }
  return JSON.parse(readFileSync(out, "utf8"));
};

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const rows = { total: [], prior: [] };

const PAIRS = buildPairs(H, BYE, { from: FROM, to: TO, leadMaxRank: LEAD_MAX_RANK });

for (const season of [...new Set(PAIRS.map((p) => p.season))].sort((x, y) => x - y)) {
  const vm = { total: fit("total", season), prior: fit("prior", season) };

  for (const p of PAIRS.filter((x) => x.season === season)) {
    const lift = HANDCUFF_MODEL.backup * p.basePerWk + HANDCUFF_MODEL.lead * p.leadPerWk - p.basePerWk;
    // A non-positive lift is not a handcuff recommendation, so it is not a row this gate scores.
    // This is the GATE's filter, deliberately not the builder's -- the screen fits on those pairs.
    if (lift <= 0) continue;

    for (const armName of ["total", "prior"]) {
      const missProb = leadMissProb(vm[armName], p.pos, p.frac);
      rows[armName].push({
        season, pos: p.pos, lead: p.lead, backup: p.backup,
        predicted: lift * missProb * p.playable, realised: p.realised,
        leadMissedGames: p.leadMissedGames, missProb, playable: p.playable,
        depthOrder: p.depthOrder, lift,
      });
    }
  }
  process.stderr.write(`  ${season}: ${rows.total.filter((r) => r.season === season).length} pairs\n`);
}

const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  const num = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  const da = Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0)), db = Math.sqrt(b.reduce((s, x) => s + (x - mb) ** 2, 0));
  return da && db ? num / (da * db) : NaN;
};

console.log(`\nHANDCUFF GATE -- ${FROM}-${TO}, leave-season-out, n=${rows.total.length} (lead, backup) pairs`);

/**
 * EVERY METRIC IS SPLIT BY DEPTH ORDER, and that is not presentation.
 *
 * Depth-2 and depth-3 are different populations with different model behaviour, and pooling them was
 * this gate's first flaw -- it hid that the fitted lift is not merely too high but ORDERED BACKWARDS.
 * `HANDCUFF_MODEL` is one equation with no depth term:
 *
 *     lift = activePerWk - base = 0.402*lead - 0.078*base
 *
 * so a WORSE backup, having a smaller base, is handed a LARGER lift. The docstring in handcuff.ts
 * reports +4.42 pts/wk for depth-2 and +2.37 for depth-3 -- a split the shipped formula cannot
 * express, and whose direction it inverts. Pooled, those two errors average into a single wrong
 * number that looks like a calibration problem; split, it is visibly a SHAPE problem.
 *
 * The ALL row is kept so the pooled figures remain comparable to earlier runs, never as the headline.
 */
const DEPTHS = [{ k: 2, label: "depth-2" }, { k: 3, label: "depth-3" }, { k: null, label: "ALL" }];
const at = (armName, d) => (d == null ? rows[armName] : rows[armName].filter((x) => x.depthOrder === d));

// ---- 1. THE MISS RATE. A lead-level quantity, so it is IDENTICAL across depth by construction --
// the same lead appears once per backup. Reported once, split only to show that it does not move.
{
  console.log("\n  MISS RATE (per playable week) -- the quantity the two arms differ on");
  console.log("    depth        n     ACTUAL   shipped   fixed    shipped/act   fixed/act");
  for (const { k, label } of DEPTHS) {
    const r = at("total", k);
    if (!r.length) continue;
    const actual = mean(r.map((x) => x.leadMissedGames / x.playable));
    const ship = mean(at("total", k).map((x) => x.missProb));
    const fix = mean(at("prior", k).map((x) => x.missProb));
    console.log(`    ${label.padEnd(9)} ${String(r.length).padStart(5)}    ${actual.toFixed(3)}     ${ship.toFixed(3)}   ${fix.toFixed(3)}        ${(ship / actual).toFixed(2)}x        ${(fix / actual).toFixed(2)}x`);
  }
}

// ---- 2. THE LIFT. Where the depth split actually bites.
{
  console.log("\n  LIFT per week, model vs realised (pairs whose lead missed at least one week)");
  console.log("    depth        n   model   realised   ratio");
  for (const { k, label } of DEPTHS) {
    const g = at("total", k).filter((x) => x.leadMissedGames > 0);
    if (!g.length) continue;
    const modelLift = mean(g.map((x) => x.lift));
    const realisedLift = mean(g.map((x) => x.realised / x.leadMissedGames));
    console.log(`    ${label.padEnd(9)} ${String(g.length).padStart(5)}   ${modelLift.toFixed(2).padStart(5)}   ${realisedLift.toFixed(2).padStart(8)}   ${(modelLift / realisedLift).toFixed(2)}x`);
  }
  const d2 = at("total", 2).filter((x) => x.leadMissedGames > 0);
  const d3 = at("total", 3).filter((x) => x.leadMissedGames > 0);
  if (d2.length && d3.length) {
    const mOrder = mean(d2.map((x) => x.lift)) - mean(d3.map((x) => x.lift));
    const rOrder = mean(d2.map((x) => x.realised / x.leadMissedGames)) - mean(d3.map((x) => x.realised / x.leadMissedGames));
    console.log(`    ORDERING  model depth2-depth3 ${mOrder >= 0 ? "+" : ""}${mOrder.toFixed(2)}   realised ${rOrder >= 0 ? "+" : ""}${rOrder.toFixed(2)}` +
      `   ${Math.sign(mOrder) === Math.sign(rOrder) ? "same direction" : "*** INVERTED -- the model ranks the worse backup higher ***"}`);
  }
}

// ---- 2b. THE LIFT BY POSITION, because HANDCUFF_MODEL was not fitted on all four.
//
// handcuff.ts's own docstring says "depth-2 backup, LEAD BACK out: +4.42 pts/wk, 307 cases" -- a
// RUNNING BACK fit. The shipped formula carries no position term and `handcuffBoard` applies it to
// QB, RB, WR and TE alike. If RB depth-2 recovers something near the fitted number while the other
// positions do not, the lift is not simply "too high": it is an RB model being served at positions
// it was never measured on, and the fix is scoping rather than recalibration.
{
  console.log("");
  console.log("  LIFT by POSITION, depth-2 only (the case HANDCUFF_MODEL was fitted on)");
  console.log("    pos       n   model   realised   ratio");
  for (const pos of POS) {
    const g = at("total", 2).filter((x) => x.pos === pos && x.leadMissedGames > 0);
    if (!g.length) continue;
    const m = mean(g.map((x) => x.lift));
    const r = mean(g.map((x) => x.realised / x.leadMissedGames));
    console.log(`    ${pos.padEnd(4)} ${String(g.length).padStart(6)}   ${m.toFixed(2).padStart(5)}   ${r.toFixed(2).padStart(8)}   ${(m / r).toFixed(2)}x`);
  }
}

// ---- 3. THE EV, which is lift x rate and inherits both errors.
{
  console.log("\n  EXPECTED POINTS, predicted vs realised");
  console.log("    depth     arm        pred   realised      bias      MAE     corr");
  for (const { k, label } of DEPTHS) {
    for (const armName of ["total", "prior"]) {
      const r = at(armName, k);
      if (!r.length) continue;
      const pr = r.map((x) => x.predicted), ac = r.map((x) => x.realised);
      console.log(`    ${label.padEnd(9)} ${(armName === "total" ? "shipped" : "fixed").padEnd(8)} ${mean(pr).toFixed(2).padStart(6)} ${mean(ac).toFixed(2).padStart(10)} ${(mean(pr) - mean(ac)).toFixed(2).padStart(9)} ${mean(r.map((x) => Math.abs(x.predicted - x.realised))).toFixed(2).padStart(8)} ${corr(pr, ac).toFixed(3).padStart(8)}`);
    }
  }
}

// ---- 4. THE SAMPLE, so no row above is read without knowing what is in it.
{
  console.log("\n  SAMPLE");
  console.log("    depth     lead missed >=1wk   mean games missed   realised | missed   | never missed");
  for (const { k, label } of DEPTHS) {
    const r = at("total", k);
    if (!r.length) continue;
    const hurt = r.filter((x) => x.leadMissedGames > 0);
    console.log(`    ${label.padEnd(9)} ${(100 * hurt.length / r.length).toFixed(1).padStart(13)}%   ${mean(r.map((x) => x.leadMissedGames)).toFixed(2).padStart(17)}   ${mean(hurt.map((x) => x.realised)).toFixed(2).padStart(15)}   ${mean(r.filter((x) => x.leadMissedGames === 0).map((x) => x.realised)).toFixed(2).padStart(13)}`);
  }
}

// ---- 5. THE DECISION TEST. Ranking is what an owner actually uses -- "which handcuffs are worth a
// roster spot" -- so score the TOP-K by predicted EV against that depth's own population, per season.
{
  console.log(`\n  DECISION TEST: mean REALISED value of the top-${TOPK} by predicted EV, each season`);
  console.log("    depth     arm        top-K   population   edge");
  for (const { k, label } of DEPTHS) {
    for (const armName of ["total", "prior"]) {
      const perSeason = [];
      const all = at(armName, k);
      for (const season of [...new Set(all.map((x) => x.season))]) {
        const r = all.filter((x) => x.season === season).sort((a, b) => b.predicted - a.predicted);
        if (r.length < TOPK) continue;
        perSeason.push({ top: mean(r.slice(0, TOPK).map((x) => x.realised)), pop: mean(r.map((x) => x.realised)) });
      }
      if (!perSeason.length) { console.log(`    ${label.padEnd(9)} ${(armName === "total" ? "shipped" : "fixed").padEnd(8)}  (fewer than ${TOPK} pairs per season)`); continue; }
      const top = mean(perSeason.map((x) => x.top)), pop = mean(perSeason.map((x) => x.pop));
      console.log(`    ${label.padEnd(9)} ${(armName === "total" ? "shipped" : "fixed").padEnd(8)} ${top.toFixed(2).padStart(7)} ${pop.toFixed(2).padStart(12)}   ${(top - pop >= 0 ? "+" : "") + (top - pop).toFixed(2)}`);
    }
  }
}
