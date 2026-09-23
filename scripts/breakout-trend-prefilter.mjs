// IS HIS ROLE GROWING? -- trend features for the waiver-breakout question, pre-filtered.
//
// THE STRUCTURAL GAP THIS TARGETS. Every feature screened so far is a LEVEL or a to-date AVERAGE:
// `prior_snap_share` says how big his role IS, `t4_mean` says what he HAS been scoring,
// `season_line_pg` says what we thought he was worth. None of them says whether his role is
// GROWING -- and a breakout is a role change. A player at 30% snaps and falling and a player at 30%
// and climbing are the same row to every model in this repo.
//
// WHY THIS IS NOT THE REJECTED PBP WORK. `docs/feature-frontier.md` records the situational-
// opportunity substrate (red-zone, goal-line, end-zone share) as a comprehensive null. Those were
// PRIOR-SEASON aggregates fed to the PRESEASON projector -- `prior_rz_touch_share` and friends in
// `feat_player_season_ext`. These are WITHIN-SEASON DELTAS off the weekly play-by-play, which is a
// different quantity from a different table answering a different question. Stated because "we
// already tested PBP" is the obvious and wrong objection.
//
// THE BAR IS RAISED ON PURPOSE. The controls are BOTH incumbents AND the usage features that have
// already been admitted or nearly admitted (`prior_snap_share`, `td_ts`, `td_rush_yards`,
// `rz_share_td`). A trend that merely re-expresses a level we already use is worth nothing, so it
// has to survive a partial against the working model, not against an empty one.
//
// THE CANDIDATE LIST IS PRE-REGISTERED AND SHORT. Eight, each with a stated hypothesis, fixed before
// any number was read. Testing forty things and reporting the best three is how a winner's curse is
// manufactured, and this repo has a recorded instance (+3.4pp becoming +1.0pp on holdout).
//
// Usage: node --import tsx scripts/breakout-trend-prefilter.mjs [--from 2013] [--to 2025]
import Database from "better-sqlite3";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", 2013)), TO = Number(arg("--to", 2025));
const MAX_WEEK = Number(arg("--max-week", 13));
const MIN_ROS = Number(arg("--min-ros-games", 4));
const RECENT = Number(arg("--recent", 2));         // weeks in the "recent" window

const db = new Database("data/ff.db", { readonly: true });

const INCUMBENTS = ["season_line_pg", "t4_mean"];
/** Already admitted (WR) or near it -- a new candidate must beat THIS, not an empty model. */
const KNOWN_USAGE = ["prior_snap_share", "td_ts", "td_rush_yards", "rz_share_td"];

/**
 * THE EIGHT, with the hypothesis each one encodes:
 *   d_tgt        targets rising          -- the receiving role is being handed to him
 *   d_carries    carries rising          -- the backfield is tilting his way
 *   d_hv         high-value touches up   -- red-zone/goal-line/end-zone work, where points live
 *   d_air        air yards rising        -- not just more looks, DEEPER looks
 *   d_tgt_share  share of team targets   -- rising WITHIN his offense, net of team pace
 *   d_snap       snap share rising       -- the rawest possible "he is playing more"
 *   exp_years    years since draft       -- the second-year breakout is a real phenomenon
 *   draft_round  draft capital           -- a buried 2nd-rounder is not a buried UDFA
 */
const CANDS = ["d_tgt", "d_carries", "d_hv", "d_air", "d_tgt_share", "d_snap", "exp_years", "draft_round"];

// ---- the weekly play-by-play, resolved to player_sk (99.9% join via player_xref) ---------------
const pbp = db.prepare(`
  SELECT x.player_sk, p.season, p.week, p.team,
         p.targets, p.carries, p.air_yards,
         (p.rz_carries + p.rz_targets + p.gtg_carries + p.ez_targets) AS hv
    FROM raw_pbp_player_week p
    JOIN player_xref x ON x.source='gsis' AND x.source_id = p.gsis_id
   WHERE p.season BETWEEN ? AND ?
`).all(FROM, TO);

