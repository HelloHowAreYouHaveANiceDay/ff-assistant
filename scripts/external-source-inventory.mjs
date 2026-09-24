// WHAT EXTERNAL, WEEKLY-VARYING INFORMATION DOES THE STORE ALREADY HOLD THAT THE WEEKLY MODEL DOES
// NOT FIT?
//
// This starts the second round of feature exploration from PROVENANCE rather than from residual
// correlation, because the first round's verdict was that provenance is what separated the one
// admitted feature from the four rejects (docs/validation.md, 2026-09-24):
//
//   ecr_wk_rank  +0.04134 pooled CRPS, 19x our floor   EXTERNAL  (a human panel's weekly forecast)
//   four rejects +0.03x to -1.14x of the floor          DERIVED  (recombinations of the same rows
//                                                                 the model's own history is built
//                                                                 from)
//
// A boosted tree already expresses any monotone recombination of what it holds, so a derived column
// buys parameters rather than information. The question worth asking is therefore NOT "what else can
// be computed from the box scores" but "what does somebody ELSE know each week that we are not
// reading".
//
// THREE THINGS DISQUALIFY A TABLE HERE, and each is checked rather than assumed:
//   - NO WEEKLY VARIATION. A season-constant column cannot explain week-to-week residual; the model
//     already has the season line, which is the best season-constant summary there is.
//   - NO PLAYER KEY. Team-level context is largely carried by the odds block already.
//   - ALREADY FITTED. A column on the served artifact's 26 is not a candidate.
//
// It reports COVERAGE ON THE LIVE SEASON too, because a source that is rich in history and empty in
// 2026 cannot help a decision this year -- that is the ecr_wk_rank situation exactly.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const db = new Database("data/ff.db", { readonly: true });
const FITTED = new Set(JSON.parse(readFileSync("data/weekly-artifact.json", "utf8")).features.map((f) => f.name));

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all().map((r) => r.name);

const PLAYER_KEYS = ["player_sk", "gsis_id", "player_id", "espn_player_id", "feat_key", "name"];
const rows = [];
for (const t of tables) {
  let cols;
  try { cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); } catch { continue; }
  const hasWeek = cols.includes("week");
  const hasSeason = cols.includes("season");
  const key = PLAYER_KEYS.find((k) => cols.includes(k)) ?? null;
  if (!hasWeek || !hasSeason || !key) continue;   // needs week-level variation AND a player key
  let n = 0, live = 0, seasons = 0;
  try {
    n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    live = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE season = 2026`).get().c;
    seasons = db.prepare(`SELECT COUNT(DISTINCT season) c FROM ${t}`).get().c;
  } catch { continue; }
  if (!n) continue;
  // Columns that are plausibly a MEASURE rather than a key/label.
  const measures = cols.filter((c) =>
    !PLAYER_KEYS.includes(c) && !["season", "week", "team", "opponent", "pos", "position",
      "as_of", "as_of_start", "as_of_end", "fetched_at", "updated_at", "league_id", "game_id"].includes(c));
  rows.push({ t, n, live, seasons, key, measures, fittedHits: measures.filter((m) => FITTED.has(m)) });
}

rows.sort((a, b) => b.live - a.live || b.n - a.n);
console.log(`weekly + player-keyed tables in the store: ${rows.length}\n`);
console.log("table                          rows     2026    seasons  key         fitted?  measures");
for (const r of rows) {
  console.log(
    r.t.padEnd(30), String(r.n).padStart(8), String(r.live).padStart(8), String(r.seasons).padStart(7),
    " " + (r.key ?? "-").padEnd(12),
    (r.fittedHits.length ? `${r.fittedHits.length} fitted` : "none").padEnd(8),
    r.measures.slice(0, 6).join(",") + (r.measures.length > 6 ? ` (+${r.measures.length - 6})` : ""),
  );
}

console.log("\n\nREADING THIS: a table with rows in 2026 and NO fitted measures is where a second round");
console.log("should look FIRST -- it is information the store already pays to collect and the model");
console.log("does not read. A table rich in history but empty in 2026 cannot move a decision this");
console.log("season however good it looks historically.");
db.close();
