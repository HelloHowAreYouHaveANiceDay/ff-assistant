/**
 * WHAT MOVES WHEN THE CALENDAR MOVES -- the four-cell sensitivity of the championship tripwire to
 * the two things the calendar can differ in.
 *
 * This script does not run the backtests; it PRINTS THE EXACT COMMANDS, in order.
 *
 * WHAT CHANGED IN INTEGRATION PASS 3, and it matters for anyone holding the old block: this used to
 * print `ff format set` writes (which mutate the store's config for the duration of a cell) and an
 * `FF_SEEDING=` environment prefix. Both are gone. The calendar and the bracket are ordinary
 * `ff backtest` FLAGS now, defaulted from the league's own format block, so:
 *
 *   - no cell mutates the store, so a half-finished sweep cannot leave the machine configured for a
 *     league nobody chose, and there is no restore step to forget;
 *   - the cells no longer have to run adjacent to share a config;
 *   - and, critically, `FF_SEEDING` IS NO LONGER READ AT ALL. A copy of this script from before the
 *     change prints commands that appear to sweep the seeding rule and in fact run the same cell
 *     four times -- four identical numbers that read as "the seeding rule does not matter".
 *
 * The cells, all at 1999-2024 n=150, a 7-team field, and a RESEEDING bracket (which is what both
 * simulators have always done and what ESPN says this league does):
 *   (a) 14 regular weeks, playoffs 15/16/17, record seeding      -- the LEGACY tripwire, 38.1%
 *   (b) 13 regular weeks, playoffs 14/15/16, record seeding
 *   (c) 14 regular weeks, playoffs 15/16/17, division-winners-first
 *   (d) 13 regular weeks, playoffs 14/15/16, division-winners-first -- the EFFECTIVE format today,
 *       and therefore what the flagless run reproduces
 *
 * Cells must still be run SEQUENTIALLY: two concurrent backtests on this machine turned a two-minute
 * job into a two-hour stall.
 *
 * Usage: node scripts/format-sensitivity.mjs
 */
const BT = "npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150";
const cells = [
  ["a", "14wk 15/16/17 record  (the legacy tripwire)", 14, "record", "data/trials/F-a-legacy.tsv"],
  ["b", "13wk 14/15/16 record", 13, "record", "data/trials/F-b-13wk.tsv"],
  ["c", "14wk 15/16/17 division-winners-first", 14, "division-winners-first", "data/trials/F-c-14wk-div.tsv"],
  ["d", "13wk 14/15/16 division-winners-first  (TODAY'S FORMAT)", 13, "division-winners-first", "data/trials/F-d-effective.tsv"],
];
console.log("# Run these IN ORDER, one at a time. None of them writes to the store.");
console.log("npm run ff -- format show        # confirm what the flagless run would use\n");
for (const [id, label, regWeeks, seeding, dump] of cells) {
  console.log(`# --- cell (${id}): ${label} ---`);
  console.log(`${BT} --reg-weeks ${regWeeks} --playoff-teams 7 --seeding ${seeding} --playoff-reseed true --dump-trials ${dump}\n`);
}
console.log("# Paired statistics -- the aggregate percentages cannot support this comparison.");
for (const [id, , , , dump] of cells.slice(1)) {
  console.log(`node scripts/paired-analysis.mjs data/trials/F-a-legacy.tsv ${dump}   # a vs ${id}`);
}
console.log("\n# Nothing to restore: no cell touched the config.");
