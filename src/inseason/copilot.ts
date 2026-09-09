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
}

export function defaultProvenance(ctx: SimContext): Provenance {
  return { season: ctx.season, boardRows: ctx.board.size, varianceSeasons: null, sampler: "bootstrap", projectionArtifact: null };
}

interface BaseOpts { trials?: number; seed?: number; seeds?: number[]; provenance?: Provenance }

function assumptionsOf(ctx: SimContext, basis: Assumptions["basis"], o: BaseOpts, trials: number | null, seeds: number[] | null): Assumptions {
  return {
    schedule: ctx.syntheticSchedule ? "generated" : "real",
    basis,
    trials,
    seeds,
    artifact: o.provenance ?? defaultProvenance(ctx),
    asOf: new Date().toISOString(),
  };
}

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
  assumptions: Assumptions;
}

/** Playoff and championship odds for every team from the rosters that actually exist, ours flagged. */
export function seasonOdds(ctx: SimContext, o: BaseOpts = {}): SeasonOddsResult {
  const trials = o.trials ?? 4000;
  const seed = o.seed ?? 7;
  const opts = ctx.opts(trials, seed);
  const raw = ctx.run(ctx.teams, trials, seed);
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
  const sorted = [...rows].sort((a, b) => b.champion - a.champion);
  return {
    teams: sorted,
    us: rows[ctx.meIdx],
    playoffTeams: opts.playoffTeams,
    regWeeks: ctx.weeks.length,
    randomTitlePct: r2(100 / ctx.teams.length),
    invariants,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, [seed]),
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
  const assumptions = assumptionsOf(ctx, allWeekly ? "weekly-model" : "projection", o, null, null);
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
// A SHARED SIMULATION HELPER -- every "what does this move do to our title odds" question.
// ---------------------------------------------------------------------------------------------

/** Our title probability, in percent, for a hypothetical league state, under one seed. */
const titlePct = (ctx: SimContext, teams: SeasonTeamInput[], trials: number, seed: number, idx = ctx.meIdx): number =>
  100 * ctx.run(teams, trials, seed)[idx].champion;

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

export interface WaiverDrop { name: string; pos: string; proj: number; deltaPp: number; se: number }
export interface WaiverRefusal { add: string; drop: string; pos: string; why: string }
export interface WaiverTarget {
  add: string; pos: string; proj: number;
  drop: string; dropPos: string;
  deltaPp: number; se: number;
  afterTitlePct: number;
  clearsNoise: boolean;
  faab: number; faabRule: string;
  drops: WaiverDrop[];
}
export interface WaiverResult {
  baseTitlePct: number;
  noiseFloorPp: number;
  targets: WaiverTarget[];
  refused: WaiverRefusal[];
  faabBudget: number;
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
export const FAAB_RULE = "10% of budget per +1pp of title probability, capped at 50% -- a stated rule of thumb, not a fitted value";
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

  const baseBySeed = seeds.map((s) => titlePct(ctx, ctx.teams, trials, s));
  const base = mean(baseBySeed);
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
      const perSeed = seeds.map((s, i) => {
        const teams = ctx.clone();
        teams[ctx.meIdx].roster = teams[ctx.meIdx].roster.filter((p) => p.name !== cand.name).concat([{ ...add }]);
        return titlePct(ctx, teams, trials, s) - baseBySeed[i];
      });
      const { delta, se } = pairedDelta(perSeed);
      drops.push({ name: cand.name, pos: cand.pos, proj: r2(cand.proj), deltaPp: delta, se });
    }
    if (!drops.length) continue;
    drops.sort((a, b) => b.deltaPp - a.deltaPp);
    const best = drops[0];
    const floor = noiseFloorPp(base, trials);
    targets.push({
      add: add.name, pos: add.pos, proj: r2(add.proj),
      drop: best.name, dropPos: best.pos,
      deltaPp: best.deltaPp, se: best.se,
      afterTitlePct: r2(base + best.deltaPp),
      clearsNoise: best.deltaPp > floor,
      faab: faabFor(best.deltaPp, budget), faabRule: FAAB_RULE,
      drops,
    });
  }
  targets.sort((a, b) => b.deltaPp - a.deltaPp);
  return {
    baseTitlePct: r2(base),
    noiseFloorPp: noiseFloorPp(base, trials),
    targets,
    refused,
    faabBudget: budget,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, seeds),
  };
}

// ---------------------------------------------------------------------------------------------
// TRADES
// ---------------------------------------------------------------------------------------------

