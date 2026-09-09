// STEP 1 OF THE IN-SEASON BACKTEST: the raw week-by-week roster and transaction rows.
//
// Two kinds of test, and the split matters.
//
//   PARSER TESTS run against the CACHED ESPN PAYLOADS themselves (data/cache/espn/*.json.gz), not
//   against a fixture this repo wrote. A parser graded on a fixture its own author invented is a
//   producer validating itself, which is the failure mode docs/data-layers.md names. Where the cache
//   is absent (a clean clone, CI) they skip and SAY SO rather than passing vacuously.
//
//   GUARD TESTS are hermetic and are FAULT-INJECTED: the completeness guard is fed a season it MUST
//   reject, and the test fails if it does not. A guard that has only ever returned "clean" is
//   indistinguishable from a guard that is not connected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  parseRosterWeek, isStarterSlot, checkRosterWeeks, weeksInSeason, espnCachePath,
  type RosterWeekCheck,
} from "../src/data/leagueRosters.js";
import { parseTransactionWeek, localIso } from "../src/data/leagueTransactions.js";

const LEAGUE = "462233";
const cached = (key: string): unknown | null => {
  const f = espnCachePath(key);
  return existsSync(f) ? JSON.parse(gunzipSync(readFileSync(f)).toString("utf8")) : null;
};

// ------------------------------------------------------------------------------------------
// PARSER, against real payloads
// ------------------------------------------------------------------------------------------

test("roster parser: a past season's week is a full league of full rosters, with real starters", () => {
  const j = cached(`box-${LEAGUE}-2020-w3`);
  if (!j) { console.log("  (skipped: no cached 2020 w3 boxscore -- run `ff ingest-raw league-rosters`)"); return; }
  const got = parseRosterWeek(j, 2020, 3);
  assert.equal(got.available, true);
  const teams = new Set(got.rows.map((r) => r.teamId));
  assert.equal(teams.size, 14, "2020 was a 14-team league");
  for (const t of teams) {
    const mine = got.rows.filter((r) => r.teamId === t);
    assert.equal(mine.length, 13, `team ${t} should roster 13`);
    assert.equal(mine.filter((r) => r.isStarter).length, 8, `team ${t} should start 8`);
  }
  // Every row must have a position and a name -- a roster of "?" would parse, load and be useless.
  assert.equal(got.rows.filter((r) => r.position === "?").length, 0);
  assert.equal(got.rows.filter((r) => !r.name).length, 0);
});

test("roster parser: the starting lineup MOVES between weeks (the whole premise of the track)", () => {
  const a = cached(`box-${LEAGUE}-2020-w3`), b = cached(`box-${LEAGUE}-2020-w8`);
  if (!a || !b) { console.log("  (skipped: cached 2020 w3/w8 boxscores absent)"); return; }
  const key = (payload: unknown, w: number): string => {
    const rows = parseRosterWeek(payload, 2020, w).rows.filter((r) => r.teamId === "2" && r.isStarter);
    return rows.map((r) => r.espnPlayerId).sort().join(",");
  };
  const k3 = key(a, 3), k8 = key(b, 8);
  assert.ok(k3.length > 0 && k8.length > 0);
  // This is the assertion that would have caught the leagueHistory+mRoster trap: that endpoint
  // returns byte-identical starters for every week of the season, and it looks entirely plausible.
  assert.notEqual(k3, k8, "week 3 and week 8 starters are identical -- the endpoint is ignoring the week");
});

test("roster parser: a scoring period with no games is 'unavailable' with a note, not an exception", () => {
  const j = cached(`box-${LEAGUE}-2020-w17`);
  if (!j) { console.log("  (skipped: cached 2020 w17 boxscore absent)"); return; }
  const got = parseRosterWeek(j, 2020, 17);
  assert.equal(got.available, false);
  assert.equal(got.rows.length, 0);
  assert.ok(got.note && got.note.length > 0, "an empty week must carry a note saying why");
});

test("transaction parser: a real week yields ADD/DROP items keyed by ESPN's own transaction id", () => {
  const j = cached(`tx-${LEAGUE}-2024-w5`);
  if (!j) { console.log("  (skipped: cached 2024 w5 transactions absent)"); return; }
  const got = parseTransactionWeek(j, 2024, 5);
  assert.equal(got.available, true);
  assert.ok(got.rows.length >= 20, `expected the probed 21 items, got ${got.rows.length}`);
  // One row per ITEM. A pickup is an ADD plus a DROP under one transaction id, so ids repeat and
  // item_no disambiguates -- the property the primary key depends on.
  const ids = new Set(got.rows.map((r) => r.transactionId));
  assert.ok(ids.size < got.rows.length, "every item had a unique transaction id -- the container is being flattened wrong");
  for (const r of got.rows) {
    assert.ok(["ADD", "DROP", "LINEUP", "DRAFT"].includes(r.itemType), `unexpected item type ${r.itemType}`);
    assert.ok(r.espnPlayerId.length > 0);
    assert.ok(r.executedAt && /^\d{4}-\d{2}-\d{2} /.test(r.executedAt), "executed_at must be a local date-time");
  }
});

