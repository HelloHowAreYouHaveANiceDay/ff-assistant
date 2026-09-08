/**
 * FORWARD season Monte Carlo -- "given THESE rosters and THIS schedule, what are our odds?"
 *
 * Distinct from backtest.ts, and the difference matters. The backtest asks whether our DRAFT
 * STRATEGY is good: it replays history, re-drafts each season, and scores against ACTUAL weekly
 * results. This asks what happens to a roster that already exists in a season that has not happened,
 * so every weekly score must be SAMPLED rather than replayed.
 *
 * THE THING THAT DECIDES WHETHER THE OUTPUT MEANS ANYTHING, stated first because it is the step
 * most season simulators skip: PROJECTION ERROR DOMINATES WEEKLY NOISE. If you feed in our board as
 * truth, the simulator answers "given that our roster is exactly the 7th best, here are the odds"
 * and returns a precisely wrong number with tight error bars. The real uncertainty is whether we are
 * 3rd or 12th. So each simulated season first draws every player's TRUE seasonal mean from our
 * projection times a lognormal error (`projSd`, the same 0.30 the backtest uses for the market), and
 * only then samples weeks around that. Setting projSd = 0 reproduces the overconfident version, and
 * season-odds.mjs reports both so the difference is visible rather than assumed.
 *
 * WHAT IS MODELLED
 *   - per-player TRUE mean drawn once per season (projection error)
 *   - weekly scores around it, with position/tier CV and right-skew from data/variance-model.json
 *   - availability: bye weeks plus per-position injury draws
 *   - the real head-to-head schedule, seeding by record with points-for as tiebreak (verified: that
 *     is exactly how this league seeds -- zero rank-vs-record inversions in 2025)
 *   - single-elimination playoffs with byes for top seeds
 *
 * WHAT IS NOT, and both make the output slightly OVER-confident:
 *   - NFL-teammate correlation. A QB and his WR1 boom together; independent draws understate how
 *     often a good roster has a genuinely bad week, which is the tail that decides playoff races.
 *   - in-season roster change. Justified here rather than assumed: this league averages ~0.1 trades
 *     per team per season, so ignoring trades is accuracy, not simplification. Waivers are real
 *     (~15 adds/team) and their omission understates every team roughly equally.
 *
 *     THAT LAST CLAIM WAS TRUE ACROSS TEAMS AND FALSE ACROSS POSITIONS, which is the axis every
 *     roster decision runs along. QB, K and DST are streamed in every real league; a manager whose
 *     only quarterback is on bye adds one, he does not field nobody. Scoring the empty slot as zero
 *     charged a penalty that is never paid, and charged it only to rosters carrying one body at a
 *     mandatory slot. See `replacement` in SeasonOpts, which is now the streaming floor.
 */
import { optimalLineup } from "../inseason/lineup.js";
// Imported as `unitDraw`, not `draw`: the playoff bracket already has a local `draw(teamIndex)` that
// would shadow it, and the shadowed call type-checked as a wrong-arity error only by luck.
import { draw as unitDraw, drawGauss, PURPOSE, PlayerIds } from "./rng.js";
import { prepare as prepBootstrap, sampleSeason as bootstrapSeason, weekOf, type RankOutcomes, type CorrelationModel, type PoolPlayer } from "./bootstrap.js";

export interface VarianceModel {
  tiers: number;
  unfitted: string[];
  pos: Record<string, { cv: number[]; avail: number[]; skew: number[]; fitted: boolean }>;
}

/** `team` is the NFL team, required only in bootstrap mode: it is what identifies teammates to
 *  correlate. Absent, a player is simply drawn independently. */
