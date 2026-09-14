// HOW MANY WEEKS OF THE PRESEASON LINE IS ONE PLAYED WEEK WORTH?
//
//   node --import tsx scripts/fit-ros-blend.mjs [--seasons 2012-2025] [--min-line 3] [--min-remaining 3]
//                                                [--frame scheduled|played] [--out data/ros-blend.json]
//
// The question the season simulator needs answered before it can price a roster mid-season (D18):
// after the season's first weeks, what is the best estimate of a player's REST-OF-SEASON per-week
// mean? The estimator is fixed by design -- (K*line + k*rate)/(K+k), a weighted shrink of the
// observed rate toward the preseason line -- and this script fits the one number in it, K, against
// what actually happened.
//
// THE FRAME IS THE WHOLE FIT, so it is a flag and both are printed. The simulator prices a player at
// `proj / 17` -- his preseason season total spread over the SCHEDULED weeks, missed games included --
// and draws availability separately. So the quantity to update is the per-SCHEDULED-week rate:
//   line   season_line_pg (points per scheduled week; the BLIND per-season line since D17)
//   rate   to-date points / non-bye weeks elapsed (a missed game is a zero, as it is for the team)
//   target remaining points / remaining non-bye weeks, missed games as zeros
// `--frame played` is the other frame (per game actually played) and is here to show what the
// first cut of this script measured by mistake: a per-played-game rate mixed into a per-week line is
// on a different scale, and the fit then "prefers" the line at every K because every blend is
// biased upward. It is kept because a number that was wrong once should stay reproducible.
//
// SELECTION IS SEASON-GROUPED: leave-one-season-out, held-out RMSE reported beside the pooled curve.
// Two controls: K = infinity (line only, the pre-D18 behaviour) and K = 0 (the rate alone). The
// fitted K has to beat both or it is not doing anything.
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2012-2025").split("-").map(Number);
const MIN_LINE = Number(val("--min-line", "3"));
const MIN_REMAINING = Number(val("--min-remaining", "3"));
const FRAME = val("--frame", "scheduled");
const OUT = val("--out", "data/ros-blend.json");
if (FRAME !== "scheduled" && FRAME !== "played") throw new Error(`--frame must be scheduled or played, got ${FRAME}`);
const KS = [0, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, Infinity];

const db = new Database("data/ff.db", { readonly: true });

const rows = [];
for (let season = LO; season <= HI; season++) {
  const weeks = db.prepare(
    `SELECT m.feat_key, m.week, m.pts, m.is_bye, m.season_line_pg, w.td_games, w.td_pts
       FROM feat_player_week_model m
       JOIN feat_player_week w ON w.season = m.season AND w.week = m.week AND w.feat_key = m.feat_key
      WHERE m.season = ? AND m.in_population = 1 AND m.pos IN ('QB','RB','WR','TE')
      ORDER BY m.feat_key, m.week`,
  ).all(season);
  const byKey = new Map();
  for (const r of weeks) (byKey.get(r.feat_key) ?? byKey.set(r.feat_key, []).get(r.feat_key)).push(r);
  for (const [, ws] of byKey) {
    const line = ws[0].season_line_pg;
    if (line == null || line < MIN_LINE) continue;
    const nonBye = ws.filter((r) => !r.is_bye);
    const played = nonBye.filter((r) => r.pts != null);
    for (const cp of ws) {
      const w = cp.week;
      if (w < 2) continue;
      let k, rate, target, remainingN;
      if (FRAME === "played") {
        const rem = played.filter((r) => r.week >= w);
        remainingN = rem.length;
        k = cp.td_games ?? 0;
        rate = k > 0 && cp.td_pts != null ? cp.td_pts / k : null;
        target = rem.length ? rem.reduce((a, r) => a + r.pts, 0) / rem.length : null;
      } else {
        const before = nonBye.filter((r) => r.week < w), after = nonBye.filter((r) => r.week >= w);
        remainingN = after.length;
        k = before.length;
        rate = k > 0 ? before.reduce((a, r) => a + (r.pts ?? 0), 0) / k : null;
        target = after.length ? after.reduce((a, r) => a + (r.pts ?? 0), 0) / after.length : null;
      }
      if (target == null || remainingN < MIN_REMAINING) continue;
      rows.push({ season, w, line, k, rate, target });
    }
  }
}
console.log(`frame ${FRAME}: ${rows.length} (season, player, checkpoint) triples over ${LO}-${HI}; line >= ${MIN_LINE}, >= ${MIN_REMAINING} remaining`);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`  scale check -- mean line ${mean(rows.map((r) => r.line)).toFixed(2)}, mean to-date rate ${mean(rows.filter((r) => r.rate != null).map((r) => r.rate)).toFixed(2)}, mean target ${mean(rows.map((r) => r.target)).toFixed(2)}  (a frame mismatch shows up here as the rate sitting on a different scale from line and target)`);

