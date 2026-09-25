// REPORT for the waiver decision replay (`season-calibration.mjs --waiver-backtest`).
//
// Every row is already a difference against STAND for the same (season, week, team), so each arm's
// number is "what the move gained". The unit is the SEASON: per-season means over its team-weeks,
// then mean, SE and the 2.9*SE floor across seasons. Head-to-heads pair two arms on the SAME
// (season, week, team) before averaging.
//
// Usage: node scripts/waiver-decision-report.mjs [--scorer stream|zero] <file.jsonl> [<file.jsonl> ...]
//
// --scorer: `stream` (default since 2026-09-25) scores an empty slot at a real streamer's actual
// points (`dPts`); `zero` is the first scorer, an empty slot = 0 (`dPts0`), kept so the D42 admission
// can be re-read on the scorer it was measured on. Rows written before the streaming scorer existed
// carry only `dPts`, which WAS the zero scorer -- `zero` reads it for them.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const si = argv.indexOf("--scorer");
const SCORER = si >= 0 ? argv.splice(si, 2)[1] : "stream";
if (SCORER !== "stream" && SCORER !== "zero") throw new Error(`--scorer must be stream or zero, got ${SCORER}`);
const rows = argv.flatMap((f) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
if (SCORER === "stream" && rows.some((r) => r.dPts0 === undefined)) {
  throw new Error("these rows predate the streaming scorer (no dPts0) -- their dPts is the ZERO scorer; pass --scorer zero");
}
const ptsOf = (r) => (SCORER === "zero" ? (r.dPts0 ?? r.dPts) : r.dPts);
const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const key = (r) => `${r.season}|${r.W}|${r.team}`;
const byArm = new Map();
for (const r of rows) (byArm.get(r.arm) ?? byArm.set(r.arm, new Map()).get(r.arm)).set(key(r), r);

function verdict(perSeason) {
  const d = perSeason.filter((x) => Number.isFinite(x));
  const m = mean(d), se = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) / Math.max(1, d.length - 1));
  return { m, se, floor: 2.9 * se, up: d.filter((x) => x > 0).length, n: d.length, v: m > 2.9 * se ? "BETTER" : m < -2.9 * se ? "WORSE" : "NULL" };
}
const fmt = (x) => `${x.m >= 0 ? "+" : ""}${x.m.toFixed(2)}  SE ${x.se.toFixed(2)}  floor ${x.floor.toFixed(2)}  ${x.up}/${x.n} seasons up  ${x.v}`;

const decisions = byArm.get("STAND")?.size ?? 0;
console.log(`\nWAIVER DECISION REPLAY -- ${seasons.join(",")}; ${decisions} team-week decisions (every team as us, at each checkpoint)`);
console.log(`each arm vs STAND, per decision, season as the unit; scorer: ${SCORER === "zero" ? "EMPTY SLOT = 0 (the original)" : "empty slot = a real streamer's actual points"}`);
console.log("");
console.log("  arm        moved     realised pts gained / decision                         playoff flips / 100 decisions");
for (const arm of ["SIM", "SIM_OLD", "RATE", "EXP0", "EXP5", "EXP10", "EXPL0", "EXPL5", "EXPL10", "EXPF0", "EXPF5", "EXPF10", "HINDSIGHT", "ANTI", "ORACLE"]) {
  const m = byArm.get(arm); if (!m) continue;
  const rs = [...m.values()];
  const pts = verdict(seasons.map((y) => mean(rs.filter((r) => r.season === y).map(ptsOf))));
  const po = verdict(seasons.map((y) => 100 * mean(rs.filter((r) => r.season === y).map((r) => r.dPo))));
  console.log(`  ${arm.padEnd(9)} ${String(rs.filter((r) => r.moved).length).padStart(4)}/${rs.length}   ${fmt(pts).padEnd(62)} ${po.m >= 0 ? "+" : ""}${po.m.toFixed(2)} (${po.v})`);
}

console.log("\nHEAD-TO-HEAD, paired on the same (season, week, team):");
for (const [a, b] of [["SIM", "SIM_OLD"], ["SIM", "RATE"], ["SIM", "STAND"], ["RATE", "STAND"], ["EXP0", "SIM"], ["EXP5", "SIM"], ["EXP10", "SIM"], ["EXP5", "RATE"],
  ["EXPL10", "EXP10"], ["EXPF10", "EXP10"], ["EXPF5", "EXP10"], ["EXPF10", "EXPL10"], ["EXPF5", "EXPL10"], ["EXPF0", "EXPL10"]]) {
  const A = byArm.get(a), B = byArm.get(b); if (!A || !B) continue;
  const per = seasons.map((y) => mean([...A.values()].filter((r) => r.season === y && B.has(key(r))).map((r) => ptsOf(r) - ptsOf(B.get(key(r))))));
  const perPo = seasons.map((y) => 100 * mean([...A.values()].filter((r) => r.season === y && B.has(key(r))).map((r) => r.dPo - B.get(key(r)).dPo)));
  console.log(`  ${a.padEnd(8)} - ${b.padEnd(8)} pts ${fmt(verdict(per))}   playoffs/100 ${verdict(perPo).m.toFixed(2)} (${verdict(perPo).v})`);
}
const orc = byArm.get("ORACLE"), sim = byArm.get("SIM");
if (orc && sim) {
  const o = mean([...orc.values()].map(ptsOf)), sgain = mean([...sim.values()].map(ptsOf));
  console.log(`\n  capture: SIM realises ${(100 * sgain / o).toFixed(0)}% of the hindsight ceiling (${sgain.toFixed(2)} of ${o.toFixed(2)} pts/decision)`);
}
