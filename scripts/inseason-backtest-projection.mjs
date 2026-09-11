// PHASE 0 -- the guillotine. Before building any progressive projection, prove the decision harness
// can SEE projection quality and cannot be FOOLED. A projection-driven waiver (waiverByProjection) is
// A/B'd: baseline reads the frozen season line, variant reads a control projector.
//   PASS iff: oracle beats frozen with CI clear of 0; noise & shuffle do NOT; frozen-vs-frozen == 0.
//   node --import tsx scripts/inseason-backtest-projection.mjs [--seasons 2018-2024] [--model served|floor]
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { waiverByProjection, hasRealDrop, dropBest } from "../src/inseason/backtest/policies.ts";
import { frozenProjector, makeOracleProjector, makeNoiseProjector, makeShuffleProjector } from "../src/inseason/backtest/projectors.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2024");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
if (!lg) { console.error("no league synced"); process.exit(2); }

const admit = (s) => s.freeAgents.length > 0 && hasRealDrop(s);
const baseline = waiverByProjection(frozenProjector);
const run = (variantProjector) => backtestPolicies(db, {
  leagueId: lg.league_id, seasons, model,
  baseline, variant: waiverByProjection(variantProjector), control: dropBest, admit,
});

const controls = [
  ["oracle", makeOracleProjector(db)],
  ["noise", makeNoiseProjector()],
  ["shuffle", makeShuffleProjector(db)],
  ["frozen", frozenProjector],
];

console.log(`\nPHASE 0 GUILLOTINE -- can the harness see projection quality? ${model} model, seasons ${seasonsArg}`);
console.log(`  A/B: waiver-by-projection(variant) vs waiver-by-projection(frozen). + => variant's projection made a better add.\n`);
console.log("  variant   meanDiff/dec   CI [lo, hi]        P(better)   differed   verdict");
const results = {};
for (const [name, proj] of controls) {
  const r = run(proj);
  results[name] = r;
  const ci = `[${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]`;
  console.log(`  ${name.padEnd(9)} ${r.meanDiff.toFixed(3).padStart(7)}       ${ci.padEnd(16)}  ${(100 * r.bootstrap.pVariantBetter).toFixed(0).padStart(3)}%       ${String(r.differed).padStart(4)}`);
}

// -- the kill conditions, asserted --
const oracle = results.oracle, noise = results.noise, shuffle = results.shuffle, frozen = results.frozen;
const checks = [
  ["oracle beats frozen, CI clear of 0", oracle.meanDiff > 0 && oracle.bootstrap.lo > 0],
  ["oracle effect is large (> 1 pt/decision)", oracle.meanDiff > 1],
  ["noise does NOT beat frozen (CI includes/below 0)", noise.bootstrap.lo <= 0],
  ["shuffle does NOT beat frozen (CI includes/below 0)", shuffle.bootstrap.lo <= 0],
  ["frozen-vs-frozen diverges on ZERO decisions", frozen.differed === 0 && frozen.meanDiff === 0],
  ["positive control (drop-best) is strongly negative", oracle.control && oracle.control.meanDiff < -1],
];
console.log(`\n  KILL CONDITIONS:`);
let allPass = true;
for (const [label, ok] of checks) { console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}`); allPass = allPass && ok; }
console.log(`\n  PHASE 0 ${allPass ? "PASSES -- the harness can see a better projection and rejects noise. Safe to build the model." : "FAILS -- do NOT build on this harness until it can see the oracle and reject noise."}`);
db.close();
process.exit(allPass ? 0 : 1);