test("transaction parser: FAAB bids survive on waiver claims", () => {
  // MEASURED, not assumed. Across 2018-2025 this league's WAIVER transactions carry a bid on 93% of
  // claims with a season maximum of $51-$106, while FREEAGENT pickups carry 0 -- except in 2018,
  // where 72 of 230 free-agent moves carry a bid of exactly $1. So the assertion is on the WAIVER
  // rows; an assertion that every FREEAGENT bid is zero would be a claim about a league setting that
  // this league changed after its first season.
  let checked = 0;
  for (const w of [2, 4, 6, 8, 10]) {
    const j = cached(`tx-${LEAGUE}-2018-w${w}`);
    if (!j) continue;
    const waivers = parseTransactionWeek(j, 2018, w).rows.filter((r) => r.type === "WAIVER");
    for (const r of waivers) {
      assert.ok(r.bidAmount != null, "a waiver claim must carry its bid, even when it is zero");
      assert.ok(r.bidAmount >= 0);
      checked++;
    }
  }
  if (!checked) console.log("  (skipped: no cached 2018 waiver weeks)");
});

// ------------------------------------------------------------------------------------------
// PURE HELPERS
// ------------------------------------------------------------------------------------------

test("slot 20 is the bench and 21 is IR; 23 is FLEX and is a START", () => {
  assert.equal(isStarterSlot(20), false);
  assert.equal(isStarterSlot(21), false);
  assert.equal(isStarterSlot(23), true, "23 is FLEX -- treating it as IR would erase every flex start");
  assert.equal(isStarterSlot(0), true);
});

test("weeksInSeason follows the NFL's 17->18 change", () => {
  assert.equal(weeksInSeason(2020), 17);
  assert.equal(weeksInSeason(2021), 18);
});

test("localIso renders LOCAL time, so a Tuesday-night waiver stays on Tuesday", () => {
  const ms = new Date(2024, 9, 2, 22, 15, 30).getTime();
  assert.equal(localIso(ms), "2024-10-02 22:15:30");
});

// ------------------------------------------------------------------------------------------
// THE COMPLETENESS GUARD, AND ITS FAULT INJECTION
// ------------------------------------------------------------------------------------------

const clean = (season: number, teamWeeks = 224): RosterWeekCheck => ({
  season, weeks: 16, teamWeeks, rows: teamWeeks * 13,
  minRoster: 13, maxRoster: 13, modeRoster: 13, offSize: 0,
  minStarters: 8, maxStarters: 8, modeStarters: 8, offStarters: 0,
});

test("the completeness guard passes a clean season", () => {
  assert.deepEqual(checkRosterWeeks([clean(2022)]), []);
});

test("FAULT INJECTION: a season with half its rosters truncated MUST be rejected", () => {
  // The failure this guard exists for: a session that lapsed mid-sweep, or a gated view, leaves
  // short rosters that load without complaint and look exactly like real ones.
  const broken = { ...clean(2022), offSize: 112, minRoster: 6 };
  const found = checkRosterWeeks([broken]);
  assert.ok(found.length > 0, "the guard did not fire on a season with half its rosters short");
  assert.match(found[0].what, /roster size/);
  assert.ok(found[0].got > found[0].limit);
});

test("FAULT INJECTION: a season with no rows at all MUST be rejected, not silently pass", () => {
  const empty = { ...clean(2022, 0), rows: 0 };
  const found = checkRosterWeeks([empty]);
  assert.ok(found.length > 0, "an empty season passed the completeness guard");
  assert.match(found[0].what, /no team-weeks/);
});

test("FAULT INJECTION: the starter check fires too, at its own looser limit", () => {
  // The two tolerances are deliberately different: roster size is a league rule, starter count is a
  // manager's choice. This proves the starter branch is connected and not merely inert.
  assert.deepEqual(checkRosterWeeks([{ ...clean(2019), offStarters: 18 }]), [], "8% short lineups is a real 2019 fact, not a defect");
  const found = checkRosterWeeks([{ ...clean(2019), offStarters: 90 }]);
  assert.ok(found.length > 0, "the starter branch never fires -- it is dead code");
  assert.match(found[0].what, /starter count/);
});
