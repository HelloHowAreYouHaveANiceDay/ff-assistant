// THE OWNER'S QUESTION, WITH BOTH MODELS' NUMBERS ON ONE PAGE. IT DECIDES NOTHING.
//
//   node --import tsx scripts/streaming-gate-question.mjs [--seasons 2012-2025] [--train-seasons 2010-2025]
//
// WHAT IS OPEN. Track F applied the weekly gate once, per position, on the decision population, and
// the two-part model failed on ONE THING: clause (b)'s POOLED coverage band, 0.852 against a ceiling
// of 0.85 -- while every position was individually inside its own [0.70, 0.90] band. It also failed
// clause (a) at K and DST by ties of 0.0013 and 0.0003. Nothing shipped, and the band was NOT
// widened, because a band chosen after seeing 0.852 is not a band.
//
// The streaming gate (`ff evaluate-streaming`) has its own pre-existing clauses and NO POOLED
// COVERAGE CONDITION -- deliberately, and for a stated reason: it is applied to one position at a
// time, and a position IS its own population. On the decision population it now passes at all six.
// So `WEEKLY_SERVE` maps QB, K and DST to the streaming artifact and RB, WR and TE to the floor,
// because that is what the streaming gate said when it was run, and Track F did not widen
// `SHIPPED_STREAMING_POSITIONS` on the strength of the new pass, because that would be tuning.
//
// THE OWNER'S DECISION, which this script exists to inform and not to make: DOES THE POOLED BAND
// SUPERSEDE THE PER-POSITION BANDS, OR THE OTHER WAY ROUND? The two gates disagree about nothing
// except that question, and the answer decides whether RB, WR and TE keep being served the floor.
//
// So this prints the SAME clause table -- `weeklyGateByPos`, the corrected form, clauses (a), (b)
// WITH the pooled band, and (c) -- for BOTH models, computed by ONE function so the two columns
// cannot differ because two harnesses disagree about arithmetic.
//
// IT CHANGES NOTHING. `SHIPPED_STREAMING_POSITIONS` and `WEEKLY_SERVE` are untouched by this file.
import { evaluateWeekly } from "../src/weekly/evaluate.ts";
import { weeklyGateByPos, GATE_COV_POOLED, GATE_COV_POS, GATE_ZERO_TOL } from "../src/weekly/evaluate.ts";
import { evaluateStreaming } from "../src/weekly/streamingEvaluate.ts";
import { WEEKLY_SERVE, SHIPPED_STREAMING_POSITIONS } from "../src/weekly/streamingServe.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const range = (s) => { const [lo, hi] = s.split("-").map(Number); const o = []; for (let y = lo; y <= hi; y++) o.push(y); return o; };
const seasons = range(arg("--seasons", "2012-2025"));
const trainSeasons = range(arg("--train-seasons", "2010-2025"));

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const mark = (b) => (b ? "PASS" : "FAIL");

console.log("THE STREAMING GATE QUESTION -- both models under the SAME corrected clauses.");
console.log(`clauses: (a) CRPS beats the floor at this position; (b) coverage | pts>0 in ` +
  `[${GATE_COV_POOLED.join(", ")}] POOLED and [${GATE_COV_POS.join(", ")}] at the position; ` +
  `(c) zero share within ${GATE_ZERO_TOL}, pooled and at the position.`);
console.log(`seasons ${seasons[0]}-${seasons[seasons.length - 1]}, trained on ` +
  `${trainSeasons[0]}-${trainSeasons[trainSeasons.length - 1]}, decision population.\n`);

console.log("running the WEEKLY harness (two-part vs the floor)...");
const w = await evaluateWeekly({ seasons, trainSeasons, features: "all" });
console.log("running the STREAMING harness (streaming vs the floor)...");
const s = await evaluateStreaming({ seasons, trainSeasons });

