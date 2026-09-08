// DOES THE MARKET'S DISAGREEMENT ABOUT A PLAYER PREDICT HOW WRONG WE WILL BE ABOUT HIM?
//
//   node scripts/ecr-dispersion.mjs <db_fpecr.csv.gz>
//
// Our simulator applies ONE projection error to everybody: projSd = 0.30, lognormal, identical for a
// unanimous consensus pick and for a player the experts cannot agree on. ffsimulator instead carries
// a per-player `sd` straight from the rankings. I flagged that as a promising missing factor and said
// it could not be tested because we hold no historical ECR -- which was true of OUR store and false
// of the world: DynastyProcess publishes the whole FantasyPros archive with ecr, sd, best and worst
// per player per scrape date.
//
// THE TEST. Take each season's PRESEASON redraft ranking, join to what the player actually scored,
// and ask whether the reported sd predicts the size of the miss. Concretely: does a player with a
// wide expert spread deviate further from his rank-implied projection than a player with a narrow
// one? If yes, projSd should be per-player and we are currently over-confident about contested
// players and under-confident about consensus ones -- which distorts exactly the tails that decide
// championships.
//
// PRESEASON ONLY, and the cut matters. In-season rankings know things the draft did not, so a
// mid-October scrape would leak outcome into the predictor and the test would pass for the wrong
// reason. Only scrapes from the four weeks before week 1 are used.
import { createReadStream, readFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const path = process.argv[2];
if (!path) { console.log("usage: node scripts/ecr-dispersion.mjs <db_fpecr.csv.gz>"); process.exit(1); }
const POS = ["QB", "RB", "WR", "TE"];

// --- preseason redraft rankings, one row per (season, player) --------------------------------------
const rank = new Map();   // season|name -> {ecr, sd, best, worst, pos}
{
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let idx = null;
  for await (const line of rl) {
    if (!idx) { idx = {}; line.split(",").forEach((h, i) => (idx[h.trim()] = i)); continue; }
    const f = line.split(",");
    if (f[idx.ecr_type] !== "ro") continue;                    // redraft overall == our board's flavour
    const date = f[idx.scrape_date] || "";
    const mo = date.slice(5, 7), day = Number(date.slice(8, 10));
    // Preseason window: August through the first week of September.
    if (!(mo === "08" || (mo === "09" && day <= 7))) continue;
    const pos = (f[idx.pos] || "").toUpperCase();
    if (!POS.includes(pos)) continue;
    const name = (f[idx.player] || "").trim();
    const season = Number(date.slice(0, 4));
    const ecr = Number(f[idx.ecr]), sd = Number(f[idx.sd]);
    if (!name || !Number.isFinite(ecr) || !Number.isFinite(sd)) continue;
    const k = `${season}|${name}`;
    // Keep the LATEST preseason scrape -- closest to the real draft, still no games played.
    const prev = rank.get(k);
    if (!prev || date > prev.date) rank.set(k, { ecr, sd, pos, date });
  }
}
console.log(`${rank.size.toLocaleString()} preseason (season, player) redraft rankings\n`);

// --- what they actually scored ---------------------------------------------------------------------
const actual = new Map();
for (const line of readFileSync("data/history-points.csv", "utf8").trim().split(/\r?\n/).slice(1)) {
  const [s, name, pos, pts] = line.split(",");
  if (POS.includes(pos)) actual.set(`${Number(s)}|${name}`, { pos, pts: Number(pts) });
}

// --- the rank curve: mean points by within-position preseason rank ---------------------------------
const rows = [];
const seasons = [...new Set([...rank.keys()].map((k) => Number(k.split("|")[0])))].sort();
for (const s of seasons) {
  for (const pos of POS) {
    const list = [...rank.entries()].filter(([k, v]) => k.startsWith(`${s}|`) && v.pos === pos)
      .sort((a, b) => a[1].ecr - b[1].ecr);
    list.forEach(([k, v], i) => {
      const act = actual.get(k);
      if (!act) return;                                        // never played, or a name we cannot match
      rows.push({ season: s, pos, posRank: i + 1, ecr: v.ecr, sd: v.sd, pts: act.pts });
    });
  }
}
// curve[pos][rank] from the OTHER seasons, so a season's own outcome is not in its own predictor
const predict = (pos, posRank, exclude) => {
  const vals = rows.filter((r) => r.pos === pos && r.posRank === posRank && r.season !== exclude).map((r) => r.pts);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};
const cases = [];
for (const r of rows) {
  if (r.posRank > 48) continue;
  const pred = predict(r.pos, r.posRank, r.season);
  if (!pred || pred < 20) continue;
  cases.push({ ...r, pred, logRatio: Math.log(Math.max(1, r.pts) / pred) });
}
console.log(`${cases.length} joined player-seasons with a preseason rank, an sd, and an outcome`);
console.log(`seasons: ${[...new Set(cases.map((c) => c.season))].sort().join(", ")}\n`);

// --- THE QUESTION: does sd predict the SIZE of the miss? -------------------------------------------
//
// WITHIN RANK BANDS, and getting this wrong the first time inverted the answer. sd means different
// things at different ranks -- an sd of 5 at pick 3 is enormous disagreement, the same 5 at pick 150
// is nothing -- so the first version normalised it as sd/ecr. That was worse than doing nothing:
// dividing by ecr makes the ratio track rank INVERSELY, since early picks have tiny denominators. The
// "widest disagreement" quintile came out full of elite players, who are the most predictable, and
// the test reported 0.51x -- an apparently strong result in the opposite direction, entirely
// manufactured by the control.
//
// The honest design compares players who are ranked SIMILARLY and disagreed about differently. Split
// into rank bands first, then split each band by raw sd, and compare outcome dispersion within the
// band. Rank never varies across the comparison, so it cannot drive it.
const BANDS = [[1, 12], [13, 24], [25, 48], [49, 96], [97, 400]];
console.log("Within each ECR band: outcome dispersion for LOW vs HIGH expert disagreement");
console.log("  ecr band     n    low-sd spread   high-sd spread   ratio");
const ratios = [];
for (const [lo, hi] of BANDS) {
  const g = cases.filter((c) => c.ecr >= lo && c.ecr <= hi).sort((a, b) => a.sd - b.sd);
  if (g.length < 60) { console.log(`  ${String(lo).padStart(3)}-${String(hi).padEnd(4)} ${String(g.length).padStart(6)}   too few`); continue; }
  const half = Math.floor(g.length / 2);
  const disp = (arr) => {
    const m = arr.reduce((a, c) => a + c.logRatio, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, c) => a + (c.logRatio - m) ** 2, 0) / (arr.length - 1));
  };
  const lowS = disp(g.slice(0, half)), highS = disp(g.slice(half));
  ratios.push(highS / lowS);
  console.log(`  ${String(lo).padStart(3)}-${String(hi).padEnd(4)} ${String(g.length).padStart(6)}   ${lowS.toFixed(3).padStart(11)}   ${highS.toFixed(3).padStart(13)}   ${(highS / lowS).toFixed(2)}x`);
}
const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
const allAbove = ratios.every((r) => r > 1);
console.log(`\n  mean ratio across bands: ${mean.toFixed(2)}x   (every band above 1: ${allAbove})`);
console.log(mean > 1.15 && allAbove
  ? `  REAL: within a rank band, players the experts disagree about deviate further from their
  rank-implied projection. A single global projSd is over-confident about contested players.`
  : mean > 1.15
    ? `  MIXED: the mean points the right way but not every band agrees, so the effect is not
  consistent enough to justify replacing a single global projSd yet.`
    : `  NOT SUPPORTED: holding rank fixed, expert disagreement does not predict a wider outcome.
  A global projSd is defensible and a per-player sd would be borrowed sophistication, not signal.`);
