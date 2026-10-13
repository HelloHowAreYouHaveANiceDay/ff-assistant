/**
 * THE LIVE SEASON'S UNIVERSE (2026-10-08). It used to be exactly the preseason consensus, so a man the
 * consensus skipped -- Tyler Huntley, picked up and started at QB by a rival in week 5 -- had no
 * feature row, no projection, no board row, and was dropped from the season simulator with a
 * WARNING. `liveUniverseExtras` adds the prior season's scorers who are still in the league, plus
 * rostered men with something to project from. These pin each arm and each guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { liveUniverseExtras } from "../src/features/build.js";
import type { DB } from "../src/db/db.js";

const SEASON = 2026;

function store(rostered: { name: string; position: string; week?: number }[]): DB {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE raw_league_roster_week (league_id TEXT, season INTEGER, week INTEGER, team_id TEXT,
    name TEXT, position TEXT, as_of_start TEXT)`);
  const ins = db.prepare("INSERT INTO raw_league_roster_week VALUES ('L', @s, @w, '1', @n, @p, '2026-09-01')");
  for (const r of rostered) ins.run({ s: SEASON, w: r.week ?? 5, n: r.name, p: r.position });
  return db as unknown as DB;
}

// A resolver that knows exactly the men named here; everyone else stays unresolved (NK: key).
const SK: Record<string, string> = { "tylerhuntley|QB": "2170", "carsonwentz|QB": "3852", "joeburrow|QB": "1", "retiredguy|WR": "9", "rookie|RB": "77", "nobody|TE": "88" };
const resolver = {
  staged: 0, offensivePos: () => null,
  resolve: ({ name, pos }: { name: string; pos: string }) => SK[`${name.toLowerCase().replace(/[^a-z]/g, "")}|${pos}`] ?? null,
};
const prow = (sk: string, name: string, pos: string) =>
  [sk, { key: sk, sk, name, nameKey: name.toLowerCase().replace(/[^a-z]/g, ""), pos, pts: 40, games: 5, team: null }] as const;
const usage = { games: 3, fd: 0, ts: 0, attempts: 0, rushYards: 0, ays: 0, wopr: 0, team: "BAL", teamFirst: "BAL" };

test("a prior-season scorer still in the league is added; the consensus and the retired are not", () => {
  const ecr = new Map([["1", { name: "Joe Burrow", pos: "QB" }]]);
  const prior = new Map([prow("1", "Joe Burrow", "QB"), prow("2170", "Tyler Huntley", "QB"), prow("3852", "Carson Wentz", "QB"), prow("9", "Retired Guy", "WR")]);
  const depth = new Map([["2170", "BAL"]]);              // Huntley: on a 2026 depth chart
  const cur = new Map([["3852", usage]]);                // Wentz: has played in 2026
  const out = liveUniverseExtras(store([]), SEASON, resolver, ecr, prior, depth, cur, new Map());
  assert.deepEqual([...out.rows.keys()].sort(), ["2170", "3852"]);
  assert.equal(out.fromPrior, 2);
  assert.ok(!out.rows.has("1"), "a consensus man is never added twice");
  assert.ok(!out.rows.has("9"), "a scorer with no evidence he is still in the league stays out");
});

test("rostered is evidence enough for a prior-season scorer", () => {
  const prior = new Map([prow("2170", "Tyler Huntley", "QB")]);
  const out = liveUniverseExtras(store([{ name: "Tyler Huntley", position: "QB" }]), SEASON, resolver, new Map(), prior, new Map(), new Map(), new Map());
  assert.deepEqual([...out.rows.keys()], ["2170"]);
});

test("a rostered man with draft capital is added; one with nothing to project from is skipped BY NAME", () => {
  const db = store([{ name: "Rookie", position: "RB" }, { name: "Nobody", position: "TE" }]);
  const drafted = new Map([["77", { year: 2026, round: 3, pick: 80 }]]);
  const out = liveUniverseExtras(db, SEASON, resolver, new Map(), new Map(), new Map(), new Map(), drafted);
  assert.deepEqual([...out.rows.keys()], ["77"]);
  assert.equal(out.fromRostered, 1);
  assert.deepEqual(out.skippedNoBasis, ["Nobody (TE)"]);
});

test("a consensus man held under a DIFFERENT surrogate key is not added again (name+position guard)", () => {
  // Kenny Gainwell, 2026: sk 1834 in history, 12112 in the ECR feed. Matching on the key alone added
  // him twice and `project` kept the higher number, moving a consensus man's projection.
  const ecr = new Map([["12112", { name: "Kenny Gainwell", pos: "RB" }]]);
  const prior = new Map([prow("1834", "Kenny Gainwell", "RB")]);
  const out = liveUniverseExtras(store([]), SEASON, resolver, ecr, prior, new Map([["1834", "PIT"]]), new Map(), new Map());
  assert.equal(out.rows.size, 0);
});

test("only the CURRENT roster week counts, and DST is left to the consensus", () => {
  const db = store([{ name: "Rookie", position: "RB", week: 1 }, { name: "Carson Wentz", position: "QB", week: 5 }, { name: "Bears D/ST", position: "D/ST", week: 5 }]);
  const prior = new Map([prow("3852", "Carson Wentz", "QB")]);
  const drafted = new Map([["77", { year: 2026, round: 3, pick: 80 }]]);
  const out = liveUniverseExtras(db, SEASON, resolver, new Map(), prior, new Map(), new Map(), drafted);
  assert.deepEqual([...out.rows.keys()], ["3852"], "the week-1 rookie was dropped by week 5; the D/ST is never added");
});

test("a man the extras already carry is not added a second time from the roster under another key", () => {
  // The prior-season row holds Huntley under one key; his roster name resolves to another (the
  // crosswalk duplicate again). Without the guard the rostered arm adds him twice -- he has draft
  // capital under the second key -- and `project` keeps the higher of two numbers.
  const prior = new Map([prow("5000", "Tyler Huntley", "QB")]);
  const drafted = new Map([["2170", { year: 2020, round: 7, pick: 250 }]]);
  const out = liveUniverseExtras(store([{ name: "Tyler Huntley", position: "QB" }]), SEASON, resolver, new Map(), prior,
    new Map([["5000", "BAL"]]), new Map(), drafted);
  assert.deepEqual([...out.rows.keys()], ["5000"]);
  assert.equal(out.fromRostered, 0);
});

test("a consensus man staged under ANOTHER NAME is not added again (stg_player_alias, Hollywood/Marquise Brown)", () => {
  // The consensus carries "Hollywood Brown" under the pinned stub key 12119; his history is "Marquise
  // Brown", sk 2612. No name guard can connect them -- staging's alias does. Positive control first:
  // without the alias row he enters twice, which is the defect on the 2026-10-13 candidate board.
  const ecr = new Map([["12119", { name: "Hollywood Brown", pos: "WR" }]]);
  const prior = new Map([prow("2612", "Marquise Brown", "WR")]);
  const depth = new Map([["2612", "PHI"]]);
  const bare = store([]);
  bare.exec("CREATE TABLE stg_player_alias (name_key TEXT, position TEXT, player_sk INTEGER, alias_of TEXT, reason TEXT, source TEXT, updated_at TEXT)");
  assert.deepEqual([...liveUniverseExtras(bare, SEASON, resolver, ecr, prior, depth, new Map(), new Map()).rows.keys()], ["2612"],
    "control: unaliased, the guard cannot see him and he is added");
  bare.prepare("INSERT INTO stg_player_alias VALUES ('hollywoodbrown','WR',2612,'marquisebrown','nickname','board:462233','x')").run();
  const out = liveUniverseExtras(bare, SEASON, resolver, ecr, prior, depth, new Map(), new Map());
  assert.equal(out.rows.size, 0, "the alias says 2612 IS the consensus man: one row, not two");
  // and the rostered arm too: his roster spelling resolves to the real key
  const rosterRes = { ...resolver, resolve: ({ name, pos }: { name: string; pos: string }) => (name === "Marquise Brown" && pos === "WR" ? "2612" : null) };
  bare.prepare("INSERT INTO raw_league_roster_week VALUES ('L', ?, 5, '1', 'Marquise Brown', 'WR', '2026-09-01')").run(SEASON);
  const r2 = liveUniverseExtras(bare, SEASON, rosterRes, ecr, new Map(), new Map(), new Map(), new Map([["2612", { year: 2019, round: 1, pick: 25 }]]));
  assert.equal(r2.rows.size, 0);
});
