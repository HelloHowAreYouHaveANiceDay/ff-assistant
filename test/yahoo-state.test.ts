/**
 * THE YAHOO *STATE* READERS (WP9), pinned to saved pages -- started lineups with their actual points,
 * the available-player pool, the transaction log with its FAB bids, and "my leagues".
 *
 * WHY EVERY ONE OF THESE IS A FIXTURE TEST. The D18 season seed refuses to run for a league with no
 * started-lineup rows, and the whole value of WP9 is that it now HAS them -- so the failure mode that
 * matters is not "the parser throws", it is "the parser quietly returns something plausible from a
 * page Yahoo has redesigned". A saved page turns a redesign into a red test.
 *
 * THE LOAD-BEARING ASSERTION IS THE ESPN-SHAPE INVARIANT at the bottom: a Yahoo `raw_league_roster_week`
 * row must be indistinguishable in COLUMNS AND SEMANTICS from an ESPN one, because four downstream
 * readers (`isStarterSlot`, `SLOT_NAME`, `startingTemplate`, the lineup optimum) read that table
 * without ever asking which platform wrote it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseYahooAvailable, parseYahooMyLeagues, parseYahooScoreboardWeek, parseYahooTeamWeek,
  parseYahooTransactions, rowCells, tableBody, tableRows,
} from "../src/league/yahooDom.js";
import { YAHOO_ID_PREFIX, yahooPlayerKey, yahooSlotId } from "../src/league/yahoo.js";
import { ESPN_SLOT_NAME } from "../src/league/espnSlots.js";
import { isStarterSlot } from "../src/data/leagueRosters.js";

const FIX = join("test", "fixtures", "yahoo");
const rd = (n: string): string => readFileSync(join(FIX, n), "utf8");
const teamWeek11 = rd("teamweek-11-wk1-129048.html");
const teamWeek1 = rd("teamweek-1-wk1-129048.html");
const players = rd("players-available-129048.html");
const transactions = rd("transactions-129048.html");
const myLeagues = rd("myleagues.html");
const scoreboard = rd("scoreboard-scores-wk1-129048.html");

// ---------------------------------------------------------------------------------------------
// The nesting-aware table scanner -- the bug that made a page parse two different ways
// ---------------------------------------------------------------------------------------------

test("tableBody stops at the MATCHING close tag, not the first nested one", () => {
  const html = `<table id="outer"><tr><td><table class="inner"><tr><td>x</td></tr></table></td></tr><tr><td>y</td></tr></table>`;
  const body = tableBody(html, /<table[^>]*id="outer"[^>]*>/i);
  assert.ok(body && body.includes("y"), "a lazy scan would have stopped at the inner </table> and lost row 2");
  // FAULT INJECTION on the thing the scanner exists to beat: the lazy form really does lose the row.
  const lazy = /<table[^>]*id="outer"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  assert.ok(lazy && !lazy[1].includes("y"), "the lazy regex must fail here, or this test proves nothing");
  assert.equal(tableRows(body!).length, 2);
  assert.deepEqual(rowCells(tableRows(body!)[1]).map((c) => c.trim()), ["y"]);
});

test("tableBody returns null (not a wrong table) when the opening tag is absent", () => {
  assert.equal(tableBody("<div>no tables here</div>", /<table[^>]*id="statTable0"[^>]*>/i), null);
});

test("the players page really does nest a table inside a cell -- so the scanner is load-bearing here", () => {
  const body = tableBody(players, /<table[^>]*class="[^"]*\bTable-interactive\b[^"]*"[^>]*>/i)!;
  assert.ok(/<table/i.test(body), "fixture must still contain the nested Tst-forecast tables");
  assert.equal(parseYahooAvailable(players).length, 25);
});

// ---------------------------------------------------------------------------------------------
// /f1/<id>/<team>?week=N -- the started lineup and the week's ACTUAL points
// ---------------------------------------------------------------------------------------------

test("a team-week page yields every rostered man with his slot and his actual points", () => {
  const rows = parseYahooTeamWeek(teamWeek11);
  assert.equal(rows.length, 18);                       // 19 slots, one empty IR -- empty slots are skipped
  assert.deepEqual(rows[0], { slot: "QB", playerId: "32671", name: "Joe Burrow", pos: "QB", team: "CIN", points: 20.96, proj: 28.74 });
  // The slot tokens are YAHOO'S here; normalization happens in the adaptor, not the parser.
  assert.deepEqual([...new Set(rows.map((r) => r.slot))], ["QB", "RB", "WR", "TE", "W/R/T", "Q/W/R/T", "BN", "IR"]);
  // A zero week is a REAL result and must not come back null (Kyle Pitts, week 1).
  const pitts = rows.find((r) => r.name.startsWith("Kyle Pitts"))!;
  assert.equal(pitts.points, 0);
});

test("the started ten sum to the score Yahoo's own scoreboard prints -- two pages, one number", () => {
  const rows = parseYahooTeamWeek(teamWeek11);
  const started = rows.filter((r) => !/^(BN|IR)$/i.test(r.slot));
  assert.equal(started.length, 10);
  const sum = Math.round(started.reduce((s, r) => s + (r.points ?? 0), 0) * 100) / 100;
  const game = parseYahooScoreboardWeek(scoreboard, 1).find((g) => g.homeId === "11" || g.awayId === "11")!;
  assert.equal(sum, game.homeId === "11" ? game.homePts : game.awayPts);
  assert.equal(sum, 138);
});

/**
 * THE REGRESSION THAT MOTIVATED THE MARKER-BASED COLUMN LOOKUP, and it is the whole test file's point.
 *
 * ANOTHER manager's team page renders two extra action cells (Propose Trade, Add to Watch List) after
 * the player, so the score does NOT sit at the index it sits at on our own page. Reading by index
 * landed 110 of the league's 120 week-1 starters with a null score -- every team but ours -- and the
 * D18 seed then silently fell back to the shared NFL actuals table, i.e. to this league's points under
 * ANOTHER league's scoring rules. Points-for came out ~30% low for all twelve teams while the win/loss
 * column stayed correct, which is exactly the kind of wrong that survives being looked at.
 */
