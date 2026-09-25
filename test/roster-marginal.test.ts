/**
 * ROSTER-AWARE VALUE, tested on the fixture league with the REAL simulator.
 *
 * Every assertion here is a statement the VOR book CANNOT make, because VOR prices a player against
 * a replacement level derived from the league's format rather than from our roster: a second
 * quarterback behind a healthy one, a kicker who can only sit on the bench, and two identical tight
 * ends whose byes fall in different weeks are all worth exactly the same to `computeValues` and are
 * worth very different amounts to a team. So each test is paired with the case that must come out
 * differently -- a guard that can only ever say "small" is not measuring anything.
 *
 * TRIALS ARE LOW AND THE EFFECTS ARE LARGE, deliberately. These are structural claims (a bench K is
 * worth about nothing) rather than measurements of a small edge, and every comparison is run under
 * COMMON RANDOM NUMBERS through one `MarginalBook`, so the two arms meet the same seasons.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MarginalBook, fillRoster, slotAccepts, type MarginalEnv, type MarginalPlayer, type MarginalState } from "../src/draft/rosterMarginal.js";
import { simulateSeasons } from "../src/draft/season.js";
import { fixtureCtx, vm, SLOTS, FLEX_OK } from "./fixtures/copilot-league.js";

const ctx = fixtureCtx();
/** A flat market: everyone costs what his projection is worth on a crude linear scale, floored at
 *  $1. The fill only needs SOME price signal; what it must not have is a price of zero, which would
 *  make the budget curve meaningless. */
const priceOf = (p: MarginalPlayer) => Math.max(1, Math.round(p.proj / 20));

const env: MarginalEnv = {
  weeks: ctx.weeks,
  vm,
  opts: (trials, seed) => ctx.opts(trials, seed),
  slots: SLOTS,
  flexOk: FLEX_OK,
  priceOf,
};

/** The other fifteen teams, untouched, so every arm faces the same field. */
const opponents = ctx.teams.slice(1);

const P = (name: string, pos: string, proj: number, bye: number | null = null): MarginalPlayer =>
  ({ name, pos, proj, team: "NFLX", bye });

/** A full twelve-man roster in the league's shape, so removing one slot is the only difference
 *  between two states. `over` replaces individual entries by index. */
function baseRoster(over: Record<number, MarginalPlayer | null> = {}): MarginalPlayer[] {
  const spec: MarginalPlayer[] = [
    P("Quinn Zed", "QB", 300), P("Rex Zed", "RB", 250), P("Ross Zed", "RB", 200),
    P("Wade Zed", "WR", 240), P("Will Zed", "WR", 210), P("Wynn Zed", "WR", 180),
    P("Tate Zed", "TE", 150, 7), P("Kane Zed", "K", 120), P("Dane Zed", "DST", 110),
    P("Rory Zed", "RB", 90), P("Wren Zed", "WR", 85), P("Todd Zed", "TE", 80),
  ];
  const out: MarginalPlayer[] = [];
  for (let i = 0; i < spec.length; i++) {
    const o = Object.prototype.hasOwnProperty.call(over, i) ? over[i] : spec[i];
    if (o) out.push(o);
  }
  return out;
}

/** The free pool every state draws its fill from -- cheap bodies at every position, so no state is
 *  ever unable to fill a slot for want of a legal body. */
const POOL: MarginalPlayer[] = [
  ...["QB", "RB", "WR", "TE", "K", "DST"].flatMap((pos) => [0, 1, 2, 3].map((k) =>
    P(`Free ${pos} ${"XYZW"[k]}`, pos, 70 - 18 * k))),
];

