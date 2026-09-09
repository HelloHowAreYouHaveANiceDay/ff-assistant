// THE LEAKAGE GUARD, and it is the first thing the weekly track built.
//
// A weekly model that can see one hour past the first kickoff looks superb and is worth nothing, and
// the failure is silent: there is no error, no NaN, no coverage hole -- just a very good RMSE. So
// this test does not read the builder's comments and believe them. It PERTURBS week w's own source
// data -- the player's actual points, and the points every player scored against week w's opponent
// -- rebuilds, and asserts that not one feature of week w moved.
//
// It is fault-injected THREE ways, because a guard that only ever returns "clean" is dead code that
// reads exactly like a guard that is passing:
//
//   1. POSITIVE CONTROL ON THE PERTURBATION. Weeks AFTER w must change. If they do not, the
//      perturbation never reached the builder and the "week w did not move" assertion is measuring
//      nothing. This is the one that catches a fixture wired to the wrong key.
//   2. POSITIVE CONTROL ON THE DETECTOR. With `leakDvpThroughWeek` the DvP window is moved to
//      include week w, which is the real leak in its natural habitat -- a `<=` where a `<` belongs.
//      The guard must fire.
//   3. POSITIVE CONTROL ON THE TARGET. `pts` is the target, not a feature, and it MUST move under
//      the perturbation -- otherwise the fixture's own player is not the one being perturbed.
//
// The fixture is synthetic and hermetic: its own SQLite file, its own schedule, no network. That is
// deliberate. Running this against the real store would make it slow, and worse, it would make a
// failure ambiguous between "the builder leaks" and "the store changed".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { buildInto, type ScheduleInfo } from "../src/weekly/features.js";

const SEASON = 2099;
const WEEKS = 8;
const TEAMS = ["AAA", "BBB", "CCC", "DDD"];
/** Two-team-per-game round robin: (w + i) pairing, so every team plays every week. */
function opponentOf(team: string, week: number): { opp: string; home: number } {
  const i = TEAMS.indexOf(team);
  const j = (i + 1 + ((week - 1) % 3)) % TEAMS.length;
  const opp = TEAMS[j === i ? (i + 1) % TEAMS.length : j];
  return { opp, home: i < TEAMS.indexOf(opp) ? 1 : 0 };
}

/** A hermetic schedule: week w is played on day w, every team, both seasons. */
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

/** Deterministic pseudo-points, so a rebuild without a perturbation is byte-identical. */
const pointsFor = (p: number, w: number) => Math.round(((p * 7 + w * 13) % 29) * 10) / 10;

