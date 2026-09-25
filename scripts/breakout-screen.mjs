// CAN A WAIVER BREAKOUT BE SPOTTED IN ADVANCE? (2026-09-25)
//
//   node scripts/breakout-screen.mjs [--league 462233] [--seasons 2018-2025] [--weeks 3-8]
//
// Population: every CLAIMABLE, ACTIVE skill-position free agent in this league's real pool -- in the free
// pool at week W-1 and W (nobody else took him), and he played his team's last game before W.
// Outcome: BREAKOUT = his rest-of-regular-season points per scheduled week (W..13, zeros counted) reach a
// STARTABLE level: RB/WR >= 10, TE >= 8, QB >= 15.
// Baseline: the rest-of-season rate we already serve, (K*line + k*to-date)/(K+k), K = 6.
// Candidates (all knowable before W): last week's snap share and its trend, route share, WOPR, air-yards
// share, depth-chart rank, teammates out, expert weekly rank (ECR), DFS salary percentile.
//
// Scored LEAVE-ONE-SEASON-OUT with a logistic model; per season: log-loss vs the baseline-only model, and
// the hit rate of each week's TOP 5 picks. A feature earns a look only if it beats the baseline on held-out
// seasons -- the same bar every screen in this repo uses (2.9 SE across seasons).
import Database from "better-sqlite3";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const LEAGUE = val("--league", "462233");
const [LO, HI] = val("--seasons", "2018-2025").split("-").map(Number);
const [W0, W1] = val("--weeks", "3-8").split("-").map(Number);
const REG = 13, K = 6;
const BAR = { RB: 10, WR: 10, TE: 8, QB: 15 };
const db = new Database("data/ff.db", { readonly: true });

const rows = db.prepare(
  `SELECT season, week, player_sk sk, name, pos, is_bye bye, pts, season_line_pg line, prior_snap_share snap,
          prior_route_share route, prior_wopr wopr, prior_air_yards_share ays, depth_rank depth, teammates_out tmo,
          ecr_wk_rank ecr, dfs_salary_pct dfs
     FROM feat_player_week_model WHERE season BETWEEN ? AND ? AND pos IN ('QB','RB','WR','TE') AND player_sk IS NOT NULL`,
).all(LO, HI);
const by = new Map();
for (const r of rows) { const k = `${r.season}|${r.sk}`; (by.get(k) ?? by.set(k, new Map()).get(k)).set(r.week, r); }
const pool = new Set(db.prepare("SELECT season, week, player_sk sk FROM fact_fa_pool_week WHERE league_id=? AND player_sk IS NOT NULL").all(LEAGUE).map((r) => `${r.season}|${r.week}|${r.sk}`));

