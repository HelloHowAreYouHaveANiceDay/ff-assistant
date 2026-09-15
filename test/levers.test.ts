// The lever REGISTRY is the single source of truth: `DEFAULT_LEVERS`, `LEVER_META`, the CLI flags
// and the Settings UI are all derived from `LEVER_SPECS`. These tests defend that property against
// the two failures this repo has already had -- a duplicated lever table that drifted (the
// renderer's `LEVERS_UI` carried 8 of 13 levers and stale defaults), and a lever with no backtest
// flag (`maxKDst`), which made it unmeasurable by the only arbiter that counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEVER_SPECS, LEVER_BY_KEY, LEVER_META, DEFAULT_LEVERS,
  clampLever, applyLevers, isLeverOff, leverOverridesFromArgv, leversToV2Config,
  consensusWeights, anyConsensusBlend,
  type Levers,
} from "../src/draft/levers.ts";
import { blendConsensus, weightForPos } from "../src/draft/consensusBlend.ts";

// The SHIPPED posture, spelled out. This is the config that measures ~33% championships on 25
// scored seasons; if a lever default moves, this test names it rather than letting the change ride
// in silently and show up as an unexplained backtest delta days later.
const SHIPPED: Levers = {
  tierBreak: 0.75, maxKDst: 2, starterReserve: 4, benchReserve: 1, maxShare: 0.25,
  aggr: 0.7, premium: 2, sleeperThreshold: 5,
  benchDiscount: 0.25, // DEMOTED 2026-09-14 (D15): default 0.35 -> 0.25. The 0.35 re-optimisation was +1.4pp on TITLES but NULL on the D13 playoff gate (+0.51pp, PBO 8%) with a NEGATIVE holdout confirm (-0.83pp); 0.25 keeps a real discount. Old posture via --bench-discount 0.35.
  multQB: 1, multRB: 1, multWR: 1, multTE: 1,
  consensusBlend: 0, // DEMOTED 2026-09-13 (D14): default 1 -> 0. Was +2.8pp on TITLES but NULL on the D13 playoff gate and fails family-wide FDR (WS4/WS6). Available via --consensus-blend 1.
  // PER-POSITION consensus blend. QB=0.5 SHIPPED 2026-09-14 (D21): the projector is anti-predictive at
  // QB out of sample, so blending QB toward the FFToday consensus improves QB accuracy (Spearman +0.024,
  // 10/12) and the in-season playoff Brier (0.2294->0.2244, 7/8 seasons), NULL on the draft gate.
  // RB/WR/TE stay 0 (WR has a real OOS edge a blend would destroy); each falls back to `consensusBlend`.
  consensusBlendQB: 0.5, consensusBlendRB: 0, consensusBlendWR: 0, consensusBlendTE: 0,
};

test("regression lock: DEFAULT_LEVERS is the shipped, holdout-validated posture", () => {
  assert.deepEqual(DEFAULT_LEVERS, SHIPPED);
});

test("registry covers every lever exactly once, and LEVER_META is derived from it", () => {
  const specKeys = LEVER_SPECS.map((s) => s.key);
  assert.equal(new Set(specKeys).size, specKeys.length, "duplicate lever key in LEVER_SPECS");
  assert.deepEqual(new Set(Object.keys(DEFAULT_LEVERS)), new Set(specKeys));
  assert.deepEqual(new Set(Object.keys(LEVER_META)), new Set(specKeys));
});

test("every spec is internally coherent: default and off both sit inside the range", () => {
  for (const s of LEVER_SPECS) {
    if (s.kind !== "number") continue;
    assert.ok(s.min != null && s.max != null && s.step != null, `${s.key}: numeric lever needs min/max/step`);
    assert.ok(s.min! <= s.max!, `${s.key}: min > max`);
    assert.ok(Number(s.default) >= s.min! && Number(s.default) <= s.max!, `${s.key}: default outside its own range`);
    // `off` is what --lever-off writes, so where declared it must be a legal value too. Levers with
    // no genuine no-op setting (tierBreak, maxKDst, maxShare, sleeperThreshold) declare none rather
    // than inventing one outside their range -- this test is what caught that when they did.
    if (s.off != null) {
      assert.ok(Number(s.off) >= s.min! && Number(s.off) <= s.max!, `${s.key}: off value outside its own range`);
    }
  }
});

