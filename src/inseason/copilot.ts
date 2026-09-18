/**
 * THE IN-SEASON DECISION SURFACE -- one module, one sim context, one unit of measure.
 *
 * WHY THIS EXISTS. Fifteen scripts under `scripts/` answered the in-season questions -- season odds,
 * lineups, waivers, trades, handcuffs, depth risk, power rankings, playoff SOS -- and each one was a
 * program, not a function: it opened its own store, printed its own table, and exited. Nothing could
 * CALL them. So the desktop Assistant, whose entire purpose is to run the team on the user's behalf,
 * had no way to reach a single one of those answers, and the MCP surface it does reach was still
 * entirely a DRAFT surface (read_board, draft_player, set_lever) months after the draft ended.
 *
 * This file is those answers as pure functions over a `SimContext`. The CLI (`ff copilot <verb>`) and
 * the MCP tools (`season_odds`, `lineup_recommend`, ...) are two thin callers of the same functions,
 * so the number the Assistant quotes and the number a terminal prints cannot differ.
 *
 * ONE UNIT OF MEASURE. Every recommendation that can be is scored as a CHANGE IN OUR CHAMPIONSHIP
 * PROBABILITY, not in points. Points cannot see a mandatory slot going empty, cannot see that our
 * league pays on a 7-of-16 threshold and then top-heavy, and cannot see that a sixth receiver on a
 * roster with five effective receiving slots is worth approximately nothing. Where a title delta is
 * NOT the honest unit -- a weekly lineup, a playoff schedule -- the function says so in
 * `assumptions.basis` rather than dressing a lineup quantity up as a probability.
 *
 * EVERY RESULT CARRIES ITS ASSUMPTIONS. `assumptions` travels in the returned JSON: whether the
 * schedule was the REAL one or a generated stand-in, how many trials and which seeds, what data
 * produced it, and when. This is not decoration. An LLM handed a bare "33.2%" will quote it as a
 * fact; handed `{champion: 0.332, assumptions: {schedule: "generated", trials: 800}}` it has no way
 * to quote the number without the caveat attached to it. The tool descriptions in
 * `src/agent/agent.ts` say the same thing again in prose, because a field is only a caveat if the
 * reader knows to look.
 *
 * WHAT IS DELIBERATELY NOT HERE. No ESPN writes. Nothing in this module sets a lineup, submits a
 * claim or sends an offer; every function returns a RECOMMENDATION and the human acts. That is not
 * timidity about the plumbing -- it is D3's log-before-act invariant reaching the point where there
 * is something to log. The action-log write happens in the callers (`ff copilot`, the MCP tools), so
 * the black-box recorder sees every piece of advice given even though no roster move follows it.
 */
import { optimalLineup } from "./lineup.js";
import { slotAdmits } from "../draft/slots.js";
// Track H. The one-week HEAD-TO-HEAD objective. Imported rather than inlined because the sampler,
// the copula call and the swap search are a module's worth of decisions with their own tests; this
// file's job is to hand it the roster, the opponent and the week and to report what it said.
import { winProbLineup, opponentStarters, type WeeklyBand, type WinProbOpts, type WinProbResult, type WinProbPlayer } from "./winprob.js";
import { handcuffBoard, loadInjuryOutlook, type DepthEntry, type HandcuffRow, type InjuryOutlookSet } from "./handcuff.js";
import { rosterGaps, rosterOverfills, type SeasonTeamInput, type SeasonOdds, type VarianceModel } from "../draft/season.js";
import { dstAliasKey, nameKey } from "../draft/values.js";
import { perGameStrength } from "../draft/rosBlend.js";
import {
  loadFaabModel, liveFaabState, featureRow, recommendBid, faabArtifactFor,
  type FaabModel, type FaabLiveState, type FaabRow,
} from "./faab.js";
import type { AcquisitionRules } from "../league/types.js";
import type { SimContext } from "../draft/simContext.js";
import { round3 as r3 } from "../round3.js";

/**
 * NFL weeks a season projection is spread over. Season projections in the board are FULL-SEASON
 * totals; every weekly quantity below divides by this, and says so in `assumptions.basis`.
 *
 * THERE ARE TWO DIFFERENT "WEEKS" IN THIS REPO AND THEY ARE NOT INTERCHANGEABLE (I-7).
 *
 *   NFL_WEEKS = 17   the frame a SEASON PROJECTION is in. A board line is a 17-game total, so
 *                    `proj / 17` is points per SCHEDULED NFL week. simContext.ts:254/273 uses the
 *                    same frame, deliberately, and says why.
 *   regWeeks         the length of THIS LEAGUE's regular season (ESPN 462233: 13; Yahoo 129048: 14).
 *                    The right divisor only for a quantity that is "per week of the league's season".
 *
 * `leagueSeasonWeeks` below is the second one, from the league's own format block. Use it whenever
 * the question is about the league's calendar and NOT about spreading a season projection.
 *
 * THE DISAGREEMENT IS RESOLVED (D25, 2026-09-16), AND THERE IS NOW ONE FRAME. `simContext.ts` built
 * the streaming `replacement` level as `seasonPts / regWeeks` while every consumer of it compared
 * against `proj / 17` quantities, so the streaming floor was high by 17/regWeeks (1.3077x for ESPN
 * 462233). It divides by 17 now, at the producer, so `ctx.replacement` and every per-week projection
 * beside it are in the SAME frame. `scripts/season-calibration.mjs` carried its own copy of the same
 * rule and was corrected with it (`--replacement-frame reg` reproduces the old arm). Anything asking
 * "per week of the LEAGUE's season" -- the handcuff/depth horizon, the playoff calendar -- still uses
 * `leagueSeasonWeeks`, which is the other frame and is not interchangeable with this one.
 */
export const NFL_WEEKS = 17;

/**
 * HOW MANY WEEKS THIS LEAGUE'S SEASON ACTUALLY RUNS -- through its last playoff week, from the format
 * block that has a provenance. ESPN 462233 ends week 16; Yahoo 129048 ends week 17. Falls back to
 * `NFL_WEEKS` only when the context carries no format at all (a hand-built fixture).
 */
export function leagueSeasonWeeks(ctx: SimContext): number {
  const po = ctx.format?.playoffWeeks ?? [];
  if (po.length) return Math.max(...po);
  const rw = ctx.format?.regWeeks;
  return rw && rw > 0 ? rw : NFL_WEEKS;
}

// ---------------------------------------------------------------------------------------------
// ASSUMPTIONS -- the thing that travels with every number.
// ---------------------------------------------------------------------------------------------

/** What data produced an answer. Filled by `loadProvenance` (copilotStore.ts) where a store is
 *  available; the pure default below carries only what the context itself knows. */
export interface Provenance {
  /**
   * WHICH LEAGUE, WHICH PLATFORM, WHICH SCORING (I-7). Every number this file produces is about one
   * league, and until this pass none of them said which: with two leagues in one store a playoff
   * probability, a FAAB dollar figure and a lineup were all quotable with no way to tell whose they
   * were. `scoringKey` is the content hash of the rules the board under the number was built from --
   * the same key `data/formats/<key>/` is named by -- so "this is the Yahoo number" is checkable
   * rather than asserted.
   *
   * `null` only where the caller built a context by hand and named no league (the pure fixtures in
   * test/ do this); every path through `copilotActions.runCopilot` fills all three.
   */
  leagueId: string | null;
  platform: string | null;
  scoringKey: string | null;
  season: number;
  /** Rows on the value board the rosters were resolved against. */
  boardRows: number;
  /** Seasons the variance model was fitted on, when the file could be read. */
  varianceSeasons: number | null;
  /** Which sampler the season simulator is using. */
  sampler: string;
  /** `fittedAt` of data/projection-artifact.json when present. */
  projectionArtifact: string | null;
}

// ---------------------------------------------------------------------------------------------
// THE OBJECTIVE -- which quantity a recommendation is actually maximising, stated on every result.
// ---------------------------------------------------------------------------------------------

/**
 * WHY THE UNIT OF MEASURE CHANGED, and it is the central finding of the whole redesign.
 *
 * P(title) = P(playoffs) x P(title | playoffs). Phase 2c scored this simulator against 114 real
 * team-seasons of this league and found it has measurable skill on the FIRST factor -- playoff Brier
 * 0.2369 against a uniform 0.2451 -- and NONE on the second: title Brier 0.0658 against a uniform
 * 0.0652, which is WORSE than knowing nothing.
 *
 * Those are the figures from the PER-SEASON-FORMAT re-run (integration pass 3): each season scored
 * against its own field size, seeding rule and bracket rule instead of one format for all eight. It
 * moves the playoff Brier by a thousandth from the constant-field run and the skill score not at
 * all, which is the useful result -- the finding survives the correction rather than depending on it.
 * Single elimination among seven makes P(title |
 * playoffs) very nearly a coin flip, and eight titles in 114 team-seasons is almost no signal to fit
 * against anyway.
 *
 * Every recommendation in this module used to be scored as a change in CHAMPIONSHIP probability. That
 * is the quantity the model cannot predict, and optimising a quantity a model cannot predict is
 * optimising its noise. So:
 *
 *   PRIMARY      the change in P(PLAYOFFS). Ranking, the noise floor and the verdict all use it.
 *   SECONDARY    expected optimal-lineup points in the three fantasy playoff weeks. It is the
 *                tie-break, and it becomes the primary once a seed is secure -- see the regime
 *                switch below.
 *   ALONGSIDE    the change in P(title), computed and reported on every row and never used alone.
 *
 * Nothing here hides the title number. It is the number the owner will ask about, and refusing to
 * show it would be its own kind of dishonesty; what changes is that it no longer decides.
 */
export type Regime = "insecure" | "secure";

/**
 * WHERE A SEED COUNTS AS SECURE, derived from the calibration rather than chosen.
 *
 * `scripts/season-calibration.mjs` bins the simulator's predicted playoff probability against what
 * actually happened over 114 team-seasons:
 *
 *   predicted   n    mean predicted   realised
 *   5-15%       2          8.3%          0.0%
 *   15-30%     13         24.1%         23.1%
 *   30-50%     71         41.3%         47.9%
 *   50-70%     27         58.0%         40.7%
 *   70-100%     1         74.4%        100.0%
 *
 * The first bin whose REALISED playoff rate exceeds 85% is 70-100%, so the threshold is 70% of
 * predicted playoff probability. Two things about that number have to be said out loud, because a
 * threshold quoted without them would be quoting a sample of one:
 *
 *   - the 70-100% bin contains ONE team-season. It went to the playoffs. That is the whole evidence.
 *   - the 50-70% bin is the largest miscalibration on the page -- 58% predicted, 41% realised -- so
 *     the simulator is OVER-confident just below the threshold, which argues for putting the switch
 *     ABOVE the miscalibrated band rather than inside it. 70% is where that band ends.
 *
 * So it is derived, it is defensible, and it rests on very little. It is exposed on every result
 * (`seasonOdds().regime`) so a reader can disagree with it explicitly instead of by accident.
 */
export const PLAYOFF_SECURE_THRESHOLD_PCT = 70;

export interface Objective {
  regime: Regime;
  /** What the recommendation is RANKED on. */
  primary: "playoffs" | "playoff-week strength";
  secondary: "playoff-week strength" | "playoffs";
  alongside: "title";
  thresholdPct: number;
  ourPlayoffPct: number | null;
  note: string;
}

export function objectiveFor(playoffPct: number | null, thresholdPct = PLAYOFF_SECURE_THRESHOLD_PCT): Objective {
  const secure = playoffPct != null && playoffPct >= thresholdPct;
  return {
    regime: secure ? "secure" : "insecure",
    primary: secure ? "playoff-week strength" : "playoffs",
    secondary: secure ? "playoffs" : "playoff-week strength",
    alongside: "title",
    thresholdPct,
    ourPlayoffPct: playoffPct == null ? null : r2(playoffPct),
    note: secure
      ? `our simulated playoff probability is ${playoffPct!.toFixed(1)}%, at or above the ${thresholdPct}% ` +
        "threshold, so the seed is treated as secure and moves are ranked on expected optimal-lineup " +
        "points in the league PLAYOFF WEEKS (weeks 14-16 under the current format block) -- the only thing left that a bracket can see. The change in P(playoffs) " +
        "is reported beside it and P(title) alongside both."
      : `our simulated playoff probability is ${playoffPct == null ? "not computed" : `${playoffPct.toFixed(1)}%`}, ` +
        `below the ${thresholdPct}% threshold, so moves are ranked on the change in ` +
        "P(PLAYOFFS) -- the factor this simulator has measured skill on (Brier 0.2369 against a uniform " +
        "0.2451, per-season format, 2018-2025). Playoff-week strength is the tie-break and P(title) is reported alongside; the " +
        "simulator has NO measured skill on the title (0.0658 against a uniform 0.0652).",
  };
}

export interface Assumptions {
  /** REAL means the league's actual matchups; GENERATED means a deterministic stand-in built
   *  offline, whose playoff seeding is therefore not this league's. */
  schedule: "real" | "generated";
  /** "simulation" -- a Monte Carlo title/playoff probability. "projection" -- a points quantity from
   *  the board with no simulation behind it. "weekly-model" -- a points quantity from the WEEKLY
   *  projector (`src/weekly/projector.ts`) rather than from the season line spread flat. "market" --
   *  solved from posted betting lines. */
  basis: "simulation" | "projection" | "weekly-model" | "market";
  trials: number | null;
  seeds: number[] | null;
  artifact: Provenance;
  asOf: string;
  /** One sentence naming exactly what produced the number, where the basis alone is not enough --
   *  in particular WHICH players fell back to the season line because the weekly projector had no
   *  row for them. A caveat that omits the fallback is a caveat that hides it. */
  basisNote?: string;
  /** WHICH QUANTITY THIS RESULT IS MAXIMISING. On every result, because a delta with no objective
   *  attached is the same trap as a probability with no assumptions attached: it reads as a fact. */
  objective: Objective;
  /** THE LEAGUE'S ACTUAL PLAYOFF WEEKS, carried so a caller can LABEL a playoff-week quantity
   *  instead of hardcoding one. Three summaries in `copilotActions.ts` printed the literal
   *  "wk15-17" while `format.playoffWeeks` read [14,15,16] for this league -- the arithmetic was
   *  right and the label was wrong, which is the worse failure of the two because it is invisible
   *  to every test that checks the number. A label derived from the same field the maths uses
   *  cannot drift from it. */
  playoffWeeks: number[];
  /** THE SEASON SO FAR (D18): how many settled weeks seeded the standings (0 = a from-scratch
   *  season, the pre-D18 behaviour), the week the simulation starts at, and the rest-of-season
   *  blend weight applied to played games ("Infinity" = preseason lines only). */
  played?: { weeks: number; nextWeek: number; rosBlendK: number | "Infinity"; rosApplied: number; seedBlocked?: string | null };
}

export function defaultProvenance(ctx: SimContext): Provenance {
  // A pure context carries no league (SimContext is built from a config, not from a league row), so
  // these are NULL rather than guessed -- a wrong league id on a number is worse than no league id.
  return { leagueId: null, platform: null, scoringKey: null, season: ctx.season, boardRows: ctx.board.size, varianceSeasons: null, sampler: "bootstrap", projectionArtifact: null };
}

interface BaseOpts {
  trials?: number; seed?: number; seeds?: number[]; provenance?: Provenance;
  /** Override the playoff probability at which the objective switches to playoff-week strength.
   *  Exists so the switch itself can be FAULT-INJECTED: raise it above 100 and the secure regime
   *  becomes unreachable, and a ranking that does not change was never reading the regime. */
  secureThresholdPct?: number;
}

function assumptionsOf(
  ctx: SimContext, basis: Assumptions["basis"], o: BaseOpts,
  trials: number | null, seeds: number[] | null, objective: Objective,
): Assumptions {
  return {
    schedule: ctx.syntheticSchedule ? "generated" : "real",
    basis,
    trials,
    seeds,
    artifact: o.provenance ?? defaultProvenance(ctx),
    asOf: new Date().toISOString(),
    objective,
    playoffWeeks: [...(ctx.format?.playoffWeeks ?? [])],
    ...(ctx.played ? { played: { weeks: ctx.played.weeks, nextWeek: ctx.played.nextWeek, rosBlendK: ctx.played.rosBlendK === Infinity ? "Infinity" as const : ctx.played.rosBlendK, rosApplied: ctx.played.rosApplied, seedBlocked: ctx.played.seedBlocked ?? null } } : {}),
  };
}