export interface SeasonPlayer { name: string; pos: string; proj: number; bye?: number | null; team?: string }
export interface SeasonTeamInput { id: string; name: string; roster: SeasonPlayer[] }
export interface SeasonOpts {
  weeks: number;
  playoffTeams: number;
  slots: string[];
  /** Lognormal sd of our projection error. 0 = treat the board as truth (overconfident). */
  projSd: number;
  trials: number;
  seed?: number;
  /** Multiplier applied to every K/DST CV, for the sensitivity check on those unfitted rows. */
  kdstCvScale?: number;
  /** FLEX eligibility, from the league's `flex_ok`. Defaults to RB/WR/TE. */
  flexOk?: string[];
  /**
   * STREAMING / REPLACEMENT LEVEL: per-position WEEKLY points available for free off waivers.
   *
   * Without this a slot the roster cannot fill scores ZERO, which is not how anyone plays. Nobody
   * takes a zero at quarterback in Goff's bye week -- they add whoever is free that Tuesday, and at
   * QB, K and DST the freely available option is barely worse than a rostered one. Scoring the empty
   * slot as zero therefore invents a penalty that does not exist, and it does NOT fall equally on
   * every team: it lands entirely on rosters carrying one body at a mandatory slot.
   *
   * That distortion is not academic. It inflated the K slot's apparent leverage, made a fourth-string
   * quarterback look like a top waiver claim purely as bye insurance, and marked our only kicker,
   * quarterback and defense "never droppable" when in reality you drop one the moment you add
   * another. The header below used to justify omitting waivers on the grounds that they "understate
   * every team roughly equally" -- true across teams, false across POSITIONS, which is the axis every
   * roster decision runs along.
   *
   * Left undefined, an empty slot still scores zero and the old behaviour is unchanged.
   */
  replacement?: Record<string, number>;
  /**
   * Opt out of the structural roster check. Only for cases where a partial roster is the POINT --
   * simulating a half-finished draft, or a unit test of the scoring path. Never as a way past a
   * failure: the check firing on a roster that should be complete means the roster is wrong, and
   * silencing it restores exactly the bug it was written for.
   */
  allowIncompleteRosters?: boolean;
  /** name -> rank within the FULL projection pool at that position. Required for tiers to match the
   *  variance fit; see the tiering note in simulateSeasons. */
  poolRank?: Map<string, { rank: number; of: number }>;
  /**
   * BOOTSTRAP mode. When supplied, weekly scores are resampled from the real historical outcomes of
   * players who entered a season at the same positional rank, with NFL teammates coupled through a
   * Gaussian copula -- replacing the parametric path entirely.
   *
   * It SUBSUMES three of the options above, which are therefore ignored in this mode: `projSd` (the
   * rank pool already contains busts and league-winners in their real proportions), the variance
   * model's CV (the pool is the distribution), and its availability rate (a week the player missed is
   * a real 0 in the pool). Byes are still applied from the schedule, because the pool is built only
   * from weeks a player's team actually played and would otherwise double-count them.
   */
  bootstrap?: { outcomes: RankOutcomes; corr: CorrelationModel; calibration?: "none" | "scale" };
}
export interface SeasonOdds { id: string; name: string; playoffs: number; champion: number; meanWins: number; meanPoints: number }

