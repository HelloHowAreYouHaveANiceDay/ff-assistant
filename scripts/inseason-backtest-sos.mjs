// STRENGTH OF SCHEDULE in both layers.
//   LAYER 1: (a) does this-week matchup ease improve next-week point ACCURACY? (b) does rest-of-season
//            schedule ease improve the waiver DECISION (realized + sim, holdout)?
//   LAYER 2: does PLAYOFF-week (15-17) schedule ease improve playoff-week roster value -- the Layer-2
//            objective (playoffWeekPts), the tractable proxy for championship-delta (full field sim is
//            historically unavailable). Holdout, both directions.
//   node --import tsx scripts/inseason-backtest-sos.mjs
import { openDb } from "../src/db/db.ts";
import { backtestPolicies, realizedRestOfSeason } from "../src/inseason/backtest/harness.ts";
import { makeSimExpectedScorer } from "../src/inseason/backtest/scorers.ts";
import { waiverByProjection, hasRealDrop } from "../src/inseason/backtest/policies.ts";
import { frozenProjector } from "../src/inseason/backtest/projectors.ts";
import { makeOppEase, makeSosProjector } from "../src/inseason/backtest/sos.ts";

const db = openDb();
const lg = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get();
const A = [2018, 2019, 2020, 2021], B = [2022, 2023, 2024];
const admit = (s) => s.freeAgents.length > 0 && hasRealDrop(s);
const base = waiverByProjection(frozenProjector);
const BETAS = [0.5, 1.0, 1.5, 2.0];

// ---------- LAYER 1 (a): this-week matchup accuracy ----------
const oe = makeOppEase(db);
console.log(`\n== LAYER 1 (a): this-week matchup ACCURACY (MAE vs next-week points), RB/WR/TE/QB ==`);
for (const beta of [0.5, 1.0]) {
  const g = { all: { f: 0, s: 0, n: 0 }, ext: { f: 0, s: 0, n: 0 } };
  for (const season of [...A, ...B]) {
    for (const r of db.prepare(
      `SELECT pos, week, opponent, season_line_pg, pts, is_bye, inj_out FROM feat_player_week_model
        WHERE season=? AND pos IN ('RB','WR','TE','QB') AND opponent IS NOT NULL AND season_line_pg IS NOT NULL AND pts IS NOT NULL`,
    ).all(season)) {
      if (r.is_bye || r.inj_out || r.week < 4) continue;
      const ease = oe.ease(season, r.opponent, r.pos, r.week);
      const pred = r.season_line_pg * Math.min(1.6, Math.max(0.6, Math.pow(ease, beta)));
      const fe = Math.abs(r.season_line_pg - r.pts), se = Math.abs(pred - r.pts);
      g.all.f += fe; g.all.s += se; g.all.n++;
      if (Math.abs(ease - 1) > 0.2) { g.ext.f += fe; g.ext.s += se; g.ext.n++; }
    }
  }
  const mae = (b, k) => (b[k] / b.n).toFixed(3);
  console.log(`  beta ${beta}:  all (n ${g.all.n}) frozen ${mae(g.all, "f")} -> sos ${mae(g.all, "s")}   |   extreme matchup (n ${g.ext.n}) frozen ${mae(g.ext, "f")} -> sos ${mae(g.ext, "s")}`);
}

// ---------- shared decision helpers ----------
const run = (variant, seasons, scorer) => backtestPolicies(db, { leagueId: lg.league_id, seasons, model: "served", baseline: base, variant, scorer, admit });
const tune = (design, mk) => BETAS.map((b) => ({ b, d: run(waiverByProjection(mk(b)), design, undefined).meanDiff })).sort((x, y) => y.d - x.d)[0].b;
function split(design, holdout, mk, scorer, label) {
  const best = tune(design, mk);
  const hr = run(waiverByProjection(mk(best)), holdout, undefined);
  const hs = run(waiverByProjection(mk(best)), holdout, scorer ?? makeSimExpectedScorer(db, { trials: 150 }));
  console.log(`  ${label}: beta=${best}  realized ${hr.meanDiff.toFixed(3)} CI[${hr.bootstrap.lo.toFixed(2)},${hr.bootstrap.hi.toFixed(2)}]  ${scorer ? "playoff-pts" : "sim"} ${hs.meanDiff.toFixed(3)} CI[${hs.bootstrap.lo.toFixed(2)},${hs.bootstrap.hi.toFixed(2)}]  (differed ${hr.differed})`);
  return hr.bootstrap.lo > 0 && hs.bootstrap.lo > 0;
}

// ---------- LAYER 1 (b): rest-of-season schedule -> waiver decision ----------
console.log(`\n== LAYER 1 (b): rest-of-season schedule -> waiver DECISION (realized + sim, holdout) ==`);
const l1mk = (beta) => makeSosProjector(db, { beta });
const l1 = [split(A, B, l1mk, null, "tune A->test B"), split(B, A, l1mk, null, "tune B->test A")];

// ---------- LAYER 2: playoff-week schedule -> playoff-week value ----------
const playoffScorer = { name: "playoff-weeks 15-17", score: (roster, ctx) => realizedRestOfSeason(roster, { ...ctx, fromWeek: 15, toWeek: 17 }) };
console.log(`\n== LAYER 2: playoff-week schedule -> PLAYOFF-week value (weeks 15-17, holdout) ==`);
console.log(`   (playoffWeekPts is the Layer-2 objective once seeded; full championship-delta needs the field sim, unavailable historically)`);
const l2mk = (beta) => makeSosProjector(db, { beta, playoff: true });
const l2 = [split(A, B, l2mk, playoffScorer, "tune A->test B"), split(B, A, l2mk, playoffScorer, "tune B->test A")];

console.log(`\n== VERDICTS (bar: CI excludes 0 on BOTH splits under BOTH scorers) ==`);
console.log(`  Layer 1 (rest-of-season SOS -> waiver): ${l1[0] && l1[1] ? "SURVIVES" : "REFUTED"}`);
console.log(`  Layer 2 (playoff SOS -> playoff value): ${l2[0] && l2[1] ? "SURVIVES" : "REFUTED"}`);
db.close();