/** Our three numbers for one hypothetical league state, under one seed, in one simulation. They are
 *  read from the SAME run so a playoff delta and a playoff-week delta can never come from two
 *  different samples -- the correlation trap this repo has already paid for once. */
interface Outcome { playoffPct: number; titlePct: number; poPts: number }
const outcomeOf = (ctx: SimContext, teams: SeasonTeamInput[], trials: number, seed: number, idx = ctx.meIdx): Outcome => {
  const r = ctx.run(teams, trials, seed, { playoffWeekStrength: true })[idx];
  return { playoffPct: 100 * r.playoffs, titlePct: 100 * r.champion, poPts: r.playoffWeekPts };
};

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const sd = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The noise floor of a run, stated BEFORE anything is ranked.
 *
 * A championship probability estimated from `trials` seasons carries binomial error, and at the
 * trial counts these tools can afford in an interactive session that error is comparable to the
 * effects being measured. `scripts/trade-odds.mjs` once reported eight "structural" findings that
 * were every one of them inside this width -- all of them inverted or vanished at five times the
 * trials. Ranking two options whose gap is under the floor is reading noise as a preference, so the
 * floor is returned with the ranking rather than left to the reader to compute.
 *
 * The 1.4 factor is the usual allowance for a DIFFERENCE of two correlated estimates under common
 * random numbers. It is a rule of thumb, stated here rather than buried.
 */
export function noiseFloorPp(baseTitlePct: number, trials: number): number {
  const p = Math.min(1, Math.max(0, baseTitlePct / 100));
  return r2(100 * Math.sqrt((p * (1 - p)) / Math.max(1, trials)) * 1.4);
}

// ---------------------------------------------------------------------------------------------
// SEASON ODDS
// ---------------------------------------------------------------------------------------------

export interface OddsRow extends SeasonOdds { us: boolean }
export interface Invariant { name: string; got: number; want: number; tol: number; ok: boolean }

/**
 * CONSERVATION LAWS any correct season must satisfy.
 *
 * A simulator that is quietly wrong still returns a plausible-looking table, and a plausible table
 * is exactly what nobody checks. These are the three quantities that cannot be fudged: one win per
 * game played, exactly `playoffTeams` playoff berths per season, exactly one champion. They are
 * returned WITH the odds so a consumer can see them, and `seasonOdds` refuses to return a table that
 * fails one -- a silently-wrong number is worse than an error.
 */
export function oddsInvariants(odds: SeasonOdds[], playoffTeams: number, games: number): Invariant[] {
  const sum = (f: (r: SeasonOdds) => number) => odds.reduce((a, r) => a + f(r), 0);
  const mk = (name: string, got: number, want: number, tol: number): Invariant =>
    ({ name, got: r3(got), want: r3(want), tol, ok: Math.abs(got - want) <= tol });
  return [
    mk("total mean wins = one per game played", sum((r) => r.meanWins), games, 0.5),
    mk("playoff shares sum to the playoff field", sum((r) => r.playoffs), playoffTeams, 0.05),
    mk("exactly one champion per season", sum((r) => r.champion), 1, 0.02),
  ];
}

export interface SeasonOddsResult {
  teams: OddsRow[];
  us: OddsRow;
  playoffTeams: number;
  regWeeks: number;
  randomTitlePct: number;
  invariants: Invariant[];
  /** Which objective the in-season tools are currently ranking on, and the threshold that decided
   *  it. Exposed HERE because this is the verb that computes the number the switch reads. */
  objective: Objective;
  assumptions: Assumptions;
}

/** Playoff and championship odds for every team from the rosters that actually exist, ours flagged. */
export function seasonOdds(ctx: SimContext, o: BaseOpts = {}): SeasonOddsResult {
  const trials = o.trials ?? 4000;
  const seed = o.seed ?? 7;
  const opts = ctx.opts(trials, seed);
  const raw = ctx.run(ctx.teams, trials, seed, { playoffWeekStrength: true });
  const rows: OddsRow[] = raw.map((r, i) => ({ ...r, us: i === ctx.meIdx }));
  const games = ctx.weeks.reduce((a, w) => a + w.length, 0);
  const invariants = oddsInvariants(raw, opts.playoffTeams, games);
  const bad = invariants.filter((c) => !c.ok);
  if (bad.length) {
    throw new Error(
      `season odds failed ${bad.length} conservation law(s) -- the table is not trustworthy:\n  ` +
      bad.map((c) => `${c.name}: got ${c.got}, want ${c.want} +/- ${c.tol}`).join("\n  "),
    );
  }
  // SORTED BY THE PRIMARY OBJECTIVE, not by the title. A table ordered by championship probability
  // is a table ordered by the quantity this simulator has been measured to know nothing about.
  const sorted = [...rows].sort((a, b) => b.playoffs - a.playoffs || b.champion - a.champion);
  const objective = objectiveFor(100 * rows[ctx.meIdx].playoffs, o.secureThresholdPct);
  return {
    teams: sorted,
    us: rows[ctx.meIdx],
    playoffTeams: opts.playoffTeams,
    regWeeks: ctx.weeks.length,
    randomTitlePct: r2(100 / ctx.teams.length),
    invariants,
    objective,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, [seed], objective),
  };
}

// ---------------------------------------------------------------------------------------------
// WEEKLY LINEUP
// ---------------------------------------------------------------------------------------------

// THE AVAILABILITY VOCABULARY lives in its own leaf module (src/inseason/availability.ts) so that
// `weekState.ts` can use it without a cycle back through this file. Re-exported here because every
// existing caller imports these names from `copilot.js`, and a move that forces 20 import edits is a
// move that gets reverted.
import {
  canonStatus, isKnownStatus, normalizeStatus, unknownStatusesSeen,
  type AvailabilityStatus, type AvailabilityEntry, type AvailabilityMap,
} from "./availability.js";
import { finishedTeams } from "./weekState.js";
export {
  canonStatus, isKnownStatus, normalizeStatus, unknownStatusesSeen,
  type AvailabilityStatus, type AvailabilityEntry, type AvailabilityMap,
};

export interface LineupPlayer { slot?: string; name: string; pos: string; proj: number; available: boolean; reason: string }

/** WHICH QUESTION THE LINEUP ANSWERS. `expected` maximises the sum of projected points over a legal
 *  assignment -- what has always shipped. `winprob` maximises the probability of beating THIS week's
 *  actual opponent (src/inseason/winprob.ts). They are the same lineup in a close game and different
 *  ones at the margins, which is the whole content of the second option. */
export type LineupObjective = "expected" | "winprob";

/**
 * ONE CONTESTED SLOT (M3 finding 3-a; WP19): the seated man, the best legal alternative who is
 * sitting, the MARGIN between them, and both men's band.
 *
 * WHY THE RESULT CARRIES THIS AT ALL. The stress test measured that drawing every man once from the
 * model's own p10-p90 flips the starting SET 95% of the time on the live roster, because the bands
 * are enormous relative to the gaps between candidates: the two FLEX slots were decided by 0.70
 * points between two men whose own p10-p90 spans are 22.0 and 22.9 points wide. The expected-points
 * ORDERING is stable to any plausible error in the projection; the realised ordering is a coin toss.
 * A reader handed "91.4 projected pts" and a list of names cannot see that, and the summary carried
 * neither the band nor the margin. No number moves because of this -- it is what the recommendation
 * already was, said out loud.
 *
 * WHAT THE MARGIN IS, EXACTLY, so it is not read as more than it is: the seated man's projection
 * minus the best AVAILABLE non-starting man eligible for that slot. It is the head-to-head gap a
 * reader means by "the FLEX was decided by 0.7 points", NOT the total-points cost of the swap (which
 * can cascade through the assignment and is never smaller). `marginBandFrac` divides it by the WIDER
 * of the two men's p10-p90 spans, so a value near zero reads as the coin flip it is.
 */
export interface LineupContest {
  slot: string;
  starter: { name: string; pos: string; proj: number; p10: number | null; p90: number | null };
  alternative: { name: string; pos: string; proj: number; p10: number | null; p90: number | null };
  margin: number;
  /** null when neither man has a served band -- never a fabricated width. */
  marginBandFrac: number | null;
}

export interface LineupResultJson {
  week: number;
  starters: { slot: string; name: string; pos: string; proj: number }[];
  /** Per starting slot that had a real alternative, the margin and both men's band. Empty when no
   *  slot was contested (every alternative ineligible or unavailable). */
  contested: LineupContest[];
  bench: LineupPlayer[];
  unavailable: { name: string; pos: string; reason: string }[];
  totalProj: number;
  /**
   * HOW MUCH OF `totalProj` IS ALREADY BANKED rather than forecast.
   *
   * Present only once at least one starter's game is over. `banked` is the sum of their REAL scores;
   * `projected` is the rest. The two are separated because they are different kinds of number and a
   * single headline hides that: on the Friday of week 2 this league's lineup read "89.9 projected
   * pts" when 35.0 of it had been scored the night before and could not change.
   */
  settled?: { banked: number; projected: number; players: { name: string; pts: number }[] };
  flags: string[];
  assumptions: Assumptions;
  /** Which objective produced `starters`. Always present, so a consumer never has to infer it from
   *  whether `winprob` happens to be set. */
  objective: LineupObjective;
  /** Present only under `objective: "winprob"`: BOTH lineups, the P(win) of each, the swaps taken
   *  and why, and the expected points given up to buy them. */
  winprob?: WinProbResult & { opponent: string; opponentTeamId: string };
}

/**
 * WHY A STARTER MAY NOT BE STARTED, resolved once so the guard and the optimizer read the same rule.
 * Returns null when he is startable.
 */
/**
 * A WEEKLY PROJECTION FOR ONE MAN, WITH THE DST ALIAS TRIED SECOND.
 *
 * `lineupNameKey` deliberately does NOT strip or translate a `D/ST` token -- its own header says so,
 * and unifying it with the canonical `nameKey` would silently break every weekly lineup match. The
 * consequence is that the two sides have to SPELL a defence the same way: "MIN D/ST" on both, which
 * is what `ownership` happens to write today. A roster source that writes ESPN's NICKNAME form --
 * `raw_league_roster_week` writes "Vikings D/ST" -- would match nothing and fall silently to the
 * season line, with `basisNote` reporting it as a fallback rather than as a defence nobody could
 * find.
 *
 * So the direct key is tried first, unchanged, and only on a MISS for a DST is the alias tried. That
 * ordering matters: it cannot change any lookup that already succeeds, which is the property that
 * makes this safe to add to a seam the header warns about.
 */
function weeklyFor(
  weekly: WeeklyProjection | undefined,
  p: { name: string; pos: string },
): number | undefined {
  if (!weekly) return undefined;
  const direct = weekly.get(lineupNameKey(p.name));
  if (direct != null || p.pos !== "DST") return direct;
  const alias = dstAliasKey(p.name);
  return alias == null ? undefined : weekly.get(lineupNameKey(`${alias.toUpperCase()} D/ST`));
}

export function unavailableReason(
  p: { name: string; pos: string; bye?: number | null; slot?: string | null },
  week: number,
  availability: AvailabilityMap,
): string | null {
  if (p.bye != null && Number(p.bye) === week) return `bye week ${week}`;
  /**
   * A MAN THE LEAGUE HAS ON IR CANNOT BE STARTED, whatever the injury feeds say about him.
   *
   * `ownership.slot` carried `IR` and NOTHING read it -- the architecture review flagged it and it
   * stayed open. It matters because it is a different fact from a designation: the league itself has
   * already ruled him ineligible, so he is unstartable even when the status feeds are stale, absent,
   * or spell his condition in a way the vocabulary does not know. On the Yahoo league it is four men
   * today, covered by the injury path only BY LUCK.
   *
   * `IR_SLOTS` rather than a literal: Yahoo writes `IR`, ESPN's lineupSlotId 21 renders as `IR`, and
   * a platform that spells it differently must be added here rather than silently starting him.
   */
  const slot = (p.slot ?? "").trim().toUpperCase();
  if (slot && IR_SLOTS.has(slot)) return `on IR (league slot "${p.slot}") -- not eligible to start`;
  const a = availability.get(nameKey(p.name));
  if (a && a.status === "OUT") return `${a.detail ? `OUT (${a.detail})` : "OUT"} -- ${a.source}`;
  return null;
}

/** League ROSTER slots that mean "cannot be started". Not injury statuses -- those are
 *  `OUT_STATUSES` in availability.ts -- but the league's own eligibility ruling. */
const IR_SLOTS = new Set(["IR", "INJURED RESERVE", "IL", "NA", "INACTIVE"]);

/**
 * THE GUARD THAT MAKES AVAILABILITY LOAD-BEARING.
 *
 * `optimalLineup` only ever picks from players it was TOLD are available, so on paper this can never
 * fire. That is exactly the point: the failure mode here is not the optimizer choosing badly, it is
 * the availability computation never reaching it -- a bye column that arrived null, a status map keyed
 * on a name spelling that matches nothing, a caller that forgot the argument. Every one of those
 * produces a lineup that looks completely normal and starts a man who is not playing.
 *
 * So the check is made against the SOURCE (the roster's bye + the store's status) rather than against
 * the flags the optimizer was handed, which is the only version a disconnected pipeline cannot
 * satisfy. Fault-injected in the tests by handing it a result that starts a bye player.
 */
export function assertStartersAvailable(
  starters: { name: string }[],
  roster: { name: string; pos: string; bye?: number | null }[],
  week: number,
  availability: AvailabilityMap,
): void {
  const bad: string[] = [];
  for (const s of starters) {
    if (s.name === "(empty)") continue;
    // EVERY roster man of that name, not the FIRST one (M3, 2026-09-17). `roster.find` picked
    // whichever copy came first in roster order, and two men can share a name -- ESPN has carried
    // two Mike Williamses, two Michael Carters, a Josh Allen at QB and one at LB. That made the
    // guard decide by ROSTER ORDER, in both directions, and both are wrong:
    //   * the unavailable copy first -> it THROWS on a lineup that started the available one, and
    //     the whole verb fails (`ff copilot lineup` and the MCP tool both error out). Measured.
    //   * the available copy first -> a genuinely-benched bye/OUT man passes unseen, which is the
    //     single failure this guard exists to catch.
    // Starting "that name" is a plumbing failure only when EVERY man who could be him is out. For a
    // roster with no duplicate names `cands` has one element and this is byte-identical to `find`.
    const cands = roster.filter((x) => x.name === s.name);
    if (!cands.length) continue;
    const whys = cands.map((p) => unavailableReason(p, week, availability));
    if (whys.every((w) => w != null)) bad.push(`${s.name} -- ${whys[0]}`);
  }
  if (bad.length) {
    throw new Error(
      `lineup starts ${bad.length} player(s) who cannot play in week ${week}:\n  ${bad.join("\n  ")}\n` +
      `That is an availability plumbing failure, not a lineup choice -- the optimizer can only start ` +
      `who it was told is available, so the bye/injury signal did not reach it.`,
    );
  }
}

/** The week's projections, keyed the way `lineupRecommend` can look a roster player up: normalized
 *  name. Built by the caller (which may read the store) and handed in, so this file stays pure. */
export type WeeklyProjection = Map<string, number>;

/** Loose name key -- lower case, no punctuation, no suffix. The board and the weekly feature table
 *  spell "Chris Godwin Jr." and "Chris Godwin Jr" differently often enough that an exact match
 *  would quietly send half a roster down the fallback path and report it as a weekly projection.
 *
 *  DELIBERATELY NOT the canonical nameKey in src/draft/values.ts, and MUST NOT be unified with it.
 *  This key has a different normal form on purpose: it keeps digits and word-separating SPACES
 *  ([^a-z0-9]+ -> " "), drops suffix tokens to "" rather than " ", and does NOT strip a "d/st" token
 *  -- whereas canonical collapses to letters only with no spaces or digits ([^a-z] -> "") and strips
 *  "d/st". e.g. "Amon-Ra St. Brown Jr." -> "amon ra st brown" here vs "amonrastbrown" canonical;
 *  "Broncos D/ST" -> "broncos d st" here vs "broncos" canonical. The weekly projection Map is keyed
 *  by THIS form on both sides of its join, so swapping in canonical would silently break weekly
 *  lineup matching. Left as its own definition intentionally -- an owner decision, not an oversight. */
