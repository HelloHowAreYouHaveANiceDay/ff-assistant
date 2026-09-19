/**
 * A LINEUP RECOMMENDATION MUST BE ONE THE MANAGER CAN ACTUALLY SUBMIT.
 *
 * `lineupRecommend` had no concept of a kickoff: it priced every rostered man at his weekly
 * projection and returned the best legal assignment of all of them, including the ones whose games
 * were already over. On 2026-09-18, the morning after a Thursday night game, it told league 462233
 * to start a quarterback who had thrown for 29.8 points the night before FROM THE BENCH. The
 * arithmetic was right and the advice was impossible, and it would have recurred every Friday of the
 * season and every Sunday afternoon after the early window -- which is exactly when a manager looks.
 *
 * The constraint has to hold in three places, and a fix in only some of them is the half-fix this
 * repo keeps recording: the ASSIGNMENT (`optimalLineup`), the WIN-PROBABILITY SEARCH (which seeds
 * from its own expected-points lineup and then swaps), and the REPORT (`contested`, which names the
 * closest call). A caveat that contradicts the lineup it describes is worse than no caveat, because
 * the reader believes the sentence.
 *
 * Every test asserts BOTH directions. A lock that never lets anyone move and a lock that never fires
 * produce identically green runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalLineup, type RosterPlayer } from "../src/inseason/lineup.js";
import { ASSUME_FINAL_AFTER_MINUTES, finishedNflTeams, hasKickedOff, lockedNflTeams, settledPointsFor, weekKickoffTimes } from "../src/inseason/kickoffLock.js";
import { openDb, type DB } from "../src/db/db.js";

// ---------------------------------------------------------------------------------------------
// 1. THE CLOCK
// ---------------------------------------------------------------------------------------------

const k = (day: string, hm: string) => ({ team: "DET", day, hm });

test("CLOCK: a kickoff before now has started; one after has not", () => {
  const now = { day: "2026-09-18", hm: "08:30" };
  assert.equal(hasKickedOff(k("2026-09-17", "20:15"), now), true, "last night's game has been played");
  assert.equal(hasKickedOff(k("2026-09-20", "13:00"), now), false, "Sunday has not happened yet");
  assert.equal(hasKickedOff(k("2026-09-18", "08:29"), now), true, "a minute ago");
  assert.equal(hasKickedOff(k("2026-09-18", "08:31"), now), false, "a minute from now");
  // The boundary: a game kicking off exactly now IS locked. ESPN locks at kickoff, not after it.
  assert.equal(hasKickedOff(k("2026-09-18", "08:30"), now), true);
});

function scheduleDb(): DB {
  const db = openDb(":memory:");
  const ins = db.prepare(
    `INSERT INTO raw_nfl_game (season, game_id, as_of, game_type, week, gameday, weekday, gametime, away_team, home_team, fetched_at)
     VALUES (@s,@g,@a,'REG',@w,@d,@wd,@t,@away,@home,'t0')`);
  ins.run({ s: 2026, g: "g1", a: "x", w: 2, d: "2026-09-17", wd: "Thursday", t: "20:15", away: "DET", home: "BUF" });
  ins.run({ s: 2026, g: "g2", a: "x", w: 2, d: "2026-09-20", wd: "Sunday", t: "13:00", away: "CHI", home: "MIN" });
  ins.run({ s: 2026, g: "g3", a: "x", w: 2, d: "2026-09-21", wd: "Monday", t: "20:15", away: "NYJ", home: "DEN" });
  return db;
}

test("CLOCK: only the teams that have played are locked, and the schedule size is separable", () => {
  const db = scheduleDb();
  try {
    // Friday morning ET: Thursday's two teams are locked, the other four are not.
    const friday = lockedNflTeams(db, 2026, 2, new Date("2026-09-18T12:30:00.000Z")); // 08:30 ET
    assert.deepEqual([...friday].sort(), ["BUF", "DET"]);
    assert.equal(weekKickoffTimes(db, 2026, 2).size, 6, "all six teams are scheduled");

    // POSITIVE CONTROL in the other direction: before the first kickoff, NOTHING is locked -- and
    // that empty set must be distinguishable from "no schedule", which is why the caller reports
    // both. A rule that always locked everyone would pass every test that only checks a locked man.
    const wednesday = lockedNflTeams(db, 2026, 2, new Date("2026-09-16T12:00:00.000Z"));
    assert.equal(wednesday.size, 0);
    // And after the last one, everybody is.
    const tuesday = lockedNflTeams(db, 2026, 2, new Date("2026-09-22T12:00:00.000Z"));
    assert.equal(tuesday.size, 6);
  } finally { db.close(); }
});

test("CLOCK: a week with no schedule locks nobody rather than guessing", () => {
  const db = scheduleDb();
  try {
    assert.equal(lockedNflTeams(db, 2026, 9, new Date("2026-11-20T12:00:00.000Z")).size, 0);
    assert.equal(weekKickoffTimes(db, 2026, 9).size, 0, "and the caller can see WHY it is empty");
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------------------------
// 2. THE ASSIGNMENT
// ---------------------------------------------------------------------------------------------

const SLOTS = ["QB", "RB", "WR", "FLEX", "BE", "BE"];
const p = (name: string, pos: string, proj: number, extra: Partial<RosterPlayer> = {}): RosterPlayer =>
  ({ name, pos, proj, available: true, ...extra });

/** The live shape of the defect: a high-projected QB sitting on the bench with his game played. */
const ROSTER = (lock: boolean): RosterPlayer[] => [
  p("PlayedQB", "QB", 16.8, lock ? { locked: true, lockedSlot: "BE" } : {}),
  p("BenchedByChoiceQB", "QB", 15.4),
  p("RB1", "RB", 10),
  p("WR1", "WR", 9),
  p("WR2", "WR", 8),
];

