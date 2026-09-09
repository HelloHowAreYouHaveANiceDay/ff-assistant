/**
 * DEFECT D4: the teammate correlation was measured on SAME WEEKS and applied to WHOLE SEASONS.
 *
 * `scripts/fit-correlation.mjs` measured QB-WR +0.348 on same-week residuals over 14,021 team-weeks.
 * Phase 1 moved the bootstrap draw from the week to the season -- correctly, because independent
 * weekly draws understate season-total spread by a factor of two -- and the copula moved with it. So
 * the sampler ended up coupling season QUALITY, and the same-week figure fell to +0.107 while the
 * season-total figure landed on target. Nothing failed: a correlation model was loaded, a Cholesky
 * factor was built, a number came out, and the number it came out at was the wrong one.
 *
 * A fantasy week is decided on the Sunday, so this is the half that matters for head-to-head.
 *
 * The within-week stage rearranges each coupled player's DRAWN season -- his own weekly scores dealt
 * to weeks in the order of a second correlated normal. The four things it must not break are each
 * asserted separately below, because a mechanism that restores the weekly correlation by disturbing
 * any of them has traded one wrong number for another:
 *
 *   1. the same-week correlation is restored to the fitted value      (the point)
 *   2. each player's WEEKLY multiset is bit-for-bit unchanged          (a permutation, not a resample)
 *   3. each player's SEASON TOTAL is bit-for-bit unchanged             (ditto)
 *   4. the POSITIONS of his zero weeks are unchanged                   (an injury is a run, not a rate)
 *
 * FAULT INJECTION is the `--no-week` arm, run here as a second measurement from the same fixture:
 * with the stage off, assertion 1 must fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { prepare, sampleSeason, weekOf, type RankOutcomes, type CorrelationModel, type PoolPlayer } from "../src/draft/bootstrap.js";

const HAVE = existsSync("data/rank-outcomes.json") && existsSync("data/correlation-model.json");
const outcomes: RankOutcomes | null = HAVE ? JSON.parse(readFileSync("data/rank-outcomes.json", "utf8")) : null;
const corr: CorrelationModel | null = HAVE ? JSON.parse(readFileSync("data/correlation-model.json", "utf8")) : null;

const PLAYERS: PoolPlayer[] = [
  { name: "QB1", pos: "QB", team: "AAA", rank: 3 },
  { name: "WR1", pos: "WR", team: "AAA", rank: 5 },
  { name: "TE1", pos: "TE", team: "AAA", rank: 4 },
  { name: "K1", pos: "K", team: "CCC", rank: 5 },
  { name: "DST1", pos: "DST", team: "CCC", rank: 5 },
  { name: "RB0", pos: "RB", team: "BBB", rank: 8 },     // uncoupled control
];

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pear = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};

/** ONE run of the sampler, every statistic taken from it. Two facts from two runs of a stochastic
 *  process are not a comparison -- see the top of docs/validation.md. */
function run(withWeekStage: boolean, trials = 6000) {
  const prep = prepare(PLAYERS, outcomes!, corr!, "none");
  const rng = mulberry32(20260908);
  const g = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const weekly = new Map(PLAYERS.map((p) => [p.name, [] as number[]]));
  const totals = new Map(PLAYERS.map((p) => [p.name, [] as number[]]));
  for (let i = 0; i < trials; i++) {
    const sn = sampleSeason(PLAYERS, prep, g, rng, withWeekStage ? g : undefined);
    const L = Math.max(...PLAYERS.map((p) => sn.get(p)?.weeks.length ?? 0));
    for (const p of PLAYERS) {
      const t = sn.get(p);
      totals.get(p.name)!.push(t ? t.total : 0);
      for (let w = 1; w <= L; w++) weekly.get(p.name)!.push(weekOf(t, w));
    }
  }
  return { weekly, totals };
}

test("the stage PERMUTES the drawn season -- it does not resample it", (t) => {
  if (!HAVE) return t.skip("no rank-outcomes/correlation model");
  const prep = prepare(PLAYERS, outcomes!, corr!, "none");
  // A pinned season draw on both sides: gauss 0 maps through the copula to the 0.5 quantile, so both
  // calls select the SAME trajectory for every player and the only difference is the permutation.
  const plain = sampleSeason(PLAYERS, prep, () => 0, () => 0.5);
  const rng = mulberry32(4242);
  const g = () => { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const permuted = sampleSeason(PLAYERS, prep, () => 0, () => 0.5, g);
  let moved = 0;
  for (const p of PLAYERS) {
    const a = plain.get(p), b = permuted.get(p);
    if (!a || !b) continue;
    assert.deepEqual([...b.weeks].sort((x, y) => x - y), [...a.weeks].sort((x, y) => x - y),
      `${p.name}: the weekly MULTISET changed -- the stage must permute, never resample`);
    assert.ok(Math.abs(b.total - a.total) < 1e-9, `${p.name}: season total moved from ${a.total} to ${b.total}`);
    assert.deepEqual(b.weeks.map((v) => v === 0), a.weeks.map((v) => v === 0),
      `${p.name}: a zero week moved. Their POSITIONS are the injury -- a torn ACL is a run of ` +
      `zeros at the end of a season, not zeros scattered through it.`);
    if (b.weeks.some((v, j) => v !== a.weeks[j])) moved++;
  }
  // POSITIVE CONTROL: the three assertions above all pass trivially if the stage does nothing at all.
  assert.ok(moved >= 3, `only ${moved} players' weeks were reordered -- the stage is not running`);
  // ...and the UNCOUPLED player must be untouched: he has no teammate to co-move with.
  assert.deepEqual(permuted.get(PLAYERS[5])!.weeks, plain.get(PLAYERS[5])!.weeks,
    "a player with no teammate in the group must not be permuted");
});

test("the within-week stage restores the SAME-WEEK teammate correlation", (t) => {
  if (!HAVE) return t.skip("no rank-outcomes/correlation model");
  const on = run(true);
  const w = (a: string, b: string) => pear(on.weekly.get(a)!, on.weekly.get(b)!);
  // Targets are the fitted same-week correlations, +/- 0.06 for sampling noise at this trial count.
  const want: [string, string, number][] = [["QB1", "WR1", 0.35], ["QB1", "TE1", 0.22], ["K1", "DST1", 0.22]];
  for (const [a, b, target] of want) {
    const got = w(a, b);
    assert.ok(Math.abs(got - target) <= 0.06,
      `${a}-${b} same-week correlation ${got.toFixed(3)}, target ${target}`);
  }
  // The cross-team control must stay at zero, or the "correlation" is a global effect wearing a
  // teammate costume.
  assert.ok(Math.abs(w("QB1", "RB0")) < 0.05, `cross-team QB-RB reads ${w("QB1", "RB0").toFixed(3)}`);
});

test("FAULT: with the within-week stage OFF the same-week correlation collapses", (t) => {
  if (!HAVE) return t.skip("no rank-outcomes/correlation model");
  const off = run(false);
  const got = pear(off.weekly.get("QB1")!, off.weekly.get("WR1")!);
  // This is the Phase 1 behaviour -- around +0.11 -- and the assertion above must be unable to pass
  // against it. If this ever reads near 0.35 the two arms no longer differ and the guard is dead.
  assert.ok(got < 0.25,
    `with the stage off QB-WR same-week reads ${got.toFixed(3)}; the guard cannot distinguish the arms`);
});
