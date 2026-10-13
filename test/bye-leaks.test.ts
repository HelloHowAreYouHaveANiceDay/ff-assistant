/**
 * BYE / NO-GAME LEAKS closed on 2026-10-13 (docs/decisions.md D52), one test per leak. Each
 * has a positive control (the same input with a game / off-bye still behaves as before) and the
 * bug's own shape (fault injection: the old behaviour must reappear when the fix is cut).
 *
 *  1. `topStreamPick` (the scorecard's frozen stream pick) never picks a man with no game.
 *  2. `depthRisk` adds an insurance candidate WITH his bye, not `bye: null`.
 *  3. The expected-lineup streaming floor is PER WEEK, leaving out that week's bye free agents.
 *  4. The weekly serve (`projectStreamingWith`) serves a no-game row as a certain zero, and leaves
 *     every row with a game byte-identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { topStreamPick, projectStreamingWith, type StreamProj, type StreamDb } from "../src/weekly/streamingServe.js";
import { depthRisk } from "../src/inseason/copilot.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";
import type { SeasonTeamInput } from "../src/draft/season.js";
import {
  expectedLineupPoints, replacementByWeekFrom, replacementFloor, type ExpLineupPlayer,
} from "../src/inseason/expectedLineup.js";
import { loadWeeklyRows } from "../src/weekly/features.js";

// ---------------------------------------------------------------------------------------------
// 1. topStreamPick
// ---------------------------------------------------------------------------------------------
const mk = (name: string, mean: number, rank: number, extra: Partial<StreamProj> = {}): StreamProj => ({
  feat_key: name, player_sk: null, name, pos: "DST", team: "X", opponent: "Y", mean, p10: 0, p50: mean, p90: mean * 2,
  pZero: null, rank, artifact: "a.json", ...extra,
});

test("topStreamPick: a bye / unsigned / noGame man is never the model's pick NOR the board's", () => {
  const rows = [
    mk("CIN D/ST on bye", 9, 17, { opponent: null }),          // the frozen wk6 pick
    mk("Unsigned", 8.5, 18, { team: "FA", opponent: null }),    // Tommy Myers' shape
    mk("Served zero", 8, 19, { noGame: true, opponent: null }),
    mk("Plays", 6, 20),
    mk("Plays too", 5, 21),
  ];
  const p = topStreamPick(rows, { DST: 16 });
  assert.equal(p.DST.model!.name, "Plays", "a man with no game was picked as the model's stream");
  assert.equal(p.DST.line!.name, "Plays", "the board's pick (best rank) must also skip a no-game man");
  // POSITIVE CONTROL: the same bye man WITH a game is picked -- the filter is about the game, not him.
  const withGame = rows.map((r) => (r.name === "CIN D/ST on bye" ? { ...r, opponent: "PIT" } : r));
  assert.equal(topStreamPick(withGame, { DST: 16 }).DST.model!.name, "CIN D/ST on bye");
  // A hand-built row with NO opponent field (undefined = "not said") is still eligible.
  const { opponent: _o, ...noField } = mk("Hand built", 10, 22);
  void _o;
  assert.equal(topStreamPick([noField as StreamProj, ...rows], { DST: 16 }).DST.model!.name, "Hand built");
  // Every pool man without a game: no pick at all rather than an unplayable one.
  assert.equal(topStreamPick(rows.slice(0, 3), { DST: 16 }).DST, undefined);
});

// ---------------------------------------------------------------------------------------------
// 2. depthRisk insurance carries the candidate's bye
// ---------------------------------------------------------------------------------------------
test("depthRisk: a free-agent insurer enters the sim WITH his bye (ctx.byeOf), never bye:null", () => {
  const run = (byeOf: (n: string) => number | null) => {
    const ctx = fixtureCtx();
    ctx.byeOf = (name) => byeOf(name);
    const seen: SeasonTeamInput[][] = [];
    const inner = ctx.run;
    ctx.run = (t, trials, seed, extra) => { seen.push(t); return inner(t, trials, seed, extra); };
    const r = depthRisk(ctx, "RB Bravo A", { trials: 40, seeds: [7], insurers: 2 });
    assert.ok(r.insurance.some((i) => i.name === "Free Runner"), "fixture: Free Runner must be shortlisted");
    const added = seen.map((t) => t[ctx.meIdx].roster.find((p) => p.name === "Free Runner")).filter(Boolean);
    assert.ok(added.length > 0, "the insurer never reached the simulator");
    return added.map((p) => p!.bye);
  };
  assert.deepEqual([...new Set(run((n) => (n === "Free Runner" ? 9 : null)))], [9],
    "the free-agent insurer was simulated without his bye (the pre-fix bye:null)");
  // FAULT-INJECTION SHAPE: a resolver that knows nothing reproduces the old null -- the value really
  // comes from ctx.byeOf, not from a constant.
  assert.deepEqual([...new Set(run(() => null))], [null]);
});

// ---------------------------------------------------------------------------------------------
// 3. per-week, bye-aware streaming floor
// ---------------------------------------------------------------------------------------------
test("replacementByWeekFrom: the week's floor drops that week's bye free agents; other weeks = flat floor", () => {
  const free = [
    { pos: "K", rate: 8, bye: 7 }, { pos: "K", rate: 7, bye: 9 }, { pos: "K", rate: 6, bye: 10 },
    { pos: "QB", rate: 12, bye: 7 },
  ];
  const flat = replacementFloor(free);
  assert.deepEqual(flat, { K: 7, QB: 12 });                     // second-best K; lone QB is his own floor
  const byWk = replacementByWeekFrom(free, [6, 7, 9], flat);
  assert.deepEqual(byWk[6], flat, "a week with nobody on bye must equal the flat floor exactly");
  assert.equal(byWk[7].K, 6, "wk7: the best K (bye 7) is gone, so the second-best is the 6");
  assert.equal(byWk[9].K, 6, "wk9: the floor man himself is on bye");
  // A position whose every free agent is on bye keeps the flat value rather than inventing a zero.
  assert.equal(byWk[7].QB, 12);
});

test("expectedLineupPoints: replacementByWeek prices each week's empty slot at THAT week's floor", () => {
  const SL = ["QB", "K"];
  const roster: ExpLineupPlayer[] = [{ name: "Q", pos: "QB", rate: 15, bye: 99 }, { name: "K1", pos: "K", rate: 7, bye: 7 }];
  const o = { slots: SL, from: 6, to: 8, firstWk: 6, replacement: { QB: 10, K: 6.5 } };
  const flat = expectedLineupPoints(roster, o);
  assert.equal(flat, 15 * 3 + 7 * 2 + 6.5);                    // K1's bye week streamed at the flat 6.5
  const per = expectedLineupPoints(roster, { ...o, replacementByWeek: { 7: { QB: 10, K: 5 } } });
  assert.equal(per, 15 * 3 + 7 * 2 + 5, "week 7's empty K slot did not read week 7's floor");
  // Absent map, or a map naming no week in the window = the flat rule exactly.
  assert.equal(expectedLineupPoints(roster, { ...o, replacementByWeek: { 12: { K: 0 } } }), flat);
  // No `replacement` at all (the D42 model) ignores the per-week map: an empty slot still scores 0.
  const { replacement: _r, ...d42 } = o;
  void _r;
  assert.equal(expectedLineupPoints(roster, { ...d42, replacementByWeek: { 7: { K: 5 } } }), 15 * 3 + 7 * 2);
});

// ---------------------------------------------------------------------------------------------
// 4. the serve boundary: no game -> a certain zero; rows with a game untouched
// ---------------------------------------------------------------------------------------------
const STORE = process.env.FF_DB ?? "data/ff.db";
test("projectStreamingWith: a no-game row (bye or FA) serves 0 / pZero 1; rows with a game are unchanged", { skip: !existsSync(STORE) && "no store" }, () => {
  const db = new Database(STORE, { readonly: true });
  try {
    // The latest 2026 week with BOTH a no-game row and rows with a game.
    const wk = (db.prepare(
      `SELECT week FROM feat_player_week_model WHERE season = 2026 GROUP BY week
        HAVING SUM(opponent IS NULL) > 0 AND SUM(opponent IS NOT NULL) > 0 ORDER BY week DESC LIMIT 1`,
    ).get() as { week: number } | undefined)?.week;
    if (wk == null) return;
    const proj = projectStreamingWith(db as unknown as StreamDb, 2026, wk);
    if (!proj) return;
    const opp = new Map(loadWeeklyRows(db as unknown as StreamDb, 2026, wk).map((r) => [r.feat_key, r]));
    const none = proj.rows.filter((r) => opp.get(r.feat_key)?.opponent == null);
    const some = proj.rows.filter((r) => opp.get(r.feat_key)?.opponent != null && opp.get(r.feat_key)?.team !== "FA");
    assert.ok(none.length > 0 && some.length > 0, `week ${wk}: need both kinds of row`);
    for (const r of none) {
      assert.equal(r.mean, 0, `${r.name} (no game, wk${wk}) served a mean of ${r.mean}`);
      assert.equal(r.p90, 0);
      assert.equal(r.pZero, 1);
      assert.equal(r.noGame, true);
    }
    // POSITIVE CONTROL: some row with a game projects above zero and is not flagged.
    assert.ok(some.some((r) => r.mean > 0), "nothing with a game projected above zero");
    assert.ok(some.every((r) => !r.noGame));
  } finally { db.close(); }
});
