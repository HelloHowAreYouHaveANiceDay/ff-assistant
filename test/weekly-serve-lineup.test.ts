// THE LINEUP SEAM READS THE SERVE TABLE -- integration pass 4.
//
// Track C shipped the streaming model at QB, K and DST. Track F made `WEEKLY_SERVE` the ONE table
// every consumer resolves through and wired the scorecard to it. `loadWeeklyProjection` -- the seam
// `lineupRecommend` is fed from -- kept loading `SHIPPED_WEEKLY_ARTIFACT` for all six positions, so
// the scorecard was recording a quarterback under the streaming model while the lineup was picking
// him under the floor. Two consumers, one table, two answers, nothing failing.
//
// WHAT THIS FILE ASSERTS, and why each part is here rather than implied:
//   1. a QB/K/DST projection through the seam is NOT the floor's number -- the positive control,
//      without which "routed through the table" and "still hardcoded to the floor" look identical;
//   2. RB, WR and TE are UNCHANGED to the last bit, because the table maps them to the floor and a
//      change there would mean the routing had picked up a model no gate passed;
//   3. `lineupRecommend` -- the real consumer, not the loader -- reports a different number for the
//      fixture QB under the two, which is the only thing that proves the seam reaches a DECISION;
//   4. FAULT INJECTION: forcing the floor everywhere via `artifactPath` collapses (1) back to
//      equality, which is the old behaviour reproduced on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { dataPath } from "../src/data/paths.js";
import { loadWeeklyProjection, weeklyServeAssumption } from "../src/inseason/copilotStore.js";
import { lineupRecommend, lineupNameKey, NFL_WEEKS } from "../src/inseason/copilot.js";
import { WEEKLY_SERVE, SHIPPED_STREAMING_POSITIONS, STREAM_SERVE_POS } from "../src/weekly/streamingServe.js";
import { SHIPPED_WEEKLY_ARTIFACT } from "../src/weekly/projector.js";
import { ensurePopulationColumn } from "../src/weekly/population.js";
import { fixtureCtx } from "./fixtures/copilot-league.js";

const SEASON = 2093;
const WEEK = 3;   // no fixture bye falls here, so availability cannot explain a difference

/** Feature rows for the FIXTURE's own roster, so the map this produces keys onto real roster names
 *  and `lineupRecommend` can be handed it directly. Season line per game = proj / 17, which is what
 *  the floor artifact reproduces exactly. */
function seeded(): string {
  const ctx = fixtureCtx();
  const dir = mkdtempSync(join(tmpdir(), "ff-serve-lineup-"));
  const path = join(dir, "ff.db");
  const db: DB = openDb(path);
  // `in_population` is added by ALTER, not by schema.sql -- see the note at the tail of schema.sql.
  ensurePopulationColumn(db);
  const ins = db.prepare(
    `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos, team,
        opponent, home, is_bye, season_line_pg, td_games, td_ppg, t4_mean, dvp_mult, pts, in_population, updated_at)
      VALUES (@k,@k,@s,@w,@a,@n,@p,@t,@o,1,0,@line,3,@ppg,@ppg,1.0,NULL,1,'x')`,
  );
  const insS = db.prepare(
    `INSERT INTO feat_player_week_stream (feat_key, player_sk, season, week, as_of, pos, team, opponent,
        opp_pa_pos, opp_pa_pos_n, opp_def_sacks_pg, opp_def_takeaways_pg, opp_pass_yds_allowed_pg,
        opp_rush_yds_allowed_pg, opp_off_sacks_allowed_pg, opp_off_giveaways_pg, opp_implied_total,
        roof_dome, team_fga_pg, team_pat_pg, updated_at)
      VALUES (@k,@k,@s,@w,@a,@p,@t,@o,@pa,8,2.1,1.4,230,115,2.0,1.3,23.5,0,2.1,2.6,'x')`,
  );
  db.transaction(() => {
    ctx.teams[ctx.meIdx].roster.forEach((p, i) => {
      const row = {
        k: lineupNameKey(p.name), s: SEASON, w: WEEK, a: `${SEASON}-09-20`,
        n: p.name, p: p.pos, t: "AAA", o: "BBB",
        line: p.proj / NFL_WEEKS, ppg: p.proj / NFL_WEEKS, pa: 12 + i,
      };
      ins.run(row);
      insS.run(row);
    });
  })();
  db.close();
  return path;
}

