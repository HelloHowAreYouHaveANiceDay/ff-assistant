// THE LEAKAGE GUARD FOR THE STREAMING BLOCK, built the same way and for the same reason as
// test/weekly-leakage.test.ts: a weekly model that can see one hour past the first kickoff looks
// superb and is worth nothing, and the failure is silent.
//
// What is different here is WHAT gets perturbed. The weekly guard perturbs a player's own points and
// checks his own to-date columns. These twelve columns are about the OPPONENT and about the STADIUM,
// so the perturbation has to reach the opponent's box score -- and the most attractive leak available
// in this table is not a player's own week, it is "what that defence allowed", computed for season Y
// instead of for weeks before w.
//
// FOUR CONTROLS, because a guard that can only ever return "clean" is dead code that reads exactly
// like a guard that is passing:
//
//   1. THE COLUMNS ARE CONNECTED. Every one of the twelve must be non-constant across the fixture
//      before "it did not move" is a statement about anything. This is the control that catches a
//      join keyed on the wrong column, which is how the availability block was found silently NULL.
//   2. POSITIVE CONTROL ON THE PERTURBATION. Week w+1 must move. If it does not, the perturbation
//      never reached the builder.
//   3. POSITIVE CONTROL ON THE DETECTOR. With `leakOpponentThroughWeek` every window includes week w
//      -- the real leak in its natural habitat, a `<=` where a `<` belongs -- and the guard must fire.
//   4. THE COMPLEMENT. Changing a PRE-KICKOFF input (the published total line) MUST move
//      `opp_implied_total` in week w, because that information is knowable on the Saturday. A table
//      where nothing ever moves would pass control 2 and fail this one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { buildInto, type ScheduleInfo } from "../src/weekly/features.js";
import {
  buildStreamInto, STREAM_FIELD_NAMES, type TeamWeekRow,
} from "../src/weekly/streamingFeatures.js";

const SEASON = 2099;
const WEEKS = 8;
const TEAMS = ["AAA", "BBB", "CCC", "DDD"];

function opponentOf(team: string, week: number): { opp: string; home: number } {
  const i = TEAMS.indexOf(team);
  const j = (i + 1 + ((week - 1) % 3)) % TEAMS.length;
  const opp = TEAMS[j === i ? (i + 1) % TEAMS.length : j];
  return { opp, home: i < TEAMS.indexOf(opp) ? 1 : 0 };
}

function fixtureSchedule(): ScheduleInfo {
  const weekAsOf = new Map<string, string>();
  const teamGameDay = new Map<string, string>();
  const teamGames = new Map<string, number>();
  for (const yr of [SEASON - 1, SEASON]) {
    for (let w = 1; w <= WEEKS; w++) {
      const day = `${yr}-09-${String(w + 1).padStart(2, "0")}`;
      weekAsOf.set(`${yr}|${w}`, `${yr}-09-${String(w).padStart(2, "0")}`);
      for (const t of TEAMS) {
        teamGameDay.set(`${yr}|${t}|${w}`, day);
        teamGames.set(`${yr}|${t}`, (teamGames.get(`${yr}|${t}`) ?? 0) + 1);
      }
    }
  }
  return { weekAsOf, teamGameDay, teamGames };
}

const pointsFor = (p: number, w: number) => Math.round(((p * 7 + w * 13) % 29) * 10) / 10;

function seed(db: DB): void {
  const ins = db.prepare(
    `INSERT INTO feat_player_week (feat_key, player_sk, season, week, as_of, name, pos, team,
        opponent, home, spread_line, total_line, implied_team_total, is_bye, td_games, td_fd, td_ts,
        td_attempts, td_rush_yards, td_pts, pts, updated_at)
      VALUES (@k,@sk,@s,@w,@a,@n,@p,@t,@o,@h,@sp,@tl,@it,0,@tg,@tf,@tt,@ta,@tr,@tp,@pts,'x')`,
  );
  // Six positions, not four: K and DST are the whole point of this track and a fixture without them
  // would exercise none of the columns they are the reason for.
  const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
  db.transaction(() => {
    for (const yr of [SEASON - 1, SEASON]) {
      for (let p = 0; p < 24; p++) {
        const team = TEAMS[p % TEAMS.length];
        const pos = POS[p % POS.length];
        let g = 0, sum = 0;
        for (let w = 1; w <= WEEKS; w++) {
          const { opp, home } = opponentOf(team, w);
          const pts = pointsFor(p + (yr === SEASON ? 0 : 100), w);
          ins.run({
            k: `P${p}`, sk: p + 1, s: yr, w, a: `${yr}-09-${String(w).padStart(2, "0")}`,
            n: `Player ${p}`, p: pos, t: team, o: opp, h: home,
            sp: (p % 7) - 3, tl: 44 + (w % 5) + (p % 3), it: 22 + (w % 3),
            tg: g, tf: g ? 1.5 : null, tt: g ? 0.2 : null, ta: g ? 30 : null, tr: g ? 12 : null,
            tp: g ? sum / g : null,
            pts,
          });
          g++; sum += pts;
        }
      }
    }
  })();
}

