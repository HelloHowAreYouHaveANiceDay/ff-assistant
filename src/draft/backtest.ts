// Backtest = the CHAMPIONSHIP harness. Draft with a season's values, then play a real head-to-head
// season + playoffs using that season's ACTUAL WEEKLY results, and see how often OUR team wins the
// title. Weekly variance, bye weeks, and single-elim playoffs are real here -> a top-heavy roster
// with a thin bench correctly loses titles when a stud has a down week or is out. This is what makes
// the strategy verdict trustworthy for "optimize championship wins" (season-points sim can't see it).

import { draftField, mulberry32, SIM_LEAGUE, type SimLeague } from "./sim.js";
import { computeValues, resolveValueLeague, type PointsRow } from "./values.js";
import { optimalLineup } from "../inseason/lineup.js";
import { buildSchedule, seedField } from "./schedule.js";
import type { SeedingRule } from "../league/types.js";
import type { V2Config } from "./strategy.js";

/**
 * NO DEFAULT CALENDAR, AND NO DEFAULT BRACKET.
 *
 * `playoffTeams = 6` and `regWeeks = 14` used to sit in `runBacktest`'s signature. Both were dead --
 * the one real caller has always passed the league's own values -- and a dead default that happens
 * to be plausible is the worst kind: the day a caller stops passing them, the harness silently
 * simulates a league that does not exist and reports a number with no warning anywhere. So they are
 * required now. TypeScript cannot express "required after optional" in this positional list, so the
 * requirement is a throwing sentinel, and `test/format.test.ts` fault-injects it.
 *
 * The seeding rule was briefly an `FF_SEEDING` environment variable, because the track that
 * introduced it was fenced out of `cmdBacktest`. That fence is gone: it is a `--seeding` flag now,
 * defaulted from the league's own format block, and the env var is no longer read.
 */
function required(what: string): never {
  throw new Error(`runBacktest: ${what} must be passed -- it comes from the league format block (ff format show), not from a default.`);
}

