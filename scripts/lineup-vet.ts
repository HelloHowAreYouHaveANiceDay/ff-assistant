/**
 * SCORE A PRE-REGISTERED LINEUP DECISION (2026-09-25).
 *
 *   node --import tsx scripts/lineup-vet.ts data/decisions/2026-wk3-lineup.json [--league 462233]
 *
 * The decision file is written and COMMITTED before kickoff (its commit is the timestamp); this reads it
 * after the games and scores it on ESPN's own applied points (`raw_league_roster_week`, the league's
 * scoring, including any stat corrections already synced) -- falling back to `feat_player_week.pts`
 * for a man ESPN has no row for. It prints: each player's realised points against each source's
 * prediction and band, which lineup won and by how much, and which sources called the winner.
 * A player without a realised score is reported MISSING, never counted as zero.
 */
import { readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) throw new Error("usage: lineup-vet.ts <decision.json> [--league <id>]");
const li = argv.indexOf("--league");
const LEAGUE = li >= 0 ? argv[li + 1] : "462233";
const rec = JSON.parse(readFileSync(file, "utf8"));
const m = String(rec.decision).match(/(\d{4}) week (\d+)/);
if (!m) throw new Error(`cannot read season/week from decision "${rec.decision}"`);
const season = Number(m[1]), week = Number(m[2]);
const db = openDb() as any;
const espnPts = db.prepare("SELECT applied_points p FROM raw_league_roster_week WHERE league_id=? AND season=? AND week=? AND name=? ORDER BY fetched_at DESC LIMIT 1");
const featPts = db.prepare("SELECT pts p FROM feat_player_week WHERE season=? AND week=? AND name=? AND pts IS NOT NULL");

const actual: Record<string, number | null> = {};
for (const n of Object.keys(rec.predictions)) {
  const e = espnPts.get(LEAGUE, season, week, n)?.p;
  actual[n] = e != null ? Number(e) : (featPts.get(season, week, n)?.p ?? null);
}
console.log(`\n${rec.decision}\nrecorded ${rec.recorded_at}\n`);
console.log("player                  actual   live model (band)        frozen 9/17 (band)       espn");
for (const [n, p] of Object.entries<any>(rec.predictions)) {
  const a = actual[n];
  const band = (x: any) => (x ? `${x.mean.toFixed(1).padStart(5)} (${x.p10.toFixed(1)}-${x.p90.toFixed(1)})${a != null && (a < x.p10 || a > x.p90) ? " OUT" : "    "}` : "   -              ");
  console.log(`${n.padEnd(22)} ${a == null ? "MISSING" : a.toFixed(1).padStart(6)}   ${band(p.live_model).padEnd(24)} ${band(p.frozen_0917).padEnd(24)} ${p.espn ?? "-"}`);
}
const total = (names: string[]): number | null => names.every((n) => actual[n] != null) ? names.reduce((s, n) => s + (actual[n] as number), 0) : null;
const A = [rec.lineups.A_model.TE, ...rec.lineups.A_model.FLEX], B = [rec.lineups.B_override.TE, ...rec.lineups.B_override.FLEX];
const tA = total(A), tB = total(B);
if (tA == null || tB == null) { console.log("\nNOT SCORED: a contested player has no realised points yet (sync actuals after the last game)."); process.exit(0); }
const winner = tA > tB ? "A_model" : tB > tA ? "B_override" : "tie";
console.log(`\nrealised: A (model) ${tA.toFixed(1)} vs B (override) ${tB.toFixed(1)} -> ${winner} by ${Math.abs(tA - tB).toFixed(1)}  (decisive: ${rec.decisive.A} ${actual[rec.decisive.A]} vs ${rec.decisive.B} ${actual[rec.decisive.B]})`);
for (const [src, v] of Object.entries<any>(rec.predicted_totals)) {
  const called = v.A > v.B ? "A_model" : v.B > v.A ? "B_override" : "tie";
  console.log(`  ${src.padEnd(12)} predicted A-B ${(v.A - v.B >= 0 ? "+" : "")}${(v.A - v.B).toFixed(2).padStart(5)} -> called ${called.padEnd(10)} ${called === winner ? "RIGHT" : "WRONG"}   realised A-B ${(tA - tB >= 0 ? "+" : "")}${(tA - tB).toFixed(1)}`);
}
console.log("\nOne week is one draw. Read it as a case study of the variables the model could not see, not as a verdict on the model.");
