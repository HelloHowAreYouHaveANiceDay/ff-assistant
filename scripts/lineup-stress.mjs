// LINEUP STRESS TEST -- the fuzz, the perturbation and the baseline drivers for M3.
//
//   node --import tsx scripts/lineup-stress.mjs fuzz     [--n 5000] [--seed 1]
//   node --import tsx scripts/lineup-stress.mjs perturb  [--n 400]  [--seed 1]
//   node --import tsx scripts/lineup-stress.mjs report               # fuzz + perturb, one summary
//
// WHY A SECOND IMPLEMENTATION OF THE RULES LIVES HERE, and why that is the point.
//
// `optimalLineup` is a matroid greedy with augmenting paths. It is provably optimal ON PAPER, which
// is exactly the kind of claim this repo has been burned by (CLAUDE.md: "a producer that ships its
// own validator grades its own homework"). So the reference below is deliberately NOT built out of
// the code under test:
//
//   * ELIGIBILITY is re-derived from a hand-written table (`refAdmits`) rather than imported from
//     src/draft/slots.ts. If the two disagree the fuzz says so by name -- a disagreement is a
//     FINDING about the slot vocabulary, not a crash.
//   * The ASSIGNMENT is an exact dynamic program over (slot index, used-player bitmask). It is
//     exponential in the roster and that is fine: rosters are 10-16 men, and an exact answer that
//     is slow is worth more here than a fast one that shares the optimizer's idea of optimal.
//
// WHAT "OPTIMAL" MEANS, stated so the comparison is not vacuous. `optimalLineup` seats every
// available player it legally can (Kuhn's algorithm produces a MAXIMUM matching whatever the
// weights), and then takes the best such seating. So the reference maximises the pair
// (slots filled, total projection) LEXICOGRAPHICALLY, not the total alone. The difference is only
// visible with negative projections, where a smaller lineup would score higher -- and filling the
// slot is the right answer for a real lineup, because a slot you leave empty scores zero and the
// platform will not let you leave it empty anyway. That choice is asserted rather than assumed:
// `fuzzOptimizer` reports any case where max-weight and max-cardinality disagree.
import { readFileSync } from "node:fs";
import { optimalLineup } from "../src/inseason/lineup.js";
import { isBenchSlot, slotAdmits } from "../src/draft/slots.js";

// ---------------------------------------------------------------------------------------------
// A seeded RNG. Every failure this fuzz reports must be reproducible from its seed alone.
// ---------------------------------------------------------------------------------------------
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// THE INDEPENDENT ELIGIBILITY TABLE. Hand-written from the platforms' own slot vocabularies, on
// purpose -- see the header. `slotAdmits` is cross-checked against it, never used by it.
// ---------------------------------------------------------------------------------------------
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const REF_TABLE = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DST: ["DST"],
  DEF: ["DST"], "D/ST": ["DST"],
  FLEX: ["RB", "WR", "TE"], "W/R/T": ["RB", "WR", "TE"], "RB/WR/TE": ["RB", "WR", "TE"], WRT: ["RB", "WR", "TE"],
  OP: ["QB", "RB", "WR", "TE"], SUPERFLEX: ["QB", "RB", "WR", "TE"], SF: ["QB", "RB", "WR", "TE"],
  "Q/W/R/T": ["QB", "RB", "WR", "TE"], "QB/RB/WR/TE": ["QB", "RB", "WR", "TE"],
};
const TOK = { Q: "QB", W: "WR", R: "RB", T: "TE", K: "K", D: "DST" };

/** What this slot admits, derived here and nowhere else. `flexOk` overrides the literal FLEX only --
 *  the same league-scoped rule src/draft/slots.ts documents, restated independently so a change to
 *  that rule shows up as a fuzz disagreement rather than as agreement by construction. */
export function refAdmits(slot, flexOk) {
  const s = String(slot).trim().toUpperCase();
  if (s === "FLEX" && flexOk && [...flexOk].length) return [...flexOk];
  if (REF_TABLE[s]) return REF_TABLE[s];
  if (s.includes("/")) {
    const out = [];
    for (const t of s.split("/").map((x) => x.trim())) {
      const p = POS.includes(t) ? t : TOK[t];
      if (p && !out.includes(p)) out.push(p);
    }
    if (out.length) return out;
  }
  return [s];
}

export function refIsBench(slot) {
  return /^(BE|BENCH|BN|IR|ER)$/i.test(String(slot).trim());
}

// ---------------------------------------------------------------------------------------------
// THE EXACT REFERENCE: a DP over (slot index, used-player mask), lexicographic on (filled, points).
// ---------------------------------------------------------------------------------------------
export function bruteForceBest(players, slots, flexOk) {
  const start = slots.filter((s) => !refIsBench(s));
  const avail = players.map((p, i) => ({ p, i })).filter((x) => x.p.available);
  if (avail.length > 20) throw new Error(`bruteForceBest: ${avail.length} available players is too many to enumerate`);
  const admits = start.map((s) => refAdmits(s, flexOk));
  const eligOf = (p) => (p.eligible && p.eligible.length ? p.eligible : [p.pos]);
  const ok = start.map((_, s) => avail.map((x) => eligOf(x.p).some((e) => admits[s].includes(String(e).trim().toUpperCase()))));

  const memo = new Map();
  const rec = (s, mask) => {
    if (s === start.length) return { filled: 0, pts: 0, pick: [] };
    const key = s * (1 << avail.length) + mask;
    const hit = memo.get(key);
    if (hit) return hit;
    // Leaving the slot empty is always legal; it just never wins on the cardinality key when a
    // legal seat exists.
    let best = { ...rec(s + 1, mask), pick: [-1, ...rec(s + 1, mask).pick] };
    best = { filled: best.filled, pts: best.pts, pick: best.pick };
    for (let j = 0; j < avail.length; j++) {
      if (mask & (1 << j)) continue;
      if (!ok[s][j]) continue;
      const sub = rec(s + 1, mask | (1 << j));
      const cand = { filled: sub.filled + 1, pts: sub.pts + avail[j].p.proj, pick: [j, ...sub.pick] };
      if (cand.filled > best.filled || (cand.filled === best.filled && cand.pts > best.pts + 1e-9)) best = cand;
    }
    memo.set(key, best);
    return best;
  };
  const r = rec(0, 0);
  return {
    filled: r.filled,
    pts: r.pts,
    assignment: r.pick.map((j, s) => ({ slot: start[s], name: j < 0 ? "(empty)" : avail[j].p.name, proj: j < 0 ? 0 : avail[j].p.proj })),
  };
}

