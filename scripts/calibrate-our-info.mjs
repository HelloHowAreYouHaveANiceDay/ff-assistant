// CALIBRATE THE ARBITER'S INFORMATION MODEL (D37 follow-up) -- how noisy is OUR board relative to the
// room's consensus, and how much of its error does it share?
//
// THE BACKTEST'S MODEL. With p = the player's prior-season actual points (the replay's reference):
//   room view  M = p (1 + sm zm)
//   our view   U = p (1 + su (rho zm + sqrt(1 - rho^2) zu))
// D37 shipped sm = 0.30 (the long-standing room assumption) and ASSUMED su = sm, rho = 0.5.
//
// THE TWO MOMENTS THIS MATCHES, on real draft-day projections vs the realised season (2020-2025,
// the only span with both a point-in-time consensus and a blind board):
//   accuracy gap   mean(eB^2) - mean(eC^2)   = su^2 - sm^2        e = (view - Y) / p
//   disagreement   var((B - C) / p)          = su^2 + sm^2 - 2 rho su sm
// Both are DIFFERENCES between the two views, so the part of Y nobody could predict cancels and does
// not have to be modelled. sm is held at the room's 0.30 so the room model is untouched; su and rho
// are solved. The consensus C and our board B are built EXACTLY as `ff backtest --market ecr` builds
// them: C = the curve-only artifact read at the real ECR rank, blind to its season; B =
// boardProjection with the blind per-season fold artifact.
//
// Usage: node scripts/calibrate-our-info.mjs [--artifact-dir data/fold-artifacts-d16] [--seasons 2020-2025]
//        [--min-prior 30] [--pool 250] [--sm 0.30]
import { existsSync, readFileSync } from "node:fs";
import { importTs } from "./lib/ensure-tsx.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ART = val("--artifact-dir", "data/fold-artifacts-d16");
const [lo, hi] = val("--seasons", "2020-2025").split("-").map(Number);
const MIN_PRIOR = Number(val("--min-prior", "30"));
const POOL = Number(val("--pool", "250"));
const SM = Number(val("--sm", "0.30"));
// POSITIVE CONTROLS: `--board consensus` makes B = C (must solve su = sm, rho = 1); `--board last-year` makes
// B = p, a board measurably worse than the consensus (must solve su clearly above sm).
const BOARD = val("--board", "ours");

const { openDb } = await importTs("../src/db/db.ts", import.meta.url);
const { loadArtifact, projectSeason } = await importTs("../src/model/projector.ts", import.meta.url);
const { buildCurveOnlyArtifact } = await importTs("../src/model/build.ts", import.meta.url);
const { loadFeatureRows, boardProjection } = await importTs("../src/model/features.ts", import.meta.url);

const db = openDb();
const key = (r) => r.player_sk ?? `${r.pos}|${r.name}`;
const perSeason = [];
const pooled = { eB2: 0, eC2: 0, eP2: 0, d: [], n: 0 };
for (let yr = lo; yr <= hi; yr++) {
  const p = `${ART}/artifact-${yr}.json`;
  if (!existsSync(p)) { console.log(`${yr}: no blind artifact at ${p} -- skipped`); continue; }
  const ours = loadArtifact(JSON.parse(readFileSync(p, "utf8")));
  if (ours.holdoutSeason !== yr) throw new Error(`${p} declares holdoutSeason ${ours.holdoutSeason}, not ${yr}`);
  const { artifact: curveArt } = buildCurveOnlyArtifact({ from: 1999, to: 2025, base: "curve_value_ecr", holdoutSeason: yr, pointInTime: true });
  const mFeat = loadFeatureRows(db, { season: yr, rankBasis: "ecr", base: "curve_value_ecr" });
  const C = new Map(projectSeason({ season: yr, asOf: `${yr}-09-01`, artifact: curveArt, features: mFeat }).map((r) => [key(r), r.mean]));
  const B = BOARD === "consensus" ? C : new Map(boardProjection(db, yr, ours).map((r) => [key(r), r.mean]));
  const truth = db.prepare("SELECT player_sk, name, pos, pts, prior_pts FROM feat_player_season WHERE season = ? AND pts IS NOT NULL AND prior_pts IS NOT NULL").all(yr);
  // The DRAFTABLE pool, by the consensus's own order (what the room would actually bid on), among men
  // the replay could contain at all (a prior season -- the backtest's reference p).
  let rows = truth.map((t) => ({ k: key(t), y: t.pts, p: t.prior_pts, b: BOARD === "last-year" ? (B.get(key(t)) != null ? t.prior_pts : undefined) : B.get(key(t)), c: C.get(key(t)) }))
    .filter((r) => r.b != null && r.c != null && r.p >= MIN_PRIOR);
  rows.sort((a, b) => b.c - a.c);
  rows = rows.slice(0, POOL);
  if (rows.length < 50) { console.log(`${yr}: only ${rows.length} usable rows -- skipped`); continue; }
  // A LEVEL difference common to every player moves no auction price, and the backtest's noise is
  // mean-zero, so each view is scaled to the realised total over the pool before errors are taken.
  const sy = rows.reduce((s, r) => s + r.y, 0);
  const sb = sy / rows.reduce((s, r) => s + r.b, 0), sc = sy / rows.reduce((s, r) => s + r.c, 0);
  let eB2 = 0, eC2 = 0, eP2 = 0; const d = [];
  const spn = sy / rows.reduce((s, r) => s + r.p, 0);
  for (const r of rows) {
    const eB = (sb * r.b - r.y) / r.p, eC = (sc * r.c - r.y) / r.p, eP = (spn * r.p - r.y) / r.p;
    eB2 += eB * eB; eC2 += eC * eC; eP2 += eP * eP; d.push((sb * r.b - sc * r.c) / r.p);
  }
  const n = rows.length;
  perSeason.push({ yr, n, gap: (eB2 - eC2) / n, dis: variance(d), rmseB: Math.sqrt(eB2 / n), rmseC: Math.sqrt(eC2 / n), rmseP: Math.sqrt(eP2 / n) });
  pooled.eB2 += eB2; pooled.eC2 += eC2; pooled.eP2 += eP2; pooled.d.push(...d); pooled.n += n;
}
db.close();