function seed(db: DB): void {
  const ins = db.prepare(
    `INSERT INTO feat_player_week (feat_key, player_sk, season, week, as_of, name, pos, team,
        opponent, home, spread_line, total_line, implied_team_total, is_bye, td_games, td_fd, td_ts,
        td_attempts, td_rush_yards, td_pts, pts, updated_at)
      VALUES (@k,@sk,@s,@w,@a,@n,@p,@t,@o,@h,@sp,@tl,@it,0,@tg,@tf,@tt,@ta,@tr,@tp,@pts,'x')`,
  );
  const POS = ["QB", "RB", "WR", "TE"];
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
            // feat_key is a string key; player_sk is the NUMERIC surrogate key, and they are
            // deliberately different values here. The availability block joins on player_sk, and a
            // fixture that used one string for both would have made a join that cannot parse a
            // surrogate key look like a join that works.
            k: `P${p}`, sk: p + 1, s: yr, w, a: `${yr}-09-${String(w).padStart(2, "0")}`,
            n: `Player ${p}`, p: pos, t: team, o: opp, h: home,
            sp: (p % 7) - 3, tl: 44 + (w % 5), it: 22 + (w % 3),
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

/**
 * THE AVAILABILITY BLOCK'S SOURCE ROWS, seeded into the fixture.
 *
 * Without these the ten Phase-2d columns are NULL in every row of the fixture, and "they did not
 * move under the perturbation" would be true of a column that is not connected to anything at all --
 * exactly the shape of null this repo has been burned by. Every player carries a distinct injury and
 * usage state so a join that silently matched the wrong row would show up as a moved column.
 */
function seedContext(db: DB): void {
  const ins = db.prepare(
    `INSERT INTO feat_player_week_context (player_sk, season, week, as_of, team, pos,
        prior_snap_share, prior_route_share, depth_rank, teammates_out,
        report_status_fri, practice_status_fri, updated_at)
      VALUES (@sk,@s,@w,@a,@t,@p,@snap,@route,@depth,@out,@rs,@ps,'x')`,
  );
  const STATUS = [null, "Out", "Questionable", "Doubtful"];
  const PRACTICE = [null, "Did Not Participate In Practice", "Limited Participation in Practice", "Full Participation in Practice"];
  db.transaction(() => {
    for (let p = 0; p < 24; p++) {
      for (let w = 1; w <= WEEKS; w++) {
        ins.run({
          sk: p + 1, s: SEASON, w, a: `${SEASON}-09-${String(w).padStart(2, "0")}`,
          t: TEAMS[p % TEAMS.length], p: ["QB", "RB", "WR", "TE"][p % 4],
          snap: ((p * 7 + w * 3) % 100) / 100, route: ((p * 11 + w * 5) % 100) / 100,
          depth: 1 + ((p + w) % 3), out: (p + w) % 3,
          rs: STATUS[(p + w) % STATUS.length], ps: PRACTICE[(p * 3 + w) % PRACTICE.length],
        });
      }
    }
  })();
}

const CONTEXT_COLS = [
  "prior_snap_share", "prior_route_share", "depth_rank", "teammates_out",
  "inj_out", "inj_doubtful", "inj_questionable", "prac_dnp", "prac_limited", "inj_feed",
];

interface Snap { [col: string]: number | string | null }
function snapshot(db: DB, week: number): Map<string, Snap> {
  const rows = db.prepare(
    `SELECT feat_key, td_games, td_ppg, t4_mean, t4_sd, td_fd, td_ts, td_attempts, td_rush_yards,
            dvp_mult, dvp_n, home, spread_line, total_line, implied_team_total, days_rest, as_of, pts,
            ${CONTEXT_COLS.join(", ")}
       FROM feat_player_week_model WHERE season = ? AND week = ?`,
  ).all(SEASON, week) as (Snap & { feat_key: string })[];
  return new Map(rows.map((r) => [r.feat_key, r]));
}

/** Which columns differ between two snapshots, ignoring the named ones. */
function movedColumns(a: Map<string, Snap>, b: Map<string, Snap>, ignore: string[] = []): string[] {
  const moved = new Set<string>();
  for (const [k, ra] of a) {
    const rb = b.get(k);
    if (!rb) { moved.add("(row disappeared)"); continue; }
    for (const c of Object.keys(ra)) {
      if (c === "feat_key" || ignore.includes(c)) continue;
      if (String(ra[c]) !== String(rb[c])) moved.add(c);
    }
  }
  return [...moved].sort();
}

async function build(db: DB, leak = false) {
  await buildInto(db, {
    seasons: [SEASON], currentSeason: SEASON + 1, sched: fixtureSchedule(),
    noSeasonLine: true, leakDvpThroughWeek: leak,
  });
}

test("weekly features for week w do not move when week w's own results change", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ff-weekly-leak-"));
  const path = join(dir, "leak.db");
  const db = openDb(path);
  try {
    seed(db);
    seedContext(db);
    await build(db);
    const W = 5;
    const before = snapshot(db, W);
    // THE AVAILABILITY BLOCK IS CONNECTED. Ten columns that are NULL everywhere would satisfy
    // "nothing moved" without being wired to anything, so establish first that they carry real,
    // varying values in this fixture.
    for (const c of CONTEXT_COLS) {
      const vals = new Set([...before.values()].map((r) => String(r[c])));
      assert.ok(!vals.has("null") || vals.size > 1,
        `${c} is NULL in every row of the fixture -- 'it did not move' would be a statement about a ` +
        "column that is not joined to anything");
    }
    assert.ok(new Set([...before.values()].map((r) => String(r.inj_out))).size > 1,
      "inj_out is constant across the fixture -- the injury join is not reaching these rows");
    const afterBefore = snapshot(db, W + 1);
    assert.ok(before.size >= 20, `fixture produced ${before.size} rows for week ${W}`);

    // THE PERTURBATION. Week W only: every player's actual points are moved by a large, arbitrary
    // amount. That changes (a) the target for week W, (b) what every week-W opponent allowed, and
    // (c) everything a LATER week's to-date and trailing columns are built from.
    db.prepare("UPDATE feat_player_week SET pts = pts + 40 WHERE season = ? AND week = ?").run(SEASON, W);
    // feat_player_week's own to-date columns are owned by src/features/build.ts and are not rebuilt
    // here; recompute the ones downstream of the perturbation so the fixture stays self-consistent
    // and the later-week control is real rather than an artefact of a stale column.
    for (const r of db.prepare("SELECT DISTINCT feat_key FROM feat_player_week WHERE season = ?").all(SEASON) as { feat_key: string }[]) {
      let g = 0, sum = 0;
      for (let w = 1; w <= WEEKS; w++) {
        db.prepare("UPDATE feat_player_week SET td_games = ?, td_pts = ? WHERE season = ? AND week = ? AND feat_key = ?")
          .run(g, g ? sum / g : null, SEASON, w, r.feat_key);
        const p = db.prepare("SELECT pts FROM feat_player_week WHERE season = ? AND week = ? AND feat_key = ?")
          .get(SEASON, w, r.feat_key) as { pts: number | null } | undefined;
        if (p?.pts != null) { g++; sum += p.pts; }
      }
    }
    await build(db);
    const after = snapshot(db, W);
    const afterAfter = snapshot(db, W + 1);

    // (3) POSITIVE CONTROL ON THE TARGET: `pts` is not a feature and MUST have moved. If it did not,
    // the perturbation missed this fixture's rows entirely and nothing below means anything.
    assert.deepEqual(movedColumns(before, after).includes("pts"), true,
      "the target did not move under the perturbation -- the fixture is not wired to the rows being perturbed");

    // (1) POSITIVE CONTROL ON THE PERTURBATION: a LATER week must move, because week W is prior
    // information to week W+1. A guard whose perturbation reaches nothing passes forever.
    const later = movedColumns(afterBefore, afterAfter);
    assert.ok(later.length > 0,
      `week ${W + 1} did not move under a change to week ${W} -- the perturbation is not connected, ` +
      "so 'week W did not move' is measuring nothing");
    assert.ok(later.includes("td_ppg") || later.includes("t4_mean"),
      `expected the to-date / trailing columns to move in week ${W + 1}, moved: ${later.join(", ") || "(none)"}`);

    // THE ACTUAL ASSERTION. Every FEATURE of week W is unchanged; only the target moved.
    const moved = movedColumns(before, after, ["pts"]);
    assert.deepEqual(moved, [],
      `week ${W} features moved when week ${W}'s own results changed -- that is lookahead: ${moved.join(", ")}`);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("POSITIVE CONTROL: week w's availability columns DO move when week w's CONTEXT changes", async () => {
  // The complement of the test above, and the half that makes it mean something. A change to week
  // w's own RESULTS must not reach week w's features (that is lookahead); a change to week w's own
  // INJURY REPORT must, because the report is published before his kickoff and is the whole point of
  // the block. A join that was silently dead would pass the first assertion and fail this one.
  const dir = mkdtempSync(join(tmpdir(), "ff-weekly-ctx-"));
  const db = openDb(join(dir, "ctx.db"));
  try {
    seed(db); seedContext(db);
    await build(db);
    const W = 5;
    const before = snapshot(db, W);
    const otherWeek = snapshot(db, W + 1);
    db.prepare(
      "UPDATE feat_player_week_context SET report_status_fri = 'Out', practice_status_fri = " +
      "'Did Not Participate In Practice', teammates_out = 3, depth_rank = 4, prior_snap_share = 0.01 " +
      "WHERE season = ? AND week = ?",
    ).run(SEASON, W);
    await build(db);
    const after = snapshot(db, W);
    const moved = movedColumns(before, after);
    for (const c of ["inj_out", "prac_dnp", "teammates_out", "depth_rank", "prior_snap_share"]) {
      assert.ok(moved.includes(c),
        `${c} did not move when week ${W}'s injury report changed -- the availability join is dead ` +
        `code, and every 'it did not leak' verdict about it is vacuous. Moved: ${moved.join(", ") || "(none)"}`);
    }
    // And it must be SCOPED to week w: rewriting week w's report must not touch week w+1.
    const spill = movedColumns(otherWeek, snapshot(db, W + 1));
    assert.deepEqual(spill, [],
      `changing week ${W}'s context moved week ${W + 1}: ${spill.join(", ")}`);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("FAULT INJECTION: a DvP window that includes week w makes the guard fire", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ff-weekly-leak-fi-"));
  const path = join(dir, "leak.db");
  const db = openDb(path);
  try {
    seed(db);
    seedContext(db);
    const W = 5;
    // Honest build, then the same build with the leak switched on. Nothing else differs, so any
    // difference in week W's dvp_mult IS the leak.
    await build(db, false);
    const honest = snapshot(db, W);
    await build(db, true);
    const leaked = snapshot(db, W);
    const moved = movedColumns(honest, leaked);
    assert.ok(moved.includes("dvp_mult"),
      "moving the DvP window to include week w changed nothing -- the detector cannot see the leak " +
      "it exists to catch, so its clean verdict on the honest build means nothing");

    // And the perturbation test above must FAIL against the leaked build. Prove it rather than
    // assert it: perturb week W and check the leaked dvp_mult moves.
    db.prepare("UPDATE feat_player_week SET pts = pts + 40 WHERE season = ? AND week = ?").run(SEASON, W);
    await build(db, true);
    const leakedPerturbed = snapshot(db, W);
    assert.ok(movedColumns(leaked, leakedPerturbed).includes("dvp_mult"),
      "with the leak on, week w's DvP should move when week w's results change -- it did not, so " +
      "the fault injection is not injecting the fault this guard is for");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
