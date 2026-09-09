// A one-line look at a weekly artifact through the CONSUMER's loader.
//
//   node --import tsx scripts/weekly-artifact-probe.mjs <artifact.json>
//
// It exists because "the trainer wrote a file" and "the engine can serve that file" are two
// different facts, and the second is the one that matters. Loading it here runs the full schema
// check AND the golden block, so a producer/consumer disagreement shows up as an exception rather
// than as a slightly different projection nobody notices.
import { readFileSync } from "node:fs";
import { loadWeeklyArtifact } from "../src/weekly/projector.ts";

const path = process.argv[2] ?? "data/weekly-artifact.json";
const a = loadWeeklyArtifact(JSON.parse(readFileSync(path, "utf8")));
console.log(`${path}: schema ${a.schema}, zeroModel ${a.zeroModel ?? "quantile"}, ` +
  `${a.features.length} features, positions ${Object.keys(a.coef).sort().join("/")}`);
if (a.quantileGrid) console.log(`  second-stage grid: ${a.quantileGrid.join(", ")}`);
console.log("  GOLDEN ROWS (reproduced by this evaluator to 1e-6, or the load above would have thrown)");
for (const [i, g] of (a.golden ?? []).entries()) {
  const e = g.expect;
  console.log(`   ${i} ${g.pos.padEnd(4)} line ${String(g.line).padStart(5)}  inj_out ${g.f.inj_out ?? "-"}  ` +
    `mean ${e.mean.toFixed(3)}  p10 ${e.p10.toFixed(3)}  p50 ${e.p50.toFixed(3)}  p90 ${e.p90.toFixed(3)}` +
    (e.pZero == null ? "" : `  P(zero) ${e.pZero.toFixed(4)}`));
}