test("ANOTHER manager's team page has extra action columns -- and still yields every score", () => {
  const rows = parseYahooTeamWeek(teamWeek1);
  assert.ok(rows.length >= 17);
  assert.ok(rows.every((r) => r.playerId && r.name && r.slot));
  const started = rows.filter((r) => !/^(BN|IR)$/i.test(r.slot));
  assert.equal(started.length, 10);
  // THE ASSERTION THAT WOULD HAVE CAUGHT IT: every starter has a score, on a page laid out differently.
  assert.ok(started.every((r) => r.points != null), "a starter with a null score is the index bug");
  assert.equal(rows.find((r) => r.name === "Lamar Jackson")!.points, 38.66);
  // FAULT INJECTION: the fixed index really is wrong on this page -- cells[3] is the BYE week.
  const firstRow = teamWeek1.split(/<tr[^>]*>/i).find((s) => /data-ys-playerid/.test(s))!;
  const byIndex = firstRow.match(/<td[^>]*>([\s\S]*?)<\/td>/gi)!.map((c) => c.replace(/<[^>]*>/g, "").trim());
  assert.notEqual(byIndex[3], "38.66", "if index 3 were the score here, this test would prove nothing");
});

test("the two layouts agree on the ONE thing the seed reads -- a started-lineup sum", () => {
  for (const [html, want] of [[teamWeek11, 138], [teamWeek1, 184.34]] as [string, number][]) {
    const started = parseYahooTeamWeek(html).filter((r) => !/^(BN|IR)$/i.test(r.slot));
    assert.equal(Math.round(started.reduce((s, r) => s + (r.points ?? 0), 0) * 100) / 100, want);
  }
});

