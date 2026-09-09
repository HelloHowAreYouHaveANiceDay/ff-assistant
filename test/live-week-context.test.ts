/**
 * THE LIVE SEASON IS NOT BLIND.
 *
 * `feat_player_week_context` holds nothing for 2026: it is built from `raw_injury`, whose filings
 * stopped carrying a report date in 2025 and which holds no rows at all for a season nobody has
 * archived yet. The two-part weekly model's first stage is availability -- its largest coefficients
 * by a wide margin are `inj_out` (+3.4 to +5.2 in logit) and `inj_doubtful` -- so without those rows
 * it serves the live season on its DECLARED DEFAULTS, which say every man is healthy. That is a
 * model that knows about injuries answering as if it did not, in the one month it matters, and
 * nothing about the output would look wrong.
 *
 * `buildLiveWeekContext` fills them from the two feeds the copilot's OUT refusal already reads.
 * Three properties, and the third is the one that can silently be wrong:
 *
 *   1. IT WRITES SOMETHING REAL. A designated player gets a row whose `report_status_fri` says so,
 *      and `contextFor` -- the function the weekly features actually call -- turns it into
 *      `inj_out = 1`. Asserting the row exists proves nothing about whether the model can see it.
 *   2. NEWS ESCALATES, and only escalates.
 *   3. THE POINT-IN-TIME RULE HOLDS. A snapshot taken after a week's first kickoff belongs to the
 *      NEXT week, because today's designations are contaminated by games already played. It is
 *      fault-injected in both directions: before kickoff the target must be THIS week, at or after
 *      it the target must move on and nothing may be written to the week that started.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db/db.js";
import { buildLiveWeekContext, espnStatusToReport } from "../src/features/sources/weekContext.js";
import { contextFor } from "../src/weekly/features.js";

const SEASON = 2096;
/** Week w's first kickoff. Week 1 on the 10th, week 2 on the 17th, week 3 on the 24th. */
const KICK = (w: number) => `${SEASON}-09-${String(3 + 7 * w).padStart(2, "0")}`;

/** sk -> (name_key, name, pos, team). Three receivers on one team so teammates_out has something
 *  to count, plus a quarterback whose status must not affect them. */
const PLAYERS = [
  { sk: 101, key: "aaron-alpha", name: "Aaron Alpha", pos: "WR", team: "AAA" },
  { sk: 102, key: "brett-bravo", name: "Brett Bravo", pos: "WR", team: "AAA" },
  { sk: 103, key: "carl-charlie", name: "Carl Charlie", pos: "WR", team: "AAA" },
  { sk: 104, key: "dave-delta", name: "Dave Delta", pos: "QB", team: "AAA" },
  { sk: 105, key: "evan-echo", name: "Evan Echo", pos: "WR", team: "BBB" },
];

function seed(db: DB): void {
  db.transaction(() => {
    for (const p of PLAYERS) {
      db.prepare("INSERT INTO player_identity (player_sk) VALUES (?)").run(p.sk);
      // player_status.player_id has a foreign key onto player.player_id, which IS the name_key.
      db.prepare("INSERT INTO player (player_id, name, position, nfl_team) VALUES (?,?,?,?)")
        .run(p.key, p.name, p.pos, p.team);
      db.prepare(
        "INSERT INTO stg_player (player_sk, name_key, name, position, team, ambiguous, source, updated_at) VALUES (?,?,?,?,?,0,'test','x')",
      ).run(p.sk, p.key, p.name, p.pos, p.team);
    }
    for (let w = 1; w <= 3; w++) {
      db.prepare(
        `INSERT INTO raw_nfl_game (game_id, season, week, game_type, home_team, away_team, gameday,
            spread_line, total_line, home_rest, away_rest, fetched_at)
         VALUES (?,?,?,'REG','AAA','BBB',?, -3.0, 45.0, 7, 7, 'x')`,
      ).run(`${SEASON}_${w}_AAA_BBB`, SEASON, w, KICK(w));
      for (const p of PLAYERS) {
        db.prepare(
          `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, as_of, name, pos,
              team, opponent, home, is_bye, season_line_pg, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,1,0,10.0,'x')`,
        ).run(`K${p.sk}`, String(p.sk), SEASON, w, KICK(w), p.name, p.pos, p.team,
          p.team === "AAA" ? "BBB" : "AAA");
      }
    }
  })();
}

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "ff-live-ctx-"));
  const dbPath = join(dir, "live.db");
  const db = openDb(dbPath);
  seed(db);
  db.close();
  return dbPath;
}