test("CLI flags are unique and non-empty -- two levers sharing a flag would make one unreachable", () => {
  const flags = LEVER_SPECS.map((s) => s.flag);
  for (const f of flags) assert.ok(f && !f.startsWith("-"), `bad flag "${f}" (pass it without dashes)`);
  assert.equal(new Set(flags).size, flags.length, "duplicate CLI flag across levers");
});

test("every lever is overridable from argv -- a lever the backtest cannot set cannot be measured", () => {
  for (const s of LEVER_SPECS) {
    if (s.kind !== "number") continue;
    // Pick a legal value that is NOT the default, so the parse is observable.
    const target = Number(s.default) === s.min! ? s.max! : s.min!;
    const got = leverOverridesFromArgv(["--" + s.flag, String(target)]);
    assert.equal(got[s.key], target, `--${s.flag} did not set ${s.key}`);
  }
});

test("--lever-off sets a lever to its documented identity value", () => {
  const off = leverOverridesFromArgv(["--lever-off", "benchDiscount", "--lever-off", "aggr"]);
  assert.equal(off.benchDiscount, Number(LEVER_BY_KEY.benchDiscount.off));
  assert.equal(off.aggr, Number(LEVER_BY_KEY.aggr.off));
  assert.ok(isLeverOff("benchDiscount", applyLevers(DEFAULT_LEVERS, off)));
});

test("out-of-range CLI values are clamped LOUDLY, never silently", () => {
  const seen: string[] = [];
  const got = leverOverridesFromArgv(["--aggr", "9"], (k, asked, clamped) => seen.push(`${k}:${asked}->${clamped}`));
  assert.equal(got.aggr, LEVER_BY_KEY.aggr.max);
  assert.deepEqual(seen, [`aggr:9->${LEVER_BY_KEY.aggr.max}`], "a clamp must report itself");
});

test("FAULT: an unknown lever key is rejected rather than silently created", () => {
  assert.equal(clampLever("notALever", 1), null);
  assert.deepEqual(applyLevers(DEFAULT_LEVERS, { notALever: 5 }), DEFAULT_LEVERS);
  assert.deepEqual(leverOverridesFromArgv(["--lever-off", "notALever"]), {});
});

test("FAULT: --lever-off refuses a lever that has no no-op value, rather than writing an illegal one", () => {
  for (const key of ["tierBreak", "maxKDst", "maxShare", "sleeperThreshold"] as (keyof Levers)[]) {
    assert.equal(LEVER_BY_KEY[key].off, undefined, `${key} should not claim an off value`);
    assert.deepEqual(leverOverridesFromArgv(["--lever-off", key]), {}, `--lever-off ${key} must be a no-op`);
    assert.equal(isLeverOff(key, DEFAULT_LEVERS), false);
  }
});

