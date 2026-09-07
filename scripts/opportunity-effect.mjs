// FROZEN MEASUREMENT -- 2026-09-07. Re-running this does NOT measure the current system; the arrays
// below are hardcoded results captured from specific backtest runs on that day's code.
//
// Does the opportunity model convert its R-squared gain into CHAMPIONSHIPS? Paired by season,
// identical seeds, headline mode (--full --no-lookahead, age curve ON in both arms), the opportunity
// adjustment as the only variable. The unit of generalization is the SEASON, so df comes from the
// season count and not the trial count.
//
// THE FIRST RUN OF THIS WAS A NON-MEASUREMENT AND SAID "NO EFFECT". Usage had been baked only from
// 2015, so for 2006-2015 the factor was exactly 1 and the two arms were the SAME SYSTEM. It returned
// 36.6% vs 36.5% and would have been read as a clean null. What gave it away was not the summary but
// the per-season rows: ten of nineteen were byte-identical, which no stochastic A/B ever produces.
// Extending the fit to 2006 (the columns were there the whole time) made every season differ.
//
// Keep the dead arm here. A null that came from a disconnected treatment looks exactly like a null
// that came from an ineffective one, and the difference is the entire finding.
const WINDOWS = {
  "19 seasons, model baked from 2015 only (NON-MEASUREMENT)": {
    off: { 2006: 50, 2007: 19, 2008: 29, 2009: 39, 2010: 33, 2011: 54, 2012: 50, 2013: 30, 2014: 21, 2015: 31,
           2016: 34, 2017: 37, 2018: 42, 2019: 31, 2020: 34, 2021: 37, 2022: 55, 2023: 24, 2024: 44 },
    on:  { 2006: 50, 2007: 19, 2008: 29, 2009: 39, 2010: 33, 2011: 54, 2012: 50, 2013: 30, 2014: 21, 2015: 31,
           2016: 28, 2017: 35, 2018: 38, 2019: 32, 2020: 39, 2021: 40, 2022: 48, 2023: 32, 2024: 46 },
    crit: 2.10, note: "10/19 seasons identical -- the treatment was absent, not ineffective",
  },
  "19 seasons, model baked from 2006 (REAL)": {
    off: { 2006: 50, 2007: 19, 2008: 29, 2009: 39, 2010: 33, 2011: 54, 2012: 50, 2013: 30, 2014: 21, 2015: 31,
           2016: 34, 2017: 37, 2018: 42, 2019: 31, 2020: 34, 2021: 37, 2022: 55, 2023: 24, 2024: 44 },
    on:  { 2006: 53, 2007: 20, 2008: 36, 2009: 42, 2010: 33, 2011: 57, 2012: 52, 2013: 38, 2014: 28, 2015: 28,
           2016: 30, 2017: 31, 2018: 43, 2019: 33, 2020: 39, 2021: 43, 2022: 52, 2023: 30, 2024: 48 },
    crit: 2.10, note: "every season differs",
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
  const identical = d.filter((x) => x === 0).length;
  console.log(`\n${label}`);
  console.log(`  ${w.note}`);
  console.log(`  per season: ${d.map((x) => (x >= 0 ? "+" : "") + x).join(" ")}`);
  console.log(`  mean ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}pp   sd ${sd.toFixed(2)}   se ${se.toFixed(2)}   t = ${t.toFixed(2)}   (need |t| > ${w.crit})`);
  console.log(`  95% CI  ${(mean - w.crit * se).toFixed(1)} to ${(mean + w.crit * se).toFixed(1)} pp`);
  console.log(`  better in ${d.filter((x) => x > 0).length}/${n}, worse in ${d.filter((x) => x < 0).length}, identical in ${identical}`);
  console.log(`  ${Math.abs(t) > w.crit ? "*** SIGNIFICANT ***" : "not significant"}`);
}

console.log(`
WHAT IS ESTABLISHED, stated narrowly.

The PROJECTION improves, per position and out of sample, over twenty seasons and with two null
controls holding: RB +0.0186, WR +0.0148, TE +0.0218, QB ~0. Efficiency metrics (racr) come back
NEGATIVE, which is what the literature predicts and what makes the positives believable.

The CHAMPIONSHIP translation is the first adjustment in this codebase to clear its bar rather than
merely point the right way -- compare the age curve at +0.6pp, t = 0.40. It is worth being precise
about why that is easier to believe here: the effect survives a fit whose per-position signals SHRANK
when the sample doubled (RB +0.0289 -> +0.0186 going from 10 seasons to 20), which is the signature
of removing overfit rather than adding it.

The caveat that does not go away: the baseline in the feature test is prior-season rank standing in
for ECR, because historical ECR is not something we hold. That baseline is WEAKER than what ships, so
the R-squared gains are an upper bound on what a consensus-beating model would show.`);
