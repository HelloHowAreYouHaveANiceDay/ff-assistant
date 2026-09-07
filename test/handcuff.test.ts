// The handcuff model. Three of these tests exist because the defect they describe SHIPPED into a
// run and rendered as a perfectly plausible table -- which is the whole problem with a ranked list:
// it always looks like an answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handcuffBoard, leadMissProb, HANDCUFF_MODEL } from "../src/inseason/handcuff.js";
import type { VarianceModel } from "../src/draft/season.js";

const VM: VarianceModel = {
  tiers: 4, unfitted: [],
  pos: { RB: { cv: [0.6, 0.9, 1.3, 1.3], avail: [0.8712, 0.7296, 0.4883, 0.2641], skew: [0.5, 0.9, 1.0, 1.0], fitted: true } },
};
const e = (name: string, team: string, projPts: number, depthOrder: number | null = null, rosteredPct: number | null = null) =>
  ({ name, pos: "RB", team, depthOrder, projPts, rosteredPct, poolRank: 0 });

test("a backup scores more with the lead out than with him in", () => {
  const rows = handcuffBoard([e("lead", "AAA", 340, 1), e("back", "AAA", 34, 2)], VM, { poolSize: { RB: 60 } });
  const r = rows.find((x) => x.name === "back")!;
  assert.ok(r, "the backup must appear");
  assert.ok(r.activePerWk > r.basePerWk, `if-out ${r.activePerWk} must exceed baseline ${r.basePerWk}`);
  assert.ok(r.liftPerWk > 0);
  assert.equal(r.lead, "lead");
});

// DEFECT THAT SHIPPED #1: the lead was chosen by depth_order, which is incomplete and sometimes
// simply wrong. KC's actual lead back (Kenneth Walker III, 225 projected) had depth_order NULL, was
// sorted last, and was reported as the BACKUP of an 82-point player.
test("a NULL depth_order does not demote an obvious starter", () => {
  const rows = handcuffBoard([
    e("real starter", "KC", 225, null),       // no depth data at all
    e("nominal d2", "KC", 82, 2),
    e("nominal d3", "KC", 30, 3),
  ], VM, { poolSize: { RB: 60 } });
  assert.ok(!rows.some((r) => r.name === "real starter"),
    "the 225-point back must never be listed as somebody's handcuff");
  assert.ok(rows.every((r) => r.lead === "real starter"),
    `every row must sit behind the real starter, got ${JSON.stringify(rows.map((r) => r.lead))}`);
});

test("when the depth chart and the projection disagree, the row is flagged contested", () => {
  // NE: Stevenson is listed d1 but Henderson projects higher. Real case from the live board.
  const rows = handcuffBoard([e("Henderson", "NE", 176, 2), e("Stevenson", "NE", 146, 1)], VM, { poolSize: { RB: 60 } });
  const s = rows.find((r) => r.name === "Stevenson")!;
  assert.ok(s, "the d1 player must still appear, ranked behind the higher projection");
  assert.equal(s.contested, true, "d1-but-not-lead is a timeshare and must be flagged, not hidden");
  const back = handcuffBoard([e("lead", "AAA", 340, 1), e("back", "AAA", 34, 2)], VM, { poolSize: { RB: 60 } })[0];
  assert.equal(back.contested, false, "an ordinary backup must NOT be flagged -- or the flag says nothing");
});

// DEFECT THAT SHIPPED #2: every backup was scored, including men the fit never saw. Fullbacks
// (Juszczyk 5th on SF, Ingold 4th on LAC) came out above 6.0 pts/wk if-out, purely by extrapolation.
test("only the top two backups are scored -- the range the model was fitted on", () => {
  const rows = handcuffBoard([
    e("lead", "AAA", 340, 1), e("b1", "AAA", 60, 2), e("b2", "AAA", 40, 3),
    e("fullback", "AAA", 8, 5),
  ], VM, { poolSize: { RB: 60 } });
  assert.equal(rows.length, 2, `expected 2 scored backups, got ${rows.map((r) => r.name).join(",")}`);
  assert.ok(!rows.some((r) => r.name === "fullback"), "a 5th-stringer is outside the fit and must be excluded");
});

// DEFECT THAT SHIPPED #3: sorting by lift. The algebra makes it degenerate --
// lift = (0.922-1)*base + 0.402*lead -- so the coefficient on the backup's own value is NEGATIVE and
// the ranking maximises the lead while MINIMISING the backup.
test("ranking prefers the better backup behind the same starter", () => {
  const rows = handcuffBoard([
    e("stud", "DET", 381, 1),
    e("good backup", "DET", 64, 4),     // Pacheco
    e("weak backup", "DET", 11, 3),     // Vaki
  ], VM, { poolSize: { RB: 60 } });
  assert.equal(rows[0].name, "good backup",
    `the more valuable backup must rank first; got ${rows.map((r) => `${r.name} ${r.activePerWk}`).join(" | ")}`);
  // And prove the trap is real rather than hypothetical: by LIFT the order inverts.
  const byLift = rows.slice().sort((a, b) => b.liftPerWk - a.liftPerWk);
  assert.equal(byLift[0].name, "weak backup",
    "sorting by lift must invert here -- if it does not, this test is no longer guarding anything");
});

test("a backup already as good as his lead is dropped, not shown with a negative lift", () => {
  const rows = handcuffBoard([e("a", "AAA", 200, 1), e("b", "AAA", 200, 2)], VM, { poolSize: { RB: 60 } });
  for (const r of rows) assert.ok(r.liftPerWk > 0, `${r.name} should not be listed with lift ${r.liftPerWk}`);
});

test("the miss probability is read off the fitted tier and rises with depth", () => {
  const elite = leadMissProb(VM, "RB", 0.01), deep = leadMissProb(VM, "RB", 0.95);
  assert.ok(elite > 0 && elite < 0.2, `tier-0 miss rate ${elite} should be small but non-zero`);
  assert.ok(deep > elite * 3, `a tier-3 back must miss far more often: ${elite} vs ${deep}`);
  // The bye is already inside `avail` and must be divided back out; forgetting it benches everyone
  // twice. 1 - 0.8712/(16/17) = 0.0742.
  assert.ok(Math.abs(elite - 0.0742) < 0.002, `expected ~0.074 after the bye correction, got ${elite}`);
});

test("an unknown position falls back to a stated default rather than crashing", () => {
  assert.equal(leadMissProb(VM, "WR", 0.5), 0.13);
});

test("the horizon shortens the EV -- a week-10 handcuff has fewer weeks to pay off", () => {
  const full = handcuffBoard([e("lead", "AAA", 340, 1), e("back", "AAA", 34, 2)], VM, { weeks: 17, poolSize: { RB: 60 } })[0];
  const late = handcuffBoard([e("lead", "AAA", 160, 1), e("back", "AAA", 16, 2)], VM, { weeks: 8, poolSize: { RB: 60 } })[0];
  assert.ok(late.expectedPts < full.expectedPts,
    `8 remaining weeks must be worth less than 17: ${late.expectedPts} vs ${full.expectedPts}`);
});

test("the fitted coefficients are the ones the scripts measured", () => {
  assert.equal(HANDCUFF_MODEL.backup, 0.922);
  assert.equal(HANDCUFF_MODEL.lead, 0.402);
});
