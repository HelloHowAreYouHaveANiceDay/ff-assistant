// SCREEN: do TARGET-share trend, AIR-YARDS share and CARRY share add to the served D41 usage model?
//
// The served correction (scripts/ros-usage-screen.mjs, data/ros-usage.json) uses snap share, its trend
// and target share TO DATE. This asks whether play-by-play opportunity adds on top of it, per position:
//   tgt_trend  last played week's target share minus his earlier weeks' mean
//   ay_td      air-yards share to date,  ay_trend   last week minus earlier mean
//   car_td     carry share to date,      car_trend  last week minus earlier mean
// Shares are player / TEAM total for that game (raw_pbp_player_week, keyed gsis -> player_sk through
// stg_player). All weeks strictly BEFORE the checkpoint, so every feature is known at it.
//
// Baseline = the served feature set, refitted in the same leave-season-out folds, so the comparison is
// feature-for-feature. Paired by season, 2.9*SE floor; shuffle control permutes the pbp features within
// season and must NOT beat the baseline.
//
// Usage: node scripts/ros-usage-pbp-screen.mjs [--seasons 2013-2025] [--k 6]
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const [LO, HI] = val("--seasons", "2013-2025").split("-").map(Number);
const K = Number(val("--k", "6"));
const POS = ["QB", "RB", "WR", "TE"];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const db = new Database("data/ff.db", { readonly: true });
const skOfGsis = new Map();
for (const r of db.prepare("SELECT player_sk, gsis_id FROM stg_player WHERE gsis_id IS NOT NULL").all()) skOfGsis.set(r.gsis_id, String(r.player_sk));

const rows = [];
for (let season = LO; season <= HI; season++) {
  // per (sk, week) opportunity shares
  const pbp = db.prepare("SELECT week, gsis_id, team, targets, air_yards, carries FROM raw_pbp_player_week WHERE season = ? AND week <= 18").all(season);
  const team = new Map();
  for (const r of pbp) {
    const k = `${r.team}|${r.week}`;
    const t = team.get(k) ?? team.set(k, { tg: 0, ay: 0, ca: 0 }).get(k);
    t.tg += r.targets ?? 0; t.ay += Math.max(0, r.air_yards ?? 0); t.ca += r.carries ?? 0;
  }
  const share = new Map();   // sk -> Map(week -> {tg, ay, ca})
  for (const r of pbp) {
    const sk = skOfGsis.get(r.gsis_id); if (!sk) continue;
    const t = team.get(`${r.team}|${r.week}`);
    const m = share.get(sk) ?? share.set(sk, new Map()).get(sk);
    m.set(r.week, {
      tg: t.tg > 0 ? (r.targets ?? 0) / t.tg : null,
      ay: t.ay > 0 ? Math.max(0, r.air_yards ?? 0) / t.ay : null,
      ca: t.ca > 0 ? (r.carries ?? 0) / t.ca : null,
    });
  }
  const weeks = db.prepare(
    `SELECT feat_key, player_sk, week, pts, is_bye, season_line_pg, pos, td_ts, prior_snap_share
       FROM feat_player_week_model WHERE season = ? AND pos IN ('QB','RB','WR','TE') AND season_line_pg IS NOT NULL
      ORDER BY feat_key, week`,
  ).all(season);
  const byKey = new Map();
  for (const r of weeks) { if (!byKey.has(r.feat_key)) byKey.set(r.feat_key, []); byKey.get(r.feat_key).push(r); }
  for (const [, ws] of byKey) {
    const line = ws[0].season_line_pg;
    const nonBye = ws.filter((r) => !r.is_bye);
    const sh = ws[0].player_sk ? share.get(String(ws[0].player_sk)) : null;
    for (const cp of ws) {
      if (cp.week < 3 || cp.is_bye) continue;
      const before = nonBye.filter((r) => r.week < cp.week), after = nonBye.filter((r) => r.week >= cp.week);
      if (after.length < 3 || !before.length) continue;
      const k = before.length;
      const rate = before.reduce((a, r) => a + (r.pts ?? 0), 0) / k;
      const base = (K * line + k * rate) / (K + k);
      const snap = cp.prior_snap_share;
      const earlierSnap = before.map((r) => r.prior_snap_share).filter((x) => x != null);
      const trend = snap != null && earlierSnap.length ? snap - mean(earlierSnap) : null;
      // play-by-play shares over the weeks he PLAYED before the checkpoint
      const played = sh ? [...sh.entries()].filter(([w]) => w < cp.week).sort((a, b) => a[0] - b[0]).map(([, v]) => v) : [];
      const td = (f) => { const v = played.map((x) => x[f]).filter((x) => x != null); return v.length ? mean(v) : null; };
      const tr = (f) => {
        const v = played.map((x) => x[f]).filter((x) => x != null);
        return v.length >= 2 ? v[v.length - 1] - mean(v.slice(0, -1)) : null;
      };
      rows.push({
        season, pos: cp.pos, line, k, snap, trend, ts: cp.td_ts, base,
        target: after.reduce((a, r) => a + (r.pts ?? 0), 0) / after.length,
        tgt_trend: tr("tg"), ay_td: td("ay"), ay_trend: tr("ay"), car_td: td("ca"), car_trend: tr("ca"),
      });
    }
  }
}
db.close();

