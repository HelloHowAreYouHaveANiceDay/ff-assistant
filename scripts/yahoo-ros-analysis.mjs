// STEP 4: our-model Yahoo waiver/trade analysis on REST-OF-SEASON value (D18 blend, retargeted).
// Each player's ROS per-week = (K*line + k*rate)/(K+k) via the shipped rosPerGame, with line = our
// Yahoo preseason projection/17 and rate = to-date Yahoo points/weeks played. K=6 (data/ros-blend.json,
// an NFL-level stabilization constant; refitting on Yahoo scoring is a minor follow-up). Then VOR under
// the Yahoo superflex config on ROS totals. Only week 1 is final, so the update is deliberately modest.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { resolveFormat } from "../src/data/formatResolve.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines, nameKey, slotEligibility } from "../src/draft/values.ts";
import { rosPerGame, loadRosBlend } from "../src/draft/rosBlend.ts";
import { dataPath } from "../src/data/paths.ts";

// WHICH LEAGUE / WHICH FORMAT (WP3/F-6). This used to hardcode `"sc-a845f67652fb"` and `"129048"`:
// the directory name was a literal in a source file, so nothing could tell a model of a LEAGUE from a
// model of a typo, and a re-key would have left five scripts reading a directory that no longer
// exists. `resolveFormat` derives the key from the league's stored scoring and verifies the
// directory's `scoring.json` preimage before handing back a path.
//   --league <id>   (default: the store's one league whose format is NOT the incumbent)
function formatArg(db) {
  const i = process.argv.indexOf("--league");
  if (i >= 0) return resolveFormat(db, process.argv[i + 1]);
  const rows = db.prepare("SELECT league_id FROM league ORDER BY league_id").all();
  const nonIncumbent = rows.map((r) => String(r.league_id))
    .map((id) => { try { return resolveFormat(db, id); } catch { return null; } })
    .filter((f) => f && f.provenance === "format-dir");
  if (nonIncumbent.length === 1) return nonIncumbent[0];
  throw new Error(`pass --league <id>: this store has ${nonIncumbent.length} leagues on a built ` +
    `non-incumbent format (${rows.map((r) => r.league_id).join(", ")} exist), so there is no unambiguous default.`);
}

const mainDb = openDb();
const FMT = formatArg(mainDb);
const LEAGUE = FMT.leagueId;
const cfg = resolveLeagueContext(mainDb, LEAGUE).config;
mainDb.close();
const MY_ROSTER = ["Jared Goff", "Joe Burrow", "Tyler Shough", "Omarion Hampton", "Chase Brown",
  "Jacory Croskey-Merritt", "Tyjae Spears", "Mike Washington", "Emmett Johnson", "Garrett Wilson",
  "Jameson Williams", "Carnell Tate", "Makai Lemon", "Omar Cooper", "Chris Bell", "Kyle Pitts",
  "Michael Mayer", "Isiah Pacheco"];

const { blend, source } = loadRosBlend();
const K = blend.K;

// --- preseason projection (the line) ---
const db = openDb(FMT.model.require("features-db"));
const art = loadArtifact(JSON.parse(readFileSync(FMT.model.require("projection"), "utf8")), { checkGolden: true });
const proj = boardProjection(db, 2026, art).filter((r) => r.mean > 0);
db.close();

// --- to-date 2026 Yahoo points + weeks played, from the weekly target ---
// THE LIVE SEASON LIVES IN current-actuals.csv, NOT IN history-weekly.csv (F-8, WP3). The format
// target is now frozen at SETTLED seasons -- a partial live season inside a backtest input is half a
// season presented as a season -- so the to-date rate comes from the format's own current-actuals,
// written by `ff sync-actuals --league <id>`. Absent, this REFUSES BY NAME: silently reading zero
// played weeks makes every ROS value identical to the preseason line and looks like a working blend
// (it did, for one run: "week 0 final, 17 wks left").
const wkPath = FMT.model.path("current-actuals");
if (!existsSync(wkPath)) {
  console.error(`${wkPath} does not exist -- this format has no live-season actuals, so there is no ` +
    `rate to blend the preseason line with. Run \`npm run ff -- sync-actuals --league ${LEAGUE}\` first.`);
  process.exit(1);
}
const wk = readFileSync(wkPath, "utf8").trim().split("\n").slice(1);
const td = new Map(); // nameKey -> {pts, games}
let maxWk = 0;
for (const l of wk) { const c = l.split(","); if (+c[0] !== 2026) continue; const k = nameKey(c[1]); const a = td.get(k) ?? { pts: 0, games: 0 }; a.pts += +c[4]; a.games++; td.set(k, a); maxWk = Math.max(maxWk, +c[3]); }
const REMAINING = 17 - maxWk;   // scheduled weeks left after the last played week

