/**
 * THE IN-SEASON DECISION BACKTEST HARNESS -- one place to A/B any decision policy.
 *
 * Every in-season decision (which player to DROP, whom to STREAM, whether to accept a TRADE, how to
 * set a LINEUP) is the same shape: a policy reads a POINT-IN-TIME state and produces the roster it
 * would hold going forward. This harness replays real historical roster-states, applies a BASELINE
 * and a VARIANT policy to each, scores both resulting rosters with a pluggable scorer under COMMON
 * RANDOM NUMBERS (the same future for both, so the difference is a paired statistic), and reports the
 * effect season-as-unit with a bootstrap CI and a positive control.
 *
 * The point of the abstraction: a change to a decision rule becomes a new `RosterPolicy` -- three
 * lines -- not a fresh research build. `policies.ts` holds the rules, `scorers.ts` the metrics, and
 * nothing here knows which decision it is measuring.
 *
 * POINT-IN-TIME IS ENFORCED BY TYPE. A policy is handed a `DecisionState` that carries only week-w
 * projections and roster membership. The future -- actual points and actual availability -- lives in
 * a separate `SeasonFuture` the SCORER reads and the policy never sees, the same firewall
 * `context.ts` draws between `proj` and `actual`.
 *
 * THE UNIT IS THE SEASON. Decisions within a season share its injuries, so the aggregate is a
 * season-level bootstrap, never a raw pool of decisions.
 */
import { optimalLineup, type RosterPlayer } from "../lineup.js";
import { loadWeekContext, loadModel, type ModelName } from "./context.js";
import { getConfig, type DB } from "../../db/db.js";

export interface DecisionMember {
  playerSk: string; name: string; pos: string;
  /** POINT-IN-TIME projection at the decision week. Never an outcome. */
  proj: number;
}

/** What a policy sees. Everything here was knowable before the decision week's kickoff. */
export interface DecisionState {
  season: number; week: number; teamId: string;
  roster: DecisionMember[];
  /** The free-agent pool, point-in-time. Empty for decisions that do not consult it (e.g. a pure
   *  drop choice); a streaming/waiver policy fills it. */
  freeAgents: DecisionMember[];
  template: string[];
  flexOk: Set<string>;
}

/** playerSk -> week -> realized outcome. The scorer's only window onto the future. */
export type SeasonFuture = Map<string, Map<number, { pts: number; bye: boolean; out: boolean }>>;

export interface ScoreCtx {
  season: number; fromWeek: number; toWeek: number; template: string[]; flexOk: Set<string>; future: SeasonFuture;
}

/** A decision, expressed as the roster it leaves you holding. `meta` lets a policy tag the decision
 *  (e.g. the position it protected) so the runner can attribute the effect without the harness
 *  knowing what the decision was about. */
export interface RosterPolicy {
  name: string;
  apply(state: DecisionState): { roster: DecisionMember[]; meta?: Record<string, unknown> };
}

/** A metric over a resulting roster and the future. Realized points, simulated playoff-Δ, etc. */
export interface Scorer {
  name: string;
  score(roster: DecisionMember[], ctx: ScoreCtx): number;
}

export interface DecisionRecord { season: number; week: number; teamId: string; diff: number; meta?: Record<string, unknown> }

export interface PolicyBacktestResult {
  seasons: number[]; model: ModelName; scorer: string; baseline: string; variant: string;
  decisions: DecisionRecord[];      // one per (team, week) where baseline and variant differed
  evaluated: number; differed: number;
  meanDiff: number;                 // over ALL evaluated decisions (agreements = 0)
  meanDiffWhereDiffer: number;
  perSeason: { season: number; differed: number; meanDiff: number }[];
  bootstrap: { lo: number; hi: number; pVariantBetter: number };
  /** Positive control: variant-minus-a-deliberately-bad policy. Must be strongly one-signed, or the
   *  harness is not measuring realized value. Null when no control was supplied. */
  control: { name: string; meanDiff: number } | null;
}

