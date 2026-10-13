// Scheme raw ingesters (src/data/schemeSources.ts) and the live-feed cache age (src/data/nflverse.ts).
// PURE mappers on synthetic rows, no network and no db. Each test carries a row that MUST be rejected
// or a value that MUST land null, so a mapper that keys too loosely or coerces NA to 0 fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bool01, mapSchemePlay, mapFtnPlay, mapPbpPlay, SCHEME_COLS, FTN_COLS, PBP_PLAY_COLS } from "../src/data/schemeSources.js";
import { cacheIsStale, liveNflSeason } from "../src/data/nflverse.js";

const meta = new Map([["2025_01_DAL_PHI", { week: 1, gameday: "2025-09-04" }]]);

test("bool01: TRUE/FALSE, 1/0, 1.0 parse; NA and blank are unknown, not false", () => {
  assert.equal(bool01("TRUE"), 1); assert.equal(bool01("false"), 0);
  assert.equal(bool01("1"), 1); assert.equal(bool01("1.0"), 1); assert.equal(bool01("0"), 0);
  assert.equal(bool01("NA"), null); assert.equal(bool01(""), null);
});

test("mapSchemePlay keys on (game, play), takes week + as_of from raw_nfl_game, keeps coverage", () => {
  const r = mapSchemePlay(2025, {
    nflverse_game_id: "2025_01_DAL_PHI", play_id: "71", possession_team: "DAL", offense_formation: "SHOTGUN",
    offense_personnel: "1 RB, 1 TE, 3 WR", defenders_in_box: "6", was_pressure: "FALSE", route: "SLANT",
    defense_man_zone_type: "ZONE_COVERAGE", defense_coverage_type: "COVER_3", time_to_throw: "2.41", ngs_air_yards: "NA",
  }, meta)!;
  assert.equal(r.week, 1); assert.equal(r.as_of, "2025-09-04"); assert.equal(r.team, "DAL");
  assert.equal(r.defense_coverage_type, "COVER_3"); assert.equal(r.was_pressure, 0);
  assert.equal(r.ngs_air_yards, null, "NA must land null, not 0");
  assert.equal(r.route, "SLANT");
  // every column the upsert names is present on the record
  for (const c of SCHEME_COLS) assert.ok(c in r, `missing ${c}`);
  // unkeyable rows are rejected
  assert.equal(mapSchemePlay(2025, { nflverse_game_id: "", play_id: "1" }, meta), null);
  assert.equal(mapSchemePlay(2025, { nflverse_game_id: "2025_01_DAL_PHI", play_id: "NA" }, meta), null);
  // a game raw_nfl_game does not know keeps the row but with week/as_of unknown
  const orphan = mapSchemePlay(2025, { nflverse_game_id: "2025_99_X_Y", play_id: "5" }, meta)!;
  assert.equal(orphan.week, null); assert.equal(orphan.as_of, null);
});

test("mapFtnPlay keys on the NFLVERSE play id (not FTN's) and parses the booleans", () => {
  const r = mapFtnPlay(2026, {
    nflverse_game_id: "2025_01_DAL_PHI", nflverse_play_id: "64", ftn_play_id: "1153343", week: "1",
    is_play_action: "TRUE", is_motion: "FALSE", is_rpo: "NA", n_blitzers: "2", qb_location: "U",
  }, meta)!;
  assert.equal(r.play_id, 64, "join key must be nflverse_play_id");
  assert.equal(r.ftn_play_id, 1153343);
  assert.equal(r.is_play_action, 1); assert.equal(r.is_motion, 0); assert.equal(r.is_rpo, null);
  for (const c of FTN_COLS) assert.ok(c in r, `missing ${c}`);
  assert.equal(mapFtnPlay(2026, { nflverse_game_id: "G", ftn_play_id: "9" }, meta), null, "no nflverse play id -> unkeyable");
});

test("mapPbpPlay keeps scrimmage plays only and carries PROE", () => {
  const gd = new Map([["G1", "2026-09-13"]]);
  const pass = mapPbpPlay(2026, {
    game_id: "G1", play_id: "100", week: "2", play_type: "pass", pass_attempt: "1", rush_attempt: "0",
    receiver_player_id: "00-1", passer_player_id: "00-2", xpass: "0.62", pass_oe: "37.9", shotgun: "1", pass_length: "deep",
  }, gd)!;
  assert.equal(pass.as_of, "2026-09-13"); assert.equal(pass.receiver_id, "00-1"); assert.equal(pass.pass_oe, 37.9);
  assert.equal(pass.shotgun, 1); assert.equal(pass.rusher_id, null);
  for (const c of PBP_PLAY_COLS) assert.ok(c in pass, `missing ${c}`);
  assert.ok(mapPbpPlay(2026, { game_id: "G1", play_id: "101", play_type: "run", rush_attempt: "1", rusher_player_id: "00-3" }, gd));
  // non-scrimmage plays are dropped
  assert.equal(mapPbpPlay(2026, { game_id: "G1", play_id: "1", play_type: "kickoff" }, gd), null);
  assert.equal(mapPbpPlay(2026, { game_id: "G1", play_id: "2", play_type: "no_play", pass_attempt: "0", rush_attempt: "0" }, gd), null);
  assert.equal(mapPbpPlay(2026, { game_id: "G1", play_id: "NA", play_type: "pass" }, gd), null);
});

test("cacheIsStale: a finished file never expires; a live one expires past its max age", () => {
  const h = 3600_000, now = 1_000 * h;
  assert.equal(cacheIsStale(now - 10_000 * h, now, null), false, "finished-season file: cache forever");
  assert.equal(cacheIsStale(now - 5 * h, now, 6), false);
  assert.equal(cacheIsStale(now - 7 * h, now, 6), true, "the bug: a live file fetched long ago must re-fetch");
});

test("liveNflSeason: Jan/Feb belong to the previous season", () => {
  assert.equal(liveNflSeason(new Date(2027, 0, 20)), 2026);
  assert.equal(liveNflSeason(new Date(2027, 1, 10)), 2026);
  assert.equal(liveNflSeason(new Date(2026, 9, 12)), 2026);
  assert.equal(liveNflSeason(new Date(2027, 2, 1)), 2027);
});
