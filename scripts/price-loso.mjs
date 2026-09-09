// DOES THE PRICE MODEL PREDICT THIS ROOM BETTER THAN THE TWO BOOKS WE ALREADY HAVE?
//
//   node --import tsx scripts/price-loso.mjs [--variants none,inflation,full]
//
// LEAVE ONE SEASON OUT: predict each of 2022-2025 from the other three. Not a random split -- picks
// within one draft share the room's mood, its money and its nomination order, so a random split
// leaks between folds and every model looks better than it is.
//
// THREE BOOKS, ONE COMPARISON, ALL NORMALISED TO THE SAME SEASON TOTAL. Comparing an unnormalised
// book against a normalised one measures the normalisation: a book whose dollars happen to sum to
// less than the room's money is cheap everywhere and would win half these cells for a reason that
// has nothing to do with knowing who is worth what.
//
//   price   the fitted hurdle model (tools/train_price.py), holding out the season being scored
//   rank    RANK_DECAY, the independent exponential-decay book the simulator already ships
//   vor     computeValues, i.e. OUR OWN valuation function -- the default `--bot-book`
//
// THE PROJECTION BEHIND THE TWO BASELINES IS POINT-IN-TIME. Both `rank` and `vor` price a list of
// projected points, so they need a board for the season being scored, and a board built from an
// artifact fitted on 1999-2025 would have seen it. `data/fold-artifacts-2b/artifact-<season>.json`
// is the per-fold artifact from `ff evaluate-projection --keep-artifacts`, each blind to its own
// season. Without it this script REFUSES to run rather than quietly scoring a baseline that cheats.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadPriceModel, priceFor } from "../src/model/price.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { rankBook } from "../src/draft/sim.ts";
import { computeValues, resolveValueLeague } from "../src/draft/values.ts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const VARIANTS = val("--variants", "none,inflation,full").split(",");
const FOLD_DIR = val("--artifact-dir", "data/fold-artifacts-2b");
const BUDGET = 200;
// `--seasons 2018-2025` restricts the leave-one-season-out set. `--holdout 2026` instead fits on
// every OTHER season once and scores only that one -- a true holdout rather than a rotation, which
// is the right shape when the season in question is the one the model has never been near.
const SEASON_RANGE = val("--seasons", null);
const HOLDOUT = val("--holdout", null) === null ? null : Number(val("--holdout", null));

const db = new Database("data/ff.db", { readonly: true });
let seasons = db.prepare("SELECT DISTINCT season FROM fact_draft_pick ORDER BY season").all().map((r) => r.season);
if (!seasons.length) { console.log("fact_draft_pick is empty"); process.exit(1); }
if (SEASON_RANGE) {
  const [lo, hi] = SEASON_RANGE.split("-").map(Number);
  seasons = seasons.filter((s) => s >= lo && s <= (hi ?? lo));
}
// The pool the price model may train on, passed through to train_price.py. In holdout mode it is
// everything up to and including the held-out season (which that script then removes); in rotation
// mode it is exactly the seasons being rotated over.
let TRAIN_POOL = SEASON_RANGE;
if (HOLDOUT != null) {
  TRAIN_POOL = `${Math.min(...seasons)}-${HOLDOUT}`;
  seasons = [HOLDOUT];
}
seasons.sort((a, b) => a - b);

// ---- the picks, with the market state as it stood ------------------------------------------------
const bySeason = new Map();
for (const s of seasons) {
  const picks = db.prepare("SELECT * FROM fact_draft_pick WHERE season = ? ORDER BY pick_order").all(s);
  const teams = new Set(picks.map((p) => p.team_name)).size;
  const leagueMoney = teams * BUDGET;
  const n = picks.length;
  let spent = 0;
  const rows = picks.map((p, k) => {
    const r = {
      name: p.name, pos: p.pos, price: p.price,
      ecrPosRank: p.consensus_pos_rank_asof, ecrSd: p.consensus_sd_asof,
      moneyLeft: (leagueMoney - spent) / leagueMoney,
      slotsLeft: (n - k) / n,
      pickShare: k / n,
      leagueMoney,
    };
    spent += p.price;
    return r;
  });
  bySeason.set(s, { rows, teams, leagueMoney, n, spent });
}