function gauss(rng: () => number): number { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export type Weekly = Map<string, Map<number, number>>; // name -> week -> actual points

export interface BacktestResult { champ: boolean; madePlayoffs: boolean; wins: number; regPoints: number; }

/**
 * Single-elimination playoff with byes for the top seeds (handles 4/6/7/8...). seeds[0] = best.
 *
 * `reseed` is ESPN's `playoffReseed`, and it is a real fork, not a formatting choice:
 *
 *   true  -- after every round the survivors are re-ordered BY SEED, so the highest remaining seed
 *            always plays the lowest remaining seed. A bye team's reward is the weakest survivor.
 *   false -- a FIXED bracket. Survivors keep their position in the tree, so the 7-team bracket's
 *            top seed meets the winner of 4-v-5 whatever else happened, and the 2 seed cannot meet
 *            the 1 seed before the final even if every other favourite lost.
 *
 * The only mechanical difference is the sort, which is why it is easy to get wrong by omission: the
 * repo reseeded for its whole life without ever having read the league's setting.
 */
export function playoffWinner(seeds: number[], beat: (a: number, b: number, wk: number) => number, startWeek: number, reseed: boolean): number {
  let alive = seeds.map((team, seed) => ({ team, seed }));
  let wk = startWeek;
  while (alive.length > 1) {
    const byes = 2 ** Math.ceil(Math.log2(alive.length)) - alive.length; // top `byes` seeds skip
    const bye = alive.slice(0, byes), play = alive.slice(byes);
    const winners: { team: number; seed: number }[] = [];
    for (let i = 0; i < play.length / 2; i++) { const a = play[i], b = play[play.length - 1 - i]; winners.push(beat(a.team, b.team, wk) === a.team ? a : b); }
    alive = [...bye, ...winners];
    if (reseed) alive.sort((x, y) => x.seed - y.seed);
    wk++;
  }
  return alive[0].team;
}

/** Choose the lineup by a selection value (default = season projection = a NAIVE manager who ignores
 *  weekly matchup/health), score by that week's ACTUAL. A skilled manager passes `sel` = a WEEKLY
 *  projection (actual + forecast noise) -> starts the right players that week. Byes/inactives are
 *  unstartable -> depth matters. */
function weekScore(roster: { name: string; pos: string; proj: number }[], week: number, weekly: Weekly, lg: SimLeague, sel?: Map<string, number>): number {
  const startable = roster
    .map((p) => ({ pos: p.pos, proj: sel ? (sel.get(p.name) ?? p.proj) : p.proj, actual: weekly.get(p.name)?.get(week) }))
    .filter((p) => p.actual != null) as { pos: string; proj: number; actual: number }[];
  // pick starters by proj, but the "points" we total are ACTUAL -> reuse startingPoints by feeding
  // proj as the selection value, then map back. Simplest: group, sort by proj, sum actual of chosen.
  const FLEX_OK = new Set(["RB", "WR", "TE"]);
  const byPos: Record<string, { proj: number; actual: number }[]> = {};
  for (const p of startable) (byPos[p.pos] ??= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.proj - a.proj);
  let total = 0; const used = new Set<{ proj: number; actual: number }>();
  for (const slot of lg.slots) {
    if (slot === "BE") continue;
    if (slot === "FLEX") { let best: { proj: number; actual: number } | null = null; for (const p of FLEX_OK) { const a = (byPos[p] || []).find((x) => !used.has(x)); if (a && (!best || a.proj > best.proj)) best = a; } if (best) { used.add(best); total += best.actual; } }
    else { const a = (byPos[slot] || []).find((x) => !used.has(x)); if (a) { used.add(a); total += a.actual; } }
  }
  return total;
}

/** FULL-SYSTEM week score for our team: run the REAL lineup optimizer (inseason/lineup.ts) using OUR
 *  per-game projection, on the players who actually PLAYED that week (availability), score by ACTUAL.
 *  This exercises the production lineup code end-to-end (not a synthetic noise proxy). */
function realWeekScore(roster: { name: string; pos: string; proj: number }[], week: number, weekly: Weekly, lg: SimLeague, perGame: Map<string, number>): number {
  const players = roster.map((p) => ({ name: p.name, pos: p.pos, proj: perGame.get(p.name) ?? p.proj / 17, available: weekly.get(p.name)?.get(week) != null }));
  const res = optimalLineup(players, lg.slots);
  let total = 0;
  for (const s of res.starters) { const a = weekly.get(s.name)?.get(week); if (a != null) total += a; }
  return total;
}

/**
 * THE MARKET ARBITER, as an option rather than an assumption.
 *
 * The default market is "our own projection, times one shared lognormal error of sd 0.30" -- a
 * number that was asserted and never measured, and a SINGLE draw, so every bot in the room holds an
 * identical view and the auction clears at almost exactly the book. Neither is what a real room
 * looks like.
 *
 * `--market ecr` replaces both halves. `proj` carries the REAL preseason consensus projection --
 * the point-in-time curve read at each player's actual FantasyPros positional rank, so rookies are
 * in the pool with a consensus rank instead of being absent for want of a prior season -- and
 * `sdByName` carries the market's MEASURED error at that player's rank band rather than one
 * constant (scripts/market-noise.mjs: 0.46 at ranks 1-6 rising to 1.21 past 60). `idioSd` then gives
 * each bot an independent view on top of the shared one, which is the half no amount of tuning the
 * shared sd can produce.
 */
export interface MarketModel {
  /** name -> the market's projection. Absent names fall back to our own projection for that player. */
  proj?: Map<string, number>;
  /** name -> the SHARED log-sd for that player. Absent names use the scalar marketSd. */
  sdByName?: Map<string, number>;
  /** Per-bot, per-player independent log-sd. 0 = the old behaviour, one view for the whole room. */
  idioSd?: number;
}

export function runBacktest(seasonPoints: PointsRow[], weekly: Weekly, _ourValues: Map<string, number>, cfg: V2Config, seed: number, lg: SimLeague = SIM_LEAGUE, marketSd = 0.30, ourSd?: number, ourWeeklySd?: number, botWeeklySd?: number, realLineup = false, ourWaivers = false, drainNom = false, greedyNom = false, playoffTeams: number = required("playoffTeams"), regWeeks: number = required("regWeeks"), avail: Map<string, number> = new Map(), injuryLever = 0, botBook: "vor" | "rank" | "price" = "vor", homogeneous = false, divisions = 0, market: MarketModel = {}, botChurn = false, seeding: SeedingRule = required("seeding"), playoffReseed: boolean = required("playoffReseed")): BacktestResult {
  const REG_WEEKS = Array.from({ length: regWeeks }, (_, i) => i + 1); // fantasy regular-season weeks
  const rngM = mulberry32(seed * 104729 + 3);
  const rngU = mulberry32(seed * 15485863 + 7);
  const us = ourSd == null ? marketSd : ourSd; // our projection error; < marketSd => a VALUE EDGE
  // The MARKET (bots) draft on a consensus projection = truth x (1 + noise, sd marketSd). WE draft
  // on OUR projection = truth x (1 + noise, sd ourSd). If ours is tighter we spot mis-priced players
  // and win value. Everyone SCORES by the real weekly truth; lineups are set by the market view (so
  // this isolates the VALUE edge from any lineup-setting skill).
  // THE MARKET'S VIEW. Two forms, and the difference is the whole point of `--market ecr`:
  //   default  our own projection times (1 + e), e ~ N(0, marketSd) -- one shared draw
  //   ecr      the real consensus projection times exp(e), e ~ N(0, the MEASURED sd at his rank
  //            band), median-preserving so the market is not biased up or down by its own error
  const projMarket: PointsRow[] = seasonPoints.map((p) => {
    const base = market.proj?.get(p.name) ?? p.points;
    if (!market.proj && !market.sdByName) {
      return { ...p, points: Math.max(0, p.points * (1 + gauss(rngM) * marketSd)) };
    }
    const sd = market.sdByName?.get(p.name) ?? marketSd;
    return { ...p, points: Math.max(0, base * Math.exp(gauss(rngM) * sd - 0.5 * sd * sd)) };
  });
  const projUs = new Map(seasonPoints.map((p) => [p.name, Math.max(0, p.points * (1 + gauss(rngU) * us))]));
  const projMap = new Map(projMarket.map((p) => [p.name, p.points]));
  // OUR values. Optional injury lever: discount by prior-season availability (avail = games/regWeeks),
  // modelling "pay less for injury-prone players". injuryLever=0 => baseline (no discount). Only OUR
  // team applies it (it's our strategy); the market/bots still bid on projMarket.
  // Price OUR book for the league actually under test (`lg`, which ff.ts builds from the SYNCED
  // config), not the hardcoded DEFAULT_VALUE_LEAGUE. For a 16-team $200 12-slot league the two are
  // identical -- which is exactly why this went unnoticed -- but for any other league the ARBITER
  // was valuing players for a different format than the live board (`ff.ts:767`) prices them for.
  // maxKDst likewise comes from the lever instead of the literal 2.
  const useValues = new Map(computeValues(seasonPoints.map((p) => ({ ...p, points: projUs.get(p.name) ?? 0 })), resolveValueLeague(lg), cfg.maxKDst ?? 2).map((v) => {
    const a = injuryLever ? (avail.get(v.name) ?? 1) : 1; // unknown players (e.g. rookies) => assume healthy
    return [v.name, Math.max(1, v.value * (1 - injuryLever * (1 - a)))] as [string, number];
  }));
  const picks = draftField(projMarket, useValues, cfg, seed, lg, { drainNom, greedyNom, botBook, homogeneous, botIdioSd: market.idioSd });
  const rosters: { name: string; pos: string; proj: number }[][] = Array.from({ length: lg.teams }, () => []);
  for (const p of picks) rosters[p.team].push({ name: p.name, pos: p.pos, proj: projMap.get(p.name) ?? 0 });

  // In-season LINEUP skill: our team (0) can set each week's lineup by a WEEKLY projection
  // (actual + forecast noise, sd ourWeeklySd) instead of the season average -> starts the right
  // players that week. Bots stay naive (season projection). Isolates the lineup-management edge.
  const ourPerGame = new Map([...projUs.entries()].map(([n, v]) => [n, v / 17])); // our weekly talent estimate
  const selFor = (t: number, wk: number): Map<string, number> | undefined => {
    const sd = t === 0 ? ourWeeklySd : botWeeklySd;
    if (sd == null) return undefined; // naive: start by season projection
    const m = new Map<string, number>();
    for (const p of rosters[t]) { const a = weekly.get(p.name)?.get(wk); if (a != null) m.set(p.name, Math.max(0, a * (1 + gauss(rngU) * sd))); }
    return m;
  };
  // FULL-SYSTEM: our team (0) uses the REAL lineup optimizer on OUR projection; others use the sel model.
  const wkS = (t: number, wk: number) => (realLineup && t === 0)
    ? realWeekScore(rosters[t], wk, weekly, lg, ourPerGame)
    : weekScore(rosters[t], wk, weekly, lg, selFor(t, wk));

  // In-season WAIVERS (our team): each week, using ONLY prior-week production (no lookahead), swap our
  // weakest player for the best-producing free agent whose trailing average clearly beats them. This
  // is the roster-churn edge -- a manager who works the wire upgrades over a stand-pat field.
  const posOf = new Map(projMarket.map((p) => [p.name, p.pos]));
  const drafted = new Set(picks.map((p) => p.name));
  const freeAgents = (ourWaivers || botChurn) ? [...weekly.keys()].filter((n) => !drafted.has(n) && posOf.has(n)) : [];
  // The minimum bodies a roster needs at each position to fill its mandatory starting slots. A
  // waiver rule that ignores this will happily drop a team's only quarterback for a fourth receiver
  // -- which no manager does, and which would make bot churn look worse than it is by breaking the
  // bots rather than by testing them.
  const MIN_AT_POS: Record<string, number> = {};
  for (const s of lg.slots) if (s !== "BE" && s !== "FLEX") MIN_AT_POS[s] = (MIN_AT_POS[s] ?? 0) + 1;
  const trailAvg = (name: string, uptoWk: number): { avg: number; g: number } => {
    let s = 0, g = 0; for (let w = 1; w < uptoWk; w++) { const p = weekly.get(name)?.get(w); if (p != null) { s += p; g++; } }
    return { avg: g ? s / g : 0, g };
  };
  // Rest-of-season per-game estimate (NO lookahead): shrink recent form toward preseason talent --
  // early weeks trust the draft projection, later weeks trust actuals. Stops us dropping a
  // slow-starting stud for a hot-hand free agent who regresses (naive trailing-avg churn LOSES).
  const rosPerGame = (name: string, wk: number): number => {
    const pre = (projMap.get(name) ?? 0) / 17;
    const { avg, g } = trailAvg(name, wk);
    if (g === 0) return pre;
    const w = Math.min(1, (wk - 1) / 9); // weight on actuals ramps to 1 by ~week 10
    return (1 - w) * pre + w * avg;
  };
  /**
   * ONE waiver attempt for ONE team. The rule is the conservative one our own team runs -- swap the
   * weakest rostered player for the best-producing free agent whose rest-of-season estimate CLEARLY
   * beats him -- with a legality guard the single-team version never needed.
   *
   * `--bot-churn` gives every bot the same rule, at the league's observed rate of about one add per
   * team per week. Until now the field stood pat all season while our team worked the wire, which
   * flatters us twice: we gain from churn and they never do. A standing-pat field is not a
   * conservative assumption, it is a wrong one -- this room averages ~15 adds per team per season.
   */
  const attemptWaiver = (team: number, wk: number) => {
    const posCount: Record<string, number> = {};
    for (const p of rosters[team]) posCount[p.pos] = (posCount[p.pos] ?? 0) + 1;
    const droppable = rosters[team].filter((p) => (posCount[p.pos] ?? 0) > (MIN_AT_POS[p.pos] ?? 0));
    if (!droppable.length) return;
    const weakest = droppable.map((p) => ({ p, ros: rosPerGame(p.name, wk) })).sort((a, b) => a.ros - b.ros)[0];
    if (!weakest) return;
    const fa = freeAgents.map((n) => ({ n, ros: rosPerGame(n, wk), g: trailAvg(n, wk).g }))
      .filter((x) => x.g >= 2).sort((a, b) => b.ros - a.ros)[0];
    if (!fa || !(fa.ros > weakest.ros + 3)) return;      // only a CLEAR rest-of-season upgrade
    rosters[team] = rosters[team].filter((p) => p !== weakest.p)
      .concat([{ name: fa.n, pos: posOf.get(fa.n)!, proj: projMap.get(fa.n) ?? fa.ros * 17 }]);
    freeAgents.splice(freeAgents.indexOf(fa.n), 1);
    freeAgents.push(weakest.p.name);
  };
  const runWaiver = (wk: number) => {
    if (wk < 3) return;
    if (ourWaivers) attemptWaiver(0, wk);
    if (!botChurn) return;
    // WAIVER PRIORITY ROTATES. Processing the teams in a fixed order would hand seat 1 the best free
    // agent every single week for twenty-five seasons, which is not a league rule anywhere and would
    // make one bot systematically strong. The rotation is deterministic in the week, so the pairing
    // with an arm that has churn off is preserved.
    for (let i = 0; i < lg.teams; i++) {
      const t = (i + wk) % lg.teams;
      if (t === 0) continue;                             // our team is handled by --waivers, above
      attemptWaiver(t, wk);
    }
  };

  const wins = new Array(lg.teams).fill(0);
  const totPts = new Array(lg.teams).fill(0);
  // SCHEDULE. Previously the field was reshuffled every week, so each opponent was an independent
  // uniform draw -- unbiased in expectation, but it capped nothing (you could draw the best roster
  // four times) and erased correlated schedule risk entirely (a hard division is a season-long tax
  // that independent draws average away). `divisions` builds standard divisional play instead:
  // 6 in-division + 8 cross. Seat assignment to divisions is randomised per season so our team (0)
  // is not permanently in the same division as the same bots.
  const sched = divisions > 0 ? buildSchedule(lg.teams, regWeeks, divisions) : null;
  let seat: number[] = [];
  if (sched) {
    seat = [...Array(lg.teams).keys()];
    for (let i = seat.length - 1; i > 0; i--) { const j = Math.floor(rngM() * (i + 1)); [seat[i], seat[j]] = [seat[j], seat[i]]; }
  }
  for (const [wi, wk] of REG_WEEKS.entries()) {
    runWaiver(wk); // process waivers before this week's games
    const scores = rosters.map((_, t) => wkS(t, wk));
    const games: [number, number][] = sched
      ? sched.weeks[wi].map(([a, b]) => [seat[a], seat[b]] as [number, number])
      : (() => {
        const order = [...Array(lg.teams).keys()];
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rngM() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
        const out: [number, number][] = [];
        for (let i = 0; i < lg.teams; i += 2) out.push([order[i], order[i + 1]]);
        return out;
      })();
    for (const [a, b] of games) {
      totPts[a] += scores[a]; totPts[b] += scores[b];
      if (scores[a] >= scores[b]) wins[a]++; else wins[b]++;
    }
  }
  // SEEDING. `sched.divisionOf` is indexed by SCHEDULE SLOT, and seats are shuffled into slots above
  // so our team is not permanently in the same division -- so the map has to be inverted before it
  // can be read as "team t's division". Getting that backwards would put every team in the wrong
  // division while still producing a plausible bracket, which is the kind of wrong that never fails.
  const divisionOfTeam = sched ? (() => { const m = new Array(lg.teams).fill(0); seat.forEach((team, slot) => { m[team] = sched.divisionOf[slot]; }); return m; })() : undefined;
  const standings = [...Array(lg.teams).keys()].map((t) => ({ wins: wins[t], pts: totPts[t] }));
  const seeds = seedField(standings, playoffTeams, seeding, divisionOfTeam);
  const madePlayoffs = seeds.includes(0);
  const beat = (a: number, b: number, wk: number) => (wkS(a, wk) >= wkS(b, wk) ? a : b);
  const champ = playoffWinner(seeds, beat, regWeeks + 1, playoffReseed); // playoffs begin the week after the regular season
  return { champ: champ === 0, madePlayoffs, wins: wins[0], regPoints: Math.round(totPts[0]) };
}