test("consensusWeights: per-position lever overrides the scalar, else falls back to it", () => {
  // A fully zeroed set -> identity (this is no longer DEFAULT_LEVERS after D21 shipped QB=0.5).
  const allZero: Levers = { ...DEFAULT_LEVERS, consensusBlend: 0, consensusBlendQB: 0, consensusBlendRB: 0, consensusBlendWR: 0, consensusBlendTE: 0 };
  assert.deepEqual(consensusWeights(allZero), { QB: 0, RB: 0, WR: 0, TE: 0 });
  assert.equal(anyConsensusBlend(allZero), false);
  // SHIPPED default (D21): QB=0.5 toward market, RB/WR/TE on the projector.
  assert.deepEqual(consensusWeights(DEFAULT_LEVERS), { QB: 0.5, RB: 0, WR: 0, TE: 0 });
  assert.equal(anyConsensusBlend(DEFAULT_LEVERS), true);
  // Scalar alone applies uniformly (backward compatible with the old scalar meaning). From `allZero`,
  // not DEFAULT_LEVERS, because the shipped QB=0.5 would otherwise override the scalar at QB.
  assert.deepEqual(consensusWeights({ ...allZero, consensusBlend: 1 }), { QB: 1, RB: 1, WR: 1, TE: 1 });
  // Per-position overrides its own position; others fall back to the scalar.
  assert.deepEqual(
    consensusWeights({ ...allZero, consensusBlend: 0.3, consensusBlendQB: 0.8, consensusBlendWR: 0 }),
    { QB: 0.8, RB: 0.3, WR: 0.3, TE: 0.3 },
  );
  // The experiment's posture: QB toward market, WR left on the projector, scalar 0.
  assert.deepEqual(consensusWeights({ ...DEFAULT_LEVERS, consensusBlendQB: 0.5 }), { QB: 0.5, RB: 0, WR: 0, TE: 0 });
  assert.equal(anyConsensusBlend({ ...DEFAULT_LEVERS, consensusBlendQB: 0.5 }), true);
});

test("the per-position blend flags are overridable from argv", () => {
  const got = leverOverridesFromArgv(["--consensus-blend-qb", "0.5", "--consensus-blend-wr", "0"]);
  assert.equal(got.consensusBlendQB, 0.5);
  assert.equal(got.consensusBlendWR, 0);
});

test("blendConsensus with a per-position map: a zero-weight position is byte-identical", () => {
  // Two QBs (projector orders A>B) and two WRs (projector orders C>D). The consensus REVERSES both.
  const rows = [
    { name: "qbA", pos: "QB", points: 300 }, { name: "qbB", pos: "QB", points: 200 },
    { name: "wrC", pos: "WR", points: 150 }, { name: "wrD", pos: "WR", points: 100 },
  ];
  const pctOf = (_pos: string, name: string) => ({ qbA: 1, qbB: 0, wrC: 1, wrD: 0 }[name] ?? null);
  // QB blended fully toward consensus (reverses points by slot); WR untouched.
  const out = blendConsensus(rows, pctOf, { QB: 1, RB: 0, WR: 0, TE: 0 });
  const by = Object.fromEntries(out.map((r) => [r.name, r.points]));
  assert.equal(by.qbA, 200, "QB blend should demote A to B's slot");
  assert.equal(by.qbB, 300, "QB blend should promote B to A's slot");
  assert.equal(by.wrC, 150, "WR weight 0 must leave WR exactly as projected");
  assert.equal(by.wrD, 100, "WR weight 0 must leave WR exactly as projected");
  // A uniform scalar of 0 is a no-op (returns the same array reference), matching the old contract.
  assert.equal(blendConsensus(rows, pctOf, 0), rows);
  assert.equal(weightForPos({ QB: 0.5 }, "QB"), 0.5);
  assert.equal(weightForPos({ QB: 0.5 }, "WR"), 0, "an omitted position resolves to 0");
});

test("leversToV2Config carries every strategy-facing lever, positional multipliers included", () => {
  const cfg = leversToV2Config({ ...DEFAULT_LEVERS, aggr: 0.6, multWR: 1.2, maxKDst: 3 });
  assert.equal(cfg.aggr, 0.6);
  assert.equal(cfg.maxKDst, 3);
  assert.deepEqual(cfg.posMult, { QB: 1, RB: 1, WR: 1.2, TE: 1 });
  // benchDiscount is the largest measured lever; losing it in this mapping would silently revert
  // a +3.6pp result, so assert it explicitly rather than trusting the spread.
  assert.equal(cfg.benchDiscount, DEFAULT_LEVERS.benchDiscount);
});
