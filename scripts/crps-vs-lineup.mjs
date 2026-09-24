// DOES A CRPS IMPROVEMENT ACTUALLY BUY A BETTER LINEUP?
//
// The weekly track gates on pooled CRPS (scripts/weekly-paired-floor.mjs). Twenty-odd candidates
// have now been rejected by that gate. Before screening a twenty-first it is worth asking whether
// the gate's metric tracks the thing that wins matchups -- because if it does not, some of those
// rejections were the proxy talking.
//
// TWO QUESTIONS, DELIBERATELY SEPARATED, because they have different answers and different worth:
//
//   (a) LARGE SCALE. Across the five models the evaluator already scores side by side (zero,
//       season_line, shipped_week, trailing4, weekly), does CRPS order them the same way
//       lineup value does? If not, the metric is simply wrong and nothing else matters.
//
//   (b) AT THE MARGIN. Across the paired candidate arms, does the SIGN of the CRPS delta match the
//       sign of the lineup delta? This is the one that bears on the rejections, and it is a much
//       harder test: (a) compares models that differ by whole points of captured score, (b)
//       compares arms that differ by hundredths.
//
// THE POWER HERE IS LOW AND SAYING SO IS PART OF THE RESULT. There are six paired arms, and the
// evaluator reports `lineup` POOLED over seasons with no per-season breakdown, so there is no
// paired-season SE to put on the lineup side. Six points cannot establish a correlation; they can
// show a systematic SIGN DISAGREEMENT, which is the failure worth finding. Treated as a screen
// that can raise a flag, never as a measurement that can clear one.
//
// NO METRIC SHOPPING. This cannot and does not reopen any verdict. Choosing whichever metric gives
// the answer you wanted is the winner's-curse failure this repo has paid for; the only legitimate
// output is "the gate's metric does / does not track the decision", decided in advance.
import { readFileSync, existsSync } from "node:fs";

const S = process.argv[2];
if (!S) { console.error("usage: node scripts/crps-vs-lineup.mjs <scratchpad-dir>"); process.exit(1); }
const load = (a) => (existsSync(`${S}/eval-${a}.json`) ? JSON.parse(readFileSync(`${S}/eval-${a}.json`, "utf8")) : null);

// (base, candidate) pairs. The baseline MATTERS: a rebuild rewrote the feature table between
// groups, so an arm may only be compared with the baseline run against the same table.
const PAIRS = [
  ["base", "cand", "QB opponent block (5 cols)"],
  ["base", "rz", "rz_share_td"],
  ["base", "vol", "prior_vol_cv"],
  ["base2", "adot", "air-yards share + WOPR"],
  ["base3", "skew", "ecr_wk_skew"],
  ["base4", "dfs", "dfs_salary_pct"],
];
const SCEN = "standard-15";
const lineupOf = (j, model = "weekly") => j?.lineup?.[SCEN]?.[model] ?? null;
const crpsOf = (j, model = "weekly") => j?.pooled?.[model]?.crps ?? null;

// ---- (a) large scale: the five models inside one evaluation -------------------------------------
const ref = load("base4") ?? load("base");
console.log("(a) LARGE SCALE -- the five models the evaluator scores side by side");
console.log("    if CRPS and lineup value disagree HERE, the metric is simply wrong.\n");
console.log("    model           CRPS(lower better)   meanCaptured   winShare");
const models = ["zero", "season_line", "shipped_week", "trailing4", "weekly"];
const pts = [];
for (const m of models) {
  const c = crpsOf(ref, m), l = lineupOf(ref, m);
  if (c == null || !l) continue;
  pts.push({ m, c, cap: l.meanCaptured });
  console.log(`    ${m.padEnd(14)} ${c.toFixed(4).padStart(12)} ${l.meanCaptured.toFixed(3).padStart(15)} ${l.winShare.toFixed(4).padStart(11)}`);
}
// Spearman on 5 points: -1 is the ideal (lower CRPS should mean higher capture).
const rank = (arr) => { const s = [...arr].sort((x, y) => x - y); return arr.map((v) => s.indexOf(v)); };
const rc = rank(pts.map((p) => p.c)), rl = rank(pts.map((p) => p.cap));
const n = pts.length;
let d2 = 0; for (let i = 0; i < n; i++) d2 += (rc[i] - rl[i]) ** 2;
const rho = 1 - (6 * d2) / (n * (n * n - 1));
console.log(`\n    Spearman(CRPS rank, capture rank) = ${rho.toFixed(3)}   (-1.000 is perfect: lower CRPS = more captured)`);

// ---- (b) at the margin: the paired candidate arms -----------------------------------------------
console.log("\n\n(b) AT THE MARGIN -- the six paired arms, all of which the CRPS gate REJECTED");
console.log("    improvement = base - cand, so POSITIVE CRPS = candidate better.");
console.log("    lineup delta = cand - base, so POSITIVE = candidate better. Signs should AGREE.\n");
console.log("    candidate                 dCRPS      dCaptured   dWinShare   agree?");
const rows = [];
for (const [b, c, label] of PAIRS) {
  const jb = load(b), jc = load(c);
  if (!jb || !jc) { console.log(`    ${label.padEnd(24)} -- missing arm --`); continue; }
  const cb = crpsOf(jb), cc = crpsOf(jc);
  const lb = lineupOf(jb), lc = lineupOf(jc);
  if (cb == null || cc == null || !lb || !lc) { console.log(`    ${label.padEnd(24)} -- missing metric --`); continue; }
  const dC = cb - cc;                       // positive = candidate better
  const dCap = lc.meanCaptured - lb.meanCaptured;
  const dWin = lc.winShare - lb.winShare;
  // A delta of exactly zero carries no sign and is counted separately rather than as agreement.
  const agree = dC === 0 || dCap === 0 ? "flat" : (Math.sign(dC) === Math.sign(dCap) ? "yes" : "NO");
  rows.push({ label, dC, dCap, dWin, agree });
  console.log(
    `    ${label.padEnd(24)} ${(dC >= 0 ? "+" : "") + dC.toFixed(5).padStart(9)} ` +
    `${(dCap >= 0 ? "+" : "") + dCap.toFixed(4).padStart(11)} ${(dWin >= 0 ? "+" : "") + dWin.toFixed(4).padStart(10)}   ${agree}`,
  );
}
const scored = rows.filter((r) => r.agree !== "flat");
const yes = scored.filter((r) => r.agree === "yes").length;
console.log(`\n    signs agree on ${yes} of ${scored.length} arms.`);
console.log("    With six points this cannot establish a correlation. It CAN show systematic");
console.log("    disagreement, which is the failure worth finding -- and a coin toss is 50%.");
console.log(`\n    drawnRosters per lineup figure: ${lineupOf(ref)?.drawnRosters ?? "?"} (Monte-Carlo; no SE is reported per season,`);
console.log("    which is exactly why this is a flag-raiser and not a verdict).");
