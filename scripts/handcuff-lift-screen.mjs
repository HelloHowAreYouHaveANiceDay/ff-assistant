// DOES A POSITION-AWARE LIFT BEAT THE SHIPPED ONE? -- leave-season-out, same pairs as the gate.
//
// `handcuff-gate.mjs` established that `HANDCUFF_MODEL` (activePerWk = 0.922*base + 0.402*lead) is
// an RB-shaped model served at four positions, and that it carries no depth term whose direction it
// does not then invert:
//
//     QB 0.96x   RB 1.55x   WR 4.43x   TE 2.68x      (model lift / realised lift, depth-2)
//
// This screens replacements. The rule is the repo's, not mine: a candidate must beat the incumbent
// OUT OF SAMPLE, by a margin bigger than the noise, or it is rejected. Every fit here is
// leave-season-out -- the coefficients that score season Y never saw season Y.
//
// THE CANDIDATES, chosen because they imply different strategies rather than to pad a table:
//   shipped      0.922*base + 0.402*lead                  -- one equation, all positions
//   perPos       a_p*base + b_p*lead                      -- the same shape, fitted per position
//   perPosDepth  a_pd*base + b_pd*lead                    -- and per depth, which the docstring's
//                                                            +4.42/+2.37 split says should matter
//   flatPerPos   base + c_p                               -- additive, the form the original horse
//                                                            race rejected; kept as a control, since
//                                                            a candidate that cannot beat IT is not
//                                                            worth shipping either
//
// Usage: node --import tsx scripts/handcuff-lift-screen.mjs [--from 2005] [--to 2025]
import { HANDCUFF_MODEL } from "../src/inseason/handcuff.js";
import { loadHistory, byeIndex, buildPairs, POS } from "./lib/handcuff-pairs.mjs";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", 2005)), TO = Number(arg("--to", 2025));
const LEAD_MAX_RANK = Number(arg("--lead-max-rank", 36));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** OLS for y = a*x1 + b*x2, no intercept -- the shipped form, so a fitted arm is comparable. */
function fit2(rows) {
  let s11 = 0, s12 = 0, s22 = 0, sy1 = 0, sy2 = 0;
  for (const r of rows) {
    s11 += r.x1 * r.x1; s12 += r.x1 * r.x2; s22 += r.x2 * r.x2;
    sy1 += r.y * r.x1; sy2 += r.y * r.x2;
  }
  const det = s11 * s22 - s12 * s12;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  return { a: (sy1 * s22 - sy2 * s12) / det, b: (sy2 * s11 - sy1 * s12) / det };
}

const H = loadHistory();
const BYE = byeIndex(H);
const all = buildPairs(H, BYE, { from: FROM, to: TO, leadMaxRank: LEAD_MAX_RANK })
  // Only pairs where the lead ACTUALLY missed time carry an observed active level to fit or score.
  .filter((p) => p.leadMissedGames > 0 && p.observedActive != null);

const seasons = [...new Set(all.map((p) => p.season))].sort((a, b) => a - b);
const key = (p, withDepth) => (withDepth ? `${p.pos}|${p.depthOrder}` : p.pos);

// levelPerPos is a CONTROL, and the one the charter's rule 4 demands: before believing a gain,
// check a broader lever does not already explain it. It predicts a per-position CONSTANT LEVEL and
// ignores `base` and `lead` entirely. If it matches flatPerPos, then the backup's own projection
// carries no usable signal here and the "win" is just a positional average wearing a costume.
const ARMS = ["shipped", "perPos", "perPosDepth", "flatPerPos", "levelPerPos"];
const err = Object.fromEntries(ARMS.map((a) => [a, []]));