function mkState(roster: MarginalPlayer[], openSlots: string[], extraPool: MarginalPlayer[] = [], budget = 60): MarginalState {
  // A STATE MUST ADD UP. Twelve men plus one open bench slot is thirteen roster spots, and the
  // simulator will happily field it -- the extra man simply never starts, so every marginal measured
  // against that baseline is a comparison between two illegal rosters. Three of these tests were
  // written that way first and produced a bench kicker worth MINUS thirteen points.
  assert.equal(roster.length + openSlots.length, SLOTS.length,
    `state has ${roster.length} players and ${openSlots.length} open slots, which is not a ${SLOTS.length}-man roster`);
  return { roster, openSlots, budget, pool: [...extraPool, ...POOL], opponents, meId: "0", meName: "us" };
}

const BOOK = { trials: 150, seed: 21, shadowSteps: 1 };

// =============================================================================================
// A SECOND QUARTERBACK IS NOT A FIRST QUARTERBACK
// =============================================================================================

test("marginal: a QB behind a healthy starter is worth far less than the same QB filling an empty QB slot", () => {
  const qb = P("Adam Free", "QB", 300);
  const withStarter = new MarginalBook(mkState(baseRoster({ 11: null }), ["BE"], [qb]), env, BOOK);
  const withoutStarter = new MarginalBook(mkState(baseRoster({ 0: null }), ["QB"], [qb]), env, BOOK);
  const backup = withStarter.marginal(qb);
  const starter = withoutStarter.marginal(qb);
  assert.ok(starter.playoffsPp > backup.playoffsPp + 2,
    `the same quarterback measured ${starter.playoffsPp}pp filling an empty slot and ${backup.playoffsPp}pp as a backup -- ` +
    "a roster-aware value that cannot separate those two is not roster-aware");
  assert.equal(starter.objective, "playoffs");
});

// =============================================================================================
// A BENCH KICKER OR DEFENCE IS DEAD ROSTER
// =============================================================================================

test("marginal: at a streamed position the bench tells two men apart far less than at running back", () => {
  // "A BENCH K IS WORTH ABOUT ZERO" IS NOT DIRECTLY TESTABLE HERE and the first version of this test
  // tried anyway. In a fixture where all sixteen rosters are identical the playoff race is a
  // knife-edge, so ANY change to the twelfth man moves P(playoffs) several points -- the bench kicker
  // measured -12pp, which is a real statement about giving up a bench back, not about the kicker.
  //
  // The claim that IS the point survives that: a bench slot at a streamed position is DEAD, so how
  // good the man is cannot matter. Two kickers seventy points apart must be worth the same on the
  // bench; two backs two hundred points apart must not, which is the positive control that the
  // measurement can separate anything at all.
  //
  // PAIRED, 2026-09-25. Each comparison is now the SAME man (same name, so the same keyed draws) in
  // two otherwise identical books, differing only in his projection. The first version compared six
  // differently-named men -- six unpaired random streams -- and its "<= 2pp" passed only on the luck
  // of one seed under a week draw that was not a normal (season.ts `perfRng`); fixing the draw failed
  // it. Paired, a better bench kicker is consistently worth +2-4pp, which is REAL, not dead roster:
  // the lineup is set on a noisy true mean, so a good bench kicker sometimes starts. The claim that
  // survives is the RATIO: at a streamed position the bench is worth a fraction of what it is worth
  // at running back (measured 0.07-0.25 of it over seeds 21-24).
  const pair = (name: string, pos: string, good: number, bad: number): number => {
    const at = (proj: number) => {
      const p = P(name, pos, proj);
      return new MarginalBook(mkState(baseRoster({ 11: null }), ["BE"], [p]), env, { ...BOOK, fillExclude: [name] }).marginal(p).playoffsPp;
    };
    return Math.abs(at(good) - at(bad));
  };
  const dK = pair("Kip Free", "K", 110, 40);
  const dD = pair("Dirk Free", "DST", 100, 30);
  const dR = pair("Rand Free", "RB", 260, 60);
  assert.ok(dR > 2, `two bench backs 200 points apart differed by only ${dR}pp -- the bench cannot tell anyone apart, so the lines below prove nothing`);
  assert.ok(dK < 0.4 * dR, `a bench kicker 70 points better moved ${dK}pp against ${dR}pp for a back -- the bench K slot is not near-dead here`);
  assert.ok(dD < 0.4 * dR, `a bench defence 70 points better moved ${dD}pp against ${dR}pp for a back`);
});