test("ASSIGNMENT: a locked BENCH man is never started, however high he projects", () => {
  const r = optimalLineup(ROSTER(true), SLOTS);
  const qb = r.starters.find((s) => s.slot === "QB")!;
  assert.equal(qb.name, "BenchedByChoiceQB", "the only startable QB must take the slot");
  assert.ok(r.flags.some((f) => /LOCKED, cannot be started.*PlayedQB/.test(f)), `flags: ${r.flags.join(" | ")}`);
  // And he must NOT also be reported as out-projecting a starter -- that flag reads as an
  // actionable suggestion, which is the very thing this constraint exists to suppress.
  assert.ok(!r.flags.some((f) => /PlayedQB.*out-projects/.test(f)), `flags: ${r.flags.join(" | ")}`);
});

test("ASSIGNMENT: FAULT -- without the lock the optimizer starts him, which is the bug", () => {
  // The positive control for the constraint itself. If this ever fails, the lock has stopped being
  // the thing that changes the answer and these tests are measuring nothing.
  const r = optimalLineup(ROSTER(false), SLOTS);
  assert.equal(r.starters.find((s) => s.slot === "QB")!.name, "PlayedQB");
});

test("ASSIGNMENT: a locked STARTER holds his slot even when a better man is eligible", () => {
  const roster = [
    p("LockedWR", "WR", 4, { locked: true, lockedSlot: "WR" }),
    p("BetterWR", "WR", 20),
    p("QB1", "QB", 12), p("RB1", "RB", 10),
  ];
  const r = optimalLineup(roster, SLOTS);
  assert.equal(r.starters.find((s) => s.slot === "WR")!.name, "LockedWR", "he cannot be benched");
  // The better man is still seated where he legally can be -- FLEX -- rather than dropped. A lock
  // constrains one slot, it does not remove a player from consideration everywhere.
  assert.equal(r.starters.find((s) => s.slot === "FLEX")!.name, "BetterWR");
  assert.ok(r.flags.some((f) => /LOCKED, cannot be benched.*LockedWR/.test(f)));
});

