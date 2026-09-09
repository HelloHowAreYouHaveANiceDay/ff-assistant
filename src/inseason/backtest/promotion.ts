/**
 * BACKTEST 3: WHAT A BACKUP ACTUALLY DOES WHEN HE IS PROMOTED.
 *
 * `src/inseason/handcuff.ts` ships a fitted prior -- activePerWk = 0.922*backup + 0.402*lead -- from
 * a within-player design on 27 seasons of our own weekly history, where "the lead is out" was
 * inferred from the lead's own missing week. This measures the same thing from the OTHER direction,
 * on evidence that side never used: the PUBLISHED DEPTH CHART moving a man from rank 2 to rank 1,
 * with the departed starter carrying an OUT designation that week.
 *
 * THE EVENT, defined tightly enough to be a fact rather than a heuristic:
 *   at week w-1 a player is rank 2 at his position for his team (the backup)
 *   at week w   that same backup is rank 1
 *   at week w   some player who WAS rank 1 at w-1, and is no longer, has an OUT designation
 *
 * THE FIRST VERSION REQUIRED EXACTLY ONE RANK-1 PLAYER, and it returned ZERO WIDE RECEIVERS across
 * seven seasons. That is not a fact about receivers; a team fields two or three of them, so the
 * published chart carries about 2.5 rank-1 receivers per team and the rule excluded every one by
 * construction. A position group's starter count is a property of the position, not a data quality
 * signal, and a filter that silently deletes an entire position is the kind of null that reads
 * exactly like a measurement.
 * Everything is point-in-time: `depth_rank` is published before the games and `inj_out` lives in
 * feat_player_week_model, whose whole as-of contract is tested by test/weekly-leakage.test.ts.
 *
 * WHY THE DEPTH CHART AND NOT JUST THE MISSING WEEK. handcuff.ts's design identifies the lead by
 * weeks 1-4 PRODUCTION, which is a hindsight-light but still production-based definition. Requiring
 * a published rank-2-to-rank-1 move plus an OUT designation is a strictly pre-kickoff signal: it is
 * what a manager could actually have acted on on Saturday. The two ought to broadly agree, and where
 * they do not, this one is the one a decision can be built on.
 */
import type { DB } from "../../db/db.js";
import { HANDCUFF_MODEL } from "../handcuff.js";
import { mean, r2, r3 } from "./lineup.js";

export interface PromotionRow {
  season: number; week: number; team: string; pos: string;
  starterSk: string; starterName: string; starterT4: number | null;
  backupSk: string; backupName: string; backupT4: number | null;
  backupPriorSnapPct: number | null;
  impliedTotal: number | null;
  /** THE OUTCOMES. Scoring only. */
  ptsW: number; snapPctW: number | null;
  next4Mean: number | null; next4Games: number;
}

const POS = ["QB", "RB", "WR", "TE"];

