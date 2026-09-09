// TRACK I, STEP 3: the consumers.
//
// The change under test is a SUBSTITUTION -- the lead's miss rate, and the depth-risk horizon, stop
// being a per-tier constant for a player who is on the injury report and become a reading of his
// actual injury. Two ways that goes wrong without failing:
//
//   NOT CONNECTED  the outlook is loaded, the row is looked up, and the number that comes out is the
//                  tier rate anyway. A flat column and a working lever look identical, so every test
//                  here compares the SAME board built with and without the outlook.
//   CONNECTED THE WRONG WAY  a season-ending designation must produce a horizon that covers the
//                  playoffs; a Questionable hamstring must not. That is the fault injection the task
//                  names, and it is the only one that distinguishes "the model is wired in" from
//                  "the model is wired in backwards".
//
// The outlook is INJECTED rather than read from the store, so these assert the wiring rather than
// whatever this week's ESPN feed happens to say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { handcuffBoard, type DepthEntry } from "../src/inseason/handcuff.js";
import {
  horizonFor, loadInjuryHorizonArtifact, outlookFrom, emptyOutlookSet,
  type InjuryHorizonArtifact, type InjuryOutlookSet, type LiveEpisode,
} from "../src/inseason/injuryHorizon.js";
import type { VarianceModel } from "../src/draft/season.js";

const PATH = "data/injury-duration-artifact.json";
const skip = existsSync(PATH) ? false : `${PATH} not fitted -- run tools/train_injury_duration.py`;
const art = (): InjuryHorizonArtifact => loadInjuryHorizonArtifact(JSON.parse(readFileSync(PATH, "utf8")));

/** A four-tier variance model whose top tier is durable, so the tier rate is small and any movement
 *  in the board's numbers has to come from the injury model rather than from a noisy baseline. */
const VM: VarianceModel = {
  tiers: 4, unfitted: [],
  pos: { RB: { cv: [0.3, 0.3, 0.3, 0.3], avail: [0.90, 0.80, 0.60, 0.40], skew: [0, 0, 0, 0], fitted: true } },
};

const DEPTH: DepthEntry[] = [
  { name: "Lead Back", pos: "RB", team: "KC", depthOrder: 1, projPts: 255, poolRank: 1 },
  { name: "Backup Back", pos: "RB", team: "KC", depthOrder: 2, projPts: 85, poolRank: 40 },
];
const POOL = { RB: 100 };

/** Build an outlook set holding exactly one man, from one hand-written point-in-time row. */
function outlookOf(a: InjuryHorizonArtifact, nk: string, row: Partial<LiveEpisode>): InjuryOutlookSet {
  const e = {
    playerSk: null, name: nk, season: 2026, week: 5, source: "live" as const,
    designation: "", practice_status: "", injury_group: "", pos: "RB",
    weeks_missed_so_far: 0, weeks_in_episode: 0, prior_episodes_same: 0, prior_episodes_any: 0,
    age: 27, injury_secondary_present: 0, ...row,
  } as LiveEpisode;
  const set = emptyOutlookSet(() => 0.129, "fixture");
  set.byName.set(nk, outlookFrom(a, e, nk));
  return { ...set, artifactPresent: true, source: "live" };
}

test("handcuffs: an INJURED lead moves the board; the same board with no outlook does not", { skip }, () => {
  const a = art();
  const plain = handcuffBoard(DEPTH, VM, { weeks: 10, positions: ["RB"], poolSize: POOL });
  const hurt = handcuffBoard(DEPTH, VM, {
    weeks: 10, positions: ["RB"], poolSize: POOL,
    outlook: outlookOf(a, "leadback", { designation: "Out", practice_status: "DNP", injury_group: "knee", weeks_missed_so_far: 2, weeks_in_episode: 3 }),
  });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].missSource, "tier");
  assert.equal(plain[0].leadGamesOutNext4, null);
  assert.equal(hurt[0].missSource, "injury-model");
  // CONNECTED: the EV must move, and upward, because the lead is Out and has already missed two.
  assert.ok(hurt[0].expectedPts > plain[0].expectedPts * 1.5,
    `expectedPts ${hurt[0].expectedPts} vs ${plain[0].expectedPts} -- the injury model changed nothing`);
  assert.ok((hurt[0].leadGamesOutNext4 ?? 0) > (hurt[0].leadGamesOutNext4Tier ?? 99));
  assert.equal(hurt[0].leadDesignation, "Out");
  // and the lift itself, which is a property of the two players, must be UNTOUCHED: the injury
  // model prices the EVENT, not the payoff, and a change there would be double counting.
  assert.equal(hurt[0].liftPerWk, plain[0].liftPerWk);
  assert.equal(hurt[0].activePerWk, plain[0].activePerWk);
});

test("handcuffs: a HEALTHY-ish lead on the report barely moves the board", { skip }, () => {
  // The negative half. A man listed Probable with a full practice is on the report and is going to
  // play, and pricing him like an injury would be worse than the tier rate, not better.
  const a = art();
  const plain = handcuffBoard(DEPTH, VM, { weeks: 10, positions: ["RB"], poolSize: POOL });
  const soft = handcuffBoard(DEPTH, VM, {
    weeks: 10, positions: ["RB"], poolSize: POOL,
    outlook: outlookOf(a, "leadback", { designation: "Probable", practice_status: "Full", injury_group: "hand" }),
  });
  assert.equal(soft[0].missSource, "injury-model");
  assert.ok((soft[0].leadGamesOutNext4 ?? 9) < 0.6, `Probable + full practice expects ${soft[0].leadGamesOutNext4} of the next four missed`);
  assert.ok(soft[0].expectedPts < plain[0].expectedPts * 1.6);
});

