/**
 * WP13 -- THE LAST WIRING PACKAGE, AND THE THREE THINGS IT COULD GET SILENTLY WRONG.
 *
 * Every item in this package is a seam where the wrong answer RENDERS PERFECTLY: a lineup total in
 * another league's scoring, a ledger row hashing files it never opened, a raw asset that fetched one
 * league and stamped another's id. None of them fails; each just answers a different question under
 * the same column heading. So each test below is built to FAIL when the wiring is undone, and the
 * ones that can be are paired with the negative case (the incumbent's path, which must not move).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso, setSetting, type DB } from "../src/db/db.js";
import { loadLeagueRosterWeeks, type RosterWeekFetch } from "../src/data/leagueRosters.js";
import { buildRosterState } from "../src/features/sources/rosterState.js";
import { ROUTINES, planRoutines } from "../src/inseason/routines.js";
import { RAW_ASSETS } from "../src/data/ingest.js";
import { ingestPlatformTransactions } from "../src/data/leagueTransactions.js";
// @ts-expect-error -- a plain-JS arbiter helper, deliberately loadable by `node` without tsx.
import { fingerprintDraftArbiter } from "../scripts/lib/deps.mjs";

// =================================================================================================
// (1) THE POINTS A LINEUP FACT IS DENOMINATED IN (item 4)
// =================================================================================================

const SEASON = 2091, WEEK = 1, LEAGUE = "L1";

function fixture(): { dir: string; db: DB; fmt: DB } {
  const dir = mkdtempSync(join(tmpdir(), "ff-wp13-"));
  const db = openDb(join(dir, "main.db"));
  const fmt = openDb(join(dir, "features.db"));
  const now = nowIso();
  db.prepare("INSERT INTO raw_nfl_game (game_id, season, week, game_type, gameday, as_of, fetched_at) VALUES (?,?,?,?,?,?,?)")
    .run("g1", SEASON, WEEK, "REG", `${SEASON}-09-10`, `${SEASON}-09-10`, now);
  let sk = 0;
  for (const [nameKey, pos] of [["aplayer", "RB"], ["bplayer", "WR"]] as [string, string][]) {
    db.prepare("INSERT INTO player_identity (player_sk) VALUES (?)").run(++sk);
    db.prepare("INSERT INTO stg_player (player_sk, name_key, position, team, ambiguous) VALUES (?,?,?,?,?)")
      .run(sk, nameKey, pos, null, 0);
  }
  // THE SAME TWO MEN, TWICE, AT DIFFERENT PRICES. This is the whole point: the main store holds the
  // INCUMBENT's scoring and the format database holds the league's own, and nothing about a roster
  // row says which one it should be read in.
  for (const [k, nm, pos, main, ours] of [["1", "A Player", "RB", 10, 25], ["2", "B Player", "WR", 4, 11]] as [string, string, string, number, number][]) {
    db.prepare("INSERT INTO feat_player_week_model (season, week, player_sk, name, pos, pts) VALUES (?,?,?,?,?,?)").run(SEASON, WEEK, k, nm, pos, main);
    fmt.prepare("INSERT INTO feat_player_week_model (season, week, player_sk, name, pos, pts) VALUES (?,?,?,?,?,?)").run(SEASON, WEEK, k, nm, pos, ours);
  }
  const rows: RosterWeekFetch = {
    season: SEASON, week: WEEK, available: true, note: null,
    rows: [
      { season: SEASON, week: WEEK, teamId: "11", espnPlayerId: "p1", name: "A Player", position: "RB", lineupSlotId: 2, isStarter: 1, appliedPoints: 25, acquisitionType: null, acquisitionDate: null, proTeam: null },
      { season: SEASON, week: WEEK, teamId: "11", espnPlayerId: "p2", name: "B Player", position: "WR", lineupSlotId: 4, isStarter: 1, appliedPoints: 11, acquisitionType: null, acquisitionDate: null, proTeam: null },
    ],
  };
  loadLeagueRosterWeeks(db, LEAGUE, [rows], now);
  return { dir, db, fmt };
}

test("item 4: a lineup fact is priced out of the POINTS DB it is given, not the store it lives in", () => {
  const f = fixture();
  try {
    // NEGATIVE CONTROL FIRST -- no `pointsDb` is the incumbent's path, and it must still read the
    // shared table. Without this, a test that only checks the new branch cannot tell "follows the
    // handle" from "always reads the second database".
    buildRosterState(f.db, LEAGUE, [SEASON], { throughAsOf: `${SEASON}-12-01` });
    const shared = f.db.prepare("SELECT started_pts FROM fact_lineup_week WHERE league_id=? AND season=? AND week=?").get(LEAGUE, SEASON, WEEK) as { started_pts: number };
    assert.equal(shared.started_pts, 14, "the shared table prices this lineup at 10 + 4");

    // POSITIVE CONTROL: the same rosters, the same code, the league's own currency -- and it equals
    // what the platform itself published for that lineup (25 + 11), which the shared table does not.
    buildRosterState(f.db, LEAGUE, [SEASON], { throughAsOf: `${SEASON}-12-01`, pointsDb: f.fmt });
    const own = f.db.prepare("SELECT started_pts, optimal_pts FROM fact_lineup_week WHERE league_id=? AND season=? AND week=?").get(LEAGUE, SEASON, WEEK) as { started_pts: number; optimal_pts: number };
    assert.equal(own.started_pts, 36, "25 + 11 -- the total the league's own site publishes");
    assert.equal(own.optimal_pts, 36, "the hindsight optimum is in the same currency as the lineup");
    const per = f.db.prepare("SELECT name, actual_pts FROM fact_roster_week WHERE league_id=? ORDER BY name").all(LEAGUE) as { name: string; actual_pts: number }[];
    assert.deepEqual(per.map((r) => r.actual_pts), [25, 11], "and so is every player row");
  } finally { f.db.close(); f.fmt.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("item 4: the FREE-AGENT POOL is priced from the same handle -- a pool in one currency and the rosters it is compared against in another is the same defect one table over", () => {
  const f = fixture();
  try {
    // A man on nobody's roster, at a different price in each database.
    f.db.prepare("INSERT INTO feat_player_week_model (season, week, player_sk, name, pos, pts) VALUES (?,?,?,?,?,?)").run(SEASON, WEEK, "9", "Free Man", "RB", 3);
    f.fmt.prepare("INSERT INTO feat_player_week_model (season, week, player_sk, name, pos, pts) VALUES (?,?,?,?,?,?)").run(SEASON, WEEK, "9", "Free Man", "RB", 8);
    buildRosterState(f.db, LEAGUE, [SEASON], { throughAsOf: `${SEASON}-12-01`, pointsDb: f.fmt });
    const fa = f.db.prepare("SELECT name, actual_pts FROM fact_fa_pool_week WHERE league_id=? AND player_sk='9'").get(LEAGUE) as { name: string; actual_pts: number };
    assert.equal(fa.actual_pts, 8, "the pool is priced in the league's own scoring");
  } finally { f.db.close(); f.fmt.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

// =================================================================================================
// (2) THE ROUTINE SET IS PER LEAGUE (item 3)
// =================================================================================================

test("item 3: every routine is leagueScoped now, and the plan carries --league on every step", () => {
  for (const [name, r] of Object.entries(ROUTINES)) {
    assert.equal(r.leagueScoped, true, `routine ${name} -- all four verbs take --league as of WP13`);
  }
  const dir = mkdtempSync(join(tmpdir(), "ff-wp13r-"));
  const db = openDb(join(dir, "t.db"));
  try {
    const ins = db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)");
    ins.run("AAA", "espn", "E", 2026, "1", nowIso());
    ins.run("BBB", "yahoo", "Y", 2026, "11", nowIso());
    const plan = planRoutines(db, ["actuals", "roster"], "AAA");
    for (const lg of ["AAA", "BBB"]) {
      const run = plan.runs.find((x) => x.leagueId === lg && x.routine === "actuals");
      assert.ok(run, `league ${lg} runs actuals`);
      assert.deepEqual(run!.steps, [["sync-actuals", ["--league", lg]]]);
    }
    // THE OTHER GATE IS STILL THERE: `roster` is ESPN-only, so the Yahoo league must not run it.
    //
    // THIS USED TO BE `assert.match(skip.why, /no yahoo adaptor/)` -- a NAME-KEYED assertion on a
    // human-readable sentence, which keeps passing if the reason's MEANING changes (and which says
    // nothing at all about whether the step runs). What matters is the STRUCTURAL outcome: the step
    // is not in the plan, and a runner that executes the plan makes ZERO calls for that league.
    //
    // The expectation is DERIVED from the routine definition rather than retyped, so it cannot go
    // stale the way an enumerated one does.
    const rosterSteps = ROUTINES.roster.steps.map((s) => s[0]);
    assert.ok(ROUTINES.roster.platforms && !ROUTINES.roster.platforms.includes("yahoo"),
      "the premise: `roster` declares itself ESPN-only");
    const skip = plan.skipped.find((x) => x.leagueId === "BBB" && x.routine === "roster");
    assert.ok(skip, "the Yahoo league's roster routine is still skipped");

    // A RECORDING RUNNER: execute the plan the way the scheduler does and record every (verb, league)
    // it would invoke. Nothing may be recorded for the Yahoo league's ESPN-only steps -- that is the
    // fact the prose was standing in for.
    const called: { verb: string; leagueId: string }[] = [];
    for (const run of plan.runs) for (const [verb, args] of run.steps) {
      const i = args.indexOf("--league");
      called.push({ verb, leagueId: i >= 0 ? args[i + 1] : run.leagueId });
    }
    assert.equal(called.filter((c) => c.leagueId === "BBB" && rosterSteps.includes(c.verb)).length, 0,
      `the ESPN-only step(s) ${rosterSteps.join(", ")} must never be invoked for the Yahoo league`);
    // POSITIVE CONTROL: the recorder is not simply empty -- the SAME steps DO run for the ESPN league,
    // and the platform-neutral routine runs for both. A recorder that can only ever be empty would
    // pass this test with the whole planner deleted.
    assert.equal(called.filter((c) => c.leagueId === "AAA" && rosterSteps.includes(c.verb)).length,
      rosterSteps.length, "positive control: the ESPN league DOES run every roster step");
    assert.deepEqual(called.filter((c) => c.verb === "sync-actuals").map((c) => c.leagueId).sort(),
      ["AAA", "BBB"], "positive control: the platform-neutral routine runs for BOTH leagues");
    // The reason still has to NAME the platform it refused and the steps it refused to run -- checked
    // against the data, not against a remembered sentence.
    assert.ok(skip!.why.includes("yahoo"), "the refusal names the platform the row actually carries");
    for (const v of rosterSteps) assert.ok(skip!.why.includes(v), `the refusal names the step \`${v}\``);
    assert.equal(plan.skipped.filter((x) => /--league/.test(x.why)).length, 0, "nothing is skipped for want of the flag any more");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("item 3: a league-shaped raw asset dispatches on the league's PLATFORM and refuses an unknown one by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-wp13p-"));
  const path = join(dir, "t.db");
  const db = openDb(path);
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
    .run("ZZZ", "sleeper", "somewhere else", 2026, "3", nowIso());
  setSetting(db, "active_league", "ZZZ");
  db.close();
  try {
    const asset = RAW_ASSETS.find((a) => a.id === "league-rosters")!;
    await assert.rejects(
      () => asset.run(path, [2026], { leagueId: "ZZZ" }),
      /sleeper/,
      "a platform with no adaptor is named, not silently given the ESPN body",
    );
    // ...and nothing was written under that league's id.
    const back = openDb(path);
    const n = (back.prepare("SELECT COUNT(*) c FROM raw_league_roster_week WHERE league_id='ZZZ'").get() as { c: number }).c;
    back.close();
    assert.equal(n, 0, "a refusal writes nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("item 3: the transaction dispatcher refuses an ESPN league BY NAME -- the two readers are not interchangeable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-wp13t-"));
  const path = join(dir, "t.db");
  const db = openDb(path);
  db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
    .run("EEE", "espn", "E", 2026, "1", nowIso());
  db.close();
  try {
    await assert.rejects(
      () => ingestPlatformTransactions({ dbPath: path, leagueId: "EEE" }),
      /espn.*ingestLeagueTransactions/s,
      "the platform branch names ESPN's own reader rather than writing zero rows",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =================================================================================================
// (3) THE ARBITER FINGERPRINT FOLLOWS THE FORMAT (item 5)
// =================================================================================================

/** The format directory whose `scoring.json` this test can borrow, or null on a clean clone (the
 *  directories are gitignored, ~1GB each). Both branches are asserted below; neither is skipped. */