/** Every promotion event, with its features and its outcomes. */
export function promotionEvents(db: DB, seasons: number[]): PromotionRow[] {
  const rows: PromotionRow[] = [];
  for (const season of seasons) {
    // The published chart, deduplicated to the BEST rank a man holds at his position that week --
    // the feed lists a player once per formation and occasionally twice at the same rank.
    const depth = db.prepare(
      `SELECT week, team, depth_position AS pos, gsis_id, MIN(depth_rank) AS rank, full_name
         FROM raw_depth_chart
        WHERE season=? AND source_schema='weekly' AND formation='Offense' AND game_type='REG'
          AND gsis_id IS NOT NULL AND gsis_id<>'' AND depth_rank IS NOT NULL
          AND depth_position IN ('QB','RB','WR','TE')
        GROUP BY week, team, depth_position, gsis_id`,
    ).all(season) as { week: number; team: string; pos: string; gsis_id: string; rank: number; full_name: string }[];
    if (!depth.length) continue;

    const byKey = new Map<string, { gsis: string; rank: number; name: string }[]>();
    for (const d of depth) {
      const k = `${d.week}|${d.team}|${d.pos}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push({ gsis: d.gsis_id, rank: d.rank, name: d.full_name });
    }

    const skOf = new Map<string, string>();
    for (const r of db.prepare("SELECT source_id, player_sk FROM player_xref WHERE source='gsis'").all() as { source_id: string; player_sk: number }[]) {
      skOf.set(r.source_id, String(r.player_sk));
    }
    const pfrOf = new Map<string, string>();
    for (const r of db.prepare("SELECT source_id, player_sk FROM player_xref WHERE source='pfr'").all() as { source_id: string; player_sk: number }[]) {
      pfrOf.set(String(r.player_sk), r.source_id);
    }

    const feat = new Map<string, { pts: number; t4: number | null; out: number; implied: number | null }>();
    for (const f of db.prepare(
      `SELECT week, player_sk, pts, t4_mean, COALESCE(inj_out,0) AS out, implied_team_total
         FROM feat_player_week_model WHERE season=? AND player_sk IS NOT NULL`,
    ).all(season) as { week: number; player_sk: string; pts: number | null; t4_mean: number | null; out: number; implied_team_total: number | null }[]) {
      feat.set(`${f.week}|${f.player_sk}`, { pts: f.pts ?? 0, t4: f.t4_mean, out: f.out, implied: f.implied_team_total });
    }
    const snaps = new Map<string, number>();
    for (const s of db.prepare(
      `SELECT week, pfr_player_id, offense_pct FROM raw_snap_count WHERE season=? AND pfr_player_id IS NOT NULL`,
    ).all(season) as { week: number; pfr_player_id: string; offense_pct: number | null }[]) {
      if (s.offense_pct != null) snaps.set(`${s.week}|${s.pfr_player_id}`, s.offense_pct);
    }
    const snapOf = (sk: string, week: number): number | null => {
      const pfr = pfrOf.get(sk);
      if (!pfr) return null;
      return snaps.get(`${week}|${pfr}`) ?? null;
    };

    const weeks = [...new Set(depth.map((d) => d.week))].sort((a, b) => a - b);
    const lastWeek = weeks[weeks.length - 1];
    for (const week of weeks) {
      if (week < 2) continue;
      for (const team of new Set(depth.map((d) => d.team))) {
        for (const pos of POS) {
          const prev = byKey.get(`${week - 1}|${team}|${pos}`) ?? [];
          const now = byKey.get(`${week}|${team}|${pos}`) ?? [];
          const prevOne = prev.filter((x) => x.rank === 1);
          const prevTwo = prev.filter((x) => x.rank === 2);
          if (!prevOne.length || !prevTwo.length) continue;
          const nowOneIds = new Set(now.filter((x) => x.rank === 1).map((x) => x.gsis));
          // The promoted man: rank 2 last week, rank 1 this week.
          const backup = prevTwo.find((x) => nowOneIds.has(x.gsis));
          if (!backup) continue;
          // The man he replaced: a week w-1 starter who is no longer rank 1 AND is designated OUT.
          // Where a group had several starters the DISPLACED one is the highest trailing-4 of them,
          // which is the man whose production the backup is being asked to replace.
          const displaced = prevOne
            .filter((x) => !nowOneIds.has(x.gsis))
            .map((x) => ({ x, sk: skOf.get(x.gsis) }))
            .filter((c) => c.sk && feat.get(`${week}|${c.sk}`)?.out)
            .sort((a, b) => (feat.get(`${week}|${b.sk}`)?.t4 ?? 0) - (feat.get(`${week}|${a.sk}`)?.t4 ?? 0))[0];
          if (!displaced) continue;
          const starter = displaced.x;
          const sSk = displaced.sk as string, bSk = skOf.get(backup.gsis);
          if (!bSk) continue;
          const sF = feat.get(`${week}|${sSk}`), bF = feat.get(`${week}|${bSk}`);
          if (!sF || !bF) continue;

          const nextPts: number[] = [];
          for (let k = week; k <= Math.min(lastWeek, week + 3); k++) {
            const g = feat.get(`${k}|${bSk}`);
            if (g) nextPts.push(g.pts);
          }
          const priorSnaps: number[] = [];
          for (let k = Math.max(1, week - 4); k < week; k++) {
            const v = snapOf(bSk, k);
            if (v != null) priorSnaps.push(v);
          }
          rows.push({
            season, week, team, pos,
            starterSk: sSk, starterName: starter.name, starterT4: sF.t4,
            backupSk: bSk, backupName: backup.name, backupT4: bF.t4,
            backupPriorSnapPct: priorSnaps.length ? r2(mean(priorSnaps)) : null,
            impliedTotal: bF.implied,
            ptsW: bF.pts, snapPctW: snapOf(bSk, week),
            next4Mean: nextPts.length ? r2(mean(nextPts)) : null, next4Games: nextPts.length,
          });
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// P39 AND THE PER-POSITION TABLE
// ---------------------------------------------------------------------------------------------

export interface PosSummary {
  pos: string; n: number;
  meanStarterT4: number; meanBackupT4: number;
  meanPtsW: number; meanNext4: number;
  meanSnapPctW: number | null; meanPriorSnapPct: number | null; snapLift: number | null;
  /** RATIO OF MEANS -- the primary. Robust to a starter whose trailing-4 is near zero, which makes
   *  the mean of per-event ratios explode on a handful of rows. */
  shareOfStarter: number;
  /** MEAN OF RATIOS, on events whose denominator is at least 3 points a game. Reported beside it
   *  because the two answer slightly different questions and quoting only one hides that. */
  meanRatio: number; ratioN: number;
}

export function summarizeByPosition(rows: PromotionRow[]): PosSummary[] {
  const out: PosSummary[] = [];
  for (const pos of POS) {
    const sub = rows.filter((r) => r.pos === pos && r.starterT4 != null);
    if (!sub.length) continue;
    const withRatio = sub.filter((r) => (r.starterT4 as number) >= 3);
    const snapW = sub.filter((r) => r.snapPctW != null).map((r) => r.snapPctW as number);
    const snapP = sub.filter((r) => r.backupPriorSnapPct != null).map((r) => r.backupPriorSnapPct as number);
    out.push({
      pos, n: sub.length,
      meanStarterT4: r2(mean(sub.map((r) => r.starterT4 as number))),
      meanBackupT4: r2(mean(sub.filter((r) => r.backupT4 != null).map((r) => r.backupT4 as number))),
      meanPtsW: r2(mean(sub.map((r) => r.ptsW))),
      meanNext4: r2(mean(sub.filter((r) => r.next4Mean != null).map((r) => r.next4Mean as number))),
      meanSnapPctW: snapW.length ? r2(mean(snapW)) : null,
      meanPriorSnapPct: snapP.length ? r2(mean(snapP)) : null,
      snapLift: snapW.length && snapP.length ? r2(mean(snapW) - mean(snapP)) : null,
      shareOfStarter: r3(mean(sub.map((r) => r.ptsW)) / Math.max(1e-9, mean(sub.map((r) => r.starterT4 as number)))),
      meanRatio: withRatio.length ? r3(mean(withRatio.map((r) => r.ptsW / (r.starterT4 as number)))) : 0,
      ratioN: withRatio.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// THE MODEL, AND ITS GATE
// ---------------------------------------------------------------------------------------------

/** Ordinary least squares by normal equations with a small ridge, for a handful of columns. */
export function ols(X: number[][], y: number[], ridge = 1e-6): number[] {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += ridge;
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < p; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, j) => (Math.abs(A[j][j]) < 1e-12 ? 0 : v / A[j][j]));
}

export interface CvResult {
  n: number; folds: number;
  rmseNew: number; rmsePrior: number; rmseConstant: number;
  coef: { intercept: number; starterT4: number; priorSnapPct: number; impliedTotal: number };
  /** The same fit with the backup's OWN trailing-4 added, because the shipped prior uses it and a
   *  comparison that denies the challenger a column the incumbent has is not a fair race. */
  rmseNewPlusBackup: number;
  perFold: { season: number; n: number; rmseNew: number; rmsePrior: number }[];
}

/** `offense_pct` from the snap feed is ALREADY A FRACTION in [0, 1] -- checked, not assumed. An
 *  earlier version divided it by 100 again and produced a coefficient of 1,152, which is what a
 *  scale error looks like when nothing refuses it. */
const FEATURES = (r: PromotionRow): number[] => [1, r.starterT4 ?? 0, r.backupPriorSnapPct ?? 0, r.impliedTotal ?? 22];
const FEATURES_PLUS = (r: PromotionRow): number[] => [...FEATURES(r), r.backupT4 ?? 0];
/** The SHIPPED prior, applied to the same event: what handcuff.ts says a promoted backup scores. */
export const priorPrediction = (r: PromotionRow): number =>
  HANDCUFF_MODEL.backup * (r.backupT4 ?? 0) + HANDCUFF_MODEL.lead * (r.starterT4 ?? 0);

/** NESTED BY SEASON: each season is held out in turn and the model is fitted on the others. Any
 *  in-sample comparison here would be a fit statistic, which is exactly what `ff calibrate` already
 *  is and exactly why it is not validation. */
export function crossValidate(rows: PromotionRow[], pos?: string): CvResult {
  const usable = rows.filter((r) => r.starterT4 != null && r.backupT4 != null && (!pos || r.pos === pos));
  const seasons = [...new Set(usable.map((r) => r.season))].sort();
  const sqNew: number[] = [], sqPrior: number[] = [], sqConst: number[] = [], sqPlus: number[] = [];
  const perFold: CvResult["perFold"] = [];
  for (const held of seasons) {
    const tr = usable.filter((r) => r.season !== held);
    const te = usable.filter((r) => r.season === held);
    if (tr.length < 8 || !te.length) continue;
    const w = ols(tr.map(FEATURES), tr.map((r) => r.ptsW));
    const wPlus = ols(tr.map(FEATURES_PLUS), tr.map((r) => r.ptsW));
    const c = mean(tr.map((r) => r.ptsW));
    const fN: number[] = [], fP: number[] = [];
    for (const r of te) {
      const pn = FEATURES(r).reduce((s, x, i) => s + x * w[i], 0);
      const pp = FEATURES_PLUS(r).reduce((s, x, i) => s + x * wPlus[i], 0);
      const pr = priorPrediction(r);
      fN.push((pn - r.ptsW) ** 2); fP.push((pr - r.ptsW) ** 2);
      sqNew.push((pn - r.ptsW) ** 2); sqPlus.push((pp - r.ptsW) ** 2);
      sqPrior.push((pr - r.ptsW) ** 2); sqConst.push((c - r.ptsW) ** 2);
    }
    perFold.push({ season: held, n: te.length, rmseNew: r2(Math.sqrt(mean(fN))), rmsePrior: r2(Math.sqrt(mean(fP))) });
  }
  const full = ols(usable.map(FEATURES), usable.map((r) => r.ptsW));
  return {
    n: usable.length, folds: perFold.length,
    rmseNew: r3(Math.sqrt(mean(sqNew))), rmsePrior: r3(Math.sqrt(mean(sqPrior))),
    rmseConstant: r3(Math.sqrt(mean(sqConst))), rmseNewPlusBackup: r3(Math.sqrt(mean(sqPlus))),
    coef: { intercept: r3(full[0]), starterT4: r3(full[1]), priorSnapPct: r3(full[2]), impliedTotal: r3(full[3]) },
    perFold,
  };
}
