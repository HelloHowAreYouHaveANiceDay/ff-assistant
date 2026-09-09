/**
 * ESPN eligibility: the slot-id mapping, and the identity join that must NOT be a name join.
 *
 * The mapping test's whole point is the COMBO slots. Every wide receiver in ESPN's pool carries slot
 * 3 (RB/WR) and slot 23 (FLEX); a reader that treats those as positions marks the entire board
 * dual-eligible, which is a working-looking feature that measures nothing. So there is a positive
 * control (a genuine RB/WR, slots 2 AND 4, comes back dual) beside the negative one (an ordinary WR
 * carrying 3 and 23 comes back single) -- a mapper that can only ever say "single" passes the second
 * test alone.
 *
 * The staging test is the two Justin Jeffersons. FAULT INJECTION lives in it: `stageEligibility`
 * takes a `resolveBy` switch, and flipping it to "name" is watched to hand the wide receiver the
 * linebacker's eligibility. A guard nobody has seen fail is not a guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import {
  mapEligibility, stageEligibility, storeRawEligibility, loadEligibilityMap,
  DEDICATED_SLOT_POS, ESPN_SLOT_NAME, type EligibilityRow,
} from "../src/data/eligibility.js";

const SEASON = 2026;

function tmpDb() {
  const path = join(mkdtempSync(join(tmpdir(), "ff-elig-")), "ff.db");
  return openDb(path);
}

test("the slot table separates DEDICATED ids from COMBO ids", () => {
  // If a combo id ever leaks into the dedicated map the whole board goes dual, silently.
  for (const combo of [3, 5, 7, 23]) {
    assert.equal(DEDICATED_SLOT_POS[combo], undefined, `slot ${combo} (${ESPN_SLOT_NAME[combo]}) must not name a position`);
  }
  for (const bench of [20, 21, 24]) assert.equal(DEDICATED_SLOT_POS[bench], undefined);
  assert.deepEqual(
    Object.entries(DEDICATED_SLOT_POS).map(([k, v]) => `${k}:${v}`).sort(),
    ["0:QB", "16:DST", "17:K", "2:RB", "4:WR", "6:TE"].sort(),
  );
});

test("an ordinary receiver is SINGLE-eligible despite carrying RB/WR and FLEX", () => {
  // These are Puka Nacua's real 2026 slots, read through the bridge.
  const r = mapEligibility(SEASON, { id: 4426515, fullName: "Puka Nacua", defaultPositionId: 3, eligibleSlots: [3, 4, 5, 23, 7, 20, 21] })!;
  assert.deepEqual(r.eligiblePositions, ["WR"]);
  assert.equal(r.defaultPosition, "WR");
  assert.deepEqual(r.rawSlots, [3, 4, 5, 23, 7, 20, 21], "the raw ids must be kept verbatim for audit");
});

test("POSITIVE CONTROL: two dedicated slots come back as two positions", () => {
  const r = mapEligibility(SEASON, { id: 1, fullName: "Dual Man", defaultPositionId: 2, eligibleSlots: [2, 3, 4, 5, 23, 7, 20, 21] })!;
  assert.deepEqual(r.eligiblePositions, ["RB", "WR"]);
  const qbte = mapEligibility(SEASON, { id: 2, fullName: "Wildcat Passer", defaultPositionId: 4, eligibleSlots: [0, 5, 6, 23, 7, 20, 21] })!;
  assert.deepEqual(qbte.eligiblePositions, ["QB", "TE"]);
});

test("a player with no dedicated slot at all keeps his default position rather than vanishing", () => {
  const r = mapEligibility(SEASON, { id: 3, fullName: "Unlisted Guy", defaultPositionId: 1, eligibleSlots: [20, 21] })!;
  assert.deepEqual(r.eligiblePositions, ["QB"]);
});

/** Both Justin Jeffersons: same name_key, different ESPN ids, different eligibility. */
function seedJeffersons(db: ReturnType<typeof openDb>) {
  const ins = db.prepare("INSERT INTO player_identity (name_key, birthdate, primary_position, first_name, matched_by, created_at) VALUES (?,?,?,?,?,?)");
  const wr = ins.run("justinjefferson", "1999-06-16", "WR", "Justin", "test", "now").lastInsertRowid as number;
  const lb = ins.run("justinjefferson", "2003-03-20", "LB", "Justin", "test", "now").lastInsertRowid as number;
  const x = db.prepare("INSERT INTO player_xref (player_sk, source, source_id, created_at) VALUES (?,?,?,?)");
  x.run(wr, "espn", "4262921", "now");
  x.run(lb, "espn", "4692890", "now");
  return { wr, lb };
}

