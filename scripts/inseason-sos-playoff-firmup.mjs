// FIRM UP the one live lead: playoff-week SOS -> playoff-week value. Two hardening checks the first
// pass lacked:
//   (1) FIXED beta=1 (pre-registered, no tuning) over ALL 7 seasons pooled -> more power, no winner's
//       curse from beta selection.
//   (2) The SIM-DISTRIBUTIONAL playoff scorer (injury/variance-aware, weeks 15-17) alongside realized.
//       A real edge survives the distributional scorer; role trend and full-RoS SOS did not.
//   node --import tsx scripts/inseason-sos-playoff-firmup.mjs
import { openDb } from "../src/db/db.ts";
import { backtestPolicies, realizedRestOfSeason } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { waiverByProjection, hasRealDrop } from "../src/inseason/backtest/policies.ts";
import { frozenProjector } from "../src/inseason/backtest/projectors.ts";
import { makeSosProjector } from "../src/inseason/backtest/sos.ts";

const db = openDb();
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
const ALL = [2018, 2019, 2020, 2021, 2022, 2023, 2024];
const admit = (s) => s.freeAgents.length > 0 && hasRealDrop(s);
const base = waiverByProjection(frozenProjector);
const variant = waiverByProjection(makeSosProjector(db, { beta: 1, playoff: true })); // FIXED beta, no tuning

// playoff-window scorers (weeks 15-17): realized actuals, and sim-distributional.
const realizedPlayoff = { name: "realized 15-17", score: (r, ctx) => realizedRestOfSeason(r, { ...ctx, fromWeek: 15, toWeek: 17 }) };
const simBase = makeSimExpectedScorer(db, { trials: 200 });
const simPlayoff = { name: "sim 15-17", score: (r, ctx) => simBase.score(r, { ...ctx, fromWeek: 15, toWeek: 17 }) };

const run = (scorer, seasons) => backtestPolicies(db, { leagueId: lg.league_id, seasons, model: "served", baseline: base, variant, scorer, admit });
const line = (r, label) => `  ${label.padEnd(18)} meanDiff ${r.meanDiff.toFixed(3).padStart(7)}  whereDiffer ${r.meanDiffWhereDiffer.toFixed(2).padStart(6)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (differed ${r.differed}/${r.evaluated})`;

console.log(`\nPLAYOFF-SOS FIRM-UP -- fixed beta=1, all seasons ${ALL[0]}-${ALL.at(-1)} pooled, playoff-week value (15-17)\n`);
const rReal = run(realizedPlayoff, ALL);
const rSim = run(simPlayoff, ALL);
console.log(line(rReal, "realized playoff"));
console.log(line(rSim, "sim playoff"));

console.log(`\n  per-season (realized playoff-week diff/decision):`);
for (const s of rReal.perSeason) console.log(`    ${s.season}: ${s.meanDiff.toFixed(2).padStart(6)}  (differed ${s.differed})`);

const solid = rReal.bootstrap.lo > 0 && rSim.bootstrap.lo > 0;
console.log(`\n  VERDICT: ${solid
  ? "FIRM -- positive with CI clear of 0 under BOTH the realized AND the distributional playoff scorer."
  : "still PLAUSIBLE not proven -- " + (rSim.bootstrap.lo > 0 ? "survives sim" : "does NOT clear the distributional scorer") + "; treat as a copilot signal, not an automated edge."}`);
db.close();
