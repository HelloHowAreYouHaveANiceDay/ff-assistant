// The FLEX-baseline allocation, which sets every position's replacement level and therefore the
// whole bid table. An even 3-way split of the FLEX slots hands TE starting slots it never actually
// wins; the weighted fill (default) allocates them by projected points. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselines, computeValues, resolveValueLeague, type PointsRow, type ValueLeague } from "../src/draft/values.ts";

// 4 teams, 1 RB / 1 WR / 1 TE dedicated + 1 FLEX each => 4 dedicated per pos, 4 flex slots.
const LG: ValueLeague = {
  teams: 4, budget: 200, rosterSpots: 8,
  starters: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1 },
};

// Every leftover TE (beyond TE4) scores BELOW every leftover RB/WR, so a points-weighted fill of
// the 4 FLEX slots must take zero TEs. Ranks are dense so the baseline index is unambiguous.
function fixture(): PointsRow[] {
  const rows: PointsRow[] = [];
  for (let i = 0; i < 12; i++) rows.push({ name: `RB${i + 1}`, pos: "RB", points: 300 - i * 10 });
  for (let i = 0; i < 12; i++) rows.push({ name: `WR${i + 1}`, pos: "WR", points: 295 - i * 10 });
  // TEs: TE1-TE4 are elite, everything after collapses far under the RB/WR leftovers (min 190).
  for (let i = 0; i < 12; i++) rows.push({ name: `TE${i + 1}`, pos: "TE", points: i < 4 ? 280 - i * 5 : 100 - i });
  return rows;
}

test("weighted FLEX fill: leftover TEs lose every flex slot; RB+WR shares sum to flexTotal", () => {
  const pts = fixture();
  const w = baselines(pts, LG); // default = weighted
  const dedicated = 4; // 1 starter x 4 teams
  const byPos = (pos: string) => pts.filter((p) => p.pos === pos).map((p) => p.points).sort((a, b) => b - a);

  // TE gets no flex share -> its baseline is the FIRST player past the dedicated starters (TE5).
  assert.equal(w.TE, byPos("TE")[dedicated], "TE baseline must sit at the dedicated count (no flex share)");

  // Recover each position's flex share from where its baseline landed; they must sum to flexTotal.
  const shareOf = (pos: string) => byPos(pos).indexOf(w[pos]) - dedicated;
  const flexTotal = (LG.starters.FLEX ?? 0) * LG.teams;
  assert.equal(shareOf("TE"), 0);
  assert.equal(shareOf("RB") + shareOf("WR"), flexTotal, "RB+WR must absorb all 4 flex slots");
});

test("regression lock: flexWeighted=false reproduces the old even 3-way split", () => {
  const pts = fixture();
  const e = baselines(pts, LG, false);
  const dedicated = 4;
  const evenShare = Math.round(((LG.starters.FLEX ?? 0) * LG.teams) / 3); // round(4/3) = 1
  for (const pos of ["RB", "WR", "TE"]) {
    const arr = pts.filter((p) => p.pos === pos).map((p) => p.points).sort((a, b) => b - a);
    assert.equal(e[pos], arr[dedicated + evenShare], `${pos} even-split baseline`);
  }
});

// FI: this is the whole point of the fix -- an elite TE must be worth LESS under the weighted curve.
// Injecting `flexWeighted = false` as the default in baselines() makes both halves equal and fails.
test("FAULT: an elite TE is priced LOWER under the weighted curve than under the even split", () => {
  const pts = fixture();
  const val = (rows: ReturnType<typeof computeValues>, n: string) => rows.find((r) => r.name === n)!.value;
  const weighted = computeValues(pts, LG, 2, true);
  const even = computeValues(pts, LG, 2, false);
  assert.ok(val(weighted, "TE1") < val(even, "TE1"),
    `weighted TE1 ${val(weighted, "TE1")} must be < even-split TE1 ${val(even, "TE1")}`);
  // ... and the money the TEs gave back has to land on the WRs.
  assert.ok(val(weighted, "WR1") > val(even, "WR1"),
    `weighted WR1 ${val(weighted, "WR1")} must be > even-split WR1 ${val(even, "WR1")}`);
});

// F3 / Step 9a: our table keys defenses by ABBREVIATION ("HOU D/ST" -> "hou"); ESPN's draft room
// shows the NICKNAME ("Texans D/ST" -> "texans"), so the live lookup missed all 32.
import fs from "node:fs";
import { dstAliasKey, DST_KEY_ALIASES } from "../src/draft/values.ts";

