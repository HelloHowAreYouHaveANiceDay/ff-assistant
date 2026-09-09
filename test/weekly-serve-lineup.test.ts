// THE LINEUP SEAM READS THE SERVE TABLE -- integration pass 4, then the 2026-09-09 owner decision
// to widen the table to all six positions.
//
// Track C shipped the streaming model at QB, K and DST. Track F made `WEEKLY_SERVE` the ONE table
// every consumer resolves through and wired the scorecard to it. `loadWeeklyProjection` -- the seam
// `lineupRecommend` is fed from -- kept loading `SHIPPED_WEEKLY_ARTIFACT` for all six positions, so
// the scorecard was recording a quarterback under the streaming model while the lineup was picking
// him under the floor. Two consumers, one table, two answers, nothing failing. Then, on the
// decision-population measurement recorded in docs/validation.md, the owner widened `WEEKLY_SERVE`
// to serve the streaming artifact at every position -- so the "RB/WR/TE stay on the floor" half of
// this file's original claim is gone, and every assertion below is read FROM THE TABLE rather than
// naming a subset of positions by hand, so it does not go stale the next time the table changes.
//
// WHAT THIS FILE ASSERTS, and why each part is here rather than implied:
//   1. every position `WEEKLY_SERVE` maps to the streaming artifact produces a projection through
//      the seam that is NOT the floor's number -- the positive control, without which "routed
//      through the table" and "still hardcoded to the floor" look identical. Today that is all six.
//   2. `lineupRecommend` -- the real consumer, not the loader -- reports a different number for the
//      fixture QB, RB, WR and TE under the two, which is the only thing that proves the seam reaches
//      a DECISION rather than stopping at the loader;
//   3. `assumptions.artifactByPos` (via `weeklyServeAssumption`) names `streaming-artifact.json` at
//      all six positions, so a report cannot claim a model was consulted that was not;
//   4. `loadWeeklyBands` -- the winprob objective's loader -- returns the SAME means, because a band
//      that came from a different read of the table than the mean it sits beside is the drift the
//      one-call design exists to prevent;
//   5. FAULT INJECTION: forcing the floor everywhere via `artifactPath` collapses (1) back to
//      equality, which is the old behaviour reproduced on demand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { dataPath } from "../src/data/paths.js";
import { loadWeeklyProjection, loadWeeklyBands, weeklyServeAssumption } from "../src/inseason/copilotStore.js";
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

test("the LINEUP seam serves EVERY position from the streaming artifact -- the 2026-09-09 owner decision", () => {
  const path = seeded();
  const served = loadWeeklyProjection(SEASON, WEEK, path);
  const floor = loadWeeklyProjection(SEASON, WEEK, path, dataPath(SHIPPED_WEEKLY_ARTIFACT));
  assert.ok(served && floor, "both projections must load -- a null here is not a passing test");

  const ctx = fixtureCtx();
  const roster = ctx.teams[ctx.meIdx].roster;

  // (1) THE POSITIVE CONTROL. A guard that can only ever report "same" is indistinguishable from a
  // seam that was never rewired, so every streaming position MUST differ. This is read FROM THE
  // TABLE (`SHIPPED_STREAMING_POSITIONS`), never as a hardcoded subset -- as of 2026-09-09 that is
  // all six positions, and asserting it by name here would go stale the next time the table changes.
  assert.deepEqual([...SHIPPED_STREAMING_POSITIONS].sort(), [...STREAM_SERVE_POS].sort(),
    "the owner decision to ship streaming at all six positions is not reflected in the table -- " +
    "this test's premise needs re-reading");
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

  // (2) NO POSITION IS LEFT ON THE FLOOR. Derived from the table, not hardcoded, so this correctly
  // becomes vacuous (and stays a real check) if the mapping is ever narrowed again.
  const floorPos = STREAM_SERVE_POS.filter((p) => WEEKLY_SERVE[p] === SHIPPED_WEEKLY_ARTIFACT);
  for (const p of roster.filter((r) => floorPos.includes(r.pos))) {
    const k = lineupNameKey(p.name);
    assert.equal(served!.get(k), floor!.get(k),
      `${p.pos} maps to the floor, so routing through the table must change nothing at ${p.pos}`);
  }

  // The result can SAY which artifact served each position, rather than leaving a reader to guess.
  const say = weeklyServeAssumption();
  assert.equal(say.table.QB, WEEKLY_SERVE.QB);
  assert.match(say.text, /WEEKLY_SERVE/);
  // Every position's assumption names the streaming artifact by file, since that is what serves it
  // under the 2026-09-09 mapping -- a report that omitted one would be claiming a model was NOT
  // consulted that in fact was.
  for (const pos of STREAM_SERVE_POS) {
    assert.equal(say.table[pos], "streaming-artifact.json",
      `${pos}'s assumption does not name the streaming artifact`);
  }
});

test("lineupRecommend for the fixture QB, RB, WR and TE differs between the floor and the SERVED artifact", () => {
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

  // ...and, under the 2026-09-09 owner decision, the running back, receiver and tight end ALSO move
  // -- the streaming artifact now serves them too, so a lineup that reported the same number for
  // them under both arms would mean the seam had not picked up the widened table at those positions.
  for (const p of ctx.teams[ctx.meIdx].roster.filter((r) => ["RB", "WR", "TE"].includes(r.pos))) {
    assert.notEqual(projOf(a, p.name), projOf(b, p.name),
      `${p.name} (${p.pos}) did not move between the floor and the served artifact -- ${p.pos} is ` +
      "supposed to be served by the streaming model now");
  }
});

test("loadWeeklyBands returns the SAME means loadWeeklyProjection does", () => {
  // `loadWeeklyBands` exists because `objective: "winprob"` needs a p10/p50/p90 and not a mean, and
  // its comment claims the means it returns ARE the other function's. Two loaders reading the same
  // table on two calls is how a mean and its own band start coming from different artifacts, so the
  // claim is asserted here rather than left to the comment.
  const path = seeded();
  const means = loadWeeklyProjection(SEASON, WEEK, path)!;
  const withBands = loadWeeklyBands(SEASON, WEEK, path)!;
  assert.ok(withBands.weekly.size > 0);
  assert.deepEqual([...withBands.weekly.entries()].sort(), [...means.entries()].sort());
  // And every mean has a band whose own mean is the same number -- a band attached to a different
  // projection than the one the lineup ranks on is the specific drift this shares one call to avoid.
  for (const [k, m] of withBands.weekly) {
    const b = withBands.bands.get(k);
    assert.ok(b, `${k} has a mean and no band`);
    assert.equal(b!.mean, m);
    assert.ok(b!.p10 <= b!.p50 && b!.p50 <= b!.p90, `${k}'s band is not ordered`);
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
