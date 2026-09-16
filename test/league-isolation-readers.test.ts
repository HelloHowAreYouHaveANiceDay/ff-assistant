/**
 * THE DECISIVE TEST FOR WP2 (S-4/S-6/S-9): a SECOND league in the store must change NOTHING about
 * what the first league reads.
 *
 * WHY IT IS SHAPED THIS WAY. Every other way of checking "is this reader filtered?" compares the
 * system against itself -- you read the code, you see a `WHERE league_id = ?`, and you have proved
 * that the line you are looking at has the clause you just read. What that cannot tell you is whether
 * the clause is BOUND to the right value, whether some other statement in the same function is
 * unfiltered, or whether a join drags the other league back in through the other side.
 *
 * So the check is differential and end-to-end. Two stores are built from the SAME schema and the SAME
 * fixture for league A. One of them ALSO holds league B's rows -- a full, plausible second league in
 * every league-keyed table, with COLLIDING keys: the same seasons, the same weeks, the same numeric
 * team ids (ESPN numbers 1-18 and Yahoo 1-12, so they overlap outright), the same player keys. Then
 * every reader is called for league A on both stores and the two answers must be byte-identical.
 *
 * An unfiltered read cannot survive that: league B's rows are chosen to MOVE the answer (bigger
 * budgets, more teams, extra free agents, a different owner on the same team id), so a reader that
 * sees them returns a different number, and `deepStrictEqual` says which one.
 *
 * FAULT INJECTION (2026-09-16): with `AND league_id = ?` removed from `realFaPool`, this file fails
 * with `pool size 4 !== 2`; with the `WHERE league_id = ?` removed from `budgetFor`, it fails with
 * `250 !== 100`; with the scoped `DELETE` in `buildLeagueFacts` reverted to `DELETE FROM
 * fact_team_season`, the "does not delete the other league's rows" test fails with `0 !== 16`.
 *
 * FAULT INJECTION for the six readers added 2026-09-16 (W-1): with `league_id=?` weakened to
 * `(league_id=? OR 1=1)` in `backtest/lineup.ts`'s per-week `fact_lineup_week` read, this file fails
 * with `btLineup: league B's rows changed what league A reads`. Weakening the `SELECT DISTINCT week`
 * read in the same function does NOT fail it -- worth recording, because it says exactly how far the
 * fixture reaches: both leagues run the same weeks, so that query is not discriminating here. A guard
 * is only as good as the difference the fixture can express.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../src/db/db.js";
import { budgetFor, coverage, buildWaiverClaimsOn, espnToSk } from "../src/features/sources/faab.js";
import { realFaPool } from "../src/weekly/streamingEvaluate.js";
import { hasRosterFeed, populationSource, buildPopulation } from "../src/weekly/population.js";
// THE SIX THE ENUMERATION MISSED (W-1, 2026-09-16). An independent QA pass observed that `readAll`
// below is a HAND-TYPED list -- a snapshot of the day it was written -- and named six league-keyed
// readers the architecture review had listed that were never in it. All six were correctly filtered
// when checked BY HAND, which is exactly the state in which a guard is most comfortable and least
// useful: the next reader added escapes silently. Reading a `WHERE league_id = ?` is not the test;
// calling the reader on two stores is.
import { backtestWaivers } from "../src/inseason/backtest/waiver.js";
import { backtestLineups } from "../src/inseason/backtest/lineup.js";
import { backtestWinProbLineups } from "../src/inseason/backtest/winprobLineup.js";
import { backtestPolicies } from "../src/inseason/backtest/harness.js";
import { backtestStreaming } from "../src/inseason/backtest/streaming.js";
import { valueMinDrop, dropBest } from "../src/inseason/backtest/policies.js";
import { regWeeksFor } from "../src/inseason/regWeeks.js";
import { liveFaabState } from "../src/inseason/faab.js";
import { ourTeamId } from "../src/inseason/backtest/faab.js";
import { scoreOdds } from "../src/weekly/scorecard.js";
import { resolveTrade } from "../src/inseason/proposeTrade.js";
import { buildLeagueFacts, buildDraftPicks } from "../src/features/picks.js";

const SEASON = 2094;
const A = "AAA", B = "BBB";
/** One player, one identity, rostered in BOTH leagues -- the player universe has no league dimension. */
const SHARED_ESPN_ID = "shared9", SHARED_ESPN_ID_2 = "shared8";
const FMT_A = "sc-a", FMT_B = "sc-b";

