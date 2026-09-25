/**
 * THE LIVE WEEKLY ROW'S TEAM (architecture review 2026-09-24, B1).
 *
 * The forward builder wrote the season row's Sept-1 team into every week, so a man traded or signed
 * in September kept his old opponent, spread, rest days and `opp_*` block all season (Blake Grupe
 * served as IND while on NYJ). `forwardTeamAt` is the rule that replaced it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardTeamAt } from "../src/weekly/features.js";

const played = new Map<number, { team: string | null }>([[1, { team: "DEN" }], [2, { team: "DEN" }]]);

test("a week NOT YET PLAYED takes the CURRENT roster team, not the Sept-1 one", () => {
  assert.equal(forwardTeamAt({ played, week: 4, lastSettled: 3, currentTeam: "CLE", seasonTeam: "DEN" }), "CLE");
  // and a man with no played weeks at all (a September signing) likewise
  assert.equal(forwardTeamAt({ played: undefined, week: 4, lastSettled: 3, currentTeam: "NYJ", seasonTeam: "IND" }), "NYJ");
});

test("a SETTLED week keeps the team observed then -- the current team must not leak backwards", () => {
  assert.equal(forwardTeamAt({ played, week: 2, lastSettled: 3, currentTeam: "CLE", seasonTeam: "DEN" }), "DEN");
  // week 3 was settled but he did not play: the running team, not today's roster
  assert.equal(forwardTeamAt({ played, week: 3, lastSettled: 3, currentTeam: "CLE", seasonTeam: "DEN" }), "DEN");
});

test("no current team known falls back to the running team, then the season row", () => {
  assert.equal(forwardTeamAt({ played, week: 5, lastSettled: 3, currentTeam: null, seasonTeam: "XXX" }), "DEN");
  assert.equal(forwardTeamAt({ played: undefined, week: 5, lastSettled: 3, currentTeam: null, seasonTeam: "IND" }), "IND");
});
