// THE CULMINATION: our-model Yahoo waiver/trade analysis. Our Yahoo projector + superflex VOR value
// my roster and the live FA pool on the SAME format-native scale, then: optimal superflex lineup,
// weakest startable slots, FA upgrades, and the QB-surplus trade angle.
// Full-season preseason value; weeks 1-2 not yet folded in (D18 ROS blend is the refinement).
import { readFileSync } from "node:fs";
import { openDb } from "../src/db/db.ts";
import { liveYahooPool } from "./yahoo-live-pool.mjs";
import { resolveFormat } from "../src/data/formatResolve.ts";
import { resolveLeagueContext } from "../src/data/leagueContext.ts";
import { loadArtifact } from "../src/model/projector.ts";
import { boardProjection } from "../src/model/features.ts";
import { computeValues, resolveValueLeague, baselines, nameKey, slotEligibility } from "../src/draft/values.ts";
import { dataPath } from "../src/data/paths.ts";

const season = 2026;
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
// OUR ROSTER AND THE FREE-AGENT POOL, READ LIVE FROM YAHOO (WP9). Both used to be literals in this
// file: an eighteen-name array, and `data/formats/<key>/fa-pool.json`, a hand-scraped list with no
// producer. Both were stale within hours of being written -- when this changed, the array still had
// Michael Mayer and Chris Bell, whom we had already dropped, and did not have Mike Gesicki or
// Devaughn Vele, whom we had added. See scripts/yahoo-live-pool.mjs.
const LIVE = await liveYahooPool(LEAGUE);
const MY_ROSTER = LIVE.ours;
if (LIVE.overlap.length) throw new Error(`yahoo pool control FAILED: ${LIVE.overlap.length} "available" player(s) are on a roster (${LIVE.overlap.slice(0, 5).map((f) => f.name).join(", ")}). One of the two reads is of the wrong thing; refusing to rank a pool that contains rostered men.`);

const db = openDb(FMT.model.require("features-db"));
const art = loadArtifact(JSON.parse(readFileSync(FMT.model.require("projection"), "utf8")), { checkGolden: true });
const proj = boardProjection(db, season, art).filter((r) => r.mean > 0);
db.close();
const lg = resolveValueLeague(cfg);
const points = proj.map((r) => ({ name: r.name, pos: r.pos, points: r.mean }));
const base = baselines(points, lg);
const vals = computeValues(points, lg, cfg.levers?.maxKDst ?? 2);
const byKey = new Map();
for (const v of vals) { const p = points.find((x) => x.name === v.name); byKey.set(nameKey(v.name), { ...v, points: p?.points ?? 0 }); }
const look = (n) => byKey.get(nameKey(n)) ?? { value: 1, pos: "?", valuePos: "?", points: 0 };

// --- optimal superflex lineup from my roster (greedy by value into eligibility-typed slots) --------
const starterSlots = cfg.slots.filter((s) => !/^(BE|IR|ER)$/i.test(s)).map((s) => ({ slot: s, elig: new Set(slotEligibility(s)) }))
  .sort((a, b) => a.elig.size - b.elig.size);        // fill dedicated first, superflex last
const mine = MY_ROSTER.map((n) => ({ name: n, ...look(n) })).sort((a, b) => b.value - a.value);
const filled = []; const used = new Set();
for (const slot of starterSlots) {
  const pick = mine.find((m) => !used.has(m.name) && slot.elig.has(m.pos));
  if (pick) { used.add(pick.name); filled.push({ slot: slot.slot, ...pick }); }
  else filled.push({ slot: slot.slot, name: "(empty)", value: 0, pos: "-" });
}
const bench = mine.filter((m) => !used.has(m.name));

console.log(`OUR-MODEL waiver/trade analysis -- league ${LEAGUE}, format ${FMT.scoringKey}, ${season}`);
console.log(`Replacement baselines (pts): QB ${base.QB?.toFixed(0)} RB ${base.RB?.toFixed(0)} WR ${base.WR?.toFixed(0)} TE ${base.TE?.toFixed(0)}\n`);
console.log(`=== MY OPTIMAL STARTING LINEUP (our value) ===`);
for (const f of filled) console.log(`  ${f.slot.padEnd(9)} $${String(f.value).padStart(3)}  ${(f.pos ?? "-").padEnd(3)} ${f.name}`);
const startVals = filled.filter((f) => f.value > 0).map((f) => f.value);
const weakest = Math.min(...startVals);
console.log(`  --> weakest startable value: $${weakest}`);
console.log(`\n  BENCH: ${bench.map((b) => `${b.name} $${b.value}(${b.pos})`).join(", ")}`);

// --- FA pool overlaid with our value ------------------------------------------------------------
// THE REAL POOL, from Yahoo's own `status=A` player list through the adaptor -- not a file.
const fa = LIVE.fa;
const faVals = [];
for (const f of fa) { const v = byKey.get(nameKey(f.name)); if (v) faVals.push({ name: f.name, pos: v.valuePos ?? v.pos, value: v.value, points: v.points }); }
const seen = new Set(); const faUniq = faVals.filter((f) => (seen.has(nameKey(f.name)) ? false : seen.add(nameKey(f.name))));
faUniq.sort((a, b) => b.value - a.value);
console.log(`\n=== BEST AVAILABLE (our value), of ${fa.length} available read live from Yahoo (${fa.filter((f) => f.waivers).length} still on waivers; 0 of them on any roster -- checked) ===`);
for (const f of faUniq.slice(0, 15)) {
  const up = f.value > weakest ? `  <-- UPGRADE over $${weakest} flex` : "";
  console.log(`  $${String(f.value).padStart(3)}  ${f.pos.padEnd(3)} ${f.name.padEnd(24)} ${f.points.toFixed(0)}pt${up}`);
}
const upgrades = faUniq.filter((f) => f.value > weakest);
console.log(`\n  ${upgrades.length} FA(s) beat my weakest startable slot ($${weakest}).`);
