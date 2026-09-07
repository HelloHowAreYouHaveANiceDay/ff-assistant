// FROZEN MEASUREMENT -- 2026-09-07. Re-running this does NOT measure the current system.
//
// The per-season arrays below are hardcoded results captured from specific backtest runs on that
// day's code. They are kept because they are the arithmetic behind a recorded conclusion, and a
// claim of significance should be reproducible rather than asserted. They are NOT a live check.
//
// SUPERSEDED, and by how much: the "with K/DST" arm was measured before the DST scoring was
// ground-truthed against ESPN and before the projection curve was rebuilt, both later the same day.
// The current headline is 35.5% (2015-2024, n=150), not the 35.6% below. The +7.5pp conclusion
// survives -- every later change measured neutral within noise -- but quote validation.md for the
// LEVEL and this file only for the DELTA it computes.
//
// Two paired tests on the K/DST rebuild, both in the documented headline mode
// (--full --no-lookahead, n=150, identical seeds so the only variable is the one under test).
// Unit of generalization is the SEASON (10), never the trial (1500).
const YEARS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];

const arms = {
  "history WITHOUT K/DST":       [15, 19, 23, 33, 32, 34, 38, 38, 25, 24],
  "history WITH K/DST":          [24, 21, 41, 35, 41, 35, 49, 49, 22, 39],
  "with K/DST, maxKDst UNCAPPED": [15, 17, 29, 43, 43, 39, 49, 41, 26, 40],
};

function paired(aName, bName) {
  const a = arms[aName], b = arms[bName];
  const d = b.map((x, i) => x - a[i]);
  const n = d.length;
  const mean = d.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(d.reduce((x, v) => x + (v - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = mean / se;
  const crit = 2.26; // df=9, p<0.05 two-tailed
  console.log(`\n${bName}  MINUS  ${aName}`);
  console.log("  per season: " + YEARS.map((y, i) => `${y}:${d[i] >= 0 ? "+" : ""}${d[i]}`).join("  "));
  console.log(`  mean ${mean >= 0 ? "+" : ""}${mean.toFixed(1)}pp   sd ${sd.toFixed(2)}   se ${se.toFixed(2)}   t = ${t.toFixed(2)}`);
  console.log(`  95% CI  ${(mean - crit * se).toFixed(1)} to ${(mean + crit * se).toFixed(1)} pp`);
  console.log(`  ${Math.abs(t) > crit ? "*** SIGNIFICANT ***" : "not significant"} (|t| > ${crit} needed at df=${n - 1})`);
  return { mean, t };
}

console.log("K/DST REBUILD -- paired season tests, headline mode (--full --no-lookahead, n=150)");
paired("history WITHOUT K/DST", "history WITH K/DST");
console.log(`
  What this measures is NOT that the strategy got better. It is that the backtest was UNDERSTATING
  it: with no kickers or defenses in the draft pool, every one of the 16 teams played all season
  with two starting slots EMPTY. Fewer scoring starters means higher relative weekly variance, and
  higher variance dilutes skill -- so a real edge converted to titles less often than it should
  have. Filling the slots restores the signal.`);

paired("history WITH K/DST", "with K/DST, maxKDst UNCAPPED");
console.log(`
  maxKDst is measured here for the FIRST TIME. Before the rebuild the lever was inert -- --max-kdst
  2 and --max-kdst 60 returned an identical 36.5%, because a cap on K/DST spending cannot bind when
  the pool contains no K or DST to buy. The shipped default of 2 was reasoning, not measurement.
  It now moves the number in the expected direction, but read the CI before treating it as settled.`);
