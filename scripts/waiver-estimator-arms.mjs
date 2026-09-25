// THREE DIFFERENT ESTIMATORS FOR THE SAME DECISION -- not three more features.
//
// ~20 feature candidates have been screened across two tracks and essentially all rejected. Every
// one asked "can we predict a player better". These ask a different question: ARE WE RANKING THE
// RIGHT QUANTITY? Nothing has tested that.
//
// The measured gap they are aimed at: on lineups both we and the managers capture ~87% of the
// hindsight ceiling, so there is ~13% left and most of it is irreducible. On waivers both sides
// capture ~63% of a mix-matched ceiling -- 37% left, roughly three times the pot.
//
//   A  ROSTER-CONDITIONAL   rank by marginal improvement to THAT TEAM's starting lineup, not by the
//                           player's own projection. The default ranker cannot see a roster at all
//                           (its arguments are a player and a projection), so our arm has been
//                           answering "who are the best K free agents in the league" while every
//                           manager answered "who helps my team".
//   B  RANK-LOSS            fit the ORDER directly (pairwise logistic on "did A out-produce B")
//                           instead of fitting points and sorting by them. Our CRPS beats the
//                           baselines while our rankings tie the room -- good calibration with
//                           mediocre ordering is the shape a ranking loss targets.
//   C  OPTION VALUE         rank a bench add by its CEILING (p90), not its mean. A stash is worth
//                           the chance he becomes startable; a 4.6 mean with a 6.6 ceiling never
//                           enters a lineup.
//
// EVERY ARM IS SCORED ON MIX-MATCHED CAPTURE, because raw points per game is position-blind and an
// arm that drifts toward quarterbacks scores higher without picking better -- the defect this
// harness was already retracted for once.
//
// Usage: node --import tsx scripts/waiver-estimator-arms.mjs [--league 462233]
import Database from "better-sqlite3";
import { backtestWaivers } from "../src/inseason/backtest/waiver.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const LEAGUE = arg("--league", "462233");
const MODEL = arg("--model", "challenger");
const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const db = new Database("data/ff.db");

// ---- B: the rank-loss model, fitted LEAVE-SEASON-OUT ------------------------------------------
// Pairwise logistic: for two men in the same (season, week, position) cell, predict which produced
// more rest-of-season points per game. The features are the incumbents the pool is ranked on today
// plus the usage block, so the ONLY difference from an OLS arm is the LOSS.
const FEATS = ["season_line_pg", "t4_mean", "prior_snap_share", "td_ts", "rz_share_td"];
const rows = db.prepare(`
  SELECT season, week, pos, player_sk, pts, ${FEATS.join(", ")}
    FROM feat_player_week_model
   WHERE pos IN ('QB','RB','WR','TE') AND season BETWEEN 2018 AND 2025
   ORDER BY season, player_sk, week`).all();
{ // realised rest-of-season ppg, the label -- suffix sums per (season, player)
  const g = new Map();
  for (const r of rows) { const k = `${r.season}|${r.player_sk}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  for (const [, arr] of g) {
    let sum = 0, n = 0;
    for (let i = arr.length - 1; i >= 0; i--) { sum += arr[i].pts ?? 0; n++; arr[i].y = sum / n; }
  }
}
const fill = {};
for (const f of FEATS) {
  const v = rows.map((r) => r[f]).filter((x) => x != null).sort((a, b) => a - b);
  fill[f] = v.length ? v[Math.floor(v.length / 2)] : 0;
}
const x = (r) => FEATS.map((f) => (r[f] ?? fill[f]));

/** Pairwise logistic by gradient descent. Pairs are drawn WITHIN (season, week, pos) so the model
 *  learns ordering inside the cell a decision is actually made in, never across positions. */
function fitRank(train, epochs = 12, lr = 0.05) {
  const cells = new Map();
  for (const r of train) { const k = `${r.season}|${r.week}|${r.pos}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(r); }
  const w = new Array(FEATS.length).fill(0);
  // Standardise so one feature's scale does not dominate the step size.
  const mu = FEATS.map((_, j) => train.reduce((a, r) => a + x(r)[j], 0) / train.length);
  const sd = FEATS.map((_, j) => {
    const v = Math.sqrt(train.reduce((a, r) => a + (x(r)[j] - mu[j]) ** 2, 0) / train.length);
    return v > 0 ? v : 1;
  });
  const z = (r) => x(r).map((v, j) => (v - mu[j]) / sd[j]);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cellList = [...cells.values()].filter((c) => c.length >= 2);
  for (let e = 0; e < epochs; e++) {
    for (const c of cellList) {
      for (let t = 0; t < c.length; t++) {
        const a = c[Math.floor(rnd() * c.length)], b = c[Math.floor(rnd() * c.length)];
        if (a === b || a.y == null || b.y == null || a.y === b.y) continue;
        const za = z(a), zb = z(b);
        const d = za.map((v, j) => v - zb[j]);
        const s = d.reduce((acc, v, j) => acc + v * w[j], 0);
        const p = 1 / (1 + Math.exp(-s));
        const label = a.y > b.y ? 1 : 0;
        for (let j = 0; j < w.length; j++) w[j] += lr * (label - p) * d[j];
      }
    }
  }
  return { w, z };
}
const rankModel = new Map();
for (const s of SEASONS) rankModel.set(s, fitRank(rows.filter((r) => r.season !== s && r.y != null)));
const featRow = new Map(rows.map((r) => [`${r.season}|${r.week}|${r.player_sk}`, r]));

// ---- A: marginal value to THIS team's starting lineup -------------------------------------------
/** How much does adding `cand` raise this roster's best legal starting total? Zero if he does not
 *  crack the lineup -- which is the entire point: a WR5 on a team with five WRs is worth nothing,
 *  however good he looks in isolation. */