/** The same DP with the CARDINALITY key dropped -- max points alone. Used only to report when the
 *  two objectives disagree (i.e. when a negative projection makes an empty slot "better"). */
export function bruteForceMaxPoints(players, slots, flexOk) {
  const start = slots.filter((s) => !refIsBench(s));
  const avail = players.map((p) => p).filter((p) => p.available);
  const admits = start.map((s) => refAdmits(s, flexOk));
  const eligOf = (p) => (p.eligible && p.eligible.length ? p.eligible : [p.pos]);
  const ok = start.map((_, s) => avail.map((p) => eligOf(p).some((e) => admits[s].includes(String(e).trim().toUpperCase()))));
  const memo = new Map();
  const rec = (s, mask) => {
    if (s === start.length) return 0;
    const key = s * (1 << avail.length) + mask;
    if (memo.has(key)) return memo.get(key);
    let best = rec(s + 1, mask);
    for (let j = 0; j < avail.length; j++) {
      if (mask & (1 << j)) continue;
      if (!ok[s][j]) continue;
      const cand = rec(s + 1, mask | (1 << j)) + avail[j].proj;
      if (cand > best) best = cand;
    }
    memo.set(key, best);
    return best;
  };
  return rec(0, 0);
}

// ---------------------------------------------------------------------------------------------
// THE TEMPLATES. Every shape the brief names, plus the two real ones.
// ---------------------------------------------------------------------------------------------
export const TEMPLATES = {
  espn: { slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "DST", "K", "BE", "BE", "BE", "BE", "BE", "BE", "BE"], flexOk: ["RB", "WR", "TE"] },
  yahooSuperflex: { slots: ["QB", "RB", "RB", "WR", "WR", "TE", "W/R/T", "Q/W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "IR", "IR"], flexOk: ["RB", "WR", "TE"] },
  singleFlex: { slots: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "K", "DST", "BE", "BE", "BE"], flexOk: ["RB", "WR", "TE"] },
  twoFlex: { slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DST", "BE", "BE"], flexOk: ["RB", "WR", "TE"] },
  noKicker: { slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BE", "BE", "BE"], flexOk: ["RB", "WR", "TE"] },
  flexHeavy: { slots: ["QB", "FLEX", "FLEX", "FLEX", "SUPERFLEX", "BE", "BE"], flexOk: ["RB", "WR", "TE"] },
  slashForms: { slots: ["QB", "RB/WR", "WR/TE", "OP", "K", "BE", "BE"], flexOk: ["RB", "WR", "TE"] },
  wideFlex: { slots: ["QB", "RB", "WR", "FLEX", "FLEX"], flexOk: ["RB", "WR", "TE", "QB"] }, // a league that EDITED flex_ok
  starved: { slots: ["QB", "QB", "RB", "RB", "RB", "WR", "WR", "WR", "TE", "K", "DST", "BE"], flexOk: ["RB", "WR", "TE"] },
};

/** One random roster. The distributions are chosen to HIT the hard cases often, not to look like a
 *  real roster: ties are frequent (projections are quantised), zeros and negatives appear, dual
 *  eligibility appears, and the roster is often too SHORT to fill the template. */
export function makeRoster(rand, opts = {}) {
  const n = opts.n ?? 4 + Math.floor(rand() * 13);
  const out = [];
  for (let i = 0; i < n; i++) {
    const pos = POS[Math.floor(rand() * POS.length)];
    const r = rand();
    // Quantised to 0.5 so ties are common -- a tie-break bug hides completely under continuous draws.
    let proj = Math.round(rand() * 30 * 2) / 2;
    if (r < 0.10) proj = 0;
    else if (r < 0.16) proj = -Math.round(rand() * 6 * 2) / 2;   // negative: a DST can go negative
    else if (r < 0.30) proj = Math.round(rand() * 6) * 2;        // a coarse grid: many exact ties
    const p = { name: `P${i}`, pos, proj, available: rand() > (opts.outRate ?? 0.25) };
    // Dual eligibility, roughly as often as a real board carries it, plus an aggressive tail.
    if (rand() < (opts.dualRate ?? 0.25) && pos !== "K" && pos !== "DST") {
      const other = ["RB", "WR", "TE", "QB"][Math.floor(rand() * 4)];
      p.eligible = other === pos ? [pos] : [pos, other];
    }
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// AXIS 1 -- OPTIMALITY AND LEGALITY.
// ---------------------------------------------------------------------------------------------
/** `optimizer` exists ONLY so the fuzz can be fault-injected: hand it a knowingly-wrong assigner
 *  (the old slot-order greedy) and every assertion below must go red. A checker nobody has watched
 *  fail is indistinguishable from a checker that is not connected. */
export function checkOnce(players, slots, flexOk, optimizer = optimalLineup) {
  const res = optimizer(players, slots, flexOk);
  const ref = bruteForceBest(players, slots, flexOk);
  const problems = [];

  const start = slots.filter((s) => !refIsBench(s));
  // (a) SHAPE: one starter row per starting slot, in template order.
  if (res.starters.length !== start.length) problems.push(`starter count ${res.starters.length} != ${start.length}`);
  for (let i = 0; i < Math.min(res.starters.length, start.length); i++) {
    if (res.starters[i].slot !== start[i]) problems.push(`slot ${i} is ${res.starters[i].slot}, template says ${start[i]}`);
  }

  // (b) LEGALITY: every seated man is eligible for his slot, is available, and appears once.
  const byName = new Map(players.map((p) => [p.name, p]));
  const seen = new Set();
  let filled = 0;
  for (const s of res.starters) {
    if (s.name === "(empty)") continue;
    filled++;
    const p = byName.get(s.name);
    if (!p) { problems.push(`starter ${s.name} is not on the roster`); continue; }
    if (seen.has(s.name)) problems.push(`${s.name} started twice`);
    seen.add(s.name);
    if (!p.available) problems.push(`ILLEGAL: ${s.name} is unavailable and was started at ${s.slot}`);
    const admits = refAdmits(s.slot, flexOk);
    const elig = p.eligible && p.eligible.length ? p.eligible : [p.pos];
    if (!elig.some((e) => admits.includes(e))) problems.push(`ILLEGAL: ${s.name} (${elig.join("/")}) at ${s.slot} which admits ${admits.join("/")}`);
  }

  // (c) OPTIMALITY: same number of slots filled, same total, to the rounding the result publishes.
  if (filled !== ref.filled) problems.push(`filled ${filled} slots, the exact reference fills ${ref.filled}`);
  const got = res.starters.reduce((a, x) => a + x.proj, 0);
  if (Math.abs(got - ref.pts) > 1e-6) problems.push(`total ${got.toFixed(3)} != optimal ${ref.pts.toFixed(3)}`);

  // (d) The BENCH is exactly the complement, and nobody is lost or duplicated.
  const benchNames = res.bench.map((b) => b.name);
  if (benchNames.length + filled !== players.length) problems.push(`bench ${benchNames.length} + started ${filled} != roster ${players.length}`);

  // (e) An EMPTY slot must be genuinely unfillable -- nobody available, eligible and unused.
  for (const s of res.starters) {
    if (s.name !== "(empty)") continue;
    const admits = refAdmits(s.slot, flexOk);
    const free = players.filter((p) => p.available && !seen.has(p.name) &&
      (p.eligible && p.eligible.length ? p.eligible : [p.pos]).some((e) => admits.includes(e)));
    if (free.length) problems.push(`${s.slot} left empty while ${free[0].name} was available, eligible and benched`);
  }

  // (f) The slot VOCABULARY: our independent table vs src/draft/slots.ts, on every token in play.
  for (const s of slots) {
    const mineBench = refIsBench(s), theirsBench = isBenchSlot(s);
    if (mineBench !== theirsBench) problems.push(`VOCAB: isBenchSlot("${s}")=${theirsBench}, reference says ${mineBench}`);
    if (mineBench) continue;
    const a = refAdmits(s, flexOk).join(","), b = slotAdmits(s, flexOk).join(",");
    if (a !== b) problems.push(`VOCAB: slotAdmits("${s}")=[${b}], reference says [${a}]`);
  }

  return { res, ref, problems };
}

/**
 * THE FAULT INJECTION for the fuzz itself: the pre-matroid algorithm, a slot-order greedy. It is
 * legal but not optimal, so `checkOnce` must reject it on rosters with overlapping eligibility. If
 * this ever stops producing failures, the fuzz has stopped measuring optimality.
 */
export function greedyBySlotOrder(players, slots, flexOk) {
  const start = slots.filter((s) => !refIsBench(s));
  const used = new Set();
  const starters = [];
  for (const slot of start) {
    const admits = refAdmits(slot, flexOk);
    let pick = null;
    for (const p of players) {
      if (!p.available || used.has(p)) continue;
      const elig = p.eligible && p.eligible.length ? p.eligible : [p.pos];
      if (!elig.some((e) => admits.includes(e))) continue;
      if (!pick || p.proj > pick.proj) pick = p;
    }
    if (pick) { used.add(pick); starters.push({ slot, name: pick.name, pos: pick.pos, proj: pick.proj }); }
    else starters.push({ slot, name: "(empty)", pos: slot, proj: 0 });
  }
  const bench = players.filter((p) => !used.has(p)).map((p) => ({ name: p.name, pos: p.pos, proj: p.proj, available: p.available }));
  return { starters, bench, totalProj: starters.reduce((a, x) => a + x.proj, 0), flags: [] };
}

export function fuzzOptimizer({ n = 5000, seed = 1, templates = Object.keys(TEMPLATES), optimizer = optimalLineup } = {}) {
  const failures = [];
  const cardinalityConflicts = [];
  let cases = 0;
  for (const tname of templates) {
    const t = TEMPLATES[tname];
    const rand = rng(seed + tname.length * 7919);
    for (let i = 0; i < n; i++) {
      // Keep the exact DP tractable: cap the AVAILABLE count, never the roster shape.
      let players = makeRoster(rand, {});
      while (players.filter((p) => p.available).length > 16) players = makeRoster(rand, {});
      cases++;
      const { problems, ref } = checkOnce(players, t.slots, t.flexOk, optimizer);
      if (problems.length) failures.push({ template: tname, seed, i, problems, players, slots: t.slots, flexOk: t.flexOk });
      const maxPts = bruteForceMaxPoints(players, t.slots, t.flexOk);
      if (maxPts > ref.pts + 1e-9) cardinalityConflicts.push({ template: tname, i, maxPts, filledPts: ref.pts });
    }
  }
  return { cases, failures, cardinalityConflicts };
}

// ---------------------------------------------------------------------------------------------
// AXIS 3 -- STABILITY. How far must a projection move before the LINEUP moves?
// ---------------------------------------------------------------------------------------------
/** The starting set as a comparable string. Slot labels are included: moving a man from RB to FLEX
 *  is a different recommendation even though the same eleven play. */
export const lineupKey = (r) => r.starters.map((s) => `${s.slot}:${s.name}`).join("|");
/** The starting SET alone -- who plays, ignoring which slot he is labelled with. */
export const startedSet = (r) => r.starters.filter((s) => s.name !== "(empty)").map((s) => s.name).sort().join(",");

export function perturbStability({ n = 400, seed = 7, pcts = [0.01, 0.05, 0.10, 0.20], template = "espn" } = {}) {
  const t = TEMPLATES[template];
  const rand = rng(seed);
  const rows = pcts.map((p) => ({ pct: p, trials: 0, slotFlips: 0, setFlips: 0, ptsLost: 0 }));
  for (let i = 0; i < n; i++) {
    let players = makeRoster(rand, { n: 14, outRate: 0.12, dualRate: 0.15 });
    while (players.filter((p) => p.available).length > 16) players = makeRoster(rand, { n: 14, outRate: 0.12, dualRate: 0.15 });
    const base = optimalLineup(players, t.slots, t.flexOk);
    const bk = lineupKey(base), bs = startedSet(base);
    for (const row of rows) {
      // Each man perturbed INDEPENDENTLY by +/- pct -- the question is whether the recommendation is
      // stable to noise of that size, not whether a common shift moves it (it cannot).
      const jittered = players.map((p) => ({ ...p, proj: Math.round(p.proj * (1 + (rand() * 2 - 1) * row.pct) * 100) / 100 }));
      const r = optimalLineup(jittered, t.slots, t.flexOk);
      row.trials++;
      if (lineupKey(r) !== bk) row.slotFlips++;
      if (startedSet(r) !== bs) {
        row.setFlips++;
        // What the flip COST under the true (unjittered) projections -- the honest size of the error.
        const byName = new Map(players.map((p) => [p.name, p.proj]));
        const trueOf = (x) => x.starters.reduce((a, s) => a + (s.name === "(empty)" ? 0 : byName.get(s.name) ?? 0), 0);
        row.ptsLost += trueOf(base) - trueOf(r);
      }
    }
  }
  return rows.map((r) => ({
    pct: r.pct,
    slotFlipPct: Math.round((r.slotFlips / r.trials) * 1000) / 10,
    setFlipPct: Math.round((r.setFlips / r.trials) * 1000) / 10,
    meanPtsLostPerFlip: r.setFlips ? Math.round((r.ptsLost / r.setFlips) * 100) / 100 : 0,
    meanPtsLostPerWeek: Math.round((r.ptsLost / r.trials) * 1000) / 1000,
  }));
}

// ---------------------------------------------------------------------------------------------
// AXIS 4 -- VALUE AGAINST BASELINES, and AXIS 5 -- CALIBRATION, on real team-weeks.
//
// Everything below reuses the VALIDATED point-in-time loader (`loadWeekContext`) and varies exactly
// one thing: the projection each arm ranks by. Availability, roster membership, the template, the
// IR exclusion and the actuals are identical across arms, so a difference between two arms is a
// difference between two projections and nothing else.
//
// THE ARMS:
//   managers    what the room actually started (fact_lineup_week.started_pts)
//   hindsight   the best legal lineup from the same roster knowing the results -- the ceiling
//   floor       the season-line-only artifact, i.e. "season line / 17" -- the cheap baseline
//   trailing4   `t4_mean`, the trailing-four-game mean, straight off the point-in-time feature row
//               -- the OTHER cheap baseline, and the one a human actually uses
//   served      WEEKLY_SERVE, the per-position table the live seam resolves through
//
// ESPN'S OWN WEEKLY PROJECTION IS NOT AN ARM HERE, and the reason is a measurement rather than a
// choice: `raw_espn_projection` holds 585 rows, all of them season 2026 week 2. ESPN publishes a
// `statSourceId=1` block only for the CURRENT/UPCOMING scoring period, `src/weekly/espnProjections.ts`
// refuses to infer one from a season total, and the store accumulates only weeks somebody
// snapshotted before kickoff. There is therefore no way to backfill 2018-2025, and an arm built by
// inference would be our arithmetic wearing ESPN's name.
// ---------------------------------------------------------------------------------------------

/** Trailing-four-game mean per player_sk for one week, from the same point-in-time feature row the
 *  context reads. Null where the man has played fewer than the window -- reported, never zeroed. */
function trailing4Of(db, season, week) {
  const out = new Map();
  for (const r of db.prepare(
    "SELECT player_sk, t4_mean FROM feat_player_week_model WHERE season=? AND week=? AND player_sk IS NOT NULL",
  ).all(season, week)) if (r.t4_mean != null) out.set(r.player_sk, Number(r.t4_mean));
  return out;
}

/**
 * THE TWO FALLBACK QUANTITIES D33 IS A CHOICE BETWEEN, point-in-time, for one week.
 *
 * `lineupRecommend` prices a roster man the weekly projector has NO row for at the season line.
 * Before D33 that was the PRESEASON line spread flat (`proj / 17`); after it, the D18 rest-of-season
 * blend -- the same number `src/draft/season.ts` prices him at. Both are reconstructible for a past
 * week from `feat_player_week_model`, which carries `season_line_pg` (frozen at Y-09-01),
 * `td_games` and `td_ppg` (to-date through week w-1), so the change can be measured on real
 * team-weeks instead of argued about.
 *
 * NOTE WHAT THIS IS NOT. `src/inseason/backtest/lineup.ts` -- the repo's own manager backtest -- uses
 * NEITHER of these: its fallback is `td_ppg`, and it says so. So the manager backtest is BLIND to
 * D33 by construction and must print the same number before and after; that is a degeneracy control
 * on the change, not a measurement of it. This is the measurement of it.
 */
function fallbackPairOf(db, season, week, K) {
  const out = new Map();
  for (const r of db.prepare(
    "SELECT player_sk, season_line_pg, td_games, td_ppg FROM feat_player_week_model " +
    "WHERE season=? AND week=? AND player_sk IS NOT NULL",
  ).all(season, week)) {
    const line = r.season_line_pg == null ? null : Number(r.season_line_pg);
    if (line == null || !Number.isFinite(line)) continue;
    const k = r.td_games == null ? 0 : Number(r.td_games);
    const ppg = r.td_ppg == null ? null : Number(r.td_ppg);
    // The D18 blend, in the frame it was fitted in: K games of preseason prior against k played.
    const blended = k > 0 && ppg != null && Number.isFinite(ppg) && Number.isFinite(K)
      ? (K * line + k * ppg) / (K + k)
      : line;
    out.set(r.player_sk, { pre: line, blend: blended });
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Season-level bootstrap on a paired per-team-week quantity. The unit of analysis is the SEASON:
 *  1,896 team-weeks are eight correlated draws, and an interval over the rows would be about
 *  sqrt(1896/8) = 15x too tight. Same rule the repo's own harness follows. */
export function seasonCI(rows, valueOf, iters = 2000, seed = 20260917) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.season)) by.set(r.season, []); by.get(r.season).push(valueOf(r)); }
  const seasons = [...by.values()];
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const draws = [];
  for (let i = 0; i < iters; i++) {
    const picked = [];
    for (let k = 0; k < seasons.length; k++) picked.push(...seasons[Math.floor(rnd() * seasons.length)]);
    draws.push(mean(picked));
  }
  draws.sort((a, b) => a - b);
  return {
    mean: mean(rows.map(valueOf)),
    lo: draws[Math.floor(0.025 * draws.length)],
    hi: draws[Math.floor(0.975 * draws.length)],
    seasons: seasons.length,
    seasonsWon: [...by.entries()].filter(([, v]) => mean(v) > 0).length,
  };
}

/**
 * THE AFTER ARM WITHOUT PROMOTING ANYTHING (D32, charter rule 1).
 *
 * `--cal-weekly <file> --cal-lineonly <file>` take the `bandCalibration` block off two CANDIDATE
 * artifacts on a temp path and graft it onto the SERVED ones in-process. That is byte-equivalent to
 * serving the candidates -- and it is only legitimate because the candidates are proved, before this
 * runs, to be the served files plus that one field (scratchpad heads-identity.mjs: byte-for-byte on
 * everything else, golden mean/p50 identical to 0). Without that proof this would be a measurement
 * of two different models.
 *
 * With no flags both arms read the served files and the BEFORE/AFTER tables are identical, which is
 * the degenerate case and reads as one.
 */
function calOverlayFrom(argv) {
  const pick = (k) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : null; };
  const byFile = {};
  for (const [flag, file] of [["cal-weekly", "weekly-artifact.json"], ["cal-lineonly", "weekly-artifact-lineonly.json"]]) {
    const p = pick(flag);
    if (!p) continue;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!j.bandCalibration) throw new Error(`${p} carries no bandCalibration -- grafting nothing would silently measure the served band twice`);
    byFile[file] = j.bandCalibration;
  }
  return Object.keys(byFile).length ? byFile : null;
}