test("ASSIGNMENT: the augmenting path may not route THROUGH a locked slot", () => {
  // The subtle one, and it took two attempts to write. Pre-seating alone is NOT enough: Kuhn's
  // search displaces occupants along an augmenting path, so without an explicit guard a man who
  // wants the locked slot can push the locked man out of it and the assignment calls itself optimal.
  //
  // THE FIRST VERSION OF THIS TEST DID NOT EXERCISE THE GUARD AT ALL -- removing the guard left it
  // green, because the free-slot pass seated the challenger in FLEX and displacement was never
  // attempted. A test that cannot fail is not evidence. The shape below forces the path:
  //
  //   - FLEX is restricted to WR/TE, so `OnlyRB` has exactly ONE legal slot: RB.
  //   - RB is held by the locked man, so the free-slot pass MUST fail and the search MUST try to
  //     displace him.
  //   - The locked man is WR-eligible, so the displacement would SUCCEED (he has somewhere to go) --
  //     which is what makes this a real test rather than one that passes because nothing was
  //     possible either way.
  //
  // Verified by fault injection: with the guard removed, `LockedRB` is moved to FLEX and `OnlyRB`
  // takes the RB slot -- i.e. a man whose game has kicked off is benched.
  const roster = [
    p("LockedRB", "RB", 3, { locked: true, lockedSlot: "RB", eligible: ["RB", "WR"] }),
    p("OnlyRB", "RB", 30, { eligible: ["RB"] }),
  ];
  const r = optimalLineup(roster, ["RB", "FLEX"], ["WR", "TE"]);
  assert.equal(r.starters.find((s) => s.slot === "RB")!.name, "LockedRB", "the locked man keeps his slot");
  assert.ok(!r.starters.some((x) => x.name === "OnlyRB"), "the challenger cannot take it and sits");
});

test("ASSIGNMENT: NO LOCKS means byte-identical behaviour -- the default path is untouched", () => {
  // Every existing caller passes no locks. If this diverges, the change is not additive and every
  // historical lineup and backtest result moved with it.
  const plain = [p("QB1", "QB", 20), p("RB1", "RB", 15), p("WR1", "WR", 12), p("WR2", "WR", 9), p("TE1", "TE", 3)];
  const a = optimalLineup(plain, SLOTS);
  const b = optimalLineup(plain.map((x) => ({ ...x, locked: false, lockedSlot: null })), SLOTS);
  assert.deepEqual(a.starters, b.starters);
  assert.deepEqual(a.bench, b.bench);
  assert.equal(a.totalProj, b.totalProj);
  assert.deepEqual(a.flags, b.flags);
});

test("ASSIGNMENT: a locked man whose slot is not in the template is locked OUT, not re-seated", () => {
  // The safe failure. An unknown or already-taken slot must not quietly make him movable.
  const roster = [
    p("Odd", "WR", 25, { locked: true, lockedSlot: "SUPERFLEX" }),
    p("QB1", "QB", 12), p("RB1", "RB", 10), p("WR1", "WR", 9), p("WR2", "WR", 8),
  ];
  const r = optimalLineup(roster, SLOTS);
  assert.ok(!r.starters.some((s) => s.name === "Odd"), "he must not be seated somewhere else");
  assert.ok(r.flags.some((f) => /LOCKED, cannot be started.*Odd/.test(f)));
});

// ---------------------------------------------------------------------------------------------
// 3. FINISHED IS NOT LOCKED, AND SETTLED POINTS
// ---------------------------------------------------------------------------------------------

