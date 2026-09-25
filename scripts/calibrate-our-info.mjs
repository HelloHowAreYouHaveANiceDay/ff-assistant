// CALIBRATE THE ARBITER'S INFORMATION MODEL -- both sides of the table (D38, D39).
//
// THE MODEL. With p = the player's prior-season actual points (the replay's reference) and
// delta = (Y - p) / p the change that actually happened (clipped to [-1, 3]):
//   room view  M = p (1 + km * delta + sm * zm)
//   our view   U = p (1 + ku * delta + su * (rho * zm + sqrt(1 - rho^2) * zu))
// k is how much of the REAL change a forecaster saw coming (information); s is its noise; rho is how
// much of our noise is the room's. Until D39 the room was km = 0, sm = 0.30 ASSUMED -- a room that can
// only be WORSE than last season's points, while the real consensus is BETTER than them. This measures
// all five, on real point-in-time projections, by regressing each forecaster's change-from-last-year on
// the change that happened (season fixed effects): the slope is k, the residual sd is s, the residual
// correlation between the two forecasters is rho.
//
// THE TWO FORECASTERS are built EXACTLY as `ff backtest --market ecr` builds them: the room = the
// consensus curve read at the real ECR rank (blind to its season); us = `boardProjection` with the blind
// per-season fold artifact. 2020-2025 is the only span with both.
//
// POSITIVE CONTROLS: `--board consensus` (B := C) must reproduce the room's k/s with rho = 1;
// `--board last-year` (B := p) must give ku = 0, su = 0.
//
// Usage: node scripts/calibrate-our-info.mjs [--league <id>] [--seasons 2020-2025] [--pool N]
//          [--min-prior 30] [--board ours|consensus|last-year] [--write]
//   --league  the FORMAT to calibrate (its own feature store and fold artifacts); omitted = the incumbent.
//   --pool    default: teams x non-IR roster slots of that league -- the players the room actually prices.
//   --write   save the result to that format's info-model.json (read by `ff backtest`).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { importTs } from "./lib/ensure-tsx.mjs";

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LEAGUE = val("--league", null);
const [lo, hi] = val("--seasons", "2020-2025").split("-").map(Number);
const MIN_PRIOR = Number(val("--min-prior", "30"));
const BOARD = val("--board", "ours");
const WRITE = argv.includes("--write");
const DELTA_HI = 3;

const { openDb, getConfig, activeLeagueId } = await importTs("../src/db/db.ts", import.meta.url);
const { INCUMBENT_MODEL, resolveFormat } = await importTs("../src/data/formatResolve.ts", import.meta.url);
const { loadArtifact, projectSeason } = await importTs("../src/model/projector.ts", import.meta.url);
const { buildCurveOnlyArtifact } = await importTs("../src/model/build.ts", import.meta.url);
const { loadFeatureRows, boardProjection } = await importTs("../src/model/features.ts", import.meta.url);

// The format and its league shape.
const store = openDb();
const leagueId = LEAGUE ?? activeLeagueId(store);
const model = LEAGUE ? resolveFormat(store, LEAGUE).model : INCUMBENT_MODEL;
const cfg = getConfig(store, leagueId);
store.close();
const rostered = cfg.teams * cfg.slots.filter((s) => !/^(IR|ER)$/i.test(s)).length;
const POOL = Number(val("--pool", String(rostered)));
const featDb = model.path("features-db");
const ART = model.path("fold-artifacts");

const db = openDb(featDb);
const key = (r) => r.player_sk ?? `${r.pos}|${r.name}`;
const clip = (d) => Math.max(-1, Math.min(DELTA_HI, d));
const seasons = [];
for (let yr = lo; yr <= hi; yr++) {
  const p = `${ART}/artifact-${yr}.json`;
  if (!existsSync(p)) { console.log(`${yr}: no blind artifact at ${p} -- skipped`); continue; }
  const ours = loadArtifact(JSON.parse(readFileSync(p, "utf8")));
  if (ours.holdoutSeason !== yr) throw new Error(`${p} declares holdoutSeason ${ours.holdoutSeason}, not ${yr}`);
  const { artifact: curveArt } = buildCurveOnlyArtifact({ dbPath: featDb, from: 1999, to: 2025, base: "curve_value_ecr", holdoutSeason: yr, pointInTime: true });
  const mFeat = loadFeatureRows(db, { season: yr, rankBasis: "ecr", base: "curve_value_ecr" });
  const C = new Map(projectSeason({ season: yr, asOf: `${yr}-09-01`, artifact: curveArt, features: mFeat }).map((r) => [key(r), r.mean]));
  const B = BOARD === "consensus" ? C : new Map(boardProjection(db, yr, ours).map((r) => [key(r), r.mean]));
  const truth = db.prepare("SELECT player_sk, name, pos, pts, prior_pts FROM feat_player_season WHERE season = ? AND pts IS NOT NULL AND prior_pts IS NOT NULL").all(yr);
  let rows = truth.map((t) => ({ y: t.pts, p: t.prior_pts, c: C.get(key(t)), b: BOARD === "last-year" ? (B.get(key(t)) != null ? t.prior_pts : undefined) : B.get(key(t)) }))
    .filter((r) => r.b != null && r.c != null && r.p >= MIN_PRIOR);
  rows.sort((a, b) => b.c - a.c);
  rows = rows.slice(0, POOL);
  if (rows.length < 50) { console.log(`${yr}: only ${rows.length} usable rows -- skipped`); continue; }
  // Season fixed effects: a LEVEL shift common to every player (a forecaster that runs 5% hot all year)
  // moves no auction price, so each series is demeaned within its season.
  const dmean = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return a.map((x) => x - m); };
  // A DIRECT accuracy read, independent of the regression: each view level-scaled to the realised
  // total, error in units of p. Printed beside the fit so a surprising k/s can be checked against it.
  const sy = rows.reduce((a, r) => a + r.y, 0);
  const sB = sy / rows.reduce((a, r) => a + r.b, 0), sC = sy / rows.reduce((a, r) => a + r.c, 0);
  const rmse = (f) => Math.sqrt(rows.reduce((a, r) => a + ((f(r) - r.y) / r.p) ** 2, 0) / rows.length);
  seasons.push({
    rmseB: rmse((r) => sB * r.b), rmseC: rmse((r) => sC * r.c), rmseP: rmse((r) => r.p),
    yr, n: rows.length,
    delta: dmean(rows.map((r) => clip((r.y - r.p) / r.p))),
    dC: dmean(rows.map((r) => (r.c - r.p) / r.p)),
    dB: dmean(rows.map((r) => (r.b - r.p) / r.p)),
  });
}
db.close();

