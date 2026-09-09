/**
 * WHAT MOVES WHEN THE CALENDAR MOVES -- the four-cell sensitivity of the championship tripwire to
 * the two things the owner has not yet settled.
 *
 * This script does not run the backtests; it PRINTS THE EXACT COMMANDS, in order, including the
 * config writes that change the calendar and the restore at the end. It is a script rather than a
 * paragraph in a doc because the ordering is load-bearing: cells (b) and (d) require the store to
 * hold a 13-week format while they run, so a sweep left half-finished leaves the machine configured
 * for a league the owner has not chosen. Run it, read it, and paste the block.
 *
 * The cells:
 *   (a) 14 regular weeks, playoffs 15/16/17, record seeding      -- today; must reproduce 38.1%
 *   (b) 13 regular weeks, playoffs 14/15/16, record seeding
 *   (c) 14 regular weeks, playoffs 15/16/17, division-winners-first
 *   (d) 13 regular weeks, playoffs 14/15/16, division-winners-first
 *
 * Cells must be run SEQUENTIALLY. Two concurrent backtests on this machine turned a two-minute job
 * into a two-hour stall, and here they would also fight over one config row.
 *
 * Usage: node scripts/format-sensitivity.mjs
 */
const BT = "npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150 --dump-trials";
const cells = [
  ["a", "14wk 15/16/17 record", null, "record", "data/trials/E-a-base.tsv"],
  ["b", "13wk 14/15/16 record", "ff format set --reg-weeks 13 --playoff-weeks 14,15,16 --seeding record", "record", "data/trials/E-b-13wk.tsv"],
  ["d", "13wk 14/15/16 division", null, "division-winners-first", "data/trials/E-d-13wk-div.tsv"],
  ["c", "14wk 15/16/17 division", "ff format sync --from-cache --adopt", "division-winners-first", "data/trials/E-c-14wk-div.tsv"],
];
console.log("# Run these IN ORDER, one at a time. (b) and (d) share the 13-week config, so they are adjacent.");
console.log("npm run ff -- format sync --from-cache --adopt        # start from ESPN's block\n");
for (const [id, label, setup, seeding, dump] of cells) {
  console.log(`# --- cell (${id}): ${label} ---`);
  if (setup) console.log(`npm run ff -- ${setup.replace(/^ff /, "")}`);
  const env = seeding === "record" ? "" : `FF_SEEDING=${seeding} `;
  console.log(`${env}${BT} ${dump}\n`);
}
console.log("# Paired statistics -- the aggregate percentages cannot support this comparison.");
for (const [id, , , , dump] of cells.slice(1)) {
  console.log(`node scripts/paired-analysis.mjs data/trials/E-a-base.tsv ${dump}   # a vs ${id}`);
}
console.log("\n# RESTORE. Leave the store holding what ESPN says, not the last cell's calendar.");
console.log("npm run ff -- format sync --from-cache --adopt");
console.log("npm run ff -- format show");
