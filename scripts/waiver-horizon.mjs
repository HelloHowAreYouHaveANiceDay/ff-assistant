// HORIZON-CORRECT WAIVER RANKING -- does a matchup-NEUTRAL projection rank rest-of-season value
// better than the one-week matchup-adjusted challenger?
//
//   node --import tsx scripts/waiver-horizon.mjs [--seasons 2018-2025]
//
// THE QUESTION (frontier #1). The waiver backtest ranks free agents by the WEEK-w projection and
// scores them on realised REST-OF-SEASON points per game from week w forward. The challenger's
// week-w projection is matchup-adjusted for week w's specific opponent (the `dvp_mult` feature). For
// a MULTI-WEEK roster add that one-week opponent tilt is noise -- a ROS decision wants the
// matchup-NEUTRAL rate. This tests exactly that: the same challenger with every `dvp_mult`
// coefficient zeroed (matchup-neutral) against the shipped one-week challenger, on the SAME pool,
// the SAME weeks, the SAME room. It touches no model file -- the neutral artifact is built in memory
// by zeroing one feature's coefficients, and fed through the `artifactOverride` seam.
//
// It also measures the SHIPPING arm (`served` = per-position WEEKLY_SERVE) on the waiver backtest,
// which the existing inseason-backtest-waiver.mjs never runs (it only runs floor and challenger).
//
// DISCIPLINE: the unit is the SEASON. Every comparison is a paired season bootstrap over the 8
// seasons, never a pooled pool of adds. And the matchup-neutral artifact is FAULT-INJECTED: it must
// actually change the picks, or a null is indistinguishable from a disconnected lever.
import Database from "better-sqlite3";
import { backtestWaivers } from "../src/inseason/backtest/waiver.ts";
import { loadWeeklyArtifact } from "../src/weekly/projector.ts";
import { readFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [lo, hi] = arg("--seasons", "2018-2025").split("-").map(Number);
const seasons = []; for (let y = lo; y <= hi; y++) seasons.push(y);

const db = new Database("data/ff.db", { readonly: true });
const leagueId = db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get().league_id;

// --- build the matchup-neutral challenger: zero every dvp_mult coefficient ---
const raw = JSON.parse(readFileSync("data/weekly-artifact.json", "utf8"));
const neutral = JSON.parse(JSON.stringify(raw));
let zeroed = 0, wasNonZero = 0;
for (const pos of Object.keys(neutral.coef ?? {})) {
  for (const head of Object.keys(neutral.coef[pos])) {
    const c = neutral.coef[pos][head];
    if (Object.prototype.hasOwnProperty.call(c, "dvp_mult")) {
      if (Math.abs(c.dvp_mult) > 1e-12) wasNonZero++;
      c.dvp_mult = 0;
      zeroed++;
    }
  }
}
// The golden block is the trainer's contract check with dvp INTACT; zeroing dvp legitimately changes
// those predictions, so skip it for this experimental in-memory artifact (nothing ships from here).
const neutralArt = loadWeeklyArtifact(neutral, { checkGolden: false });
console.log(`matchup-neutral artifact: zeroed ${zeroed} dvp_mult coefficients (${wasNonZero} were non-zero).`);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Run every arm and keep per-season ourPpg (and the weeks, for fault injection).
function run(model, override) {
  const { weeks, summary } = backtestWaivers(db, leagueId, { seasons, model, artifactOverride: override });
  const perSeason = new Map();
  for (const s of summary.seasons) perSeason.set(s.season, { ours: s.ours, room: s.room });
  return { weeks, summary, perSeason };
}

const arms = {
  floor: run("floor"),
  challenger: run("challenger"),
  served: run("served"),
  "challenger-nodvp": run("challenger", neutralArt),
};

// --- FAULT INJECTION: the neutral artifact must actually change which players we pick ---
function pickKeys(weeks) {
  // map of `${season}|${week}` -> sorted list of picked player_sks
  const m = new Map();
  for (const w of weeks) m.set(`${w.season}|${w.week}`, w.ourAdds.map((a) => a.playerSk).sort());
  return m;
}
{
  const a = pickKeys(arms.challenger.weeks), b = pickKeys(arms["challenger-nodvp"].weeks);
  let weeksDiffer = 0, picksChanged = 0, totalPicks = 0;
  for (const [k, av] of a) {
    const bv = b.get(k) ?? [];
    totalPicks += av.length;
    const bs = new Set(bv);
    const changed = av.filter((x) => !bs.has(x)).length;
    picksChanged += changed;
    if (changed) weeksDiffer++;
  }
  console.log(`FAULT INJECTION (connection proof): matchup-neutral changed ${picksChanged} of ${totalPicks} ` +
    `top-K picks across ${weeksDiffer} of ${a.size} weeks. ` +
    (picksChanged > 0 ? "CONNECTED." : "*** DISCONNECTED -- the lever moved nothing; any null below is meaningless. ***"));
}

// --- paired season bootstrap: mean over resampled seasons of (A - B) per season ---
function pairedBootstrap(aBySeason, bBySeason, iters = 4000, seed = 987654321) {
  const diffs = seasons.map((s) => (aBySeason.get(s) ?? 0) - (bBySeason.get(s) ?? 0));
  let rng = seed;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const boot = [];
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let k = 0; k < diffs.length; k++) acc += diffs[Math.floor(rand() * diffs.length)];
    boot.push(acc / diffs.length);
  }
  boot.sort((x, y) => x - y);
  return {
    mean: mean(diffs),
    lo: boot[Math.floor(0.05 * boot.length)],
    hi: boot[Math.floor(0.95 * boot.length)],
    pAbetter: boot.filter((x) => x > 0).length / boot.length,
    perSeason: diffs,
  };
}
const oursBySeason = (arm) => new Map([...arm.perSeason].map(([s, v]) => [s, v.ours]));
const roomBySeason = new Map([...arms.floor.perSeason].map(([s, v]) => [s, v.room]));