// Team weekly totals, for the SHARE trend (a player can gain share while his offense slows down).
const teamTgt = new Map();
for (const r of pbp) {
  const k = `${r.season}|${r.week}|${r.team}`;
  teamTgt.set(k, (teamTgt.get(k) ?? 0) + (r.targets ?? 0));
}
for (const r of pbp) r.tgt_share = (teamTgt.get(`${r.season}|${r.week}|${r.team}`) || 0) > 0
  ? (r.targets ?? 0) / teamTgt.get(`${r.season}|${r.week}|${r.team}`) : 0;

/** season|player -> week -> row, so a delta can be taken strictly over weeks BEFORE w. */
const hist = new Map();
for (const r of pbp) {
  const k = `${r.season}|${r.player_sk}`;
  if (!hist.has(k)) hist.set(k, new Map());
  hist.get(k).set(r.week, r);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
/**
 * THE DELTA, AND IT IS STRICTLY POINT-IN-TIME. "recent" is the last `RECENT` weeks he appeared
 * BEFORE w; "base" is every appearance before THAT. Week w itself is never read -- it is the first
 * week of the label. Null when either side is empty, because a delta off one observation is noise
 * wearing a trend's name.
 */
function deltaFor(seasonPlayer, w, field) {
  const m = hist.get(seasonPlayer);
  if (!m) return null;
  const weeks = [...m.keys()].filter((x) => x < w).sort((a, b) => a - b);
  if (weeks.length < RECENT + 2) return null;
  const rec = weeks.slice(-RECENT), base = weeks.slice(0, -RECENT);
  if (!base.length) return null;
  return mean(rec.map((x) => m.get(x)[field] ?? 0)) - mean(base.map((x) => m.get(x)[field] ?? 0));
}

// ---- draft capital / experience, from the season-level table ------------------------------------
const ext = new Map();
for (const r of db.prepare(
  `SELECT player_sk, season, draft_year, draft_round FROM feat_player_season_ext WHERE season BETWEEN ? AND ?`
).all(FROM, TO)) ext.set(`${r.season}|${r.player_sk}`, r);

// ---- the pool: same synthetic construction the wide screen uses ---------------------------------
const ROSTERED_DEPTH = { QB: 22, RB: 48, WR: 57, TE: 22 };
const all = db.prepare(`
  SELECT season, week, pos, player_sk, pts, ${[...INCUMBENTS, ...KNOWN_USAGE].join(", ")}
    FROM feat_player_week_model
   WHERE season BETWEEN ? AND ? AND pos IN ('QB','RB','WR','TE')
   ORDER BY season, player_sk, week
`).all(FROM, TO);

const groups = new Map();
for (const r of all) { const k = `${r.season}|${r.player_sk}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
for (const [, g] of groups) {
  let sum = 0, cnt = 0;
  for (let i = g.length - 1; i >= 0; i--) { sum += g[i].pts ?? 0; cnt++; g[i].ros_pts = sum; g[i].ros_games = cnt; }
}
const byWeek = new Map();
for (const r of all) { const k = `${r.season}|${r.week}|${r.pos}`; if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(r); }
const rows = [];
for (const [, wk] of byWeek) {
  wk.sort((a, b) => (b.season_line_pg ?? -1) - (a.season_line_pg ?? -1));
  const depth = ROSTERED_DEPTH[wk[0].pos] ?? 40;
  for (let i = depth; i < wk.length; i++) rows.push(wk[i]);
}

const panel = rows.filter((r) => r.week <= MAX_WEEK && r.ros_games >= MIN_ROS
  && r.season_line_pg != null && r.t4_mean != null);

for (const r of panel) {
  const sp = `${r.season}|${r.player_sk}`;
  r.y = r.ros_pts / r.ros_games;
  r.d_tgt = deltaFor(sp, r.week, "targets");
  r.d_carries = deltaFor(sp, r.week, "carries");
  r.d_hv = deltaFor(sp, r.week, "hv");
  r.d_air = deltaFor(sp, r.week, "air_yards");
  r.d_tgt_share = deltaFor(sp, r.week, "tgt_share");
  // Snap share arrives as a weekly LEVEL already carried forward, so its own lag is the trend.
  const g = groups.get(sp) ?? [];
  const prevSnap = g.filter((x) => x.week < r.week - RECENT).map((x) => x.prior_snap_share).filter((v) => v != null);
  r.d_snap = (r.prior_snap_share != null && prevSnap.length) ? r.prior_snap_share - mean(prevSnap) : null;
  const e = ext.get(sp);
  r.exp_years = e?.draft_year ? r.season - e.draft_year : null;
  r.draft_round = e?.draft_round ?? null;
}

// ---- stats --------------------------------------------------------------------------------------
function ranks(v) {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; dbb += y * y; }
  return da && dbb ? num / Math.sqrt(da * dbb) : NaN;
};
function residual(y, X) {
  const n = y.length, p = X.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  const col = (j, i) => (j === 0 ? 1 : X[j - 1][i]);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) {
    b[j] += col(j, i) * y[i];
    for (let k = 0; k < p; k++) A[j][k] += col(j, i) * col(k, i);
  }
  for (let j = 0; j < p; j++) A[j][j] += 1e-8;
  for (let j = 0; j < p; j++) {
    let piv = j;
    for (let k = j + 1; k < p; k++) if (Math.abs(A[k][j]) > Math.abs(A[piv][j])) piv = k;
    [A[j], A[piv]] = [A[piv], A[j]]; [b[j], b[piv]] = [b[piv], b[j]];
    if (Math.abs(A[j][j]) < 1e-12) continue;
    for (let k = j + 1; k < p; k++) {
      const f = A[k][j] / A[j][j];
      for (let l = j; l < p; l++) A[k][l] -= f * A[j][l];
      b[k] -= f * b[j];
    }
  }
  const c = new Array(p).fill(0);
  for (let j = p - 1; j >= 0; j--) {
    let s = b[j];
    for (let k = j + 1; k < p; k++) s -= A[j][k] * c[k];
    c[j] = Math.abs(A[j][j]) < 1e-12 ? 0 : s / A[j][j];
  }
  return y.map((yi, i) => yi - c.reduce((s, cj, j) => s + cj * col(j, i), 0));
}

console.log(`\nTREND PRE-FILTER -- synthetic waiver pool, ${FROM}-${TO}, recent window ${RECENT} wk, n=${panel.length}`);
console.log(`  Controls: ${INCUMBENTS.join(", ")} + ALREADY-WORKING usage (${KNOWN_USAGE.join(", ")})`);
console.log(`  ${CANDS.length} pre-registered candidates. A partial near zero means it is a level already in the model.\n`);

for (const pos of ["RB", "WR", "TE", "QB"]) {
  const sub = panel.filter((r) => r.pos === pos && [...INCUMBENTS, ...KNOWN_USAGE].every((k) => r[k] != null));
  if (sub.length < 500) { console.log(`  ${pos}: ${sub.length} rows -- too thin\n`); continue; }
  console.log(`  ${pos}  n=${sub.length}`);
  console.log(`    candidate        raw rho   partial vs working model      n`);
  for (const f of CANDS) {
    const ok = sub.filter((r) => r[f] != null);
    if (ok.length < 300) { console.log(`    ${f.padEnd(15)} (n=${ok.length}, too thin)`); continue; }
    const fr = ranks(ok.map((r) => r[f]));
    const yr = ranks(ok.map((r) => r.y));
    const ctrl = [...INCUMBENTS, ...KNOWN_USAGE].map((c) => ranks(ok.map((r) => r[c])));
    const raw = corr(fr, yr);
    const part = corr(residual(fr, ctrl), residual(yr, ctrl));
    const flag = Math.abs(part) >= 0.05 ? "  <-- survives" : "";
    console.log(`    ${f.padEnd(15)} ${raw.toFixed(3).padStart(8)} ${part.toFixed(3).padStart(24)} ${String(ok.length).padStart(7)}${flag}`);
  }
  console.log();
}
console.log("  0.05 is a SCREENING THRESHOLD, not a significance test -- it only decides what earns an");
console.log("  expensive paired-season screen. Nothing here admits anything.");