// --- ROS totals: blend line/17 with the observed rate, spread over remaining weeks ---
const rosPoints = proj.map((r) => {
  const linePg = r.mean / 17;
  const a = td.get(nameKey(r.name));
  const pg = rosPerGame(linePg, a?.games ?? 0, a?.pts ?? null, K);
  return { name: r.name, pos: r.pos, points: (pg ?? linePg) * REMAINING, preseason: r.mean, wk1: a?.pts ?? null };
});

const lg = resolveValueLeague(cfg);
const base = baselines(rosPoints, lg);
const vals = computeValues(rosPoints, lg, cfg.levers?.maxKDst ?? 2);
const byKey = new Map();
for (const v of vals) { const p = rosPoints.find((x) => x.name === v.name); byKey.set(nameKey(v.name), { ...v, ...p }); }
const look = (n) => byKey.get(nameKey(n)) ?? { value: 1, pos: "?", valuePos: "?", points: 0, wk1: null };

console.log(`OUR-MODEL Yahoo ROS analysis (D18 blend K=${K}, ${source}; week ${maxWk} final, ${REMAINING} wks left)`);
console.log(`ROS replacement baselines (pts over ${REMAINING} wks): QB ${base.QB?.toFixed(0)} RB ${base.RB?.toFixed(0)} WR ${base.WR?.toFixed(0)} TE ${base.TE?.toFixed(0)}\n`);

// optimal superflex lineup
const slots = cfg.slots.filter((s) => !/^(BE|IR|ER)$/i.test(s)).map((s) => ({ slot: s, elig: new Set(slotEligibility(s)) })).sort((a, b) => a.elig.size - b.elig.size);
const mine = MY_ROSTER.map((n) => ({ name: n, ...look(n) })).sort((a, b) => b.value - a.value);
const used = new Set(); const filled = [];
for (const s of slots) { const p = mine.find((m) => !used.has(m.name) && s.elig.has(m.pos)); if (p) { used.add(p.name); filled.push({ slot: s.slot, ...p }); } else filled.push({ slot: s.slot, name: "(empty)", value: 0 }); }
console.log(`=== MY STARTING LINEUP (ROS value) ===`);
for (const f of filled) console.log(`  ${f.slot.padEnd(9)} $${String(f.value).padStart(3)}  ${(f.valuePos ?? f.pos ?? "-").padEnd(3)} ${f.name}`);
const weakest = Math.min(...filled.filter((f) => f.value > 0).map((f) => f.value));
console.log(`  weakest startable: $${weakest};  BENCH: ${mine.filter((m) => !used.has(m.name)).map((b) => `${b.name} $${b.value}`).join(", ")}`);

// FA overlay
const fa = JSON.parse(readFileSync(join(FMT.model.dir, "fa-pool.json"), "utf8"));
const seen = new Set(); const faVals = [];
for (const f of fa) { const v = byKey.get(nameKey(f.name)); if (v && !seen.has(nameKey(f.name))) { seen.add(nameKey(f.name)); faVals.push(v); } }
faVals.sort((a, b) => b.value - a.value);
console.log(`\n=== BEST AVAILABLE (ROS value) ===`);
for (const f of faVals.slice(0, 12)) console.log(`  $${String(f.value).padStart(3)}  ${(f.valuePos ?? f.pos).padEnd(3)} ${f.name.padEnd(22)} ROS ${f.points.toFixed(0)}  wk1 ${f.wk1 == null ? "-" : f.wk1.toFixed(0)}  (pre ${f.preseason.toFixed(0)})${f.value > weakest ? "  <-- UPGRADE" : ""}`);
console.log(`\n  ${faVals.filter((f) => f.value > weakest).length} FA(s) beat weakest startable ($${weakest}).`);
