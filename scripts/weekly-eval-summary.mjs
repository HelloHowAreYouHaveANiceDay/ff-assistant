// Summarize one `ff evaluate-weekly --json` output: the gate clauses (a/b/c) pooled and per position,
// plus the weekly model's pooled CRPS/coverage/zero-share. For Front B baseline-vs-candidate reads.
import { readFileSync } from "node:fs";
const ev = JSON.parse(readFileSync(process.argv[2], "utf8"));
const model = process.argv[3] ?? "weekly";
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "NA");
const p = ev.pooled?.[model] ?? {};
const base = ev.pooled?.shipped_week ?? {};
console.log(`FILE ${process.argv[2]}  model=${model}`);
console.log(`  features: ${(ev.featuresUsed ?? []).length} used`);
console.log(`  POOLED  n=${p.n}  CRPS ${f(p.crps)}  RMSE ${f(p.rmse)}  cov(>0) ${f(p.coverageNonZero)}  ` +
  `bias ${f(p.bias)}  zeroPred ${f(p.zeroPred)} vs zeroActual ${f(p.zeroActual)}`);
console.log(`  shipped_week baseline CRPS ${f(base.crps)}`);
console.log("  GATE (pooled all-or-nothing):");
for (const c of ev.gate?.clauses ?? []) console.log(`    (${c.id}) ${c.passed ? "PASS" : "FAIL"}  ${c.evidence}`);
console.log(`    OVERALL ${ev.gate?.passed ? "PASS" : "FAIL"}`);
console.log("  PER POSITION (model CRPS, cov>0, zeroPred vs zeroActual):");
for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
  const s = ev.byPos?.[pos]?.[model]; const fl = ev.byPos?.[pos]?.season_line ?? ev.byPos?.[pos]?.shipped_week;
  if (!s) continue;
  console.log(`    ${pos.padEnd(4)} CRPS ${f(s.crps)}  cov(>0) ${f(s.coverageNonZero)}  ` +
    `zero ${f(s.zeroPred)} vs ${f(s.zeroActual)} (off ${f(Math.abs(s.zeroPred - s.zeroActual))})`);
}
console.log("  GATE BY POSITION (verdict = fills WEEKLY_SERVE):");
for (const g of ev.gateByPos ?? []) {
  console.log(`    ${String(g.pos).padEnd(4)} ${g.clauses.map((c) => `${c.id}:${c.passed ? "P" : "F"}`).join(" ")}`);
}
console.log("  LINEUP REGRET:");
for (const [scen, byModel] of Object.entries(ev.lineup ?? {})) {
  const m = byModel?.[model];
  if (m) console.log(`    ${scen.padEnd(12)} captured ${f(m.meanCaptured, 2)}  winShare ${f(m.winShare, 3)}`);
}
