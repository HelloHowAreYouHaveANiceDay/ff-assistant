/**
 * THE WIN-PROBABILITY LINEUP: does it actually trade shape for probability, and can it tell which
 * way round?
 *
 * The dangerous failure here is not a wrong lineup, it is a lineup that never moves. A swap search
 * that is not connected -- a neighbourhood that generates nothing, a legality check that rejects
 * everything, a delta below a threshold that is too high -- returns the expected-points lineup with
 * a probability stapled to it, which is EXACTLY what a correct search returns whenever expected
 * points really is the right answer. Nothing in the output distinguishes the two.
 *
 * So every test that claims the search MOVES a lineup is re-run with `noSearch: true`, which is the
 * one thing a working search cannot survive. And the direction is asserted, not just the movement:
 * the same two players, the same bands, and only the OPPONENT changed must produce opposite lineups.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  winProbLineup, opponentStarters, quantileFn, sampleWeek, WINPROB_COUPLING_DEFAULT,
  type WinProbPlayer, type WeeklyBand,
} from "../src/inseason/winprob.js";

const SIMS = 20000;
const SEED = 11;

/** One startable slot, so the lineup IS the choice and nothing else can move. */
const ONE_WR = ["WR", "BE"];

const band = (p10: number, p50: number, p90: number, mean = p50, pZero?: number): WeeklyBand =>
  ({ mean, p10, p50, p90, ...(pZero == null ? {} : { pZero }) });

/** The steady man: a narrow band, a real floor, no ceiling. */
const steady = (name: string, mean: number): WinProbPlayer =>
  ({ name, pos: "WR", available: true, team: null, proj: mean, band: band(mean - 3, mean, mean + 3, mean) });

/** The boom-or-bust man: he is zero a third of the time and enormous a tenth of it. */
const boom = (name: string, mean: number): WinProbPlayer =>
  ({ name, pos: "WR", available: true, team: null, proj: mean, band: band(0, mean * 0.5, mean * 2.6, mean, 0.30) });

/** An opponent who is a single certainty, so the margin is exactly what the fixture says it is. */
const wall = (mean: number): WinProbPlayer[] =>
  [{ name: "Opp Wall", pos: "WR", available: true, team: null, proj: mean, band: band(mean - 1, mean, mean + 1, mean) }];

// -------------------------------------------------------------------------------------------
// THE MARGINAL
// -------------------------------------------------------------------------------------------

test("the sampler's marginal IS the published band -- the quantile function reproduces it", () => {
  const q = quantileFn(band(4, 10, 22, 11));
  assert.equal(q(0.10), 4);
  assert.equal(q(0.50), 10);
  assert.equal(q(0.90), 22);
  assert.ok(q(0.99) > 22, "the tail beyond p90 is extended, or every ceiling is clipped at p90");
  assert.ok(q(0.30) > 4 && q(0.30) < 10, "levels between published knots interpolate");
  assert.equal(q(0), 0, "points cannot be negative");
});

test("P(zero week) is an ATOM, not a low quantile", () => {
  const q = quantileFn(band(0, 6, 20, 8, 0.35));
  assert.equal(q(0.34), 0);
  assert.equal(q(0.35), 0);
  assert.ok(q(0.60) > 0, "everything above the atom must be able to score");
  // And it shows up in the sample: about 35% of drawn weeks are exactly zero.
  const m = sampleWeek([{ name: "Z", pos: "WR", available: true, team: null, proj: 8, band: band(0, 6, 20, 8, 0.35) }], { sims: 20000, seed: 3 });
  let zeros = 0;
  for (let s = 0; s < m.sims; s++) if (m.pts[0][s] === 0) zeros++;
  assert.ok(Math.abs(zeros / m.sims - 0.35) < 0.02, `drew ${(zeros / m.sims).toFixed(3)} zeros against a stated 0.35`);
});

test("a quantile crossing cannot invert the sampler", () => {
  // p50 BELOW p10, which independently-fitted levels really do produce.
  const q = quantileFn(band(9, 5, 20, 11));
  assert.ok(q(0.50) >= q(0.10), "the quantile function is not monotone, so its median sits below its own tenth percentile");
});

// -------------------------------------------------------------------------------------------
// THE DIRECTION OF THE TRADE
// -------------------------------------------------------------------------------------------

test("HEAVY UNDERDOG: the search starts the high-variance man the expected-points lineup benched", () => {
  const ours = [steady("Steady", 12), boom("Boom", 11)];
  const r = winProbLineup(ours, wall(24), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED });

  assert.equal(r.posture, "underdog");
  assert.equal(r.epStarters[0].name, "Steady", "the expected-points lineup must prefer the higher mean, or the fixture is not testing a trade");
  assert.equal(r.starters[0].name, "Boom");
  assert.equal(r.swaps.length, 1);
  assert.equal(r.swaps[0].out, "Steady");
  assert.equal(r.swaps[0].in, "Boom");
  assert.ok(r.swaps[0].sdDelta > 0, "the swap was sold as variance-up and did not raise the standard deviation");
  assert.ok(r.gainPp > 0 && r.winPct > r.epWinPct);
  assert.ok(r.epCostPts > 0, "a trade that costs nothing is not a trade");
  assert.ok(r.evaluated > 0 && r.passes > 0, "the search reported no cost, which means it did not run");
});

