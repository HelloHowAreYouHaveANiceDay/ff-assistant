/**
 * THE YAHOO SETTINGS READER, pinned to the league's OWN SAVED PAGE.
 *
 * `config:129048` was, until 2026-09-16, a byte copy of the ESPN league's config with three fields
 * edited: it carried ESPN's 13-week/7-team playoff calendar, ESPN's four divisions with ESPN's team
 * ids, ESPN's half-PPR `rec 0.5`, ESPN's kicker and defense rule sets for a league that rosters
 * neither, a `$200` auction budget for a SNAKE draft, and `"League Name":"seacaptaindate.com"`. Nothing
 * failed on any of it -- a config inherited from another league passes every shape check there is.
 *
 * So these tests read the real settings page (test/fixtures/yahoo/settings-129048.html, saved from the
 * live site through the app's logged-in webview) and assert the reader produces the league that page
 * describes. The decisive one is `scoringKey` matching the ground-truthed constant: the hash is
 * content-derived, so it cannot agree by coincidence.
 *
 * FAULT INJECTION is at the bottom: each refusal is shown FIRING against a page with the row removed,
 * because a guard that has never been watched to fail is indistinguishable from one that is not wired.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYahooScoringTables, parseYahooSettingsTable, yahooScoringFromTables } from "../src/league/yahooDom.js";
import { yahooSettingsFromHtml, yahooSlot, parseYahooPlayoffs, yahooUrls } from "../src/league/yahoo.js";
import { scoringKey } from "../src/data/formatKey.js";
import { YAHOO_129048_SCORING, DEFAULT_SCORING } from "../src/draft/scoring.js";
import { validateFormat } from "../src/league/index.js";

const FIX = join("test", "fixtures", "yahoo");
const settingsHtml = readFileSync(join(FIX, "settings-129048.html"), "utf8");
const managersHtml = readFileSync(join(FIX, "teams-129048.html"), "utf8");
const read = () => yahooSettingsFromHtml(settingsHtml, { leagueId: "129048", season: 2026, managersHtml, now: new Date("2026-09-16T02:41:00") });

test("the settings table is read by TABLE, not by a class on a cell", () => {
  const t = parseYahooSettingsTable(settingsHtml);
  // `League ID#` is the one row whose cells carry NO `typeStandard` class. Keying on that class -- the
  // obvious selector -- dropped exactly the row the identity guard depends on.
  assert.equal(t["League ID#"], "129048");
  assert.equal(t["League Name"], "Fappening World Cup Edition");
  assert.equal(t["Max Teams"], "12");
  assert.equal(t["Draft Type"], "Live Standard Draft");
  assert.equal(t["Roster Positions"], "QB, WR, WR, RB, RB, TE, W/R/T, W/R/T, W/R/T, Q/W/R/T, BN, BN, BN, BN, BN, BN, BN, IR, IR");
  assert.equal(t["Playoffs"], "8 teams - Week 15, 16 and 17 (ends Monday, Jan 4)");
  assert.equal(t["Playoff Reseeding"], "Yes");
  assert.equal(t["Divisions"], "No");
  assert.equal(t["Waiver Type"], "FAB w/ Continual rolling list tiebreak");
  assert.equal(t["Weekly Waivers"], "Game Time - Tuesday");
});

test("all FOUR scoring groups are found -- they are one <table> with four <thead>s", () => {
  // The four position groups are NOT four tables. Splitting on `</table>` returns only QB, and since
  // QB carries every stat the result LOOKS complete -- it would just have given every position the
  // QB reception rate and silently lost the TE premium.
  const groups = parseYahooScoringTables(settingsHtml);
  assert.deepEqual(groups.map((g) => g.group), ["QB", "RB", "WR", "TE"]);
  assert.equal(groups.find((g) => g.group === "QB")!.rows["Receptions"], "1");
  assert.equal(groups.find((g) => g.group === "TE")!.rows["Receptions"], "1.5");
});

test("the scoring model read from the page equals the ground-truthed constant, term for term", () => {
  const { rules, unmapped } = yahooScoringFromTables(parseYahooScoringTables(settingsHtml));
  const keys = [...new Set([...Object.keys(rules), ...Object.keys(YAHOO_129048_SCORING)])].sort();
  for (const k of keys) {
    assert.deepEqual(
      (rules as unknown as Record<string, unknown>)[k],
      (YAHOO_129048_SCORING as unknown as Record<string, unknown>)[k],
      `scoring term "${k}" read from the page does not match YAHOO_129048_SCORING`,
    );
  }
  // The content hash is the check that cannot agree by accident -- and it is the key of the format
  // directory the Yahoo model is already trained in (data/formats/sc-a845f67652fb).
  assert.equal(scoringKey(rules), "sc-a845f67652fb");
  assert.notEqual(scoringKey(rules), scoringKey(DEFAULT_SCORING));
  // Two terms Yahoo scores that `ScoringRules` cannot express. Reported, never dropped in silence.
  assert.deepEqual(Object.keys(unmapped).sort(), ["Offensive Fumble Return TD", "Return Touchdowns"]);
});

test("Yahoo slot tokens normalize to OUR vocabulary -- and BN must become BE", () => {
  assert.equal(yahooSlot("W/R/T"), "FLEX");
  assert.equal(yahooSlot("Q/W/R/T"), "SUPERFLEX");
  assert.equal(yahooSlot("IR"), "IR");
  assert.equal(yahooSlot("QB"), "QB");
  // NOT cosmetic: every "is this a bench slot?" test in the repo spells the bench BE|BENCH(|IR|ER).
  // A literal `BN` matches none of them, so seven bench slots would count as seven STARTING slots at a
  // position called "BN" and move every replacement level in the league.
  assert.equal(yahooSlot("BN"), "BE");
  assert.match(String(/^(BE|BENCH|IR|ER)$/i.test(yahooSlot("BN"))), /true/);
});

test("the whole config: teams, slots, draft type, budget, calendar, waivers", () => {
  const s = read();
  assert.equal(s.platform, "yahoo");
  assert.equal(s.leagueId, "129048");
  assert.equal(s.name, "Fappening World Cup Edition");
  assert.equal(s.teams, 12);
  assert.deepEqual(s.slots, ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "FLEX", "FLEX", "SUPERFLEX", "BE", "BE", "BE", "BE", "BE", "BE", "BE", "IR", "IR"]);
  assert.equal(s.slots.filter((x) => x === "BE").length, 7);
  assert.equal(s.draftType, "snake");
  // A snake draft has no dollars. `null`, not 200 -- the stored 200 came from the ESPN league.
  assert.equal(s.budget, null);
  assert.equal(s.scoringBucket, "PPR");
  // This league rosters no K and no D/ST, so it HAS no kicking or defensive rules. Null says that;
  // ESPN's constants (which is what was stored) say the opposite and look identical in the store.
  assert.equal(s.kicker, null);
  assert.equal(s.defense, null);
  assert.equal(s.acquisition.waivers, true);
  assert.equal(s.acquisition.faabBudget, 100);        // observed: a team with zero moves shows $100
  assert.deepEqual(s.acquisition.processDays, ["Tuesday"]);
  assert.equal(s.acquisition.seasonLimit, null);      // "No maximum"
  assert.equal(s.acquisition.weeklyLimit, null);
  assert.equal(s.rosterSettings["League Name"], "Fappening World Cup Edition");
});

test("the format block is Yahoo's calendar, not ESPN's", () => {
  const f = read().format;
  validateFormat(f, "yahoo 129048");                  // shape + self-consistency
  assert.equal(f.regWeeks, 14);                       // ESPN's was 13
  assert.equal(f.playoffTeams, 8);                    // ESPN's was 7
  assert.deepEqual(f.playoffWeeks, [15, 16, 17]);     // ESPN's was [14,15,16]
  assert.equal(f.playoffRoundWeeks, 1);
  assert.equal(f.playoffReseed, true);
  assert.equal(f.seeding, "record");                  // the page says "Divisions: No" outright
  assert.deepEqual(f.divisions, []);                  // ESPN's four divisions carried ESPN TEAM IDS
  assert.equal(f.tiebreak, "Best regular season record vs opponent wins");
  assert.equal(f.source, "owner-override");
  assert.match(String(f.note), /football\.fantasysports\.yahoo\.com\/f1\/129048\/settings/);
});

test("the playoff cell parser", () => {
  assert.deepEqual(parseYahooPlayoffs("8 teams - Week 15, 16 and 17 (ends Monday, Jan 4)"), { teams: 8, weeks: [15, 16, 17] });
  assert.deepEqual(parseYahooPlayoffs("4 teams - Week 16 and 17"), { teams: 4, weeks: [16, 17] });
  // The parenthetical carries a DATE; a reader that scraped every digit would read "4" as a week.
  assert.deepEqual(parseYahooPlayoffs("6 teams - Week 15, 16 and 17 (ends Monday, Jan 4)").weeks, [15, 16, 17]);
});

test("URL builders", () => {
  assert.equal(yahooUrls.settings("129048"), "https://football.fantasysports.yahoo.com/f1/129048/settings");
  assert.equal(yahooUrls.rosters("129048"), "https://football.fantasysports.yahoo.com/f1/129048/starters");
  assert.equal(yahooUrls.team("129048", "11"), "https://football.fantasysports.yahoo.com/f1/129048/11");
  assert.equal(yahooUrls.team("129048", null), "https://football.fantasysports.yahoo.com/f1/129048");
  assert.equal(yahooUrls.scoreboard("129048", 3), "https://football.fantasysports.yahoo.com/f1/129048/?matchup_week=3");
});

// ---------------------------------------------------------------------------------------------
// FAULT INJECTION -- each refusal watched to FIRE.
// ---------------------------------------------------------------------------------------------

test("a page for ANOTHER league is refused before anything is returned", () => {
  const other = settingsHtml.replace("<b>129048</b>", "<b>999999</b>");
  assert.throws(() => yahooSettingsFromHtml(other, { leagueId: "129048", season: 2026 }), /REFUSED.*asked for league 129048 but the page is league 999999/s);
});

test("a MISSING row throws and names itself -- it is never defaulted", () => {
  for (const [row, pattern] of [
    ["Roster&nbsp;Positions:", /Roster Positions/],
    ["Playoffs:", /Playoffs/],
    ["Max Teams:", /Max Teams/],
    ["Waiver Type:", /Waiver Type/],
  ] as [string, RegExp][]) {
    const i = settingsHtml.indexOf(row);
    assert.ok(i > 0, `fixture no longer contains "${row}" -- this fault injection is not injecting anything`);
    const start = settingsHtml.lastIndexOf("<tr", i);
    const end = settingsHtml.indexOf("</tr>", i) + 5;
    const broken = settingsHtml.slice(0, start) + settingsHtml.slice(end);
    assert.throws(() => yahooSettingsFromHtml(broken, { leagueId: "129048", season: 2026 }), pattern, `removing the "${row}" row did not make the reader refuse`);
  }
});

test("a Yes/No setting that is neither throws rather than being read as false", () => {
  const broken = settingsHtml.replace(/(Playoff Reseeding:<\/td>[\s\S]{0,200}?<b>)Yes(<\/b>)/, "$1Maybe$2");
  assert.notEqual(broken, settingsHtml, "the Playoff Reseeding cell was not actually changed");
  assert.throws(() => yahooSettingsFromHtml(broken, { leagueId: "129048", season: 2026 }), /Playoff Reseeding.*not Yes or No/s);
});

test("a per-position disagreement on a FLAT term refuses rather than flattening it", () => {
  // Receptions legitimately differ by position (TE premium) and are carried as recByPos. Anything
  // ELSE differing means the league is not one rule set, and taking the QB table's value silently
  // would be the fabrication this whole reader exists to remove.
  const i = settingsHtml.indexOf("Offense (TE)");
  const broken = settingsHtml.slice(0, i) + settingsHtml.slice(i).replace(/(Rushing Touchdowns<\/td>\s*<td><b>)6(<\/b>)/, "$19$2");
  assert.notEqual(broken, settingsHtml, "the TE Rushing Touchdowns cell was not actually changed");
  assert.throws(() => yahooScoringFromTables(parseYahooScoringTables(broken)), /Rushing Touchdowns.*6 for QB but 9 for TE/s);
});

test("a league that DOES roster K or DST is refused, not handed null rules", () => {
  const broken = settingsHtml.replace("BN, BN, BN, BN, BN, BN, BN, IR, IR", "K, DEF, BN, BN, BN, BN, BN, IR, IR");
  assert.notEqual(broken, settingsHtml, "the Roster Positions cell was not actually changed");
  assert.throws(() => yahooSettingsFromHtml(broken, { leagueId: "129048", season: 2026 }), /rosters K and DST/);
});
