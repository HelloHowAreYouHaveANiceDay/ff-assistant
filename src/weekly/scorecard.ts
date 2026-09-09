/**
 * THE FORWARD SCORECARD: what we predicted, what happened, accruing weekly.
 *
 * Everything else in this repo is a backtest. A backtest is a claim about a model measured by the
 * person who built it, on data that already existed when he built it, and every safeguard in
 * CLAUDE.md exists because that arrangement keeps producing numbers that do not survive contact with
 * a new season. The scorecard is the one measurement that cannot be gamed after the fact, and it
 * gets its integrity from ONE property:
 *
 *   A PREDICTION IS WRITTEN ONCE, BEFORE KICKOFF, AND NEVER UPDATED.
 *
 * `scorecard_prediction` is INSERT OR IGNORE. Re-running the snapshot is a no-op rather than a
 * rewrite, so a model that is improved mid-season cannot retroactively improve its record; it can
 * only start a new one. `scorecard_result` is the opposite -- freely rebuildable -- because scoring
 * is a pure function of a frozen prediction and a settled actual, and a rebuildable score with a
 * frozen prediction is exactly the right way round.
 *
 * THE SNAPSHOT REFUSES TO RUN LATE. If the week's first kickoff has passed, the snapshot for that
 * week is not taken. A "prediction" written after the games is the single failure this whole file
 * exists to prevent, and it would leave no trace: the row would look exactly like an honest one.
 *
 * THREE KINDS.
 *   weekly -- per player, per week: our model, the season line, the shipped week() path, trailing-4,
 *             and ESPN's own number where the bridge could read it.
 *   season -- per player, once: the preseason season projection, scored against points-to-date.
 *   odds   -- per team, once: playoff and title probability, scored by Brier once the season
 *             resolves. Written only where the store actually holds such a number; this file does
 *             not manufacture one.
 */