// =============================================================================================
// A BYE THAT COLLIDES WITH OUR ONLY STARTER AT THAT SLOT
// =============================================================================================

test("marginal: a backup whose bye collides with our only tight end is worth less than the identical man on a different bye", () => {
  // The roster's only real TE, `Tate Zed`, is on bye in week 7 and the depth TE is removed, so the
  // slot genuinely has one body. Two candidates identical in every way except the week they are off.
  //
  // PAIRED, 2026-09-25: the SAME man ("Cy Free", same keyed draws) with bye 7 in one book and bye 11
  // in another. The first version compared "Cyrus Free" with "Cedric Free" -- two unpaired streams --
  // and passed on one seed's luck; with the week draw fixed (season.ts `perfRng`) it read -8pp. The
  // replacement fill is OFF here: with it, the collision costs only the gap to a streamed tight end
  // (~8 points once), below this fixture's resolution. At 200 trials the gap is positive on 5/5 seeds
  // (21-25, +0.5 to +3.5pp) and at least the no-clash gap on 5/5.
  const envNoRep: MarginalEnv = { ...env, opts: (t, s) => ({ ...ctx.opts(t, s), replacement: undefined }) };
  const at = (roster: MarginalPlayer[], bye: number) => {
    const p = P("Cy Free", "TE", 200, bye);
    return new MarginalBook(mkState(roster, ["BE"], [p]), envNoRep, { ...BOOK, trials: 200, fillExclude: ["Cy Free"] }).marginal(p).playoffsPp;
  };
  const roster = baseRoster({ 11: null });
  const gapWith = at(roster, 11) - at(roster, 7);
  assert.ok(gapWith > 0,
    `bye-11 minus bye-7 (colliding with our only TE) measured ${gapWith}pp -- the bye is not reaching the marginal`);

  // FAULT INJECTION. Take the collision away -- our tight end now plays every week -- and the gap
  // must not grow, because the only thing distinguishing the two was the week he covers.
  const noClash = baseRoster({ 6: P("Tate Zed", "TE", 150, null), 11: null });
  const gapWithout = at(noClash, 11) - at(noClash, 7);
  assert.ok(gapWithout <= gapWith,
    `the gap was ${gapWith}pp with the collision and ${gapWithout}pp without it -- removing the collision did not shrink it, so the collision was not what produced it`);
});

// =============================================================================================
// THE MARGINAL MOVES WHEN THE ROSTER MOVES
// =============================================================================================

test("marginal: the same player is worth different amounts to two different rosters", () => {
  const wr = P("Walt Free", "WR", 250);
  // One roster is deep at receiver (three good ones plus depth); the other has lost two of them, so
  // the same man walks into a starting slot rather than into a queue.
  const deep = new MarginalBook(mkState(baseRoster({ 11: null }), ["BE"], [wr]), env, BOOK).marginal(wr);
  const thin = new MarginalBook(mkState(baseRoster({ 4: null, 5: null }), ["WR", "BE"], [wr]), env, BOOK).marginal(wr);
  assert.notEqual(deep.playoffsPp, thin.playoffsPp);
  assert.ok(thin.playoffsPp > deep.playoffsPp,
    `the thin roster valued him at ${thin.playoffsPp}pp and the deep one at ${deep.playoffsPp}pp`);
});

// =============================================================================================
// THE DOLLAR CONVERSION
// =============================================================================================