const z = (x) => [x ?? 0, x == null ? 1 : 0];
const SERVED = (r) => [r.line, r.k, r.snap ?? 0, r.snap == null ? 1 : 0, (r.snap ?? 0) * r.line, r.ts ?? 0, r.ts == null ? 1 : 0, r.trend ?? 0, r.trend == null ? 1 : 0];
const ARMS = {
  served: SERVED,
  "+tgt_trend": (r) => [...SERVED(r), ...z(r.tgt_trend)],
  "+air_yards": (r) => [...SERVED(r), ...z(r.ay_td), ...z(r.ay_trend)],
  "+carries": (r) => [...SERVED(r), ...z(r.car_td), ...z(r.car_trend)],
  "+all_pbp": (r) => [...SERVED(r), ...z(r.tgt_trend), ...z(r.ay_td), ...z(r.ay_trend), ...z(r.car_td), ...z(r.car_trend)],
};

function ols(X, y, ridge = 1e-3) {
  const p = X[0].length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) { const x = [1, ...X[i]]; for (let j = 0; j < p; j++) { b[j] += x[j] * y[i]; for (let q = 0; q < p; q++) A[j][q] += x[j] * x[q]; } }
  for (let j = 1; j < p; j++) A[j][j] += ridge * X.length;
  for (let j = 0; j < p; j++) {
    let piv = j; for (let q = j + 1; q < p; q++) if (Math.abs(A[q][j]) > Math.abs(A[piv][j])) piv = q;
    [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
    for (let q = j + 1; q < p; q++) { const f = A[q][j] / A[j][j]; for (let l = j; l < p; l++) A[q][l] -= f * A[j][l]; b[q] -= f * b[j]; }
  }
  const c = new Array(p).fill(0);
  for (let j = p - 1; j >= 0; j--) { let s = b[j]; for (let q = j + 1; q < p; q++) s -= A[j][q] * c[q]; c[j] = s / A[j][j]; }
  return (x) => { let s = c[0]; for (let i = 0; i < x.length; i++) s += c[i + 1] * x[i]; return s; };
}
const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
function predict(feat, shuffle = false) {
  const pred = new Map();
  for (const Y of seasons) for (const pos of POS) {
    let train = rows.filter((r) => r.season !== Y && r.pos === pos);
    if (shuffle) {   // permute the PBP fields within season
      const by = new Map(); for (const r of train) (by.get(r.season) ?? by.set(r.season, []).get(r.season)).push(r);
      train = []; let s = 7;
      for (const [, rs] of by) {
        const f = rs.map((r) => [r.tgt_trend, r.ay_td, r.ay_trend, r.car_td, r.car_trend]);
        for (let i = f.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [f[i], f[j]] = [f[j], f[i]]; }
        rs.forEach((r, i) => train.push({ ...r, tgt_trend: f[i][0], ay_td: f[i][1], ay_trend: f[i][2], car_td: f[i][3], car_trend: f[i][4] }));
      }
    }
    if (train.length < 200) continue;
    const fn = ols(train.map(feat), train.map((r) => r.target - r.base));
    for (const r of rows) if (r.season === Y && r.pos === pos) pred.set(r, Math.max(0, r.base + fn(feat(r))));
  }
  return pred;
}
const P = Object.fromEntries(Object.entries(ARMS).map(([n, f]) => [n, predict(f)]));
P["+all_pbp SHUFFLED"] = predict(ARMS["+all_pbp"], true);

console.log(`\nPBP OPPORTUNITY SCREEN -- ${LO}-${HI}, ${rows.length} rows; coverage: air-yards to date ${rows.filter((r) => r.ay_td != null).length}, carries ${rows.filter((r) => r.car_td != null).length}`);
console.log("paired by season against the SERVED usage model (leave-season-out refit), 2.9*SE floor\n");
for (const arm of ["+tgt_trend", "+air_yards", "+carries", "+all_pbp", "+all_pbp SHUFFLED"]) {
  for (const [label, sub] of [["ALL", () => true], ...POS.map((p) => [p, (r) => r.pos === p]), ...POS.map((p) => [`${p} starters`, (r) => r.pos === p && r.line >= 3])]) {
    const d = seasons.map((Y) => {
      const rs = rows.filter((r) => r.season === Y && sub(r) && P.served.has(r) && P[arm].has(r));
      if (!rs.length) return null;
      const e0 = Math.sqrt(mean(rs.map((r) => (P.served.get(r) - r.target) ** 2)));
      const e1 = Math.sqrt(mean(rs.map((r) => (P[arm].get(r) - r.target) ** 2)));
      return e0 - e1;
    }).filter((x) => x != null);
    const m = mean(d), se = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) / Math.max(1, d.length - 1));
    console.log(`  ${arm.padEnd(18)} ${label.padEnd(12)} d ${m.toFixed(4).padStart(8)}  SE ${se.toFixed(4)}  floor ${(2.9 * se).toFixed(4)}  ${d.filter((x) => x > 0).length}/${d.length}  ${m > 2.9 * se ? "ADMIT" : m < -2.9 * se ? "REJECT (worse)" : "NULL"}`);
  }
}