/** raw_nfl_game, so `roof_dome` is joined to something. Two teams play under a roof and two do not,
 *  which is what makes "roof_dome did not move" a statement about a live column. */
function seedGames(db: DB): void {
  const ins = db.prepare(
    `INSERT INTO raw_nfl_game (season, game_id, game_type, week, gameday, home_team, away_team, roof, fetched_at)
      VALUES (@s,@id,'REG',@w,@d,@h,@a,@roof,'x')`,
  );
  db.transaction(() => {
    for (const yr of [SEASON - 1, SEASON]) {
      for (let w = 1; w <= WEEKS; w++) {
        for (const t of TEAMS) {
          const { opp, home } = opponentOf(t, w);
          if (!home) continue;
          ins.run({
            s: yr, id: `${yr}-${w}-${t}`, w, d: `${yr}-09-${String(w + 1).padStart(2, "0")}`,
            // Varies with the WEEK as well as the team. Keyed on the team alone, the round-robin
            // puts both of week 5's home teams under a roof and the column is constant in exactly
            // the week the guard snapshots -- which control 1 caught, and which would have made
            // "roof_dome did not move" a statement about nothing.
            h: t, a: opp, roof: (TEAMS.indexOf(t) + w) % 2 === 0 ? "dome" : "outdoors",
          });
        }
      }
    }
  })();
}

/** A hermetic team-week feed. Every quantity varies with (team, week) so a column wired to the wrong
 *  one of them shows up as a moved value rather than as a coincidence. */
function teamWeekFixture(bump = 0, bumpWeek = -1): TeamWeekRow[] {
  const rows: TeamWeekRow[] = [];
  for (const yr of [SEASON - 1, SEASON]) {
    for (let w = 1; w <= WEEKS; w++) {
      for (const t of TEAMS) {
        const i = TEAMS.indexOf(t);
        const b = yr === SEASON && w === bumpWeek ? bump : 0;
        rows.push({
          season: yr, week: w, team: t, opponent: opponentOf(t, w).opp,
          // Each quantity is TEAM-SEPARABLE by construction -- a term linear in the team index, not
          // a modulus of it -- so no two teams can share a season mean by coincidence. A fixture
          // whose columns collide is a fixture in which "it did not move" is true for the wrong
          // reason, and control 1 below is what turned that up.
          passYards: 200 + i * 17 + w * 3 + b * 10,
          rushYards: 90 + i * 11 + w * 2 + b * 10,
          sacksSuffered: 1 + i + (w % 3) + b,
          giveaways: 1 + i * 2 + (w % 2) + b,
          defSacks: 2 + i * 3 + (w % 4) + b,
          defTakeaways: 1 + i + (w % 3) + b,
          fgAtt: 1 + i * 2 + (w % 2) + b,
          patAtt: 2 + i + (w % 4) + b,
        });
      }
    }
  }
  return rows;
}

interface Snap { [col: string]: number | string | null }
function snapshot(db: DB, week: number): Map<string, Snap> {
  const rows = db.prepare(
    `SELECT feat_key, ${STREAM_FIELD_NAMES.join(", ")} FROM feat_player_week_stream
      WHERE season = ? AND week = ?`,
  ).all(SEASON, week) as (Snap & { feat_key: string })[];
  return new Map(rows.map((r) => [r.feat_key, r]));
}

