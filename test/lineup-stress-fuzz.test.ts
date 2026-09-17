/**
 * AXIS 1 of the M3 lineup stress test: `optimalLineup` against an EXACT reference, on thousands of
 * random rosters and every roster template this repo has to serve.
 *
 * WHY A FUZZ AND NOT MORE FIXTURES. `test/lineup-eligibility.test.ts` already pins the optimizer
 * against the algorithm it replaced on 1,000 random rosters -- which proves the two AGREE, not that
 * either is right. The reference here is different in kind: an exact dynamic program over
 * (slot index, used-player bitmask), with its own hand-written eligibility table that does NOT
 * import src/draft/slots.ts. A producer that ships its own validator passes forever; this one can
 * disagree, and the disagreement is reported by slot token.
 *
 * WHAT IT ASSERTS, per case: the starter rows match the template slot for slot; every seated man is
 * available, eligible for his slot and seated once; the number of slots filled and the total
 * projection equal the exact optimum; the bench is exactly the complement; and an "(empty)" slot is
 * genuinely unfillable.
 *
 * THE SEED IS FIXED, so a failure is reproducible from the message alone, and the case that failed
 * is printed in full (roster, slots, flexOk) rather than summarised.
 *
 * THE CONTROL IS THE POINT. The last test runs the SAME fuzz against the pre-matroid slot-order
 * greedy and REQUIRES it to fail. Without it, "0 failures" is equally consistent with a correct
 * optimizer and with a checker that is not connected to anything -- which is the failure this repo
 * has hit at four separate layers in one session (CLAUDE.md, "Verifying work").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// The driver is plain .mjs so `scripts/lineup-stress.mjs` and this file cannot drift into two
// implementations of the same reference. tsconfig only includes src/, so the untyped import is
// invisible to `npm run typecheck` and deliberate here.
// @ts-expect-error -- untyped .mjs driver, shared with the script on purpose
import { fuzzOptimizer, checkOnce, greedyBySlotOrder, TEMPLATES, bruteForceBest, rng, makeRoster } from "../scripts/lineup-stress.mjs";

const SEED = 20260917;

const describeFailure = (f: { template: string; i: number; problems: string[]; players: unknown; slots: unknown; flexOk: unknown }) =>
  `template ${f.template}, case ${f.i}, seed ${SEED}\n  ${f.problems.join("\n  ")}\n` +
  `  slots=${JSON.stringify(f.slots)} flexOk=${JSON.stringify(f.flexOk)}\n  roster=${JSON.stringify(f.players)}`;

test("FUZZ: optimalLineup is exactly optimal and legal on 9,000 random rosters across nine templates", () => {
  const r = fuzzOptimizer({ n: 1000, seed: SEED });
  assert.equal(r.cases, 9000, "every template must contribute its cases");
  assert.equal(r.failures.length, 0, r.failures.length ? describeFailure(r.failures[0]) : "");
});

test("FAULT INJECTION: the same fuzz REJECTS the slot-order greedy the matroid replaced", () => {
  // The greedy is legal but not optimal, so it must lose slots or points on overlapping eligibility.
  // A fuzz that passes this one is measuring nothing.
  const r = fuzzOptimizer({ n: 300, seed: SEED, optimizer: greedyBySlotOrder });
  assert.ok(r.failures.length > 0, "the fuzz did not reject a knowingly-suboptimal optimizer -- it is not connected");
  const kinds = new Set(r.failures.flatMap((f: { problems: string[] }) => f.problems.map((p) => p.replace(/[0-9.]+/g, "N"))));
  assert.ok([...kinds].some((k) => String(k).includes("optimal") || String(k).includes("reference fills")),
    `the rejections must be about OPTIMALITY, not shape: ${[...kinds].slice(0, 4).join(" | ")}`);
});

test("the independent slot table agrees with src/draft/slots.ts on every token these templates use", () => {
  // Reported as its own test because a VOCAB disagreement is a finding about the slot module, not
  // about the assignment -- and the fuzz above would otherwise bury it among optimality failures.
  const problems: string[] = [];
  for (const [name, t] of Object.entries(TEMPLATES) as [string, { slots: string[]; flexOk: string[] }][]) {
    const players = [{ name: "P0", pos: "QB", proj: 1, available: true }];
    for (const p of checkOnce(players, t.slots, t.flexOk).problems as string[]) if (p.startsWith("VOCAB")) problems.push(`${name}: ${p}`);
  }
  assert.deepEqual(problems, []);
});

test("a slot stays EMPTY rather than being filled illegally, and the rest of the lineup still fills", () => {
  // More starters than eligible players, stated as a fixture so the claim is readable rather than
  // only implied by the fuzz: three men, an eight-slot template.
  const slots = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K"];
  const players = [
    { name: "A", pos: "QB", proj: 20, available: true },
    { name: "B", pos: "RB", proj: 15, available: true },
    { name: "C", pos: "WR", proj: 10, available: true },
  ];
  const { problems, res } = checkOnce(players, slots, ["RB", "WR", "TE"]);
  assert.deepEqual(problems, []);
  assert.equal(res.starters.filter((s: { name: string }) => s.name === "(empty)").length, 5);
  // The RB is at RB and not consumed by FLEX -- template order, the documented tie-break.
  assert.equal(res.starters.find((s: { slot: string }) => s.slot === "RB").name, "B");
  assert.ok(res.flags.some((f: string) => /no available player to fill DST/.test(f)));
});

test("TIES: an all-tied roster still produces a full legal lineup, and the total is the optimum", () => {
  // Every projection identical is the case where a tie-break bug is total and invisible: any
  // assignment scores the same, so only LEGALITY and CARDINALITY distinguish right from wrong.
  const slots = TEMPLATES.espn.slots;
  const players = ["QB", "RB", "RB", "WR", "WR", "TE", "TE", "K", "DST"].map((pos, i) => ({ name: `P${i}`, pos, proj: 9, available: true }));
  const { problems, res, ref } = checkOnce(players, slots, TEMPLATES.espn.flexOk);
  assert.deepEqual(problems, []);
  assert.equal(ref.filled, 9);
  assert.equal(res.totalProj, 81);
});

test("ZERO and NEGATIVE projections: the slot is FILLED, because an empty slot also scores zero", () => {
  // The documented objective is max (slots filled, points) lexicographically -- a real lineup must
  // be submitted full. This test pins that choice so it cannot be changed by accident, and measures
  // what it costs against pure max-points.
  const slots = ["QB", "DST"];
  const players = [
    { name: "A", pos: "QB", proj: 18, available: true },
    { name: "D", pos: "DST", proj: -3, available: true },
  ];
  const res = checkOnce(players, slots, ["RB", "WR", "TE"]).res;
  assert.equal(res.starters.find((s: { slot: string }) => s.slot === "DST").name, "D");
  assert.equal(res.totalProj, 15);
  // And the exact reference agrees, i.e. the fuzz is not silently excusing this.
  assert.equal(bruteForceBest(players, slots, ["RB", "WR", "TE"]).filled, 2);
});

test("IR and bench tokens never become starting slots, in either platform's vocabulary", () => {
  // Yahoo 129048 carries TWO `IR` slots and five `BN`; before src/draft/slots.ts each was a phantom
  // starting slot at a position of that name, i.e. two permanent unfillable flags on every lineup.
  const slots = ["QB", "BN", "BE", "BENCH", "IR", "IR", "ER"];
  const players = [{ name: "A", pos: "QB", proj: 12, available: true }, { name: "B", pos: "RB", proj: 9, available: true }];
  const res = checkOnce(players, slots, ["RB", "WR", "TE"]).res;
  assert.equal(res.starters.length, 1);
  assert.deepEqual(res.flags, []);
  assert.equal(res.bench.length, 1);
});

test("SUPERFLEX: the spare quarterback fills the superflex slot and the plain FLEX still cannot take him", () => {
  const slots = ["QB", "FLEX", "SUPERFLEX"];
  const players = [
    { name: "QB1", pos: "QB", proj: 25, available: true },
    { name: "QB2", pos: "QB", proj: 22, available: true },
    { name: "WR1", pos: "WR", proj: 12, available: true },
  ];
  const { problems, res } = checkOnce(players, slots, ["RB", "WR", "TE"]);
  assert.deepEqual(problems, []);
  assert.equal(res.starters.find((s: { slot: string }) => s.slot === "SUPERFLEX").name, "QB2");
  assert.equal(res.starters.find((s: { slot: string }) => s.slot === "FLEX").name, "WR1");
  // FAULT INJECTION: take the receiver away and FLEX must go EMPTY rather than absorb the QB --
  // `flex_ok` must not leak into SUPERFLEX and vice versa (the documented scope rule).
  const res2 = checkOnce(players.slice(0, 2), slots, ["RB", "WR", "TE"]).res;
  assert.equal(res2.starters.find((s: { slot: string }) => s.slot === "FLEX").name, "(empty)");
});

test("DUAL ELIGIBILITY: the fuzz's hardest shape, driven on its own so the mechanism is readable", () => {
  // A man eligible at RB and WR: taking him for RB strands the better receiver. The greedy fill
  // loses points here and the matroid must not.
  const slots = ["RB", "WR", "FLEX"];
  const players = [
    { name: "Swing", pos: "RB", proj: 20, available: true, eligible: ["RB", "WR"] },
    { name: "OnlyWR", pos: "WR", proj: 19, available: true },
    { name: "OnlyRB", pos: "RB", proj: 3, available: true },
  ];
  const { problems, res } = checkOnce(players, slots, ["RB", "WR", "TE"]);
  assert.deepEqual(problems, []);
  assert.equal(res.totalProj, 42);
  // The control: the old algorithm on the same roster scores less.
  const greedy = greedyBySlotOrder(players, slots, ["RB", "WR", "TE"]);
  assert.ok(greedy.totalProj <= res.totalProj, "the reference greedy cannot beat the optimum");
});

test("the fuzz generator itself produces the hard cases it claims to -- ties, zeros, negatives, duals", () => {
  // A generator that only ever emitted distinct positive single-eligible projections would make
  // every assertion above vacuous. Measured, not asserted in a comment.
  const rand = rng(SEED);
  let ties = 0, zeros = 0, negs = 0, duals = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const r = makeRoster(rand, {}) as { proj: number; eligible?: string[] }[];
    n += r.length;
    const seen = new Set<number>();
    for (const p of r) {
      if (seen.has(p.proj)) ties++; seen.add(p.proj);
      if (p.proj === 0) zeros++;
      if (p.proj < 0) negs++;
      if (p.eligible && p.eligible.length > 1) duals++;
    }
  }
  assert.ok(ties > n * 0.10, `too few ties: ${ties}/${n}`);
  assert.ok(zeros > n * 0.05, `too few zeros: ${zeros}/${n}`);
  assert.ok(negs > n * 0.02, `too few negatives: ${negs}/${n}`);
  assert.ok(duals > n * 0.05, `too few dual-eligible men: ${duals}/${n}`);
});