const blend = (r, K) => {
  if (r.rate == null || K === Infinity) return r.line;
  if (K <= 0) return r.rate;
  return (K * r.line + r.k * r.rate) / (K + r.k);
};
const rmse = (rs, K) => Math.sqrt(rs.reduce((a, r) => a + (blend(r, K) - r.target) ** 2, 0) / rs.length);

console.log("\n  K (weeks of prior)   RMSE of rest-of-season per-week points");
const pooled = {};
let best = { K: Infinity, v: Infinity };
for (const K of KS) { const v = rmse(rows, K); pooled[String(K)] = v; if (v < best.v) best = { K, v }; console.log(`  ${String(K).padStart(10)}           ${v.toFixed(4)}${K === Infinity ? "   <- line only (pre-D18)" : K === 0 ? "   <- rate only" : ""}`); }
console.log(`\n  pooled best K = ${best.K} (RMSE ${best.v.toFixed(4)}; line-only ${pooled["Infinity"].toFixed(4)}, rate-only ${pooled["0"].toFixed(4)})`);

const seasons = [...new Set(rows.map((r) => r.season))].sort();
let held = 0, heldN = 0, heldLine = 0, heldRate = 0;
const picks = [];
for (const ho of seasons) {
  const tr = rows.filter((r) => r.season !== ho), te = rows.filter((r) => r.season === ho);
  let b = { K: Infinity, v: Infinity };
  for (const K of KS) { const v = rmse(tr, K); if (v < b.v) b = { K, v }; }
  picks.push(b.K);
  held += rmse(te, b.K) ** 2 * te.length; heldN += te.length;
  heldLine += rmse(te, Infinity) ** 2 * te.length; heldRate += rmse(te, 0) ** 2 * te.length;
}
const heldOut = Math.sqrt(held / heldN), heldOutLine = Math.sqrt(heldLine / heldN), heldOutRate = Math.sqrt(heldRate / heldN);
console.log(`  leave-one-season-out: held-out RMSE ${heldOut.toFixed(4)} (line-only ${heldOutLine.toFixed(4)}, rate-only ${heldOutRate.toFixed(4)}); K chosen per fold: ${picks.join(", ")}`);

console.log(`\n  by weeks elapsed (pooled K = ${best.K}):   k     n    line-only   blended   rate-only`);
for (const k of [1, 2, 3, 4, 6, 8, 12]) {
  const rs = rows.filter((r) => r.k === k);
  if (rs.length < 100) continue;
  console.log(`  ${String(k).padStart(42)} ${String(rs.length).padStart(6)}   ${rmse(rs, Infinity).toFixed(3).padStart(8)}  ${rmse(rs, best.K).toFixed(3).padStart(8)}  ${rmse(rs, 0).toFixed(3).padStart(9)}`);
}

if (FRAME === "scheduled") {
  const out = {
    K: best.K === Infinity ? "Infinity" : best.K,
    frame: FRAME, fittedOn: `${LO}-${HI}`, fittedAt: new Date().toISOString().slice(0, 10),
    rows: rows.length, minLine: MIN_LINE, minRemaining: MIN_REMAINING,
    rmseByK: Object.fromEntries(Object.entries(pooled).map(([k, v]) => [k, Number(v.toFixed(5))])),
    heldOut: { rmse: Number(heldOut.toFixed(5)), lineOnly: Number(heldOutLine.toFixed(5)), rateOnly: Number(heldOutRate.toFixed(5)), kPerFold: picks.map((k) => (k === Infinity ? "Infinity" : k)) },
    notes: "ros_pw = (K*line + k*rate)/(K+k), per SCHEDULED week (missed games are zeros, the simulator's frame); k = non-bye weeks elapsed, K in weeks. Fitted by scripts/fit-ros-blend.mjs on the weekly model table's BLIND per-season lines (D17); selection season-grouped. Read by src/draft/rosBlend.ts.",
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n  wrote ${OUT}`);
} else {
  console.log(`\n  (frame played: printed only; the simulator's frame is scheduled and only that fit is written)`);
}
db.close();