const JEFFERSON_ROWS: EligibilityRow[] = [
  { season: SEASON, espnPlayerId: "4262921", name: "Justin Jefferson", defaultPosition: "WR", eligiblePositions: ["WR"], rawSlots: [3, 4, 5, 23, 7, 20, 21] },
  // The linebacker, whom ESPN qualifies at nothing offensive. Given a deliberately DIFFERENT set so
  // a mix-up is visible rather than a coin flip that happens to land right.
  { season: SEASON, espnPlayerId: "4692890", name: "Justin Jefferson", defaultPosition: "RB", eligiblePositions: ["RB"], rawSlots: [2, 3, 23, 7, 20, 21] },
];

test("staging resolves by ESPN id, so the two Justin Jeffersons keep their own eligibility", () => {
  const db = tmpDb();
  const { wr, lb } = seedJeffersons(db);
  assert.equal(storeRawEligibility(db, JEFFERSON_ROWS), 2);
  const res = stageEligibility(db, SEASON, JEFFERSON_ROWS);
  assert.equal(res.staged, 2, "two men, two staged rows");
  assert.equal(res.unresolved, 0);
  const get = (sk: number) => JSON.parse((db.prepare("SELECT positions_json FROM player_eligibility WHERE player_sk=? AND season=?").get(sk, SEASON) as { positions_json: string }).positions_json);
  assert.deepEqual(get(wr), ["WR"]);
  assert.deepEqual(get(lb), ["RB"]);
  db.close();
});

test("FAULT INJECTION: resolving by NAME collapses the two Jeffersons into one wrong row", () => {
  const db = tmpDb();
  const { wr, lb } = seedJeffersons(db);
  const res = stageEligibility(db, SEASON, JEFFERSON_ROWS, "name");
  // The name join cannot tell them apart: one surrogate key absorbs BOTH sets, the other gets none.
  assert.equal(res.staged, 1, "a name join produced one row for two men -- if this is 2, the fixture no longer discriminates");
  const rows = db.prepare("SELECT player_sk, positions_json FROM player_eligibility WHERE season=?").all(SEASON) as { player_sk: number; positions_json: string }[];
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].positions_json), ["RB", "WR"],
    "the wide receiver has been handed the linebacker's eligibility -- exactly the defect the ESPN-id join exists to prevent");
  assert.ok(rows[0].player_sk === wr || rows[0].player_sk === lb);
  db.close();
});

test("loadEligibilityMap omits single-eligible players, so an all-single league yields an EMPTY map", () => {
  const db = tmpDb();
  seedJeffersons(db);
  stageEligibility(db, SEASON, JEFFERSON_ROWS);
  assert.equal(loadEligibilityMap(db, SEASON).size, 0, "nobody here is dual; the map must be empty, not merely small");

  // ...and a genuine dual DOES appear, or the emptiness above proves nothing.
  const dual: EligibilityRow[] = [{ season: SEASON, espnPlayerId: "4262921", name: "Justin Jefferson", defaultPosition: "WR", eligiblePositions: ["RB", "WR"], rawSlots: [2, 3, 4, 5, 23, 7, 20, 21] }];
  stageEligibility(db, SEASON, dual);
  const m = loadEligibilityMap(db, SEASON);
  assert.equal(m.size, 1);
  assert.deepEqual(m.get("justinjefferson"), ["RB", "WR"]);
  db.close();
});
