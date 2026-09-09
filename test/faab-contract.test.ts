// THE TRAIN/SERVE CONTRACT FOR THE FAAB MODEL: does src/inseason/faab.ts agree with
// tools/train_faab.py?
//
// Same shape, and for the same reason, as test/artifact-contract.test.ts. A producer that ships its
// OWN validator mirroring its OWN types grades its own homework and passes forever while every
// consumer rejects its output. So the golden block inside data/faab-model.json holds the TRAINER'S
// OWN numbers for five fixture rows -- a clearing price, three points on the P(win) curve, and the
// closed-form solve for a 70% target -- and the TypeScript evaluator recomputes every one of them.
//
// The three formulas exist in both languages on purpose. That is not duplication to refactor away;
// it is the only thing that makes this comparison mean anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  loadFaabModel, checkGolden, clearingPrice, pWin, bidForWinProb, recommendBid, featureRow,
  FAAB_ARTIFACT_PATH, type FaabModel, type FaabRow,
} from "../src/inseason/faab.js";

const model = (): FaabModel | null => (existsSync(FAAB_ARTIFACT_PATH) ? loadFaabModel(FAAB_ARTIFACT_PATH) : null);

test("the trainer's own predictions are reproduced by the TypeScript evaluator", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact -- run tools/train_faab.py");
  const g = checkGolden(m);
  assert.ok(g.rows >= 5, `expected at least five golden rows, got ${g.rows}`);
  assert.ok(g.worst < 1e-6, `train/serve disagree by ${g.worst} -- ${g.where}`);
});

test("the artifact publishes no target column as an input", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  // The same list scripts/faab-leakage.mjs G5 enforces. Checked against the artifact's OWN published
  // names rather than against a symptom of leakage, which nothing downstream could detect.
  for (const bad of ["ros_pts", "ros_games", "won", "competing_bids", "bid_amount"]) {
    assert.ok(!m.features.includes(bad), `${bad} is published as a model input`);
  }
  assert.ok(m.features.includes("team_faab_share"), "the remaining-budget feature is missing entirely");
});

test("P(win) rises with the bid, and the recommender inverts it exactly", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  const row: FaabRow = { budget: 100, f: m.golden[0].f };
  const a = pWin(m, row, 1), b = pWin(m, row, 10), c = pWin(m, row, 60);
  assert.ok(a < b && b < c, `P(win) is not monotone in the bid: ${a} ${b} ${c}`);
  // The closed-form solve must land ON its own target, to within the rounding up to whole dollars.
  for (const target of [0.4, 0.55, 0.7]) {
    const bid = bidForWinProb(m, row, target);
    if (bid == null) continue;
    assert.ok(pWin(m, row, bid) >= target - 1e-9, `bid ${bid} does not reach ${target}`);
    if (bid > 1) assert.ok(pWin(m, row, bid - 1) < target, `bid ${bid} is not the SMALLEST that reaches ${target}`);
  }
});

test("a recommendation above the budget is FLAGGED, never silently capped", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  // The fixture RB is a contested week-2 breakout: reaching 70% on him costs more than a season's
  // whole budget, which is a REFUSAL and must not read as "bid your last dollar".
  const row: FaabRow = { budget: 100, f: m.golden[0].f };
  const r = recommendBid(m, row, { target: 0.7, remaining: 40 });
  if (r.wanted != null && r.wanted > 100) {
    assert.equal(r.overBudget, true, "a bid past the budget was not flagged");
    assert.equal(r.overRemaining, true, "a bid past our remaining FAAB was not flagged");
    assert.ok(r.bid <= 40, "the recommended bid exceeds the remaining FAAB it was capped to");
    assert.ok(r.winPctAtBid < r.targetWinPct, "the capped bid still claims to reach the target");
  }
  // Whatever the cap did, the curve is always reported and always ordered.
  assert.ok(r.curve.length >= 2);
  for (let i = 1; i < r.curve.length; i++) assert.ok(r.curve[i].bid > r.curve[i - 1].bid);
});

test("featureRow mirrors the trainer's feature dict, unranked default included", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  const f = featureRow(m, { pos: "RB", week: 4, posLineRank: null, teamsNeedPos: 3, teamsCounted: 12 });
  // The unranked default is read from the ARTIFACT, so a retrain that changes it cannot leave a
  // constant behind in the TypeScript -- the drift that would produce.
  assert.equal(f.log_rank, Math.log(m.rankWhenUnranked));
  assert.equal(f.pos_RB, 1);
  assert.equal(f.pos_WR, 0);
  assert.equal(f.need_share, 0.25);
  assert.equal(f.line_pg, null);            // absent means absent, and the spec supplies the default
  for (const s of m.priceFeatures) assert.ok(s.name in f, `featureRow omits ${s.name}`);
});

test("FAULT INJECTION: a corrupted coefficient is caught by the golden check", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  assert.ok(checkGolden(m).worst < 1e-6);
  const broken = JSON.parse(JSON.stringify(m)) as FaabModel;
  broken.price.coef.week += 0.01;
  const g = checkGolden(broken);
  assert.ok(g.worst > 1e-6, "the golden check did not notice a changed coefficient");
});

test("FAULT INJECTION: a model where money buys nothing refuses to name a bid", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  const dead = JSON.parse(JSON.stringify(m)) as FaabModel;
  dead.win.coef.log_bid = 0;
  const row: FaabRow = { budget: 100, f: m.golden[1].f };
  assert.equal(bidForWinProb(dead, row, 0.7), null, "a zero bid effect still produced a target bid");
  // ...and the copilot falls back to the clearing price rather than to nothing.
  const r = recommendBid(dead, row, { target: 0.7 });
  assert.equal(r.wanted, null);
  assert.ok(r.bid >= 1);
});

test("FAULT INJECTION: the model registry's faab check refuses each thing it exists to refuse", async (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  const { MODELS } = await import("../src/draft/models.js");
  const spec = MODELS.find((s) => s.key === "faab");
  assert.ok(spec?.check, "the faab model is not registered, or registered without a check");
  const raw = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
  assert.equal(spec.check(raw), null, "the real artifact does not pass its own registry check");

  const broke = (mut: (j: Record<string, unknown>) => void): string | null => {
    const j = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    mut(j);
    return spec.check!(j);
  };
  // A target column reaches the published input list.
  assert.match(String(broke((j) => (j.features as string[]).push("ros_pts"))), /ros_pts/);
  // The golden block is dropped, so nothing checks train against serve.
  assert.match(String(broke((j) => { j.golden = []; })), /golden/);
  // The bid's confidence interval stops travelling with the bid.
  assert.match(String(broke((j) => { delete j.bidEffect; })), /bidEffect/);
  // The permuted-target control is made to LOOK like signal -- the check reads the control, not the fit.
  assert.match(String(broke((j) => {
    (j.controls as Record<string, number>).permutedPriceMae = 0.5;
  })), /noise/);
});

test("the clearing price never leaves the budget", (t) => {
  const m = model();
  if (!m) return t.skip("no FAAB artifact");
  for (const g of m.golden) {
    const p = clearingPrice(m, { budget: g.budget, f: g.f });
    assert.ok(p >= m.clamps.lo && p <= g.budget, `${g.pos} priced at ${p} against a ${g.budget} budget`);
  }
});