function fit(ss) {
  const x = ss.flatMap((s) => s.delta), c = ss.flatMap((s) => s.dC), b = ss.flatMap((s) => s.dB);
  const dot = (u, v) => u.reduce((s, ui, i) => s + ui * v[i], 0);
  const vx = dot(x, x);
  const km = dot(c, x) / vx, ku = dot(b, x) / vx;
  const rC = c.map((ci, i) => ci - km * x[i]), rB = b.map((bi, i) => bi - ku * x[i]);
  const sm = Math.sqrt(dot(rC, rC) / rC.length), su = Math.sqrt(dot(rB, rB) / rB.length);
  const rho = sm > 0 && su > 0 ? dot(rC, rB) / rC.length / (sm * su) : NaN;
  return { km, sm, ku, su, rho, n: x.length };
}

const P = fit(seasons);
const rng = (() => { let s = 12345; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; })();
const bs = [];
for (let b = 0; b < 2000; b++) bs.push(fit(seasons.map(() => seasons[Math.floor(rng() * seasons.length)])));
const q = (k, p) => { const s = bs.map((r) => r[k]).filter(Number.isFinite).sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");

console.log(`\nINFORMATION-MODEL CALIBRATION  format ${model.scoringKey} (league ${leagueId}); board = ${BOARD}; pool = top ${POOL} by consensus with prior >= ${MIN_PRIOR} pts`);
console.log("season   n     room: k     s       us: k     s      rho      RMSE/p: room   ours   last-year");
for (const s of seasons) {
  const r = fit([s]);
  console.log(`${s.yr}   ${String(s.n).padStart(3)}        ${f3(r.km)}  ${f3(r.sm)}       ${f3(r.ku)}  ${f3(r.su)}   ${f3(r.rho)}           ${f3(s.rmseC)}  ${f3(s.rmseB)}  ${f3(s.rmseP)}`);
}
console.log(`\nPOOLED (${P.n} player-seasons, ${seasons.length} seasons), season-bootstrap 90% intervals:`);
for (const [k, label] of [["km", "room information  km"], ["sm", "room noise        sm"], ["ku", "our information   ku"], ["su", "our noise         su"], ["rho", "shared noise     rho"]]) {
  console.log(`  ${label} = ${f3(P[k])}   [${f3(q(k, 0.05))}, ${f3(q(k, 0.95))}]`);
}

if (WRITE) {
  if (BOARD !== "ours") throw new Error("--write is only meaningful for --board ours (the controls are not calibrations)");
  const out = model.path("info-model");
  const doc = {
    _what: "The arbiter's information model for this format (docs/decisions.md D38/D39): each forecaster's view is p (1 + k * delta + s * z), delta = (Y - p)/p clipped to [-1, 3]; our z shares rho with the room's. Read by `ff backtest`; `--room-info legacy` ignores it.",
    scoringKey: model.scoringKey, league: String(leagueId),
    roomKappa: Number(P.km.toFixed(4)), roomSd: Number(P.sm.toFixed(4)),
    ourKappa: Number(P.ku.toFixed(4)), ourSd: Number(P.su.toFixed(4)), rho: Number(P.rho.toFixed(4)),
    deltaClip: [-1, DELTA_HI],
    intervals90: Object.fromEntries(["km", "sm", "ku", "su", "rho"].map((k) => [k, [Number(q(k, 0.05).toFixed(4)), Number(q(k, 0.95).toFixed(4))]])),
    measuredOn: { seasons: seasons.map((s) => s.yr), playerSeasons: P.n, pool: POOL, minPrior: MIN_PRIOR, foldArtifacts: ART, featuresDb: featDb },
    command: `node scripts/calibrate-our-info.mjs${LEAGUE ? ` --league ${LEAGUE}` : ""} --write`,
    measuredAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\nwrote ${out}`);
}