test("the LINEUP seam serves QB/K/DST from the streaming artifact and RB/WR/TE from the floor", () => {
  const path = seeded();
  const served = loadWeeklyProjection(SEASON, WEEK, path);
  const floor = loadWeeklyProjection(SEASON, WEEK, path, dataPath(SHIPPED_WEEKLY_ARTIFACT));
  assert.ok(served && floor, "both projections must load -- a null here is not a passing test");

  const ctx = fixtureCtx();
  const roster = ctx.teams[ctx.meIdx].roster;

  // (1) THE POSITIVE CONTROL. A guard that can only ever report "same" is indistinguishable from a
  // seam that was never rewired, so every streaming position MUST differ.
  for (const pos of SHIPPED_STREAMING_POSITIONS) {
    const p = roster.find((r) => r.pos === pos);
    assert.ok(p, `the fixture roster has no ${pos}`);
    const k = lineupNameKey(p!.name);
    const a = served!.get(k), b = floor!.get(k);
    assert.ok(a != null && b != null, `${p!.name} missing from a projection`);
    assert.ok(Math.abs(a! - b!) > 1e-6,
      `${pos} is mapped to ${WEEKLY_SERVE[pos]} but the seam produced the floor's number ` +
      `(${a!.toFixed(4)} vs ${b!.toFixed(4)}) -- the routing is not connected`);
  }

  // (2) AND THE POSITIONS THE TABLE MAPS TO THE FLOOR MUST NOT MOVE AT ALL.
  const floorPos = STREAM_SERVE_POS.filter((p) => WEEKLY_SERVE[p] === SHIPPED_WEEKLY_ARTIFACT);
  assert.deepEqual(floorPos, ["RB", "WR", "TE"], "the table moved -- this test's claim needs re-reading");
  for (const p of roster.filter((r) => floorPos.includes(r.pos))) {
    const k = lineupNameKey(p.name);
    assert.equal(served!.get(k), floor!.get(k),
      `${p.pos} maps to the floor, so routing through the table must change nothing at ${p.pos}`);
  }

  // The result can SAY which artifact served each position, rather than leaving a reader to guess.
  const say = weeklyServeAssumption();
  assert.equal(say.table.QB, WEEKLY_SERVE.QB);
  assert.match(say.text, /WEEKLY_SERVE/);
});

test("lineupRecommend for the fixture QB differs between the floor and the SERVED artifact", () => {
  const path = seeded();
  const ctx = fixtureCtx();
  const served = loadWeeklyProjection(SEASON, WEEK, path)!;
  const floor = loadWeeklyProjection(SEASON, WEEK, path, dataPath(SHIPPED_WEEKLY_ARTIFACT))!;

  const a = lineupRecommend(ctx, WEEK, { weekly: served });
  const b = lineupRecommend(ctx, WEEK, { weekly: floor });

  const qb = ctx.teams[ctx.meIdx].roster.find((p) => p.pos === "QB")!;
  const projOf = (r: typeof a, name: string) =>
    [...r.starters, ...r.bench].find((s) => s.name === name)?.proj;
  assert.ok(projOf(a, qb.name) != null && projOf(b, qb.name) != null, "the QB is in neither result");
  assert.notEqual(projOf(a, qb.name), projOf(b, qb.name),
    "the DECISION layer produced the same QB number under two different artifacts -- the seam does " +
    "not reach lineupRecommend");
  assert.notEqual(a.totalProj, b.totalProj, "the recommended lineup's total did not move at all");

  // ...and the running backs, receivers and tight ends are untouched, so the move is the table's and
  // not a wholesale change of model.
  for (const p of ctx.teams[ctx.meIdx].roster.filter((r) => ["RB", "WR", "TE"].includes(r.pos))) {
    assert.equal(projOf(a, p.name), projOf(b, p.name), `${p.name} moved, and nothing should have`);
  }
});

test("FAULT INJECTION: forcing one artifact everywhere reproduces the OLD behaviour exactly", () => {
  const path = seeded();
  const ctx = fixtureCtx();
  const roster = ctx.teams[ctx.meIdx].roster;
  const forced = loadWeeklyProjection(SEASON, WEEK, path, dataPath(SHIPPED_WEEKLY_ARTIFACT))!;
  const floor = loadWeeklyProjection(SEASON, WEEK, path, dataPath(SHIPPED_WEEKLY_ARTIFACT))!;
  // Every position equal, INCLUDING the streaming ones -- which is what the seam did before this
  // change, and is the arm that proves the difference above comes from the table and not from noise.
  for (const p of roster) assert.equal(forced.get(lineupNameKey(p.name)), floor.get(lineupNameKey(p.name)));

  const served = loadWeeklyProjection(SEASON, WEEK, path)!;
  const qb = roster.find((p) => p.pos === "QB")!;
  assert.notEqual(served.get(lineupNameKey(qb.name)), forced.get(lineupNameKey(qb.name)),
    "with the override off the QB must come back to the streaming number");
});
