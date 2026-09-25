// THE WAIVER DECISION REPLAY -- what the copilot's waiver pricing would have done, week by week, on
// this league's real rosters and free-agent pools, scored on what actually happened.
//
// Called from `scripts/season-calibration.mjs --waiver-backtest`, which builds each historical week's
// simulator context (real rosters, blind projections, schedule, settled standings) with the SAME
// `buildSeason` the season gate uses -- so the replay and the gate cannot disagree about a week.
//
// ARMS, one decision per (season, checkpoint week, team-as-us):
//   STAND     no move.
//   SIM       today's copilot (D40 coupling on, D41 usage-corrected rates for rostered men AND free
//             agents, shortlist on the rate): the (add, drop) with the largest mean playoff-probability
//             gain over paired seeds, taken only if it clears the paired floor 2.9*SE.
//   SIM_OLD   the copilot before 2026-09-25: coupling off, plain D18 blend for rostered men, free
//             agents at their preseason line, shortlist on the preseason line.
//   RATE      a simple rule: the free agent with the best usage-corrected rate replaces the lowest-rate
//             legal drop if the gain is >= RATE_MIN pts/g.
//   ANTI      NEGATIVE CONTROL: drop our best man for the worst free agent at his position. Must lose
//             heavily, or the scorer cannot see a move's value.
//   ORACLE    hindsight ceiling: the candidate move with the best REALISED gain (or stand). Scale only.
//
// SCORING IS OUTCOMES ONLY. Each week from W to the end of the regular season our lineup is chosen by
// the point-in-time usage rate among men who were available (not on bye, not ruled out as of that
// week), and scored on their ACTUAL points; opponents keep their actual started points. Every arm uses
// the same selection rule, so a difference between arms is the MOVE, not the lineup rule. Reported:
// realised points gained, and made-playoffs recomputed with those points against the real schedule.
import { simulateSeasons, rosterGaps } from "../../src/draft/season.ts";
import { optimalLineup } from "../../src/inseason/lineup.ts";
import { nameKey } from "../../src/draft/values.ts";
import { slotAdmits } from "../../src/draft/slots.ts";
import { expectedLineupPoints, availByPosFrom } from "../../src/inseason/expectedLineup.ts";

const RATE_MIN = 1.0;
const SKILL = ["QB", "RB", "WR", "TE"];