test("DST alias: every defense in the SHIPPED value table is reachable from its nickname", () => {
  // Coverage is DERIVED from the real table, not a hand-typed list -- so a team rename or an added
  // defense fails here instead of silently escaping the map.
  const keys = fs.readFileSync("data/values.csv", "utf8").trim().split("\n").slice(1)
    .map((l) => l.split(","))
    .filter((c) => c[1] === "DST")
    .map((c) => c[0]);
  assert.equal(keys.length, 32, "the table should carry all 32 defenses");
  const reachable = new Set(Object.values(DST_KEY_ALIASES));
  for (const name of keys) {
    const abbrKey = name.toLowerCase().replace(/\bd\/?st\b/g, " ").replace(/[^a-z]/g, "");
    assert.ok(reachable.has(abbrKey), `no nickname maps to ${name} (key ${abbrKey})`);
  }
});

test("DST alias: ESPN spellings resolve to our abbreviation key; a non-defense returns null", () => {
  assert.equal(dstAliasKey("Texans D/ST"), "hou");
  assert.equal(dstAliasKey("49ers D/ST"), "sf");       // non-letters stripped -> "ers"
  assert.equal(dstAliasKey("Washington D/ST"), "was");
  assert.equal(dstAliasKey("HOU D/ST"), "hou");        // already-correct name is a no-op
  assert.equal(dstAliasKey("Ja'Marr Chase"), null);
});

// --- the value book must follow the CONFIGURED league, not a hardcoded default -------------------
//
// `backtest.ts` and `sim.ts` used to price OUR book with the literal DEFAULT_VALUE_LEAGUE while the
// live board (`ff.ts:767`) priced it with resolveValueLeague(config). For a 16-team $200 12-slot
// league those two are identical, which is exactly why the divergence went unnoticed -- and why the
// "backtest still prints 32.9%" regression check CANNOT catch it. These tests use a deliberately
// DIFFERENT league so the two paths are distinguishable.

test("the value book actually depends on the league: a different format prices players differently", () => {
  const pts = fixture();
  const small: ValueLeague = { teams: 4, budget: 200, rosterSpots: 8, starters: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1 } };
  const big: ValueLeague = { teams: 10, budget: 300, rosterSpots: 14, starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2 } };
  const a = new Map(computeValues(pts, small).map((v) => [v.name, v.value]));
  const b = new Map(computeValues(pts, big).map((v) => [v.name, v.value]));
  // Deeper starting requirements push replacement level down and more money chases the same pool,
  // so the top of the book must move. If these ever match, someone has re-hardcoded the league.
  assert.notDeepEqual([...a.entries()], [...b.entries()], "value book ignored the league it was given");
  assert.notEqual(a.get("RB1"), b.get("RB1"), "RB1 priced identically in two different formats");
});

test("resolveValueLeague accepts a SimLeague as-is -- the shape the backtest passes down", () => {
  // SimLeague is {teams, budget, slots}: the exact structural contract backtest.ts/sim.ts rely on
  // when they hand `lg` to resolveValueLeague. A field rename there would break the fix silently.
  const simShaped = { teams: 12, budget: 300, slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DST", "BE", "BE", "BE", "BE", "BE"] };
  const vl = resolveValueLeague(simShaped);
  assert.equal(vl.teams, 12);
  assert.equal(vl.budget, 300);
  assert.equal(vl.rosterSpots, 14, "rosterSpots must count ALL slots, bench included");
  assert.equal(vl.starters.RB, 2);
  assert.equal(vl.starters.FLEX, 1);
  assert.equal(vl.starters.BE, undefined, "bench slots must not be counted as starters");
});

test("computeValues honours the maxKDst it is GIVEN, not the literal default", () => {
  // A dedicated fixture: the cap can only be OBSERVED if the uncapped price would exceed it, which
  // needs a K whose points sit far above his own replacement level. (With a single K in the pool the
  // baseline falls back to that same player, VOR is 0, and the cap never binds -- so a naive fixture
  // passes whether or not the argument is honoured.)
  const pts: PointsRow[] = [
    { name: "RB1", pos: "RB", points: 100 }, { name: "RB2", pos: "RB", points: 90 },
    { name: "RB3", pos: "RB", points: 80 }, { name: "RB4", pos: "RB", points: 70 },
    { name: "K1", pos: "K", points: 500 }, { name: "K2", pos: "K", points: 100 },
    { name: "K3", pos: "K", points: 90 }, { name: "K4", pos: "K", points: 80 },
  ];
  const lg: ValueLeague = { teams: 2, budget: 200, rosterSpots: 4, starters: { RB: 1, K: 1 } };
  const uncapped = new Map(computeValues(pts, lg, 999).map((v) => [v.name, v.value]));
  assert.ok(uncapped.get("K1")! > 7, "fixture is not exercising the cap");
  assert.equal(new Map(computeValues(pts, lg, 2).map((v) => [v.name, v.value])).get("K1"), 2);
  assert.equal(new Map(computeValues(pts, lg, 7).map((v) => [v.name, v.value])).get("K1"), 7);
});
