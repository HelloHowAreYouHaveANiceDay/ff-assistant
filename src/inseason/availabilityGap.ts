/**
 * THE AVAILABILITY INFORMATION GAP -- the classifier, and only the classifier (M2c, 2026-09-16).
 *
 * `docs/in-season-backtest.md` records that our recommended lineup starts a man who scores EXACTLY
 * ZERO 4-6% of the time against the managers' 3.5%, and calls it "an information gap, not an
 * optimisation gap". That is a hypothesis about WHICH zeros, and the remedy differs per class:
 *
 *   friday    the injury report already said Out/Doubtful before the week's first kickoff. Our
 *             lineup rule reads `feat_player_week_model.inj_out` / `inj_doubtful` and refuses to
 *             start such a man, so this class in OUR started set must be ~empty. A residue is an
 *             availability-PLUMBING defect: a designation that reached the Friday report column and
 *             never reached the column the optimiser reads.
 *   inactive  no Friday designation, and ZERO snaps. This is what a Sunday-morning re-read recovers,
 *             and it is the only class that bounds the `weekly_sunday` workflow.
 *   played    he took snaps and scored nothing. No feed recovers this. It is the irreducible floor.
 *   dst       a team defence: a synthetic key with no PFR snap row at all, ever. Its own class
 *             rather than silently counted as `inactive` -- a DST that scores zero HAS played, and
 *             calling it a game-day inactive would inflate exactly the number this file bounds.
 *
 * THE CLASS THAT MATTERS IS DEFINED BY AN ABSENCE, which is also what a broken crosswalk looks like.
 * So `snapControlRate` exists beside `snapPlayedIndex` and must be read with it: every player who
 * SCORED POINTS must carry a snap row, and if he does not then "took zero snaps" is a measurement of
 * `player_xref('pfr')` rather than of the NFL. The caller refuses on a low rate; this module does not
 * decide policy, it supplies the number that makes the decision possible.
 *
 * PURE APART FROM THE TWO INDEX BUILDERS. The classifier itself takes indexes and returns a verdict,
 * so a test can drive every branch from a fixture with no store at all.
 */
import type { DB } from "../db/db.js";

export const ZERO_CLASSES = ["friday", "inactive", "played", "dst"] as const;
export type ZeroClass = typeof ZERO_CLASSES[number];

/** `${week}|${player_sk}` -> the pre-kickoff designation, from BOTH columns that carry one. */
export interface FridayDesignation {
  /** `feat_player_week_context.report_status_fri` -- the archived Friday injury report. */
  report: string | null;
  /** `feat_player_week_model.inj_out` -- the column the lineup optimiser actually reads. */
  injOut: boolean;
  /** `feat_player_week_model.inj_doubtful` -- read by the optimiser too (DOUBTFUL counts as OUT). */
  injDoubtful: boolean;
}

export type FridayIndex = Map<string, FridayDesignation>;
/** `${week}|${player_sk}` for every man who took at least one snap of any kind that week. */
export type PlayedIndex = Set<string>;

export const gapKey = (week: number, sk: string | number): string => `${week}|${sk}`;

/** Statuses on the Friday report that mean "knowably not playing" -- the same two the optimiser's
 *  own rule treats as OUT (context.ts: `inj_out ? "OUT" : inj_doubtful ? "DOUBTFUL" : null`). */
const REPORT_OUT = new Set(["out", "doubtful"]);

/**
 * WHO TOOK A SNAP, per week of one season, keyed by surrogate key.
 *
 * PFR publishes a snap row only for a player who was on the field, so an inactive has no row rather
 * than a row of zeros (10 all-zero rows exist across 2018-2025, out of 205,354). The `>0` test is
 * kept anyway: it costs nothing and makes the predicate say what it means.
 *
 * `st_snaps` is in the OR deliberately -- a kicker takes no offensive snap and would otherwise read
 * as inactive in every week he ever played.
 */
export function snapPlayedIndex(db: DB, season: number): PlayedIndex {
  const out: PlayedIndex = new Set();
  for (const r of db.prepare(
    `SELECT s.week AS week, CAST(x.player_sk AS TEXT) AS sk
       FROM raw_snap_count s
       JOIN player_xref x ON x.source = 'pfr' AND x.source_id = s.pfr_player_id
      WHERE s.season = ?
        AND (COALESCE(s.offense_snaps, 0) > 0 OR COALESCE(s.st_snaps, 0) > 0 OR COALESCE(s.defense_snaps, 0) > 0)`,
  ).all(season) as { week: number; sk: string }[]) out.add(gapKey(r.week, r.sk));
  return out;
}

