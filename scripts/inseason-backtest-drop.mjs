// Drop-selection A/B on the reusable decision harness: value-min (baseline) vs depth-aware (variant),
// scored by realized rest-of-season lineup value under common random numbers, season-as-unit.
// See src/inseason/backtest/{harness,policies}.ts. Usage:
//   node --import tsx scripts/inseason-backtest-drop.mjs [--seasons 2018-2025] [--model served|floor]
//     [--protect QB,TE,K,DST]   (omit to run the per-position diagnostic + tuned policy) [--league <id>]
//
// WHICH LEAGUE (D-2, 2026-09-16 -- D25.2's fix applied to this sibling). This picked its league with
// `ORDER BY last_synced_at DESC LIMIT 1`, which on a two-league store returns whichever league synced
// last (Yahoo 129048, zero `fact_roster_week` rows for these seasons) -- so the harness scored ZERO
// decisions and printed a confident `0.000`. It now resolves the ACTIVE league through the one
// resolver, takes `--league <id>`, and REFUSES an empty decision set rather than scoring it.
import { openDb } from "../src/db/db.ts";
import { backtestPolicies } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { valueMinDrop, depthAwareDrop, dropBest, hasRealDrop } from "../src/inseason/backtest/policies.ts";
import { resolveLeagueContext, requireLeagueId } from "../src/data/leagueContext.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const seasonsArg = arg("--seasons", "2018-2025");
const [lo, hi] = seasonsArg.split("-").map(Number);
const seasons = []; for (let y = lo; y <= (hi ?? lo); y++) seasons.push(y);
const model = arg("--model", "served");
const db = openDb(arg("--db", undefined));
const leagueId = requireLeagueId(resolveLeagueContext(db, arg("--league", undefined)), "inseason-backtest-drop");

const scorer = arg("--scorer", "realized") === "sim" ? makeSimExpectedScorer(db, { trials: 200, leagueId }) : undefined;
const run = (protect, control) => backtestPolicies(db, {
  leagueId, seasons, model, scorer,
  baseline: valueMinDrop, variant: depthAwareDrop(protect), control, admit: hasRealDrop,
});
// AN EMPTY DECISION SET IS A REFUSAL, NOT A ZERO (D25.2) -- `evaluated 0` prints as `0.000` beside a
// `0.0` positive control, which is indistinguishable from "protecting depth does nothing".
const refuseIfEmpty = (r) => {
  if (r.evaluated !== 0) return r;
  console.error(`\nREFUSED: league ${leagueId} produced ZERO evaluated decisions over ${seasonsArg} ` +
    `(no fact_roster_week / fact_lineup_week rows for it). Nothing was measured -- a printed 0.000 here ` +
    `would be an empty set, not a null result. Pass --league <id> for a league with in-season history.`);
  process.exit(3);
};
const line = (r, label) =>
  `  ${label.padEnd(24)} diff/decision ${r.meanDiff.toFixed(3).padStart(7)}  CI [${r.bootstrap.lo.toFixed(2)}, ${r.bootstrap.hi.toFixed(2)}]  P(better) ${(100 * r.bootstrap.pVariantBetter).toFixed(0)}%  (differed ${r.differed})`;

const t0 = Date.now();
const ALL = ["QB", "RB", "WR", "TE", "K", "DST"];
console.log(`\nDEPTH-AWARE DROP -- on the decision harness, ${model} model, seasons ${seasonsArg}\n`);

const explicit = arg("--protect", null);
if (explicit) {
  const set = new Set(explicit.split(",").map((s) => s.trim().toUpperCase()));
  console.log(line(refuseIfEmpty(run(set, dropBest)), `protect {${[...set].join(",")}}`));
} else {
  const diag = refuseIfEmpty(run(new Set(ALL), dropBest));
  const byPos = new Map();
  for (const d of diag.decisions) { const p = d.meta?.protectedPos; if (!p) continue; const a = byPos.get(p) ?? []; a.push(d.diff); byPos.set(p, a); }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log("THE VALUE OF A BENCH BACKUP, PER POSITION (realized pts saved when depth-aware kept it):");
  console.log("  pos    times kept   mean diff (pts)");
  for (const [p, a] of [...byPos.entries()].sort((x, y) => mean(y[1]) - mean(x[1]))) console.log(`  ${p.padEnd(5)}  ${String(a.length).padStart(6)}      ${mean(a).toFixed(2).padStart(7)}`);
  console.log(`\n  positive control (drop-your-best): ${diag.control.meanDiff.toFixed(1)} pts  (must be strongly negative)\n`);

  const tuned = new Set([...byPos.entries()].filter(([, a]) => mean(a) > 0).map(([p]) => p));
  console.log("POLICY COMPARISON (diff/decision = realized pts saved vs value-min; season-level CI):");
  console.log(line(run(new Set()),               "protect {} (=value-min)"));
  console.log(line(run(new Set(["TE"])),         "protect {TE}"));
  console.log(line(run(new Set(["QB", "TE"])),   "protect {QB,TE}"));
  console.log(line(run(new Set(["QB", "TE", "K", "DST"])), "protect {QB,TE,K,DST}"));
  console.log(line(diag,                          "protect {all 6}"));
  console.log(line(run(tuned),                    `TUNED {${[...tuned].join(",")}}`));
}
db.close();
console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
