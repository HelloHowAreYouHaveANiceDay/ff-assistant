/**
 * THE YAHOO ROSTER AND SCHEDULE READERS, pinned to saved pages.
 *
 * The Yahoo roster was, until 2026-09-16, an eighteen-name ARRAY typed into
 * `scripts/yahoo-waiver-trade.mjs`. These parse the league's own all-rosters page instead.
 *
 * The fixture holds two real team blocks (1 and 11), unmodified markup, rather than all twelve --
 * enough to exercise every branch at 63 KB instead of 378 KB. The live twelve-team read is the WP4
 * positive control, not a checked-in file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYahooManagers, parseYahooRosters, parseYahooScheduleWeek } from "../src/league/yahooDom.js";
import { yahooSlot } from "../src/league/yahoo.js";

const FIX = join("test", "fixtures", "yahoo");
const starters = readFileSync(join(FIX, "starters-129048.html"), "utf8");
const managers = readFileSync(join(FIX, "teams-129048.html"), "utf8");
const scoreboard = readFileSync(join(FIX, "scoreboard-wk3-129048.html"), "utf8");
/** Fold Yahoo's curly apostrophe onto ASCII, for comparison only. */
const apos = (s: string): string => s.replace(/[\u2018\u2019]/g, "'");

test("every team block is read, with its name from the link above its table", () => {
  const rs = parseYahooRosters(starters);
  assert.deepEqual(rs.map((r) => r.teamId), ["1", "11"]);
  assert.equal(rs[0].teamName, "Sheng's Team");
  // Yahoo renders a CURLY apostrophe (U+2019) in this team's name. The parser keeps what the page
  // says, verbatim; only the comparison normalizes -- a reader that rewrote the name would make the
  // store's team name differ from the platform's.
  assert.equal(apos(rs[1].teamName), "Joe's Rookie Daycare");
});

test("our roster: eighteen men, with slot, position and NFL team", () => {
  const me = parseYahooRosters(starters).find((r) => r.teamId === "11")!;
  assert.equal(me.players.length, 18);
  const goff = me.players.find((p) => p.name === "Jared Goff")!;
  assert.deepEqual(goff, { slot: "QB", name: "Jared Goff", pos: "QB", team: "DET" });
  // The superflex slot holds a second QB -- the fact that makes this format different from ESPN's.
  const sf = me.players.find((p) => p.slot === "Q/W/R/T")!;
  assert.equal(sf.name, "Joe Burrow");
  assert.equal(sf.pos, "QB");
  assert.equal(yahooSlot(sf.slot), "SUPERFLEX");
  // Seven bench and one occupied IR.
  assert.equal(me.players.filter((p) => p.slot === "BN").length, 7);
  assert.equal(me.players.filter((p) => p.slot === "IR").length, 1);
  assert.equal(me.players.filter((p) => p.slot === "W/R/T").length, 3);
  // A generational suffix comes through VERBATIM -- nameKey strips it downstream; the adaptor must
  // not silently rewrite what the platform says a player is called.
  assert.ok(me.players.some((p) => p.name === "Kyle Pitts Sr."));
  assert.ok(me.players.some((p) => p.name === "Omar Cooper Jr."));
  // Every player carries a real position: a blank here is how a roster silently scores zero.
  for (const p of me.players) assert.match(p.pos, /^(QB|RB|WR|TE|K|DEF)$/, `${p.name} has pos "${p.pos}"`);
});

test("an all-rosters page with no team table THROWS rather than reporting an empty league", () => {
  // types.ts is explicit about this: an empty roster and a failed read look identical to a caller,
  // and a trade script that scores an empty roster reports a confident wrong answer with no error.
  assert.throws(() => parseYahooRosters("<html><body>Please sign in</body></html>"), /carried no `Tst-team-N` table/);
});

test("the Managers table gives the FAB balance a budget can be OBSERVED from", () => {
  const ms = parseYahooManagers(managers);
  assert.equal(ms.length, 12);
  const untouched = ms.filter((m) => m.moves === 0);
  assert.ok(untouched.length > 0, "no team with zero moves -- the FAB budget cannot be observed");
  assert.equal(Math.max(...untouched.map((m) => m.faabRemaining as number)), 100);
  const mine = ms.find((m) => apos(m.teamName) === "Joe's Rookie Daycare")!;
  assert.equal(mine.faabRemaining, 98);
  assert.equal(mine.waiverPriority, 7);
  // A co-manager row has no team of its own and must not become a thirteenth team.
  assert.ok(!ms.some((m) => /^co-manager$/i.test(m.teamName)));
});

test("the week scoreboard gives six games, and ONLY the requested week's", () => {
  const wk3 = parseYahooScheduleWeek(scoreboard, 3);
  assert.equal(wk3.length, 6);
  assert.deepEqual(wk3.map((g) => [g.homeId, g.awayId].join("-")).sort(), ["1-8", "11-7", "2-3", "4-12", "5-10", "6-9"]);
  // Every team appears exactly once.
  const seen = wk3.flatMap((g) => [g.homeId, g.awayId]).sort((a, b) => Number(a) - Number(b));
  assert.equal(new Set(seen).size, 12);
  // The page also renders last week's recap links; taking those too is how a schedule reader reports
  // last week's pairings as this week's.
  const withStale = scoreboard + '<a href="/f1/129048/matchup?week=1&mid1=11&mid2=4">Recap</a>';
  assert.equal(parseYahooScheduleWeek(withStale, 3).length, 6);
  assert.equal(parseYahooScheduleWeek(withStale, 1).length, 1);
  assert.equal(parseYahooScheduleWeek(scoreboard, 9).length, 0);
});