function variance(a) { const m = a.reduce((s, x) => s + x, 0) / a.length; return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length; }
function solve(gap, dis) {
  const su2 = gap + SM * SM;
  if (su2 <= 0) return { su: 0, rho: NaN, note: "our board is so much more accurate than the consensus that su < 0 is implied -- floored at 0" };
  const su = Math.sqrt(su2);
  const rho = (su2 + SM * SM - dis) / (2 * su * SM);
  return { su, rho, note: rho > 1 || rho < -1 ? `rho ${rho.toFixed(3)} is outside [-1, 1]: the two moments are not jointly reachable at sm ${SM}` : "" };
}

console.log(`\nINFORMATION-MODEL CALIBRATION  sm fixed at ${SM}; pool = top ${POOL} by consensus with prior >= ${MIN_PRIOR} pts; board = ${ART}`);
console.log("season   n   RMSE/p: board  consensus  last-year   gap(eB2-eC2)  var(B-C)/p   ->  su      rho");
for (const s of perSeason) {
  const r = solve(s.gap, s.dis);
  console.log(`${s.yr}   ${String(s.n).padStart(3)}         ${s.rmseB.toFixed(3)}     ${s.rmseC.toFixed(3)}      ${s.rmseP.toFixed(3)}      ${s.gap >= 0 ? "+" : ""}${s.gap.toFixed(4)}      ${s.dis.toFixed(4)}      ${r.su.toFixed(3)}   ${Number.isFinite(r.rho) ? r.rho.toFixed(3) : "n/a"}`);
}
const gapP = (pooled.eB2 - pooled.eC2) / pooled.n, disP = variance(pooled.d);
const P = solve(gapP, disP);
// Season-block bootstrap: the unit of analysis is the season (CLAUDE.md checklist item 1).
const rng = (() => { let s = 12345; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })();
const bs = [];
for (let b = 0; b < 2000; b++) {
  let g = 0, dsum = 0, d2 = 0, n = 0;
  for (let i = 0; i < perSeason.length; i++) {
    const s = perSeason[Math.floor(rng() * perSeason.length)];
    g += s.gap * s.n; dsum += s.dis * s.n; n += s.n;
  }
  const r = solve(g / n, dsum / n);
  if (Number.isFinite(r.rho)) bs.push(r);
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
console.log(`\nPOOLED (${pooled.n} player-seasons, ${perSeason.length} seasons): gap ${gapP >= 0 ? "+" : ""}${gapP.toFixed(4)}, disagreement var ${disP.toFixed(4)}`);
console.log(`  ->  su = ${P.su.toFixed(3)}   rho = ${Number.isFinite(P.rho) ? P.rho.toFixed(3) : "n/a"}   ${P.note}`);
if (bs.length) {
  console.log(`  season-bootstrap 90% intervals: su [${q(bs.map((r) => r.su), 0.05).toFixed(3)}, ${q(bs.map((r) => r.su), 0.95).toFixed(3)}]   ` +
    `rho [${q(bs.map((r) => r.rho), 0.05).toFixed(3)}, ${q(bs.map((r) => r.rho), 0.95).toFixed(3)}]`);
}
console.log(`\n  D37 assumed su = ${SM}, rho = 0.5. Pass the solved values as --our-noise / --our-rho.`);