/**
 * One league's worth of rows in every league-keyed table. `scale` makes league B's numbers DIFFERENT
 * from league A's at every column a reader could pick up -- a filter that leaks returns B's number,
 * or a sum of both, and either way not A's.
 */
function seedLeague(db: DB, lg: string, o: { teams: number; budget: number; faPlayers: number; bid: number; owner: string; regWeeks: number; fmt: string }): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO league (league_id, platform, name, season, team_id, last_synced_at) VALUES (?,?,?,?,?,?)`,
  ).run(lg, "espn", `League ${lg}`, SEASON, "1", now);
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)`)
    .run(`config:${lg}`, JSON.stringify({ season: SEASON, teams: o.teams, budget: o.budget }), now);

  // raw_league_season / team_season / matchup / pick -- the FEEDS of the three fact tables.
  db.prepare(
    `INSERT INTO raw_league_season (league_id, season, available, size, auction_budget, slot_counts_json, reg_weeks, playoff_teams, fetched_at)
     VALUES (?,?,1,?,?,?,?,?,?)`,
  ).run(lg, SEASON, o.teams, o.budget, JSON.stringify({ RB: 2, WR: 2 }), o.regWeeks, 6, now);
  for (let t = 1; t <= o.teams; t++) {
    db.prepare(
      `INSERT INTO raw_league_team_season (league_id, season, team_id, name, owner_id, owner, wins, losses, points_for,
         final_rank, playoff_seed, acquisitions, faab_spent, drops, trades, lineup_moves, fetched_at)
       VALUES (?,?,?,?,?,?,7,7,1000,?,?,3,?,1,0,5,?)`,
    ).run(lg, SEASON, String(t), `${lg} Team ${t}`, `o${t}`, `${o.owner}${t}`, t, t, o.budget, now);
    db.prepare(
      `INSERT INTO fact_team_season (league_id, season, team_id, team_name, owner, wins, losses, points_for,
         playoff_seed, final_rank, champion, made_playoffs, settled, faab_spent, updated_at)
       VALUES (?,?,?,?,?,7,7,1000,?,?,?,?,1,?,?)`,
    ).run(lg, SEASON, String(t), `${lg} Team ${t}`, `${o.owner}${t}`, t, t, t === 1 ? 1 : 0, t <= 6 ? 1 : 0, o.budget, now);
  }
  for (let w = 1; w <= 3; w++) {
    db.prepare(`INSERT INTO raw_league_matchup (league_id, season, week, home_id, away_id, fetched_at) VALUES (?,?,?,?,?,?)`)
      .run(lg, SEASON, w, "1", "2", now);
    db.prepare(`INSERT INTO fact_matchup (league_id, season, week, home_id, away_id, updated_at) VALUES (?,?,?,?,?,?)`)
      .run(lg, SEASON, w, "1", "2", now);
    // BOTH SIDES of the matchup carry a lineup row: the win-probability backtest scores a team
    // against its OPPONENT's actual points, so a one-sided week is silently skipped and the whole
    // reader returns zero team-weeks -- a null that would compare equal on both stores.
    for (const t of ["1", "2"]) {
      db.prepare(
        `INSERT INTO fact_lineup_week (league_id, season, week, team_id, started_pts, optimal_pts, bench_left, starters, roster_n, built_at)
         VALUES (?,?,?,?,?,?,0,8,13,?)`,
      ).run(lg, SEASON, w, t, 100 + o.teams, 120 + o.teams, now);
    }
  }
  db.prepare(
    `INSERT INTO raw_league_pick (league_id, season, pick_no, team_id, name, pos, price, owner_id, owner, fetched_at)
     VALUES (?,?,1,'1',?,'RB',?,?,?,?)`,
  ).run(lg, SEASON, `${lg} Star`, o.budget, "o1", `${o.owner}1`, now);

  // Roster / free-agent state. Team ids COLLIDE with the other league's on purpose.
  for (let w = 1; w <= 3; w++) {
    for (let t = 1; t <= o.teams; t++) {
      db.prepare(
        `INSERT INTO fact_roster_week (league_id, season, week, team_id, player_sk, espn_player_id, name, pos, is_starter, built_at)
         VALUES (?,?,?,?,?,?,?,'RB',1,?)`,
      ).run(lg, SEASON, w, String(t), `${lg}sk${t}`, `${lg}${t}`, `${lg} Body ${t}`, now);
    }
    for (let p = 0; p < o.faPlayers; p++) {
      db.prepare(
        `INSERT INTO fact_fa_pool_week (league_id, season, week, player_sk, pos, name, built_at) VALUES (?,?,?,?,'RB',?,?)`,
      ).run(lg, SEASON, w, `${lg}fa${p}`, `${lg} FA ${p}`, now);
    }
    db.prepare(
      `INSERT INTO raw_league_roster_week (league_id, season, week, team_id, espn_player_id, name, position, lineup_slot_id, is_starter, applied_points, as_of, fetched_at)
       VALUES (?,?,?,'1',?,?,'RB',2,1,10,?,?)`,
    ).run(lg, SEASON, w, `${lg}1`, `${lg} Star`, now, now);
  }

  // BOTH LEAGUES ROSTER THE SAME MAN, exactly as two real leagues do. `asOfRosterState` -- and so the
  // lineup and win-probability backtests -- resolves the as-of roster feed through
  // `player_identity`/`player_xref`, which are GLOBAL tables with no league dimension; without a
  // resolvable man those two readers see an empty room and return zero team-weeks, a null that
  // compares equal on both stores and covers nothing. The identity, the crosswalk and his feature
  // rows are seeded ONCE in `makeStore` (see SHARED_ESPN_ID); only the ROSTERING is per league.
  for (let w = 1; w <= 3; w++) {
    for (const [t, id] of [["1", SHARED_ESPN_ID], ["2", SHARED_ESPN_ID_2]] as [string, string][]) {
      db.prepare(
        `INSERT INTO raw_league_roster_week (league_id, season, week, team_id, espn_player_id, name, position, lineup_slot_id, is_starter, applied_points, as_of, fetched_at)
         VALUES (?,?,?,?,?,?,'RB',2,1,15,?,?)`,
      ).run(lg, SEASON, w, t, id, `Shared Starter ${t}`, now, now);
    }
  }

  // Waiver history: one EXECUTED claim, at a bid that differs between the leagues.
  db.prepare(
    `INSERT INTO raw_league_transaction (league_id, season, week, transaction_id, item_no, type, item_type,
        executed_at, proposed_at_ms, team_id, espn_player_id, from_team_id, to_team_id, bid_amount, status, is_pending, fetched_at)
     VALUES (?,?,2,?,0,'WAIVER','ADD',?,1000,'1',?, '-1', '1', ?, 'EXECUTED', 0, ?)`,
  ).run(lg, SEASON, `${lg}tx1`, now, `${lg}1`, o.bid, now);
  db.prepare(
    `INSERT INTO fact_waiver_claim (league_id, season, week, transaction_id, team_id, espn_player_id, player_sk,
        name, pos, bid_amount, status, won, competing_bids, budget, teams_counted, season_line_pg, built_at)
     VALUES (?,?,2,?,'1',?,?,?,'RB',?,'EXECUTED',1,0,?,?,?,?)`,
  ).run(lg, SEASON, `${lg}tx1`, `${lg}1`, `${lg}sk1`, `${lg} Star`, o.bid, o.budget, o.teams, o.bid, now);

  // Decision snapshots and frozen odds -- per league and per FORMAT respectively.
  db.prepare(
    `INSERT INTO decision_snapshot (league_id, verb, season, week, schedule, summary, result_json, updated_at)
     VALUES (?,'season_odds',?,1,'real',?, '{}', ?)`,
  ).run(lg, SEASON, `${lg} says so`, now);
  for (let t = 1; t <= o.teams; t++) {
    for (const [model, v] of [["playoff", t <= 6 ? 85 : 12], ["title", t === 1 ? 40 : 4]] as [string, number][]) {
      db.prepare(
        `INSERT INTO scorecard_prediction (format_key, season, week, kind, model, subject, name, value, as_of, created_at)
         VALUES (?,?,0,'odds',?,?,?,?,?,?)`,
      ).run(o.fmt, SEASON, model, String(t), String(t), v, `${SEASON}-09-01`, now);
    }
  }

  // Weekly model rows, so the population source has something to read.
  for (let w = 1; w <= 3; w++) {
    db.prepare(
      `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, season_line_pg, td_ppg, pts)
       VALUES (?,?,?,?,?,'RB',?,1,10)`,
    ).run(`${lg}-${w}-1`, `${lg}sk1`, SEASON, w, `${lg} Star`, 12);
  }
}