export async function runBaselines({ seasons = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025], leagueId = "462233", calOverlay = null } = {}) {
  const { openDb } = await import("../src/db/db.js");
  const { loadWeekContext, loadModel } = await import("../src/inseason/backtest/context.js");
  const { projectStreamingWith } = await import("../src/weekly/streamingServe.js");
  const db = openDb();
  const models = { floor: loadModel("floor"), served: loadModel("served") };
  // D33: the two fallback arms. The blend's K is read off the fitted file, never retyped -- a
  // hardcoded 6 here would keep agreeing with the model right up until the day somebody refits it.
  const { loadRosBlend } = await import("../src/draft/rosBlend.js");
  const rosK = loadRosBlend().blend.K;
  const ARMS = ["floor", "trailing4", "served", "fbPre", "fbBlend"];
  const rows = [];                      // one per (season, week, team, arm-agnostic) with every arm's score
  const posRows = [];                   // per starting SLOT: what each arm's pick actually scored
  const bandRows = [];                  // AXIS 5: the served band vs the realised points

  for (const season of seasons) {
    const weeks = db.prepare("SELECT DISTINCT week FROM fact_lineup_week WHERE league_id=? AND season=? ORDER BY week").all(leagueId, season);
    for (const { week } of weeks) {
      const ctxByModel = { floor: loadWeekContext(db, leagueId, season, week, models.floor), served: loadWeekContext(db, leagueId, season, week, models.served) };
      const base = ctxByModel.served;
      if (!base.rosters.size || !base.template.length) continue;
      const t4 = trailing4Of(db, season, week);
      const fb = fallbackPairOf(db, season, week, rosK);
      // THE SERVED BAND, for axis 5. `loadWeekContext` carries only the mean, so the quantiles come
      // from the same router that produced that mean -- one call, so a mean and its own p10/p90
      // cannot arrive from two different reads of the table.
      const band = new Map();
      const applyCal = calOverlay
        ? (a, f) => (calOverlay[f] ? { ...a, bandCalibration: calOverlay[f] } : a)
        : null;
      for (const x of (projectStreamingWith(db, season, week, undefined, applyCal ? { mapArtifact: applyCal } : undefined)?.rows ?? [])) {
        if (x.player_sk == null) continue;
        const prev = band.get(x.player_sk);
        if (prev == null || x.mean > prev.mean) band.set(x.player_sk, { mean: x.mean, p10: x.p10, p50: x.p50, p90: x.p90, pZero: x.pZero });
      }
      // THE BEFORE ARM (D32): the SAME artifacts with `bandCalibration` stripped, projected from the
      // SAME row read in the SAME process. Nothing else differs, so a delta below cannot be refit
      // noise, a store change or a different week's rows -- it is the field under test and nothing
      // else. An artifact that carries no calibration produces two identical arms, which is the
      // degenerate case and reads as one.
      const bandRaw = new Map();
      for (const x of (projectStreamingWith(db, season, week, undefined, { mapArtifact: stripBandCal })?.rows ?? [])) {
        if (x.player_sk == null) continue;
        const prev = bandRaw.get(x.player_sk);
        if (prev == null || x.mean > prev.mean) bandRaw.set(x.player_sk, { mean: x.mean, p10: x.p10, p50: x.p50, p90: x.p90 });
      }
      const real = new Map(db.prepare(
        "SELECT team_id, started_pts, optimal_pts FROM fact_lineup_week WHERE league_id=? AND season=? AND week=?",
      ).all(leagueId, season, week).map((r) => [r.team_id, r]));

      for (const [teamId, entries] of base.rosters) {
        const r = real.get(teamId);
        if (!r) continue;
        const men = entries.filter((e) => e.lineupSlotId !== 21);   // IR is not startable
        const meta = men.map((e) => ({ e, p: base.players.get(e.playerSk) }));
        const mk = (projOf) => men.map((e, i) => ({
          name: `${e.name}#${e.playerSk}`, pos: e.pos,
          proj: projOf(e, meta[i].p) ?? 0,
          available: meta[i].p ? meta[i].p.available : true,
        }));
        const actualOf = (nm) => base.players.get(String(nm).split("#")[1])?.actual ?? 0;
        const score = (res) => res.starters.reduce((a, s) => a + (s.name === "(empty)" ? 0 : actualOf(s.name)), 0);

        const lineups = {
          floor: optimalLineup(mk((e) => { const f = ctxByModel.floor.players.get(e.playerSk); return f?.proj ?? f?.fallback ?? 0; }), base.template, ["RB", "WR", "TE"]),
          trailing4: optimalLineup(mk((e, p) => t4.get(e.playerSk) ?? p?.fallback ?? 0), base.template, ["RB", "WR", "TE"]),
          served: optimalLineup(mk((e, p) => p?.proj ?? p?.fallback ?? 0), base.template, ["RB", "WR", "TE"]),
          // D33 BEFORE / AFTER. Identical everywhere the weekly projector HAS a row; they can only
          // differ on the men it does not, which is the whole exposure of the change. `season_line_pg`
          // IS per game, so the "before" arm is that number itself -- `lineupRecommend`'s `proj / 17`
          // divides a season TOTAL to reach the same frame.
          fbPre: optimalLineup(mk((e, p) => (p?.proj != null ? p.proj : (fb.get(e.playerSk)?.pre ?? p?.fallback ?? 0))), base.template, ["RB", "WR", "TE"]),
          fbBlend: optimalLineup(mk((e, p) => (p?.proj != null ? p.proj : (fb.get(e.playerSk)?.blend ?? p?.fallback ?? 0))), base.template, ["RB", "WR", "TE"]),
          // HINDSIGHT: the same optimizer, ranking by the REAL result. Availability is deliberately
          // left as it was known -- a ceiling that could start a man who was ruled out is not a
          // ceiling anybody could have hit, and the repo's own `optimal_pts` is computed the same way.
          hindsight: optimalLineup(mk((e, p) => p?.actual ?? 0), base.template, ["RB", "WR", "TE"]),
        };
        const row = { season, week, teamId, managers: r.started_pts, storedOptimal: r.optimal_pts, hindsight: score(lineups.hindsight) };
        for (const a of ARMS) row[a] = score(lineups[a]);
        // D33 exposure, per team-week: how many rostered men the weekly projector had no row for,
        // and whether the two fallback arms chose a DIFFERENT starting set. A points delta with no
        // count of the men it could possibly have come from is unreadable.
        row.fellBack = meta.filter((m) => m.p == null || m.p.proj == null).length;
        row.rosterN = men.length;
        // THE POSITIVE CONTROL for D33, and without it "0 team-weeks changed" is unreadable: a dead
        // lever and a real null draw the same flat line. Count the men whose two fallback NUMBERS
        // actually differ, and by how much. If this is 0 the arms are the same arm.
        row.d33Men = 0; row.d33Abs = 0;
        for (let i = 0; i < men.length; i++) {
          const p = meta[i].p;
          if (p && p.proj != null) continue;
          const f = fb.get(men[i].playerSk);
          if (!f) continue;
          const d = Math.abs(f.blend - f.pre);
          if (d > 1e-9) { row.d33Men++; row.d33Abs += d; }
        }
        const setOf = (res) => res.starters.map((s) => s.name).sort().join("|");
        row.d33Changed = setOf(lineups.fbPre) !== setOf(lineups.fbBlend) ? 1 : 0;
        rows.push(row);

        // PER SLOT: our served pick against the hindsight pick, so "how far below the ceiling" can
        // be read by position rather than only in aggregate.
        for (let i = 0; i < lineups.served.starters.length; i++) {
          const s = lineups.served.starters[i], h = lineups.hindsight.starters[i];
          posRows.push({
            season, slot: s.slot,
            served: s.name === "(empty)" ? 0 : actualOf(s.name),
            hindsight: h.name === "(empty)" ? 0 : actualOf(h.name),
            floorPick: lineups.floor.starters[i].name === "(empty)" ? 0 : actualOf(lineups.floor.starters[i].name),
            t4Pick: lineups.trailing4.starters[i].name === "(empty)" ? 0 : actualOf(lineups.trailing4.starters[i].name),
          });
        }
        // AXIS 5: every ROSTERED man, starter and bench, with the served band and his realised week.
        for (let i = 0; i < men.length; i++) {
          const p = meta[i].p;
          if (!p || p.proj == null) continue;
          const startedByUs = lineups.served.starters.some((s) => s.name === `${men[i].name}#${men[i].playerSk}`);
          bandRows.push({
            season, week, pos: p.pos, mean: p.proj, actual: p.actual,
            started: startedByUs, available: p.available, whyNot: p.whyNot,
            designated: p.whyNot === "OUT" || p.whyNot === "DOUBTFUL",
            ...(band.get(men[i].playerSk) ?? {}),
            raw: bandRaw.get(men[i].playerSk) ?? null,
          });
        }
      }
    }
  }
  db.close();
  return { rows, posRows, bandRows };
}
export { mean as _mean };

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const argOf = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const f3 = (x) => (Math.round(x * 1000) / 1000).toFixed(3);