test("parseYahooTeamWeek REFUSES a page with no roster table rather than returning []", () => {
  assert.throws(() => parseYahooTeamWeek("<html><body>signed out</body></html>"), /statTable0/);
});

// ---------------------------------------------------------------------------------------------
// The ESPN-SHAPE INVARIANT -- the reason any of this can be stored in raw_league_roster_week
// ---------------------------------------------------------------------------------------------

test("a Yahoo roster-week row carries an ESPN-SHAPED slot id, and every reader of that column agrees", () => {
  const rows = parseYahooTeamWeek(teamWeek11);
  for (const r of rows) {
    const id = yahooSlotId(r.slot);
    // 1. The id is in ESPN's OWN id space -- the same map espn.ts and eligibility.ts read.
    assert.ok(ESPN_SLOT_NAME[id] != null, `slot ${r.slot} -> ${id} is not an ESPN lineup slot id`);
    // 2. `isStarterSlot`, the ESPN ingester's own predicate, agrees with Yahoo's bench tokens.
    assert.equal(isStarterSlot(id), !/^(BN|IR)$/i.test(r.slot), `is_starter disagrees for slot ${r.slot}`);
  }
  // 3. The starting template a Yahoo week produces is the league's real one (superflex included).
  const names = rows.filter((r) => isStarterSlot(yahooSlotId(r.slot))).map((r) => ESPN_SLOT_NAME[yahooSlotId(r.slot)]).sort();
  assert.deepEqual(names, ["FLEX", "FLEX", "FLEX", "OP", "QB", "RB", "RB", "TE", "WR", "WR"]);
});

test("yahooSlotId REFUSES an unknown token instead of defaulting it", () => {
  assert.throws(() => yahooSlotId("LW"), /no lineup-slot id/);
});

test("a Yahoo player id is NAMESPACED, because the ESPN id space overlaps it", () => {
  assert.equal(yahooPlayerKey("32671"), "y:32671");
  assert.equal(YAHOO_ID_PREFIX, "y:");
  // The hazard this prevents, stated as an assertion: a bare Yahoo id is a plausible ESPN id.
  assert.match("32671", /^\d{5}$/);
});

// ---------------------------------------------------------------------------------------------
// The scoreboard's scores
// ---------------------------------------------------------------------------------------------

test("the week-1 scoreboard gives six games with both sides' final scores", () => {
  const games = parseYahooScoreboardWeek(scoreboard, 1);
  assert.equal(games.length, 6);
  assert.ok(games.every((g) => g.homePts != null && g.awayPts != null));
  // Each of the twelve teams appears exactly once.
  assert.equal(new Set(games.flatMap((g) => [g.homeId, g.awayId])).size, 12);
  const ours = games.find((g) => g.homeId === "11")!;
  assert.equal(ours.awayId, "4");
  assert.deepEqual([ours.homePts, ours.awayPts], [138, 185.9]);
});

test("a score is the Fz-lg div, NEVER the F-shade projection beside it", () => {
  // Team 11's week-1 PROJECTION was 172.08; its score was 138.00. Taking the divs by position
  // instead of by class returns the projection for at least one side.
  const g = parseYahooScoreboardWeek(scoreboard, 1).find((x) => x.homeId === "11")!;
  assert.notEqual(g.homePts, 172.08);
  assert.equal(g.homePts, 138);
});

test("a scoreboard read for the wrong week returns nothing rather than another week's games", () => {
  assert.deepEqual(parseYahooScoreboardWeek(scoreboard, 2), []);
});

// ---------------------------------------------------------------------------------------------
// /f1/<id>/players?status=A -- the real free-agent pool
// ---------------------------------------------------------------------------------------------

