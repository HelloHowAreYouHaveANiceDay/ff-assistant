// DOES IN-SEASON USAGE EXPLAIN WHAT THE K=6 REST-OF-SEASON BLEND GETS WRONG?
//
// THE CASE THAT PROMPTED IT. Marvin Harrison Jr., 2026 week 3: preseason line 8.81/wk, two games of
// 3.8 and 0.0, so the D18 blend prices him at (6*8.81 + 2*1.90)/8 = 7.08 -- a 20% markdown. That is
// correct behaviour for a POINTS slump: two games of receiver scoring is weak evidence and `K=6` is
// the fitted minimum of a held-out RMSE curve (4.3666 at K=6 against 4.9295 line-only and 5.1474
// rate-only, all 14 folds choosing 6). But his usage says something the points cannot: 79% of snaps
// with a 6% target share. He is on the field and not being thrown to, which is a ROLE collapse, and
// the blend is a pure points blend that cannot see it.
//
// THE FRAME IS `fit-ros-blend.mjs`'s, EXACTLY -- same population filter (`in_population = 1`), same
// `--min-line 3` / `--min-remaining 3`, same SCHEDULED-week frame where a missed game is a zero.
// Reusing the estimand rather than re-deriving it is the point: a different panel would make any
// difference unattributable to the feature.
//
// THE RESIDUAL FRAMING IS WHAT MAKES THIS A FAIR TEST. The candidate does not re-predict the target;
// it predicts the BLEND'S ERROR, `target - blend(K=6)`, from usage. So a usage feature that merely
// re-expresses the level the blend already carries regresses to ~0 by construction, and only
// information the blend is MISSING can score. That is the same discipline the waiver pre-filter used
// as a partial correlation, applied here as a residual.
//
// Usage: node --import tsx scripts/ros-blend-usage-screen.mjs [--seasons 2012-2025] [--shuffle]
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2012-2025").split("-").map(Number);
const MIN_LINE = Number(val("--min-line", "3"));
const MIN_REMAINING = Number(val("--min-remaining", "3"));
const K_SHIPPED = Number(val("--k", "6"));
const SHUFFLE = argv.includes("--shuffle");

const db = new Database("data/ff.db", { readonly: true });

/** Pre-registered, with the hypothesis each encodes. Fixed before any number was read. */
const USAGE = [
  "td_ts",              // to-date target share -- the MHJ signal: on the field, not thrown to
  "prior_snap_share",   // is he playing at all
  "prior_route_share",  // is he running routes when he plays
  "ts_x_line",          // target share INTERACTED with the line: 6% is alarming for a WR1, normal
                        // for a WR4, and only the interaction can say which player this is
];
/** Carried so the residual model can calibrate; they are NOT the candidate. */
const CTX = ["line", "k"];

const rows = [];
for (let season = LO; season <= HI; season++) {
  const weeks = db.prepare(
    `SELECT m.feat_key, m.week, m.pts, m.is_bye, m.season_line_pg, m.pos,
            m.td_ts, m.prior_snap_share, m.prior_route_share
       FROM feat_player_week_model m
      WHERE m.season = ? AND m.in_population = 1 AND m.pos IN ('QB','RB','WR','TE')
      ORDER BY m.feat_key, m.week`,
  ).all(season);
  const byKey = new Map();
  for (const r of weeks) { if (!byKey.has(r.feat_key)) byKey.set(r.feat_key, []); byKey.get(r.feat_key).push(r); }
  for (const [, ws] of byKey) {
    const line = ws[0].season_line_pg;
    if (line == null || line < MIN_LINE) continue;
    const nonBye = ws.filter((r) => !r.is_bye);
    for (const cp of ws) {
      const w = cp.week;
      if (w < 2) continue;
      const before = nonBye.filter((r) => r.week < w), after = nonBye.filter((r) => r.week >= w);
      if (after.length < MIN_REMAINING) continue;
      const k = before.length;
      const rate = k > 0 ? before.reduce((a, r) => a + (r.pts ?? 0), 0) / k : null;
      const target = after.reduce((a, r) => a + (r.pts ?? 0), 0) / after.length;
      if (target == null) continue;
      rows.push({
        season, w, pos: cp.pos, line, k, rate, target,
        td_ts: cp.td_ts, prior_snap_share: cp.prior_snap_share, prior_route_share: cp.prior_route_share,
        ts_x_line: cp.td_ts != null ? cp.td_ts * line : null,
      });
    }
  }
}

