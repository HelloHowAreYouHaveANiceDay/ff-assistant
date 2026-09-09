// HOW WRONG IS THE MARKET, ACTUALLY?
//
//   node --import tsx scripts/market-noise.mjs [--from 2020] [--to 2025]
//
// The backtest has always applied `marketSd = 0.30` -- one number, asserted, never measured. This
// measures it, from the only thing that can: the REAL preseason consensus, the projection that
// consensus implies, and what the players then actually scored.
//
//   market error = log(actual season points / curve projection at his real preseason ECR rank)
//
// The projection is the CURVE-ONLY artifact, point-in-time (fitted only on seasons before the one
// being scored), read at the player's ECR positional rank from `ranking_history` -- the last
// consensus published before anyone played. So the quantity is "how far out was the market's own
// number", not "how far out were we".
//
// TWO COMPONENTS, because they enter the simulator differently:
//
//   SHARED         the whole room reads the same rankings, so most of this error is COMMON: when the
//                  consensus is wrong about a player, every bidder is wrong about him together, and
//                  the auction still clears near the (wrong) consensus. This is what the sd below
//                  measures, and it is what `--market-noise` has always set.
//   IDIOSYNCRATIC  how far individual bidders disagree ON TOP of that. It cannot be read from
//                  outcomes at all -- outcomes only see the room's consensus error -- so it is
//                  BOUNDED from the price model's leave-one-season-out residual dispersion
//                  (scripts/price-loso.mjs), which is disagreement about PRICE given the same public
//                  rank, i.e. exactly the quantity wanted, in the only place it is observable.
//
// A NOTE ON SURVIVORSHIP, stated because it bounds what these numbers mean. A ranked player who
// never posted a season has no row to score, so he is dropped rather than counted as a zero. That
// biases the measured error DOWN: the real market error is larger than this, and the sds below are
// therefore a floor.
import Database from "better-sqlite3";
import { buildCurveOnlyArtifact } from "../src/model/build.ts";
import { loadFeatureRows } from "../src/model/features.ts";
import { projectSeason } from "../src/model/projector.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
const FROM = val("--from", 2020), TO = val("--to", 2025);

const BANDS = [["1-6", 1, 6], ["7-12", 7, 12], ["13-24", 13, 24], ["25-40", 25, 40], ["41-60", 41, 60], ["60+", 61, 1e9]];
const bandOf = (r) => (BANDS.find(([, lo, hi]) => r >= lo && r <= hi) ?? BANDS[BANDS.length - 1])[0];

const db = new Database("data/ff.db", { readonly: true });
const rows = [];
for (let yr = FROM; yr <= TO; yr++) {
  const have = db.prepare(
    "SELECT COUNT(*) c FROM feat_player_season WHERE season = ? AND ecr_pos_rank IS NOT NULL",
  ).get(yr).c;
  if (!have) { console.log(`  ${yr}: no consensus in the archive -- skipped`); continue; }
  // POINT-IN-TIME: the curve for season yr fitted only on seasons before it, and its quantile heads
  // likewise. A curve that had seen yr would make the market look better informed than it was.
  const { artifact } = buildCurveOnlyArtifact({ from: 1999, to: 2025, base: "curve_value_ecr", holdoutSeason: yr, pointInTime: true });
  const feats = loadFeatureRows(db, { season: yr, rankBasis: "ecr", base: "curve_value_ecr" });
  const proj = new Map(projectSeason({ season: yr, asOf: `${yr}-09-01`, artifact, features: feats }).map((r) => [`${r.pos}|${r.name}`, r.mean]));
  const actual = db.prepare(
    "SELECT name, pos, pts, ecr_pos_rank FROM feat_player_season WHERE season = ? AND pts IS NOT NULL AND ecr_pos_rank IS NOT NULL",
  ).all(yr);
  let scored = 0;
  for (const a of actual) {
    const p = proj.get(`${a.pos}|${a.name}`);
    if (!p || !(p > 0) || !(a.pts > 0)) continue;
    rows.push({ season: yr, pos: a.pos, rank: a.ecr_pos_rank, band: bandOf(a.ecr_pos_rank), e: Math.log(a.pts / p) });
    scored++;
  }
  console.log(`  ${yr}: ${scored} scored of ${have} ranked  (${have - scored} ranked players never posted a season -- dropped, see the header)`);
}
db.close();

if (!rows.length) { console.log("nothing measurable"); process.exit(1); }

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

console.log(`\nMARKET ERROR, log(actual / consensus-implied projection), ${FROM}-${TO}`);
console.log(`  slice        n      mean      sd`);
const show = (label, sel) => {
  const a = rows.filter(sel).map((r) => r.e);
  if (a.length < 20) return;
  console.log(`  ${label.padEnd(10)} ${String(a.length).padStart(5)}   ${mean(a).toFixed(3).padStart(7)}  ${sd(a).toFixed(3).padStart(6)}`);
};
show("ALL", () => true);
for (const [b] of BANDS) show(b, (r) => r.band === b);
for (const p of ["QB", "RB", "WR", "TE"]) show(p, (r) => r.pos === p);

const all = rows.map((r) => r.e);
console.log(`\n  SHARED market sd (the whole room reads the same rankings):  ${sd(all).toFixed(3)}`);
console.log(`  The backtest's long-standing assumption was 0.30, on a MULTIPLICATIVE (1 + e) scale`);
console.log(`  rather than a log one; log sd ${sd(all).toFixed(3)} is the honest replacement, and it is`);
console.log(`  a FLOOR because ranked players who never played are dropped rather than scored as 0.`);
console.log(`\n  IDIOSYNCRATIC bound, from the price model's LOSO residuals by tier (scripts/price-loso.mjs):`);
console.log(`    top12 0.538   13-36 0.429   37-96 0.530   tail 0.610`);
console.log(`  Those are disagreements about PRICE given the same public rank, so they bound how far`);
console.log(`  two bidders' private views can diverge. The simulator's idiosyncratic term is set well`);
console.log(`  BELOW them, because a price residual also contains roster need, budget state and`);
console.log(`  auction noise -- all of which the simulator models separately and would double-count.`);
