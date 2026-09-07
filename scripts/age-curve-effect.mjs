// FROZEN MEASUREMENT -- 2026-09-07. Re-running this does NOT measure the current system; the arrays
// below are hardcoded results captured from specific backtest runs on that day's code.
//
// Does the age curve convert its R-squared gain into CHAMPIONSHIPS? Paired by season, identical
// seeds, headline mode (--full --no-lookahead), the age curve as the only variable.
//
// Two windows because ten seasons could not settle it. The unit of generalization is the SEASON, so
// df comes from the season count, not the trial count -- a 10-season window has 9 df and needs
// |t| > 2.26, which is a high bar for a real-but-modest effect.
const WINDOWS = {
  "20 seasons, OVER-AMPLIFIED curve (superseded)": {
    off: { 2005: 14, 2006: 47, 2007: 20, 2008: 25, 2009: 42, 2010: 22, 2011: 52, 2012: 55, 2013: 40, 2014: 19,
           2015: 19, 2016: 29, 2017: 38, 2018: 34, 2019: 35, 2020: 38, 2021: 38, 2022: 48, 2023: 23, 2024: 46 },
    on:  { 2005: 16, 2006: 43, 2007: 28, 2008: 29, 2009: 33, 2010: 28, 2011: 61, 2012: 50, 2013: 30, 2014: 32,
           2015: 38, 2016: 26, 2017: 37, 2018: 36, 2019: 35, 2020: 36, 2021: 48, 2022: 46, 2023: 23, 2024: 49 },
    crit: 2.09,
  },
  "20 seasons, SHIPPED signal-scaled curve": {
    off: { 2005: 14, 2006: 47, 2007: 20, 2008: 25, 2009: 42, 2010: 22, 2011: 52, 2012: 55, 2013: 40, 2014: 19,
           2015: 19, 2016: 29, 2017: 38, 2018: 34, 2019: 35, 2020: 38, 2021: 38, 2022: 48, 2023: 23, 2024: 46 },
    on:  { 2005: 17, 2006: 51, 2007: 19, 2008: 19, 2009: 38, 2010: 36, 2011: 55, 2012: 51, 2013: 32, 2014: 16,
           2015: 20, 2016: 35, 2017: 34, 2018: 45, 2019: 35, 2020: 32, 2021: 31, 2022: 56, 2023: 24, 2024: 49 },
    crit: 2.09,
  },
};

for (const [label, w] of Object.entries(WINDOWS)) {
  const years = Object.keys(w.off);
  const d = years.map((y) => w.on[y] - w.off[y]);
  const n = d.length;
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = mean / se;
  const wins = d.filter((x) => x > 0).length, losses = d.filter((x) => x < 0).length;
  console.log(`\n${label}`);
  console.log(`  per season: ${years.map((y, i) => `${d[i] >= 0 ? "+" : ""}${d[i]}`).join(" ")}`);
  console.log(`  mean ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}pp   sd ${sd.toFixed(2)}   se ${se.toFixed(2)}   t = ${t.toFixed(2)}   (need |t| > ${w.crit})`);
  console.log(`  95% CI  ${(mean - w.crit * se).toFixed(1)} to ${(mean + w.crit * se).toFixed(1)} pp`);
  console.log(`  better in ${wins}/${n} seasons, worse in ${losses}`);
  console.log(`  ${Math.abs(t) > w.crit ? "*** SIGNIFICANT ***" : "not significant"}`);
}

console.log(`
THE SHIPPED CURVE SCORES WORSE ON CHAMPIONSHIPS THAN THE ONE IT REPLACED, AND THAT IS THE POINT.

The first curve gave QB the widest age swing (1.25 -> 0.83) on the SMALLEST measured per-position
signal (+0.0072 R-squared) and gave TE a full curve on no signal at all (-0.0019). Scaling each
position's amplitude to its own measured out-of-sample lift -- RB 100%, WR 55%, QB 20%, TE flat --
cut the championship delta from +2.0pp to +0.6pp.

A noise-fit can score well on any single measurement. The over-amplified curve looked BETTER on
championships while being worse statistically, which is exactly the trap a backtest sets when it is
the only arbiter. The per-position R-squared test is the stronger evidence and it says the shipped
amplitudes are right.

WHAT IS ACTUALLY ESTABLISHED: age improves the PROJECTION, per position and out-of-sample --
RB +0.0369, WR +0.0204, QB +0.0072, TE nothing. The championship translation is +0.6pp with t = 0.40,
i.e. not established at all. Shipped because the board feeds trades, waivers and season odds as well
as the draft, and the projection improvement is real for all of them -- NOT because it wins titles.`);