export interface TradeOffer { give: string[]; get: string[] }
export interface TradeSide { teamId: string; teamName: string; baseTitlePct: number; afterTitlePct: number; deltaPp: number; se: number; legal: boolean; illegalWhy: string[] }
export interface TradeCheckResult {
  offer: TradeOffer;
  us: TradeSide;
  them: TradeSide;
  noiseFloorPp: number;
  verdict: "good for us" | "bad for us" | "inside the noise floor";
  mutual: boolean;
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

  const baseUs: number[] = [], baseThem: number[] = [], afterUs: number[] = [], afterThem: number[] = [];
  for (const s of seeds) {
    const b = ctx.run(ctx.teams, trials, s);
    baseUs.push(100 * b[ctx.meIdx].champion);
    baseThem.push(100 * b[ti].champion);
    const teams = ctx.clone();
    apply(teams);
    const a = ctx.run(teams, trials, s);
    afterUs.push(100 * a[ctx.meIdx].champion);
    afterThem.push(100 * a[ti].champion);
  }
  const dUs = pairedDelta(afterUs.map((v, i) => v - baseUs[i]));
  const dThem = pairedDelta(afterThem.map((v, i) => v - baseThem[i]));
  const floor = noiseFloorPp(mean(baseUs), trials);
  return {
    offer,
    us: { teamId: ctx.teams[ctx.meIdx].id, teamName: ctx.teams[ctx.meIdx].name, baseTitlePct: r2(mean(baseUs)), afterTitlePct: r2(mean(afterUs)), deltaPp: dUs.delta, se: dUs.se, legal: !usGaps.length, illegalWhy: usGaps },
    them: { teamId: ctx.teams[ti].id, teamName: ctx.teams[ti].name, baseTitlePct: r2(mean(baseThem)), afterTitlePct: r2(mean(afterThem)), deltaPp: dThem.delta, se: dThem.se, legal: !themGaps.length, illegalWhy: themGaps },
    noiseFloorPp: floor,
    verdict: dUs.delta > floor ? "good for us" : dUs.delta < -floor ? "bad for us" : "inside the noise floor",
    mutual: dUs.delta > floor && dThem.delta > floor,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, seeds),
  };
}

export interface TradeIdea {
  give: string; givePos: string; giveValue: number;
  get: string; getPos: string; getValue: number;
  partnerId: string; partner: string;
  valueGap: number;
  deltaPp: number; usAfterTitlePct: number;
  themDeltaPp: number;
  clearsNoise: boolean; mutual: boolean;
}
export interface TradeFinderResult {
  baseTitlePct: number;
  noiseFloorPp: number;
  maxValueGap: number;
  candidates: number;
  skippedNoValue: number;
  ideas: TradeIdea[];
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

  const baseOdds = ctx.run(ctx.teams, trials, seed);
  const baseUs = 100 * baseOdds[ctx.meIdx].champion;
  const floor = noiseFloorPp(baseUs, trials);
  const ideas: TradeIdea[] = screened.map((c) => {
    const teams = ctx.clone();
    teams[ctx.meIdx].roster = teams[ctx.meIdx].roster.filter((p) => p.name !== c.give.name).concat([{ ...c.get }]);
    teams[c.ti].roster = teams[c.ti].roster.filter((p) => p.name !== c.get.name).concat([{ ...c.give }]);
    const after = ctx.run(teams, trials, seed);
    const dUs = 100 * after[ctx.meIdx].champion - baseUs;
    const dThem = 100 * (after[c.ti].champion - baseOdds[c.ti].champion);
    return {
      give: c.give.name, givePos: c.give.pos, giveValue: c.gv,
      get: c.get.name, getPos: c.get.pos, getValue: c.tv,
      partnerId: ctx.teams[c.ti].id, partner: ctx.teams[c.ti].name,
      valueGap: r3(c.gap),
      deltaPp: r2(dUs), usAfterTitlePct: r2(baseUs + dUs), themDeltaPp: r2(dThem),
      clearsNoise: dUs > floor, mutual: dUs > floor && dThem > floor,
    };
  }).sort((a, b) => b.deltaPp - a.deltaPp);

  return {
    baseTitlePct: r2(baseUs),
    noiseFloorPp: floor,
    maxValueGap: maxGap,
    candidates: cand.length,
    skippedNoValue,
    ideas,
    assumptions: assumptionsOf(ctx, "simulation", { ...o, seeds: [seed] }, trials, [seed]),
  };
}

// ---------------------------------------------------------------------------------------------
// HANDCUFFS
// ---------------------------------------------------------------------------------------------

