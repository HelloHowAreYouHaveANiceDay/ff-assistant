/**
 * BACKTEST 1b: THE WIN-PROBABILITY LINEUP AGAINST THIS LEAGUE'S REAL MATCHUPS.
 *
 * `backtest/lineup.ts` asks whether our lineup rule scores more POINTS than the managers did. This
 * asks the only question the league actually pays out on: does it WIN MORE GAMES. They are not the
 * same question, and the gap between them is the whole reason this file exists -- a lineup that
 * scores two points fewer and wins one more game a season is a better lineup, and a points-only
 * replay would have reported it as a regression.
 *
 * For every team-week from 2018 on where the schedule names an opponent, three lineups on the SAME
 * roster and the SAME point-in-time projections:
 *
 *   manager    what he actually started, from fact_lineup_week
 *   ep         `optimalLineup` over the projector's means -- the rule that ships today
 *   winprob    `winProbLineup` over the projector's BANDS against that opponent's projected total
 *
 * and one bar, which is the same for all three: THE OPPONENT'S ACTUAL POINTS THAT WEEK. Not his
 * simulated total, not his projection -- the real result, out of `fact_lineup_week.started_pts`.
 * Scoring our lineup against a simulated opponent would be scoring a decision against the model that
 * made it, and it would flatter whichever lineup the model liked.
 *
 * WHAT THE WIN-PROBABILITY LINEUP IS ALLOWED TO KNOW. Exactly what the expected-points lineup knows:
 * `loadWeekContext`'s point-in-time block, anchored the day before the week's first kickoff, plus the
 * OPPONENT'S ROSTER as of the same anchor and his projected lineup on the same projections. Nothing
 * reads `pts` for the week being decided; that column reaches this file only through `actual`, and
 * only after a lineup has been chosen. The opponent's REALISED total is used to score, never to
 * choose -- if it were an input, this replay would report a win rate near 100% and look like a
 * triumph.
 *
 * THE BANDS. `loadWeekContext` keeps only the projector's MEAN, so this file re-runs `projectWeekly`
 * on the same rows and the same artifact to recover p10/p50/p90 and P(zero week). Same artifact,
 * same rows, same week: the mean it recovers is asserted equal to the context's, so a drift between
 * the two paths cannot pass silently.
 *
 * A ROSTERED MAN THE PROJECTOR HAS NO ROW FOR has no band either. Giving him none would make him a
 * POINT MASS -- a zero-variance player -- which the floor side of the search would prefer for
 * entirely the wrong reason. So he is given the MEASURED shape of his position in that same week:
 * the median p10/mean, p50/mean and p90/mean over every projected row at his position, applied to
 * his fallback mean. That is a measurement from the same point-in-time data rather than an
 * assumption, and the share of men it covers is reported.
 */
import { readFileSync } from "node:fs";
import type { DB } from "../../db/db.js";
import { dataPath } from "../../data/paths.js";
import { optimalLineup, type RosterPlayer } from "../lineup.js";
import { loadWeeklyRows } from "../../weekly/features.js";
import { projectWeekly } from "../../weekly/projector.js";
import { winProbLineup, opponentStarters, WINPROB_COUPLING_DEFAULT, type WinProbPlayer, type WeeklyBand } from "../winprob.js";
import { loadWeekContext, loadModel, type ModelName, type WeekContext } from "./context.js";
import type { CorrelationModel } from "../../draft/bootstrap.js";
import { mean, r2, r3 } from "./lineup.js";

export interface WinProbRow {
  season: number; week: number; teamId: string; oppId: string;
  /** Point-in-time: our EP projected total minus the opponent's EP projected total. */
  projMargin: number;
  bucket: "under5" | "5to15" | "over15";
  /** The bar. The opponent's REAL points that week. */
  oppActual: number;
  managerPts: number; epPts: number; wpPts: number;
  managerWin: number; epWin: number; wpWin: number;   // 1 / 0.5 / 0
  hindsightPts: number; hindsightWin: number;
  /** How many starters differ between the two lineups. */
  differs: number;
  /** Projected points the win-probability lineup gave up. */
  epCost: number;
  /** Its own estimate of what it bought, in percentage points of P(win). */
  gainPp: number;
  posture: "underdog" | "even" | "favourite";
  swaps: number;
  fellBack: number; rosterN: number;
}