function lineupMarginal(candProj, candPos, team) {
  const base = team.roster.map((m) => {
    const pw = team.players.get(m.playerSk);
    return { name: m.playerSk, pos: m.pos, proj: pw?.proj ?? 0, available: true };
  });
  const before = optimalLineup(base, team.template, new Set(["RB", "WR", "TE"]));
  const after = optimalLineup(
    [...base, { name: "__cand__", pos: candPos, proj: candProj, available: true }],
    team.template, new Set(["RB", "WR", "TE"]),
  );
  const sum = (r) => r.starters.reduce((a, s) => a + (s.proj ?? 0), 0);
  return Math.max(0, sum(after) - sum(before));
}

/**
 * WITHIN-CELL PERCENTILE for arm B. Built lazily per (season, week, pos): the rank model scores the
 * skill positions, and anything it has no feature row for -- K, DST, a man with no weekly row --
 * is ordered by its projection instead. Both come out as a 0-1 position-relative rank, so the
 * single sort the harness does is comparing like with like.
 */
const pctCache = new Map();
function pctOf(season, week, pos, sk, proj) {
  const cellKey = `${season}|${week}|${pos}`;
  let cell = pctCache.get(cellKey);
  if (!cell) {
    const m = rankModel.get(season);
    const members = rows.filter((r) => r.season === season && r.week === week && r.pos === pos);
    const scored = members.map((r) => ({
      sk: r.player_sk,
      s: m ? m.z(r).reduce((a, v, j) => a + v * m.w[j], 0) : (r.season_line_pg ?? 0),
    })).sort((a, b) => a.s - b.s);
    cell = new Map(scored.map((v, i) => [v.sk, scored.length > 1 ? i / (scored.length - 1) : 0.5]));
    pctCache.set(cellKey, cell);
  }
  const hit = cell.get(sk);
  if (hit != null) return hit;
  // No feature row (K, DST, or an unmodelled man): fall back to the projection, normalised into the
  // same 0-1 band by a fixed scale so it cannot dominate or be dominated by construction.
  return Math.max(0, Math.min(1, (proj ?? 0) / 25));
}

const ARMS = [
  { name: "shipped (projection, global top-K)", opts: {} },
  {
    name: "A roster-conditional (lineup marginal)",
    opts: { rosterRanker: (p, proj, team) => lineupMarginal(proj, p.pos, team) },
  },
  {
    /**
     * THE FIRST VERSION OF THIS ARM WAS DEGENERATE AND THE MIX METRIC FLATTERED IT.
     *
     * Returning the raw pairwise score put it on a scale incomparable with `proj`, and every
     * feature here (season line, form, snap share, target share, red-zone share) is a SKILL
     * POSITION column that is null for kickers and defences. Those got median-filled, scored
     * highest, and the arm picked 57% K and 43% DST -- the two positions with the LEAST headroom
     * between best and average (1.42 and 1.48 against 1.71-1.76 for WR/RB/TE). It then posted the
     * best mix-matched capture in the table, 68.7%, while its skill was -0.2. It was capturing a
     * large share of a small opportunity.
     *
     * So every candidate is scored on a WITHIN-CELL PERCENTILE instead: the rank model orders the
     * skill positions, `proj` orders K and DST, and both are expressed as a position's own 0-1
     * percentile so one sort can mix them without one scale swallowing the other.
     */
    name: "B rank-loss (pairwise, within-cell percentile)",
    opts: { ranker: (p, season, week, proj) => pctOf(season, week, p.pos, p.player_sk, proj) },
  },
  {
    // The REAL p90 off the projector, not a proxy: `pw` is the context's own record for this man.
    // A null p90 (the projector produced no band) falls back to the mean rather than to zero,
    // which would rank every unbanded player last for a reason that is not a measurement.
    name: "C option value (p90 ceiling)",
    opts: { ranker: (p, season, week, proj, pw) => pw?.p90 ?? proj },
  },
];

console.log(`\nWAIVER ESTIMATOR ARMS -- league ${LEAGUE}, model ${MODEL}, seasons ${SEASONS[0]}-${SEASONS[SEASONS.length - 1]}`);
console.log("  Same pool, same choice set, same K. Only the QUESTION changes.\n");
console.log("  arm                                       raw ppg   MIX-MATCHED capture   QB share");
const out = [];
for (const a of ARMS) {
  const opts = { seasons: SEASONS, model: MODEL, ...a.opts };
  const { summary: s } = backtestWaivers(db, LEAGUE, opts);
  const qb = s.mix.ours.byPos.find((b) => b.pos === "QB")?.share ?? 0;
  out.push({ name: a.name, raw: s.ourPpg, cap: s.ourCaptureAtMix, qb, skill: s.mix.ours.skill });
  console.log(
    `  ${a.name.padEnd(40)} ${s.ourPpg.toFixed(2).padStart(7)} ${(100 * s.ourCaptureAtMix).toFixed(1).padStart(18)}% ${(100 * qb).toFixed(0).padStart(10)}%`,
  );
  if (out.length === 1) console.log(`  ${"THE ROOM (reference)".padEnd(40)} ${s.roomPpg.toFixed(2).padStart(7)} ${(100 * s.roomCaptureAtMix).toFixed(1).padStart(18)}% ${(100 * (s.mix.room.byPos.find((b) => b.pos === "QB")?.share ?? 0)).toFixed(0).padStart(10)}%`);
}
console.log("\n  MIX-MATCHED capture is the comparable column: raw ppg is position-blind and an arm");
console.log("  that drifts toward quarterbacks raises it without picking better.");

db.close();