export interface HandcuffResult { rows: (HandcuffRow & { ours: boolean; rostered: boolean })[]; weeks: number; positions: string[]; assumptions: Assumptions }

/** Rank every backup by what he scores IF the man ahead of him misses a week. The model and its
 *  three rejected functional forms are documented in handcuff.ts; this only attaches league context
 *  -- who is already ours, and who is rostered anywhere -- and the assumptions block. */
export function handcuffs(
  ctx: SimContext,
  o: BaseOpts & { depth: DepthEntry[]; vm: VarianceModel; weeks?: number; positions?: string[]; poolSize?: Record<string, number>; freeOnly?: boolean } = { depth: [], vm: { pos: {} } as VarianceModel },
): HandcuffResult {
  const weeks = o.weeks ?? NFL_WEEKS;
  const positions = o.positions ?? ["RB"];
  const ourNames = new Set(ctx.teams[ctx.meIdx].roster.map((p) => nameKey(p.name)));
  let rows = handcuffBoard(o.depth, o.vm, { weeks, positions, poolSize: o.poolSize })
    .map((r) => ({ ...r, ours: ourNames.has(nameKey(r.name)), rostered: ctx.ownedIds.has(nameKey(r.name)) }));
  if (o.freeOnly) rows = rows.filter((r) => !r.rostered);
  return { rows, weeks, positions, assumptions: assumptionsOf(ctx, "projection", o, null, null) };
}

// ---------------------------------------------------------------------------------------------
// DEPTH RISK
// ---------------------------------------------------------------------------------------------

export interface DepthRiskResult {
  player: { name: string; pos: string; proj: number };
  baseTitlePct: number;
  withoutTitlePct: number;
  /** POSITIVE = percentage points of title probability we lose if he is gone for the season. */
  costPp: number;
  se: number;
  noiseFloorPp: number;
  insurance: { name: string; pos: string; proj: number; from: string; free: boolean; recoversPp: number }[];
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
  const baseBySeed: number[] = [], outBySeed: number[] = [];
  for (const s of seeds) {
    baseBySeed.push(titlePct(ctx, ctx.teams, trials, s));
    const t = ctx.clone();
    t[ctx.meIdx].roster = withoutOf(t);
    outBySeed.push(titlePct(ctx, t, trials, s));
  }
  // base MINUS without, so the headline number reads as a COST: positive means we are worse off
  // without him. Reporting the raw delta here has bitten before -- a negative "cost" is read as a
  // benefit by anything skimming the field name.
  const cost = pairedDelta(baseBySeed.map((v, i) => v - outBySeed[i]));

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
    const perSeed = seeds.map((s, i) => {
      const t = ctx.clone();
      t[ctx.meIdx].roster = withoutOf(t).concat([{ name: r.name, pos: r.pos, proj: r.proj, team: r.team, bye: null }]);
      return titlePct(ctx, t, trials, s) - outBySeed[i];
    });
    return { name: r.name, pos: r.pos, proj: r2(r.proj), from: r.from, free: r.free, recoversPp: r2(mean(perSeed)) };
  }).sort((a, b) => b.recoversPp - a.recoversPp);

  return {
    player: { name: at.name, pos: at.pos, proj: r2(at.proj) },
    baseTitlePct: r2(mean(baseBySeed)),
    withoutTitlePct: r2(mean(outBySeed)),
    costPp: cost.delta,
    se: cost.se,
    noiseFloorPp: noiseFloorPp(mean(baseBySeed), trials),
    insurance,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, seeds),
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
export interface PowerResult { rows: PowerRow[]; leagueMeanStartPts: number; ourRank: number; assumptions: Assumptions }

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
  return {
    rows,
    leagueMeanStartPts: Math.round(mean(rows.map((r) => r.startPts))),
    ourRank: rows.findIndex((r) => r.us) + 1,
    assumptions: assumptionsOf(ctx, "simulation", o, trials, [seed]),
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
  o: BaseOpts & { games: GameRow[]; regWeeks?: number; nflWeeks?: number; teamOf?: Map<string, string>; players?: { name: string; pos: string; proj: number }[] },
): SosResult {
  const regWeeks = o.regWeeks ?? ctx.weeks.length;
  const nflWeeks = o.nflWeeks ?? NFL_WEEKS;
  const playoffWeeks: number[] = [];
  for (let w = regWeeks + 1; w <= nflWeeks; w++) playoffWeeks.push(w);

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
    assumptions: assumptionsOf(ctx, "market", o, null, null),
  };
}