const blend = (r, K) => (r.rate == null || K === Infinity) ? r.line : (K <= 0 ? r.rate : (K * r.line + r.k * r.rate) / (K + r.k));
for (const r of rows) { r.base = blend(r, K_SHIPPED); r.resid = r.target - r.base; }

const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const rmse = (rs, f) => Math.sqrt(rs.reduce((a, r) => a + (f(r) - r.target) ** 2, 0) / rs.length);

function fit(train, feats, fill) {
  const p = feats.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  const col = (j, r) => (j === 0 ? 1 : (r[feats[j - 1]] ?? fill[feats[j - 1]]));
  for (const r of train) for (let j = 0; j < p; j++) {
    b[j] += col(j, r) * r.resid;
    for (let q = 0; q < p; q++) A[j][q] += col(j, r) * col(q, r);
  }
  for (let j = 0; j < p; j++) A[j][j] += 1e-6;
  for (let j = 0; j < p; j++) {
    let piv = j;
    for (let q = j + 1; q < p; q++) if (Math.abs(A[q][j]) > Math.abs(A[piv][j])) piv = q;
    [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
    if (Math.abs(A[j][j]) < 1e-12) continue;
    for (let q = j + 1; q < p; q++) {
      const f2 = A[q][j] / A[j][j];
      for (let l = j; l < p; l++) A[q][l] -= f2 * A[j][l];
      b[q] -= f2 * b[j];
    }
  }
  const c = new Array(p).fill(0);
  for (let j = p - 1; j >= 0; j--) {
    let s = b[j];
    for (let q = j + 1; q < p; q++) s -= A[j][q] * c[q];
    c[j] = Math.abs(A[j][j]) < 1e-12 ? 0 : s / A[j][j];
  }
  return (r) => c.reduce((s, cj, j) => s + cj * col(j, r), 0);
}

console.log(`\nROS-BLEND USAGE SCREEN -- ${LO}-${HI}, K=${K_SHIPPED}, n=${rows.length} (season, player, checkpoint)` +
  `${SHUFFLE ? "   *** SHUFFLED RESIDUALS (control) ***" : ""}`);
console.log(`  Candidate predicts the BLEND'S ERROR from usage, so anything the blend already knows scores ~0.\n`);
console.log(`  pos     n     RMSE K=${K_SHIPPED}   RMSE +usage    paired d       SE     floor   verdict`);

for (const pos of ["ALL", "WR", "RB", "TE", "QB"]) {
  const sub = pos === "ALL" ? rows : rows.filter((r) => r.pos === pos);
  if (sub.length < 2000) { console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(6)}  too thin`); continue; }

  const perSeason = [];
  for (const ho of seasons) {
    const tr = sub.filter((r) => r.season !== ho);
    let te = sub.filter((r) => r.season === ho);
    if (tr.length < 500 || te.length < 100) continue;
    if (SHUFFLE) {
      const sh = te.map((r) => r.resid).sort(() => Math.random() - 0.5);
      te = te.map((r, i) => ({ ...r, resid: sh[i], target: r.base + sh[i] }));
    }
    const fill = {};
    for (const f of [...CTX, ...USAGE]) {
      const v = tr.map((r) => r[f]).filter((x) => x != null && Number.isFinite(x));
      fill[f] = v.length ? median(v) : 0;
    }
    const g = fit(tr, [...CTX, ...USAGE], fill);
    perSeason.push({
      base: rmse(te, (r) => r.base),
      cand: rmse(te, (r) => r.base + g(r)),
    });
  }
  if (perSeason.length < 3) { console.log(`  ${pos.padEnd(5)} too few seasons`); continue; }

  // Paired by SEASON. RMSE is a loss, so a POSITIVE d means the candidate is better.
  const d = perSeason.map((x) => x.base - x.cand);
  const m = mean(d);
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, d.length - 1));
  const se = sd / Math.sqrt(d.length);
  const floor = 2.9 * se;
  console.log(`  ${pos.padEnd(5)} ${String(sub.length).padStart(6)}   ${mean(perSeason.map((x) => x.base)).toFixed(4)}      ${mean(perSeason.map((x) => x.cand)).toFixed(4)}    ` +
    `${((m >= 0 ? "+" : "") + m.toFixed(4)).padStart(9)} ${se.toFixed(4).padStart(8)} ${floor.toFixed(4).padStart(9)}   ` +
    `${m > floor ? "ADMIT" : "REJECT"}  (${d.filter((x) => x > 0).length}/${d.length})`);
}
console.log(`\n  A loss, so positive = better. Nothing here ships: the blend is read by src/draft/season.ts`);
console.log(`  and src/inseason/lineup.ts, so a change is D18 territory and needs the gate plus sign-off.`);