/** Build every (season, week, team) DecisionState, calling `visit` with the state and a per-season
 *  future/scoring context. One loader so no two decision backtests disagree about "as of week w". */
function iterateStates(
  db: DB, leagueId: string, seasons: number[], model: ModelName, maxDecisionWeek: number | undefined,
  visit: (state: DecisionState, ctx: ScoreCtx) => void,
): void {
  const wm = loadModel(model);
  const cfg = getConfig(db);
  const flexOk = new Set<string>(cfg.flex_ok as string[]);

  for (const season of seasons) {
    const future: SeasonFuture = new Map();
    for (const r of db.prepare(
      `SELECT player_sk, week, pts, is_bye, inj_out FROM feat_player_week_model
        WHERE season=? AND player_sk IS NOT NULL`,
    ).all(season) as { player_sk: string; week: number; pts: number | null; is_bye: number | null; inj_out: number | null }[]) {
      let m = future.get(r.player_sk); if (!m) { m = new Map(); future.set(r.player_sk, m); }
      m.set(r.week, { pts: r.pts ?? 0, bye: !!r.is_bye, out: !!r.inj_out });
    }
    const regWeeks = (db.prepare(`SELECT MAX(reg_weeks) rw FROM raw_league_season WHERE season=?`).get(season) as { rw: number | null }).rw
      ?? (db.prepare(`SELECT MAX(week) w FROM feat_player_week_model WHERE season=? AND pts IS NOT NULL`).get(season) as { w: number | null }).w
      ?? 14;
    const maxW = Math.min(maxDecisionWeek ?? regWeeks - 1, regWeeks - 1);

    // Preload every season's FA-pool rows once, indexed by week.
    const faByWeek = new Map<number, { playerSk: string; name: string; pos: string }[]>();
    for (const r of db.prepare(
      `SELECT week, player_sk, name, pos FROM fact_fa_pool_week WHERE season=? AND player_sk IS NOT NULL`,
    ).all(season) as { week: number; player_sk: string; name: string; pos: string }[]) {
      let l = faByWeek.get(r.week); if (!l) { l = []; faByWeek.set(r.week, l); }
      l.push({ playerSk: r.player_sk, name: r.name, pos: r.pos });
    }

    for (let W = 1; W <= maxW; W++) {
      const wc = loadWeekContext(db, leagueId, season, W, wm);
      const scoreCtx: ScoreCtx = { season, fromWeek: W, toWeek: regWeeks, template: wc.template, flexOk, future };
      // The free-agent pool is league-wide for the week; each FA's POINT-IN-TIME projection comes from
      // the same week context the roster players use (loadWeekContext projects every player with a
      // weekly row, not just the rostered). FAs with no projection row are dropped, not zeroed.
      const freeAgents: DecisionMember[] = [];
      for (const fa of faByWeek.get(W) ?? []) {
        const p = wc.players.get(fa.playerSk);
        if (!p || (p.proj == null && p.fallback == null)) continue;
        freeAgents.push({ playerSk: fa.playerSk, name: p.name, pos: p.pos, proj: p.proj ?? p.fallback ?? 0 });
      }
      for (const [teamId, entries] of wc.rosters) {
        const roster: DecisionMember[] = [];
        for (const e of entries) {
          const p = wc.players.get(e.playerSk);
          if (!p) continue;
          roster.push({ playerSk: e.playerSk, name: p.name, pos: p.pos, proj: p.proj ?? p.fallback ?? 0 });
        }
        visit({ season, week: W, teamId, roster, freeAgents, template: wc.template, flexOk }, scoreCtx);
      }
    }
  }
}

/** Realized rest-of-season value of a roster: sum over weeks of the best legal lineup from the
 *  AVAILABLE players, scored on ACTUAL points. The default scorer; `scorers.ts` may add others. */