const obs = [];
for (const [key, wk] of by) {
  const [season, sk] = key.split("|"); const y = Number(season);
  for (let W = W0; W <= W1; W++) {
    if (!pool.has(`${y}|${W - 1}|${sk}`) || !pool.has(`${y}|${W}|${sk}`)) continue;
    const at = wk.get(W); if (!at || at.line == null) continue;
    const before = [...wk.entries()].filter(([w, r]) => w < W && !r.bye).sort((a, b) => a[0] - b[0]);
    const last = before[before.length - 1]; if (!last || last[1].pts == null) continue;       // active
    const k = before.length, td = before.reduce((a, [, r]) => a + (r.pts ?? 0), 0);
    const rate = k ? (K * at.line + td) / (K + k) : at.line;
    const after = [...wk.entries()].filter(([w, r]) => w >= W && w <= REG && !r.bye);
    if (after.length < 5) continue;
    const ros = after.reduce((a, [, r]) => a + (r.pts ?? 0), 0) / after.length;
    const earlierSnap = before.slice(0, -1).map(([, r]) => r.snap).filter((x) => x != null);
    obs.push({
      season: y, W, sk, name: at.name, pos: at.pos, rate, ros, hit: ros >= BAR[at.pos] ? 1 : 0,
      snap: at.snap, snapTrend: at.snap != null && earlierSnap.length ? at.snap - earlierSnap.reduce((a, x) => a + x, 0) / earlierSnap.length : null,
      route: at.route, wopr: at.wopr, ays: at.ays, depth: at.depth, tmo: at.tmo,
      ecr: at.ecr != null ? -Math.log(at.ecr) : null, dfs: at.dfs,
    });
  }
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log(`claimable active free agents, ${LO}-${HI} weeks ${W0}-${W1}: ${obs.length} player-weeks, breakouts ${obs.filter((o) => o.hit).length} (${(100 * mean(obs.map((o) => o.hit))).toFixed(1)}%)`);

// ---- logistic regression (standardised features, ridge 1e-2, gradient descent) ----
function fitLogit(tr, cols) {
  const mu = cols.map((c) => mean(tr.map((o) => o[c]))), sd = cols.map((c, j) => Math.sqrt(mean(tr.map((o) => (o[c] - mu[j]) ** 2))) || 1);
  const X = tr.map((o) => [1, ...cols.map((c, j) => (o[c] - mu[j]) / sd[j])]), y = tr.map((o) => o.hit);
  const w = new Array(cols.length + 1).fill(0);
  for (let it = 0; it < 400; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < X.length; i++) { const p = 1 / (1 + Math.exp(-X[i].reduce((s, v, j) => s + v * w[j], 0))); for (let j = 0; j < w.length; j++) g[j] += (p - y[i]) * X[i][j]; }
    for (let j = 0; j < w.length; j++) w[j] -= 0.5 * (g[j] / X.length + (j ? 1e-2 * w[j] : 0));
  }
  return (o) => 1 / (1 + Math.exp(-(w[0] + cols.reduce((s, c, j) => s + w[j + 1] * (o[c] - mu[j]) / sd[j], 0))));
}
const seasons = [...new Set(obs.map((o) => o.season))].sort();
const complete = (cols) => obs.filter((o) => cols.every((c) => o[c] != null && Number.isFinite(o[c])));
function evalArm(cols, base) {
  const data = complete([...new Set([...cols, ...base])]);
  const per = [];
  for (const ho of seasons) {
    const tr = data.filter((o) => o.season !== ho), te = data.filter((o) => o.season === ho);
    if (!te.length || tr.length < 50) continue;
    const fB = fitLogit(tr, base), fC = fitLogit(tr, cols);
    const ll = (f) => mean(te.map((o) => { const p = Math.min(1 - 1e-6, Math.max(1e-6, f(o))); return -(o.hit * Math.log(p) + (1 - o.hit) * Math.log(1 - p)); }));
    // top-5 each (season, W): hit rate
    const top = (f) => { const hits = []; for (const W of new Set(te.map((o) => o.W))) { const t = te.filter((o) => o.W === W).sort((a, b) => f(b) - f(a)).slice(0, 5); hits.push(...t.map((o) => o.hit)); } return mean(hits); };
    per.push({ season: ho, dLL: ll(fB) - ll(fC), topB: top(fB), topC: top(fC) });
  }
  const d = per.map((p) => p.dLL), m = mean(d), se = Math.sqrt(mean(d.map((x) => (x - m) ** 2)) / Math.max(1, d.length - 1));
  return { n: data.length, m, se, up: d.filter((x) => x > 0).length, k: d.length, topB: mean(per.map((p) => p.topB)), topC: mean(per.map((p) => p.topC)), v: m > 2.9 * se ? "BETTER" : m < -2.9 * se ? "WORSE" : "NULL" };
}
const BASE = ["rate"];
console.log("\nfeature added to the served rate    n     held-out log-loss gain (per season)      top-5 weekly hit rate: rate only -> with feature");
for (const [label, cols] of [
  ["snap share (last week)", ["rate", "snap"]], ["snap-share TREND", ["rate", "snapTrend"]], ["route share", ["rate", "route"]],
  ["WOPR (target+air share)", ["rate", "wopr"]], ["air-yards share", ["rate", "ays"]], ["depth-chart rank", ["rate", "depth"]],
  ["teammates out", ["rate", "tmo"]], ["expert weekly rank (ECR)", ["rate", "ecr"]], ["DFS salary percentile", ["rate", "dfs"]],
]) {
  const r = evalArm(cols, BASE);
  console.log(`  ${label.padEnd(30)} ${String(r.n).padStart(5)}   ${r.m >= 0 ? "+" : ""}${(1000 * r.m).toFixed(2)}e-3  SE ${(1000 * r.se).toFixed(2)}e-3  ${r.up}/${r.k} up  ${r.v.padEnd(6)}   ${(100 * r.topB).toFixed(1)}% -> ${(100 * r.topC).toFixed(1)}%`);
}
const byPos = {};
for (const o of obs) (byPos[o.pos] ??= []).push(o.hit);
console.log(`\nbase rates by position: ${Object.entries(byPos).map(([p, h]) => `${p} ${(100 * mean(h)).toFixed(1)}% of ${h.length}`).join(", ")}`);