import { readFileSync } from "node:fs";
import { openDb, nowIso, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import { loadWeeklyArtifact, projectWeekly, seasonLineOnlyArtifact, type WeeklyArtifact } from "./projector.js";
import { loadWeeklyRows, loadSchedule, type ScheduleInfo } from "./features.js";
import { makeProjections } from "../projections.js";
import { score, lineupRegret, type Scored1, type Pred } from "./evaluate.js";
import { fetchEspnWeekly, storeEspnWeekly } from "./espnProjections.js";

export const SCORECARD_MODELS = ["weekly", "season_line", "shipped_week", "trailing4", "espn"] as const;
export type ScorecardModel = typeof SCORECARD_MODELS[number];
/** The model the weekly gains are quoted against, matching src/weekly/evaluate.ts. */
export const SC_BASELINE: ScorecardModel = "shipped_week";

export interface ScorecardOpts {
  dbPath?: string;
  season: number;
  /** Take the snapshot for the imminent week. */
  snapshot?: boolean;
  /** Score every week whose games are all settled. */
  score?: boolean;
  /** Also read ESPN's own weekly projection through the app bridge. */
  espn?: boolean;
  /** Snapshot a specific week rather than the imminent one. */
  week?: number;
  /** The date the run is anchored to. Injectable so a test can drive the refusal path. */
  today?: string;
  artifactPath?: string;
  rosters?: number;
  /** A pre-loaded schedule, so a test can drive the late-snapshot refusal without a network read. */
  sched?: ScheduleInfo;
}

export interface ScorecardResult {
  season: number;
  today: string;
  imminentWeek: number | null;
  snapshot: { week: number | null; taken: number; skipped: string | null; byModel: Record<string, number> };
  espn: { attempted: boolean; ok: boolean; reason: string; stored: number };
  seasonKind: { taken: number; skipped: string | null };
  oddsKind: { taken: number; skipped: string | null };
  scored: {
    week: number; model: string; n: number; rmse: number; crps: number; coverage: number;
    lineupPts: number; lineupWinShare: number;
  }[];
  seasonScored: { n: number; rmse: number; note: string } | null;
  notes: string[];
}

/**
 * TODAY, IN THE LOCAL CALENDAR. Not `toISOString().slice(0, 10)`, which is UTC.
 *
 * This is not pedantry, it cost the first live run. At 22:50 on 2026-09-08 in this timezone the UTC
 * date is already 2026-09-09, so the harness read week 1 -- whose as-of is 2026-09-08, the day before
 * its Thursday kickoff -- as ALREADY PLAYED, refused to snapshot it, and silently snapshotted week 2
 * instead. Nothing errored. The scorecard would have opened the season having frozen a week-2
 * prediction made before week 1 and no prediction at all for week 1, which is the worst of both:
 * a missing record and a needlessly bad one. The comparison is against a football gameday, and a
 * football gameday is a local-calendar date.
 */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The imminent week: the earliest REG week of the season whose first kickoff is still ahead. */
export function imminentWeek(sched: ScheduleInfo, season: number, today: string): number | null {
  const weeks = [...sched.weekAsOf.keys()].filter((k) => k.startsWith(`${season}|`))
    .map((k) => ({ week: Number(k.split("|")[1]), asOf: sched.weekAsOf.get(k)! }))
    .sort((a, b) => a.week - b.week);
  for (const w of weeks) if (w.asOf >= today) return w.week;
  return null;
}

/** Weeks all of whose games have a settled result in the feature table. */
function settledWeeks(db: DB, season: number, sched: ScheduleInfo, today: string): number[] {
  const rows = db.prepare(
    "SELECT week, COUNT(*) n, SUM(pts IS NOT NULL) scored FROM feat_player_week_model WHERE season = ? GROUP BY week",
  ).all(season) as { week: number; n: number; scored: number }[];
  const out: number[] = [];
  for (const r of rows) {
    const asOf = sched.weekAsOf.get(`${season}|${r.week}`);
    // "Settled" means the week's games are behind us AND someone scored in it. Either alone is not
    // enough: a week can be in the past with an unbuilt history file, which is missing data rather
    // than a week of zeros, and scoring it would record every model as catastrophically wrong.
    if (asOf && asOf < today && r.scored > 0) out.push(r.week);
  }
  return out.sort((a, b) => a - b);
}

/** Every model's prediction for one (season, week), from the feature table. */
function weeklyPredictions(db: DB, season: number, week: number, artifact: WeeklyArtifact, lineOnly: WeeklyArtifact) {
  const rows = loadWeeklyRows(db, season, week).filter((r) => r.season_line_pg != null);
  const out = new Map<string, { name: string; pos: string; by: Partial<Record<ScorecardModel, Pred>> }>();
  const put = (k: string, name: string, pos: string, m: ScorecardModel, p: Pred) => {
    const cur = out.get(k) ?? out.set(k, { name, pos, by: {} }).get(k)!;
    cur.by[m] = p;
  };
  for (const r of projectWeekly({ artifact, rows })) {
    put(r.feat_key, r.name, r.pos, "weekly", { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
  }
  for (const r of projectWeekly({ artifact: lineOnly, rows })) {
    put(r.feat_key, r.name, r.pos, "season_line", { mean: r.mean, p10: r.p10, p50: r.p50, p90: r.p90 });
  }
  // The SHIPPED path, called as the app calls it. gamesPerSeason 1 because season_line_pg is already
  // per game -- handing it 17 would divide the line a second time.
  const defRatings = new Map<string, number>();
  for (const r of rows) {
    const d = r.f.dvp_mult;
    if (r.opponent && d != null && Number.isFinite(d)) defRatings.set(`${r.opponent}|${r.pos}`, d);
  }
  const shipped = makeProjections({
    seasonPoints: rows.map((r) => ({ name: r.feat_key, pos: r.pos, season: r.season_line_pg! })),
    defRatings, gamesPerSeason: 1,
  });
  for (const r of rows) {
    const v = shipped.week(r.feat_key, r.pos, r.opponent ?? undefined);
    put(r.feat_key, r.name, r.pos, "shipped_week", { mean: v, p10: NaN, p50: NaN, p90: NaN });
    const t4 = r.f.t4_mean ?? r.f.td_ppg ?? r.season_line_pg!;
    put(r.feat_key, r.name, r.pos, "trailing4", { mean: t4, p10: NaN, p50: NaN, p90: NaN });
  }
  // ESPN. TWO THINGS TO KNOW BEFORE READING ITS SCORE.
  //
  // (1) POPULATION. Our weekly model is fitted on `rostered` weeks, so it prices in the chance the
  // man does not play; ESPN's published number reads like a projection conditioned on playing. On
  // 2026 week 1, over the 430 players both cover, our mean is 5.22 and ESPN's 5.95. When the week is
  // scored, ESPN will look biased high against rostered actuals, and that is a difference in the
  // question being answered, not a defect. Read CRPS and lineup regret, not the bias column.
  //
  // (2) THE JOIN is by name+position, not by surrogate key: raw_espn_projection carries ESPN's own
  // id, which nothing in the identity registry maps yet, and inventing a mapping here would silently
  // attach one man's projection to another. A name+pos join misses the collisions Phase 1 fixed on
  // the board and that is stated rather than hidden -- the row count is reported (430 of 523).
  const espn = db.prepare(
    "SELECT name, pos, proj_pts FROM raw_espn_projection WHERE season = ? AND week = ?",
  ).all(season, week) as { name: string; pos: string; proj_pts: number }[];
  if (espn.length) {
    const byName = new Map(espn.map((e) => [`${e.name.toLowerCase()}|${e.pos}`, e.proj_pts]));
    for (const r of rows) {
      const v = byName.get(`${r.name.toLowerCase()}|${r.pos}`);
      if (v != null) put(r.feat_key, r.name, r.pos, "espn", { mean: v, p10: NaN, p50: NaN, p90: NaN });
    }
  }
  return out;
}

function lineOnlyArtifactFor(db: DB, season: number): WeeklyArtifact {
  // Quantiles measured on seasons STRICTLY BEFORE the one being scored. Measuring them on the live
  // season would put its own results into its own baseline.
  const rows = db.prepare(
    `SELECT pos, COALESCE(pts, 0.0) / season_line_pg AS r FROM feat_player_week_model
      WHERE COALESCE(is_bye, 0) = 0 AND season_line_pg > 0 AND season < ?`,
  ).all(season) as { pos: string; r: number }[];
  const byPos: Record<string, number[]> = {};
  for (const r of rows) (byPos[r.pos] ??= []).push(r.r);
  const q: Record<string, { p10: number; p50: number; p90: number }> = {};
  const quant = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : 1;
  };
  for (const [pos, v] of Object.entries(byPos)) q[pos] = { p10: quant(v, 0.10), p50: quant(v, 0.50), p90: quant(v, 0.90) };
  // No prior season in this store at all -- a fresh install, or a fixture. The positions then come
  // from the live season and the quantiles collapse onto 1.0, which is seasonLineOnlyArtifact's
  // stated "we have no spread" rather than an invented one. Building an artifact with no positions
  // instead would be refused by the loader and take the whole scorecard down over a missing baseline.
  if (!Object.keys(q).length) {
    const live = db.prepare(
      "SELECT DISTINCT pos FROM feat_player_week_model WHERE season = ? AND pos IS NOT NULL",
    ).all(season) as { pos: string }[];
    const positions = live.map((r) => r.pos);
    if (!positions.length) {
      throw new Error(`scorecard: no feature rows for ${season} -- build the weekly features first`);
    }
    return loadWeeklyArtifact(seasonLineOnlyArtifact({ positions, seasons: [season - 1] }));
  }
  return loadWeeklyArtifact(seasonLineOnlyArtifact({ positions: Object.keys(q), seasons: [season - 1], quantiles: q }));
}

export async function runScorecard(opts: ScorecardOpts): Promise<ScorecardResult> {
  const db = openDb(opts.dbPath);
  const today = opts.today ?? iso(new Date());
  const notes: string[] = [];
  const res: ScorecardResult = {
    season: opts.season, today, imminentWeek: null,
    snapshot: { week: null, taken: 0, skipped: null, byModel: {} },
    espn: { attempted: false, ok: false, reason: "not attempted", stored: 0 },
    seasonKind: { taken: 0, skipped: null },
    oddsKind: { taken: 0, skipped: null },
    scored: [], seasonScored: null, notes,
  };
  try {
    const sched = opts.sched ?? await loadSchedule([opts.season]);
    const imm = imminentWeek(sched, opts.season, today);
    res.imminentWeek = imm;
    const artifact = loadWeeklyArtifact(JSON.parse(readFileSync(opts.artifactPath ?? dataPath("weekly-artifact.json"), "utf8")));
    const lineOnly = lineOnlyArtifactFor(db, opts.season);

    // ---------------- SNAPSHOT ----------------
    if (opts.snapshot !== false) {
      const week = opts.week ?? imm;
      res.snapshot.week = week;
      const asOf = week != null ? sched.weekAsOf.get(`${opts.season}|${week}`) : undefined;
      if (week == null) {
        res.snapshot.skipped = `no week of ${opts.season} still has its first kickoff ahead of ${today}`;
      } else if (!asOf) {
        res.snapshot.skipped = `the schedule feed has no gameday for ${opts.season} week ${week}`;
      } else if (asOf < today) {
        // THE REFUSAL. A prediction written after kickoff is indistinguishable from an honest one in
        // the table, so it is refused here rather than flagged later.
        res.snapshot.skipped = `week ${week} kicked off on ${asOf} (as-of), which is before ${today} -- ` +
          "refusing to write a 'prediction' after the games. A prediction snapshotted late leaves no " +
          "trace in the row and would silently flatter every model in it.";
      } else {
        if (opts.espn) {
          res.espn.attempted = true;
          const lg = (db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get() as { league_id?: string } | undefined)?.league_id;
          const f = await fetchEspnWeekly({ season: opts.season, week, leagueId: lg });
          res.espn.ok = f.ok; res.espn.reason = f.reason;
          if (f.ok) res.espn.stored = storeEspnWeekly(db, f.rows, asOf);
        }
        const preds = weeklyPredictions(db, opts.season, week, artifact, lineOnly);
        const ins = db.prepare(
          `INSERT OR IGNORE INTO scorecard_prediction
             (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
           VALUES (@season,@week,'weekly',@model,@subject,@name,@pos,@value,@p10,@p90,@asOf,@now)`,
        );
        const now = nowIso();
        db.transaction(() => {
          for (const [key, v] of preds) {
            for (const m of SCORECARD_MODELS) {
              const p = v.by[m];
              if (!p || !Number.isFinite(p.mean)) continue;
              const info = ins.run({
                season: opts.season, week, model: m, subject: key, name: v.name, pos: v.pos,
                value: p.mean, p10: Number.isFinite(p.p10) ? p.p10 : null,
                p90: Number.isFinite(p.p90) ? p.p90 : null, asOf, now,
              });
              if (info.changes) { res.snapshot.taken++; res.snapshot.byModel[m] = (res.snapshot.byModel[m] ?? 0) + 1; }
            }
          }
        })();
        if (!res.snapshot.taken) {
          notes.push(`week ${week} was already snapshotted -- predictions are written once and never ` +
            "updated, so a re-run is a no-op rather than a rewrite.");
        }
      }

      // ---- season kind: the preseason season projection, one row per player. ----
      const seasonRows = db.prepare(
        `SELECT feat_key, name, pos, MAX(season_line_pg) AS line, COUNT(*) AS weeks
           FROM feat_player_week_model WHERE season = ? AND season_line_pg IS NOT NULL GROUP BY feat_key`,
      ).all(opts.season) as { feat_key: string; name: string; pos: string; line: number; weeks: number }[];
      if (!seasonRows.length) {
        res.seasonKind.skipped = `no season lines for ${opts.season} -- run \`ff build-weekly-features\` first`;
      } else {
        const insS = db.prepare(
          `INSERT OR IGNORE INTO scorecard_prediction
             (season, week, kind, model, subject, name, pos, value, p10, p90, as_of, created_at)
           VALUES (@season,0,'season','season_line',@subject,@name,@pos,@value,NULL,NULL,@asOf,@now)`,
        );
        const now = nowIso();
        const asOf = `${opts.season}-09-01`;
        db.transaction(() => {
          for (const r of seasonRows) {
            // The season total, not the per-game line: what is scored against is points-to-date at
            // season end, and storing the per-game figure would need a games count nobody has yet.
            const info = insS.run({ season: opts.season, subject: r.feat_key, name: r.name, pos: r.pos, value: r.line * r.weeks, asOf, now });
            if (info.changes) res.seasonKind.taken++;
          }
        })();
      }

      // ---- odds kind. Written only where the store HOLDS a playoff/title probability. ----
      const hasOdds = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='team_odds'").get() as { c: number };
      if (!hasOdds.c) {
        res.oddsKind.skipped = "no odds table in this store";
      } else {
        const cols = db.prepare("PRAGMA table_info(team_odds)").all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        if (!names.has("playoff_prob") && !names.has("title_prob")) {
          res.oddsKind.skipped =
            "team_odds carries a game spread and total, not a playoff or title probability. The " +
            "'odds' kind is left EMPTY rather than manufacturing one from the spread -- a Brier " +
            "score accrued against a number we invented would measure our own arithmetic.";
        }
      }
    }

    // ---------------- SCORE ----------------
    if (opts.score !== false) {
      const weeks = settledWeeks(db, opts.season, sched, today);
      if (!weeks.length) notes.push(`no settled weeks of ${opts.season} to score as of ${today}`);
      const all: Scored1[] = [];
      for (const week of weeks) {
        const frozen = db.prepare(
          "SELECT model, subject, name, pos, value, p10, p90 FROM scorecard_prediction WHERE season = ? AND week = ? AND kind = 'weekly'",
        ).all(opts.season, week) as { model: string; subject: string; name: string; pos: string; value: number; p10: number | null; p90: number | null }[];
        if (!frozen.length) { notes.push(`week ${week} is settled but was never snapshotted -- nothing to score`); continue; }
        const actual = new Map<string, number>();
        for (const r of db.prepare(
          "SELECT feat_key, pts, is_bye FROM feat_player_week_model WHERE season = ? AND week = ?",
        ).all(opts.season, week) as { feat_key: string; pts: number | null; is_bye: number | null }[]) {
          if (!r.is_bye) actual.set(r.feat_key, r.pts ?? 0);
        }
        const bySubject = new Map<string, Scored1>();
        for (const f of frozen) {
          const y = actual.get(f.subject);
          if (y == null) continue;
          const s = bySubject.get(f.subject) ?? bySubject.set(f.subject, {
            key: f.subject, pos: f.pos, band: "all", season: opts.season, week, actual: y, by: {},
          }).get(f.subject)!;
          // A point-only model gets no interval, and its CRPS and coverage are therefore not
          // reported. Fabricating a band here would let a point forecast score as a distribution.
          s.by[f.model] = {
            mean: f.value,
            p10: f.p10 ?? NaN, p50: f.value, p90: f.p90 ?? NaN,
          };
        }
        all.push(...bySubject.values());

        const models = [...new Set(frozen.map((f) => f.model))].sort();
        const lr = lineupRegret([...bySubject.values()], opts.rosters ?? 200, { models, baseline: SC_BASELINE });
        const sc = Object.keys(lr)[0];
        for (const m of models) {
          const rows = [...bySubject.values()].filter((r) => r.by[m]).map((r) => ({ actual: r.actual, p: r.by[m] }));
          const hasBand = rows.length > 0 && rows.every((r) => Number.isFinite(r.p.p10) && Number.isFinite(r.p.p90));
          const s = score(rows);
          res.scored.push({
            week, model: m, n: s.n, rmse: s.rmse,
            crps: hasBand ? s.crps : NaN, coverage: hasBand ? s.coverage : NaN,
            lineupPts: lr[sc]?.[m]?.meanCaptured ?? NaN,
            lineupWinShare: lr[sc]?.[m]?.winShare ?? NaN,
          });
        }
      }

      // Persist the scored rows. Rebuildable BY DESIGN, unlike the predictions.
      const insR = db.prepare(
        `INSERT INTO scorecard_result (season, week, kind, model, metric, value, n, scored_at)
         VALUES (@season,@week,'weekly',@model,@metric,@value,@n,@now)
         ON CONFLICT(season, week, kind, model, metric) DO UPDATE SET
           value=excluded.value, n=excluded.n, scored_at=excluded.scored_at`,
      );
      const now = nowIso();
      db.transaction(() => {
        for (const r of res.scored) {
          for (const [metric, value] of [["rmse", r.rmse], ["crps", r.crps], ["coverage", r.coverage],
            ["lineup_pts", r.lineupPts], ["lineup_win_share", r.lineupWinShare]] as [string, number][]) {
            if (Number.isFinite(value)) insR.run({ season: opts.season, week: r.week, model: r.model, metric, value, n: r.n, now });
          }
        }
      })();

      // ---- the season kind, scored against points to date. ----
      const sp = db.prepare(
        "SELECT subject, value FROM scorecard_prediction WHERE season = ? AND kind = 'season'",
      ).all(opts.season) as { subject: string; value: number }[];
      if (sp.length && weeks.length) {
        const todate = new Map<string, number>();
        for (const r of db.prepare(
          `SELECT feat_key, SUM(COALESCE(pts, 0.0)) AS p FROM feat_player_week_model
            WHERE season = ? AND week <= ? AND COALESCE(is_bye,0)=0 GROUP BY feat_key`,
        ).all(opts.season, Math.max(...weeks)) as { feat_key: string; p: number }[]) todate.set(r.feat_key, r.p);
        const share = Math.max(...weeks) / 17;
        const pairs = sp.filter((r) => todate.has(r.subject))
          .map((r) => ({ pred: r.value * share, act: todate.get(r.subject)! }));
        if (pairs.length) {
          const rmse = Math.sqrt(pairs.reduce((s, p) => s + (p.pred - p.act) ** 2, 0) / pairs.length);
          res.seasonScored = {
            n: pairs.length, rmse,
            note: `preseason season projection prorated to ${Math.max(...weeks)}/17 of a season, ` +
              "against points scored so far. Prorating is the only honest comparison mid-season and " +
              "it assumes an even scoring rate, which is a stated approximation, not a measurement.",
          };
        }
      }
    }
  } finally { db.close(); }
  return res;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const num = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");

export function formatScorecard(r: ScorecardResult): string {
  const out: string[] = [];
  out.push(`SCORECARD ${r.season} -- as of ${r.today}; imminent week ${r.imminentWeek ?? "(none)"}`);
  out.push("");
  out.push("SNAPSHOT (written once, never updated)");
  if (r.snapshot.skipped) out.push(`  week ${r.snapshot.week ?? "-"}: SKIPPED -- ${r.snapshot.skipped}`);
  else {
    out.push(`  week ${r.snapshot.week}: ${r.snapshot.taken} new prediction rows`);
    for (const [m, n] of Object.entries(r.snapshot.byModel)) out.push(`    ${pad(m, 14)} ${n}`);
  }
  out.push(`  season kind: ${r.seasonKind.taken} rows${r.seasonKind.skipped ? " -- " + r.seasonKind.skipped : ""}`);
  out.push(`  odds kind:   ${r.oddsKind.taken} rows${r.oddsKind.skipped ? " -- " + r.oddsKind.skipped : ""}`);
  out.push(`  espn:        ${r.espn.attempted ? (r.espn.ok ? `${r.espn.stored} stored` : "not stored") : "not attempted"} -- ${r.espn.reason}`);
  out.push("");
  out.push("SCORED WEEKS");
  if (!r.scored.length) out.push("  (nothing settled yet)");
  else {
    out.push("  " + pad("week", 6) + pad("model", 14) + "      n     RMSE     CRPS    cover   lineup  winShare");
    for (const s of r.scored) {
      out.push("  " + pad(String(s.week), 6) + pad(s.model, 14) + String(s.n).padStart(7) +
        num(s.rmse).padStart(9) + num(s.crps).padStart(9) + num(s.coverage).padStart(9) +
        num(s.lineupPts, 2).padStart(9) + num(s.lineupWinShare).padStart(10));
    }
  }
  if (r.seasonScored) {
    out.push("");
    out.push(`SEASON KIND: n=${r.seasonScored.n}, RMSE ${r.seasonScored.rmse.toFixed(2)}`);
    out.push(`  ${r.seasonScored.note}`);
  }
  if (r.notes.length) {
    out.push("");
    out.push("NOTES");
    for (const n of r.notes) out.push(`  ${n}`);
  }
  return out.join("\n");
}