// WHICH ARTIFACT PRICES THE BASELINE BOOKS FOR THIS SEASON, and the rule is the same one the script
// has always enforced: it must be BLIND to the season being scored. The per-fold artifacts are blind
// by construction. The season AFTER the last fold -- the live one -- has no fold artifact and does
// not need one: the shipped artifact is fitted on seasons strictly before it, so it is blind to it
// for exactly the same reason. Any earlier season with no fold artifact is a hard stop, because
// there the shipped artifact WOULD have seen it.
function foldArtifact(season) {
  const p = join(FOLD_DIR, `artifact-${season}.json`);
  if (existsSync(p)) return p;
  const shipped = "data/projection-artifact.json";
  if (existsSync(shipped)) {
    const a = JSON.parse(readFileSync(shipped, "utf8"));
    const last = Math.max(...(a.seasons ?? a.trainedSeasons ?? [0]));
    if (Number.isFinite(last) && last < season) return shipped;
  }
  console.error(`missing ${p}. The two baseline books need a board for ${season} built from an ` +
    `artifact BLIND to ${season}; without it they would be scored on a projection that had seen ` +
    `the season. Run:  npm run ff -- evaluate-projection --seasons 2008-2025 --keep-artifacts ${FOLD_DIR}`);
  process.exit(1);
}

// ---- the two baseline books, from a point-in-time board ------------------------------------------
function baselineBooks(season, leagueMoney, teams, slotsPerTeam) {
  const art = loadArtifact(JSON.parse(readFileSync(foldArtifact(season), "utf8")));
  const proj = boardProjection(db, season, art)
    .filter((r) => r.mean > 0)
    .map((r) => ({ name: r.name, pos: r.pos, points: r.mean }));
  const slots = ["QB", "RB", "WR", "TE", "FLEX", "FLEX", "DST", "K", ...Array(slotsPerTeam - 8).fill("BE")];
  const lg = { teams, budget: BUDGET, slots };
  const rank = rankBook(proj, lg);
  const vor = new Map(computeValues(proj, resolveValueLeague(lg), 2).map((v) => [v.name, v.value]));
  return { rank, vor };
}

// ---- normalise every book to the season's actual total -------------------------------------------
// The one comparison rule that matters: three books, one dollar scale. A book is scaled so that the
// sum over THE PICKS BEING SCORED equals what the room actually spent on them.
function normalise(pred, actualTotal) {
  const sum = [...pred.values()].reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return pred;
  const f = actualTotal / sum;
  return new Map([...pred.entries()].map(([k, v]) => [k, Math.max(1, v * f)]));
}

// ---- tiers, by the PRE-DRAFT board, never by what happened ---------------------------------------
// Tiering by the price paid or by the pick order would condition on the outcome, which flatters
// whichever book is closest to the outcome by construction.
function tierOf(overallRank) {
  if (overallRank <= 12) return "top12";
  if (overallRank <= 36) return "13-36";
  if (overallRank <= 96) return "37-96";
  return "tail";
}
const TIERS = ["top12", "13-36", "37-96", "tail"];

function overallRanks(season, teams, slotsPerTeam) {
  const art = loadArtifact(JSON.parse(readFileSync(foldArtifact(season), "utf8")));
  const proj = boardProjection(db, season, art).filter((r) => r.mean > 0).sort((a, b) => b.mean - a.mean);
  const m = new Map();
  proj.forEach((r, i) => m.set(r.name, i + 1));
  void teams; void slotsPerTeam;
  return m;
}

// ---- fit one price variant, holding out one season ----------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "ff-price-loso-"));
function fitPrice(variant, holdout) {
  const out = join(tmp, `price-${variant}-${holdout}.json`);
  const args = [
    "run", "--with", "scikit-learn", "--with", "numpy", "tools/train_price.py",
    "--db", "data/ff.db", "--out", out, "--holdout-season", String(holdout),
    "--market-state", variant, "--quiet",
  ];
  // THE TRAINING POOL IS STATED, not inherited from whatever the store happens to hold. In a
  // rotation over 2018-2025 a fold must not see 2026; in a genuine holdout of 2026 it must see all
  // eight earlier seasons. `--seasons` says which, so the two runs cannot silently be the same fit.
  if (TRAIN_POOL) args.push("--seasons", TRAIN_POOL);
  execFileSync("uv", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 900000 });
  return loadPriceModel(JSON.parse(readFileSync(out, "utf8")));
}

// ---- run -----------------------------------------------------------------------------------------
const books = {};
for (const v of VARIANTS) books[`price:${v}`] = [];
books.rank = [];
books.vor = [];