const setStatus = (dbPath: string, key: string, status: string | null, depth: number | null = 1) => {
  const db = openDb(dbPath);
  db.prepare(
    "INSERT INTO player_status (player_id, injury_status, depth_order, updated_at) VALUES (?,?,?,'x') " +
    "ON CONFLICT(player_id) DO UPDATE SET injury_status=excluded.injury_status, depth_order=excluded.depth_order",
  ).run(key, status, depth);
  db.close();
};

test("a designated player reaches the MODEL's availability columns, not just the context table", () => {
  const dbPath = fresh();
  setStatus(dbPath, "aaron-alpha", "Out");
  setStatus(dbPath, "brett-bravo", "Questionable");
  setStatus(dbPath, "dave-delta", "Doubtful");

  const r = buildLiveWeekContext({ dbPath, season: SEASON, now: `${SEASON}-09-08` });
  assert.equal(r.skipped, null, String(r.skipped));
  assert.equal(r.week, 1, "a snapshot before every kickoff belongs to week 1");
  assert.equal(r.rows, PLAYERS.length);
  assert.equal(r.withStatus, 3);
  assert.equal(r.outs, 1);

  // THE ASSERTION THAT MATTERS: read it back through `contextFor`, which is what the weekly feature
  // builder calls. A row in the table that the feature path does not pick up is worth nothing, and
  // that is exactly the shape of the bug the leakage fixture found on its first run.
  const db = openDb(dbPath);
  const ctx = contextFor(db, SEASON);
  db.close();
  const of = (sk: number) => ctx.get(`1|${sk}`)!;
  assert.ok(of(101), "the Out player has no availability row for week 1");
  assert.equal(of(101).inj_out, 1);
  assert.equal(of(102).inj_questionable, 1);
  assert.equal(of(102).inj_out, 0);
  assert.equal(of(104).inj_doubtful, 1, "Doubtful must stay its own indicator, not be folded into Out");
  assert.equal(of(103).inj_out, 0, "an undesignated player must read 0, not null -- the feed spoke");
  assert.equal(of(103).inj_feed, 1, "inj_feed must say the feed spoke, or the model treats the week as blind");
  // teammates_out counts the same team and position, excluding himself.
  assert.equal(of(102).teammates_out, 1, "Brett's team-mate Aaron is Out and the count does not see it");
  assert.equal(of(101).teammates_out, 0, "a player counted himself as his own team-mate out");
  assert.equal(of(104).teammates_out, 0, "the quarterback counted a receiver as a positional team-mate");
  assert.equal(of(105).teammates_out, 0, "a player on the OTHER team counted the injury");
});

