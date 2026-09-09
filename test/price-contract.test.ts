/**
 * THE PRICE MODEL'S TRAIN/SERVE CONTRACT.
 *
 * Same shape as test/artifact-contract.test.ts, and for the same reason: the decisive test is to run
 * BYTES THE PRODUCER ACTUALLY EMITTED through the CONSUMER'S REAL evaluator. The trainer writes five
 * fixture market states together with its own predicted dollars; `loadPriceModel` recomputes them in
 * TypeScript and refuses the artifact if the two disagree by more than 1e-6.
 *
 * A hurdle model has a second failure mode worth naming, because it is silent: if the consumer drops
 * either part, prices remain plausible. Lose the hurdle and everyone is priced at their conditional
 * level, so the $1 tail disappears into $4s; lose the level and everyone is $1. Neither throws. The
 * loader therefore refuses an artifact missing either head, and the golden rows below span both a
 * cheap unranked kicker and a rank-1 running back so a dropped part cannot pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPriceModel, checkPriceGolden, priceFor, type PriceArtifact } from "../src/model/price.js";

const FIXTURE = "test/fixtures/price-model.json";
const raw = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as PriceArtifact;

test("the trainer's own output loads through the shipped loader", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = loadPriceModel(raw());
  assert.equal(a.fittedFrom, "tools/train_price.py");
  assert.ok(a.golden && a.golden.length >= 4, "an artifact with no golden rows proves nothing about the seam");
  assert.ok(a.seasons.length >= 3, "a room's price model wants more than one draft");
});

test("the trainer's golden predictions reproduce in TypeScript within 1e-6", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = raw();
  checkPriceGolden(a, 1e-6);
  assert.ok((a.golden ?? []).length >= 4);
});

test("FAULT: perturbing one golden prediction makes the loader REFUSE it", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = raw();
  a.golden![0].expect += 1e-3;
  assert.throws(() => loadPriceModel(a), /golden row 0/);
});

test("FAULT: dropping the hurdle head makes the loader REFUSE it", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = raw();
  delete (a.coef.RB as Partial<typeof a.coef.RB>).hurdle;
  assert.throws(() => loadPriceModel(a), /'hurdle' head/);
});

test("FAULT: renaming a feature makes the loader REFUSE it", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = raw();
  (a.features[0] as { name: string }).name = "hype";
  assert.throws(() => loadPriceModel(a), /not one this evaluator can compute/);
});

test("FAULT: dropping the smearing factor makes the loader REFUSE it", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = raw();
  (a as { smear: number }).smear = 0;
  assert.throws(() => loadPriceModel(a), /smear must be positive/);
});

test("the model has FACE VALIDITY: the elite cost more, the unranked cost about a dollar", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = loadPriceModel(raw());
  const M = 3200;                                     // a 16-team, $200 room
  const at = (pos: string, rank: number | null) => priceFor(a, pos, {
    ecrPosRank: rank, ecrSd: rank ? Math.max(1, rank * 0.3) : null,
    moneyLeft: 1, slotsLeft: 1, pickShare: 0, leagueMoney: M,
  });
  const rb1 = at("RB", 1), rb12 = at("RB", 12), rb40 = at("RB", 40), rbNone = at("RB", null);
  assert.ok(rb1 > rb12 && rb12 > rb40 && rb40 >= rbNone,
    `RB prices must fall with rank: ${rb1.toFixed(1)} / ${rb12.toFixed(1)} / ${rb40.toFixed(1)} / ${rbNone.toFixed(1)}`);
  // The room's real top price is $88-106 across 2022-2025. A model that puts the best RB at $250 or
  // at $20 is not describing this room, whatever its residuals say.
  assert.ok(rb1 >= 55 && rb1 <= 130, `top RB priced at $${rb1.toFixed(0)}; the room's real top is $88-106`);
  assert.ok(rbNone <= 3, `an unranked RB at $${rbNone.toFixed(1)} -- the $1 mass is not being respected`);
  assert.ok(at("K", 1) <= 6, `the best kicker at $${at("K", 1).toFixed(1)}; this room pays $1-2 for one`);
  // AND THE MARKET STATE MUST MATTER. A model whose market-state slopes were dropped would satisfy
  // every assertion above and be a static rank table.
  const late = priceFor(a, "RB", {
    ecrPosRank: 12, ecrSd: 4, moneyLeft: 0.05, slotsLeft: 0.1, pickShare: 0.95, leagueMoney: M,
  });
  assert.ok(Math.abs(late - rb12) > 1,
    `the same RB12 prices at $${rb12.toFixed(1)} early and $${late.toFixed(1)} with the room broke -- ` +
    `if those are equal the market-state features are not connected`);
});

test("the committed fixture is still what the trainer produces TODAY", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  if (!existsSync("data/ff.db")) return t.skip("no store to train against");
  const tmp = join(tmpdir(), `ff-price-contract-${process.pid}.json`);
  try {
    execFileSync("uv", [
      "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_price.py",
      "--db", "data/ff.db", "--out", tmp, "--quiet",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
  } catch { return t.skip("uv/scikit-learn unavailable, or the trainer could not run here"); }
  if (!existsSync(tmp)) return t.skip("trainer produced no output file");
  const fresh = JSON.parse(readFileSync(tmp, "utf8")) as PriceArtifact;
  rmSync(tmp, { force: true });
  const fx = raw();
  assert.deepEqual(fresh.features.map((f) => f.name), fx.features.map((f) => f.name),
    "the trainer's feature NAMES have changed since the fixture was recorded -- re-record it");
  // FEATURE NAMES ARE NOT ENOUGH. `inflation` and `quad` produce the SAME post-table feature list --
  // the rank terms are absorbed into the rank table -- so a fixture recorded under one and a trainer
  // defaulting to the other would agree on every name and disagree on every number.
  assert.equal((fresh as { marketState?: string }).marketState, (fx as { marketState?: string }).marketState,
    "the trainer's default market-state variant has changed since the fixture was recorded");
  assert.deepEqual(Object.keys(fresh.coef).sort(), Object.keys(fx.coef).sort());
  assert.deepEqual(Object.keys(fresh.rankTable).sort(), Object.keys(fx.rankTable).sort());
  checkPriceGolden(fresh, 1e-6);
});

test("FAULT: a rank table that CLIMBS is refused", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = raw();
  // The defect this catches shipped once: an unrepaired per-position parabola put the RB3 above the
  // RB1 while every residual statistic improved. No MAE can see an inverted ordering.
  a.rankTable.RB.level[5] = a.rankTable.RB.level[4] + 0.5;
  assert.throws(() => loadPriceModel(a), /rank table climbs/);
});

test("the shipped rank table falls with rank at every position -- the positive control", (t) => {
  if (!existsSync(FIXTURE)) return t.skip("no price fixture");
  const a = loadPriceModel(raw());
  for (const [pos, t2] of Object.entries(a.rankTable)) {
    // Not merely non-increasing (the loader checks that): the PRICE must actually fall, or the model
    // has no opinion about rank at all and the table is decoration.
    //
    // Either head may carry it, and at KICKER only one does: this room pays $1-2 for a kicker
    // whichever one it is, so the level head is genuinely flat and the whole rank effect lives in
    // the hurdle -- whether he costs a dollar or two dollars. Requiring both to fall would fail on a
    // model that is right about kickers.
    const falls = (v: number[]) => v[0] > v[v.length - 1] + 1e-6;
    assert.ok(falls(t2.level) || falls(t2.hurdle),
      `${pos}: neither the level nor the hurdle table falls with rank -- the rank effect is not connected`);
  }
  // ...and at the four positions this room actually spends money on, the LEVEL must fall: their
  // prices differ by far more than a dollar across ranks, which the hurdle alone cannot express.
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const t2 = a.rankTable[pos];
    assert.ok(t2.level[0] > t2.level[t2.level.length - 1] + 0.5, `${pos} level table is flat`);
  }
});