// ONE function, both models. `weeklyGateByPos` takes the model and floor NAMES, so the streaming
// arm is the same code path as the two-part arm with a different key -- not a second gate.
const gW = weeklyGateByPos(w.pooled, w.byPos, { model: "weekly", floor: "season_line" });
const gS = weeklyGateByPos(s.pooled, s.byPos, { model: "streaming", floor: "season_line" });

const byPos = (gates) => Object.fromEntries(gates.map((g) => [g.pos, g]));
const W = byPos(gW), S = byPos(gS);

console.log("\n================ THE CLAUSE TABLE, BOTH MODELS ================");
console.log("        |            TWO-PART (Track F)            |            STREAMING");
console.log("  pos   |   (a)    (b)    (c)   verdict  |   (a)    (b)    (c)   verdict");
for (const p of POS) {
  const a = W[p], b = S[p];
  const cell = (g) => g ? `${mark(g.clauses[0].passed).padEnd(6)} ${mark(g.clauses[1].passed).padEnd(6)} ${mark(g.clauses[2].passed).padEnd(6)} ${(g.passed ? "PASSES" : "fails").padEnd(8)}` : "-".padEnd(29);
  console.log(`  ${p.padEnd(5)} | ${cell(a)} | ${cell(b)}`);
}

console.log("\n---- THE EVIDENCE, PER CLAUSE, AT THE THREE POSITIONS THE QUESTION IS ABOUT");
for (const p of ["RB", "WR", "TE"]) {
  console.log(`\n  ${p}   (WEEKLY_SERVE currently: ${WEEKLY_SERVE[p]})`);
  for (const [label, g] of [["two-part", W[p]], ["streaming", S[p]]]) {
    if (!g) { console.log(`    ${label}: no rows`); continue; }
    console.log(`    ${label}:`);
    for (const c of g.clauses) console.log(`      (${c.id}) ${mark(c.passed)}  ${c.evidence}`);
  }
}

console.log("\n---- POOLED, which is the whole of the disagreement");
for (const [label, r, key] of [["two-part", w, "weekly"], ["streaming", s, "streaming"]]) {
  const m = r.pooled[key], fl = r.pooled.season_line;
  console.log(`  ${label.padEnd(10)} n ${String(m?.n ?? 0).padStart(7)}  CRPS ${f(m?.crps)} (floor ${f(fl?.crps)})  ` +
    `coverage|pts>0 ${f(m?.coverageNonZero, 3)}  band [${GATE_COV_POOLED.join(", ")}]  ` +
    `${m && m.coverageNonZero >= GATE_COV_POOLED[0] && m.coverageNonZero <= GATE_COV_POOLED[1] ? "IN" : "OUT"}` +
    `   zero pred ${f(m?.zeroPred, 3)} vs actual ${f(m?.zeroActual, 3)}`);
}

console.log("\n---- WHAT SHIPS TODAY, unchanged by this script");
console.log(`  SHIPPED_STREAMING_POSITIONS: ${SHIPPED_STREAMING_POSITIONS.join(", ")}`);
for (const p of POS) console.log(`    ${p.padEnd(4)} ${WEEKLY_SERVE[p]}`);
console.log(`
  THE DECISION IS THE OWNER'S AND IS NOT TAKEN HERE. Two readings, and they are both defensible:

    POOLED BAND SUPERSEDES. A model in band at every position and out of band overall has a
    composition problem the per-position view cannot see, and clause (b) was registered with the
    pooled condition for exactly that reason. Under this reading nothing changes: RB, WR and TE keep
    the floor, and the two-part model stays unshipped over 0.002.

    PER-POSITION BANDS SUPERSEDE. The decision this gate makes is per position -- WEEKLY_SERVE is a
    per-position table -- and a pooled coverage figure is a mixture over six positions whose
    populations differ in size and in zero rate, so it is not a property any single served decision
    has. Under this reading the pooled clause is the wrong unit for a per-position decision, and it
    was already dropped on those grounds for the streaming gate.

  WHAT MUST NOT HAPPEN EITHER WAY: choosing the reading that lets a model through, after seeing which
  reading that is. Whichever is adopted has to be adopted as the rule for the NEXT candidate too.`);