async function printBaselines(calOverlay = null) {
  const t0 = Date.now();
  if (calOverlay) console.log("AFTER ARM OVERLAY: " + Object.keys(calOverlay).join(", ") + " carry a candidate bandCalibration");
  const { rows, posRows, bandRows } = await runBaselines({ calOverlay });
  if (!rows.length) { console.log("REFUSED: zero scored team-weeks -- an empty decision set is a refusal, not a zero."); return; }
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  console.log(`\nBASELINES  ${rows.length} team-weeks, seasons ${seasons[0]}-${seasons[seasons.length - 1]}, league 462233, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  // A CONTROL on the harness itself: our recomputed hindsight must reproduce the store's own
  // `optimal_pts`. If it does not, the two are not the same ceiling and nothing below is comparable.
  const dOpt = rows.map((r) => r.hindsight - r.storedOptimal);
  console.log(`  control: recomputed hindsight vs the store's optimal_pts -- mean ${f3(mean(dOpt))}, max |d| ${f2(Math.max(...dOpt.map(Math.abs)))}`);
  console.log("\n  arm          mean pts   vs managers   season CI            seasons won   beats own manager");
  const mgr = mean(rows.map((r) => r.managers));
  console.log(`  managers     ${f2(mgr).padStart(8)}          --                        --              --`);
  console.log(`  hindsight    ${f2(mean(rows.map((r) => r.hindsight))).padStart(8)}   ${f2(mean(rows.map((r) => r.hindsight - r.managers))).padStart(11)}`);
  for (const arm of ["floor", "trailing4", "served", "fbPre", "fbBlend"]) {
    const ci = seasonCI(rows, (r) => r[arm] - r.managers);
    const w = rows.filter((r) => r[arm] > r.managers).length + 0.5 * rows.filter((r) => r[arm] === r.managers).length;
    console.log(`  ${arm.padEnd(12)} ${f2(mean(rows.map((r) => r[arm]))).padStart(8)}   ${f2(ci.mean).padStart(11)}   [${f2(ci.lo)}, ${f2(ci.hi)}]`.padEnd(70) +
      `${ci.seasonsWon}/${ci.seasons}`.padStart(11) + `${f3(w / rows.length)}`.padStart(19));
  }
  // D33 -- the fallback change, on the men it can possibly touch.
  {
    const exposed = rows.filter((r) => r.fellBack > 0);
    const changed = rows.filter((r) => r.d33Changed);
    console.log(`\n  D33 FALLBACK ARMS (only the men the weekly projector had NO row for can differ):`);
    const fbMen = rows.reduce((a, r) => a + r.fellBack, 0);
    const allMen = rows.reduce((a, r) => a + r.rosterN, 0);
    console.log(`    rostered men with no weekly row: ${fbMen} of ${allMen} (${f3(fbMen / Math.max(1, allMen))}); ` +
      `${exposed.length} of ${rows.length} team-weeks exposed (${f3(exposed.length / rows.length)})`);
    const d33Men = rows.reduce((a, r) => a + r.d33Men, 0);
    const d33Abs = rows.reduce((a, r) => a + r.d33Abs, 0);
    console.log(`    POSITIVE CONTROL -- fallback men whose two NUMBERS actually differ: ${d33Men}` +
      (d33Men ? `, mean |blend - preseason| ${f2(d33Abs / d33Men)} pts/week` : "  <-- THE ARMS ARE THE SAME ARM, read nothing below"));
    console.log(`    team-weeks whose STARTING SET changed: ${changed.length} (${f3(changed.length / rows.length)})`);
    const ci = seasonCI(rows, (r) => r.fbBlend - r.fbPre);
    console.log(`    fbBlend - fbPre: ${f2(ci.mean)} pts/team-week [${f2(ci.lo)}, ${f2(ci.hi)}], ${ci.seasonsWon}/${ci.seasons} seasons`);
    if (changed.length) {
      const c = changed.map((r) => r.fbBlend - r.fbPre);
      console.log(`    on the ${changed.length} CHANGED team-weeks only: ${f2(mean(c))} pts, ` +
        `${c.filter((x) => x > 0).length} better / ${c.filter((x) => x < 0).length} worse`);
    }
  }
  console.log("\n  PAIRED, arm vs arm (season CI on the per-team-week difference):");
  for (const [a, b] of [["served", "floor"], ["served", "trailing4"], ["trailing4", "floor"]]) {
    const ci = seasonCI(rows, (r) => r[a] - r[b]);
    console.log(`    ${a} - ${b}: ${f2(ci.mean)} [${f2(ci.lo)}, ${f2(ci.hi)}], ${ci.seasonsWon}/${ci.seasons} seasons`);
  }
  console.log("\n  PER SEASON (mean pts):  season   n   managers  hindsight   floor  trailing4  served");
  for (const s of seasons) {
    const sub = rows.filter((r) => r.season === s);
    console.log(`                          ${s}  ${String(sub.length).padStart(3)}` +
      ["managers", "hindsight", "floor", "trailing4", "served"].map((k) => f2(mean(sub.map((r) => r[k]))).padStart(10)).join(""));
  }
  console.log("\n  PER SLOT (mean realised pts of the man each arm started, and the gap to hindsight):");
  console.log("    slot     n     floor  trailing4    served  hindsight   served gap");
  const slots = [...new Set(posRows.map((p) => p.slot))];
  for (const slot of slots) {
    const sub = posRows.filter((p) => p.slot === slot);
    console.log(`    ${slot.padEnd(6)} ${String(sub.length).padStart(5)}` +
      [["floorPick"], ["t4Pick"], ["served"], ["hindsight"]].map(([k]) => f2(mean(sub.map((p) => p[k]))).padStart(10)).join("") +
      f2(mean(sub.map((p) => p.served - p.hindsight))).padStart(13));
  }
  return { rows, bandRows };
}

/** Strip the D32 band calibration off an artifact -- the BEFORE arm. A deep-ish copy of just the
 *  field, so the heads, the boosted block and the golden rows are the identical objects. */
export function stripBandCal(a) {
  if (!a || a.bandCalibration == null) return a;
  const { bandCalibration, ...rest } = a;
  return rest;
}

/** AXIS 5 -- is the served p10/p90 an 80% interval, split by the regimes where it might not be?
 *
 *  `arm` selects WHICH band: "after" is the served artifact as it stands, "before" is the same
 *  artifact with `bandCalibration` removed, projected in the same call from the same rows. */
function printCalibration(bandRows, arm = "after") {
  const lo = (r) => (arm === "before" ? r.raw?.p10 : r.p10);
  const hi = (r) => (arm === "before" ? r.raw?.p90 : r.p90);
  const covered = (r) => r.actual >= lo(r) && r.actual <= hi(r);
  const cell = (label, sub) => {
    if (!sub.length) return `  ${label.padEnd(34)} ${"-".padStart(7)}      (no rows)`;
    const cov = sub.filter(covered).length / sub.length;
    const below = sub.filter((r) => r.actual < lo(r)).length / sub.length;
    const above = sub.filter((r) => r.actual > hi(r)).length / sub.length;
    return `  ${label.padEnd(34)} ${String(sub.length).padStart(6)}   ${f3(cov)}   ${f3(below)}   ${f3(above)}   ${f2(mean(sub.map((r) => r.actual - r.mean)))}`;
  };
  const withBand = bandRows.filter((r) => r.p10 != null && r.p90 != null && (arm === "after" || r.raw != null));
  console.log(`\nCALIBRATION UNDER STRESS [${arm.toUpperCase()}] -- the p10/p90 on ${withBand.length} rostered player-weeks`);
  console.log("  (nominal coverage 0.80; `bias` is mean(actual - projected), so negative = the model is too high)");
  console.log("  cell                                    n   cover   <p10   >p90     bias");
  console.log(cell("ALL", withBand));
  for (const pos of POS) console.log(cell(`pos ${pos}`, withBand.filter((r) => r.pos === pos)));
  console.log(cell("STARTERS (our served lineup)", withBand.filter((r) => r.started)));
  console.log(cell("BENCH", withBand.filter((r) => !r.started)));
  console.log(cell("injury-DESIGNATED (OUT/DOUBTFUL)", withBand.filter((r) => r.designated)));
  console.log(cell("clean (no designation, no bye)", withBand.filter((r) => !r.designated && r.whyNot == null)));
  console.log(cell("weeks 1-4", withBand.filter((r) => r.week <= 4)));
  console.log(cell("weeks 5-17", withBand.filter((r) => r.week >= 5)));
  // THE REGIME CROSS-CELLS the D32 brief gates on: starter/bench x early/late, each at each position
  // is too thin to read, so the two regimes are crossed with each other rather than with position.
  for (const [lab, f] of [
    ["STARTERS weeks 1-4", (r) => r.started && r.week <= 4],
    ["STARTERS weeks 5-17", (r) => r.started && r.week >= 5],
    ["BENCH weeks 1-4", (r) => !r.started && r.week <= 4],
    ["BENCH weeks 5-17", (r) => !r.started && r.week >= 5],
  ]) console.log(cell(lab, withBand.filter(f)));
  // AND THE SHARE OF ROWS THAT CLAIM A POSITIVE FLOOR AT ALL. Without it the `<p10` column cannot be
  // read: with a zero atom under a quarter of the population, p10 = 0 is the CORRECT tenth
  // percentile and P(y < p10) = 0 on every one of those rows by construction, so a pooled `<p10`
  // below 0.10 is a measurement of the atom rather than of the band.
  const floored = withBand.filter((r) => lo(r) > 0);
  if (floored.length) {
    console.log(`  --- of ${withBand.length} rows, ${floored.length} (${f3(floored.length / withBand.length)}) claim a p10 > 0;` +
      ` on THOSE rows <p10 is ${f3(floored.filter((r) => r.actual < lo(r)).length / floored.length)} (nominal 0.10)`);
  }
  // DARK-FEED weeks: the seasons the ablation named as usage-dark are 2018-2019 (pre-participation
  // coverage) -- read off the data rather than asserted, so the split is a measurement.
  const bySeason = new Map();
  for (const r of withBand) { if (!bySeason.has(r.season)) bySeason.set(r.season, []); bySeason.get(r.season).push(r); }
  console.log("  --- by season (the dark-feed axis, since a feed goes dark for a whole season here)");
  for (const s of [...bySeason.keys()].sort()) console.log(cell(`season ${s}`, bySeason.get(s)));
}

if (process.argv[1] && process.argv[1].endsWith("lineup-stress.mjs")) {
  const cmd = process.argv[2] ?? "report";
  const seed = Number(argOf("seed", 1));
  if (cmd === "fuzz" || cmd === "report") {
    const n = Number(argOf("n", cmd === "report" ? 2000 : 5000));
    const t0 = Date.now();
    const r = fuzzOptimizer({ n, seed });
    console.log(`FUZZ  ${r.cases} cases over ${Object.keys(TEMPLATES).length} templates, seed ${seed}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`      failures: ${r.failures.length}`);
    for (const f of r.failures.slice(0, 5)) {
      console.log(`  FAIL ${f.template} #${f.i}: ${f.problems.join("; ")}`);
      console.log(`       ${JSON.stringify(f.players)}`);
    }
    console.log(`      cases where max-POINTS beats max-CARDINALITY (negative projections): ${r.cardinalityConflicts.length}` +
      (r.cardinalityConflicts.length ? ` (worst +${Math.max(...r.cardinalityConflicts.map((c) => c.maxPts - c.filledPts)).toFixed(2)} pts by benching a negative man)` : ""));
    // THE CONTROL. The same fuzz against the pre-matroid slot-order greedy MUST go red -- otherwise
    // the zero above is a measurement of a disconnected checker, not of a correct optimizer.
    const inj = fuzzOptimizer({ n: Math.min(n, 300), seed, optimizer: greedyBySlotOrder });
    console.log(`      CONTROL (slot-order greedy, ${inj.cases} cases): ${inj.failures.length} failures` +
      `${inj.failures.length ? ` -- e.g. ${inj.failures[0].template}: ${inj.failures[0].problems[0]}` : "  <-- THE FUZZ IS NOT CONNECTED"}`);
  }
  if (cmd === "perturb" || cmd === "report") {
    const n = Number(argOf("n", 400));
    console.log(`\nPERTURB  ${n} rosters, ESPN template, seed ${seed + 6}`);
    console.log("  pct    slot-flip%  set-flip%  pts lost/flip  pts lost/week");
    for (const r of perturbStability({ n, seed: seed + 6 })) {
      console.log(`  ${String(Math.round(r.pct * 100)).padStart(3)}%  ${String(r.slotFlipPct).padStart(9)}  ${String(r.setFlipPct).padStart(9)}  ${String(r.meanPtsLostPerFlip).padStart(13)}  ${String(r.meanPtsLostPerWeek).padStart(13)}`);
    }
  }
  if (cmd === "baselines" || cmd === "calibration" || cmd === "all") {
    const got = await printBaselines(calOverlayFrom(process.argv));
    if (got) {
      // THE MEDIAN-IDENTITY CONTROL (D32), and it is the first thing printed because everything
      // after it is only readable if it holds. A BAND calibration must not move the point estimate;
      // if `mean` or `p50` differs between the two arms on any row, what follows is a model change
      // wearing a calibration's name and the coverage table is not a coverage table.
      const paired = got.bandRows.filter((r) => r.raw != null && r.p10 != null);
      const dMean = paired.map((r) => Math.abs(r.mean - r.raw.mean));
      const dP50 = paired.map((r) => Math.abs(r.p50 - r.raw.p50));
      const dP10 = paired.map((r) => Math.abs(r.p10 - r.raw.p10));
      const dP90 = paired.map((r) => Math.abs(r.p90 - r.raw.p90));
      console.log(`\nD32 CONTROL -- ${paired.length} paired rows (served band vs the same artifact with bandCalibration stripped)`);
      console.log(`  max |d mean| ${Math.max(0, ...dMean).toExponential(2)}   max |d p50| ${Math.max(0, ...dP50).toExponential(2)}` +
        `   <- MUST be 0; the median and the mean are not the calibration's business`);
      console.log(`  max |d p10 | ${Math.max(0, ...dP10).toExponential(2)}   max |d p90| ${Math.max(0, ...dP90).toExponential(2)}` +
        `   <- 0 here means the artifact carries NO calibration (the arms are the same model)`);
      printCalibration(got.bandRows, "before");
      printCalibration(got.bandRows, "after");
    }
  }
}
