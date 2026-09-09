// SUPERSEDED by scripts/season-calibration.mjs (Phase 2c, 2026-09-09). It refuses to run.
//
// This script asked the right question -- does an 18% happen 18% of the time? -- and could not
// answer it, for a reason that no longer holds: the league's outcomes were not in the store. So it
// ran on a GENERATED schedule and, absent `data/league-outcomes.json`, on outcomes DRAWN FROM THE
// SIMULATOR'S OWN PROBABILITIES. That fixture mode was honest about itself, and it is exactly the
// thing that must not be left lying next to a real harness: a Brier score computed against
// simulated outcomes looks precisely like one computed against real ones.
//
// `fact_team_season` (130 rows, 2018-2026, with wins, seeds, final ranks and a derived champion
// flag) and `fact_matchup` (1,050 real games) landed in Phase 2c, so the real measurement is now
// possible and is what `season-calibration.mjs` does: real rosters, the real schedule, the real
// outcomes, 114 team-seasons, plus the shuffled-outcome control this script invented.
//
// Refusing rather than deleting, because a script that quietly disappears takes its reasoning with
// it -- and the fixture-vs-real distinction above is the part worth keeping.
console.error(
  "scripts/sim-calibration.mjs is SUPERSEDED. It scored the simulator against a GENERATED schedule\n" +
  "and, without data/league-outcomes.json, against outcomes drawn from the simulator itself.\n" +
  "The league's real schedule and outcomes are in the store since Phase 2c. Run instead:\n\n" +
  "  node --import tsx scripts/season-calibration.mjs --seasons 2018-2025 --trials 3000\n",
);
process.exit(2);