test("the available-player page yields 25 rows with id, position and roster status", () => {
  const rows = parseYahooAvailable(players);
  assert.equal(rows.length, 25);
  assert.equal(rows[0].name, "Jayden Reed");
  assert.ok(rows.every((r) => /^\d+$/.test(r.playerId)));
  assert.ok(rows.every((r) => ["QB", "RB", "WR", "TE"].includes(r.pos)), "pos=O is the offensive pool");
  // Yahoo distinguishes a straight free agent from a man still on waivers, and both appear here.
  assert.ok(rows.some((r) => /^FA$/i.test(r.status)));
  assert.ok(rows.some((r) => /^W\b/i.test(r.status)));
});

test("parseYahooAvailable REFUSES an empty page rather than reporting an empty pool", () => {
  assert.throws(() => parseYahooAvailable("<html><body>signed out</body></html>"), /free-agent pool/);
});

// ---------------------------------------------------------------------------------------------
// /f1/<id>/transactions -- WITH the winning FAB bid, for every team
// ---------------------------------------------------------------------------------------------

test("the transaction log carries every team's WINNING FAB bid, not just ours", () => {
  const tx = parseYahooTransactions(transactions, "129048");
  assert.ok(tx.length >= 10, `expected a full page of transactions, got ${tx.length}`);
  // Newest first. Row 0 is a FREE-AGENT add (no bid); row 1 is a WAIVER CLAIM by another team.
  assert.equal(tx[0].teamId, "11");
  assert.deepEqual(tx[0].items.map((i) => [i.action, i.name, i.bid]), [
    ["add", "Mike Gesicki", null],
    ["drop", "Michael Mayer", null],
  ]);
  assert.equal(tx[1].teamId, "9");
  assert.equal(tx[1].when, "Sep 16, 4:55 am");
  assert.deepEqual(tx[1].items.map((i) => [i.action, i.name, i.bid]), [
    ["add", "David Njoku", 2],
    ["drop", "Terrance Ferguson", null],
  ]);
  // Bids belong to OTHER managers' claims too -- which is the whole reason this page is worth having.
  const teamsWithBids = new Set(tx.filter((t) => t.items.some((i) => i.bid != null)).map((t) => t.teamId));
  assert.ok(teamsWithBids.size >= 3, `only ${teamsWithBids.size} team(s) show a bid`);
  // Every add/drop pair keys a real Yahoo player id.
  assert.ok(tx.every((t) => t.items.every((i) => /^\d+$/.test(i.playerId))));
  // THE DERIVED KEY IS A FUNCTION OF THE EVENT, NOT OF ITS POSITION. Yahoo publishes no transaction
  // id; a key containing the row's ordinal would change for every past transaction the moment a new
  // one is added above it, so a re-ingest would re-insert the whole history under fresh primary keys.
  assert.equal(new Set(tx.map((t) => t.key)).size, tx.length, "derived keys collide");
  // FAULT INJECTION: drop the newest row (exactly what happens to page 1 when someone makes a move)
  // and every remaining transaction must keep the key it had. An ordinal-based key fails this.
  const withoutFirst = parseYahooTransactions(transactions.replace(/<tr[^>]*>[\s\S]*?<\/tr>/i, ""), "129048");
  assert.deepEqual(withoutFirst.map((t) => t.key), tx.slice(1).map((t) => t.key));
});

test("parseYahooTransactions REFUSES a page with no transaction table", () => {
  assert.throws(() => parseYahooTransactions("<html><body>signed out</body></html>", "129048"), /Tst-transaction-table/);
});

// ---------------------------------------------------------------------------------------------
// /f1/myleagues -- discover
// ---------------------------------------------------------------------------------------------

test("my-leagues names the league AND our team in it", () => {
  const rows = parseYahooMyLeagues(myLeagues);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].leagueId, "129048");
  assert.equal(rows[0].name, "Fappening World Cup Edition");
  // The field that used to be hardcoded null, and whose blanking breaks every verb needing our seat.
  assert.equal(rows[0].teamId, "11");
});