export interface BucketSummary {
  bucket: string; teamWeeks: number;
  epWinPct: number; wpWinPct: number; gainPp: number;
  managerWinPct: number; hindsightWinPct: number;
  differShare: number; meanEpCost: number;
  /** What the search CLAIMED it was buying, in percentage points of P(win), under its own sampler.
   *  Beside the realised gain it is the only thing that separates "the objective is wrong" from
   *  "the distribution the objective was taken under is wrong". */
  claimedGainPp: number;
}

export interface WinProbSummary {
  model: ModelName;
  teamWeeks: number; seasons: number[];
  sims: number; coupling: number;
  epWinPct: number; wpWinPct: number; gainPp: number;
  managerWinPct: number; hindsightWinPct: number;
  meanEpPts: number; meanWpPts: number; meanManagerPts: number; meanOppActual: number;
  /** Mean projected points a week the win-probability lineup gives up. */
  meanEpCost: number;
  claimedGainPp: number;
  differShare: number;
  bandFallbackRate: number;
  buckets: BucketSummary[];
  perSeason: { season: number; teamWeeks: number; epWinPct: number; wpWinPct: number; gainPp: number; epCost: number }[];
  /**
   * A CONSERVATION LAW, and the cheapest proof that the replay is wired to the real results at all.
   *
   * Both sides of every matchup are rows, and every real game has exactly one winner, so the
   * MANAGERS' win rate over the whole set must be exactly 50% -- ties counted as half. It cannot be
   * anything else, whatever the projections say, and a run that reports 47% or 53% has mismatched a
   * team to the wrong opponent's realised total, dropped one side of some matchups, or read the
   * wrong column. Every other number on this summary would still look completely plausible.
   */
  pairedInvariant: { name: string; got: number; want: number; tol: number; ok: boolean };
  /** Team-weeks skipped, with the reason, so a shrinking denominator cannot pass unremarked. */
  skipped: Record<string, number>;
}

const BUCKET = (m: number): WinProbRow["bucket"] =>
  Math.abs(m) < 5 ? "under5" : Math.abs(m) <= 15 ? "5to15" : "over15";

/**
 * THE MEASURED SHAPE OF A POSITION IN ONE WEEK: median p10/mean, p50/mean, p90/mean over every row
 * the projector produced at that position. Used only for a man the projector had no row for, so that
 * he is not silently a certainty. A position with fewer than five projected rows gets no shape and
 * its men stay point masses -- reported rather than filled in with the league average.
 */
export function positionShapes(proj: { pos: string; mean: number; p10: number; p50: number; p90: number; pZero?: number }[]):
  Map<string, { p10: number; p50: number; p90: number; pZero: number }> {
  const by = new Map<string, { p10: number[]; p50: number[]; p90: number[]; pZero: number[] }>();
  for (const p of proj) {
    if (!(p.mean > 0)) continue;
    if (!by.has(p.pos)) by.set(p.pos, { p10: [], p50: [], p90: [], pZero: [] });
    const b = by.get(p.pos)!;
    b.p10.push(p.p10 / p.mean); b.p50.push(p.p50 / p.mean); b.p90.push(p.p90 / p.mean);
    b.pZero.push(p.pZero ?? 0);
  }
  const med = (xs: number[]): number => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const out = new Map<string, { p10: number; p50: number; p90: number; pZero: number }>();
  for (const [pos, b] of by) {
    if (b.p10.length < 5) continue;
    out.set(pos, { p10: med(b.p10), p50: med(b.p50), p90: med(b.p90), pZero: med(b.pZero) });
  }
  return out;
}

interface Bands { byPlayer: Map<string, WeeklyBand>; teamOf: Map<string, string | null>; shapes: ReturnType<typeof positionShapes> }

/** p10/p50/p90/pZero per player_sk for one week, from the SAME artifact the context used. */
function loadBands(db: DB, season: number, week: number, artifact: ReturnType<typeof loadModel>): Bands {
  const rows = loadWeeklyRows(db, season, week);
  const proj = projectWeekly({ artifact, rows });
  const byPlayer = new Map<string, WeeklyBand>();
  for (const p of proj) {
    if (p.player_sk == null) continue;
    const prev = byPlayer.get(p.player_sk);
    if (prev == null || p.mean > prev.mean) {
      byPlayer.set(p.player_sk, { mean: p.mean, p10: p.p10, p50: p.p50, p90: p.p90, pZero: p.pZero ?? null, source: "projector" });
    }
  }
  const teamOf = new Map<string, string | null>();
  for (const r of db.prepare(
    `SELECT player_sk, team FROM feat_player_week_model WHERE season=? AND week=? AND player_sk IS NOT NULL`,
  ).all(season, week) as { player_sk: string; team: string | null }[]) teamOf.set(r.player_sk, r.team);
  return { byPlayer, teamOf, shapes: positionShapes(proj) };
}