test("the budget curve is monotone and spans a real range -- a flat curve prices everyone at the budget", () => {
  // STARTING slots, not bench ones: money spent on the bench barely moves a season, so a curve
  // measured over three bench slots is flat for a real reason and cannot test anything.
  const book = new MarginalBook(mkState(baseRoster({ 1: null, 3: null, 9: null }), ["RB", "WR", "BE"], []), env, { trials: 200, seed: 5, shadowSteps: 2 });
  const c = book.budgetCurve();
  for (let i = 1; i < c.length; i++) assert.ok(c[i].playoffs >= c[i - 1].playoffs, "the curve decreases with more money");
  assert.ok(c[c.length - 1].playoffs > c[0].playoffs, "the budget buys nothing at all -- the curve cannot price anything");
});

test("dollarsFor is bounded by the budget and rises with the marginal it prices", () => {
  const state = mkState(baseRoster({ 1: null, 3: null }), ["RB", "WR"], []);
  const book = new MarginalBook(state, env, { trials: 200, seed: 5, shadowSteps: 2 });
  const c = book.budgetCurve();
  const span = c[c.length - 1].playoffs - c[0].playoffs;
  const small = book.dollarsFor(span * 0.2), big = book.dollarsFor(span * 0.8);
  assert.ok(small >= 0 && big <= state.budget, `${small} / ${big} outside [0, ${state.budget}]`);
  assert.ok(big > small, `a bigger marginal priced no higher: ${big} vs ${small}`);
  assert.equal(book.dollarsFor(0), 0);
  // FAULT INJECTION: a marginal larger than everything the budget can buy must saturate at the
  // budget, not run off to an arbitrary number. The first version divided by a local slope and
  // priced a $200 auction's best player at $406.
  assert.equal(book.dollarsFor(span * 100), state.budget);
});

// =============================================================================================
// THE FILL -- the plan the shadow price is measured against
// =============================================================================================

test("fillRoster fills every slot it legally can, spends the money, and does not stack the bench with quarterbacks", () => {
  const state = mkState([], [...SLOTS], []);
  const rich = fillRoster(state, env, 200);
  const poor = fillRoster(state, env, 12);
  assert.equal(rich.length, SLOTS.length, "a fill that leaves slots empty understates what the money buys");
  const spentRich = rich.reduce((a, p) => a + priceOf(p), 0);
  const spentPoor = poor.reduce((a, p) => a + priceOf(p), 0);
  assert.ok(spentRich > spentPoor, `the fill spent ${spentRich} at $200 and ${spentPoor} at $12`);
  assert.ok(spentRich <= 200, `the fill spent ${spentRich} of a $200 budget`);
  const qbs = rich.filter((p) => p.pos === "QB").length;
  assert.ok(qbs <= 2, `the fill rostered ${qbs} quarterbacks -- raw season points put every QB above every WR, and a plan that sorts on them buys four`);
});

test("slotAccepts: FLEX takes the league's own eligibility and a dedicated slot takes only its own position", () => {
  assert.equal(slotAccepts("FLEX", "RB", FLEX_OK), true);
  assert.equal(slotAccepts("FLEX", "QB", FLEX_OK), false);
  assert.equal(slotAccepts("QB", "RB", FLEX_OK), false);
  assert.equal(slotAccepts("BE", "K", FLEX_OK), true);
});

// =============================================================================================
// PLAYOFF-WEEK STRENGTH -- the SECONDARY objective
// =============================================================================================

test("playoffWeekPts is reported only when asked for, and a better roster scores more in weeks 15-17", () => {
  const mk = (mult: number, on: boolean) => simulateSeasons(
    [{ id: "0", name: "us", roster: baseRoster().map((p) => ({ ...p, proj: p.proj * mult })) }, ...opponents],
    ctx.weeks, vm, { ...ctx.opts(200, 9), playoffWeekStrength: on, allowIncompleteRosters: true },
  )[0];
  assert.ok(Number.isNaN(mk(1, false).playoffWeekPts),
    "playoffWeekPts came back a number without being asked for -- a consumer would read a zero as 'this roster scores nothing in December'");
  const weak = mk(1, true).playoffWeekPts, strong = mk(1.6, true).playoffWeekPts;
  assert.ok(strong > weak, `a 60% stronger roster scored ${strong} against ${weak} over the playoff weeks`);
});
