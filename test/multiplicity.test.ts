import { test } from "node:test";
import assert from "node:assert/strict";
// WS4 family-wide multiplicity. The BH primitives live beside the arbiter core they report on.
import { familyAdjust, bhSurvivors, rowOneSidedP, groupLedgerFamilies, dedupByConfig } from "../scripts/lib/arbiter.mjs";

// A "true signal" is a tiny p-value; a "null" is a large one. BH q for the true signal at rank 1 is
// p_true * N / 1, so it MUST rise as the family of nulls grows -- that monotone weakening is the whole
// point of family-wide accounting (a config that cleared out of many looks less special).
const TRUE_P = 0.001;
const NULL_P = 0.6; // a pure null: no evidence of a positive effect

function familyOf(nNulls: number, withSignal: boolean) {
  const nulls = Array.from({ length: nNulls }, () => NULL_P);
  return withSignal ? [TRUE_P, ...nulls] : nulls;
}

test("FAULT (a): the true signal's adjusted significance WEAKENS monotonically as N nulls grow", () => {
  let prevQ = -Infinity;
  for (const nNulls of [1, 5, 20, 100, 500]) {
    const { q } = familyAdjust(familyOf(nNulls, true));
    const qTrue = q[0]; // the true signal is index 0
    assert.ok(qTrue >= prevQ, `q of true signal must not fall as family grows: ${qTrue} < ${prevQ} at N=${nNulls}`);
    assert.ok(qTrue > prevQ || nNulls === 1, `q should strictly rise while below the clamp (N=${nNulls}): ${qTrue}`);
    prevQ = qTrue;
  }
  // sanity: at N=1 null the signal's q is p*2/1; at N=500 it is p*501/1 -- an ~250x weaker claim.
  const small = familyAdjust(familyOf(1, true)).q[0];
  const big = familyAdjust(familyOf(500, true)).q[0];
  assert.ok(big > small * 100, `expected big family to weaken the signal >100x (small ${small}, big ${big})`);
});

test("FAULT (b): a PURE-NULL family yields NO survivor at FDR 0.10", () => {
  for (const n of [3, 10, 50]) {
    const surv = bhSurvivors(familyOf(n, false), 0.10);
    assert.equal(surv.length, 0, `pure-null family of ${n} must have no survivor, got ${surv.length}`);
    // and every adjusted q is far above threshold
    const { q } = familyAdjust(familyOf(n, false));
    assert.ok(Math.min(...q) > 0.10, `min q ${Math.min(...q)} must exceed 0.10`);
  }
});

test("(c): a family with a STRONG signal KEEPS it (survives BH at 0.10)", () => {
  // even against 20 nulls, p=0.001 -> q = 0.001*21 = 0.021 < 0.10.
  const surv = bhSurvivors(familyOf(20, true), 0.10);
  assert.deepEqual(surv, [0], `the strong signal (index 0) must be the sole survivor, got ${JSON.stringify(surv)}`);
  const { q } = familyAdjust(familyOf(20, true));
  assert.ok(q[0] <= 0.10, `strong-signal q ${q[0]} must clear 0.10`);
});

test("familyAdjust is monotone in p (larger raw p never gets a smaller q) and clamps to 1", () => {
  const ps = [0.001, 0.02, 0.2, 0.5, 0.9];
  const { q } = familyAdjust(ps);
  for (let i = 1; i < q.length; i++) assert.ok(q[i] >= q[i - 1], `q not monotone at ${i}: ${q[i]} < ${q[i - 1]}`);
  assert.ok(q.every((v) => v <= 1), "every q clamped to <= 1");
  assert.deepEqual(familyAdjust([]).q, [], "empty family -> empty q");
});

test("rowOneSidedP: p_gt0 rows and playoff_t rows both map to a one-sided p (and agree on direction)", () => {
  // old-style championship row: p_gt0 = 0.985 -> one-sided p = 0.015.
  const oldRow = { p_gt0: 0.985 };
  const a = rowOneSidedP(oldRow);
  assert.equal(a.source, "champ:p_gt0");
  assert.ok(Math.abs(a.p - 0.015) < 1e-9, `p ${a.p}`);
  // new-style playoffs row: a strongly positive t -> small p; a negative t -> p near 1.
  const posT = rowOneSidedP({ primary: "playoffs", playoff_t: 3.233 });
  const negT = rowOneSidedP({ primary: "playoffs", playoff_t: -6.344 });
  assert.equal(posT.source, "playoffs:t");
  assert.ok(posT.p < 0.01, `positive t should give small p, got ${posT.p}`);
  assert.ok(negT.p > 0.99, `negative t should give p near 1, got ${negT.p}`);
  // a row with no significance at all -> null p (cannot fabricate one).
  assert.equal(rowOneSidedP({ treatment_label: "x" }).p, null);
});

test("dedup + grouping: a config re-measured N times counts ONCE; families split by baseline", () => {
  const rows = [
    { baseline_label: "shipped", treatment_label: "A", config_hash: "h1", timestamp: "2026-01-01", p_gt0: 0.5 },
    { baseline_label: "shipped", treatment_label: "A", config_hash: "h1", timestamp: "2026-02-01", p_gt0: 0.9 }, // newer dup of A
    { baseline_label: "shipped", treatment_label: "B", config_hash: "h2", timestamp: "2026-01-01", p_gt0: 0.8 },
    { baseline_label: "other", treatment_label: "C", config_hash: "h3", timestamp: "2026-01-01", p_gt0: 0.7 },
  ];
  const deduped = dedupByConfig(rows);
  assert.equal(deduped.length, 3, "h1 collapses to one row");
  const keptA = deduped.find((r) => r.config_hash === "h1");
  assert.equal(keptA?.p_gt0, 0.9, "dedup keeps the LATEST measurement");
  const fam = groupLedgerFamilies(rows);
  assert.equal(fam.size, 2, "two baselines -> two families");
  assert.equal(fam.get("shipped")?.length, 2, "shipped family has 2 distinct configs (A,B)");
  assert.equal(fam.get("other")?.length, 1, "other family has 1 config");
});