/** One roster's entries, in the sampler's shape. */
function toWinProbPlayers(
  ctx: WeekContext, entries: { playerSk: string; name: string; pos: string; lineupSlotId: number }[], b: Bands,
): { players: WinProbPlayer[]; fellBack: number; noBand: number } {
  const players: WinProbPlayer[] = [];
  let fellBack = 0, noBand = 0;
  for (const e of entries) {
    if (e.lineupSlotId === 21) continue;            // the IR slot is not startable
    const p = ctx.players.get(e.playerSk);
    const projected = p?.proj ?? null;
    if (projected == null) fellBack++;
    const m = projected ?? p?.fallback ?? 0;
    let band = b.byPlayer.get(e.playerSk) ?? null;
    // THE TWO PATHS MUST AGREE. `loadWeekContext` keeps the projector's mean and this file re-runs
    // the projector for the band. If the two ever disagree, the band belongs to a different
    // projection from the one the expected-points lineup was chosen on, and every comparison below
    // is between two MODELS rather than two objectives. Same artifact, same rows, same week -- so a
    // difference is a wiring fault, and it fails loudly rather than quietly shifting a number.
    if (band && projected != null && Math.abs(band.mean - projected) > 1e-6) {
      throw new Error(
        `band/mean drift for ${e.name} (${e.playerSk}) in ${ctx.season} week ${ctx.week}: the context ` +
        `has ${projected} and the re-run projector has ${band.mean}. The two lineups would then be ` +
        `chosen on different projections, which is not the comparison this backtest claims to make.`,
      );
    }
    if (!band || projected == null) {
      // No projector row -- his shape is his POSITION's measured shape this week, scaled to his
      // fallback mean. Absent even that, he stays a point mass and is counted.
      const sh = b.shapes.get(e.pos);
      band = sh && m > 0
        ? { mean: m, p10: m * sh.p10, p50: m * sh.p50, p90: m * sh.p90, pZero: sh.pZero, source: "position-shape" }
        : null;
      if (!band) noBand++;
    }
    players.push({
      name: `${e.name}#${e.playerSk}`, pos: e.pos,
      available: p ? p.available : true,
      team: b.teamOf.get(e.playerSk) ?? null,
      proj: m,
      band,
    });
  }
  return { players, fellBack, noBand };
}

const scoreOn = (ctx: WeekContext, names: { name: string }[]): number => {
  let t = 0;
  for (const s of names) {
    if (s.name === "(empty)") continue;
    t += ctx.players.get(s.name.split("#")[1])?.actual ?? 0;
  }
  return t;
};

const wl = (ours: number, theirs: number): number => (ours > theirs ? 1 : ours === theirs ? 0.5 : 0);

