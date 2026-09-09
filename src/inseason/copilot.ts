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
import { handcuffBoard, type DepthEntry, type HandcuffRow } from "./handcuff.js";
import { rosterGaps, type SeasonTeamInput, type SeasonOdds, type VarianceModel } from "../draft/season.js";
import { nameKey } from "../draft/values.js";
import type { SimContext } from "../draft/simContext.js";

/** NFL weeks a season projection is spread over. Season projections in the board are FULL-SEASON
 *  totals; every weekly quantity below divides by this, and says so in `assumptions.basis`. */
export const NFL_WEEKS = 17;

// ---------------------------------------------------------------------------------------------
// ASSUMPTIONS -- the thing that travels with every number.
// ---------------------------------------------------------------------------------------------

/** What data produced an answer. Filled by `loadProvenance` (copilotStore.ts) where a store is
 *  available; the pure default below carries only what the context itself knows. */
export interface Provenance {
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
}

export function defaultProvenance(ctx: SimContext): Provenance {
  return { season: ctx.season, boardRows: ctx.board.size, varianceSeasons: null, sampler: "bootstrap", projectionArtifact: null };
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
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

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

export type AvailabilityStatus = "OUT" | "QUESTIONABLE" | "ACTIVE";
export interface AvailabilityEntry { status: AvailabilityStatus; source: string; detail?: string }
/** name_key -> what the store says about him this week. Built by `loadAvailability`. */
export type AvailabilityMap = Map<string, AvailabilityEntry>;

/** Statuses that make a man UNSTARTABLE. QUESTIONABLE deliberately does not: he plays more often
 *  than not, and benching every questionable starter costs more than the occasional zero. */
const OUT_STATUSES = new Set(["OUT", "IR", "PUP", "NFI", "SUSPENSION", "DNR", "DOUBTFUL"]);

export function normalizeStatus(raw: string | null | undefined): AvailabilityStatus {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return "ACTIVE";
  if (OUT_STATUSES.has(s)) return "OUT";
  if (s === "QUESTIONABLE") return "QUESTIONABLE";
  return "ACTIVE";
}

export interface LineupPlayer { slot?: string; name: string; pos: string; proj: number; available: boolean; reason: string }
export interface LineupResultJson {
  week: number;
  starters: { slot: string; name: string; pos: string; proj: number }[];
  bench: LineupPlayer[];
  unavailable: { name: string; pos: string; reason: string }[];
  totalProj: number;
  flags: string[];
  assumptions: Assumptions;
}

/**
 * WHY A STARTER MAY NOT BE STARTED, resolved once so the guard and the optimizer read the same rule.
 * Returns null when he is startable.
 */
export function unavailableReason(
  p: { name: string; pos: string; bye?: number | null },
  week: number,
  availability: AvailabilityMap,
): string | null {
  if (p.bye != null && Number(p.bye) === week) return `bye week ${week}`;
  const a = availability.get(nameKey(p.name));
  if (a && a.status === "OUT") return `${a.detail ? `OUT (${a.detail})` : "OUT"} -- ${a.source}`;
  return null;
}

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
    const p = roster.find((x) => x.name === s.name);
    if (!p) continue;
    const why = unavailableReason(p, week, availability);
    if (why) bad.push(`${s.name} -- ${why}`);
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
 *  would quietly send half a roster down the fallback path and report it as a weekly projection. */
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
  } = {},
): LineupResultJson {
  const availability = o.availability ?? new Map<string, AvailabilityEntry>();
  const perWeek = o.weeklyPoints ?? NFL_WEEKS;
  const roster = ctx.teams[ctx.meIdx].roster;
  const unavailable: LineupResultJson["unavailable"] = [];
  const fellBack: string[] = [];
  let fromWeekly = 0;
  const players = roster.map((p) => {
    const why = unavailableReason(p, week, availability);
    if (why) unavailable.push({ name: p.name, pos: p.pos, reason: why });
    const wk = o.weekly?.get(lineupNameKey(p.name));
    if (o.weekly) { if (wk != null && Number.isFinite(wk)) fromWeekly++; else fellBack.push(p.name); }
    const pts = wk != null && Number.isFinite(wk) ? wk : p.proj / perWeek;
    return { name: p.name, pos: p.pos, proj: r2(pts), available: why == null, reason: why ?? "available" };
  });
  const res = optimalLineup(players, ctx.slots, ctx.flexOk);
  assertStartersAvailable(res.starters, roster, week, availability);
  const reasonOf = new Map(players.map((p) => [p.name, p.reason]));

  const allWeekly = o.weekly != null && fellBack.length === 0;
  // A weekly lineup has no objective to trade off -- you start the best legal eleven, and that is the
  // same answer whichever regime we are in. The objective block still travels, with the regime
  // unknown, so a consumer never has to wonder whether it was omitted or forgotten.
  const assumptions = assumptionsOf(ctx, allWeekly ? "weekly-model" : "projection", o, null, null, objectiveFor(null));
  assumptions.basisNote = o.weekly == null
    ? `no weekly projector was supplied: every point total is the season projection divided by ${perWeek}, which has no matchup, no recent form and no weather in it`
    : allWeekly
      ? `every point total is from the weekly projector (src/weekly/projector.ts) for week ${week}`
      : `${fromWeekly} of ${roster.length} point totals are from the weekly projector for week ${week}; ` +
        `${fellBack.length} fell back to the season projection divided by ${perWeek} because the projector had no row for them: ${fellBack.join(", ")}`;

  return {
    week,
    starters: res.starters.map((s) => ({ ...s, proj: r2(s.proj) })),
    bench: res.bench.map((b) => ({ ...b, proj: r2(b.proj), reason: reasonOf.get(b.name) ?? "available" })),
    unavailable,
    totalProj: r2(res.totalProj),
    flags: res.flags,
    assumptions,
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
  const availability = o.availability ?? new Map<string, AvailabilityEntry>();
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
      const gaps = rosterGaps([{ id: "us", name: "us", roster: after }], ctx.slots, ctx.flexOk);
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
function pairedDelta(perSeed: number[]): { delta: number; se: number } {
  return { delta: r2(mean(perSeed)), se: r2(sd(perSeed) / Math.sqrt(Math.max(1, perSeed.length))) };
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
  se: number;
}
export interface WaiverDrop extends ObjectiveDelta { name: string; pos: string; proj: number }
export interface WaiverRefusal { add: string; drop: string; pos: string; why: string }
export interface WaiverTarget extends ObjectiveDelta {
  add: string; pos: string; proj: number;
  drop: string; dropPos: string;
  afterPlayoffPct: number;
  afterTitlePct: number;
  clearsNoise: boolean;
  faab: number; faabRule: string;
  drops: WaiverDrop[];
}
export interface WaiverResult {
  basePlayoffPct: number;
  basePlayoffWeekPts: number;
  baseTitlePct: number;
  noiseFloorPp: number;
  targets: WaiverTarget[];
  refused: WaiverRefusal[];
  faabBudget: number;
  objective: Objective;
  assumptions: Assumptions;
}

/**
 * FAAB GUIDANCE IS A STATED RULE, NOT A MEASUREMENT -- and it is labelled as such on every row.
 *
 * Nothing in this repo has measured what a percentage point of championship probability is worth in
 * FAAB dollars; there is no historical bid data to fit it on. Returning a bare number anyway would
 * be exactly the failure this module exists to prevent, so the rule travels with the number: ten
 * percent of the budget per point of title probability, capped at half the budget. It is a way to
 * turn a ranking into a bid, not a valuation.
 */
export const FAAB_RULE = "10% of budget per +1pp of PLAYOFF probability, capped at 50% -- a stated rule of thumb, not a fitted value. It was quoted against title probability until Phase 3; the rule is unchanged, the quantity it is applied to is the one the simulator can actually predict.";
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
  o: BaseOpts & { adds?: number; dropsPerAdd?: number; faabBudget?: number; positions?: string[] } = {},
): WaiverResult {
  const trials = o.trials ?? 800;
  const seeds = o.seeds ?? [7, 101];
  const nAdds = o.adds ?? 5;
  const nDrops = o.dropsPerAdd ?? 4;
  const budget = o.faabBudget ?? 100;

  const free = [...ctx.board.entries()]
    .filter(([id]) => !ctx.ownedIds.has(id))
    .map(([, p]) => p)
    .filter((p) => (o.positions ? o.positions.includes(p.pos) : true))
    .sort((a, b) => b.proj - a.proj)
    .slice(0, nAdds);

  const baseBySeed = seeds.map((s) => outcomeOf(ctx, ctx.teams, trials, s));
  const basePlayoff = mean(baseBySeed.map((b) => b.playoffPct));
  const baseTitle = mean(baseBySeed.map((b) => b.titlePct));
  const basePoPts = mean(baseBySeed.map((b) => b.poPts));
  const objective = objectiveFor(basePlayoff, o.secureThresholdPct);
  const mine = ctx.teams[ctx.meIdx].roster;
  const refused: WaiverRefusal[] = [];
  const targets: WaiverTarget[] = [];

  for (const add of free) {
    // Cheapest first: the lowest-projection bodies are the real drop candidates, and evaluating all
    // twelve against five adds is minutes of simulation for rows nobody reads.
    const candidates = [...mine].sort((a, b) => a.proj - b.proj).slice(0, Math.max(1, nDrops) + 3);
    const drops: WaiverDrop[] = [];
    for (const cand of candidates) {
      if (drops.length >= nDrops) break;
      const probe = ctx.clone();
      probe[ctx.meIdx].roster = probe[ctx.meIdx].roster.filter((p) => p.name !== cand.name).concat([{ ...add }]);
      const gaps = rosterGaps([probe[ctx.meIdx]], ctx.slots, ctx.flexOk);
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
      faab: faabFor(best.playoffsPp, budget), faabRule: FAAB_RULE,
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
    faabBudget: budget,
    objective,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, seeds, objective),
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
  const usGaps = rosterGaps([probe[ctx.meIdx]], ctx.slots, ctx.flexOk);
  const themGaps = rosterGaps([probe[ti]], ctx.slots, ctx.flexOk);

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
  o: BaseOpts & { values: Map<string, number>; maxGap?: number; limit?: number; positions?: string[] },
): TradeFinderResult {
  const trials = o.trials ?? 1200;
  const seed = o.seed ?? 7;
  const maxGap = o.maxGap ?? 0.15;
  const limit = o.limit ?? 12;
  const val = (n: string): number | null => o.values.get(nameKey(n)) ?? null;

  const mine = ctx.teams[ctx.meIdx].roster;
  let skippedNoValue = 0;
  type Cand = { ti: number; give: SeasonTeamInput["roster"][number]; get: SeasonTeamInput["roster"][number]; gv: number; tv: number; gap: number };
  const cand: Cand[] = [];
  for (const give of mine) {
    const gv = val(give.name);
    if (gv == null) { skippedNoValue++; continue; }
    for (let ti = 0; ti < ctx.teams.length; ti++) {
      if (ti === ctx.meIdx) continue;
      for (const get of ctx.teams[ti].roster) {
        const tv = val(get.name);
        if (tv == null) continue;
        if (o.positions && !o.positions.includes(get.pos)) continue;
        const gap = Math.abs(tv - gv) / Math.max(tv, gv, 1);
        if (gap > maxGap) continue;
        const a = mine.filter((p) => p.name !== give.name).concat([get]);
        const b = ctx.teams[ti].roster.filter((p) => p.name !== get.name).concat([give]);
        if (rosterGaps([{ id: "a", name: "us", roster: a }, { id: "b", name: ctx.teams[ti].name, roster: b }], ctx.slots, ctx.flexOk).length) continue;
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
    ideas,
    objective,
    assumptions: assumptionsOf(ctx, "simulation", { ...o, seeds: [seed] }, trials, [seed], objective),
  };
}

// ---------------------------------------------------------------------------------------------
// HANDCUFFS
// ---------------------------------------------------------------------------------------------

export interface HandcuffResult { rows: (HandcuffRow & { ours: boolean; rostered: boolean })[]; weeks: number; positions: string[]; objective: Objective; assumptions: Assumptions }

/** Rank every backup by what he scores IF the man ahead of him misses a week. The model and its
 *  three rejected functional forms are documented in handcuff.ts; this only attaches league context
 *  -- who is already ours, and who is rostered anywhere -- and the assumptions block. */
export function handcuffs(
  ctx: SimContext,
  o: BaseOpts & { depth: DepthEntry[]; vm: VarianceModel; weeks?: number; positions?: string[]; poolSize?: Record<string, number>; freeOnly?: boolean; ourPlayoffPct?: number } = { depth: [], vm: { pos: {} } as VarianceModel },
): HandcuffResult {
  const weeks = o.weeks ?? NFL_WEEKS;
  const positions = o.positions ?? ["RB"];
  const ourNames = new Set(ctx.teams[ctx.meIdx].roster.map((p) => nameKey(p.name)));
  let rows = handcuffBoard(o.depth, o.vm, { weeks, positions, poolSize: o.poolSize })
    .map((r) => ({ ...r, ours: ourNames.has(nameKey(r.name)), rostered: ctx.ownedIds.has(nameKey(r.name)) }));
  if (o.freeOnly) rows = rows.filter((r) => !r.rostered);
  // HANDCUFFS ARE NOT SCORED IN PROBABILITY AND SAYING SO IS THE POINT. The ranking is a conditional
  // POINTS payoff -- what this man scores in the weeks the starter ahead of him misses -- and dressing
  // it up as a playoff delta would be inventing a simulation that was never run. The objective block
  // travels anyway, naming the regime, so a consumer can see which question the rows do NOT answer.
  const objective = objectiveFor(o.ourPlayoffPct ?? null, o.secureThresholdPct);
  return { rows, weeks, positions, objective, assumptions: assumptionsOf(ctx, "projection", o, null, null, objective) };
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
  se: number;
  noiseFloorPp: number;
  insurance: { name: string; pos: string; proj: number; from: string; free: boolean; recoversPp: number; recoversPlayoffWeekPts: number; recoversTitlePp: number }[];
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
  o: BaseOpts & { insurers?: number } = {},
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
    objective,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, seeds, objective),
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