test("FAULT INJECTION on the as-of rule: a snapshot after a week's first kickoff belongs to the NEXT week", () => {
  const dbPath = fresh();
  setStatus(dbPath, "aaron-alpha", "Out");

  // The day BEFORE week 1's kickoff: week 1.
  const before = buildLiveWeekContext({ dbPath, season: SEASON, now: `${SEASON}-09-09`, write: false });
  assert.equal(before.week, 1);
  assert.deepEqual(before.kickedOff, []);

  // ON the kickoff day, and after it: week 2, both times. A game that has started is a game whose
  // outcome could be in today's injury report.
  for (const day of [KICK(1), `${SEASON}-09-12`]) {
    const after = buildLiveWeekContext({ dbPath, season: SEASON, now: day, write: false });
    assert.equal(after.week, 2, `a snapshot on ${day} was assigned to week ${after.week}, not week 2`);
    assert.deepEqual(after.kickedOff, [1]);
  }

  // And nothing may be written to the week that started. Write for real at a post-kickoff date and
  // assert week 1 stays empty -- the counts above are a claim about a variable, this is a claim
  // about the table.
  const w = buildLiveWeekContext({ dbPath, season: SEASON, now: `${SEASON}-09-12` });
  assert.equal(w.week, 2);
  const db = openDb(dbPath);
  const n = (wk: number) => (db.prepare(
    "SELECT count(*) c FROM feat_player_week_context WHERE season = ? AND week = ?",
  ).get(SEASON, wk) as { c: number }).c;
  const got = [n(1), n(2)];
  db.close();
  assert.equal(got[0], 0, "rows were written for week 1, which had already kicked off");
  assert.ok(got[1] > 0, "no rows were written for week 2 either -- the builder wrote nothing at all");
});

test("every week behind us is a skip that says so, not a silent write to the last one", () => {
  const dbPath = fresh();
  const r = buildLiveWeekContext({ dbPath, season: SEASON, now: `${SEASON}-12-01`, write: false });
  assert.equal(r.week, null);
  assert.match(String(r.skipped), /kicked off/);
  assert.deepEqual(r.kickedOff, [1, 2, 3]);
});

test("news ESCALATES a man the structured status has not caught, and never clears one", () => {
  const dbPath = fresh();
  setStatus(dbPath, "aaron-alpha", "Out");
  setStatus(dbPath, "brett-bravo", "Questionable");
  const db = openDb(dbPath);
  db.prepare(
    "INSERT INTO news (player_id, player_name, pos, team, category, severity, detail, source, asof) " +
    "VALUES (?,?,?,?,'injury','high','torn something','test','x')",
  ).run("carl-charlie", "Carl Charlie", "WR", "AAA");
  // A LOW-severity row must do nothing at all, and a high-severity one must not downgrade Aaron.
  db.prepare(
    "INSERT INTO news (player_id, player_name, pos, team, category, severity, detail, source, asof) " +
    "VALUES (?,?,?,?,'injury','low','tweaked something','test','x')",
  ).run("brett-bravo", "Brett Bravo", "WR", "AAA");
  db.close();

  const r = buildLiveWeekContext({ dbPath, season: SEASON, now: `${SEASON}-09-08` });
  assert.equal(r.fromNews, 1, "the high-severity headline did not rule anybody out");
  assert.equal(r.outs, 2);
  const db2 = openDb(dbPath);
  const ctx = contextFor(db2, SEASON);
  db2.close();
  assert.equal(ctx.get(`1|103`)!.inj_out, 1, "the news escalation did not reach the model's column");
  assert.equal(ctx.get(`1|102`)!.inj_questionable, 1, "a LOW-severity news row changed a status it must not touch");
  assert.equal(ctx.get(`1|102`)!.inj_out, 0);
  assert.equal(ctx.get(`1|101`)!.inj_out, 1);
});

test("the ESPN vocabulary maps onto the report vocabulary, and Doubtful is not folded into Out", () => {
  assert.equal(espnStatusToReport("Out"), "Out");
  assert.equal(espnStatusToReport("IR"), "Out");
  assert.equal(espnStatusToReport("PUP"), "Out");
  assert.equal(espnStatusToReport("DNR"), "Out");
  assert.equal(espnStatusToReport("Doubtful"), "Doubtful");
  assert.equal(espnStatusToReport("Questionable"), "Questionable");
  assert.equal(espnStatusToReport("Active"), null);
  assert.equal(espnStatusToReport(null), null);
  assert.equal(espnStatusToReport(""), null);
});