function someFormatDir(): { dir: string; rules: unknown; kicker: unknown; defense: unknown } | null {
  try {
    for (const d of readdirSync("data/formats")) {
      const p = `data/formats/${d}/scoring.json`;
      if (!existsSync(p)) continue;
      const sc = JSON.parse(readFileSync(p, "utf8"));
      if (sc.rules) return { dir: `data/formats/${d}`, rules: sc.rules, kicker: sc.kicker ?? null, defense: sc.defense ?? null };
    }
  } catch { /* no formats directory */ }
  return null;
}

test("item 5: a league whose rules match a format directory fingerprints THAT directory's inputs; a league that matches none is byte-identical to the flagless run", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-wp13d-"));
  const db = openDb(join(dir, "t.db"));
  try {
    // THE INCUMBENT'S PART SET IS FROZEN. Every row already in data/experiments.jsonl was enrolled at
    // the flagless hash, so a named ESPN league must not produce a different one -- otherwise the
    // first `--league 462233` run would make the whole ledger read STALE for no reason at all.
    db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
      .run("INC", "espn", "E", 2026, "1", nowIso());
    setSetting(db, "active_league", "INC");
    setSetting(db, "config:INC", JSON.stringify({ scoring_rules: { rec: 0.5 }, kicker: null, defense: null }));
    const flagless = fingerprintDraftArbiter(db);
    const named = fingerprintDraftArbiter(db, "INC");
    assert.equal(named.hash, flagless.hash, "an unmatched (incumbent) league reads the root's files, exactly as before");
    assert.ok(flagless.parts["file:data/history-points.csv"], "the incumbent's key spelling is unchanged (forward slashes, root path)");

    const fmt = someFormatDir();
    if (!fmt) {
      // A clean clone: the directories are gitignored. Assert the ONLY thing that is knowable here --
      // that a league with no directory to match falls back to the root and says nothing else -- and
      // say plainly that the positive branch was not exercised, rather than passing in silence.
      assert.equal(Object.keys(flagless.parts).some((k) => k.startsWith("format:")), false);
      console.log("  (no data/formats/<key> on this machine -- the per-format branch was not exercised)");
      return;
    }
    setSetting(db, "config:FMT", JSON.stringify({ scoring_rules: fmt.rules, kicker: fmt.kicker, defense: fmt.defense }));
    db.prepare("INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)")
      .run("FMT", "yahoo", "Y", 2026, "11", nowIso());
    const per = fingerprintDraftArbiter(db, "FMT");
    assert.notEqual(per.hash, flagless.hash, "a format's run cannot carry the incumbent's fingerprint");
    assert.ok(per.parts[`file:${fmt.dir}/history-points.csv`], "it hashes the format's own target");
    assert.ok(per.parts[`file:${fmt.dir}/history-weekly.csv`], "...both halves of it");
    assert.ok(per.parts[`file:${fmt.dir}/projection-artifact.json`], "...and the projector its board is built from");
    assert.equal(per.parts["file:data/history-points.csv"], undefined, "and NOT the incumbent's, which it never opened");
    assert.match(String(per.parts["format:FMT"]), /scoring\.json$/, "the match is recorded, with the evidence it was made on");

    // FAULT INJECTION: break the match (one scoring term differs) and the run falls back to the root,
    // i.e. the fingerprint really reads the rules rather than the league id or the directory listing.
    setSetting(db, "config:FMT", JSON.stringify({ scoring_rules: { ...(fmt.rules as Record<string, number>), zzz_not_a_real_term: 1 }, kicker: fmt.kicker, defense: fmt.defense }));
    const broken = fingerprintDraftArbiter(db, "FMT");
    assert.equal(broken.parts[`file:${fmt.dir}/history-points.csv`], undefined, "a config that matches no directory hashes no directory");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