for (const Y of seasons) {
  const train = all.filter((p) => p.season !== Y);
  const test = all.filter((p) => p.season === Y);
  if (!train.length || !test.length) continue;

  // Fit each arm on TRAIN only.
  const coefPos = new Map(), coefPosDepth = new Map(), flatPos = new Map(), levelPos = new Map();
  for (const withDepth of [false, true]) {
    const groups = new Map();
    for (const p of train) {
      const k = key(p, withDepth);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ x1: p.basePerWk, x2: p.leadPerWk, y: p.observedActive });
    }
    for (const [k, rows] of groups) {
      // A cell too thin to fit is left out; the scorer falls back to shipped and says so by counting.
      if (rows.length < 30) continue;
      const c = fit2(rows);
      if (c) (withDepth ? coefPosDepth : coefPos).set(k, c);
    }
  }
  for (const pos of POS) {
    const rows = train.filter((p) => p.pos === pos);
    if (rows.length >= 30) flatPos.set(pos, mean(rows.map((p) => p.observedActive - p.basePerWk)));
    if (rows.length >= 30) levelPos.set(pos, mean(rows.map((p) => p.observedActive)));
  }

  for (const p of test) {
    // TWO BASELINES, AND THEY ANSWER DIFFERENT QUESTIONS. Reported side by side because picking one
    // silently is how handcuff-gate.mjs and this screen came to disagree about QB -- the gate had
    // shipped at 0.96x and this had it biased -3.51, on the same players.
    //
    //   vs PROJECTION (basePerWk)  what the board can actually do: it holds a projection, not a
    //                              within-season average. This is the OPERATIONAL error and it
    //                              correctly includes projection error -- a backup QB projected near
    //                              zero who then starts six games is a huge miss here, and honestly so.
    //   vs OBSERVED BASE           what the lead's absence CAUSED, holding the man fixed -- the
    //                              within-player contrast HANDCUFF_MODEL was actually fitted on.
    //
    // Arms are ranked on the operational one; the causal one is printed so the two experiments
    // reconcile instead of quietly contradicting each other.
    const realisedLift = p.observedActive - p.basePerWk;
    const causalLift = p.observedActive - p.observedBase;
    const pred = {
      shipped: HANDCUFF_MODEL.backup * p.basePerWk + HANDCUFF_MODEL.lead * p.leadPerWk - p.basePerWk,
      perPos: (() => { const c = coefPos.get(key(p, false)); return c ? c.a * p.basePerWk + c.b * p.leadPerWk - p.basePerWk : null; })(),
      perPosDepth: (() => { const c = coefPosDepth.get(key(p, true)); return c ? c.a * p.basePerWk + c.b * p.leadPerWk - p.basePerWk : null; })(),
      flatPerPos: flatPos.has(p.pos) ? flatPos.get(p.pos) : null,
      // Expressed as a lift so every arm scores through the same code path; the LEVEL it implies is
      // base + (level - base) = level, i.e. the backup's own projection cancels out exactly.
      levelPerPos: levelPos.has(p.pos) ? levelPos.get(p.pos) - p.basePerWk : null,
    };
    for (const armName of ARMS) {
      const v = pred[armName];
      if (v == null) continue;
      // THE LEVEL, carried so the identity below can be CHECKED rather than asserted: a handcuff is
      // a BENCH player, so what he is worth is what he SCORES in the weeks you start him -- not his
      // gain over a base you never collect, because you never start him while the lead plays.
      const predictedActive = p.basePerWk + v;
      err[armName].push({
        season: p.season, pos: p.pos, depth: p.depthOrder,
        e: v - realisedLift, abs: Math.abs(v - realisedLift),
        eCausal: v - causalLift,
        eLevel: predictedActive - p.observedActive,
      });
    }
  }
}

console.log(`\nHANDCUFF LIFT SCREEN -- ${FROM}-${TO}, leave-season-out, n=${err.shipped.length} pairs with an observed absence\n`);
console.log("  arm            n      bias      MAE     vs shipped");
const baseMae = mean(err.shipped.map((x) => x.abs));
for (const armName of ARMS) {
  const e = err[armName];
  if (!e.length) { console.log(`  ${armName.padEnd(12)} (no cell met the 30-row floor)`); continue; }
  const mae = mean(e.map((x) => x.abs));
  const delta = baseMae - mae;
  console.log(`  ${armName.padEnd(12)} ${String(e.length).padStart(5)} ${mean(e.map((x) => x.e)).toFixed(3).padStart(9)} ${mae.toFixed(3).padStart(8)}  ${armName === "shipped" ? "--" : (delta >= 0 ? "+" : "") + delta.toFixed(3) + (delta > 0 ? "  better" : "  WORSE")}`);
}

/**
 * THE BASELINES, SETTLED -- and by an identity, not a preference.
 *
 * A handcuff is a BENCH player. You do not start him while the lead plays, so his base level is
 * points you never collect; what he is worth is what he SCORES in the weeks you actually start him.
 * The decision-relevant quantity is therefore the LEVEL, `activePerWk`, not a gain over anything.
 *
 * And the operational baseline already IS that, exactly:
 *
 *     e_operational = v - (observedActive - basePerWk)
 *                   = (basePerWk + v) - observedActive
 *                   = predictedActive - observedActive
 *
 * So there was never a choice to make between the two: "lift vs projection" and "predict the level"
 * are the same number written differently, and the level is the one the decision needs. Verified
 * below rather than asserted, because an identity I have only argued for is a claim.
 *
 * The CAUSAL baseline stays, clearly labelled, for the one job it is right for: measuring what an
 * absence DOES to a player, holding the man fixed. That is what HANDCUFF_MODEL was fitted on and it
 * is the correct frame for diagnosing the model -- but it is not the frame for valuing a roster spot.
 */
{
  const maxGap = Math.max(...ARMS.flatMap((a) => err[a].map((x) => Math.abs(x.e - x.eLevel))));
  console.log(`\n  BASELINE IDENTITY CHECK: max |e_operational - e_level| = ${maxGap.toExponential(2)}` +
    `${maxGap < 1e-9 ? "  -- identical, so 'lift vs projection' IS 'predict the level'" : "  *** NOT IDENTICAL -- the settlement below does not hold ***"}`);
}

