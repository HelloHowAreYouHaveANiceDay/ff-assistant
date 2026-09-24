// IS THERE STABLE PLAYER-SPECIFIC STRUCTURE THE POSITIONAL MODEL MISSES?
//
// The question behind "should we build individual models". Building one model per player is not
// the first thing to test -- the first thing to test is whether an individual effect EXISTS and is
// STABLE, because if it does not, no amount of per-player machinery can find it, and if it does,
// the cheap way to capture it is a shrunk player intercept (partial pooling), not 300 models.
//
// THIS REPO HAS A DIRECTLY RELEVANT PRECEDENT AND IT IS NEGATIVE. Per-manager draft profiles have
// NO out-of-sample signal: predicting an owner's held-out season from his own history is WORSE than
// assuming league-average (7.99pp vs 7.67pp, 44/92 wins). That is the same shape of question one
// level up, and it is why this gets measured before anything gets built.
//
// THE DESIGN: split each player's weeks into ODD and EVEN within the same seasons, and ask whether
// his mean residual on the odd weeks predicts his mean residual on the even weeks. Odd/even holds
// TEAM, SEASON, SUPPORTING CAST and the preseason line constant -- a split by season would confound
// a real individual effect with a change of team or a new offensive coordinator, and would flatter
// the result. If a player's residual is a stable property of the player, these correlate. If the
// positional model has already taken everything a player-level term could, they do not.
//
// REPORTED, because a bare correlation is not a decision:
//   - the SPLIT-HALF correlation, and the Spearman-Brown estimate of full reliability;
//   - a SHUFFLE NULL (residuals permuted across players within position) for the noise scale;
//   - the VARIANCE BUDGET: between-player SD vs within-player SD. A perfectly reliable individual
//     effect that is worth 0.2 points cannot move a lineup whose typical margin is ~2-3 points,
//     and reliability alone would hide that.
//
// KEYED BY player_sk, NEVER by display name. Name-keying merges two different men who share one --
// this repo has already paid for that twice (14 merged (season, pos, name) groups in the weekly
// history; Adrian Peterson with 32 games in a 16-game season).
//
// LIMIT, STATED: the residuals come from the SHIPPED artifact, which was fitted on these seasons.
// In-sample residuals are SHRUNK toward zero, so a real individual effect is if anything
// UNDERSTATED here. That direction is safe for a go/no-go: a null measured this way is weak
// evidence of a null, but a strong POSITIVE result would be real.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { loadWeeklyArtifact, projectWeekly } from "../src/weekly/projector.ts";
import { loadWeeklyRows } from "../src/weekly/features.ts";

const ART = loadWeeklyArtifact(JSON.parse(readFileSync("data/weekly-artifact.json", "utf8")));
const FROM = 2012, TO = 2025;
const MIN_PER_HALF = 8; // a mean over fewer than this is mostly noise and would depress the correlation
const db = new Database("data/ff.db", { readonly: true });

const byPlayer = new Map(); // player_sk -> { pos, name, odd: [], even: [], all: [] }
let rowsSeen = 0, projected = 0, noSk = 0;

// `loadWeeklyRows` deliberately does NOT carry `pts` -- "the target cannot be read by accident".
// So the target is fetched separately and joined on (feat_key, week). Reading it off the feature
// row would have been the accident that docstring exists to prevent; the first run of this script
// silently scored ZERO rows because `r.pts` was undefined, which is the contract working.
const ptsOf = new Map();
for (const r of db.prepare(
  `SELECT season, week, feat_key, pts FROM feat_player_week_model
    WHERE season BETWEEN ? AND ? AND pts IS NOT NULL`,
).all(FROM, TO)) ptsOf.set(`${r.season}|${r.week}|${r.feat_key}`, Number(r.pts));

