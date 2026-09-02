// Fault-injection tests for the per-manager bot model + nomination policy. The guard that matters:
// feed the model a KNOWN behavior and confirm it comes out (a QB-payer must bid QB up; a punter must
// not), and confirm the budget gate actually collapses a bid once the positional target is spent --
// a bidder that can only ever say "no" (or "yes") is dead code that reads like a working one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBotBidder, posPremium, loadManagers, type ManagerProfile } from "../src/draft/managers.ts";
import { planDrainNomination, payersFrom, type NomPlayer } from "../src/draft/nomination.ts";

const league = { QB: 0.09, RB: 0.40, WR: 0.41, TE: 0.08, K: 0.01, DST: 0.005 };
const qbPayer: ManagerProfile = { owner: "Payer", abbrev: "PAY", seasons: [2024], share: { QB: 0.25, RB: 0.30, WR: 0.35, TE: 0.08, K: 0.01, DST: 0 }, conc: 0.82, maxBuy: 70, cheap: 8 };
const qbPunter: ManagerProfile = { owner: "Punter", abbrev: "PUN", seasons: [2024], share: { QB: 0.01, RB: 0.40, WR: 0.50, TE: 0.07, K: 0.01, DST: 0 }, conc: 0.78, maxBuy: 75, cheap: 9 };

const rng = () => 0.5; // fixed -> deterministic, isolates the profile effect from noise

test("FAULT: a QB-payer bids a top QB strictly higher than a QB-punter does", () => {
  const payer = makeBotBidder(qbPayer, league);
  const punter = makeBotBidder(qbPunter, league);
  const emptySpend = {};
  const pay = payer(40, "QB", 10, emptySpend, rng);
  const pun = punter(40, "QB", 10, emptySpend, rng);
  assert.ok(pay > pun, `QB-payer (${pay}) must outbid QB-punter (${pun}) on the same QB`);
  assert.ok(pun < 40, `punter should bid a $40-value QB below value, got ${pun}`);
});

test("FAULT: the positional budget gate collapses a bid once the target is spent", () => {
  const bid = makeBotBidder(qbPayer, league); // QB target = 0.25*200 = $50
  const fresh = bid(40, "QB", 10, {}, rng);
  const afterSpend = bid(40, "QB", 10, { QB: 60 }, rng); // already over the $50 QB target
  assert.ok(fresh > afterSpend * 2, `bid must collapse after target spent: fresh ${fresh} vs spent ${afterSpend}`);
  assert.ok(afterSpend >= 1, "still returns a legal >=1 bargain bid");
});

test("posPremium reflects the profile: overweight QB -> higher premium than punter; K always cheap", () => {
  assert.ok(posPremium(qbPayer, league, "QB") > posPremium(qbPunter, league, "QB"), "QB-payer premium > punter");
  assert.ok(posPremium(qbPunter, league, "QB") <= 0.9, "QB-punter bids QB at/below value");
  assert.ok(posPremium(qbPayer, league, "K") <= 0.7, "nobody pays up for K");
});

test("real profiles load and cover the 2025 league (16 owners)", () => {
  const { profiles, leagueShare } = loadManagers();
  assert.ok(profiles.length >= 14, `expected the returning field, got ${profiles.length}`);
  assert.ok(leagueShare.RB > 0.2 && leagueShare.WR > 0.2, "RB+WR dominate league spend");
  assert.ok(profiles.some((p) => p.owner === "<owner>"), "the scouted managers are present");
});

// --- nomination policy ---------------------------------------------------------------------
const board: NomPlayer[] = [
  { name: "Elite QB", pos: "QB", value: 45 },
  { name: "Elite RB", pos: "RB", value: 60 },
  { name: "Scrub K", pos: "K", value: 1 },
  { name: "Mid WR", pos: "WR", value: 20 },
];

test("drain nomination puts up the craved position of the best-funded payer -- not our target", () => {
  const payers = payersFrom([{ share: qbPayer.share, budgetLeft: 120, openPositions: new Set(["QB", "RB"]) }], league);
  const choice = planDrainNomination(board, new Set(["Elite RB"]), payers); // we WANT the RB
  assert.equal(choice.player.name, "Elite QB", "should nominate the QB to drain the QB-payer");
  assert.notEqual(choice.player.name, "Elite RB", "must never nominate a player we're targeting");
});

test("FAULT: no well-funded payer -> falls back to nominating a scrub (never stalls, never our target)", () => {
  const brokePayers = payersFrom([{ share: qbPayer.share, budgetLeft: 5, openPositions: new Set(["QB"]) }], league);
  const choice = planDrainNomination(board, new Set(["Elite RB"]), brokePayers);
  assert.ok(choice.player.value <= 20, "with no drain target, nominate a cheap non-target");
  assert.notEqual(choice.player.name, "Elite RB");
});