function movedColumns(a: Map<string, Snap>, b: Map<string, Snap>): string[] {
  const moved = new Set<string>();
  for (const [k, ra] of a) {
    const rb = b.get(k);
    if (!rb) { moved.add("(row disappeared)"); continue; }
    for (const c of Object.keys(ra)) {
      if (c === "feat_key") continue;
      if (String(ra[c]) !== String(rb[c])) moved.add(c);
    }
  }
  return [...moved].sort();
}

async function build(db: DB, tw: TeamWeekRow[], leak = false): Promise<void> {
  await buildInto(db, {
    seasons: [SEASON], currentSeason: SEASON + 1, sched: fixtureSchedule(), noSeasonLine: true,
  });
  await buildStreamInto(db, { seasons: [SEASON], teamWeek: tw, leakOpponentThroughWeek: leak });
}

const W = 5;

test("streaming features for week w do not move when week w's own results change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-stream-leak-"));
  const db = openDb(join(dir, "leak.db"));
  try {
    seed(db); seedGames(db);
    await build(db, teamWeekFixture());
    const before = snapshot(db, W);
    const laterBefore = snapshot(db, W + 1);
    assert.ok(before.size >= 20, `fixture produced ${before.size} rows for week ${W}`);

    // (1) EVERY COLUMN IS CONNECTED. A column that is NULL or constant everywhere would satisfy
    // "it did not move" without being wired to anything at all.
    for (const c of STREAM_FIELD_NAMES) {
      const vals = new Set([...before.values()].map((r) => String(r[c])));
      assert.ok(!vals.has("null"),
        `${c} is NULL somewhere in the fixture -- 'it did not move' would be partly a statement ` +
        "about a column that is not joined to anything");
      // `opp_pa_pos_n` is deliberately exempt from the WITHIN-WEEK part: it is the count of
      // team-games the opponent has played, which inside one week is w-1 for every team by
      // construction. Demanding variation there would be demanding a bug. It is checked for
      // variation ACROSS the season instead, below, which is the axis it can actually vary on.
      if (c !== "opp_pa_pos_n") {
        assert.ok(vals.size > 1,
          `${c} is CONSTANT across week ${W} of the fixture -- a column that can only take one ` +
          "value cannot be shown to have not moved, because it could not move under any input");
      }
    }
    const nVals = new Set((db.prepare(
      "SELECT DISTINCT opp_pa_pos_n AS v FROM feat_player_week_stream WHERE season = ?",
    ).all(SEASON) as { v: number }[]).map((r) => r.v));
    assert.ok(nVals.size > 1, "opp_pa_pos_n takes one value across the whole season -- it is not connected");

    // THE PERTURBATION, on both sources at once: week W's fantasy results (which feed opp_pa_pos)
    // and week W's team box scores (which feed the other eight accumulators).
    db.prepare("UPDATE feat_player_week SET pts = pts + 40 WHERE season = ? AND week = ?").run(SEASON, W);
    await build(db, teamWeekFixture(50, W));
    const after = snapshot(db, W);
    const laterAfter = snapshot(db, W + 1);

    // (2) POSITIVE CONTROL ON THE PERTURBATION: week W+1 must move, because week W is prior
    // information to it. A perturbation that reaches nothing passes forever.
    const later = movedColumns(laterBefore, laterAfter);
    assert.ok(later.includes("opp_pa_pos"),
      `week ${W + 1}'s opp_pa_pos did not move under a change to week ${W}'s results -- the ` +
      `perturbation is not connected. Moved: ${later.join(", ") || "(none)"}`);
    assert.ok(later.includes("opp_def_sacks_pg") && later.includes("team_fga_pg"),
      `week ${W + 1}'s team-feed columns did not move under a change to week ${W}'s box scores. ` +
      `Moved: ${later.join(", ") || "(none)"}`);

    // THE ACTUAL ASSERTION.
    const moved = movedColumns(before, after);
    assert.deepEqual(moved, [],
      `week ${W} streaming features moved when week ${W}'s own results changed -- that is lookahead: ${moved.join(", ")}`);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("POSITIVE CONTROL: a change to the PUBLISHED LINE does move week w's opp_implied_total", async () => {
  // The complement, and the half that makes the test above mean something. A change to week w's
  // RESULTS must not reach week w (that is lookahead); a change to the line POSTED BEFORE KICKOFF
  // must, because it is knowable on the Saturday and is the reason the column exists.
  const dir = mkdtempSync(join(tmpdir(), "ff-stream-line-"));
  const db = openDb(join(dir, "line.db"));
  try {
    seed(db); seedGames(db);
    await build(db, teamWeekFixture());
    const before = snapshot(db, W);
    const otherBefore = snapshot(db, W + 1);
    db.prepare("UPDATE feat_player_week SET total_line = total_line + 9 WHERE season = ? AND week = ?").run(SEASON, W);
    await build(db, teamWeekFixture());
    const moved = movedColumns(before, snapshot(db, W));
    assert.ok(moved.includes("opp_implied_total"),
      `opp_implied_total did not move when week ${W}'s posted total changed -- the column is dead ` +
      `code and every 'it did not leak' verdict about it is vacuous. Moved: ${moved.join(", ") || "(none)"}`);
    const spill = movedColumns(otherBefore, snapshot(db, W + 1));
    assert.deepEqual(spill, [], `changing week ${W}'s line moved week ${W + 1}: ${spill.join(", ")}`);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FAULT INJECTION: a window that includes week w makes the guard fire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-stream-fi-"));
  const db = openDb(join(dir, "fi.db"));
  try {
    seed(db); seedGames(db);
    await build(db, teamWeekFixture(), false);
    const honest = snapshot(db, W);
    await build(db, teamWeekFixture(), true);
    const leaked = snapshot(db, W);
    const moved = movedColumns(honest, leaked);
    // EVERY accumulated column must move, not just one. A detector that fires on opp_pa_pos alone
    // would leave the other eight accumulators untested by the only control that can test them.
    for (const c of ["opp_pa_pos", "opp_pa_pos_n", "opp_def_sacks_pg", "opp_def_takeaways_pg",
      "opp_pass_yds_allowed_pg", "opp_rush_yds_allowed_pg", "opp_off_sacks_allowed_pg",
      "opp_off_giveaways_pg", "team_fga_pg", "team_pat_pg"]) {
      assert.ok(moved.includes(c),
        `moving the window to include week w changed nothing for ${c} -- the detector cannot see ` +
        `the leak it exists to catch. Moved: ${moved.join(", ") || "(none)"}`);
    }

    // And the perturbation test above must FAIL against the leaked build. Prove it rather than
    // assert it: perturb week W and check the leaked columns move.
    db.prepare("UPDATE feat_player_week SET pts = pts + 40 WHERE season = ? AND week = ?").run(SEASON, W);
    await build(db, teamWeekFixture(50, W), true);
    assert.ok(movedColumns(leaked, snapshot(db, W)).includes("opp_pa_pos"),
      "with the leak on, week w's opp_pa_pos should move when week w's results change -- it did " +
      "not, so the fault injection is not injecting the fault this guard is for");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("opp_pa_pos_n never reaches the week being predicted", async () => {
  // The defence-side version of the same claim, asserted on the stored column rather than inferred
  // from the builder: the count of team-games behind an opponent's record must be at most w-1.
  const dir = mkdtempSync(join(tmpdir(), "ff-stream-n-"));
  const db = openDb(join(dir, "n.db"));
  try {
    seed(db); seedGames(db);
    await build(db, teamWeekFixture());
    const bad = db.prepare(
      "SELECT COUNT(*) c FROM feat_player_week_stream WHERE season = ? AND opp_pa_pos_n > week - 1",
    ).get(SEASON) as { c: number };
    assert.equal(bad.c, 0, `${bad.c} rows carry opp_pa_pos_n greater than week-1`);
    // ... and the same count under the fault injection must be NON-zero, or the assertion above is
    // not sensitive to the thing it is asserting.
    await build(db, teamWeekFixture(), true);
    const leaked = db.prepare(
      "SELECT COUNT(*) c FROM feat_player_week_stream WHERE season = ? AND opp_pa_pos_n > week - 1",
    ).get(SEASON) as { c: number };
    assert.ok(leaked.c > 0,
      "with the leaked window on, opp_pa_pos_n should exceed week-1 somewhere -- it did not, so the " +
      "clean count above is not measuring the bound it claims to");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