for (let yr = FROM; yr <= TO; yr++) {
  const rows = loadWeeklyRows(db, yr).filter((r) => ["QB", "RB", "WR", "TE"].includes(r.pos));
  for (const r of rows) r.pts = ptsOf.get(`${r.season}|${r.week}|${r.feat_key}`) ?? null;
  const withPts = rows.filter((r) => r.pts != null && r.season_line_pg != null && r.season_line_pg > 0);
  rowsSeen += withPts.length;
  const proj = projectWeekly({ artifact: ART, rows: withPts });
  const byKey = new Map(proj.map((p) => [`${p.feat_key}|${p.week}`, p]));
  for (const r of withPts) {
    const p = byKey.get(`${r.feat_key}|${r.week}`);
    if (!p || !Number.isFinite(p.mean)) continue;
    if (!r.player_sk) { noSk++; continue; }
    projected++;
    const resid = Number(r.pts) - p.mean;
    if (!byPlayer.has(r.player_sk)) byPlayer.set(r.player_sk, { pos: r.pos, name: r.name, odd: [], even: [], all: [], bySeason: new Map() });
    const e = byPlayer.get(r.player_sk);
    e.all.push(resid);
    (r.week % 2 === 1 ? e.odd : e.even).push(resid);
    if (!e.bySeason.has(yr)) e.bySeason.set(yr, []);
    e.bySeason.get(yr).push(resid);
  }
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i] - ma, dbv = b[i] - mb; sa += da * da; sb += dbv * dbv; sab += da * dbv; }
  return sa <= 0 || sb <= 0 ? 0 : sab / Math.sqrt(sa * sb);
}

console.log(`rows scored ${projected} (of ${rowsSeen} with points; ${noSk} dropped for no player_sk)`);
console.log(`players ${byPlayer.size} | split: odd vs even WEEKS within season | min ${MIN_PER_HALF} per half\n`);

console.log("pos   players  rows/player  splitHalf r   SpearmanBrown   shuffleNull   betweenSD  withinSD  share");
for (const pos of ["QB", "RB", "WR", "TE"]) {
  const elig = [...byPlayer.values()].filter((e) => e.pos === pos && e.odd.length >= MIN_PER_HALF && e.even.length >= MIN_PER_HALF);
  if (elig.length < 20) { console.log(pos.padEnd(6), `only ${elig.length} eligible players -- too few to measure`); continue; }
  const o = elig.map((e) => mean(e.odd)), v = elig.map((e) => mean(e.even));
  const r = corr(o, v);
  const sb = (2 * r) / (1 + r); // Spearman-Brown: reliability of the FULL record, not half of it

  // SHUFFLE NULL: permute every residual across players within this position, preserving each
  // player's row counts. Any correlation that survives this is an artifact of the design, not of
  // the players -- and the value it returns is the noise scale the real number must beat.
  const pool = elig.flatMap((e) => [...e.odd, ...e.even]);
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  let k = 0;
  const so = [], sv = [];
  for (const e of elig) {
    so.push(mean(pool.slice(k, k + e.odd.length))); k += e.odd.length;
    sv.push(mean(pool.slice(k, k + e.even.length))); k += e.even.length;
  }
  const nullR = corr(so, sv);

  // THE VARIANCE BUDGET. `betweenSD` is the spread of players' true-ish mean residuals; `withinSD`
  // is week-to-week noise around it. An individual intercept can only ever buy the between part,
  // and only to the extent it is reliable.
  const allMeans = elig.map((e) => mean(e.all));
  const betweenSD = sd(allMeans);
  const withinSD = mean(elig.map((e) => sd(e.all)));
  const rowsPer = mean(elig.map((e) => e.all.length));
  // The share of a week's variance an individual intercept could explain, discounted by reliability.
  const share = (Math.max(0, sb) * betweenSD ** 2) / (betweenSD ** 2 + withinSD ** 2);

  console.log(
    pos.padEnd(6), String(elig.length).padStart(7), rowsPer.toFixed(1).padStart(12),
    r.toFixed(4).padStart(13), sb.toFixed(4).padStart(15), nullR.toFixed(4).padStart(13),
    betweenSD.toFixed(3).padStart(11), withinSD.toFixed(3).padStart(9), (share * 100).toFixed(2).padStart(6) + "%",
  );
}