test("FAULT INJECTION: with the swap search DISABLED the underdog fixture keeps the losing lineup", () => {
  const ours = [steady("Steady", 12), boom("Boom", 11)];
  const r = winProbLineup(ours, wall(24), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED, noSearch: true });

  assert.equal(r.starters[0].name, "Steady", "noSearch still moved the lineup, so the search is not what moves it");
  assert.equal(r.swaps.length, 0);
  assert.equal(r.evaluated, 0);
  assert.equal(r.gainPp, 0);
  assert.equal(r.winPct, r.epWinPct);
  assert.ok(r.caveats.some((c) => /SWAP SEARCH WAS DISABLED/.test(c)), "a disabled search must say so on the result");
});

test("HEAVY FAVOURITE: the search benches the high-variance man the expected-points lineup started", () => {
  // The boom man now has the HIGHER mean, so expected points starts him. Leading by twenty, his
  // thirty-percent zero is the only way we lose.
  const ours = [steady("Steady", 12), boom("Boom", 13)];
  const r = winProbLineup(ours, wall(4), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED });

  assert.equal(r.posture, "favourite");
  assert.equal(r.epStarters[0].name, "Boom", "expected points must start the higher mean, or the fixture is not testing a trade");
  assert.equal(r.starters[0].name, "Steady");
  assert.equal(r.swaps.length, 1);
  assert.ok(r.swaps[0].p10Delta > 0, "the swap was sold as floor-up and did not raise the tenth percentile");
  assert.ok(r.swaps[0].sdDelta < 0);
  assert.ok(r.gainPp > 0);
  assert.match(r.swaps[0].why, /floor/);
});

test("FAULT INJECTION: with the search disabled the favourite fixture keeps the boom-or-bust starter", () => {
  const ours = [steady("Steady", 12), boom("Boom", 13)];
  const r = winProbLineup(ours, wall(4), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED, noSearch: true });
  assert.equal(r.starters[0].name, "Boom");
  assert.equal(r.swaps.length, 0);
});

test("THE SAME TWO PLAYERS, opposite opponents, opposite lineups", () => {
  // The one assertion that a search keyed on anything other than the opponent cannot satisfy.
  const mk = () => [steady("Steady", 12), boom("Boom", 12)];
  const down = winProbLineup(mk(), wall(26), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED });
  const up = winProbLineup(mk(), wall(4), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED });
  assert.equal(down.starters[0].name, "Boom");
  assert.equal(up.starters[0].name, "Steady");
});

test("AN EVEN GAME returns the expected-points lineup", () => {
  // Two men of the same shape and different means, against an opponent projected level with us.
  const ours = [steady("Steady", 12), steady("Lesser", 11)];
  const r = winProbLineup(ours, wall(12), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED });
  assert.equal(r.posture, "even");
  assert.deepEqual(r.starters, r.epStarters);
  assert.equal(r.swaps.length, 0);
  assert.equal(r.epCostPts, 0);
  assert.ok(r.evaluated > 0, "the search must have LOOKED and declined -- zero evaluations is a dead search, not agreement");
});

// -------------------------------------------------------------------------------------------
// LEGALITY, AVAILABILITY, AND THE SEARCH'S OWN CLAIMS
// -------------------------------------------------------------------------------------------

test("an UNAVAILABLE man is never swapped in, however much variance he has", () => {
  const ours = [steady("Steady", 12), { ...boom("Boom", 11), available: false }];
  const r = winProbLineup(ours, wall(24), ONE_WR, ["RB", "WR", "TE"], { sims: SIMS, seed: SEED });
  assert.equal(r.starters[0].name, "Steady");
  assert.equal(r.swaps.length, 0);
});

test("the returned lineup is LEGAL: every slot filled by an eligible man, under real eligibility", () => {
  const slots = ["QB", "RB", "WR", "TE", "FLEX", "BE", "BE"];
  const flexOk = ["RB", "WR", "TE"];
  const mk = (name: string, pos: string, mean: number, bust: boolean, eligible?: string[]): WinProbPlayer => ({
    name, pos, available: true, team: null, proj: mean, ...(eligible ? { eligible } : {}),
    band: bust ? band(0, mean * 0.5, mean * 2.6, mean, 0.3) : band(Math.max(0, mean - 3), mean, mean + 3, mean),
  });
  const ours = [
    mk("Passer", "QB", 18, false), mk("Runner", "RB", 14, false), mk("Catcher", "WR", 13, false),
    mk("Ender", "TE", 8, false), mk("Swing", "RB", 9, false, ["RB", "WR"]),
    mk("Wild", "WR", 8.5, true), mk("Spare", "RB", 7, false),
  ];
  const r = winProbLineup(ours, wall(40), slots, flexOk, { sims: SIMS, seed: SEED });
  assert.equal(r.starters.length, 5);
  const eligOf = new Map(ours.map((p) => [p.name, p.eligible ?? [p.pos]]));
  for (const s of r.starters) {
    const e = eligOf.get(s.name)!;
    assert.ok(s.slot === "FLEX" ? e.some((x) => flexOk.includes(x)) : e.includes(s.slot),
      `${s.name} (${e.join("/")}) was seated at ${s.slot}`);
  }
  assert.equal(new Set(r.starters.map((s) => s.name)).size, 5, "a player was seated twice");
});

