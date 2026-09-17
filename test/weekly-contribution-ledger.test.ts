/**
 * THE WEEKLY CONTRIBUTION LEDGER'S DRIVER (M2g) -- the arm plan, the paired contribution, and the
 * two verdicts that are not the same statement.
 *
 * WHY THIS FILE EXISTS. `scripts/weekly-contribution-ledger.mjs` prints a 25-row table that a human
 * will read as "what each shipped weekly feature is worth". Every way that table can be WRONG while
 * looking right is a property of the driver, not of the model:
 *
 *   - an arm that silently keeps the feature it claims to drop (the ablation never happened);
 *   - an arm the trainer would REFUSE, reported as a measured zero rather than as a refusal;
 *   - a knock-in table that credits one family with the four columns every arm carries;
 *   - a contribution whose SIGN is inverted, which turns the ledger's reading inside out;
 *   - two identical runs reported as "no effect" instead of as a disconnected lever.
 *
 * So the assertions below are about exactly those, and the sign test is the load-bearing one: the
 * whole document rests on POSITIVE meaning "removing this hurt".
 *
 * Nothing here trains anything, reads the store, or touches data/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SHIPPED, REQUIRED, FAMILIES, FLOOR_PLUS, ALL_SEASONS,
  buildArms, foldJobs, ordered, twoPartFeasible,
  crpsBySeason, contribution, isDegenerate, signs, lineupOf,
} from "../scripts/weekly-contribution-ledger.mjs";

test("the shipped design is the features the served artifact actually fits", () => {
  const art = JSON.parse(readFileSync("data/weekly-artifact.json", "utf8")) as { features: { name: string }[] };
  const served = art.features.map((f) => f.name);
  // Not "the same set" -- the SAME LIST. The ledger's whole claim is that it ablated the design that
  // ships, so a served artifact that grew a column must fail here rather than be quietly measured as
  // the old width. It DID: D27/WP16b promoted `ecr_wk_rank`/`ecr_wk_sd` and this assertion is what
  // caught it, which is the pin working rather than the pin being in the way. The driver was moved
  // to 27, then to 26 when D30/WP18 dropped the dead `inj_feed` column; the PUBLISHED ledger was
  // measured on the 25 and says so at the top of its own file, with the rerun in a dated section.
  assert.deepEqual([...SHIPPED].sort(), [...served].sort(),
    "SHIPPED has drifted from the served weekly artifact -- the ledger would ablate a design nobody serves");
  assert.equal(SHIPPED.length, 26);
  // The dropped column is dropped from the DESIGN, not from the store: it is still built and still
  // audited, so a test that asserted its absence everywhere would be asserting the wrong thing.
  assert.equal(SHIPPED.includes("inj_feed"), false, "D30 dropped inj_feed from the fitted design");
});

test("the families PARTITION the shipped design -- no feature is counted twice or left out", () => {
  const all = Object.values(FAMILIES).flat();
  assert.equal(all.length, new Set(all).size, "a feature is in two families");
  assert.deepEqual([...all].sort(), [...SHIPPED].sort());
});

test("the trainer's two-part contract is honoured, not routed around", () => {
  for (const c of REQUIRED) assert.ok(SHIPPED.includes(c));
  assert.equal(twoPartFeasible(SHIPPED), true);
  for (const c of REQUIRED) {
    assert.equal(twoPartFeasible(SHIPPED.filter((x) => x !== c)), false, `${c} must make a design infeasible`);
  }
  const arms = buildArms();
  // Exactly the four required columns are REFUSED leave-one-outs, and each has a serve-mask arm
  // standing in for it -- a REFUSED row with no substitute would be a silent hole in the table.
  const refused = arms.filter((a) => a.refused).map((a) => a.id).sort();
  assert.deepEqual(refused, REQUIRED.map((c) => `loo__${c}`).sort());
  for (const c of REQUIRED) {
    const m = arms.find((a) => a.id === `mask__${c}`);
    assert.ok(m, `no serve-mask arm stands in for the refused loo__${c}`);
    assert.equal(m!.substitutes, `loo__${c}`);
  }
  // and EVERY arm that will actually be handed to the trainer is fittable.
  for (const a of arms.filter((x) => !x.refused && !x.reuseFrom)) {
    assert.ok(twoPartFeasible(a.features), `${a.id} would be refused by the trainer`);
  }
});

test("every retrained arm really removes what it says, and nothing else", () => {
  for (const a of buildArms()) {
    if (a.refused || a.reuseFrom) continue;
    const have = new Set(a.features);
    if (a.kind === "loo") {
      assert.equal(have.has(a.drop![0]), false, `${a.id} still fits the feature it drops`);
      assert.equal(a.features.length, SHIPPED.length - 1);
    }
    if (a.kind === "famloo") {
      for (const c of a.drop!) assert.equal(have.has(c), false, `${a.id} still fits ${c}`);
      // the kept columns are exactly the rest of the design
      assert.equal(a.features.length, SHIPPED.length - a.drop!.length);
    }
    // ORDER IS NOT A FREE VARIABLE: two arms with the same set must produce the same --features
    // string, or the fold bytes differ for a reason that is not the ablation.
    assert.deepEqual(a.features, ordered(a.features), `${a.id} is not in SHIPPED order`);
  }
});

test("the knock-in table holds the floor constant, so no family is credited with the required columns", () => {
  const arms = buildArms();
  const knock = arms.filter((a) => a.kind === "knockin");
  assert.ok(knock.some((a) => a.id === "knockin__floor"));
  for (const a of knock) {
    for (const c of FLOOR_PLUS) assert.ok(a.features.includes(c), `${a.id} lost a floor column`);
  }
  // Each non-floor knock-in adds ONLY its own family's non-floor members.
  for (const a of knock.filter((x) => x.id !== "knockin__floor")) {
    const extra = a.features.filter((f) => !FLOOR_PLUS.includes(f));
    assert.deepEqual([...extra].sort(), [...a.add!].sort());
    for (const c of extra) assert.ok(FAMILIES[a.family as keyof typeof FAMILIES].includes(c));
  }
  // The level family IS the floor's anchor and its own leave-one-out, so it gets neither a
  // leave-family-out arm nor a knock-in arm -- both would be duplicates under another name.
  assert.ok(!arms.some((a) => a.id === "famloo__level"));
  assert.ok(!arms.some((a) => a.id === "knockin__level"));
  assert.ok(arms.some((a) => a.id === "loo__season_line_pg"));
});

test("the serve-mask arms train NOTHING and reuse the full design's folds", () => {
  const arms = buildArms();
  const masks = arms.filter((a) => a.kind === "mask" || a.kind === "maskfam" || a.kind === "control");
  assert.equal(masks.length, SHIPPED.length + Object.keys(FAMILIES).length + 1);
  for (const a of masks) {
    assert.equal(a.reuseFrom, "full");
    assert.deepEqual(a.features, SHIPPED, `${a.id} must be scored on the FULL design -- the mask is a serve-time act`);
  }
  // ...and so they contribute no fold jobs at all.
  const jobs = foldJobs(arms);
  assert.equal(jobs.filter((j) => j.arm.startsWith("mask")).length, 0);
  assert.equal(jobs.filter((j) => j.arm === "full_dup").length, 0);
  assert.equal(jobs.length, arms.filter((a) => !a.refused && !a.reuseFrom).length * ALL_SEASONS.length);
});

test("crpsBySeason reads the weekly model's pooled CRPS and ignores the other models", () => {
  const ev = { bySeason: { 2012: { weekly: { crps: 2.5 }, lineOnly: { crps: 9 } }, 2013: { weekly: { crps: 2.6 } }, 2014: { lineOnly: { crps: 3 } } } };
  const m = crpsBySeason(ev);
  assert.deepEqual([...m.entries()], [[2012, 2.5], [2013, 2.6]]);
  assert.equal(crpsBySeason(ev, "lineOnly").get(2012), 9);
});

test("contribution is POSITIVE when the ablated arm is worse -- the sign the whole ledger rests on", () => {
  const full = new Map(ALL_SEASONS.map((y) => [y, 2.700]));
  const worse = new Map(ALL_SEASONS.map((y) => [y, 2.750]));   // dropping the feature COST 0.05 CRPS
  const better = new Map(ALL_SEASONS.map((y) => [y, 2.650]));  // dropping it HELPED
  assert.ok(contribution(full, worse, ALL_SEASONS)!.improvement > 0);
  assert.ok(contribution(full, better, ALL_SEASONS)!.improvement < 0);
  assert.ok(Math.abs(contribution(full, worse, ALL_SEASONS)!.improvement - 0.05) < 1e-9);
  assert.equal(contribution(full, worse, [2012, 2013]), null, "fewer than three seasons is not a season floor");
});

test("the floor can say KEEP and can say sub-floor -- a table of DROPs is what a dead harness prints", () => {
  // A consistent, large effect must PASS; a noisy zero must not. Both directions, because a verdict
  // function that can only ever return one of them is indistinguishable from a broken one.
  const full = new Map(ALL_SEASONS.map((y, i) => [y, 2.7 + (i % 3) * 0.01]));
  const bigLoss = new Map([...full.entries()].map(([y, v]) => [y, v + 0.20]));
  const noise = new Map([...full.entries()].map(([y, v], i) => [y, v + (i % 2 ? 0.05 : -0.05)]));
  assert.equal(contribution(full, bigLoss, ALL_SEASONS)!.pass, true, "a clean 0.20 CRPS loss must clear 2.9*SE");
  assert.equal(contribution(full, noise, ALL_SEASONS)!.pass, false, "an alternating +/-0.05 must not clear it");
});

test("a degenerate arm is distinguished from a zero-effect arm", () => {
  const full = new Map(ALL_SEASONS.map((y, i) => [y, 2.7 + i * 0.001]));
  const identical = new Map(full);
  const noisyZero = new Map(ALL_SEASONS.map((y, i) => [y, 2.7 + i * 0.001 + (i % 2 ? 0.004 : -0.004)]));
  assert.equal(isDegenerate(full, identical, ALL_SEASONS), true);
  assert.equal(isDegenerate(full, noisyZero, ALL_SEASONS), false, "a real ~0 effect must NOT read as degenerate");
  // and the noisy-zero arm's mean effect really is ~0, so the two verdicts are not the same statement
  assert.ok(Math.abs(contribution(full, noisyZero, ALL_SEASONS)!.improvement) < 1e-3);
});

test("the per-season sign string can show every character it defines", () => {
  const seasons = [2012, 2013, 2014];
  const full = new Map([[2012, 2.7], [2013, 2.7], [2014, 2.7]]);
  const arm = new Map([[2012, 2.8], [2013, 2.6], [2014, 2.7]]);
  assert.equal(signs(full, arm, seasons), "+-0");
  assert.equal(signs(full, new Map([[2012, 2.8]]), seasons), "+  ");
});

test("lineupOf reads the weekly model's captured points per scenario", () => {
  const ev = { lineup: { "standard-15": { weekly: { meanCaptured: 85.5 }, week: { meanCaptured: 77 } }, "deep-18": { week: { meanCaptured: 80 } } } };
  assert.deepEqual(lineupOf(ev), { "standard-15": 85.5 });
});
