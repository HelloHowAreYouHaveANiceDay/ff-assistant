// FROZEN MEASUREMENT -- 2026-09-07. Re-running this does NOT measure the current system.
//
// The per-season arrays below are hardcoded results captured from specific backtest runs on that
// day's code, kept because they are the arithmetic behind a recorded conclusion. Both arms predate
// the K/DST history rebuild, the DST scoring ground-truthing and the projection-curve fix, so the
// LEVELS are stale; the DELTA is what this file exists to compute and it is the part that stands.
//
// Paired test: does standard divisional play change the championship rate, or only its realism?
// Both arms use identical seeds, so the DRAFTS are identical and the schedule is the only variable.
// The unit of generalization is the SEASON (11 here), not the trial -- per-season rates are highly
// correlated within a season, so pooling 1650 trials would overstate confidence badly.
const base = { 2014: 25, 2015: 33, 2016: 29, 2017: 31, 2018: 39, 2019: 27, 2020: 30, 2021: 38, 2022: 39, 2023: 29, 2024: 41 };
const divi = { 2014: 28, 2015: 33, 2016: 31, 2017: 39, 2018: 34, 2019: 26, 2020: 39, 2021: 37, 2022: 36, 2023: 27, 2024: 42 };

const years = Object.keys(base);
const d = years.map((y) => divi[y] - base[y]);
const n = d.length;
const mean = d.reduce((a, b) => a + b, 0) / n;
const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
const se = sd / Math.sqrt(n);
const t = mean / se;

console.log("per-season championship rate, divisional minus random pairing (pp):");
console.log("  " + years.map((y, i) => `${y}:${d[i] >= 0 ? "+" : ""}${d[i]}`).join("  "));
console.log(`\n  seasons        ${n}`);
console.log(`  mean delta     ${mean >= 0 ? "+" : ""}${mean.toFixed(2)} pp`);
console.log(`  sd / se        ${sd.toFixed(2)} / ${se.toFixed(2)}`);
console.log(`  t              ${t.toFixed(2)}   (|t| > 2.23 needed at df=${n - 1}, p<0.05)`);
console.log(`  95% CI         ${(mean - 2.23 * se).toFixed(1)} to ${(mean + 2.23 * se).toFixed(1)} pp`);
console.log(`\n  ${Math.abs(t) > 2.23 ? "SIGNIFICANT" : "NOT SIGNIFICANT"} -- ${Math.abs(t) > 2.23
  ? "the schedule model changes the measured edge."
  : "the schedule model does NOT move the headline number. Random pairing was UNBIASED, so this\n  was the expected result: the fix buys realism (a repeat cap and correlated schedule risk),\n  not a different answer, and it confirms the historical championship figures were not\n  distorted by the missing schedule."}`);