test("FAULT INJECTION: a season-ending designation covers the playoffs; a Questionable hamstring does not", { skip }, () => {
  const a = art();
  // The strongest signal the archive vocabulary can carry for "he is done": Out, did not practise,
  // and four games already missed inside the episode.
  const done = horizonFor(a, {
    designation: "Out", practice_status: "DNP", injury_group: "knee", pos: "RB",
    weeks_missed_so_far: 5, weeks_in_episode: 6, prior_episodes_same: 1, prior_episodes_any: 2, age: 29,
  });
  const soft = horizonFor(a, {
    designation: "Questionable", practice_status: "Limited", injury_group: "hamstring", pos: "RB",
    weeks_missed_so_far: 0, weeks_in_episode: 0, prior_episodes_same: 0, prior_episodes_any: 0, age: 25,
  });
  // "Covers the playoffs" at a four-game horizon means the fourth game is still more likely missed
  // than not -- this model has no opinion past four games and must not be asked for one.
  assert.ok(done.p[4] > 0.5, `season-ending profile gives P(miss next 4) = ${done.p[4].toFixed(3)}, which does not cover a playoff run`);
  assert.ok(done.expectedGamesOut4 > 3.0, `expected games out ${done.expectedGamesOut4.toFixed(2)}`);
  assert.ok(soft.p[4] < 0.10, `Questionable hamstring gives P(miss next 4) = ${soft.p[4].toFixed(3)}, which is a season-ender`);
  // He is NOT expected to play through it either -- Questionable plus a limited practice is a
  // coin-flip for this week (0.554) and the shipped artifact puts the four-game expectation at 1.05
  // games. The claim being asserted is that it is a WEEK-SCALE absence rather than a season-scale
  // one, so the bound is a third of the season-ender rather than "under one game", which would be a
  // number picked to be true of today's fit.
  assert.ok(soft.expectedGamesOut4 < done.expectedGamesOut4 / 2.5,
    `expected games out ${soft.expectedGamesOut4.toFixed(2)} against the season-ender's ${done.expectedGamesOut4.toFixed(2)}`);
  assert.ok(soft.expectedGamesOut4 < 1.5, `expected games out ${soft.expectedGamesOut4.toFixed(2)}`);
  // and the DESIGNATION-ONLY baseline cannot tell these two apart nearly as well, which is the
  // whole reason the extra columns are on the row.
  const spreadModel = done.expectedGamesOut4 - soft.expectedGamesOut4;
  const spreadBase = (done.baseline ? done.baseline[1] + done.baseline[2] + done.baseline[3] + done.baseline[4] : 0)
    - (soft.baseline ? soft.baseline[1] + soft.baseline[2] + soft.baseline[3] + soft.baseline[4] : 0);
  assert.ok(spreadModel > spreadBase, `model spread ${spreadModel.toFixed(2)} is not wider than the designation-only ${spreadBase.toFixed(2)}`);
});

test("a missing artifact DEGRADES to the tier rate and SAYS SO -- it does not throw and does not fake a number", { skip: false }, () => {
  // The failure mode this repo has a scar from: `opportunity-model.json` absent meant every factor
  // returned 1 and the board looked completely normal. An empty outlook must be visible.
  const empty = emptyOutlookSet(() => 0.129, "no artifact on file");
  const rows = handcuffBoard(DEPTH, VM, { weeks: 10, positions: ["RB"], poolSize: POOL, outlook: empty });
  assert.equal(rows[0].missSource, "tier");
  assert.equal(rows[0].leadGamesOutNext4, null);
  assert.ok(empty.note.length > 10, "an empty outlook must carry the reason it is empty");
  assert.equal(empty.artifactPresent, false);
  // identical to the no-outlook board, i.e. the pre-Track-I behaviour is exactly preserved
  const plain = handcuffBoard(DEPTH, VM, { weeks: 10, positions: ["RB"], poolSize: POOL });
  assert.equal(rows[0].expectedPts, plain[0].expectedPts);
  assert.equal(rows[0].missProb, plain[0].missProb);
});

test("beyond four games the TIER rate resumes -- the model is not extrapolated", { skip }, () => {
  const a = art();
  const ol = outlookOf(a, "leadback", { designation: "Out", practice_status: "DNP", injury_group: "knee", weeks_missed_so_far: 5, weeks_in_episode: 6 });
  const four = handcuffBoard(DEPTH, VM, { weeks: 4, positions: ["RB"], poolSize: POOL, outlook: ol });
  const twelve = handcuffBoard(DEPTH, VM, { weeks: 12, positions: ["RB"], poolSize: POOL, outlook: ol });
  // Over four weeks the whole horizon is the model. Over twelve, eight of them are the tier rate,
  // so the BLENDED per-week rate must fall back toward it rather than staying at the injury level.
  assert.ok(four[0].missProb > twelve[0].missProb + 0.1,
    `blended rate ${four[0].missProb} over 4 weeks vs ${twelve[0].missProb} over 12 -- the model is being extrapolated past its fit`);
  assert.ok(twelve[0].missProb > 0.129, "the blend fell below the tier rate itself");
});