/**
 * THE POSITIVE CONTROL ON THAT INDEX, over the season's whole scoring population.
 *
 * Not over our started set: a control computed on the same selection that produces the result can be
 * made to pass by that selection. Team defences are excluded because they are synthetic keys that
 * can never have a snap row -- including them would drive the rate down for a reason that has nothing
 * to do with the crosswalk and hide a real break.
 */
export function snapControlRate(db: DB, season: number, played: PlayedIndex): { withPts: number; withSnap: number; rate: number } {
  let withPts = 0, withSnap = 0;
  for (const r of db.prepare(
    `SELECT week, CAST(player_sk AS TEXT) AS sk, pos FROM feat_player_week_model
      WHERE season = ? AND player_sk IS NOT NULL AND COALESCE(pts, 0) > 0`,
  ).all(season) as { week: number; sk: string; pos: string | null }[]) {
    if ((r.pos ?? "") === "DST") continue;
    withPts++;
    if (played.has(gapKey(r.week, r.sk))) withSnap++;
  }
  return { withPts, withSnap, rate: withPts ? withSnap / withPts : 0 };
}

/**
 * WHAT WAS DESIGNATED BEFORE KICKOFF, from BOTH columns, because the gap between them is a finding.
 *
 * `feat_player_week_model.inj_out`/`inj_doubtful` is what the optimiser reads.
 * `feat_player_week_context.report_status_fri` is the archived report those columns are built from.
 * Reading only the first would make a plumbing break -- a designation that reached the report and
 * not the model column -- indistinguishable from a genuine game-day inactive, which is precisely the
 * two classes this file has to keep apart.
 */
export function fridayIndex(db: DB, season: number): FridayIndex {
  const out: FridayIndex = new Map();
  for (const r of db.prepare(
    `SELECT week, CAST(player_sk AS TEXT) AS sk, inj_out, inj_doubtful FROM feat_player_week_model
      WHERE season = ? AND player_sk IS NOT NULL`,
  ).all(season) as { week: number; sk: string; inj_out: number | null; inj_doubtful: number | null }[]) {
    out.set(gapKey(r.week, r.sk), { report: null, injOut: !!r.inj_out, injDoubtful: !!r.inj_doubtful });
  }
  for (const r of db.prepare(
    `SELECT week, CAST(player_sk AS TEXT) AS sk, report_status_fri FROM feat_player_week_context
      WHERE season = ? AND report_status_fri IS NOT NULL`,
  ).all(season) as { week: number; sk: string; report_status_fri: string }[]) {
    const k = gapKey(r.week, r.sk);
    const cur = out.get(k) ?? { report: null, injOut: false, injDoubtful: false };
    cur.report = r.report_status_fri;
    out.set(k, cur);
  }
  return out;
}

export interface ZeroVerdict { cls: ZeroClass; why: string }

/**
 * CLASSIFY ONE ZERO-SCORING START. Order matters and is not arbitrary:
 *
 *   1. DST first, because the snap test cannot speak about it at all. Asking an unanswerable question
 *      and reading the silence as "inactive" is the exact failure shape CLAUDE.md names.
 *   2. FRIDAY next, because a man who was designated AND did not play is a Friday miss, not a
 *      game-day one -- a Sunday re-read would recover nothing that Friday had not already said.
 *   3. Then the snap test splits the remainder into the recoverable class and the floor.
 */
export function classifyZero(o: {
  week: number; sk: string; pos: string;
  played: PlayedIndex; friday: FridayIndex;
  /** What the point-in-time availability block told the optimiser. Carried so a `friday` verdict can
   *  say WHICH of the two columns knew, which is the difference between a plumbing bug and an
   *  optimiser that started a man it was correctly told was out. */
  blockSaysOut: boolean;
}): ZeroVerdict {
  const k = gapKey(o.week, o.sk);
  if (o.pos === "DST") return { cls: "dst", why: "team defence -- no PFR snap row exists, so playing status is unknowable here" };
  const f = o.friday.get(k);
  const reportOut = !!(f?.report && REPORT_OUT.has(f.report.trim().toLowerCase()));
  if (f && (f.injOut || f.injDoubtful || reportOut)) {
    const who = [
      f.injOut ? "inj_out" : null,
      f.injDoubtful ? "inj_doubtful" : null,
      reportOut ? `report_status_fri=${f.report}` : null,
    ].filter(Boolean).join(" + ");
    return {
      cls: "friday",
      why: o.blockSaysOut
        ? `designated before kickoff (${who}) and the block DID say so -- the optimiser started him anyway`
        : `designated before kickoff (${who}) and the block did NOT say so -- the designation never reached the optimiser`,
    };
  }
  if (!o.played.has(k)) return { cls: "inactive", why: "no Friday designation and ZERO snaps -- a game-day scratch a Sunday re-read can catch" };
  return { cls: "played", why: "took snaps and scored nothing -- no feed recovers this" };
}