test("the copula is CONNECTED: two teammates co-move, and with coupling 0 they do not", () => {
  const two = (): WinProbPlayer[] => [
    { name: "Arm", pos: "QB", available: true, team: "XYZ", proj: 20, band: band(8, 19, 33, 20) },
    { name: "Hands", pos: "WR", available: true, team: "XYZ", proj: 13, band: band(2, 11, 26, 13) },
  ];
  const corr = { pairs: { "QB-WR": 0.3475 } };
  const pearson = (a: Float64Array, b: Float64Array) => {
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    return ab / Math.sqrt(aa * bb);
  };
  const on = sampleWeek(two(), { sims: SIMS, seed: 5, corr, coupling: WINPROB_COUPLING_DEFAULT });
  const off = sampleWeek(two(), { sims: SIMS, seed: 5, corr, coupling: 0 });
  assert.equal(on.coupledGroups, 1);
  assert.equal(off.coupledGroups, 1, "the group still exists at coupling 0 -- only its correlation is zero");
  assert.ok(pearson(on.pts[0], on.pts[1]) > 0.25, "the copula did not couple the teammates");
  assert.ok(Math.abs(pearson(off.pts[0], off.pts[1])) < 0.03, "coupling 0 still produced a correlation, so the copula is not what makes it");
});

test("the copula is the ONLY source of dependence: the WORST uncoupled pair, not the mean of them", () => {
  // The first RNG in this module passed a MEAN-over-pairs check at -0.006 while carrying an
  // uncoupled pair at 0.48 -- signed correlations cancelling. A mean cannot see that by
  // construction, so this asserts on the maximum.
  const players: WinProbPlayer[] = Array.from({ length: 12 }, (_, i) => ({
    name: `P${i}`, pos: "WR", available: true, team: null, proj: 12, band: band(2, 10, 26, 12, 0.15),
  }));
  const pearson = (a: Float64Array, b: Float64Array) => {
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  };
  const sims = 20000, se = 1 / Math.sqrt(sims);
  let worst = 0, at = "";
  for (const seed of [1, 7, 4242]) {
    const m = sampleWeek(players, { sims, seed });
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const r = Math.abs(pearson(m.pts[i], m.pts[j]));
      if (r > worst) { worst = r; at = `seed ${seed} pair ${i}-${j}`; }
    }
  }
  assert.ok(worst < 4 * se, `uncoupled players are correlated at ${worst.toFixed(4)} (${at}), ${(worst / se).toFixed(1)} sampling errors -- the coupling calibration would be fitting this`);
});

test("COMMON RANDOM NUMBERS: a player's draws do not depend on who else is in the sample", () => {
  const a: WinProbPlayer = { name: "A", pos: "WR", available: true, team: null, proj: 12, band: band(4, 11, 22, 12) };
  const b: WinProbPlayer = { name: "B", pos: "RB", available: true, team: null, proj: 9, band: band(2, 8, 18, 9) };
  const one = sampleWeek([a], { sims: 500, seed: 9 });
  const two = sampleWeek([a, b], { sims: 500, seed: 9 });
  assert.deepEqual(Array.from(one.pts[0]), Array.from(two.pts[0]),
    "adding a player re-rolled an existing one, so two lineups are not a paired comparison");
});

test("a player with NO BAND is a point mass, and the result SAYS SO", () => {
  const ours: WinProbPlayer[] = [
    { name: "Known", pos: "WR", available: true, team: null, proj: 12, band: band(9, 12, 15, 12) },
    { name: "Unknown", pos: "WR", available: true, team: null, proj: 11, band: null },
  ];
  const r = winProbLineup(ours, wall(24), ONE_WR, ["RB", "WR", "TE"], { sims: 2000, seed: SEED });
  assert.ok(r.pointMass >= 1);
  assert.ok(r.caveats.some((c) => /POINT MASS/.test(c)));
});

test("the opponent's assumed lineup is HIS best legal one on HIS own projections", () => {
  const roster: WinProbPlayer[] = [
    { name: "OQB", pos: "QB", available: true, team: null, proj: 20, band: band(10, 20, 30, 20) },
    { name: "OWR1", pos: "WR", available: true, team: null, proj: 15, band: band(5, 14, 26, 15) },
    { name: "OWR2", pos: "WR", available: true, team: null, proj: 9, band: band(3, 8, 16, 9) },
  ];
  const s = opponentStarters(roster, ["QB", "WR", "BE"], ["RB", "WR", "TE"]);
  assert.deepEqual(s.map((p) => p.name).sort(), ["OQB", "OWR1"]);
});