export function realizedRestOfSeason(roster: DecisionMember[], ctx: ScoreCtx): number {
  let total = 0;
  for (let w = ctx.fromWeek; w <= ctx.toWeek; w++) {
    const players: RosterPlayer[] = roster.map((m) => {
      const r = ctx.future.get(m.playerSk)?.get(w);
      const available = !!r && !r.bye && !r.out;
      return { name: m.name, pos: m.pos, proj: available ? r!.pts : 0, available };
    });
    total += optimalLineup(players, ctx.template, ctx.flexOk).totalProj;
  }
  return total;
}

export function backtestPolicies(
  db: DB,
  opts: {
    leagueId: string; seasons: number[];
    baseline: RosterPolicy; variant: RosterPolicy;
    scorer?: Scorer; control?: RosterPolicy;
    model?: ModelName; maxDecisionWeek?: number;
    /** Skip a state the policies cannot act on (e.g. no legal drop). Return false to drop it. */
    admit?: (state: DecisionState) => boolean;
  },
): PolicyBacktestResult {
  const model = opts.model ?? "served";
  const scorer: Scorer = opts.scorer ?? { name: "realized-rest-of-season", score: realizedRestOfSeason };
  const decisions: DecisionRecord[] = [];
  const perSeasonDiffs = new Map<number, number[]>();
  for (const s of opts.seasons) perSeasonDiffs.set(s, []);
  const controlDiffs: number[] = [];
  let evaluated = 0, differed = 0;

  iterateStates(db, opts.leagueId, opts.seasons, model, opts.maxDecisionWeek, (state, ctx) => {
    if (opts.admit && !opts.admit(state)) return;
    const b = opts.baseline.apply(state);
    const v = opts.variant.apply(state);
    evaluated++;
    const sameRoster = b.roster.length === v.roster.length &&
      new Set(b.roster.map((m) => m.playerSk)).size === new Set([...b.roster, ...v.roster].map((m) => m.playerSk)).size;
    // CRN: both rosters scored against the SAME future in this state.
    const sb = scorer.score(b.roster, ctx);
    if (opts.control) controlDiffs.push(scorer.score(opts.control.apply(state).roster, ctx) - sb);
    if (sameRoster) { perSeasonDiffs.get(state.season)!.push(0); return; }
    differed++;
    const diff = scorer.score(v.roster, ctx) - sb;
    perSeasonDiffs.get(state.season)!.push(diff);
    decisions.push({ season: state.season, week: state.week, teamId: state.teamId, diff, meta: v.meta });
  });

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const perSeason = opts.seasons.map((s) => {
    const d = perSeasonDiffs.get(s) ?? [];
    const nz = d.filter((x) => x !== 0);
    return { season: s, differed: nz.length, meanDiff: mean(nz) };
  });
  const seasonMeans = opts.seasons.map((s) => mean(perSeasonDiffs.get(s) ?? []));
  const boot: number[] = [];
  let rng = 987654321;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    let acc = 0; for (let k = 0; k < seasonMeans.length; k++) acc += seasonMeans[Math.floor(rand() * seasonMeans.length)];
    boot.push(acc / Math.max(1, seasonMeans.length));
  }
  boot.sort((a, b) => a - b);
  const allDiffs = opts.seasons.flatMap((s) => perSeasonDiffs.get(s) ?? []);

  return {
    seasons: opts.seasons, model, scorer: scorer.name, baseline: opts.baseline.name, variant: opts.variant.name,
    decisions, evaluated, differed,
    meanDiff: mean(allDiffs),
    meanDiffWhereDiffer: mean(decisions.map((d) => d.diff)),
    perSeason,
    bootstrap: { lo: boot[Math.floor(0.05 * boot.length)], hi: boot[Math.floor(0.95 * boot.length)], pVariantBetter: boot.filter((x) => x > 0).length / boot.length },
    control: opts.control ? { name: opts.control.name, meanDiff: mean(controlDiffs) } : null,
  };
}
