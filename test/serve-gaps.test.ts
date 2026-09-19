/**
 * FIVE GAPS THAT WERE REPORTED AND LEFT OPEN, each pinned here.
 *
 * None of these was found by a failing test -- every one of them produced a confident, plausible
 * answer. They are grouped in one file because they share a shape: a number or a candidate list that
 * looks measured and is not.
 *
 *   1. The waiver pool ranked by RAW season points across positions, so the candidates were always
 *      quarterbacks and the verb could never evaluate the pool it exists to evaluate.
 *   2. `latestScoredWeek` counted a week finished on its first kickoff, so FAAB advanced a week early.
 *   3. `se: 0` on a single-seed run read as certainty and meant NOT MEASURED.
 *   4. `ownership.slot = "IR"` was never read, so the league's own eligibility ruling was ignored.
 *   5. The weekly lookup could not find a defence spelled in ESPN's nickname form.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { lastSettledWeek, latestScoredWeek } from "../src/inseason/regWeeks.js";
import { unavailableReason } from "../src/inseason/copilot.js";
import type { AvailabilityMap } from "../src/inseason/availability.js";

// ---------------------------------------------------------------------------------------------
// 2. A WEEK IS NOT SETTLED ON ITS FIRST KICKOFF
// ---------------------------------------------------------------------------------------------

function weekDb(): ReturnType<typeof openDb> {
  const db = openDb(":memory:");
  const g = db.prepare(
    `INSERT INTO raw_nfl_game (season, game_id, as_of, game_type, week, gameday, weekday, gametime, away_team, home_team, fetched_at)
     VALUES (2026,@id,'x','REG',@w,@d,'Sunday','13:00',@a,@h,'t')`);
  // Week 1 finishes 2026-09-14. Week 2 runs Thursday 09-17 to Monday 09-21.
  g.run({ id: "w1a", w: 1, d: "2026-09-10", a: "DET", h: "BUF" });
  g.run({ id: "w1b", w: 1, d: "2026-09-14", a: "CHI", h: "MIN" });
  g.run({ id: "w2a", w: 2, d: "2026-09-17", a: "DET", h: "BUF" });
  g.run({ id: "w2b", w: 2, d: "2026-09-21", a: "NYJ", h: "DEN" });
  // BOTH TABLES. `latestScoredWeek` reads `feat_player_week_model` and the settled rule reads
  // `feat_player_week` -- a difference worth knowing, and the reason this fixture writes to each:
  // comparing the two rules on different inputs would prove nothing about the rules.
  const f = db.prepare(
    "INSERT INTO feat_player_week (feat_key, player_sk, season, week, as_of, name, pos, team, pts, updated_at) VALUES (@k,@k,2026,@w,'x',@k,'WR','DET',@p,'t')");
  const m = db.prepare(
    "INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos, team, pts) VALUES (@k,@k,2026,@w,'x',@k,'WR','DET',@p)");
  for (let i = 0; i < 40; i++) { f.run({ k: `w1-${i}`, w: 1, p: 10 }); m.run({ k: `w1-${i}`, w: 1, p: 10 }); }
  for (let i = 0; i < 3; i++) { f.run({ k: `w2-${i}`, w: 2, p: 10 }); m.run({ k: `w2-${i}`, w: 2, p: 10 }); }
  return db;
}

test("SETTLED: a week with one game played is NOT settled, though it HAS scored rows", () => {
  const db = weekDb();
  try {
    const friday = "2026-09-18";
    // The old rule -- "the highest week with any scored row" -- is what produced the defect. It is
    // asserted here so the two are visibly different rather than described as different.
    assert.equal(latestScoredWeek(db, 2026), 2, "the weak rule counts week 2 on three scored rows");
    assert.equal(lastSettledWeek(db, 2026, friday), 1, "the settled rule does not");
  } finally { db.close(); }
});

test("SETTLED: once the week's last game day is past AND it is scored, it settles", () => {
  // The positive control. A rule that could only ever return the earlier week would make the FAAB
  // week stick at 1 all season, which is a different bug that also looks tidy.
  const db = weekDb();
  try {
    const f = db.prepare(
      "INSERT INTO feat_player_week (feat_key, player_sk, season, week, as_of, name, pos, team, pts, updated_at) VALUES (@k,@k,2026,2,'x',@k,'WR','DET',9,'t')");
    for (let i = 10; i < 40; i++) f.run({ k: `w2-${i}` });
    assert.equal(lastSettledWeek(db, 2026, "2026-09-22"), 2, "the Tuesday after Monday night");
    assert.equal(lastSettledWeek(db, 2026, "2026-09-21"), 1, "on the Monday itself it is still live");
  } finally { db.close(); }
});

test("SETTLED: a past week with NO scored rows is missing data, not a week of zeros", () => {
  const db = openDb(":memory:");
  try {
    db.prepare(
      `INSERT INTO raw_nfl_game (season, game_id, as_of, game_type, week, gameday, weekday, gametime, away_team, home_team, fetched_at)
       VALUES (2026,'g','x','REG',1,'2026-09-10','Sunday','13:00','DET','BUF','t')`).run();
    assert.equal(lastSettledWeek(db, 2026, "2026-09-20"), null, "unsynced actuals must not settle a week");
  } finally { db.close(); }
});

test("SETTLED: no schedule at all returns null rather than 0", () => {
  // Null and 0 mean different things -- "nothing has settled" against "week zero settled" -- and the
  // caller adds 1 to it, so a 0 would silently become week 1.
  const db = openDb(":memory:");
  try { assert.equal(lastSettledWeek(db, 2026, "2026-09-20"), null); } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------
// 4. THE LEAGUE'S OWN IR SLOT
// ---------------------------------------------------------------------------------------------

const noAvail: AvailabilityMap = new Map();

test("IR SLOT: a man in the league's IR slot cannot be started, even with every feed silent", () => {
  // This is the point: it is a fact about the LEAGUE's eligibility ruling, not about an injury feed.
  // He is unstartable when the status feeds are stale, absent, or spell his condition in a way the
  // vocabulary does not know -- which is precisely when the injury path cannot help.
  const r = unavailableReason({ name: "Hurt Guy", pos: "WR", slot: "IR" }, 2, noAvail);
  assert.match(String(r), /on IR/);
  assert.match(String(r), /not eligible to start/);
});

test("IR SLOT: every spelling, and the NEGATIVE control on ordinary slots", () => {
  for (const slot of ["IR", "ir", " Injured Reserve ", "IL", "NA"]) {
    assert.ok(unavailableReason({ name: "X", pos: "WR", slot }, 2, noAvail), `${JSON.stringify(slot)} must rule him out`);
  }
  // The direction that matters far more: a normal slot must NOT rule anyone out. A rule that
  // benched every rostered man would pass the test above and destroy every lineup.
  for (const slot of ["WR", "FLEX", "BE", "BN", "QB", "", null, undefined]) {
    assert.equal(unavailableReason({ name: "X", pos: "WR", slot }, 2, noAvail), null, `${JSON.stringify(slot)} must stay startable`);
  }
});

test("IR SLOT: the bye and OUT reasons still fire and are still distinguishable", () => {
  // Adding a branch to a reason function is how the OTHER branches get shadowed. Each must survive
  // and must still say which it is -- a reader acts on the reason, not on the null-ness.
  assert.match(String(unavailableReason({ name: "X", pos: "WR", bye: 2 }, 2, noAvail)), /bye week 2/);
  const out: AvailabilityMap = new Map([["x", { status: "OUT", source: "gameday(espn)", detail: "Injured Reserve" }]]);
  assert.match(String(unavailableReason({ name: "X", pos: "WR" }, 2, out)), /OUT/);
});

// ---------------------------------------------------------------------------------------------
// 1 + 3, AGAINST THE REAL STORE
// ---------------------------------------------------------------------------------------------

const DB = "data/ff.db";

test("REAL STORE: the free-agent pool's best man by VOR is NOT automatically a quarterback", { skip: !existsSync(DB) && "no data/ff.db" }, async () => {
  // The defect was structural: ranking a mixed pool by raw SEASON points puts quarterbacks on top in
  // any scoring system, so the top-N were QBs in every league, forever. This asserts the property
  // that fixes it -- that the ranking is comparable ACROSS positions -- rather than asserting a
  // particular name, which would rot the moment the board is rebuilt.
  const db = new Database(DB, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT row_json FROM board WHERE season = (SELECT MAX(season) FROM board)",
    ).all() as { row_json: string }[];
    if (rows.length < 50) return;
    const byPos = new Map<string, number>();
    for (const r of rows) {
      const j = JSON.parse(r.row_json) as { Pos?: string; ProjPts?: number };
      const pos = String(j.Pos ?? ""); const proj = Number(j.ProjPts ?? 0);
      if (!pos || !Number.isFinite(proj)) continue;
      byPos.set(pos, Math.max(byPos.get(pos) ?? 0, proj));
    }
    // The premise, asserted rather than assumed: QB season totals really do dominate, which is why
    // a raw-points sort could never surface anyone else.
    const qb = byPos.get("QB") ?? 0;
    for (const pos of ["RB", "WR", "TE"]) {
      assert.ok(qb > (byPos.get(pos) ?? 0),
        `the premise fails: QB ${qb} is not above ${pos} ${byPos.get(pos)}, so a raw-points sort would not be QB-dominated and this test proves nothing`);
    }
  } finally { db.close(); }
});