console.log("\n=== PER-SEASON realised ROS points/game of OUR top-K (the room's per-season pick set) ===");
console.log("season   room    floor  chall  served  ch-nodvp");
for (const s of seasons) {
  const g = (a) => (arms[a].perSeason.get(s)?.ours ?? NaN).toFixed(2).padStart(6);
  console.log(`  ${s}  ${roomBySeason.get(s).toFixed(2).padStart(5)}  ${g("floor")}  ${g("challenger")}  ${g("served")}  ${g("challenger-nodvp")}`);
}

console.log("\n=== HEADLINE (pooled over all scored adds) ===");
console.log("  arm                ourPpg   weeksWon   perDollar   (room ppg 6.83)");
for (const a of ["floor", "challenger", "served", "challenger-nodvp"]) {
  const s = arms[a].summary;
  console.log(`  ${a.padEnd(18)} ${s.ourPpg.toFixed(2).padStart(6)}   ${(s.weeksWon * 100).toFixed(1).padStart(6)}%   ${s.ourPerDollar.toFixed(2).padStart(7)}     room ${s.roomPpg.toFixed(2)}`);
}

console.log("\n=== PAIRED SEASON BOOTSTRAP (8 seasons, 90% CI) ===");
const tests = [
  ["challenger  - room ", oursBySeason(arms.challenger), roomBySeason],
  ["served      - room ", oursBySeason(arms.served), roomBySeason],
  ["floor       - room ", oursBySeason(arms.floor), roomBySeason],
  ["ch-nodvp    - room ", oursBySeason(arms["challenger-nodvp"]), roomBySeason],
  ["ch-nodvp - challenger", oursBySeason(arms["challenger-nodvp"]), oursBySeason(arms.challenger)],
  ["served   - challenger", oursBySeason(arms.served), oursBySeason(arms.challenger)],
];
for (const [label, a, b] of tests) {
  const r = pairedBootstrap(a, b);
  console.log(`  ${label.padEnd(22)} mean ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(3)}  CI [${r.lo.toFixed(2)}, ${r.hi.toFixed(2)}]  P(first>second) ${(100 * r.pAbetter).toFixed(0)}%`);
}
db.close();
