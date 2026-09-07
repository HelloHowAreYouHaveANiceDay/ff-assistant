// HOW BIG IS THE HANDCUFF EFFECT, measured on our own history before anything is built on it?
//
//   node --import tsx scripts/handcuff-effect.mjs
//
// The claim to test is narrow and specific: when a team's lead back misses a week, how much more
// does the NEXT back on that team score than he does in weeks the lead back plays? Everything about
// whether handcuff modelling is worth building follows from that number, and from how much it
// varies -- a large mean lift with enormous spread is a lottery ticket, which is a different product
// decision from a reliable bump.
//
// WITHIN-TEAM, WITHIN-SEASON comparison, which is what makes it a measurement rather than a
// correlation. Comparing backups on teams whose starter got hurt against backups on teams whose
// starter stayed healthy would confound the effect with team quality, injury-prone rosters and
// garbage time. Comparing the SAME player on the SAME team in starter-out weeks vs starter-in weeks
// removes all of that: he is his own control.
import { readFileSync } from "node:fs";

const POS = process.argv[2] || "RB";
const L = readFileSync("data/history-weekly.csv", "utf8").trim().split(/\r?\n/);
const h = L[0].split(",");
const [SI, NI, PI, WI, YI, TI] = ["season", "name", "pos", "week", "points", "team"].map((c) => h.indexOf(c));

// season|team -> week -> name -> points
const byTeam = new Map();
const seasonTot = new Map();          // season|name -> total (to rank the depth chart after the fact)
for (const line of L.slice(1)) {
  const f = line.split(",");
  if (f[PI] !== POS || !f[TI]) continue;
  const key = `${f[SI]}|${f[TI]}`;
  if (!byTeam.has(key)) byTeam.set(key, new Map());
  const wk = byTeam.get(key);
  const w = Number(f[WI]);
  if (!wk.has(w)) wk.set(w, new Map());
  wk.get(w).set(f[NI], Number(f[YI]) || 0);
  const sk = `${f[SI]}|${f[NI]}`;
  seasonTot.set(sk, (seasonTot.get(sk) ?? 0) + (Number(f[YI]) || 0));
}

// A MISSED WEEK IS AN ABSENT ROW, and that has to be checked rather than assumed -- if the file
// instead carried explicit 0-point rows, "absent" would never fire and the whole measurement would
// silently compare nothing against nothing.
const weeksPerTeam = [...byTeam.values()].map((wk) => wk.size);
const rowsPerTeamWeek = [];
for (const wk of byTeam.values()) for (const m of wk.values()) rowsPerTeamWeek.push(m.size);
const zeroRows = [...byTeam.values()].reduce((a, wk) => {
  for (const m of wk.values()) for (const v of m.values()) if (v === 0) a++;
  return a;
}, 0);
console.log(`${POS}: ${byTeam.size} team-seasons, median ${weeksPerTeam.sort((a, b) => a - b)[weeksPerTeam.length >> 1]} weeks each`);
console.log(`  ${POS}s with a row in a given team-week: median ${rowsPerTeamWeek.sort((a, b) => a - b)[rowsPerTeamWeek.length >> 1]}`);
console.log(`  explicit 0.0-point rows: ${zeroRows} -- ${zeroRows > rowsPerTeamWeek.length * 0.05
  ? "PRESENT, so absence is encoded as a zero row and 'no row' alone would undercount misses"
  : "rare, so a missed week really is an ABSENT row"}\n`);

// For each team-season: rank by season total, then compare RB2's weeks with and without RB1.
const paired = [];      // one entry per (season, team, backup) that has both kinds of week
for (const [key, wk] of byTeam) {
  const [season, team] = key.split("|");
  const names = new Set();
  for (const m of wk.values()) for (const n of m.keys()) names.add(n);
  const ranked = [...names].sort((a, b) => (seasonTot.get(`${season}|${b}`) ?? 0) - (seasonTot.get(`${season}|${a}`) ?? 0));
  if (ranked.length < 2) continue;
  const lead = ranked[0];
  for (let d = 1; d < Math.min(3, ranked.length); d++) {
    const back = ranked[d];
    const withLead = [], withoutLead = [];
    for (const [, m] of wk) {
      const backPts = m.get(back);
      if (backPts == null) continue;                 // backup did not play -> tells us nothing
      const leadPlayed = m.has(lead) && m.get(lead) > 0;
      (leadPlayed ? withLead : withoutLead).push(backPts);
    }
    // Both arms must exist, and each needs enough weeks that its mean is not one game.
    if (withLead.length < 4 || withoutLead.length < 2) continue;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    paired.push({
      season: Number(season), team, back, depth: d + 1,
      on: mean(withLead), off: mean(withoutLead),
      nOn: withLead.length, nOff: withoutLead.length,
      lift: mean(withoutLead) - mean(withLead),
    });
  }
}

const q = (a, u) => { const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * u; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`PAIRED WITHIN-PLAYER COMPARISON -- ${paired.length} (season, team, backup) cases`);
console.log(`each case is the SAME player on the SAME team: his mean in weeks the lead back played,`);
console.log(`versus his mean in weeks the lead back did not.\n`);
console.log(`  depth    n     lead in    lead out     lift    x mult    p10 lift   p90 lift`);
for (const d of [2, 3]) {
  const g = paired.filter((p) => p.depth === d);
  if (g.length < 20) { console.log(`  ${d}${String(g.length).padStart(9)}   too few`); continue; }
  const lifts = g.map((p) => p.lift);
  const on = mean(g.map((p) => p.on)), off = mean(g.map((p) => p.off));
  console.log(`  ${d}  ${String(g.length).padStart(5)}  ${on.toFixed(2).padStart(9)}  ${off.toFixed(2).padStart(9)}  ${(off - on >= 0 ? "+" : "") + (off - on).toFixed(2).padStart(6)}  ${(off / (on || 1)).toFixed(2).padStart(7)}x  ${q(lifts, 0.1).toFixed(1).padStart(9)}  ${q(lifts, 0.9).toFixed(1).padStart(9)}`);
}

// SIGNIFICANCE, paired, with the case as the unit -- not the week. Weeks within a player are not
// independent, so pooling them would inflate n and manufacture a t-statistic out of nothing.
const d2 = paired.filter((p) => p.depth === 2).map((p) => p.lift);
if (d2.length > 2) {
  const m = mean(d2);
  const sd = Math.sqrt(d2.reduce((a, x) => a + (x - m) ** 2, 0) / (d2.length - 1));
  const se = sd / Math.sqrt(d2.length);
  console.log(`\n  DEPTH-2 lift: mean ${m >= 0 ? "+" : ""}${m.toFixed(2)} pts/wk   sd ${sd.toFixed(2)}   se ${se.toFixed(2)}   t = ${(m / se).toFixed(1)}`);
  console.log(`  positive in ${d2.filter((x) => x > 0).length}/${d2.length} cases (${(100 * d2.filter((x) => x > 0).length / d2.length).toFixed(0)}%)`);
  console.log(`\n  THE SPREAD IS THE PRODUCT DECISION, not the mean. A reliable small bump and a lottery`);
  console.log(`  ticket with the same mean call for different things: the first belongs in the`);
  console.log(`  projection, the second belongs in a ranked list of who to stash and is worth owning`);
  console.log(`  precisely BECAUSE the payoff is skewed.`);
}
