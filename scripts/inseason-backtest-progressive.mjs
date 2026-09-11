// PHASE 4 -- the honest evaluation of the progressive (role-trend) projection.
//
// Arbiter = DECISIONS, not accuracy: a projection-driven waiver (waiverByProjection) reading the
// progressive projector vs the same waiver reading the frozen line. Rigor:
//   - HOLDOUT: alpha is tuned on DESIGN seasons; the number quoted is on HELD-OUT seasons (winner's
//     curse). We also run the reverse split as a robustness check.
//   - BOTH SCORERS: realized rest-of-season AND sim-distributional. A real edge survives both.
//   - NEGATIVE CONTROLS on holdout: noise & shuffle must not beat frozen; alpha=0 must diverge on 0.
//   - DECISION POPULATION: reported on decisions where the projector diverged (the mechanism) AND over
//     all decisions (how often it matters).
//   node --import tsx scripts/inseason-backtest-progressive.mjs [--model served|floor]
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { waiverByProjection, hasRealDrop } from "../src/inseason/backtest/policies.ts";
import { frozenProjector, makeNoiseProjector, makeShuffleProjector } from "../src/inseason/backtest/projectors.ts";
import { makeProgressiveProjector, makeRegimeProjector } from "../src/inseason/backtest/progressive.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const admit = (s) => s.freeAgents.length > 0 && hasRealDrop(s);
const baseline = waiverByProjection(frozenProjector);
const run = (variantProjector, seasons, scorer) => backtestPolicies(db, {
  leagueId: lg.league_id, seasons, model, baseline, variant: waiverByProjection(variantProjector), scorer, admit,
});
const ALPHAS = [0.25, 0.5, 0.75, 1.0, 1.5];

// Tune alpha on `design` by realized meanDiff; return the winner. `mk(alpha)` builds the projector.
function tune(design, mk) {
  const grid = ALPHAS.map((a) => ({ a, r: run(mk(a), design, undefined) }));
  grid.sort((x, y) => y.r.meanDiff - x.r.meanDiff);
  return { best: grid[0].a, grid };
}

function report(label, design, holdout, mk) {
  const { best, grid } = tune(design, mk);
  console.log(`\n== ${label} ==  design=${design.join(",")}  holdout=${holdout.join(",")}`);
  console.log("  alpha grid on DESIGN (realized meanDiff/decision):");
  for (const g of ALPHAS.map((a) => grid.find((x) => x.a === a)))
    console.log(`     alpha ${g.a.toFixed(2)}:  ${g.r.meanDiff.toFixed(3).padStart(7)}   (differed ${g.r.differed})${g.a === best ? "  <- chosen" : ""}`);
  const hReal = run(mk(best), holdout, undefined);
  const hSim = run(mk(best), holdout, makeSimExpectedScorer(db, { trials: 150 }));
  const ln = (r, s) => `     ${s.padEnd(14)} meanDiff ${r.meanDiff.toFixed(3).padStart(7)}  whereDiffer ${r.meanDiffWhereDiffer.toFixed(2).padStart(6)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (differed ${r.differed}/${r.evaluated})`;
  console.log(`  HOLDOUT at chosen alpha=${best}:`);
  console.log(ln(hReal, "realized"));
  console.log(ln(hSim, "sim (distr.)"));
  return { best, hReal, hSim };
}

const A = [2018, 2019, 2020, 2021], B = [2022, 2023, 2024];
const models = {
  "PHASE 2 progressive (smooth role/to-date ratio)": (a) => makeProgressiveProjector(db, { alpha: a }),
  "PHASE 3 regime (change-point vs pre-change baseline)": (a) => makeRegimeProjector(db, { alpha: a }),
};
console.log(`PROGRESSIVE PROJECTION -- decision value vs the frozen line. ${model} model.`);
console.log(`  + => re-scaling the frozen line by role trend made a better waiver add.`);
const results = {};
for (const [name, mk] of Object.entries(models)) {
  console.log(`\n#### ${name}`);
  const fwd = report("SPLIT 1 (tune early, test late)", A, B, mk);
  const rev = report("SPLIT 2 (tune late, test early)", B, A, mk);
  results[name] = { fwd, rev };
}

// -- negative controls & identity on the full sample (holdout-agnostic sanity) --
const all = [...A, ...B];
const noise = run(makeNoiseProjector(), all, undefined);
const shuffle = run(makeShuffleProjector(db), all, undefined);
const ident = run(makeProgressiveProjector(db, { alpha: 0 }), all, undefined);
console.log(`\n== CONTROLS (full sample) ==`);
console.log(`  noise   meanDiff ${noise.meanDiff.toFixed(2)}  CI [${noise.bootstrap.lo.toFixed(2)}, ${noise.bootstrap.hi.toFixed(2)}]  (must not beat frozen)`);
console.log(`  shuffle meanDiff ${shuffle.meanDiff.toFixed(2)}  CI [${shuffle.bootstrap.lo.toFixed(2)}, ${shuffle.bootstrap.hi.toFixed(2)}]  (must not beat frozen)`);
console.log(`  alpha=0 divergences ${ident.differed}  (must be 0 -- knob-off identity)`);

const holds = (r) => r.hReal.bootstrap.lo > 0 && r.hSim.bootstrap.lo > 0;
console.log(`\n== VERDICTS (pre-registered bar: CI excluding 0 on BOTH splits under BOTH scorers) ==`);
for (const [name, { fwd, rev }] of Object.entries(results))
  console.log(`  ${holds(fwd) && holds(rev) ? "SURVIVES" : "REFUTED "}  ${name}`);
db.close();