// ---- THE PROSPECTIVE TEST, and this is the one that decides anything ---------------------------
//
// Odd/even is a RELIABILITY measurement: it asks whether the effect is real inside the window we
// can see. It is an UPPER BOUND on usable value and cannot be the basis for a decision, because
// both halves are contemporaneous -- a player who simply had a good SEASON reads as a stable
// player effect in odd and even weeks alike, and the model already carries in-season form
// (td_ppg, t4_mean, t4_sd) that captures exactly that.
//
// The decision question is PROSPECTIVE: does a player's residual history predict his NEXT season?
// That is precisely the test per-manager draft profiles FAILED (7.99pp vs 7.67pp against
// league-average, 44/92 wins), and it is the honest analogue here. Each point is one
// (player, season) with >= MIN_SEASON_ROWS rows in the target season and >= MIN_PRIOR_ROWS in
// STRICTLY EARLIER seasons -- no lookahead: the predictor uses only seasons before the one scored.
const MIN_SEASON_ROWS = 8, MIN_PRIOR_ROWS = 16;
console.log("\nPROSPECTIVE: does a player's PRIOR-season residual predict his NEXT season?");
console.log("(the per-manager test's shape -- strictly earlier seasons only, no lookahead)");
console.log("pos    points   corr(prior, next)   shuffleNull   priorSD  nextSD");
for (const pos of ["QB", "RB", "WR", "TE"]) {
  const priors = [], nexts = [];
  for (const e of byPlayer.values()) {
    if (e.pos !== pos) continue;
    const yrs = [...e.bySeason.keys()].sort((a, b) => a - b);
    for (const y of yrs) {
      const cur = e.bySeason.get(y);
      if (cur.length < MIN_SEASON_ROWS) continue;
      const prior = yrs.filter((p) => p < y).flatMap((p) => e.bySeason.get(p));
      if (prior.length < MIN_PRIOR_ROWS) continue;
      priors.push(mean(prior));
      nexts.push(mean(cur));
    }
  }
  if (priors.length < 30) { console.log(pos.padEnd(6), `only ${priors.length} (player, season) points -- too few`); continue; }
  const r = corr(priors, nexts);
  // Shuffle the NEXT column against the PRIOR column: destroys the pairing, keeps both marginals.
  let seed = 24680;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const nullRs = [];
  for (let rep = 0; rep < 25; rep++) {
    const sh = [...nexts];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    nullRs.push(Math.abs(corr(priors, sh)));
  }
  nullRs.sort((a, b) => a - b);
  console.log(
    pos.padEnd(6), String(priors.length).padStart(6), r.toFixed(4).padStart(19),
    `p95 ${nullRs[Math.floor(nullRs.length * 0.95)].toFixed(4)}`.padStart(14),
    sd(priors).toFixed(3).padStart(9), sd(nexts).toFixed(3).padStart(7),
  );
}

// HOW MUCH DATA WOULD A PER-PLAYER MODEL EVEN HAVE? The feasibility half of the question: a 23-
// feature boosted head needs rows, and this is the distribution it would be fitted on.
console.log("\nrows per player (the ceiling on any per-player fit):");
for (const pos of ["QB", "RB", "WR", "TE"]) {
  const counts = [...byPlayer.values()].filter((e) => e.pos === pos).map((e) => e.all.length).sort((a, b) => a - b);
  if (!counts.length) continue;
  const q = (p) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))];
  const over = (n) => counts.filter((c) => c >= n).length;
  console.log(`  ${pos.padEnd(4)} n=${String(counts.length).padStart(4)}  median ${String(q(0.5)).padStart(3)}  p90 ${String(q(0.9)).padStart(3)}  max ${String(counts[counts.length - 1]).padStart(3)}  |  >=50 rows: ${over(50)}  >=100: ${over(100)}  >=200: ${over(200)}`);
}
db.close();