const A_OPTS = { teams: 16, budget: 100, faPlayers: 2, bid: 20, owner: "ownerA", regWeeks: 13, fmt: FMT_A };
const B_OPTS = { teams: 12, budget: 250, faPlayers: 2, bid: 77, owner: "ownerB", regWeeks: 17, fmt: FMT_B };

interface Store { db: DB; path: string; dir: string }

function makeStore(withB: boolean): Store {
  const dir = mkdtempSync(join(tmpdir(), "ff-iso-"));
  const path = join(dir, "t.db");
  const db = openDb(path);
  // The AVAILABILITY block of `feat_player_week_model` is added by the feature BUILDER, not by
  // schema.sql, and the backtest readers below select it by name. Add it here so those readers reach
  // the league-keyed tables they are here to be tested on, rather than dying on a missing column.
  for (const c of ["inj_out", "inj_doubtful", "inj_questionable"]) {
    try { db.prepare(`ALTER TABLE feat_player_week_model ADD COLUMN ${c} INTEGER`).run(); } catch { /* present */ }
  }
  // The SHARED player: one identity, one crosswalk row, one set of feature rows, IDENTICAL in both
  // stores -- so anything a league-keyed reader does with him is attributable to the league's roster
  // feed and nothing else.
  const snow = nowIso();
  for (const [nk, espnId, tag] of [["sharedstarter", SHARED_ESPN_ID, "1"], ["sharedstartertwo", SHARED_ESPN_ID_2, "2"]] as [string, string, string][]) {
    db.prepare(
      `INSERT INTO player_identity (name_key, birthdate, primary_position, first_name, matched_by, created_at)
       VALUES (?,?,'RB',?,'fixture',?)`,
    ).run(nk, `199${tag}-01-01`, `Shared Starter ${tag}`, snow);
    const sk = (db.prepare("SELECT player_sk FROM player_identity WHERE name_key = ?").get(nk) as { player_sk: number }).player_sk;
    db.prepare("INSERT INTO player_xref (player_sk, source, source_id, created_at) VALUES (?,'espn',?,?)")
      .run(sk, espnId, snow);
    for (let w = 1; w <= 3; w++) {
      db.prepare(
        `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, season_line_pg, td_ppg, pts)
         VALUES (?,?,?,?,?,'RB',11,9,15)`,
      ).run(`shared${tag}-${w}`, String(sk), SEASON, w, `Shared Starter ${tag}`);
    }
  }
  seedLeague(db, A, A_OPTS);
  if (withB) seedLeague(db, B, B_OPTS);
  // FILLER FEATURE ROWS, IDENTICAL IN BOTH STORES, so `buildPopulation`'s league-dependent half is the
  // only thing that can move. `feat_player_week_model` has NO league dimension by design -- one row per
  // player-week, shared by every league -- so its RAW counts move with the fixture and prove nothing.
  // What IS league-dependent is membership by ROSTER. These 30 fillers carry a much higher season line
  // than either league's star, pushing both stars outside the rank cut, so the only way a star enters
  // the population is through his own league's `fact_roster_week`. League B's star must therefore be
  // absent from league A's build -- and if he leaks in, `inPopulation` goes 93 -> 96.
  for (let w = 1; w <= 3; w++) {
    for (let i = 0; i < 30; i++) {
      db.prepare(
        `INSERT INTO feat_player_week_model (feat_key, player_sk, season, week, name, pos, season_line_pg, td_ppg, pts)
         VALUES (?,NULL,?,?,?,'RB',?,1,10)`,
      ).run(`fill-${w}-${i}`, SEASON, w, `Filler ${i}`, 100 - i);
    }
  }
  // A is the ACTIVE league in both stores, so a reader that falls back to "the active league"
  // instead of honouring its argument does not accidentally pass.
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('active_league', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(A, nowIso());
  return { db, path, dir };
}

const close = (s: Store): void => {
  s.db.close();
  // `force` alone is not enough on Windows: the builders below open their OWN handle on the same
  // file and the WAL sidecars can still be held for a moment after close.
  try { rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* temp dir */ }
};

/** Every reader, called for league A. The value returned is what must not move. */
function readAll(s: Store): Record<string, unknown> {
  const { db, path } = s;
  const faab = liveFaabState({ dbPath: path, season: SEASON, week: 3, teamId: "1", leagueId: A });
  return {
    budget: budgetFor(db, A, SEASON),
    coverage: coverage(db, A, [SEASON]),
    espnToSk: [...espnToSk(db, A).entries()].sort(),
    faPool: [...(realFaPool(db, [SEASON], A) ?? new Map()).keys()].sort(),
    hasRosterFeed: hasRosterFeed(db, SEASON, A),
    populationSource: populationSource(db, SEASON, A),
    regWeeks: regWeeksFor(db, A, SEASON),
    ourTeamId: ourTeamId(db, SEASON, A),
    odds: scoreOdds(db, SEASON, { formatKey: FMT_A, leagueId: A }),
    trade: resolveTrade(db, [`${A} Star`], [], A),
    faabBudget: faab.budget,
    faabTeams: faab.teamsCounted,
    faabRemaining: faab.remaining,
    faabLeagueRemaining: faab.leagueRemaining,
    faabNeed: [...faab.needByPos.entries()].sort(),
    snapshots: db.prepare("SELECT verb, summary FROM decision_snapshot WHERE league_id = ? ORDER BY verb").all(A),
    // --- the six the enumeration missed (W-1) ---------------------------------------------------
    // Each is reduced to the COUNTS that a leak would move (team-weeks, claim weeks, decisions), not
    // to a boolean: "it ran" is the assertion this whole file exists to refuse.
    // `scored`/`inPopulation` are deliberately NOT compared: they count every feature row of the
    // season, and `feat_player_week_model` is league-AGNOSTIC by design (one row per player-week,
    // shared by every league), so a second league's rows legitimately move them. What IS
    // league-dependent is `source` and WHICH men the roster half admits -- so the flag is read back
    // for league A's own star, who sits far outside the rank cut and can therefore only be in the
    // population through `fact_roster_week` FOR LEAGUE A.
    population: (() => {
      const built = buildPopulation(db, [SEASON], A);
      const flagged = db.prepare(
        "SELECT COUNT(*) c FROM feat_player_week_model WHERE season = ? AND player_sk = ? AND in_population = 1",
      ).get(SEASON, `${A}sk1`) as { c: number };
      return { source: built[0].source, aStarWeeksInPopulation: flagged.c };
    })(),
    btWaiver: (() => { const s = backtestWaivers(db, A, { seasons: [SEASON], model: "floor" }).summary;
      return { weeks: s.weeks, roomAdds: s.roomAdds, ourAdds: s.ourAdds }; })(),
    btLineup: (() => { const s = backtestLineups(db, A, { seasons: [SEASON], model: "floor" }).summary;
      return { teamWeeks: s.teamWeeks, started: s.meanStarted, optimal: s.meanOptimal }; })(),
    btWinProb: (() => { const s = backtestWinProbLineups(db, A, { seasons: [SEASON], model: "floor", sims: 20, seed: 7 }).summary;
      return { teamWeeks: s.teamWeeks }; })(),
    btHarness: (() => { const r = backtestPolicies(db, {
      leagueId: A, seasons: [SEASON], model: "floor", baseline: valueMinDrop, variant: dropBest, control: dropBest });
      return { evaluated: r.evaluated, differed: r.differed, meanDiff: r.meanDiff }; })(),
    btStreaming: backtestStreaming(db, { leagueId: A, seasons: [SEASON], model: "floor", positions: ["RB"] })
      .positions.map((p) => ({ pos: p.pos, teamWeeks: p.teamWeeks, hold: p.holdPtsPerWeek })),
  };
}

test("a SECOND league in the store changes NOTHING league A reads", () => {
  const only = makeStore(false);
  const both = makeStore(true);
  try {
    // POSITIVE CONTROL FIRST: the fixture must actually be capable of moving these numbers. If
    // league B's rows were inert, this whole file would pass on a system with no filters at all.
    assert.notDeepEqual(
      { b: budgetFor(both.db, B, SEASON), n: (realFaPool(both.db, [SEASON], B) ?? new Map()).size },
      { b: budgetFor(both.db, A, SEASON), n: (realFaPool(both.db, [SEASON], A) ?? new Map()).size },
      "league B's fixture must differ from A's, or a leak could not be detected",
    );

    const a1 = readAll(only);
    const a2 = readAll(both);
    for (const k of Object.keys(a1)) {
      assert.deepEqual(a2[k], a1[k], `${k}: league B's rows changed what league A reads`);
    }
    // And the numbers are the fixture's, not some union of the two -- a reader could in principle
    // be equally wrong on both stores.
    assert.equal(a1.budget, 100);
    assert.equal(a1.regWeeks, 13);
    assert.deepEqual(a1.faPool, [`${SEASON}|1|${A}fa0`, `${SEASON}|1|${A}fa1`, `${SEASON}|2|${A}fa0`,
      `${SEASON}|2|${A}fa1`, `${SEASON}|3|${A}fa0`, `${SEASON}|3|${A}fa1`]);
    assert.equal(a1.faabTeams, 16);
    // AND THE SIX ADDED READERS MUST HAVE ACTUALLY MEASURED SOMETHING (W-1). A reader that returns an
    // empty result on both stores compares equal forever and covers nothing -- the same "silence read
    // as agreement" this file's header is about. These are the fixture's own counts: A has 16 teams x
    // 3 weeks of rosters and one waiver claim; B has 12 x 3 and a different claim.
    assert.deepEqual(a1.population, { source: "roster_feed", aStarWeeksInPopulation: 3 },
      "A's star is outside the rank cut, so all three of his weeks enter the population ONLY through " +
      "league A's own roster feed -- a build that read another league's rosters gives 0 here");
    // League A's one EXECUTED claim, scored. (`ourAdds` is 0 because the fixture's free agents carry
    // no feature rows to rank -- the claim week itself is what a league leak would double.)
    assert.deepEqual(a1.btWaiver, { weeks: 1, roomAdds: 1, ourAdds: 0 });
    // Two teams x three weeks of real lineups for league A -- and the second league's six must not
    // join them.
    assert.equal((a1.btLineup as { teamWeeks: number }).teamWeeks, 6);
    assert.equal((a1.btWinProb as { teamWeeks: number }).teamWeeks, 6);
    assert.ok((a1.btHarness as { evaluated: number }).evaluated > 0, "the harness must evaluate real decisions");
    assert.equal((a1.btStreaming as { teamWeeks: number }[])[0].teamWeeks, 6, "streaming team-weeks");
  } finally { close(only); close(both); }
});

test("the BUILDERS rebuild one league without touching the other (S-4)", () => {
  const s = makeStore(true);
  try {
    const bTeams = () => (s.db.prepare("SELECT COUNT(*) c FROM fact_team_season WHERE league_id = ?").get(B) as { c: number }).c;
    const bGames = () => (s.db.prepare("SELECT COUNT(*) c FROM fact_matchup WHERE league_id = ?").get(B) as { c: number }).c;
    const bPicks = () => (s.db.prepare("SELECT COUNT(*) c FROM fact_draft_pick WHERE league_id = ?").get(B) as { c: number }).c;
    // Seed B's picks through the builder so both leagues have fact_draft_pick rows.
    buildDraftPicks({ dbPath: s.path, leagueId: B });
    buildLeagueFacts({ dbPath: s.path, leagueId: B });
    const before = { teams: bTeams(), games: bGames(), picks: bPicks() };
    assert.ok(before.teams > 0 && before.games > 0 && before.picks > 0, "B must have rows to lose");

    const fa = buildLeagueFacts({ dbPath: s.path, leagueId: A });
    const pa = buildDraftPicks({ dbPath: s.path, leagueId: A });
    assert.equal(fa.leagueId, A);
    assert.equal(pa.leagueId, A);
    assert.equal(fa.teamSeasons, A_OPTS.teams, "A's rebuild must cover A's teams only");
    assert.equal(pa.rows, 1, "A has exactly one raw pick");
    assert.deepEqual({ teams: bTeams(), games: bGames(), picks: bPicks() }, before,
      "rebuilding league A deleted league B's rows -- the bare `DELETE FROM` is back");
  } finally { close(s); }
});

test("the waiver builder writes only its own league's claims", () => {
  const s = makeStore(true);
  try {
    const r = buildWaiverClaimsOn(s.db, A, [SEASON]);
    assert.equal(r.rows, 1, "one EXECUTED claim in league A");
    const byLeague = s.db.prepare("SELECT league_id, COUNT(*) c FROM fact_waiver_claim GROUP BY league_id ORDER BY league_id")
      .all() as { league_id: string; c: number }[];
    assert.deepEqual(byLeague, [{ league_id: A, c: 1 }, { league_id: B, c: 1 }],
      "B's pre-seeded claim must survive A's rebuild, and A must not gain B's");
    assert.equal(r.perSeason[0].budget, A_OPTS.budget,
      "the coverage read-back must report A's own budget (100), not league B's 250");
    assert.equal(r.perSeason[0].teams, A_OPTS.teams, "...and A's own team count, not B's 12");
  } finally { close(s); }
});

test("scorecard rows are keyed by FORMAT: two formats freeze the same subject and BOTH survive", () => {
  const s = makeStore(true);
  try {
    const n = (fk: string) => (s.db.prepare(
      "SELECT COUNT(*) c FROM scorecard_prediction WHERE format_key = ? AND season = ?").get(fk, SEASON) as { c: number }).c;
    assert.equal(n(FMT_A), A_OPTS.teams * 2);
    assert.equal(n(FMT_B), B_OPTS.teams * 2);
    // The SAME (season, week, kind, model, subject) under two formats -- the exact pair the old PK
    // collapsed into one row with INSERT OR IGNORE.
    const same = s.db.prepare(
      "SELECT COUNT(*) c FROM scorecard_prediction WHERE season=? AND week=0 AND kind='odds' AND model='playoff' AND subject='1'",
    ).get(SEASON) as { c: number };
    assert.equal(same.c, 2, "one subject, two formats, two rows");
    // ...and INSERT OR IGNORE still means write-once WITHIN a format.
    const ins = s.db.prepare(
      `INSERT OR IGNORE INTO scorecard_prediction (format_key, season, week, kind, model, subject, name, value, as_of, created_at)
       VALUES (?,?,0,'odds','playoff','1','1',99,'x','x')`);
    assert.equal(ins.run(FMT_A, SEASON).changes, 0, "a second write in the same format is a no-op");
    assert.equal(n(FMT_A), A_OPTS.teams * 2);
  } finally { close(s); }
});

test("propose_trade resolves only inside its own league (P-2)", () => {
  const s = makeStore(true);
  try {
    // B's star shares nothing but the shape; asking league A for him must FAIL rather than resolve
    // against B's roster feed and then POST into league A.
    const wrong = resolveTrade(s.db, [`${B} Star`], [], A);
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems.join(" "), /no roster player matches/);
    assert.equal(wrong.leagueId, A, "the resolution must stay on the league it was asked about");
    const right = resolveTrade(s.db, [`${A} Star`], [], A);
    assert.equal(right.give[0].playerId, `${A}1`, "positive control: A's own man DOES resolve");
  } finally { close(s); }
});