export function backtestWinProbLineups(
  db: DB, leagueId: string,
  opts: { seasons: number[]; model: ModelName; sims?: number; seed?: number; corr?: CorrelationModel; noSearch?: boolean },
): { rows: WinProbRow[]; summary: WinProbSummary } {
  const artifact = loadModel(opts.model);
  const sims = opts.sims ?? 1200;
  const baseSeed = opts.seed ?? 20260909;
  const corr = opts.corr ?? (JSON.parse(readFileSync(dataPath("correlation-model.json"), "utf8")) as CorrelationModel);
  const rows: WinProbRow[] = [];
  const skipped: Record<string, number> = {};
  const bump = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  const seasonsSeen = new Set<number>();
  let rosterTotal = 0, noBandTotal = 0;

  for (const season of opts.seasons) {
    const weeks = db.prepare(
      `SELECT DISTINCT week FROM fact_lineup_week WHERE season=? ORDER BY week`,
    ).all(season) as { week: number }[];
    if (!weeks.length) continue;
    for (const { week } of weeks) {
      const games = db.prepare(
        `SELECT home_id, away_id FROM fact_matchup WHERE season=? AND week=?`,
      ).all(season, week) as { home_id: string; away_id: string }[];
      if (!games.length) { bump("no fact_matchup row for the week"); continue; }

      const ctx = loadWeekContext(db, leagueId, season, week, artifact);
      if (!ctx.rosters.size || !ctx.template.length) { bump("no roster state or no starting template"); continue; }
      const bands = loadBands(db, season, week, artifact);
      const actual = new Map((db.prepare(
        `SELECT team_id, started_pts, optimal_pts, roster_n FROM fact_lineup_week WHERE season=? AND week=?`,
      ).all(season, week) as { team_id: string; started_pts: number; optimal_pts: number; roster_n: number }[])
        .map((r) => [r.team_id, r]));

      for (const g of games) {
        for (const [us, them] of [[g.home_id, g.away_id], [g.away_id, g.home_id]] as [string, string][]) {
          const ourEntries = ctx.rosters.get(us), theirEntries = ctx.rosters.get(them);
          const ourReal = actual.get(us), theirReal = actual.get(them);
          if (!ourEntries || !theirEntries || !ourReal || !theirReal) { bump("a side of the matchup has no roster or no realised lineup"); continue; }

          const ours = toWinProbPlayers(ctx, ourEntries, bands);
          const theirs = toWinProbPlayers(ctx, theirEntries, bands);
          rosterTotal += ours.players.length;
          noBandTotal += ours.noBand;

          const asRoster = (ps: WinProbPlayer[]): RosterPlayer[] =>
            ps.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, available: p.available }));
          const epRes = optimalLineup(asRoster(ours.players), ctx.template, ["RB", "WR", "TE"]);
          const theirEp = optimalLineup(asRoster(theirs.players), ctx.template, ["RB", "WR", "TE"]);
          const theirProjTotal = theirEp.starters.reduce((a, s) => a + s.proj, 0);
          const ourProjTotal = epRes.starters.reduce((a, s) => a + s.proj, 0);
          const projMargin = ourProjTotal - theirProjTotal;

          // SEEDED PER TEAM-WEEK, so the two lineups of one team-week are a matched pair and two
          // team-weeks are independent draws. A single global seed would correlate every week's
          // sampler noise with every other's and make the season bootstrap below far too tight.
          const seed = (baseSeed + season * 100000 + week * 1000 + Number(us) * 7) >>> 0;
          const wp = winProbLineup(
            ours.players,
            opponentStarters(theirs.players.filter((p) => p.available), ctx.template, ["RB", "WR", "TE"]),
            ctx.template, ["RB", "WR", "TE"],
            { sims, seed, corr, noSearch: opts.noSearch },
          );

          const epPts = scoreOn(ctx, epRes.starters);
          const wpPts = scoreOn(ctx, wp.starters);
          const oppActual = theirReal.started_pts;
          const epNames = new Set(epRes.starters.filter((s) => s.name !== "(empty)").map((s) => s.name));
          const differs = wp.starters.filter((s) => !epNames.has(s.name)).length;

          rows.push({
            season, week, teamId: us, oppId: them,
            projMargin: r2(projMargin), bucket: BUCKET(projMargin),
            oppActual: r2(oppActual),
            managerPts: r2(ourReal.started_pts), epPts: r2(epPts), wpPts: r2(wpPts),
            managerWin: wl(ourReal.started_pts, oppActual), epWin: wl(epPts, oppActual), wpWin: wl(wpPts, oppActual),
            hindsightPts: r2(ourReal.optimal_pts), hindsightWin: wl(ourReal.optimal_pts, oppActual),
            differs, epCost: r2(wp.epCostPts), gainPp: wp.gainPp, posture: wp.posture, swaps: wp.swaps.length,
            fellBack: ours.fellBack, rosterN: ourReal.roster_n,
          });
          seasonsSeen.add(season);
        }
      }
    }
  }

  const pctOf = (rs: WinProbRow[], f: (r: WinProbRow) => number): number => r3(100 * mean(rs.map(f)));
  const bucketOf = (name: BucketSummary["bucket"], rs: WinProbRow[]): BucketSummary => ({
    bucket: name, teamWeeks: rs.length,
    epWinPct: pctOf(rs, (r) => r.epWin), wpWinPct: pctOf(rs, (r) => r.wpWin),
    gainPp: r3(pctOf(rs, (r) => r.wpWin) - pctOf(rs, (r) => r.epWin)),
    managerWinPct: pctOf(rs, (r) => r.managerWin), hindsightWinPct: pctOf(rs, (r) => r.hindsightWin),
    differShare: r3(mean(rs.map((r) => (r.differs > 0 ? 1 : 0)))),
    claimedGainPp: r3(mean(rs.map((r) => r.gainPp))),
    meanEpCost: r2(mean(rs.map((r) => r.epCost))),
  });

  return {
    rows,
    summary: {
      model: opts.model, teamWeeks: rows.length, seasons: [...seasonsSeen].sort(),
      sims, coupling: WINPROB_COUPLING_DEFAULT,
      epWinPct: pctOf(rows, (r) => r.epWin),
      wpWinPct: pctOf(rows, (r) => r.wpWin),
      gainPp: r3(pctOf(rows, (r) => r.wpWin) - pctOf(rows, (r) => r.epWin)),
      managerWinPct: pctOf(rows, (r) => r.managerWin),
      hindsightWinPct: pctOf(rows, (r) => r.hindsightWin),
      meanEpPts: r2(mean(rows.map((r) => r.epPts))),
      meanWpPts: r2(mean(rows.map((r) => r.wpPts))),
      meanManagerPts: r2(mean(rows.map((r) => r.managerPts))),
      meanOppActual: r2(mean(rows.map((r) => r.oppActual))),
      meanEpCost: r2(mean(rows.map((r) => r.epCost))),
      claimedGainPp: r3(mean(rows.map((r) => r.gainPp))),
      differShare: r3(mean(rows.map((r) => (r.differs > 0 ? 1 : 0)))),
      bandFallbackRate: r3(noBandTotal / Math.max(1, rosterTotal)),
      buckets: (["under5", "5to15", "over15"] as const).map((b) => bucketOf(b, rows.filter((r) => r.bucket === b))),
      perSeason: [...seasonsSeen].sort().map((s) => {
        const sub = rows.filter((r) => r.season === s);
        return {
          season: s, teamWeeks: sub.length,
          epWinPct: pctOf(sub, (r) => r.epWin), wpWinPct: pctOf(sub, (r) => r.wpWin),
          gainPp: r3(pctOf(sub, (r) => r.wpWin) - pctOf(sub, (r) => r.epWin)),
          epCost: r2(mean(sub.map((r) => r.epCost))),
        };
      }),
      pairedInvariant: {
        name: "both sides of every matchup are present, so the MANAGERS win exactly half of all team-weeks",
        got: pctOf(rows, (r) => r.managerWin), want: 50, tol: 0.5,
        ok: Math.abs(pctOf(rows, (r) => r.managerWin) - 50) <= 0.5,
      },
      skipped,
    },
  };
}