console.log("\n  THE SAME ARMS against the CAUSAL baseline (what the absence DID, holding the man fixed)");
console.log("  arm            bias      MAE     <- diagnosis only, NOT the decision frame");
for (const armName of ARMS) {
  const e = err[armName];
  if (!e.length) continue;
  console.log(`  ${armName.padEnd(12)} ${mean(e.map((x) => x.eCausal)).toFixed(3).padStart(8)} ${mean(e.map((x) => Math.abs(x.eCausal))).toFixed(3).padStart(8)}`);
}

console.log("\n  BIAS BY POSITION (predicted lift minus realised vs PROJECTION; + = the arm claims too much)");
console.log("    pos     shipped     perPos   perPosDepth   flatPerPos");
for (const pos of POS) {
  const cell = (armName) => {
    const e = err[armName].filter((x) => x.pos === pos);
    return e.length ? mean(e.map((x) => x.e)).toFixed(2).padStart(10) : "        --";
  };
  console.log(`    ${pos.padEnd(5)} ${cell("shipped")} ${cell("perPos")} ${cell("perPosDepth")} ${cell("flatPerPos")}`);
}

/**
 * THE ADMISSION TEST -- paired by SEASON, against this repo's 2.9*SE floor.
 *
 * THE UNIT OF ANALYSIS IS THE SEASON, NOT THE PAIR. n=1772 pairs is not 1772 independent
 * observations: they come from 21 seasons, and pairs within a season share a schedule, an injury
 * environment and a scoring era. Pooling them would shrink the standard error by roughly sqrt(84)
 * and admit almost anything -- which is exactly the error `docs/validation.md` records as the reason
 * every screen in this repo is paired by season.
 *
 * The arms see the SAME seasons and the SAME pairs, so the per-season differences are matched pairs
 * and the SE is on the difference, not on either arm's level.
 */
{
  const seasonsSeen = [...new Set(err.shipped.map((x) => x.season))].sort((a, b) => a - b);
  const maeFor = (armName, season) => {
    const e = err[armName].filter((x) => x.season === season);
    return e.length ? mean(e.map((x) => x.abs)) : null;
  };
  const paired = (ref, label) => {
  console.log(`\n  ADMISSION TEST vs ${label} -- paired by season, floor = 2.9 x SE of the per-season difference`);
  console.log("    arm           seasons   mean improvement      SE     floor   verdict");
  for (const armName of ARMS.filter((a) => a !== ref)) {
    const d = [];
    for (const season of seasonsSeen) {
      const a = maeFor(ref, season), b = maeFor(armName, season);
      if (a == null || b == null) continue;
      d.push(a - b);                                    // positive = the candidate is better
    }
    if (d.length < 3) { console.log(`    ${armName.padEnd(13)} too few seasons to judge`); continue; }
    const m = mean(d);
    const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1));
    const se = sd / Math.sqrt(d.length);
    const floor = 2.9 * se;
    const wins = d.filter((x) => x > 0).length;
    console.log(`    ${armName.padEnd(13)} ${String(d.length).padStart(5)}   ${m.toFixed(4).padStart(16)} ${se.toFixed(4).padStart(9)} ${floor.toFixed(4).padStart(9)}   ` +
      `${m > floor ? "ADMIT" : "REJECT"}  (${wins}/${d.length} seasons)`);
  }
  };
  // Against the INCUMBENT -- the only test that can admit anything.
  paired("shipped", "SHIPPED (the incumbent)");
  // Against the leading candidate -- which is what decides WHICH one, and whether `levelPerPos`
  // (a bare positional constant) already explains the win.
  paired("flatPerPos", "flatPerPos (head-to-head; + means the row beats it)");
}

// THE CONSTANTS, fitted on ALL seasons -- IN-SAMPLE, and printed only so a proposal has numbers in
// it. Every verdict above came from the leave-season-out fits, never from these.
{
  console.log("\n  flatPerPos CONSTANTS (all seasons, IN-SAMPLE -- for a proposal, not for a verdict)");
  console.log("    pos      n   activePerWk = base + c");
  for (const pos of POS) {
    const rows = all.filter((p) => p.pos === pos);
    if (!rows.length) continue;
    const c = mean(rows.map((p) => p.observedActive - p.basePerWk));
    console.log(`    ${pos.padEnd(4)} ${String(rows.length).padStart(5)}   c = ${(c >= 0 ? "+" : "") + c.toFixed(2)}`);
  }
}