test("FINISHED: a game that has kicked off but is still being played is LOCKED and NOT finished", () => {
  // The distinction the whole settled-points feature rests on. Conflating the two would price a
  // receiver with one first-quarter catch at 1.4 points for the entire week.
  const db = scheduleDb();
  try {
    const midGame = new Date("2026-09-18T01:00:00.000Z"); // 21:00 ET Thu -- 45 min into a 20:15 game
    assert.deepEqual([...lockedNflTeams(db, 2026, 2, midGame)].sort(), ["BUF", "DET"], "locked at kickoff");
    const f = finishedNflTeams(db, 2026, 2, midGame);
    assert.equal(f.byScore.size + f.byElapsed.size, 0, "but NOT finished while the game is on");
  } finally { db.close(); }
});

test("FINISHED: four hours after kickoff, with no score stored, the game is ASSUMED final", () => {
  const db = scheduleDb();
  try {
    const after = new Date("2026-09-18T04:20:00.000Z"); // 00:20 ET Fri -- 245 min past 20:15
    const f = finishedNflTeams(db, 2026, 2, after);
    assert.deepEqual([...f.byElapsed].sort(), ["BUF", "DET"]);
    assert.equal(f.byScore.size, 0, "and it must be reported as ASSUMED, not as a known result");
    // The boundary is the stated constant, not a number retyped here.
    const justBefore = new Date(after.getTime() - 6 * 60 * 1000);
    assert.ok(ASSUME_FINAL_AFTER_MINUTES === 240);
    assert.equal(finishedNflTeams(db, 2026, 2, justBefore).byElapsed.size, 0);
  } finally { db.close(); }
});

test("FINISHED: a STORED SCORE wins over the clock, and is reported as such", () => {
  const db = scheduleDb();
  try {
    db.prepare("UPDATE raw_nfl_game SET away_score=24, home_score=31, result=7 WHERE game_id='g1'").run();
    // Only twenty minutes in -- the clock alone would say "still playing", the score says otherwise.
    const f = finishedNflTeams(db, 2026, 2, new Date("2026-09-18T00:35:00.000Z"));
    assert.deepEqual([...f.byScore].sort(), ["BUF", "DET"]);
    assert.equal(f.byElapsed.size, 0);
  } finally { db.close(); }
});

test("SETTLED POINTS: joined BY ESPN ID, and a zero is never treated as a settled score", () => {
  // Zero is ambiguous in this feed: ESPN writes 0 both for "held scoreless" and for "not scored
  // yet", and they are the same bytes. Treating the second as the first would price an entire
  // unplayed roster at nothing, so a zero falls back to the projection.
  const db = scheduleDb();
  try {
    db.prepare("INSERT INTO player (player_id,name,position,espn_id,updated_at) VALUES ('scored','Scored','WR','111','t')").run();
    db.prepare("INSERT INTO player (player_id,name,position,espn_id,updated_at) VALUES ('zeroed','Zeroed','WR','222','t')").run();
    db.prepare("INSERT INTO player (player_id,name,position,espn_id,updated_at) VALUES ('nulled','Nulled','WR','333','t')").run();
    const ins = db.prepare(
      `INSERT INTO raw_league_roster_week (league_id,season,week,team_id,espn_player_id,name,position,lineup_slot_id,is_starter,applied_points,fetched_at)
       VALUES ('L',2026,2,'8',@id,@n,'WR',4,1,@p,'t')`);
    ins.run({ id: "111", n: "Scored", p: 18.4 });
    ins.run({ id: "222", n: "Zeroed", p: 0 });
    ins.run({ id: "333", n: "Nulled", p: null });

    const m = settledPointsFor(db, "L", 2026, 2);
    assert.equal(m.get("scored"), 18.4, "a real score resolves by espn_id to the board player_id");
    assert.equal(m.has("zeroed"), false, "a zero is NOT a settled score");
    assert.equal(m.has("nulled"), false, "nor is a null");
    assert.equal(m.size, 1);

    // Scoped to the league it was asked for -- another league's scores must never leak in.
    assert.equal(settledPointsFor(db, "OTHER", 2026, 2).size, 0);
    assert.equal(settledPointsFor(db, "L", 2026, 3).size, 0, "and to the week");
  } finally { db.close(); }
});