/** season -> sk -> week -> { pts, bye, out } -- the outcome table, read once per season. */
export function loadFuture(db, season) {
  const f = new Map();
  for (const r of db.prepare(
    "SELECT player_sk, week, pts, is_bye, inj_out FROM feat_player_week_model WHERE season = ? AND player_sk IS NOT NULL",
  ).all(season)) {
    const k = String(r.player_sk);
    (f.get(k) ?? f.set(k, new Map()).get(k)).set(r.week, { pts: r.pts ?? 0, bye: !!r.is_bye, out: !!r.inj_out });
  }
  return f;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

export function replayWeek(o) {
  const { db, league, s, season, W, vm, baseOpts, trials, seeds, nAdds, nDrops, future, noSim = false } = o;
  const flexOk = baseOpts.flexOk;
  const N = s.teams.length;

  // ---- who is who, and every man's two rates ----
  const skOfName = new Map(s.skOf);                        // projection name -> player_sk (rostered)
  const pool = [];
  for (const r of db.prepare(
    "SELECT player_sk, name, pos FROM fact_fa_pool_week WHERE league_id = ? AND season = ? AND week = ? AND player_sk IS NOT NULL",
  ).all(league, season, W - 1)) {
    const pr = s.lookup(r.name, r.pos);
    if (!pr || s.rostered.has(pr.name)) continue;
    if (!s.slots.some((sl) => sl === pr.pos) && !(SKILL.includes(pr.pos) && s.slots.includes("FLEX"))) continue;
    const sk = String(r.player_sk);
    if (future.get(sk)?.get(W)?.out) continue;             // ruled out AS OF week W: not claimable
    const teamAbbr = s.nflTeam.get(`${nameKey(pr.name)}|${pr.pos}`) ?? "";
    const line = pr.mean / 17;
    const rf = s.rateFor(sk, line, pr.pos);
    skOfName.set(pr.name, sk);
    pool.push({ name: pr.name, pos: pr.pos, proj: pr.mean, team: teamAbbr, bye: teamAbbr ? (s.bye.get(teamAbbr) ?? null) : null,
      sk, rNew: rf.usage, rOld: line });
  }
  const rNewOf = (p) => (s.rosOfUsage.has(p.name) ? s.rosOfUsage.get(p.name) : p.rosNew ?? p.proj / 17);
  const rOldOf = (p) => (s.rosOf.has(p.name) ? s.rosOf.get(p.name) : p.rosOld ?? p.proj / 17);
  const withRates = (roster, arm) => roster.map((p) => ({ ...p, rosPerGame: arm === "old" ? rOldOf(p) : rNewOf(p) }));
  const faAsPlayer = (f) => ({ name: f.name, pos: f.pos, proj: f.proj, team: f.team, bye: f.bye, rosNew: f.rNew, rosOld: f.rOld });

  // ---- realised scoring ----
  // STREAMING FILL (2026-09-25). A slot the roster cannot fill in a week is filled by a STREAMER: the
  // second-best free agent (by rate, as of the decision week) at a position the slot admits who plays
  // that week, scored on HIS ACTUAL points -- `simContext`'s replacement rule, realised. The first
  // version of this scorer scored an empty slot ZERO, which no manager takes: it rewarded carrying a
  // spare kicker for a bye with a whole kicker's points, and EXP10 was admitted against it. Both are
  // recorded -- `weekly` (streaming fill, the arbiter now) and `weekly0` (the old zero rule).
  const poolByPos = new Map();
  for (const f of pool) (poolByPos.get(f.pos) ?? poolByPos.set(f.pos, []).get(f.pos)).push(f);
  for (const l of poolByPos.values()) l.sort((a, b) => b.rNew - a.rNew);
  const streamerPts = (slot, w, onRoster, taken) => {
    let best = null;
    for (const pos of slotAdmits(slot, flexOk)) {
      const avail = (poolByPos.get(pos) ?? []).filter((f) => {
        if (onRoster.has(f.name) || taken.has(f.name)) return false;
        const fw = future.get(f.sk)?.get(w);
        return !!fw && !fw.bye && !fw.out;
      });
      const pick = avail[1] ?? avail[0];                       // second-best: fifteen others stream too
      if (pick && (!best || pick.rNew > best.rNew)) best = pick;
    }
    if (!best) return 0;
    taken.add(best.name);
    return future.get(best.sk)?.get(w)?.pts ?? 0;
  };
  const realisedBoth = (roster) => {
    const weekly = [], weekly0 = [];
    const onRoster = new Set(roster.map((p) => p.name));
    for (let w = W; w <= s.reg; w++) {
      const players = roster.map((p) => {
        const sk = skOfName.get(p.name);
        const fw = sk ? future.get(sk)?.get(w) : null;
        return { name: p.name, pos: p.pos, proj: rNewOf(p), available: !!fw && !fw.bye && !fw.out, _pts: fw?.pts ?? 0 };
      });
      const lu = optimalLineup(players, s.slots, flexOk);
      const byName = new Map(players.map((p) => [p.name, p._pts]));
      const got = lu.starters.reduce((a, st) => a + (byName.get(st.name) ?? 0), 0);
      const taken = new Set();
      const fill = lu.starters.filter((st) => st.name === "(empty)").reduce((a, st) => a + streamerPts(st.slot, w, onRoster, taken), 0);
      weekly0.push(got);
      weekly.push(got + fill);
    }
    return { weekly, weekly0 };
  };
  const realised = (roster) => realisedBoth(roster).weekly;
  const actualStarted = new Map();
  for (const r of db.prepare("SELECT week, team_id, started_pts FROM fact_lineup_week WHERE league_id = ? AND season = ? AND week >= ?").all(league, season, W)) {
    actualStarted.set(`${r.week}|${r.team_id}`, r.started_pts ?? 0);
  }
  const madePlayoffs = (i, ourWeekly) => {
    const wins = s.played ? [...s.played.wins] : s.teams.map(() => 0);
    const pts = s.played ? [...s.played.pts] : s.teams.map(() => 0);
    for (let w = W; w <= s.reg; w++) {
      const sc = s.teams.map((t, j) => (j === i ? ourWeekly[w - W] : (actualStarted.get(`${w}|${t.id}`) ?? 0)));
      sc.forEach((x, j) => { pts[j] += x; });
      for (const [a, b] of s.weeks[w - 1]) { if (sc[a] >= sc[b]) wins[a]++; else wins[b]++; }
    }
    const order = s.teams.map((_, j) => j).sort((a, b) => wins[b] - wins[a] || pts[b] - pts[a]);
    return order.indexOf(i) < s.field ? 1 : 0;
  };

  // ---- the simulator, paired by seed, one base per arm shared by every team ----
  const teamsFor = (arm, i = -1, roster = null) => s.teams.map((t, j) => ({ ...t, roster: withRates(j === i ? roster : t.roster, arm) }));
  const optsFor = (arm, seed) => ({ ...baseOpts, trials, seed, ...(arm === "old" ? { handcuffCoupling: null } : {}) });
  const base = noSim ? { new: [], old: [] } : {
    new: seeds.map((sd) => simulateSeasons(teamsFor("new"), s.weeks, vm, optsFor("new", sd))),
    old: seeds.map((sd) => simulateSeasons(teamsFor("old"), s.weeks, vm, optsFor("old", sd))),
  };
  const probOf = (odds, id) => odds.find((x) => x.id === id)?.playoffs ?? 0;

  const dedicated = (pos) => s.slots.filter((sl) => sl === pos).length;
  const legal = (i, roster) => rosterGaps([{ id: s.teams[i].id, roster }], s.slots, flexOk).length === 0;

  const out = [];
  for (let i = 0; i < N; i++) {
    const t = s.teams[i];
    const mine = t.roster;
    const standBoth = realisedBoth(mine);
    const standWeekly = standBoth.weekly;
    const standPts = standWeekly.reduce((a, x) => a + x, 0);
    const standPts0 = standBoth.weekly0.reduce((a, x) => a + x, 0);
    const standPo = madePlayoffs(i, standWeekly);
    const score = (roster) => {
      const b = realisedBoth(roster);
      return { dPts: b.weekly.reduce((a, x) => a + x, 0) - standPts, dPts0: b.weekly0.reduce((a, x) => a + x, 0) - standPts0, dPo: madePlayoffs(i, b.weekly) - standPo };
    };

    const candidatesFor = (arm) => {
      const r = arm === "old" ? (f) => f.rOld : (f) => f.rNew;
      const vor = (f) => r(f) - (s.replacement[f.pos] ?? 0);
      const list = [...pool].sort((a, b) => vor(b) - vor(a)).slice(0, nAdds);
      if (arm === "new") {   // D41's depth-need admission (skill positions where we have no depth)
        for (const pos of SKILL) {
          if (mine.filter((p) => p.pos === pos).length > dedicated(pos)) continue;
          const teams = new Set(mine.filter((p) => p.pos === pos).map((p) => p.team));
          for (const f of [...pool].filter((f) => f.pos === pos && !teams.has(f.team)).sort((a, b) => r(b) - r(a)).slice(0, 2)) {
            if (!list.includes(f)) list.push(f);
          }
        }
      }
      return list;
    };
    const dropsFor = (arm, add) => {
      const rate = arm === "old" ? rOldOf : rNewOf;
      const res = [];
      for (const d of [...mine].sort((a, b) => rate(a) - rate(b))) {
        if (res.length >= nDrops) break;
        const after = mine.filter((p) => p !== d).concat([faAsPlayer(add)]);
        if (legal(i, after)) res.push({ d, after });
      }
      return res;
    };
    const simArm = (arm) => {
      const moves = [];
      for (const add of candidatesFor(arm)) {
        for (const { d, after } of dropsFor(arm, add)) {
          const deltas = seeds.map((sd, k) => {
            const odds = simulateSeasons(teamsFor(arm, i, after), s.weeks, vm, optsFor(arm, sd));
            return 100 * (probOf(odds, t.id) - probOf(base[arm][k], t.id));
          });
          const m = mean(deltas);
          const se = Math.sqrt(deltas.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, deltas.length - 1)) / Math.sqrt(deltas.length);
          const floor = 2.9 * Math.max(se, (100 / trials) / Math.sqrt(seeds.length));
          moves.push({ add: add.name, drop: d.name, after, delta: m, floor });
        }
      }
      return moves;
    };
    const rowOf = (arm, mv, extra = {}) => {
      const sc = mv ? score(mv.after) : { dPts: 0, dPts0: 0, dPo: 0 };
      out.push({ season, W, team: t.id, arm, moved: !!mv, add: mv?.add ?? null, drop: mv?.drop ?? null, simDelta: mv?.delta ?? null, ...sc, ...extra });
    };

    // EXP -- OPTION 3 (2026-09-25): rank a claim by the EXPECTED rest-of-season STARTING-LINEUP points
    // it adds, from point-in-time information only: each remaining week the lineup is picked on the
    // usage rate among men not on bye (the schedule is known) and not ruled out now (week W only --
    // nobody knows week W+3's injury report), and the starters' RATES are summed. No simulator, no
    // playoff probability: the quantity the realised scorer rewards, predicted instead of observed.
    // Thresholds pre-registered as three arms (EXP0 / EXP5 / EXP10 points over the rest of the season).
    {
      const outNow = (p) => { const sk = skOfName.get(p.name); return !!(sk && future.get(sk)?.get(W)?.out); };
      const expPts = (roster) => {
        let tot = 0;
        for (let w = W; w <= s.reg; w++) {
          const players = roster.map((p) => ({ name: p.name, pos: p.pos, proj: rNewOf(p), available: p.bye !== w && !(w === W && outNow(p)) }));
          tot += optimalLineup(players, s.slots, flexOk).totalProj;
        }
        return tot;
      };
      const before = expPts(mine);
      let best = null;
      for (const add of [...pool].sort((a, b) => b.rNew - a.rNew).slice(0, 20)) {
        for (const d of [...mine].sort((a, b) => rNewOf(a) - rNewOf(b)).slice(0, 4)) {
          const after = mine.filter((p) => p !== d).concat([faAsPlayer(add)]);
          if (!legal(i, after)) continue;
          const gain = expPts(after) - before;
          if (!best || gain > best.delta) best = { add: add.name, drop: d.name, after, delta: gain };
        }
      }
      for (const [arm, th] of [["EXP0", 0], ["EXP5", 5], ["EXP10", 10]]) rowOf(arm, best && best.delta > th ? best : null);
    }
    // EXPL / EXPF (2026-09-25) -- the SHARED implementation (src/inseason/expectedLineup.ts), the one
    // the live verb calls, over the live verb's candidate breadth: top 20 free agents by rate x our 4
    // lowest-rate men PLUS the like-for-like swap (our weakest man at the add's position).
    //   EXPL  the live D42 arithmetic (byes only; an empty slot scores 0) -- EXP plus the swap.
    //   EXPF  the full model: future-week injuries at the tier-0 healthy rate (the bench covers a
    //         missed start) and an unfillable slot at the replacement level (streaming).
    // Thresholds pre-registered: 0 / 5 / 10 expected points over the rest of the regular season.
    {
      const availByPos = availByPosFrom(vm);
      const toExp = (roster) => roster.map((p) => ({ name: p.name, pos: p.pos, rate: rNewOf(p), bye: p.bye ?? null, playRate: (() => { const sk = skOfName.get(p.name) ?? p.sk; return sk && future.get(sk)?.get(W)?.out ? 0 : 1; })() }));
      for (const [tag, full] of [["EXPL", false], ["EXPF", true]]) {
        const eo = { slots: s.slots, flexOk, from: W, to: s.reg, firstWk: W, ...(full ? { availByPos, replacement: s.replacement, draws: 48 } : {}) };
        const before = expectedLineupPoints(toExp(mine), eo);
        let best = null;
        for (const add of [...pool].sort((a, b) => b.rNew - a.rNew).slice(0, 20)) {
          const lows = [...mine].sort((a, b) => rNewOf(a) - rNewOf(b)).slice(0, 4);
          const same = [...mine].filter((m) => m.pos === add.pos).sort((a, b) => rNewOf(a) - rNewOf(b))[0];
          for (const d of same && !lows.includes(same) ? [...lows, same] : lows) {
            const after = mine.filter((p) => p !== d).concat([faAsPlayer(add)]);
            if (!legal(i, after)) continue;
            const gain = expectedLineupPoints(toExp(after), eo) - before;
            if (!best || gain > best.delta) best = { add: add.name, drop: d.name, after, delta: gain };
          }
        }
        for (const th of [0, 5, 10]) rowOf(`${tag}${th}`, best && best.delta > th ? best : null);
      }
    }
    // HINDSIGHT -- THE POSITIVE CONTROL for the scorer (2026-09-25): over the same candidate breadth
    // as EXPL/EXPF, the move with the best REALISED gain (or stand). A scorer that cannot show THIS
    // gaining points cannot show any rule gaining points, and a null for every rule would mean nothing.
    {
      let best = null, bestPts = 0;
      for (const add of [...pool].sort((a, b) => b.rNew - a.rNew).slice(0, 20)) {
        const lows = [...mine].sort((a, b) => rNewOf(a) - rNewOf(b)).slice(0, 4);
        const same = [...mine].filter((m) => m.pos === add.pos).sort((a, b) => rNewOf(a) - rNewOf(b))[0];
        for (const d of same && !lows.includes(same) ? [...lows, same] : lows) {
          const after = mine.filter((p) => p !== d).concat([faAsPlayer(add)]);
          if (!legal(i, after)) continue;
          const sc = score(after);
          if (sc.dPts > bestPts) { bestPts = sc.dPts; best = { add: add.name, drop: d.name, after, delta: null }; }
        }
      }
      rowOf("HINDSIGHT", best);
    }
    // ANTI -- THE NEGATIVE CONTROL: drop our BEST man (highest rate) for the WORST free agent at his
    // position (same position, so the roster stays legal). Unambiguously harmful; the scorer must see
    // it as a large loss. (The simulator's worst CANDIDATE was tried first and is not a control: every
    // candidate only swaps a low bench body, so its worst move gained points in the 2022 wk7 probe.)
    {
      const top = [...mine].sort((a, b) => rNewOf(b) - rNewOf(a))[0];
      const worst = top ? [...pool].filter((f) => f.pos === top.pos).sort((a, b) => a.rNew - b.rNew)[0] : null;
      rowOf("ANTI", top && worst ? { add: worst.name, drop: top.name, after: mine.filter((p) => p !== top).concat([faAsPlayer(worst)]), delta: null } : null);
    }
    // RATE: best free agent by usage rate vs the lowest-rate legal drop.
    {
      const bestFa = [...pool].sort((a, b) => b.rNew - a.rNew).find((f) => dropsFor("new", f).length);
      const dr = bestFa ? dropsFor("new", bestFa)[0] : null;
      const mv = bestFa && dr && bestFa.rNew - rNewOf(dr.d) >= RATE_MIN ? { add: bestFa.name, drop: dr.d.name, after: dr.after, delta: null } : null;
      rowOf("RATE", mv);
    }
    if (noSim) { rowOf("STAND", null); continue; }

    const movesNew = simArm("new");
    const bestNew = movesNew.length ? movesNew.reduce((a, b) => (b.delta > a.delta ? b : a)) : null;
    rowOf("SIM", bestNew && bestNew.delta > bestNew.floor ? bestNew : null);
    const movesOld = simArm("old");
    const bestOld = movesOld.length ? movesOld.reduce((a, b) => (b.delta > a.delta ? b : a)) : null;
    rowOf("SIM_OLD", bestOld && bestOld.delta > bestOld.floor ? bestOld : null);
    // ORACLE: best realised gain over every simulated candidate move.
    {
      let best = null, bestPts = 0;
      for (const mv of movesNew) { const sc = score(mv.after); if (sc.dPts > bestPts) { bestPts = sc.dPts; best = mv; } }
      rowOf("ORACLE", best);
    }
    rowOf("STAND", null);
  }
  return out;
}