for (const season of seasons) {
  const { rows, teams, n } = bySeason.get(season);
  const slotsPerTeam = Math.round(n / teams);
  const actualTotal = rows.reduce((a, r) => a + r.price, 0);
  const ranks = overallRanks(season, teams, slotsPerTeam);
  const { rank, vor } = baselineBooks(season, teams * BUDGET, teams, slotsPerTeam);

  const record = (label, predByName) => {
    const norm = normalise(predByName, actualTotal);
    for (const r of rows) {
      const pred = norm.get(r.name) ?? 1;
      books[label].push({
        season, name: r.name, pos: r.pos, actual: r.price, pred,
        tier: tierOf(ranks.get(r.name) ?? 9999),
      });
    }
  };

  for (const v of VARIANTS) {
    const model = fitPrice(v, season);
    const m = new Map(rows.map((r) => [r.name, priceFor(model, r.pos, r)]));
    record(`price:${v}`, m);
  }
  record("rank", new Map(rows.map((r) => [r.name, rank.get(r.name) ?? 1])));
  record("vor", new Map(rows.map((r) => [r.name, vor.get(r.name) ?? 1])));
}
rmSync(tmp, { recursive: true, force: true });
db.close();

// ---- report --------------------------------------------------------------------------------------
const mae = (a) => a.reduce((s, r) => s + Math.abs(r.pred - r.actual), 0) / a.length;
const bias = (a) => a.reduce((s, r) => s + (r.pred - r.actual), 0) / a.length;
const within = (a, d) => 100 * a.filter((r) => Math.abs(r.pred - r.actual) <= d).length / a.length;

console.log(`LEAVE-ONE-SEASON-OUT over ${seasons.join(", ")}; every book normalised to the season's own total spend`);
console.log(`  ${"book".padEnd(18)} ${"n".padStart(4)}  ${"MAE".padStart(6)} ${"bias".padStart(7)}  ${"within $3".padStart(9)}`);
const labels = Object.keys(books);
for (const k of labels) {
  const a = books[k];
  console.log(`  ${k.padEnd(18)} ${String(a.length).padStart(4)}  ${mae(a).toFixed(2).padStart(6)} ${(bias(a) >= 0 ? "+" : "") + bias(a).toFixed(2).padStart(6)}  ${within(a, 3).toFixed(1).padStart(8)}%`);
}

console.log(`\n  MAE by tier (tier = overall rank on that season's point-in-time board)`);
console.log(`  ${"book".padEnd(18)} ${TIERS.map((t) => t.padStart(14)).join("")}`);
for (const k of labels) {
  const line = TIERS.map((t) => {
    const a = books[k].filter((r) => r.tier === t);
    return a.length ? `${mae(a).toFixed(1)}/${(bias(a) >= 0 ? "+" : "") + bias(a).toFixed(1)}`.padStart(14) : "-".padStart(14);
  }).join("");
  console.log(`  ${k.padEnd(18)}${line}`);
}
console.log(`  (each cell is MAE / bias, in dollars; a positive bias means the book OVERPAYS that tier)`);

console.log(`\n  per season MAE`);
console.log(`  ${"book".padEnd(18)} ${seasons.map((s) => String(s).padStart(9)).join("")}`);
for (const k of labels) {
  console.log(`  ${k.padEnd(18)}` + seasons.map((s) => mae(books[k].filter((r) => r.season === s)).toFixed(2).padStart(9)).join(""));
}

// THE RESIDUAL DISPERSION BY TIER, which is what `--bot-book price` needs for its per-bot noise.
// A single sd across all picks would give a $1 kicker the same absolute spread as a $100 running
// back; in log space the tiers are far closer, which is why the noise is lognormal.
console.log(`\n  LOG-RESIDUAL sd by tier -- the per-bot noise for --bot-book price`);
for (const k of labels.filter((x) => x.startsWith("price:"))) {
  const cells = TIERS.map((t) => {
    const a = books[k].filter((r) => r.tier === t);
    if (!a.length) return "-".padStart(16);
    const l = a.map((r) => Math.log(Math.max(1, r.actual) / Math.max(1, r.pred)));
    const m = l.reduce((x, y) => x + y, 0) / l.length;
    const sd = Math.sqrt(l.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, l.length - 1));
    return `${m.toFixed(2)}/${sd.toFixed(3)} (${a.length})`.padStart(16);
  });
  console.log(`  ${k.padEnd(18)}${cells.join("")}`);
}
console.log(`  ${"".padEnd(18)}${TIERS.map((t) => t.padStart(16)).join("")}`);
console.log(`  (each cell is mean / sd of log(actual/predicted), with n -- the mean is the bias the`);
console.log(`   bot noise must NOT re-add, the sd is what --bot-book price draws its per-bot noise from)`);