export const lineupNameKey = (s: string): string =>
  s.toLowerCase().replace(/[.'`]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The best legal starting lineup for one week, with everyone who cannot play named and why.
 *
 * WHERE THE WEEKLY POINTS COME FROM. Preferably from the WEEKLY PROJECTOR: the caller loads the
 * shipped weekly artifact and this week's `feat_player_week_model` rows, runs `projectWeekly`
 * (`src/weekly/projector.ts`) and hands the result in as `o.weekly`. A roster player the projector
 * has no row for -- a fixture with no week context, a just-added man the feature build has not seen
 * -- falls back EXPLICITLY to the season projection divided by 17, and `assumptions.basisNote`
 * names how many did and who. Silence there would be the whole bug: a lineup half from a weekly
 * model and half from a flat season line, reported as though it were one thing.
 *
 * The shipped artifact today is the SEASON-LINE-ONLY one (every coefficient zero, mean intercept
 * 1.0), so its projection IS the season line per game -- which is why swapping this seam in changes
 * no number yet. That is the point: the seam is proved live by a fixture artifact with a non-zero
 * coefficient moving the recommendation, not by the shipped one moving it. It still has no matchup,
 * no recent form and no weather in it until a trained artifact passes its gate.
 */
export function lineupRecommend(
  ctx: SimContext,
  week: number,
  o: BaseOpts & {
    availability?: AvailabilityMap;
    weeklyPoints?: number;
    /** Weekly projections by normalized name, from `projectWeekly`. */
    weekly?: WeeklyProjection;
    /**
     * WHICH QUESTION TO ANSWER. Defaults to `expected`, so nothing ships changed: every existing
     * caller gets bit-for-bit the lineup it got before, and `winprob` is reached only by asking for
     * it. That default is a decision, not an oversight -- the replay in docs/validation.md is what
     * would change it, and until the owner reads that it stays where it is.
     */
    objective?: LineupObjective;
    /** The SHAPE of each weekly projection -- p10/p50/p90 and P(zero week) -- by normalized name,
     *  from the same `projectWeekly` call that produced `weekly`. Required by `winprob`: without a
     *  band there is no distribution to take a probability under, only a mean. */
    bands?: Map<string, WeeklyBand>;
    /** Sampler and search knobs, including `noSearch` -- the fault-injection handle. */
    winprob?: WinProbOpts;
    /** NFL team (UPPER abbrev) -> its opponent this week. When present, the lineup is checked for a
     *  DST that shares an NFL game with one of our offensive starters (they partly cancel). Absent,
     *  no such flag is produced -- the default is unchanged. */
    nflOpp?: Map<string, string>;
    /**
     * THE NFL TEAMS WHOSE GAME HAS ALREADY KICKED OFF (UPPER abbrev), from
     * `lockedNflTeams(db, season, week)`. A rostered man on one of them cannot be moved, so he holds
     * his current slot and the optimizer may neither seat nor unseat him.
     *
     * Absent means "nothing is locked", which is both the correct answer before the week's first
     * kickoff and the behaviour every existing caller had. It is deliberately NOT defaulted to a
     * live clock read inside this function: this file is pure, and a recommendation that silently
     * depended on wall-clock time would be unreproducible in a backtest.
     */
    locked?: Set<string>;
    /**
     * WHAT A MAN WHOSE GAME IS OVER ACTUALLY SCORED, by `player_id`, from
     * `settledPointsFor(db, league, season, week)`.
     *
     * Applied ONLY to a man whose NFL team is in `finished` -- kicked off is not the same as
     * finished, and a running score substituted for a projection would price a receiver with one
     * first-quarter catch at 1.4 points for the week. Where it applies, he stops being a
     * distribution and becomes a constant: his band collapses to a point at the value he scored,
     * which is what he is.
     */
    settledPoints?: Map<string, number>;
    /** NFL teams whose game is OVER (union of `finishedNflTeams`). Gates `settledPoints`. */
    finished?: Set<string>;
  } = {},
): LineupResultJson {
  // THE CONTEXT IS THE DEFAULT. `o.availability` survives ONLY as a fault-injection override for the
  // tests -- `availability?: X` on an options bag is exactly what let eight of ten verbs run without
  // it, so it must never again be the only way the value arrives. See src/inseason/weekState.ts.
  const availability = o.availability ?? ctx.week.availability;
  const perWeek = o.weeklyPoints ?? NFL_WEEKS;
  // Same rule as `availability` above: the context is the default, the option is for injection.
  const lockedTeams = o.locked ?? ctx.week.locked;
  const finishedSet = o.finished ?? finishedTeams(ctx.week);
  const settledPts = o.settledPoints ?? ctx.week.settledPoints;
  const roster = ctx.teams[ctx.meIdx].roster;
  const unavailable: LineupResultJson["unavailable"] = [];
  const fellBack: string[] = [];
  /** Men with NEITHER a weekly row NOR a usable season projection. Named, never silently zeroed. */
  const noBasis: string[] = [];
  let fromWeekly = 0;
  /**
   * THE SEASON-LINE FALLBACK, GUARDED (M3, 2026-09-17). `p.proj / perWeek` was taken on trust, and
   * a roster man whose `proj` is not a finite number -- absent because the board carried no row for
   * him, or NaN because his `ProjPts` cell did not parse -- made this NaN. NaN then propagates all
   * the way to `totalProj`, which is the HEADLINE number of the verb, and serialises to JSON `null`;
   * the man is still seated (NaN sorts last but the assignment fills every slot it legally can), his
   * slot prints `NaN`, and `basisNote` says he "fell back to the season projection divided by 17" --
   * which is precisely what did not happen. A number nobody can read is better than a number that is
   * wrong, but a NAMED zero is better than either. `Number.isFinite` was already the test applied to
   * the weekly value one line up; it simply was not applied to the fallback.
   *
   * Today's only production loader (`loadSimContext`) writes `Number(j.ProjPts) || 0` and DROPS a
   * rostered man with no board row, so this is latent there rather than live -- but `lineupRecommend`
   * is also reached from hand-built contexts (the backtest harness, the scripts) where it is not.
   */
  /**
   * AND IT IS THE D18 REST-OF-SEASON BLEND, NOT THE PRESEASON LINE (D33, 2026-09-17). This used to
   * be `p.proj / perWeek` -- the August number spread flat -- while `src/draft/season.ts` priced the
   * very same man, on the very same context, at `rosPerGame`: his preseason line updated on the
   * games he has actually played, by the format's own fitted K. Two surfaces, one context, two
   * different per-week strengths for one player, which is exactly the drift `WEEKLY_SERVE` was built
   * to make impossible, one seam short. `perGameStrength` is now the ONE definition both read.
   */
  /** Of the men who fell back, the ones priced at the D18 BLEND rather than at the flat preseason
   *  line. Counted so `basisNote` can say which of the two it was -- a caveat that named the wrong
   *  one would be the same defect as the NaN it replaced, one layer up. */
  const blendedBack: string[] = [];
  /** Men whose game is over and whose real score replaced their projection. Named, and totalled, so
   *  a reader can see how much of the headline number is already banked rather than forecast. */
  const settled: { name: string; pts: number }[] = [];
  const seasonFallback = (p: { name: string; proj: number; rosPerGame?: number }): number => {
    const v = perGameStrength(p, perWeek);
    if (Number.isFinite(v)) {
      if (p.rosPerGame != null && Number.isFinite(p.rosPerGame)) blendedBack.push(p.name);
      return v;
    }
    noBasis.push(p.name);
    return 0;
  };
  const players = roster.map((p) => {
    const why = unavailableReason(p, week, availability);
    if (why) unavailable.push({ name: p.name, pos: p.pos, reason: why });
    const wk = weeklyFor(o.weekly, p);
    if (o.weekly) { if (wk != null && Number.isFinite(wk)) fromWeekly++; else fellBack.push(p.name); }
    const pts = wk != null && Number.isFinite(wk) ? wk : seasonFallback(p);
    // KICKOFF LOCK. `o.locked` is the set of NFL teams whose week has started; a man on one of them
    // holds wherever he currently sits. Absent, nothing is locked and the assignment is exactly what
    // it was -- which is what every caller that does not pass it still gets.
    const nflTeam = p.team ? String(p.team).toUpperCase() : null;
    const locked = !!nflTeam && lockedTeams.has(nflTeam);
    // SETTLED: his game is OVER and the league has scored him. He is no longer a projection.
    const done = !!nflTeam && finishedSet.has(nflTeam);
    const actual = done && p.playerId != null ? settledPts.get(p.playerId) : undefined;
    if (actual != null && Number.isFinite(actual)) settled.push({ name: p.name, pts: r2(actual) });
    return {
      name: p.name, pos: p.pos,
      proj: actual != null && Number.isFinite(actual) ? r2(actual) : r2(pts),
      available: why == null, reason: why ?? "available",
      ...(locked ? { locked: true, lockedSlot: p.slot ?? null } : {}),
    };
  });
  const res = optimalLineup(players, ctx.slots, ctx.flexOk);
  assertStartersAvailable(res.starters, roster, week, availability);
  // Keyed on name AND position (M3): a roster carrying two men of one name gave both bench rows
  // the LAST one's reason, so a bye man could be listed as "available". Unique names: unchanged.
  const reasonOf = new Map(players.map((p) => [`${p.name}|${p.pos}`, p.reason]));

  // -------------------------------------------------------------------------------------------
  // THE HEAD-TO-HEAD OBJECTIVE. Everything above is unchanged and runs for both objectives, so the
  // expected-points lineup is computed either way and the two are always comparable.
  // -------------------------------------------------------------------------------------------
  const objective: LineupObjective = o.objective ?? "expected";
  let wp: (WinProbResult & { opponent: string; opponentTeamId: string }) | undefined;
  if (objective === "winprob") {
    // THE OPPONENT IS NOT OPTIONAL AND IS NOT INVENTED. A win probability against a generated
    // schedule's stand-in opponent would be a number about a league that does not exist, and it
    // would look exactly like a real one. So this REFUSES rather than substituting -- the same rule
    // `--schedule real` follows one level up.
    if (ctx.syntheticSchedule) {
      throw new Error(
        "objective \"winprob\" needs the REAL schedule: it is a probability of beating a NAMED opponent, " +
        "and this context is on a GENERATED schedule, whose week-" + week + " pairing is not this league's. " +
        "Re-load the context with schedule \"real\".",
      );
    }
    const games = ctx.weeks[week - 1];
    if (!games) throw new Error(`objective "winprob": the schedule has no week ${week} (it runs 1-${ctx.weeks.length})`);
    const pair = games.find(([a, b]) => a === ctx.meIdx || b === ctx.meIdx);
    if (!pair) throw new Error(`objective "winprob": we are not scheduled in week ${week}`);
    const oppIdx = pair[0] === ctx.meIdx ? pair[1] : pair[0];
    const opp = ctx.teams[oppIdx];

    /** One roster into the sampler's shape: the mean the EP lineup uses, the band the probability
     *  needs, the NFL team the copula couples on, and the SAME availability rule as above. */
    const toWp = (rs: typeof roster): WinProbPlayer[] => rs.map((p) => {
      const k = lineupNameKey(p.name);
      const wk = o.weekly?.get(k);
      // The SAME guard as the expected-points path above -- a NaN mean here would poison the
      // sampler's every draw rather than one slot. Fixing one of two callers of a rule is worse
      // than fixing neither, because it looks done. And the SAME D33 blend, for the same reason.
      const sf = perGameStrength(p, perWeek);
      const pts = wk != null && Number.isFinite(wk) ? wk : (Number.isFinite(sf) ? sf : 0);
      return {
        name: p.name, pos: p.pos, ...(p.eligible ? { eligible: p.eligible } : {}),
        available: unavailableReason(p, week, availability) == null,
        team: p.team ?? null,
        proj: r2(pts),
        band: o.bands?.get(k) ?? null,
        ...(p.team && lockedTeams.has(String(p.team).toUpperCase())
          ? { locked: true, lockedSlot: p.slot ?? null } : {}),
      };
    });

    /**
     * A FINISHED MAN IS A CONSTANT, and the sampler has to be told so explicitly.
     *
     * Leaving his band alone would draw him from a pre-game distribution he has already resolved --
     * a receiver who scored 4.3 would keep contributing a 1.8-to-23.9 spread to our variance, which
     * is the single biggest input to P(win). Collapsing the band to a point at what he actually
     * scored is not a modelling choice; it is the only description of a completed game.
     *
     * `pZero` is deliberately dropped: a two-part band's zero atom is a statement about a game that
     * might not happen, and this one did.
     */
    const settleWp = (list: WinProbPlayer[], rs: typeof roster): WinProbPlayer[] => {
      const byName = new Map(rs.map((r) => [r.name, r]));
      return list.map((w) => {
        const r = byName.get(w.name);
        const nfl = r?.team ? String(r.team).toUpperCase() : null;
        const done = !!nfl && finishedSet.has(nfl);
        const actual = done && r?.playerId != null ? settledPts.get(r.playerId) : undefined;
        if (actual == null || !Number.isFinite(actual)) return w;
        const v = r2(actual);
        return { ...w, proj: v, band: { mean: v, p10: v, p50: v, p90: v } };
      });
    };
    const oursWp = settleWp(toWp(roster), roster);
    // THE OPPONENT IS SETTLED TOO. Half of a head-to-head margin is his, and pricing his finished
    // players at their pre-game bands while ours are constants would bias every probability in our
    // favour on exactly the days the question matters most.
    const theirsWp = settleWp(toWp(opp.roster), opp.roster).filter((p) => p.available);
    const r = winProbLineup(oursWp, opponentStarters(theirsWp, ctx.slots, ctx.flexOk), ctx.slots, ctx.flexOk, o.winprob);
    wp = { ...r, opponent: opp.name, opponentTeamId: opp.id };
    assertStartersAvailable(r.starters, roster, week, availability);
  }

  const allWeekly = o.weekly != null && fellBack.length === 0;
  // A weekly lineup has no SEASON objective to trade off -- you start the best legal eleven, and that
  // is the same answer whichever regime we are in. The objective block still travels, with the regime
  // unknown, so a consumer never has to wonder whether it was omitted or forgotten.
  const assumptions = assumptionsOf(ctx, allWeekly ? "weekly-model" : "projection", o, null, null, objectiveFor(null));
  // WHICH LINEUP QUESTION WAS ASKED, written into the objective block that already travels on every
  // result. A consumer that quotes `assumptions.objective` and nothing else must not be able to
  // mistake a win-probability lineup for the expected-points one it has always been handed.
  assumptions.objective = {
    ...assumptions.objective,
    note: objective === "winprob"
      ? `LINEUP OBJECTIVE: winprob -- the starters maximise P(beating ${wp!.opponent} in week ${week}), ` +
        `not expected points. P(win) ${wp!.winPct}% against ${wp!.epWinPct}% for the expected-points lineup, ` +
        `bought for ${wp!.epCostPts} projected points. ` + assumptions.objective.note
      : `LINEUP OBJECTIVE: expected -- the starters maximise the sum of projected points over a legal ` +
        `assignment, which is the right objective only when the game is close. ` + assumptions.objective.note,
  };
  assumptions.basisNote = o.weekly == null
    ? `no weekly projector was supplied: every point total is the season projection divided by ${perWeek}, which has no matchup, no recent form and no weather in it`
    : allWeekly
      ? `every point total is from the weekly projector (src/weekly/projector.ts) for week ${week}`
      : `${fromWeekly} of ${roster.length} point totals are from the weekly projector for week ${week}; ` +
        `${fellBack.length} fell back to the season line because the projector had no row for them: ${fellBack.join(", ")}` +
        // D33: WHICH season line, per man. The blend and the flat preseason number are different
        // quantities and a caveat that named only one of them would be describing the other.
        (blendedBack.length
          ? `; ${blendedBack.length} of those are priced at the REST-OF-SEASON blend (the preseason line updated on the games he has played, the same number the season simulator uses): ${blendedBack.join(", ")}`
          : `; none of them has played games in this context, so all ${fellBack.length} are the preseason projection divided by ${perWeek}`);
  // AND THE MEN WITH NO BASIS AT ALL (M3). The sentence above claims the fallback was a season
  // projection; for these men there was none, and they are carried at zero. Saying "fell back to the
  // season line" about a man who has no season line is the same defect as the NaN it replaced, one
  // layer up -- a plausible sentence about something that did not happen.
  if (noBasis.length) {
    assumptions.basisNote += `; ${noBasis.length} man/men had NEITHER a weekly row NOR a usable ` +
      `season projection and are carried at ZERO, which understates them: ${noBasis.join(", ")}. ` +
      "That is a board/roster join gap, not a projection.";
  }

  // Under `winprob` the STARTERS are the win-probability lineup and the bench is its complement --
  // the answer to the question that was asked. The expected-points lineup is not discarded: it is on
  // `winprob.epStarters` with its own P(win), so the two are always side by side and the reader can
  // see the trade rather than being told about it.
  const starters = wp ? wp.starters : res.starters.map((s) => ({ ...s, proj: r2(s.proj) }));
  const startingNames = new Map<string, number>();
  for (const s of starters) startingNames.set(s.name, (startingNames.get(s.name) ?? 0) + 1);
  const bench = wp
    // Consume one STARTING SEAT per name rather than filtering every man of that name out
    // (M3): with two men of one name and only one of them starting, the name-set filter
    // dropped BOTH, so a rostered man vanished from the result entirely. Unique names: unchanged.
    ? players.filter((p) => { const n = startingNames.get(p.name) ?? 0; if (n > 0) { startingNames.set(p.name, n - 1); return false; } return true; }).sort((a, b) => b.proj - a.proj)
        .map((p) => ({ name: p.name, pos: p.pos, proj: r2(p.proj), available: p.available, reason: p.reason }))
    : res.bench.map((b) => ({ ...b, proj: r2(b.proj), reason: reasonOf.get(`${b.name}|${b.pos}`) ?? "available" }));

  // DST SAME-GAME CONFLICT. Our defense is negatively correlated with the offense it FACES (measured
  // 2012-2025: vs the opposing QB -0.32, RB -0.11, WR -0.05), so starting our DST AND an offensive
  // player in the SAME NFL game means the two partly cancel -- a hedge against ourselves. Flag it
  // (informational, small, worst for a QB). Needs the week's NFL schedule via `o.nflOpp`; absent it,
  // nothing is flagged and the output is byte-identical.
  const extraFlags: string[] = [];
  // A NAME STARTED TWICE (M3). Two distinct men can share a name, and starting both of them is a
  // legal lineup -- but it PRINTS as the same player in two slots, which reads as a bug in the
  // optimizer and is indistinguishable from a duplicated roster row. The assignment is not touched
  // (it is correct); the ambiguity is named, because the reader cannot otherwise resolve it. Inert
  // on every roster with unique names, which is every roster this league has had.
  {
    const seen = new Set<string>();
    for (const s of starters) {
      if (s.name === "(empty)") continue;
      if (seen.has(s.name)) {
        extraFlags.push(`"${s.name}" fills more than one slot -- the roster carries ${roster.filter((p) => p.name === s.name).length} men of that name. ` +
          "Both are started and the lineup is legal, but check which is which before submitting it.");
      }
      seen.add(s.name);
    }
  }
  if (o.nflOpp) {
    const teamOf = new Map(roster.map((p) => [p.name, (p.team ?? "").toUpperCase()]));
    for (const s of starters) {
      if (s.pos !== "DST") continue;
      const dstTeam = teamOf.get(s.name);
      const opp = dstTeam ? o.nflOpp.get(dstTeam) : undefined;
      if (!opp) continue;
      for (const c of starters) {
        if (c.pos === "DST" || c.pos === "K") continue;
        if (teamOf.get(c.name) !== opp) continue;
        extraFlags.push(
          `DST conflict: ${s.name} and ${c.name} (${c.pos}) are in the same NFL game ` +
          `(${dstTeam} vs ${opp}) -- your defense and your ${c.pos} partly cancel ` +
          `(measured DST-vs-opposing-offense correlation, worst for a QB).`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // THE MARGIN, PER CONTESTED SLOT (WP19). See `LineupContest` for what it is and what it is not.
  // Computed from the lineup that was ACTUALLY returned -- `starters` above, which is the winprob
  // lineup under that objective -- and from the bench it left, so the two can never describe
  // different assignments.
  // -------------------------------------------------------------------------------------------
  const bandOf = (name: string): { p10: number | null; p90: number | null } => {
    const b = o.bands?.get(lineupNameKey(name));
    return b && Number.isFinite(b.p10) && Number.isFinite(b.p90) ? { p10: r2(b.p10), p90: r2(b.p90) } : { p10: null, p90: null };
  };
  const flexSet = ctx.flexOk ? new Set(ctx.flexOk) : undefined;
  const contested: LineupContest[] = [];
  /**
   * A LOCKED MAN IS NOT A CONTEST, on either side of it.
   *
   * `contested` exists to say how close a DECISION was, and a decision the manager cannot take is
   * not close -- it is not a decision. Before this, the morning after a Thursday game the serve
   * reported "QB Bo Nix over Jared Goff by -1.47" about a quarterback who had already played and
   * could not be started: a NEGATIVE margin, which reads as "you are starting the worse man", about
   * the only lineup that was legal. And it named our two locked Detroit receivers as contested
   * slots when neither could be moved at all.
   *
   * So a locked STARTER's slot is skipped (nothing can replace him) and a locked BENCH man is never
   * offered as the alternative (he cannot come in). This is the same constraint `optimalLineup` and
   * the winprob swap search now apply, at the layer that REPORTS rather than decides -- and it has
   * to be applied here too, because a caveat that contradicts the lineup it describes is worse than
   * no caveat: the reader believes the sentence, not the assignment.
   */
  const lockedNames = new Set(
    roster.filter((p) => p.team && lockedTeams.has(String(p.team).toUpperCase())).map((p) => p.name),
  );
  for (const s of starters) {
    if (s.name === "(empty)") continue;
    if (lockedNames.has(s.name)) continue;
    const admits = slotAdmits(s.slot, flexSet);
    // The best man who is SITTING, is available, is NOT locked, and could legally take this slot.
    let alt: (typeof bench)[number] | null = null;
    for (const b of bench) {
      if (!b.available || !admits.includes(b.pos) || lockedNames.has(b.name)) continue;
      if (alt == null || b.proj > alt.proj) alt = b;
    }
    if (!alt) continue;
    const sb = bandOf(s.name), ab = bandOf(alt.name);
    const spans = [sb, ab].filter((x) => x.p10 != null && x.p90 != null).map((x) => x.p90! - x.p10!);
    const width = spans.length ? Math.max(...spans) : null;
    contested.push({
      slot: s.slot,
      starter: { name: s.name, pos: s.pos, proj: r2(s.proj), ...sb },
      alternative: { name: alt.name, pos: alt.pos, proj: r2(alt.proj), ...ab },
      margin: r2(s.proj - alt.proj),
      marginBandFrac: width != null && width > 0 ? r3(Math.abs(s.proj - alt.proj) / width) : null,
    });
  }
  // THE SETTLED SPLIT SAYS ITSELF FIRST, because it changes how every other number in this result
  // should be read: a total that is half banked is not a forecast, and a win probability computed
  // over it is much tighter than one computed before kickoff.
  {
    const startedNow = new Set(starters.map((x) => x.name));
    const seated = settled.filter((x) => startedNow.has(x.name));
    if (seated.length) {
      const b = seated.reduce((a, x) => a + x.pts, 0);
      assumptions.basisNote += `; ${seated.length} starter(s) have FINISHED and are priced at what they ` +
        `actually scored, not at a projection: ${seated.map((x) => `${x.name} ${x.pts.toFixed(1)}`).join(", ")} ` +
        `-- ${b.toFixed(1)} points of the total are BANKED and cannot change`;
    }
  }
  // THE CAVEAT SAYS IT, because a result nobody reads the JSON of is a result that did not say it.
  // The TIGHTEST contest is the one that decides whether the recommendation is a recommendation.
  const tight = contested.reduce(
    (a, c) => (a == null || Math.abs(c.margin) < Math.abs(a.margin) ? c : a), null as LineupContest | null);
  if (tight) {
    assumptions.basisNote +=
      `. TIGHTEST CALL: ${tight.slot} is decided by ${Math.abs(tight.margin).toFixed(2)} projected points ` +
      `(${tight.starter.name} ${tight.starter.proj.toFixed(2)} over ${tight.alternative.name} ${tight.alternative.proj.toFixed(2)})` +
      (tight.marginBandFrac != null && tight.starter.p10 != null && tight.starter.p90 != null
        ? `, inside a p10-p90 band ${(tight.starter.p90 - tight.starter.p10).toFixed(1)} points wide -- ` +
          `${(100 * tight.marginBandFrac).toFixed(1)}% of the band, i.e. the EXPECTED-points ordering is clear and the ` +
          "REALISED one is close to a coin toss"
        : " (no served band for either man, so how close that is cannot be stated)");
  }

  // THE BANKED/FORECAST SPLIT, over the men who were actually SEATED. `settled` above is every man
  // on the roster whose game is over; only the started ones contribute to the headline total, and
  // reporting the bench's settled points inside it would overstate what is locked in.
  const startedNames = new Set(starters.map((x) => x.name));
  const seatedSettled = settled.filter((x) => startedNames.has(x.name));
  const banked = r2(seatedSettled.reduce((a, x) => a + x.pts, 0));
  const total = wp ? wp.totalProj : r2(res.totalProj);

  return {
    week,
    starters,
    contested,
    bench,
    unavailable,
    totalProj: total,
    ...(seatedSettled.length
      ? { settled: { banked, projected: r2(total - banked), players: seatedSettled } }
      : {}),
    flags: [...res.flags, ...extraFlags],
    assumptions,
    objective,
    ...(wp ? { winprob: wp } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// STREAMING -- whom to START or ADD at ONE position, this week.
// ---------------------------------------------------------------------------------------------

/**
 * A DIFFERENT QUESTION FROM `lineupRecommend`, and the difference is the whole verb.
 *
 * `lineupRecommend` sets the best legal eleven out of the twelve men we already own. It cannot
 * answer "my defence is on bye and there are nine defences free -- which one". That decision is
 * about a POOL rather than a roster, it is made at one position at a time, and the thing that
 * decides it is almost entirely the matchup: at quarterback, kicker and defence the free option in a
 * 16-team league is barely worse than a rostered one, which is exactly why `src/draft/season.ts`
 * models a streamed replacement rather than scoring an unfilled slot as zero.
 *
 * THE UNIT IS POINTS AND IT SAYS SO. Everything else in this module is scored as a change in P(playoffs)
 * because the alternative -- points -- cannot see a mandatory slot going empty or a top-heavy roster.
 * A one-week start/sit at one position has none of those properties: it is a single slot, this
 * Sunday, and simulating a season to price it would be answering a question nobody asked with a
 * number whose noise floor is larger than the effect. So `assumptions.basis` is `weekly-model` and
 * `objective` travels with the regime UNKNOWN, exactly as `lineupRecommend` does, rather than
 * dressing a points quantity up as a probability.
 *
 * WHICH ARTIFACT SERVED WHICH POSITION IS ON EVERY ROW. The streaming gate is applied per position,
 * so at some positions this is the streaming model and at others it is the same floor the lineup is
 * served from. A reader who cannot tell which would read a floor projection as a matchup-aware one.
 */
export interface StreamPlayer {
  name: string;
  pos: string;
  team: string | null;
  /** Projected points for THIS week. */
  proj: number;
  p10: number;
  p90: number;
  /** P(he scores nothing). Null where the serving artifact does not publish one -- the floor does
   *  not, and inventing a zero here would let it claim a calibration it has never had. */
  pZero: number | null;
  ours: boolean;
  /** Rostered by anyone in the league. A player who is neither `ours` nor `rostered` is streamable. */
  rostered: boolean;
  /** Non-null when he cannot be started this week (bye, or ruled out). */
  unavailable: string | null;
  artifact: string;
}

export interface StreamAdd {
  add: string;
  drop: string;
  dropPos: string;
  /** Expected points GAINED this week by starting the added man instead of our best legal option. */
  gainPts: number;
  legal: boolean;
  why: string | null;
}

export interface StreamRecommendResult {
  week: number;
  pos: string;
  /** Our own men at this position, best first. */
  ours: StreamPlayer[];
  /** The streamable pool, best first, truncated to `limit`. */
  pool: StreamPlayer[];
  /** Whom to START, of the men we already own. Null when we own nobody startable there. */
  start: StreamPlayer | null;
  /** Ours who should NOT start, with the reason. */
  sit: { name: string; reason: string }[];
  /** The claim worth making, or null when nobody free beats what we have. */
  add: StreamAdd | null;
  /** Add/drop pairs REFUSED because they leave a mandatory slot unfillable. Named, never skipped. */
  refused: { add: string; drop: string; why: string }[];
  assumptions: Assumptions;
}

/**
 * Rank our men and the pool at ONE position by the weekly projection, and say what to do.
 *
 * `o.pool` is the caller's -- `copilotActions.ts` loads it from `src/weekly/streamingServe.ts`, so
 * this function stays pure and testable on a fixture with no store and no league. A position with no
 * projections at all returns empty lists and an `assumptions.basisNote` that says so, rather than
 * silently recommending nothing as though nothing were worth doing.
 */
export function streamRecommend(
  ctx: SimContext,
  week: number,
  pos: string,
  o: BaseOpts & {
    availability?: AvailabilityMap;
    /** Every candidate at this position the weekly projector could speak to. */
    pool?: StreamPlayer[];
    /** How many pool rows to return. The ranking is over all of them; this only truncates output. */
    limit?: number;
    /** pos -> artifact filename, for the assumptions block. */
    artifactByPos?: Record<string, string>;
  } = {},
): StreamRecommendResult {
  // THE CONTEXT IS THE DEFAULT. `o.availability` survives ONLY as a fault-injection override for the
  // tests -- `availability?: X` on an options bag is exactly what let eight of ten verbs run without
  // it, so it must never again be the only way the value arrives. See src/inseason/weekState.ts.
  const availability = o.availability ?? ctx.week.availability;
  const limit = o.limit ?? 8;
  const roster = ctx.teams[ctx.meIdx].roster;
  const byeOf = new Map(roster.map((p) => [nameKey(p.name), p.bye ?? null]));

  const decorate = (p: StreamPlayer): StreamPlayer => ({
    ...p,
    unavailable: unavailableReason({ name: p.name, pos: p.pos, bye: byeOf.get(nameKey(p.name)) ?? null }, week, availability),
  });
  const all = (o.pool ?? []).filter((p) => p.pos === pos).map(decorate);
  const ours = all.filter((p) => p.ours).sort((a, b) => b.proj - a.proj);
  // STREAMABLE means nobody in the league has him. A man on another roster is not a waiver claim,
  // and listing him as one is how a "recommendation" becomes something the user cannot act on.
  const pool = all.filter((p) => !p.ours && !p.rostered).sort((a, b) => b.proj - a.proj);

  const start = ours.find((p) => p.unavailable == null) ?? null;
  const sit = ours.filter((p) => p !== start)
    .map((p) => ({ name: p.name, reason: p.unavailable ?? `projected ${r2(p.proj)} behind ${start?.name ?? "nobody"}` }));

  // THE ADD. The best free man, against our best LEGAL starter -- not against our best man, because
  // a starter who is out projects whatever he projects and cannot score it. That distinction is the
  // most common real streaming situation there is: the bye week.
  const refused: StreamRecommendResult["refused"] = [];
  let add: StreamAdd | null = null;
  const best = pool.find((p) => p.unavailable == null);
  if (best && (!start || best.proj > start.proj)) {
    // Cheapest first: the lowest-projection bodies are the real drop candidates. `rosterGaps`
    // REFUSES a drop that leaves a mandatory slot unfillable -- dropping the only kicker to stream a
    // defence is not a move anybody makes -- and refusals are named rather than silently skipped.
    const candidates = [...roster].sort((a, b) => a.proj - b.proj);
    for (const cand of candidates) {
      const after = roster.filter((p) => p.name !== cand.name)
        .concat([{ name: best.name, pos: best.pos, proj: cand.proj, team: best.team ?? undefined, bye: null }]);
      // Floor and ceiling both -- a swap keeps the roster SIZE constant but can still leave a
      // position over its league maximum (drop a tight end, add a fifth quarterback).
      const gaps = [...rosterGaps([{ id: "us", name: "us", roster: after }], ctx.slots, ctx.flexOk),
        ...rosterOverfills([{ id: "us", name: "us", roster: after }], ctx.posMax)];
      if (gaps.length) {
        refused.push({ add: best.name, drop: cand.name, why: gaps[0].replace(/^[^:]*:\s*/, "") });
        continue;
      }
      add = {
        add: best.name, drop: cand.name, dropPos: cand.pos,
        gainPts: r2(best.proj - (start?.proj ?? 0)),
        legal: true, why: null,
      };
      break;
    }
    if (!add) {
      add = {
        add: best.name, drop: "(none legal)", dropPos: "-",
        gainPts: r2(best.proj - (start?.proj ?? 0)),
        legal: false,
        why: "every drop that would make room leaves a mandatory slot unfillable -- see `refused`",
      };
    }
  }

  const assumptions = assumptionsOf(ctx, "weekly-model", o, null, null, objectiveFor(null));
  const served = o.artifactByPos?.[pos] ?? all[0]?.artifact ?? "(none)";
  assumptions.basisNote = !all.length
    ? `the weekly projector had NO row at ${pos} for week ${week} -- nothing is recommended, which is ` +
      "different from recommending that nothing be done. Build the weekly and streaming features first."
    : `${pos} week ${week} projected from ${served}; ${ours.length} of ours and ${pool.length} streamable. ` +
      "Points are a ONE-WEEK quantity from the weekly projector, not a season simulation: there is no " +
      "playoff delta here and none is claimed.";
  return { week, pos, ours, pool: pool.slice(0, limit), start, sit, add, refused, assumptions };
}

// ---------------------------------------------------------------------------------------------
// A SHARED SIMULATION HELPER -- every "what does this move do to our title odds" question.
// ---------------------------------------------------------------------------------------------

/**
 * ALL THREE DELTAS FROM ONE SET OF PAIRED RUNS, plus whichever the regime ranks on.
 *
 * The per-seed deltas are averaged rather than the averages differenced -- that is what keeps the
 * common random numbers doing their job -- and all three come from the SAME simulation of the same
 * seed, so a playoff delta and a playoff-week delta can never be a comparison across two samples.
 */
function deltasOf(after: Outcome[], base: Outcome[], objective: Objective): ObjectiveDelta {
  const dPlayoffs = after.map((a, i) => a.playoffPct - base[i].playoffPct);
  const dTitle = after.map((a, i) => a.titlePct - base[i].titlePct);
  const dPo = after.map((a, i) => a.poPts - base[i].poPts);
  const p = pairedDelta(dPlayoffs);
  const po = pairedDelta(dPo);
  return {
    playoffsPp: p.delta,
    playoffWeekPts: po.delta,
    titlePp: pairedDelta(dTitle).delta,
    rankValue: objective.primary === "playoffs" ? p.delta : po.delta,
    se: objective.primary === "playoffs" ? p.se : po.se,
  };
}

/**
 * COMMON RANDOM NUMBERS, and why every delta below is measured seed by seed.
 *
 * Two league states differing by one player must be simulated under IDENTICAL draws or the
 * difference between them is swamped by which run happened to draw a worse season. Same seed, same
 * draws, and the delta is attributable to the change. Averaging the PER-SEED deltas (rather than
 * differencing two averages) is what keeps that pairing intact, and the spread across seeds is the
 * standard error reported beside every number.
 */
/**
 * ONE SEED CANNOT PRODUCE A STANDARD ERROR, and reporting 0 for it is worse than reporting nothing.
 *
 * `sd([x])` is 0, so a single-seed run printed `se: 0` -- which reads as a perfectly precise
 * measurement and actually means NOT MEASURED. `ff copilot trade-finder` defaults to one seed, so
 * every idea it has ever returned carried `se: 0` beside a delta with real sampling noise in it; the
 * waiver verb defaults to two seeds and reported honest values like 0.1, which is exactly the
 * contrast that makes the 0 look like a number rather than an absence.
 *
 * `null` is the honest answer, and it is a different TYPE, so a consumer that formats it has to
 * decide what to print rather than silently rendering "+/-0".
 */
function pairedDelta(perSeed: number[]): { delta: number; se: number | null } {
  return {
    delta: r2(mean(perSeed)),
    se: perSeed.length < 2 ? null : r2(sd(perSeed) / Math.sqrt(perSeed.length)),
  };
}

// ---------------------------------------------------------------------------------------------
// WAIVERS
// ---------------------------------------------------------------------------------------------

/** Every scored move carries all three numbers. `playoffsPp` is the PRIMARY, `playoffWeekPts` the
 *  SECONDARY, `titlePp` the one reported alongside and never used alone. `rankValue` is whichever of
 *  the first two the ACTIVE REGIME ranks on, so a consumer can sort without knowing the rule. */
export interface ObjectiveDelta {
  playoffsPp: number;
  playoffWeekPts: number;
  titlePp: number;
  rankValue: number;
  /** Sampling error across SEEDS. Null when only one seed was run -- see `pairedDelta`: a single
   *  sample has no measurable spread, and 0 would read as certainty. */
  se: number | null;
}
export interface WaiverDrop extends ObjectiveDelta { name: string; pos: string; proj: number }
export interface WaiverRefusal { add: string; drop: string; pos: string; why: string }
export interface WaiverTarget extends ObjectiveDelta {
  add: string; pos: string; proj: number;
  drop: string; dropPos: string;
  afterPlayoffPct: number;
  afterTitlePct: number;
  clearsNoise: boolean;
  /** WHAT TO BID. Since Track J this is the fitted model's answer for `faabTargetWinPct`, not the
   *  old rule of thumb; `faabBasis` says which produced it on every row. */
  faab: number; faabRule: string;
  /** "model" -- data/faab-model.json, fitted on this league's own 794 claims. "rule" -- the stated
   *  rule of thumb, used only when the artifact or the live state is unavailable, and the row says
   *  so rather than looking identical to a measured one. */
  faabBasis: "model" | "rule";
  /** What this room has PAID for a man like this, in this week, with this much money left. */
  faabClearing: number | null;
  /** P(win) at the recommended bid. Not the target when the bid had to be capped. */
  faabWinPct: number | null;
  /** P(win) at three bid levels, so the row shows the curve rather than one point on it. */
  faabCurve: { bid: number; winPct: number }[] | null;
  /** The unclamped solve. Larger than the budget means the target is UNREACHABLE, not "bid it all". */
  faabWanted: number | null;
  /** The target costs more than the budget / more than we have left. Flagged, never silently capped. */
  faabOverBudget: boolean;
  faabOverRemaining: boolean;
  drops: WaiverDrop[];
}

/** What produced the dollar figure, stated once for the whole result rather than per row. */
export interface FaabAssumption {
  basis: "model" | "rule";
  artifact: string | null;
  builtAt: string | null;
  targetWinPct: number;
  remaining: number | null;
  budget: number;
  /** WHICH LEAGUE these dollars are that league's (I-4). `null` only when the caller did not name one. */
  leagueId: string | null;
  /** From `config.acquisition`, when the league published it. `null` = this store has no acquisition
   *  rules for the league, so the budget is an inference and the process day is unknown. */
  waivers: boolean | null;
  processDays: string[] | null;
  week: number | null;
  /** The `log_bid` interval crossing zero is the caveat the whole recommendation rests on. */
  bidEffectSignificant: boolean | null;
  note: string;
}

export interface WaiverResult {
  basePlayoffPct: number;
  basePlayoffWeekPts: number;
  baseTitlePct: number;
  noiseFloorPp: number;
  targets: WaiverTarget[];
  refused: WaiverRefusal[];
  /** How the add pool was RANKED, and any position the ranking could not price. A reader who sees
   *  four quarterbacks needs to know whether that is the pool or the sort. */
  poolRanking: { basis: "value-over-replacement" | "raw-projection"; missingReplacement: string[] };
  /** Free agents left OUT of the add pool because the store says they cannot play. Named rather than
   *  silently filtered: stashing an injured man is a legitimate human call, and the point is that
   *  the simulator cannot price it. Empty when no availability map was supplied. */
  unavailableAdds: { name: string; pos: string; reason: string }[];
  faabBudget: number;
  objective: Objective;
  /** The waiver result's assumptions carry ONE extra block, because the bid is now a second model's
   *  output and a number from a model with no provenance beside it is exactly what this file
   *  exists to prevent. */
  assumptions: Assumptions & { faab: FaabAssumption };
}

/**
 * THE FALLBACK. It used to be the only thing here.
 *
 * "Nothing in this repo has measured what a percentage point of probability is worth in FAAB
 * dollars; there is no historical bid data to fit it on." That was true when it was written and it
 * is not any more: `fact_waiver_claim` holds 794 of this league's own claims with the bid intact --
 * including 145 LOSING bids, which ESPN publishes as FAILED_INVALIDPLAYERSOURCE -- and
 * `tools/train_faab.py` fits both the clearing price and P(win | bid) on them. So the dollar figure
 * on a waiver row is now a measurement, and THIS rule is what the row falls back to when the
 * artifact or the live budget state is missing. A row that fell back says `faabBasis: "rule"`,
 * because a guess and a measurement that print the same number must not look the same.
 *
 * Ten percent of the budget per point of PLAYOFF probability, capped at half the budget. Kept
 * exactly as it was: a fallback that drifted from the thing it is a fallback for would be worse
 * than none.
 */
export const FAAB_RULE = "10% of budget per +1pp of PLAYOFF probability, capped at 50% -- a stated rule of thumb, not a fitted value. It was quoted against title probability until Phase 3; the rule is unchanged, the quantity it is applied to is the one the simulator can actually predict.";
/** What the row says when the FITTED model produced the number. It still names the quantity the
 *  RANKING prices, because the ranking is unchanged -- only the dollars moved. */
export const FAAB_MODEL_RULE =
  "the bid is FITTED on this league's own 794 waiver claims (data/faab-model.json: clearing price " +
  "plus P(win | bid), the latter measured against ESPN's published LOSING bids), solved for the " +
  "target win probability. The RANKING is unchanged -- it is still the change in PLAYOFF " +
  "probability -- and only the dollars are now a measurement rather than a rule of thumb.";
export function faabFor(deltaPp: number, budget: number): number {
  if (deltaPp <= 0) return 0;
  return Math.max(1, Math.round(Math.min(0.5, deltaPp * 0.10) * budget));
}

/**
 * Score every plausible ADD + DROP by the change in OUR title probability.
 *
 * A waiver claim is two decisions and the second is the one people get wrong. WHO TO ADD is usually
 * obvious; WHO TO DROP is a comparison between players who all look expendable because none of them
 * start. They are not equivalent -- a benched sixth receiver is genuinely idle, while the second
 * tight end is the only thing between us and an empty TE slot. `rosterGaps` refuses that second one
 * outright: dropping the only kicker to roster a fourth back is not a move anybody makes, they claim
 * another kicker instead, and simulating it as an empty slot would OVERSTATE the cost of a claim
 * nobody would make that way. Refused drops are NAMED rather than silently skipped.
 */
export function waiverTargets(
  ctx: SimContext,
  o: BaseOpts & {
    adds?: number; dropsPerAdd?: number; faabBudget?: number; positions?: string[];
    /** The win probability the recommended bid is solved for. Exposed because 0.7 is a CHOICE about
     *  how much of the budget to spend on certainty, not a measured quantity. */
    faabTargetWinPct?: number;
    /** Our remaining FAAB. Read from the store when absent; a bid above it is FLAGGED, not capped. */
    faabRemaining?: number;
    /**
     * WHO CANNOT PLAY. Absent, nothing is filtered and this verb behaves exactly as it did.
     *
     * WHY IT IS NEEDED HERE, AND NOT ONLY IN THE LINEUP. This verb built its add pool straight from
     * the board minus the rostered set and never consulted availability at all, so a free agent on
     * INJURED RESERVE was a candidate like any other -- priced at his full season projection,
     * scored through the simulator as though he would play every remaining week, and returned with
     * a confident playoff delta and a FAAB bid attached. That is exactly what happened on
     * 2026-09-18: Jordan Mason went on IR at 18:55 on the 16th, his manager dropped him four hours
     * later, and this verb recommended bidding 53% of the budget on him.
     *
     * The fix is not the availability VOCABULARY (that was a separate defect, fixed in
     * `normalizeStatus`) -- with the vocabulary corrected he was still recommended, because nothing
     * on this path read availability at all. Fixing one and not the other would have looked done.
     *
     * An excluded man is NAMED, not silently dropped: stashing an injured player is a legitimate
     * human decision, and the point is that the simulator cannot price it, not that nobody should
     * ever do it.
     */
    availability?: AvailabilityMap;
    /** Injection seams, so the replay and the tests can drive the same code path the live tool does
     *  rather than a reimplementation of it. */
    faabModel?: FaabModel | null;
    faabState?: FaabLiveState | null;
    faabWeek?: number;
    dbPath?: string;
    /** WHICH LEAGUE (I-4). Decides which fitted artifact is this league's, and filters every live
     *  read. Omitted = the active league, which is what the callers did implicitly before. */
    leagueId?: string | null;
    /** The league's own acquisition rules (`config.acquisition`), for the budget and the process day. */
    acquisition?: AcquisitionRules | null;
  } = {},
): WaiverResult {
  const trials = o.trials ?? 800;
  const seeds = o.seeds ?? [7, 101];
  const nAdds = o.adds ?? 5;
  const nDrops = o.dropsPerAdd ?? 4;
  const target = o.faabTargetWinPct ?? 0.7;

  // ---- THE BID MODEL, and everything it needs to be point-in-time ------------------------------
  //
  // Both halves can be absent -- no artifact on disk, or a store with no rows for this season -- and
  // when either is, the row falls back to the rule of thumb AND SAYS SO. A degraded number that
  // looks identical to a measured one is the failure this whole file is organised against.
  //
  // THE ARTIFACT IS RESOLVED PER LEAGUE (I-4). `data/faab-model.json` is league 462233's, fitted on
  // ITS 794 claims; handing it to another room and printing `faabBasis: "model"` would be a guess
  // wearing a measurement's label. `faabArtifactFor` returns a MISS with a reason, and the reason is
  // what lands in `assumptions.faab.note`.
  let model: FaabModel | null = null;
  let live: FaabLiveState | null = null;
  let faabNote = "";
  const artifact = faabArtifactFor(o.leagueId);
  try {
    if (o.faabModel !== undefined) model = o.faabModel;
    else if (!artifact.exists) model = null;
    else model = loadFaabModel(artifact.path);
    if (!model) faabNote = `${artifact.reason ?? `no fitted artifact at ${artifact.path}`} -- falling back to the rule of thumb`;
  } catch (e) { faabNote = `the FAAB artifact would not load (${(e as Error).message}) -- falling back to the rule of thumb`; }
  if (model) {
    try {
      live = o.faabState !== undefined ? o.faabState : liveFaabState({
        dbPath: o.dbPath, season: ctx.season, week: o.faabWeek,
        teamId: ctx.teams[ctx.meIdx].id, fallbackBudget: o.faabBudget,
        leagueId: o.leagueId, acquisition: o.acquisition,
      });
    } catch (e) { faabNote = `the live FAAB state is unreadable (${(e as Error).message}) -- falling back to the rule of thumb`; }
  }
  // The league's own budget outranks the caller's default AND the store inference, so a rule-basis
  // row on a $100 FAB league is priced against $100 rather than against an ESPN assumption.
  const acqBudget = o.acquisition?.faabBudget ?? null;
  const budget = (acqBudget && acqBudget > 0 ? acqBudget : null) ?? o.faabBudget ?? live?.budget ?? 100;
  const remaining = o.faabRemaining ?? live?.remaining ?? null;
  const usingModel = !!(model && live);
  if (usingModel) faabNote = live!.note;

  // UNAVAILABLE FREE AGENTS ARE EXCLUDED AND NAMED. See `availability` above for why this verb had
  // no such filter at all. The key is the same `nameKey` the availability map is built on, so this
  // is an id-style lookup rather than a display-name match.
  const unavailableAdds: { name: string; pos: string; reason: string }[] = [];
  const isOut = (p: { name: string; pos: string }): boolean => {
    const a = (o.availability ?? ctx.week.availability).get(nameKey(p.name));
    if (!a || a.status !== "OUT") return false;
    unavailableAdds.push({ name: p.name, pos: p.pos, reason: a.detail ?? a.source });
    return true;
  };
  /**
   * THE POOL IS RANKED BY VALUE OVER REPLACEMENT, NOT BY RAW SEASON POINTS.
   *
   * It used to be `.sort((a, b) => b.proj - a.proj)` over the whole free-agent pool. Season point
   * totals are not comparable across positions -- a quarterback outscores every running back in any
   * scoring system -- so the top `nAdds` were QUARTERBACKS every single time, in every league,
   * forever. Measured on 2026-09-18, league 462233: the four candidates offered were Malik Willis,
   * Bryce Young, Sam Darnold and Jacoby Brissett, while the pool held 115 WRs, 92 RBs and 59 TEs
   * that could not be reached without passing `--pos`. Three of the four scored +0.00pp, correctly:
   * the roster already had a starting QB, so a backup never enters a lineup. The verb was
   * structurally unable to evaluate the pool it exists to evaluate.
   *
   * `ctx.replacement` is the per-position WEEKLY points freely available off waivers -- the
   * streaming floor the season simulator already uses -- so the comparable quantity is the season
   * total ABOVE that floor. A quarterback worth 280 points against a 17-point-a-week streamer is
   * worth less than a back worth 180 against a 6-point-a-week one, which is the whole point.
   *
   * A POSITION WITH NO REPLACEMENT LEVEL IS NAMED, not silently ranked on raw points -- that would
   * reinstate the bug for exactly the positions the store knows least about.
   */
  const missingReplacement = new Set<string>();
  const vor = (p: { pos: string; proj: number }): number => {
    const r = ctx.replacement[p.pos];
    if (r == null) { missingReplacement.add(p.pos); return p.proj; }
    return p.proj - r * NFL_WEEKS;
  };
  const free = [...ctx.board.entries()]
    .filter(([id]) => !ctx.ownedIds.has(id))
    .map(([, p]) => p)
    .filter((p) => (o.positions ? o.positions.includes(p.pos) : true))
    .sort((a, b) => vor(b) - vor(a))
    .filter((p) => !isOut(p))
    .slice(0, nAdds);

  const baseBySeed = seeds.map((s) => outcomeOf(ctx, ctx.teams, trials, s));
  const basePlayoff = mean(baseBySeed.map((b) => b.playoffPct));
  const baseTitle = mean(baseBySeed.map((b) => b.titlePct));
  const basePoPts = mean(baseBySeed.map((b) => b.poPts));
  const objective = objectiveFor(basePlayoff, o.secureThresholdPct);
  const mine = ctx.teams[ctx.meIdx].roster;
  const refused: WaiverRefusal[] = [];
  const targets: WaiverTarget[] = [];

  /**
   * ONE ROW'S DOLLARS, and the eight fields that say where they came from.
   *
   * A player the live table has no row for -- a man signed on the Tuesday, a fixture name the
   * feature build has never seen -- keeps the model's population-level answer rather than being
   * dropped: the position, the week and both budget shares are still known, and the missing
   * columns take the artifact's own published defaults, which is what `missing` in a feature spec
   * IS. That is stated in `assumptions.faab.note` rather than left to be inferred.
   */
  const bidFor = (name: string, pos: string, deltaPp: number): Pick<WaiverTarget,
    "faab" | "faabRule" | "faabBasis" | "faabClearing" | "faabWinPct" | "faabCurve" | "faabWanted"
    | "faabOverBudget" | "faabOverRemaining"> => {
    if (!usingModel) {
      return {
        faab: faabFor(deltaPp, budget), faabRule: FAAB_RULE, faabBasis: "rule",
        faabClearing: null, faabWinPct: null, faabCurve: null, faabWanted: null,
        faabOverBudget: false, faabOverRemaining: false,
      };
    }
    const m = model!, st = live!;
    const p = st.byPlayer.get(nameKey(name));
    const row: FaabRow = {
      budget,
      f: featureRow(m, {
        pos, week: st.week,
        posLineRank: p?.posLineRank ?? null, seasonLinePg: p?.seasonLinePg ?? null,
        tdPpg: p?.tdPpg ?? null, priorPts: p?.priorPts ?? null,
        teamFaabShare: st.teamFaabShare, leagueFaabShare: st.leagueFaabShare,
        teamsNeedPos: st.needByPos.get(pos) ?? null, teamsCounted: st.needByPos.size ? st.teamsCounted : null,
      }),
    };
    const a = recommendBid(m, row, { target, remaining });
    return {
      faab: a.bid, faabRule: FAAB_MODEL_RULE, faabBasis: "model",
      faabClearing: a.clearingPrice, faabWinPct: a.winPctAtBid, faabCurve: a.curve,
      faabWanted: a.wanted, faabOverBudget: a.overBudget, faabOverRemaining: a.overRemaining,
    };
  };

  for (const add of free) {
    // Cheapest first: the lowest-projection bodies are the real drop candidates, and evaluating all
    // twelve against five adds is minutes of simulation for rows nobody reads.
    const candidates = [...mine].sort((a, b) => a.proj - b.proj).slice(0, Math.max(1, nDrops) + 3);
    const drops: WaiverDrop[] = [];
    for (const cand of candidates) {
      if (drops.length >= nDrops) break;
      const probe = ctx.clone();
      probe[ctx.meIdx].roster = probe[ctx.meIdx].roster.filter((p) => p.name !== cand.name).concat([{ ...add }]);
      const gaps = [...rosterGaps([probe[ctx.meIdx]], ctx.slots, ctx.flexOk),
        ...rosterOverfills([probe[ctx.meIdx]], ctx.posMax)];
      if (gaps.length) {
        refused.push({ add: add.name, drop: cand.name, pos: cand.pos, why: gaps[0].replace(/^[^:]*:\s*/, "") });
        continue;
      }
      const after = seeds.map((s) => {
        const teams = ctx.clone();
        teams[ctx.meIdx].roster = teams[ctx.meIdx].roster.filter((p) => p.name !== cand.name).concat([{ ...add }]);
        return outcomeOf(ctx, teams, trials, s);
      });
      drops.push({ name: cand.name, pos: cand.pos, proj: r2(cand.proj), ...deltasOf(after, baseBySeed, objective) });
    }
    if (!drops.length) continue;
    drops.sort((a, b) => b.rankValue - a.rankValue);
    const best = drops[0];
    const floor = noiseFloorPp(basePlayoff, trials);
    targets.push({
      add: add.name, pos: add.pos, proj: r2(add.proj),
      drop: best.name, dropPos: best.pos,
      playoffsPp: best.playoffsPp, playoffWeekPts: best.playoffWeekPts, titlePp: best.titlePp,
      rankValue: best.rankValue, se: best.se,
      afterPlayoffPct: r2(basePlayoff + best.playoffsPp),
      afterTitlePct: r2(baseTitle + best.titlePp),
      // The noise floor is computed for the PRIMARY quantity, always. Comparing a playoff delta
      // against a floor derived from the title rate is comparing two different distributions.
      clearsNoise: best.playoffsPp > floor,
      ...bidFor(add.name, add.pos, best.playoffsPp),
      drops,
    });
  }
  targets.sort((a, b) => b.rankValue - a.rankValue);
  return {
    basePlayoffPct: r2(basePlayoff),
    basePlayoffWeekPts: r2(basePoPts),
    baseTitlePct: r2(baseTitle),
    noiseFloorPp: noiseFloorPp(basePlayoff, trials),
    targets,
    refused,
    poolRanking: {
      basis: missingReplacement.size === Object.keys(ctx.replacement).length ? "raw-projection" : "value-over-replacement",
      missingReplacement: [...missingReplacement].sort(),
    },
    unavailableAdds,
    faabBudget: budget,
    objective,
    assumptions: {
      ...assumptionsOf(ctx, "simulation", o, trials, seeds, objective),
      faab: {
        basis: usingModel ? "model" : "rule",
        artifact: usingModel ? artifact.path : null,
        builtAt: model?.builtAt ?? null,
        targetWinPct: Math.round(target * 1000) / 10,
        remaining, budget,
        // WHOSE RULES PRODUCED THE DOLLARS. A budget with no league beside it is the same trap as a
        // probability with no assumptions beside it.
        leagueId: o.leagueId ?? null,
        waivers: o.acquisition ? o.acquisition.waivers : null,
        processDays: o.acquisition ? [...o.acquisition.processDays] : null,
        week: live?.week ?? null,
        bidEffectSignificant: model ? model.bidEffect.significant : null,
        note: usingModel
          ? `${faabNote}. ${model!.bidEffect.note}.`
          : `${faabNote || "no fitted bid model in play"} -- every dollar figure below is the RULE OF THUMB.`,
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// TRADES
// ---------------------------------------------------------------------------------------------

export interface TradeOffer { give: string[]; get: string[] }
export interface TradeSide extends ObjectiveDelta {
  teamId: string; teamName: string;
  basePlayoffPct: number; afterPlayoffPct: number;
  baseTitlePct: number; afterTitlePct: number;
  legal: boolean; illegalWhy: string[];
}
export interface TradeCheckResult {
  offer: TradeOffer;
  us: TradeSide;
  them: TradeSide;
  noiseFloorPp: number;
  verdict: "good for us" | "bad for us" | "inside the noise floor";
  mutual: boolean;
  objective: Objective;
  assumptions: Assumptions;
}

function locate(teams: SeasonTeamInput[], name: string): { ti: number; p: SeasonTeamInput["roster"][number] } {
  const q = nameKey(name);
  for (let ti = 0; ti < teams.length; ti++) {
    const p = teams[ti].roster.find((x) => nameKey(x.name) === q) ?? teams[ti].roster.find((x) => nameKey(x.name).includes(q));
    if (p) return { ti, p };
  }
  throw new Error(`"${name}" is on nobody's roster in this league -- check the spelling.`);
}

/**
 * Score ONE named offer from both sides.
 *
 * BOTH SIDES, always, and not out of fairness. A proposal the other manager loses on is simply
 * rejected, so a deal that is a steal for us is worth nothing -- the only offers that matter are the
 * ones somebody would sign. Reporting his delta beside ours is what separates "this helps us" from
 * "this is proposable", and they are different questions.
 */
export function tradeCheck(ctx: SimContext, offer: TradeOffer, o: BaseOpts = {}): TradeCheckResult {
  const trials = o.trials ?? 1600;
  const seeds = o.seeds ?? [7, 101];
  if (!offer.give.length || !offer.get.length) throw new Error("a trade needs at least one player on each side");

  const give = offer.give.map((n) => {
    const hit = locate(ctx.teams, n);
    if (hit.ti !== ctx.meIdx) throw new Error(`"${n}" is not on OUR roster (he is on ${ctx.teams[hit.ti].name}) -- give/get are the wrong way round?`);
    return hit.p;
  });
  const gets = offer.get.map((n) => locate(ctx.teams, n));
  const partners = new Set(gets.map((g) => g.ti));
  if (partners.size !== 1) throw new Error(`the players asked for sit on ${partners.size} different rosters -- a trade has exactly one counterparty`);
  const ti = gets[0].ti;
  if (ti === ctx.meIdx) throw new Error("both sides of the offer are our own players");

  const apply = (teams: SeasonTeamInput[]): void => {
    const giveNames = new Set(give.map((p) => p.name));
    const getNames = new Set(gets.map((g) => g.p.name));
    teams[ctx.meIdx].roster = teams[ctx.meIdx].roster.filter((p) => !giveNames.has(p.name)).concat(gets.map((g) => ({ ...g.p })));
    teams[ti].roster = teams[ti].roster.filter((p) => !getNames.has(p.name)).concat(give.map((p) => ({ ...p })));
  };

  const probe = ctx.clone();
  apply(probe);
  // BOTH legality questions, on both sides. `rosterGaps` is the floor -- can the roster still field
  // a lineup. `rosterOverfills` is the ceiling -- does it now hold more of a position than the
  // league permits. A trade can pass the first and fail the second, and until `ff sync-settings`
  // existed nothing here could ask the second at all: the maximums are not in the mSettings API, so
  // the finder proposed moves the league would reject (2 of 95, measured).
  const usGaps = [...rosterGaps([probe[ctx.meIdx]], ctx.slots, ctx.flexOk), ...rosterOverfills([probe[ctx.meIdx]], ctx.posMax)];
  const themGaps = [...rosterGaps([probe[ti]], ctx.slots, ctx.flexOk), ...rosterOverfills([probe[ti]], ctx.posMax)];

  const baseUs: Outcome[] = [], baseThem: Outcome[] = [], afterUs: Outcome[] = [], afterThem: Outcome[] = [];
  for (const s of seeds) {
    // ONE simulation per (state, seed), read for both teams. Running it twice would give us and them
    // numbers from different samples of the same league, which is the correlation trap in miniature.
    const b = ctx.run(ctx.teams, trials, s, { playoffWeekStrength: true });
    const pull = (r: SeasonOdds): Outcome => ({ playoffPct: 100 * r.playoffs, titlePct: 100 * r.champion, poPts: r.playoffWeekPts });
    baseUs.push(pull(b[ctx.meIdx]));
    baseThem.push(pull(b[ti]));
    const teams = ctx.clone();
    apply(teams);
    const a = ctx.run(teams, trials, s, { playoffWeekStrength: true });
    afterUs.push(pull(a[ctx.meIdx]));
    afterThem.push(pull(a[ti]));
  }
  const objective = objectiveFor(mean(baseUs.map((x) => x.playoffPct)), o.secureThresholdPct);
  const dUs = deltasOf(afterUs, baseUs, objective);
  const dThem = deltasOf(afterThem, baseThem, objective);
  const floor = noiseFloorPp(mean(baseUs.map((x) => x.playoffPct)), trials);
  const side = (id: string, name: string, base: Outcome[], after: Outcome[], d: ObjectiveDelta, gaps: string[]): TradeSide => ({
    teamId: id, teamName: name,
    basePlayoffPct: r2(mean(base.map((x) => x.playoffPct))), afterPlayoffPct: r2(mean(after.map((x) => x.playoffPct))),
    baseTitlePct: r2(mean(base.map((x) => x.titlePct))), afterTitlePct: r2(mean(after.map((x) => x.titlePct))),
    ...d, legal: !gaps.length, illegalWhy: gaps,
  });
  return {
    offer,
    us: side(ctx.teams[ctx.meIdx].id, ctx.teams[ctx.meIdx].name, baseUs, afterUs, dUs, usGaps),
    them: side(ctx.teams[ti].id, ctx.teams[ti].name, baseThem, afterThem, dThem, themGaps),
    noiseFloorPp: floor,
    // The verdict is on the PRIMARY quantity. `them.playoffsPp` is what decides whether the other
    // manager signs, for the same reason: it is the number about his season that is predictable.
    verdict: dUs.playoffsPp > floor ? "good for us" : dUs.playoffsPp < -floor ? "bad for us" : "inside the noise floor",
    mutual: dUs.playoffsPp > floor && dThem.playoffsPp > floor,
    objective,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, seeds, objective),
  };
}

export interface TradeIdea extends ObjectiveDelta {
  give: string; givePos: string; giveValue: number;
  get: string; getPos: string; getValue: number;
  partnerId: string; partner: string;
  valueGap: number;
  usAfterPlayoffPct: number; usAfterTitlePct: number;
  themPlayoffsPp: number; themTitlePp: number;
  clearsNoise: boolean; mutual: boolean;
}
export interface TradeFinderResult {
  basePlayoffPct: number;
  baseTitlePct: number;
  noiseFloorPp: number;
  maxValueGap: number;
  candidates: number;
  skippedNoValue: number;
  /** Pairings skipped because one side cannot play, and who they were. Counted rather than silently
   *  dropped: "no balanced candidates" and "they were all hurt" are different answers. */
  skippedUnavailable: number;
  unavailableNames: string[];
  ideas: TradeIdea[];
  objective: Objective;
  assumptions: Assumptions;
}

/**
 * FIND one-for-ones worth proposing: BALANCED ON CONSENSUS VALUE, then scored by title odds.
 *
 * The ordering matters and the repo learned it the expensive way. An earlier finder filtered on the
 * partner's SIMULATED equity and produced "our WR4 for Christian McCaffrey" as a headline
 * recommendation -- it passes, because a team already at 1.4% has almost no equity left to lose and
 * the simulator shrugs. No human accepts that offer. A manager does not simulate his season; he
 * looks at what each side is worth on the consensus market and refuses anything lopsided. So
 * acceptability is gated FIRST on consensus value (`market_value`, the KeepTradeCut-style scale we
 * already ingest), symmetrically, and the simulator is used only for the question it is good at:
 * among deals both sides would sign, which ones actually help us.
 *
 * A genuine win-win needs nobody fooled. It comes from roster CONSTRUCTION -- six receivers for five
 * effective receiving slots and one back means our sixth receiver is worth almost nothing to us and a
 * mid-tier back a great deal, and a team in the opposite shape values them the other way round.
 */
export function tradeFinder(
  ctx: SimContext,
  o: BaseOpts & {
    values: Map<string, number>; maxGap?: number; limit?: number; positions?: string[];
    /**
     * WHO CANNOT PLAY -- the same map `lineupRecommend` takes, and needed here for the same reason
     * the waiver verb needed it: this loop paired every man on our roster against every man on
     * every other roster and never asked whether either could play. A man on injured reserve was
     * valued at his full consensus price on BOTH sides -- as something to acquire, and as something
     * to send away -- and the simulator then scored the resulting roster as though he would suit up.
     *
     * Excluded men are COUNTED, not silently skipped: "there were no balanced candidates" and "the
     * balanced candidates were all hurt" are different answers and must not print the same.
     * Absent, nothing is filtered and the verb behaves exactly as it did.
     */
    availability?: AvailabilityMap;
  },
): TradeFinderResult {
  const trials = o.trials ?? 1200;
  const seed = o.seed ?? 7;
  const maxGap = o.maxGap ?? 0.15;
  const limit = o.limit ?? 12;
  const val = (n: string): number | null => o.values.get(nameKey(n)) ?? null;

  const mine = ctx.teams[ctx.meIdx].roster;
  let skippedNoValue = 0;
  let skippedUnavailable = 0;
  const outNames = new Set<string>();
  const cannotPlay = (p: { name: string }): boolean => {
    if ((o.availability ?? ctx.week.availability).get(nameKey(p.name))?.status !== "OUT") return false;
    outNames.add(p.name);
    return true;
  };
  type Cand = { ti: number; give: SeasonTeamInput["roster"][number]; get: SeasonTeamInput["roster"][number]; gv: number; tv: number; gap: number };
  const cand: Cand[] = [];
  for (const give of mine) {
    const gv = val(give.name);
    if (gv == null) { skippedNoValue++; continue; }
    // Trading AWAY a man who cannot play is a real move, but the simulator cannot price it: it
    // scores the roster he leaves as though he had been playing. Excluded on both sides, counted.
    if (cannotPlay(give)) { skippedUnavailable++; continue; }
    for (let ti = 0; ti < ctx.teams.length; ti++) {
      if (ti === ctx.meIdx) continue;
      for (const get of ctx.teams[ti].roster) {
        const tv = val(get.name);
        if (tv == null) continue;
        if (cannotPlay(get)) { skippedUnavailable++; continue; }
        if (o.positions && !o.positions.includes(get.pos)) continue;
        const gap = Math.abs(tv - gv) / Math.max(tv, gv, 1);
        if (gap > maxGap) continue;
        const a = mine.filter((p) => p.name !== give.name).concat([get]);
        const b = ctx.teams[ti].roster.filter((p) => p.name !== get.name).concat([give]);
        const sides = [{ id: "a", name: "us", roster: a }, { id: "b", name: ctx.teams[ti].name, roster: b }];
        // Floor AND ceiling -- see tradeCheck. Skipping only the lineup check let through trades
        // that overfilled a position on the RECEIVING side, which is a move the league refuses.
        if (rosterGaps(sides, ctx.slots, ctx.flexOk).length) continue;
        if (rosterOverfills(sides, ctx.posMax).length) continue;
        cand.push({ ti, give, get, gv, tv, gap });
      }
    }
  }
  // A LINEUP PRE-SCREEN, so the trial budget goes on deals that could plausibly matter rather than
  // on 300 swaps of one bench receiver for another. It is a cheap ordering, not a verdict: the title
  // delta below is what decides, and it regularly disagrees with the points ordering.
  const lineupPts = (roster: SeasonTeamInput["roster"]): number =>
    optimalLineup(roster.map((p) => ({ ...p, available: true })), ctx.slots, ctx.flexOk).starters.reduce((a, s) => a + s.proj, 0);
  const mineBase = lineupPts(mine);
  const screened = cand
    .map((c) => ({ c, screen: lineupPts(mine.filter((p) => p.name !== c.give.name).concat([c.get])) - mineBase }))
    .sort((a, b) => b.screen - a.screen)
    .slice(0, limit)
    .map((x) => x.c);

  const baseOdds = ctx.run(ctx.teams, trials, seed, { playoffWeekStrength: true });
  const pull = (r: SeasonOdds): Outcome => ({ playoffPct: 100 * r.playoffs, titlePct: 100 * r.champion, poPts: r.playoffWeekPts });
  const baseUs = pull(baseOdds[ctx.meIdx]);
  const objective = objectiveFor(baseUs.playoffPct, o.secureThresholdPct);
  const floor = noiseFloorPp(baseUs.playoffPct, trials);
  const ideas: TradeIdea[] = screened.map((c) => {
    const teams = ctx.clone();
    teams[ctx.meIdx].roster = teams[ctx.meIdx].roster.filter((p) => p.name !== c.give.name).concat([{ ...c.get }]);
    teams[c.ti].roster = teams[c.ti].roster.filter((p) => p.name !== c.get.name).concat([{ ...c.give }]);
    const after = ctx.run(teams, trials, seed, { playoffWeekStrength: true });
    const d = deltasOf([pull(after[ctx.meIdx])], [baseUs], objective);
    const them = deltasOf([pull(after[c.ti])], [pull(baseOdds[c.ti])], objective);
    return {
      give: c.give.name, givePos: c.give.pos, giveValue: c.gv,
      get: c.get.name, getPos: c.get.pos, getValue: c.tv,
      partnerId: ctx.teams[c.ti].id, partner: ctx.teams[c.ti].name,
      valueGap: r3(c.gap),
      ...d,
      usAfterPlayoffPct: r2(baseUs.playoffPct + d.playoffsPp), usAfterTitlePct: r2(baseUs.titlePct + d.titlePp),
      themPlayoffsPp: them.playoffsPp, themTitlePp: them.titlePp,
      clearsNoise: d.playoffsPp > floor, mutual: d.playoffsPp > floor && them.playoffsPp > floor,
    };
  }).sort((a, b) => b.rankValue - a.rankValue);

  return {
    basePlayoffPct: r2(baseUs.playoffPct),
    baseTitlePct: r2(baseUs.titlePct),
    noiseFloorPp: floor,
    maxValueGap: maxGap,
    candidates: cand.length,
    skippedNoValue,
    skippedUnavailable,
    unavailableNames: [...outNames].sort(),
    ideas,
    objective,
    assumptions: assumptionsOf(ctx, "simulation", { ...o, seeds: [seed] }, trials, [seed], objective),
  };
}

// ---------------------------------------------------------------------------------------------
// HANDCUFFS
// ---------------------------------------------------------------------------------------------

export interface HandcuffResult {
  rows: (HandcuffRow & { ours: boolean; rostered: boolean })[];
  weeks: number; positions: string[];
  /** How many leads on the board were priced by the injury model rather than by their tier. Zero is
   *  a real answer (nobody is hurt, or no artifact is on file) and `assumptions.basisNote` says
   *  which of the two it was -- a count with no reason attached reads as an absence of injuries. */
  injuryPriced: number;
  injurySource: "archive" | "live" | "none";
  objective: Objective; assumptions: Assumptions;
}

/**
 * Rank every backup by what he scores IF the man ahead of him misses a week. The model and its three
 * rejected functional forms are documented in handcuff.ts; this attaches league context -- who is
 * already ours, and who is rostered anywhere -- the injury outlook, and the assumptions block.
 *
 * TRACK I: THE LEAD'S MISS RATE IS NO LONGER ONLY HIS TIER. `expectedPts` was `lift x missProb x
 * weeks` where `missProb` came from the variance model's per-tier games/17, which is the same 0.129
 * for every top-tier back whether he is healthy or has been Out for three weeks with a foot. For a
 * lead who is ON THE INJURY REPORT the next four games are now priced by
 * data/injury-duration-artifact.json and only the remainder stays on the tier rate. Both numbers
 * travel on the row (`leadGamesOutNext4` against `leadGamesOutNext4Tier`) so the change is visible
 * rather than asserted.
 */
export function handcuffs(
  ctx: SimContext,
  o: BaseOpts & {
    depth: DepthEntry[]; vm: VarianceModel; weeks?: number; positions?: string[];
    poolSize?: Record<string, number>; freeOnly?: boolean; ourPlayoffPct?: number;
    /** Injected by tests. Absent, it is loaded from the store for (ctx.season, the coming week). */
    outlook?: InjuryOutlookSet; week?: number; dbPath?: string;
  } = { depth: [], vm: { pos: {} } as VarianceModel },
): HandcuffResult {
  const weeks = o.weeks ?? NFL_WEEKS;
  const positions = o.positions ?? ["RB"];
  const ourNames = new Set(ctx.teams[ctx.meIdx].roster.map((p) => nameKey(p.name)));
  const outlook = o.outlook ?? injuryOutlookFor(ctx, o.week, o.dbPath);
  let rows = handcuffBoard(o.depth, o.vm, { weeks, positions, poolSize: o.poolSize, outlook })
    .map((r) => ({ ...r, ours: ourNames.has(nameKey(r.name)), rostered: ctx.ownedIds.has(nameKey(r.name)) }));
  if (o.freeOnly) rows = rows.filter((r) => !r.rostered);
  // HANDCUFFS ARE NOT SCORED IN PROBABILITY AND SAYING SO IS THE POINT. The ranking is a conditional
  // POINTS payoff -- what this man scores in the weeks the starter ahead of him misses -- and dressing
  // it up as a playoff delta would be inventing a simulation that was never run. The objective block
  // travels anyway, naming the regime, so a consumer can see which question the rows do NOT answer.
  const objective = objectiveFor(o.ourPlayoffPct ?? null, o.secureThresholdPct);
  const assumptions = assumptionsOf(ctx, "projection", o, null, null, objective);
  const priced = rows.filter((r) => r.missSource === "injury-model").length;
  assumptions.basisNote =
    `A backup's payoff is a conditional POINTS quantity, not a probability. The lead's miss rate ` +
    `over ${weeks} weeks is ${priced ? `the injury model for ${priced} of ${rows.length} rows and ` : ""}` +
    `the variance model's per-tier availability otherwise. ${outlook.note}`;
  return {
    rows, weeks, positions, injuryPriced: priced, injurySource: outlook.source,
    objective, assumptions,
  };
}

/**
 * The injury outlook for the week a decision is being made about, loaded from the store.
 *
 * A FAILURE TO LOAD IS NOT A FAILURE OF THE VERB. The store may have no artifact, no injury table
 * and no live status feed, and a handcuff board is still a useful answer with the tier rate in it.
 * So this degrades to an EMPTY set carrying its own reason, which `assumptions.basisNote` prints --
 * the opposite of `opportunity-model.json`, whose absence silently made every factor 1.0.
 */
function injuryOutlookFor(ctx: SimContext, week?: number, dbPath?: string): InjuryOutlookSet {
  try {
    return loadInjuryOutlook({ dbPath, season: ctx.season, week });
  } catch (e) {
    return {
      artifactPresent: false, source: "none", asOf: null, byName: new Map(),
      tierMissProb: () => 0.13,
      note: `the injury horizon could not be read (${(e as Error).message}) -- every miss ` +
        `probability below is the variance model's per-tier season availability.`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// DEPTH RISK
// ---------------------------------------------------------------------------------------------

export interface DepthRiskResult {
  player: { name: string; pos: string; proj: number };
  basePlayoffPct: number;
  withoutPlayoffPct: number;
  baseTitlePct: number;
  withoutTitlePct: number;
  /** POSITIVE = percentage points of PLAYOFF probability we lose if he is gone for the season. This
   *  was quoted in title probability until Phase 3; the sign convention is unchanged and the
   *  quantity is now the one the simulator has measured skill on. */
  costPp: number;
  /** POSITIVE = expected optimal-lineup points we lose in the league PLAYOFF WEEKS (weeks 14-16 under the current format block) without him. */
  costPlayoffWeekPts: number;
  /** POSITIVE = percentage points of TITLE probability, reported alongside, never used alone. */
  costTitlePp: number;
  /** Sampling error across SEEDS. Null when only one seed was run -- see `pairedDelta`: a single
   *  sample has no measurable spread, and 0 would read as certainty. */
  se: number | null;
  noiseFloorPp: number;
  insurance: { name: string; pos: string; proj: number; from: string; free: boolean; recoversPp: number; recoversPlayoffWeekPts: number; recoversTitlePp: number }[];
  /**
   * HOW LONG HE IS ACTUALLY LIKELY TO BE OUT, which is a different question from every other number
   * on this result. The four probabilities and the costs above all price "gone for the season" --
   * a well-defined worst case and the right frame for "who insures him". This block prices the
   * absence we are actually facing, and its `source` says on what evidence.
   *
   * `tierGamesOut4` is what this repo said before Track I: the variance model's per-tier games/17
   * for his rank bucket, times four. It is carried BESIDE the model's number rather than replaced
   * by it, because a consumer that cannot see both has no way to tell an improvement from a change.
   */
  horizon: {
    source: "injury-model" | "tier-rate";
    /** null when he is not on any injury report -- which is itself the answer, not a missing value. */
    designation: string | null;
    injury: string | null;
    evidence: "archive" | "live" | "none";
    /** P(he misses the next k games), k = 1..4. Empty on the tier-rate path. */
    pMiss: Record<string, number>;
    expectedGamesOut4: number;
    tierGamesOut4: number;
    /** What the DESIGNATION ALONE would have said over the same four games, from the baseline the
     *  artifact carries. Null where no artifact is on file. */
    designationOnlyGamesOut4: number | null;
    /** The cost above, pro-rated to the absence we expect rather than to a season-long one:
     *  (playoff-week points lost without him / playoff weeks) x expectedGamesOut4. It is a POINTS
     *  quantity and is not a probability -- see `assumptions.basis`. */
    expectedCostNext4Pts: number;
  };
  objective: Objective;
  assumptions: Assumptions;
}

/**
 * What does losing ONE player actually cost us, and who insures him?
 *
 * A trade finder ranked on marginal points is structurally blind to CONCENTRATION: it prices a
 * backup at what he adds to a HEALTHY lineup, which is usually zero, so it cannot see that a slot
 * has exactly one eligible body. Both questions are asked here in the same unit -- title probability
 * with him, without him, and with each candidate replacement standing in for him.
 */
export function depthRisk(
  ctx: SimContext,
  player: string,
  o: BaseOpts & { insurers?: number; outlook?: InjuryOutlookSet; week?: number; dbPath?: string } = {},
): DepthRiskResult {
  const trials = o.trials ?? 1200;
  const seeds = o.seeds ?? [7, 101];
  const nIns = o.insurers ?? 5;
  const hit = locate(ctx.teams, player);
  if (hit.ti !== ctx.meIdx) throw new Error(`"${player}" is not on our roster -- he is on ${ctx.teams[hit.ti].name}.`);
  const at = hit.p;

  const withoutOf = (teams: SeasonTeamInput[]) => teams[ctx.meIdx].roster.filter((p) => p.name !== at.name);
  const baseBySeed: Outcome[] = [], outBySeed: Outcome[] = [];
  for (const s of seeds) {
    baseBySeed.push(outcomeOf(ctx, ctx.teams, trials, s));
    const t = ctx.clone();
    t[ctx.meIdx].roster = withoutOf(t);
    outBySeed.push(outcomeOf(ctx, t, trials, s));
  }
  const objective = objectiveFor(mean(baseBySeed.map((x) => x.playoffPct)), o.secureThresholdPct);
  // base MINUS without, so the headline number reads as a COST: positive means we are worse off
  // without him. Reporting the raw delta here has bitten before -- a negative "cost" is read as a
  // benefit by anything skimming the field name.
  const cost = deltasOf(baseBySeed, outBySeed, objective);

  // Everyone at his position who could stand in. FREE AGENTS AND ROSTERED PLAYERS ARE SHORTLISTED
  // SEPARATELY and then merged, rather than ranked together on projection. A pure projection sort
  // fills the list with the best fifteen starters in the league and never shows a single waiver
  // option, because in a 16-team league every rostered starter out-projects every free agent -- and
  // "trade for one of these fifteen men nobody will give you" is not an answer to "my back is hurt".
  // A claim is cheaper than a trade, so the cheap options get their own slots on the shortlist.
  const byProj = <T extends { proj: number }>(a: T, b: T) => b.proj - a.proj;
  const half = Math.max(1, Math.floor(nIns / 2));
  const freeCands = [...ctx.board.entries()].filter(([id, p]) => !ctx.ownedIds.has(id) && p.pos === at.pos)
    .map(([, p]) => ({ ...p, from: "free agent", free: true })).sort(byProj).slice(0, half);
  const rosteredCands = ctx.teams.flatMap((t, i) => i === ctx.meIdx ? [] : t.roster.filter((p) => p.pos === at.pos).map((p) => ({ ...p, from: t.name, free: false })))
    .sort(byProj).slice(0, nIns - freeCands.length);
  const pool = [...freeCands, ...rosteredCands];

  const insurance = pool.map((r) => {
    const after = seeds.map((s) => {
      const t = ctx.clone();
      t[ctx.meIdx].roster = withoutOf(t).concat([{ name: r.name, pos: r.pos, proj: r.proj, team: r.team, bye: null }]);
      return outcomeOf(ctx, t, trials, s);
    });
    const d = deltasOf(after, outBySeed, objective);
    return {
      name: r.name, pos: r.pos, proj: r2(r.proj), from: r.from, free: r.free,
      recoversPp: d.playoffsPp, recoversPlayoffWeekPts: d.playoffWeekPts, recoversTitlePp: d.titlePp,
      rankValue: d.rankValue,
    };
  }).sort((a, b) => b.rankValue - a.rankValue).map(({ rankValue, ...rest }) => { void rankValue; return rest; });

  // ---- TRACK I: HOW LONG IS HE ACTUALLY OUT? ----------------------------------------------
  // The pool-rank fraction is derived from the BOARD -- his rank among all players at his position
  // by projection, over the size of that pool -- which is the same quantity the handcuff board and
  // rosterValue pass to their tier lookup. Derived rather than passed in, because a caller that
  // forgot it would silently get tier 0 (the most durable bucket) for everybody.
  const outlook = o.outlook ?? injuryOutlookFor(ctx, o.week, o.dbPath);
  const samePos = [...ctx.board.values()].filter((p) => p.pos === at.pos).sort((a, b) => b.proj - a.proj);
  const idx = samePos.findIndex((p) => nameKey(p.name) === nameKey(at.name));
  const frac = samePos.length ? Math.max(0, idx) / samePos.length : 0;
  const tierPerWeek = outlook.tierMissProb(at.pos, frac);
  const ol = outlook.byName.get(nameKey(at.name)) ?? null;
  // The league's own playoff weeks, from the format block WITH its provenance -- never a literal 3.
  // A context built without a format block (a fixture) falls back to the count the block would have
  // held for this league, stated here rather than silently dividing by an undefined.
  const playoffWeeks = Math.max(1, ctx.format?.playoffWeeks?.length ?? 3);
  const perWeekPts = cost.playoffWeekPts / playoffWeeks;
  const expectedGamesOut4 = ol ? ol.expectedGamesOut4 : tierPerWeek * 4;
  const horizon: DepthRiskResult["horizon"] = {
    source: ol ? "injury-model" : "tier-rate",
    designation: ol ? (ol.designation || "(on the report, no designation)") : null,
    injury: ol ? (ol.detail || ol.injuryGroup || null) : null,
    evidence: outlook.source,
    pMiss: ol ? { "1": r3(ol.p[1]), "2": r3(ol.p[2]), "3": r3(ol.p[3]), "4": r3(ol.p[4]) } : {},
    expectedGamesOut4: r2(expectedGamesOut4),
    tierGamesOut4: r2(tierPerWeek * 4),
    designationOnlyGamesOut4: ol?.baselineExpectedGamesOut4 != null ? r2(ol.baselineExpectedGamesOut4) : null,
    expectedCostNext4Pts: r2(perWeekPts * expectedGamesOut4),
  };

  const assumptions = assumptionsOf(ctx, "simulation", o, trials, seeds, objective);
  assumptions.basisNote =
    `costPp / costPlayoffWeekPts / costTitlePp all price him GONE FOR THE SEASON, which is the frame ` +
    `the insurance shortlist needs. \`horizon\` prices the absence actually in front of us and is a ` +
    `POINTS quantity, not a probability. ${ol
      ? `He is on the report (${horizon.designation}${horizon.injury ? ", " + horizon.injury : ""}): ` +
        `the injury model expects ${horizon.expectedGamesOut4} of the next four games missed against ` +
        `${horizon.tierGamesOut4} from the per-tier rate this repo used before Track I` +
        (horizon.designationOnlyGamesOut4 != null ? ` and ${horizon.designationOnlyGamesOut4} from the designation alone` : "") + ". "
      : `He is on no injury report, so the horizon falls back to the per-tier rate -- which is what ` +
        `it is for. `}${outlook.note}`;

  return {
    player: { name: at.name, pos: at.pos, proj: r2(at.proj) },
    basePlayoffPct: r2(mean(baseBySeed.map((x) => x.playoffPct))),
    withoutPlayoffPct: r2(mean(outBySeed.map((x) => x.playoffPct))),
    baseTitlePct: r2(mean(baseBySeed.map((x) => x.titlePct))),
    withoutTitlePct: r2(mean(outBySeed.map((x) => x.titlePct))),
    costPp: cost.playoffsPp,
    costPlayoffWeekPts: cost.playoffWeekPts,
    costTitlePp: cost.titlePp,
    se: cost.se,
    noiseFloorPp: noiseFloorPp(mean(baseBySeed.map((x) => x.playoffPct)), trials),
    insurance,
    horizon,
    objective,
    assumptions,
  };
}

// ---------------------------------------------------------------------------------------------
// POWER RANKINGS
// ---------------------------------------------------------------------------------------------

export interface PowerRow {
  rank: number; teamId: string; team: string; us: boolean;
  startPts: number; byPos: Record<string, number>;
  playoffPct: number; titlePct: number;
}
export interface PowerResult { rows: PowerRow[]; leagueMeanStartPts: number; ourRank: number; objective: Objective; assumptions: Assumptions }

/**
 * Rank the league by best starting lineup on OUR projections, with each team's simulated odds beside
 * it.
 *
 * HONEST FRAMING, and it bounds everything below: this ranks teams by OUR board -- the same numbers
 * we bid from -- so it is not an independent grade of our own roster. If our projection is wrong
 * about a player it is wrong here the same way. Read the SPREAD between teams rather than any single
 * absolute. The odds column is the same run `season_odds` returns, so the two can never disagree.
 */
export function powerRankings(ctx: SimContext, o: BaseOpts = {}): PowerResult {
  const trials = o.trials ?? 2000;
  const seed = o.seed ?? 7;
  const odds = ctx.run(ctx.teams, trials, seed);
  const rows = ctx.teams.map((t, i) => {
    const starters = optimalLineup(t.roster.map((p) => ({ ...p, available: true })), ctx.slots, ctx.flexOk).starters;
    const byPos: Record<string, number> = {};
    for (const p of t.roster) byPos[p.pos] = (byPos[p.pos] ?? 0) + 1;
    return {
      rank: 0, teamId: t.id, team: t.name, us: i === ctx.meIdx,
      startPts: Math.round(starters.reduce((a, s) => a + s.proj, 0)),
      byPos,
      playoffPct: r2(100 * odds[i].playoffs),
      titlePct: r2(100 * odds[i].champion),
    };
  }).sort((a, b) => b.startPts - a.startPts);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const objective = objectiveFor(100 * odds[ctx.meIdx].playoffs, o.secureThresholdPct);
  return {
    rows,
    leagueMeanStartPts: Math.round(mean(rows.map((r) => r.startPts))),
    ourRank: rows.findIndex((r) => r.us) + 1,
    objective,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, [seed], objective),
  };
}

// ---------------------------------------------------------------------------------------------
// PLAYOFF STRENGTH OF SCHEDULE
// ---------------------------------------------------------------------------------------------

export interface GameRow { week: number; team: string; opponent: string; home: number | boolean; spread_line: number | null }
export interface SosPlayerRow { name: string; pos: string; nflTeam: string | null; sos: number | null; rank: number | null; seasonProj: number; costPerWeek: number | null }
export interface SosResult {
  playoffWeeks: number[];
  ratings: { team: string; rating: number }[];
  teamSos: { team: string; sos: number; rank: number; opponents: { week: number; opponent: string; rating: number; home: boolean; priced: boolean }[] }[];
  players: SosPlayerRow[];
  pricedPlayoffGames: number;
  playoffGames: number;
  ptsPerSpread: Record<string, number>;
  objective: Objective;
  assumptions: Assumptions;
}

/** Fantasy points lost per point of harder opponent, per position. MEASURED (tools/spread_to_points.py:
 *  each team's feature player at each position, 2023-25, n=1632 per position, regressed on the team's
 *  own spread), not assumed -- an earlier draft guessed 0.7 for every position and overstated the
 *  real QB figure by 2x and the TE figure by 8x. */
export const PTS_PER_SPREAD: Record<string, number> = { QB: 0.308, RB: 0.271, WR: 0.161, TE: 0.087 };
const HOME_EDGE = 1.0;

/**
 * Market-implied team ratings, solved from the posted lines as a SIMULTANEOUS SYSTEM.
 *
 * A team's average spread is confounded by whom it happened to play; this is not. For each priced
 * game the market's expected margin for `team` is -spread_line, which should equal
 * rating(team) - rating(opponent) + home edge. Iterate to a fixed point and centre so 0 is average.
 *
 * WHY NOT defense-vs-position, which is the obvious build: we measured whether prior-year DvP carries
 * year to year (tools/verify_dvp_signal.py) and it does not -- r = +0.07 QB, +0.19 RB, +0.01 WR,
 * +0.11 TE across 64 team-season pairs against a standard error of ~0.125. The same pipeline recovers
 * r = +0.32 for team OFFENSE, so it can see persistence when there is any to see.
 */
export function marketRatings(games: GameRow[]): Map<string, number> {
  const withLine = games.filter((g) => g.spread_line != null);
  const teams = [...new Set(games.map((g) => g.team))].sort();
  const rating = new Map<string, number>(teams.map((t) => [t, 0]));
  for (let iter = 0; iter < 200; iter++) {
    const next = new Map<string, number>();
    for (const t of teams) {
      const mineG = withLine.filter((g) => g.team === t);
      if (!mineG.length) { next.set(t, rating.get(t) ?? 0); continue; }
      const est = mineG.map((g) => (-(g.spread_line as number)) + (rating.get(g.opponent) ?? 0) - HOME_EDGE * (g.home ? 1 : -1));
      next.set(t, mean(est));
    }
    const m = mean([...next.values()]);
    for (const [t, v] of next) rating.set(t, v - m);
  }
  return rating;
}

/**
 * Playoff strength of schedule for our roster (or any named players).
 *
 * HONEST LIMITS, because the number is small and easy to over-read: ratings come from the lines
 * posted so far and cannot know a November injury, and the fantasy conversion is under a point a
 * week for a typical starter. It breaks ties between comparable players; it does not overturn a
 * projection gap. Compare `costPerWeek` against the season projection gap before acting on it.
 */
export function playoffSos(
  ctx: SimContext,
  o: BaseOpts & { games: GameRow[]; regWeeks?: number; nflWeeks?: number; teamOf?: Map<string, string>; players?: { name: string; pos: string; proj: number }[]; ourPlayoffPct?: number },
): SosResult {
  // Playoff SOS is a MARKET quantity with no simulation behind it, so it has no delta to rank; the
  // objective block travels naming the regime, because a reader in the secure regime should be
  // weighting these weeks more heavily and one in the insecure regime should barely be reading them.
  const objective = objectiveFor(o.ourPlayoffPct ?? null, o.secureThresholdPct);
  // THE BRACKET WEEKS COME FROM THE FORMAT BLOCK, not from `regWeeks + 1 .. 17`.
  //
  // That derivation is right only when the bracket happens to run to the end of the NFL season, and
  // it stopped being right the moment this league went back to 13 regular weeks: it produces FOUR
  // playoff weeks (14, 15, 16, 17) where ESPN's own settings say three (14/15/16). A fourth week of
  // opponent strength averaged into a three-week bracket is not a small error -- week 17 is the week
  // resting starters makes every rating meaningless, and it would have been silently included.
  //
  // `o.regWeeks`/`o.nflWeeks` remain, for a caller deliberately asking a hypothetical.
  const regWeeks = o.regWeeks ?? ctx.format.regWeeks;
  const nflWeeks = o.nflWeeks ?? NFL_WEEKS;
  const playoffWeeks: number[] = (o.regWeeks == null && o.nflWeeks == null)
    ? [...ctx.format.playoffWeeks]
    : (() => { const out: number[] = []; for (let w = regWeeks + 1; w <= nflWeeks; w++) out.push(w); return out; })();

  const rating = marketRatings(o.games);
  const teamSos: SosResult["teamSos"] = [];
  for (const t of [...new Set(o.games.map((g) => g.team))].sort()) {
    const wk = o.games.filter((g) => g.team === t && playoffWeeks.includes(g.week));
    if (!wk.length) continue;
    const opponents = wk.map((g) => ({ week: g.week, opponent: g.opponent, rating: r2(rating.get(g.opponent) ?? 0), home: !!g.home, priced: g.spread_line != null }));
    teamSos.push({ team: t, sos: r2(mean(opponents.map((x) => x.rating))), rank: 0, opponents });
  }
  teamSos.sort((a, b) => a.sos - b.sos);            // easiest first
  teamSos.forEach((r, i) => { r.rank = i + 1; });
  const rankOf = new Map(teamSos.map((r) => [r.team, r.rank]));
  const sosOf = new Map(teamSos.map((r) => [r.team, r.sos]));

  const who = o.players ?? ctx.teams[ctx.meIdx].roster.map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, team: p.team }));
  const players: SosPlayerRow[] = who.map((p) => {
    const nfl = (p as { team?: string }).team || o.teamOf?.get(nameKey(p.name)) || null;
    const sos = nfl ? sosOf.get(nfl) ?? null : null;
    const slope = PTS_PER_SPREAD[p.pos];
    return {
      name: p.name, pos: p.pos, nflTeam: nfl,
      sos: sos ?? null, rank: nfl ? rankOf.get(nfl) ?? null : null,
      seasonProj: Math.round(p.proj),
      costPerWeek: sos != null && slope != null ? r2(sos * slope) : null,
    };
  }).sort((a, b) => (a.sos ?? 99) - (b.sos ?? 99));

  return {
    playoffWeeks,
    ratings: [...rating.entries()].map(([team, r]) => ({ team, rating: r2(r) })).sort((a, b) => b.rating - a.rating),
    teamSos,
    players,
    pricedPlayoffGames: o.games.filter((g) => playoffWeeks.includes(g.week) && g.spread_line != null).length,
    playoffGames: o.games.filter((g) => playoffWeeks.includes(g.week)).length,
    ptsPerSpread: PTS_PER_SPREAD,
    objective,
    assumptions: assumptionsOf(ctx, "market", o, null, null, objective),
  };
}