/**
 * SEASON-LEVEL BOOTSTRAP ON THE PAIRED WIN DIFFERENCE.
 *
 * The unit of analysis is the SEASON, not the team-week: 1,800-odd team-weeks are eight seasons of
 * correlated draws, and every pair of rows from one matchup shares an opponent's realised total. The
 * same rule CLAUDE.md states for the championship backtest, and the same rule `seasonBootstrap` in
 * `backtest/lineup.ts` follows -- resampled here on (wpWin - epWin), which is a MATCHED difference
 * under common random numbers, not a difference of two aggregates.
 */
export function seasonBootstrapWins(
  rows: { season: number; wpWin: number; epWin: number }[], iters = 4000, seed = 20260909,
): { meanPp: number; loPp: number; hiPp: number; seasons: number; pGreaterZero: number } {
  const bySeason = new Map<number, number[]>();
  for (const r of rows) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season)!.push(100 * (r.wpWin - r.epWin));
  }
  const seasons = [...bySeason.values()];
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const draws: number[] = [];
  for (let i = 0; i < iters; i++) {
    const picked: number[] = [];
    for (let k = 0; k < seasons.length; k++) picked.push(...seasons[Math.floor(rnd() * seasons.length)]);
    draws.push(mean(picked));
  }
  draws.sort((a, b) => a - b);
  return {
    meanPp: r3(mean(rows.map((r) => 100 * (r.wpWin - r.epWin)))),
    loPp: r3(draws[Math.floor(0.025 * draws.length)]),
    hiPp: r3(draws[Math.floor(0.975 * draws.length)]),
    seasons: seasons.length,
    pGreaterZero: r3(draws.filter((d) => d > 0).length / draws.length),
  };
}
