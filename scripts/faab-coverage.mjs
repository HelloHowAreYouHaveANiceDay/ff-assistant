/**
 * `node --import tsx scripts/faab-coverage.mjs [--build] [--db data/ff.db]`
 *
 * Builds (with `--build`) and then READS BACK `fact_waiver_claim`: how many claims per season, how
 * many carry an outcome, whether LOSING bids exist at all, and the property that says the failures
 * really are losing bids -- across every contested player-week, exactly one claim executed and no
 * loser ever out-bid the winner.
 *
 * That last line is the positive control for the whole track. A status that merely CORRELATES with
 * losing would violate it somewhere; one that IS losing cannot.
 */
import { openDb } from "../src/db/db.js";
import { buildWaiverClaimsOn, coverage } from "../src/features/sources/faab.js";

const argv = process.argv.slice(2);
const dbPath = (argv.includes("--db") ? argv[argv.indexOf("--db") + 1] : undefined) ?? "data/ff.db";
const db = openDb(dbPath);

let res;
if (argv.includes("--build")) {
  const t0 = Date.now();
  res = buildWaiverClaimsOn(db);
  console.log(`built fact_waiver_claim: ${res.rows} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
} else {
  const seasons = db.prepare("SELECT DISTINCT season FROM fact_waiver_claim ORDER BY season").all().map((r) => r.season);
  res = { rows: db.prepare("SELECT COUNT(*) n FROM fact_waiver_claim").get().n, ...coverage(db, seasons) };
  console.log(`fact_waiver_claim: ${res.rows} rows\n`);
}

console.log("  season  claims  won  lost  unscored  bid>0%  contested  id%   feat%  teams  budget");
for (const p of res.perSeason) {
  console.log(
    `  ${p.season}  ${String(p.claims).padStart(6)}  ${String(p.winners).padStart(3)}  ${String(p.losers).padStart(4)}` +
    `  ${String(p.unscored).padStart(8)}  ${String(p.nonzeroBidPct).padStart(6)}  ${String(p.contestedPlayerWeeks).padStart(9)}` +
    `  ${String(p.resolvedPct).padStart(5)} ${String(p.withFeaturesPct).padStart(6)}  ${String(p.teams).padStart(5)}  ${String(p.budget).padStart(6)}`);
}

console.log(`\n  LOSING BIDS EXIST: ${res.losingBidsExist ? "YES" : "NO"}` +
  (res.losingBidsExist ? ` -- status FAILED_INVALIDPLAYERSOURCE, seasons ${res.losingBidSeasons.join(", ")}` : ""));
console.log(`  contested player-weeks where a LOSER out-bid the winner: ${res.orderViolations} (must be 0)`);
if (res.orderViolations > 0) {
  console.log("  FAILED: that status does not mean 'outbid'. Do not fit P(win) on it.");
  process.exitCode = 1;
}

const bids = db.prepare(
  `SELECT pos, COUNT(*) n, ROUND(AVG(bid_amount),1) mean, MAX(bid_amount) mx,
          ROUND(AVG(CASE WHEN won=1 THEN bid_amount END),1) wmean,
          ROUND(AVG(CASE WHEN won=0 THEN bid_amount END),1) lmean
     FROM fact_waiver_claim GROUP BY pos ORDER BY n DESC`).all();
console.log("\n  the price of a claim, by position (all seasons):");
console.log("  pos     n   mean   max   mean(won)  mean(lost)");
for (const b of bids) {
  console.log(`  ${String(b.pos ?? "?").padEnd(4)} ${String(b.n).padStart(4)}  ${String(b.mean).padStart(5)}  ${String(b.mx).padStart(4)}` +
    `  ${String(b.wmean ?? "-").padStart(9)}  ${String(b.lmean ?? "-").padStart(10)}`);
}
db.close();