function gauss(rng: () => number): number {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Tier a player by his projection relative to the others at his position, matching how the model
 *  was fitted (within-position rank, split into equal quartiles). */
function tierFor(rankFrac: number, tiers: number): number {
  return Math.min(tiers - 1, Math.max(0, Math.floor(rankFrac * tiers)));
}

/**
 * Sample one week. `mean` is the player's true per-game mean; noise is lognormal so the draw is
 * non-negative and right-skewed, matching the fitted skew -- a symmetric normal both produces
 * impossible negative scores and understates the ceiling games that win playoff weeks.
 */
function sampleWeek(mean: number, cv: number, rng: () => number): number {
  if (mean <= 0) return 0;
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const mu = -0.5 * sigma * sigma;                 // so E[exp(mu + sigma*Z)] = 1
  return Math.max(0, mean * Math.exp(mu + sigma * gauss(rng)));
}

/**
 * Points for a starting slot nothing on the roster can fill this week.
 *
 * Zero is the answer only when no replacement level is configured. Otherwise it is what a manager
 * would actually get by claiming the best free agent at that position -- and for FLEX, the best of
 * the positions eligible to fill it.
 */
function emptySlotPoints(slot: string, opts: SeasonOpts): number {
  const rep = opts.replacement;
  if (!rep) return 0;
  if (slot === "FLEX") {
    const flex = opts.flexOk ?? ["RB", "WR", "TE"];
    return Math.max(0, ...flex.map((p) => rep[p] ?? 0));
  }
  return rep[slot] ?? 0;
}

function playoffWinner(seeds: number[], beat: (a: number, b: number) => number): number {
  let alive = seeds.map((team, seed) => ({ team, seed }));
  while (alive.length > 1) {
    const byes = 2 ** Math.ceil(Math.log2(alive.length)) - alive.length;
    const bye = alive.slice(0, byes), play = alive.slice(byes);
    const winners: { team: number; seed: number }[] = [];
    for (let i = 0; i < play.length / 2; i++) {
      const a = play[i], b = play[play.length - 1 - i];
      winners.push(beat(a.team, b.team) === a.team ? a : b);
    }
    alive = [...bye, ...winners].sort((x, y) => x.seed - y.seed);
  }
  return alive[0].team;
}

/**
 * CAN THESE ROSTERS EVER FILL THIS LINEUP? Structural legality, checked before a single trial runs.
 *
 * There are two ways a starting slot ends up empty and they are not the same event:
 *
 *   - A player is on bye or hurt and the bench cannot cover. That is REAL FANTASY FOOTBALL and the
 *     simulator must model it -- scoring zero there is the correct answer, and `optimalLineup`
 *     rightly returns "(empty)".
 *   - The roster contains nobody at that position AT ALL, so the slot is empty in all 3,000 trials of
 *     all 14 weeks. That is never a football fact; it is a data defect upstream.
 *
 * Conflating them is what let sixteen rosters simulate for weeks with no defense. `optimalLineup`
 * DID flag it -- it pushes "no available player to fill DST" into `flags` -- and `simulateSeasons`
 * never read `flags`, so a real signal was produced and discarded on every one of millions of
 * lineup calls. A warning nobody reads is indistinguishable from no warning.
 *
 * So the structural case is refused here, at the one function every path goes through, rather than
 * being detected at any of the eight places that build rosters. An incomplete roster is now
 * impossible to simulate by accident; it takes the explicitly-named opt-out below.
 */
export function assertRostersCanFillLineup(
  teams: SeasonTeamInput[],
  slots: string[],
  flexOk?: Iterable<string>,
  replacement?: Record<string, number>,
): void {
  const problems = rosterGaps(teams, slots, flexOk);
  if (!problems.length) return;

  // WITHOUT a streaming floor the original premise holds exactly: the slot scores zero in every week
  // of every trial, which is never a football outcome. Refuse.
  if (!replacement) {
    throw new Error(
      `roster cannot fill the lineup -- these slots would score zero in EVERY week of EVERY trial, ` +
      `which is a data defect and not a football outcome:\n  ${problems.join("\n  ")}\n` +
      `If partial rosters are genuinely intended (a mid-draft simulation, say), pass ` +
      `allowIncompleteRosters: true to say so deliberately.`,
    );
  }

  // WITH a streaming floor the shape alone no longer decides, because punting a position and
  // streaming it weekly is a real strategy and the simulator can now price it. What still cannot
  // happen is MANY teams short at the SAME position: sixteen managers do not independently abandon
  // the same mandatory slot, and that pattern is what a failed join looks like from the inside --
  // it is precisely the signature of every roster in the league losing its defense to a nickname vs
  // abbreviation mismatch. So the test moves from "is this roster odd" to "is this shortfall
  // SYSTEMATIC", which is the question that actually separates a data defect from a decision.
  const shortByPos: Record<string, number> = {};
  for (const line of problems) {
    const m = /has \d+ (\w+) but the lineup starts/.exec(line);
    if (m) shortByPos[m[1]] = (shortByPos[m[1]] ?? 0) + 1;
  }
  const threshold = Math.max(2, Math.ceil(teams.length * 0.25));
  const systematic = Object.entries(shortByPos).filter(([, n]) => n >= threshold);
  if (systematic.length) {
    throw new Error(
      `${systematic.map(([pos, n]) => `${n} of ${teams.length} teams have no ${pos}`).join("; ")} -- ` +
      `that many teams do not independently punt the same mandatory slot, so this is a data defect ` +
      `(a failed join upstream), not a roster choice:\n  ${problems.slice(0, 8).join("\n  ")}\n` +
      `If it really is intended, pass allowIncompleteRosters: true.`,
    );
  }
  // One or two teams short, with streaming configured: legal, priced, and not worth a warning on
  // every call -- the sweeps construct thousands of these deliberately.
}

/**
 * The same check, reported rather than thrown.
 *
 * Callers that CONSTRUCT hypothetical rosters need to ask the question before simulating, not be
 * stopped afterwards -- scripts/waiver-check.mjs proposes dropping each player in turn, and dropping
 * the only kicker is a proposal to evaluate and reject, not a crash. Returns one line per gap, empty
 * when every team is legal.
 */
export function rosterGaps(
  teams: SeasonTeamInput[],
  slots: string[],
  flexOk?: Iterable<string>,
): string[] {
  const flex = new Set(flexOk ?? ["RB", "WR", "TE"]);
  const start = slots.filter((s) => s !== "BE" && s !== "BENCH" && s !== "IR");
  const need: Record<string, number> = {};
  let flexN = 0;
  for (const s of start) { if (s === "FLEX") flexN++; else need[s] = (need[s] ?? 0) + 1; }

  const problems: string[] = [];
  for (const t of teams) {
    const have: Record<string, number> = {};
    for (const p of t.roster) have[p.pos] = (have[p.pos] ?? 0) + 1;
    for (const [pos, n] of Object.entries(need)) {
      if ((have[pos] ?? 0) < n) problems.push(`${t.name || t.id}: has ${have[pos] ?? 0} ${pos} but the lineup starts ${n}`);
    }
    // FLEX needs players SPARE of the dedicated slots, not merely present.
    let spare = 0;
    for (const pos of flex) spare += Math.max(0, (have[pos] ?? 0) - (need[pos] ?? 0));
    if (spare < flexN) problems.push(`${t.name || t.id}: ${spare} flex-eligible players spare of the fixed slots but the lineup starts ${flexN} FLEX`);
  }
  return problems;
}

export function simulateSeasons(
  teams: SeasonTeamInput[],
  schedule: [number, number][][],
  vm: VarianceModel,
  opts: SeasonOpts,
): SeasonOdds[] {
  if (!opts.allowIncompleteRosters) assertRostersCanFillLineup(teams, opts.slots, opts.flexOk, opts.replacement);
  const N = teams.length;
  // IDENTITY-KEYED DRAWS. Every random value below is a pure function of (seed, trial, week,
  // player, purpose), so a shared player lives through the SAME season in two rosters that differ
  // elsewhere -- which is what makes a paired comparison actually paired. See draft/rng.ts for the
  // measurement showing the previous sequential stream delivered none of that.
  const seedNum = (opts.seed ?? 20260907) | 0;
  const ids = new PlayerIds();
  const pid = (name: string) => ids.id(name);
  const kScale = opts.kdstCvScale ?? 1;

  // TIERING MUST MATCH HOW THE MODEL WAS FITTED, and getting this wrong is silent and severe.
  // fit-variance.mjs tiers within the FULL seasonal player pool at a position. Tiering by rank among
  // ROSTERED players instead maps a 16-team league's WR4 -- a top-60 WR, genuinely tier 0/1 -- onto
  // the historical tier 3, whose fitted availability is 0.29. The first run of this did exactly that
  // and produced 56 pts/week against a 72.7 projection, because a third of every roster was being
  // treated as barely-playing depth. `poolRank` supplies each player's rank in the full projection
  // pool so the tiers line up with the fit.
  const tierOf = new Map<SeasonPlayer, number>();
  for (const tm of teams) {
    for (const p of tm.roster) {
      const pr = opts.poolRank?.get(p.name);
      tierOf.set(p, pr ? tierFor(pr.rank / Math.max(1, pr.of), vm.tiers) : 0);
    }
  }

  const playoffs = new Array(N).fill(0), champs = new Array(N).fill(0);
  const totWins = new Array(N).fill(0), totPts = new Array(N).fill(0);

  // BOOTSTRAP prep, once: per-player sorted pools + the Cholesky factor for each NFL-team group.
  // Grouping is per FANTASY team, which is what makes a roster's own variance right -- two managers
  // holding opposite ends of the same NFL stack is a head-to-head covariance we do not need.
  const boot = opts.bootstrap
    ? teams.map((tm) => {
      const pp: PoolPlayer[] = tm.roster.map((p) => ({
        name: p.name, pos: p.pos, team: p.team,
        rank: (opts.poolRank?.get(p.name)?.rank ?? 0) + 1,
        projPerGame: p.proj / 17,
      }));
      return { pp, byName: new Map(pp.map((x) => [x.name, x])), prep: prepBootstrap(pp, opts.bootstrap!.outcomes, opts.bootstrap!.corr, opts.bootstrap!.calibration ?? "none") };
    })
    : null;

  for (let trial = 0; trial < opts.trials; trial++) {
    // --- draw each player's TRUE season mean once (projection error) -----------------------------
    // In bootstrap mode this is only the LINEUP-SETTING estimate (a manager picks starters on what he
    // thinks they are worth); the scores themselves come from the resampled pools.
    const trueMean = new Map<SeasonPlayer, number>();
    for (const tm of teams) {
      for (const p of tm.roster) {
        const err = (!boot && opts.projSd > 0) ? Math.exp(drawGauss(seedNum, trial, 0, pid(p.name), PURPOSE.projErr) * opts.projSd - 0.5 * opts.projSd ** 2) : 1;
        trueMean.set(p, Math.max(0, (p.proj / 17) * err));
      }
    }
    // --- draw each player's whole SEASON once, then read weeks out of it ---------------------------
    // The bootstrap draw happens HERE, not inside the week loop, and that is the entire change.
    // Drawing per week made every week an independent sample from the rank pool, which understates
    // season-total spread by 1.6-2.8x (see bootstrap.ts): a torn ACL in week 3 could not persist,
    // because week 4 was a fresh draw from players who were healthy. Drawing a whole player-season
    // and then reading week w out of it keeps that persistence exactly, with no model of it, and
    // leaves the WEEKLY marginal untouched.
    //
    // Week 0 keys the draw so it cannot collide with any weekly draw, and so a paired run against a
    // different config still meets the same seasons for the same players.
    const seasonDraw = boot
      ? boot.map((b) => bootstrapSeason(b.pp, b.prep,
        (m, i) => drawGauss(seedNum, trial, 0, pid(m.name), PURPOSE.copulaA + i),
        (m) => unitDraw(seedNum, trial, 0, pid(m.name), PURPOSE.season)))
      : null;
    // --- play the weeks --------------------------------------------------------------------------
    const wins = new Array(N).fill(0), pts = new Array(N).fill(0);
    const weekPts: number[][] = Array.from({ length: N }, () => []);
    for (let w = 1; w <= opts.weeks; w++) {
      const scores = teams.map((tm, ti) => {
        if (boot) {
          const b = boot[ti];
          const drawn = seasonDraw![ti];
          const players = tm.roster.map((p) => {
            const onBye = p.bye === w;
            const pp = b.byName.get(p.name);
            const actual = onBye || !pp ? null : weekOf(drawn.get(pp), w);
            return { name: p.name, pos: p.pos, proj: trueMean.get(p) ?? 0, available: actual != null, actual };
          });
          const res = optimalLineup(players, opts.slots, opts.flexOk);
          let total = 0;
          for (const s of res.starters) {
            const hit = players.find((x) => x.name === s.name);
            if (hit?.actual != null) total += hit.actual;
            else if (s.name === "(empty)") total += emptySlotPoints(s.slot, opts);
          }
          return total;
        }
        const players = tm.roster.map((p) => {
          const tier = tierOf.get(p) ?? 0;
          const m = vm.pos[p.pos] ?? vm.pos.WR;
          const onBye = p.bye === w;
          // The fitted avail is games/17, which ALREADY includes the bye. Applying the bye
          // separately (so the RIGHT week is missed, which a season total cannot see) means the
          // injury rate must have the bye divided back out, or every player is benched twice.
          const injuryOk = unitDraw(seedNum, trial, w, pid(p.name), PURPOSE.injury) < Math.min(1, (m.avail[tier] ?? 0.85) / (16 / 17));
          const healthy = injuryOk;
          const cvBase = m.cv[tier] ?? 0.8;
          const cv = (p.pos === "K" || p.pos === "DST") ? cvBase * kScale : cvBase;
          const actual = (onBye || !healthy) ? null : sampleWeek(trueMean.get(p) ?? 0, cv, () => unitDraw(seedNum, trial, w, pid(p.name), PURPOSE.perf));
          return { name: p.name, pos: p.pos, proj: trueMean.get(p) ?? 0, available: actual != null, actual };
        });
        // Lineup is set on the TRUE mean (what a competent manager approximates), scored on the
        // sampled week -- never on the sampled value itself, which would be lookahead.
        const res = optimalLineup(players, opts.slots, opts.flexOk);
        let total = 0;
        for (const s of res.starters) {
          const hit = players.find((x) => x.name === s.name);
          if (hit?.actual != null) total += hit.actual;
          else if (s.name === "(empty)") total += emptySlotPoints(s.slot, opts);
        }
        return total;
      });
      for (let t = 0; t < N; t++) { pts[t] += scores[t]; weekPts[t].push(scores[t]); }
      for (const [a, b] of schedule[(w - 1) % schedule.length]) {
        if (scores[a] >= scores[b]) wins[a]++; else wins[b]++;
      }
    }
    // --- seed by record, points-for as tiebreak (verified against this league) --------------------
    const order = [...Array(N).keys()].sort((x, y) => wins[y] - wins[x] || pts[y] - pts[x]);
    const seeds = order.slice(0, opts.playoffTeams);
    for (const s of seeds) playoffs[s]++;
    // playoff weeks: a fresh sampled week per matchup, same generative model
    const playoffWeek = new Map<number, number>();
    // A matchup counter, because the bracket exposes no round index and playoff draws still need a
    // key that varies between rounds. This part CANNOT be perfectly aligned across arms and it is
    // worth saying why: a trade that changes the standings changes who is in the bracket at all, so
    // there is no correspondence to preserve. The regular season -- fourteen of the weeks, and what
    // determines seeding -- is fully aligned, which is where the variance reduction comes from.
    let poRound = 0;
    const beat = (a: number, b: number) => {
      poRound++;
      const draw = (t: number) => {
        if (playoffWeek.has(t)) return playoffWeek.get(t)!;
        const tm = teams[t];
        const players = tm.roster.map((p) => {
          const tier = tierOf.get(p) ?? 0;
          const m = vm.pos[p.pos] ?? vm.pos.WR;
          const healthy = unitDraw(seedNum, trial, 100 + poRound, pid(p.name), PURPOSE.playoffInjury) < Math.min(1, (m.avail[tier] ?? 0.85) / (16 / 17));
          const cvBase = m.cv[tier] ?? 0.8;
          const cv = (p.pos === "K" || p.pos === "DST") ? cvBase * kScale : cvBase;
          const actual = healthy ? sampleWeek(trueMean.get(p) ?? 0, cv, () => unitDraw(seedNum, trial, 100 + poRound, pid(p.name), PURPOSE.playoffPerf)) : null;
          return { name: p.name, pos: p.pos, proj: trueMean.get(p) ?? 0, available: actual != null, actual };
        });
        const res = optimalLineup(players, opts.slots, opts.flexOk);
        let total = 0;
        for (const s of res.starters) {
          const hit = players.find((x) => x.name === s.name);
          if (hit?.actual != null) total += hit.actual;
          else if (s.name === "(empty)") total += emptySlotPoints(s.slot, opts);
        }
        return total;
      };
      // redraw both sides each ROUND so a team is not locked to one score all playoffs
      playoffWeek.clear();
      const sa = draw(a); playoffWeek.set(a, sa);
      const sb = draw(b); playoffWeek.set(b, sb);
      return sa >= sb ? a : b;
    };
    champs[playoffWinner(seeds, beat)]++;
    for (let t = 0; t < N; t++) { totWins[t] += wins[t]; totPts[t] += pts[t]; }
  }

  return teams.map((tm, i) => ({
    id: tm.id, name: tm.name,
    playoffs: playoffs[i] / opts.trials,
    champion: champs[i] / opts.trials,
    meanWins: totWins[i] / opts.trials,
    meanPoints: totPts[i] / opts.trials,
  }));
}
