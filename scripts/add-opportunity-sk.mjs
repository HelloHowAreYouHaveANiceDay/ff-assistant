// Add a player_sk-keyed usage map to data/opportunity-model.json.
//
//   node --import tsx scripts/add-opportunity-sk.mjs
//
// The model bakes prior-season usage keyed "season|Name". That is the same name-keyed join that put
// a father's birth year on his son in the age curve, and it is wrong here for the same reason: two
// men who share a normalised name share a usage record. This adds a parallel map keyed
// "season|player_sk", which opportunity.ts prefers when a key is available.
//
// A SEPARATE SCRIPT rather than an edit to the fit, deliberately: the fit is a 20-season download and
// re-running it to attach ids would cost several minutes to change nothing about the model itself.
// This reads the artifact, adds a key, and writes it back -- so the fitted numbers are provably
// untouched, which is a property worth having when the thing being changed is identity.
import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { nameKey } from "../src/draft/values.ts";

const path = "data/opportunity-model.json";
const model = JSON.parse(readFileSync(path, "utf8"));
const before = JSON.stringify({ pos: model.pos, amplitude: model.amplitude, bucketMeans: model.bucketMeans });

const db = new Database("data/ff.db", { readonly: true });
const byNK = new Map();
for (const r of db.prepare("SELECT name_key, player_sk FROM stg_player").all()) {
  // Name-only, because the usage map has no position in its key. Where a name is shared this stores
  // null and the entry is skipped -- an ambiguous name gets no sk-keyed record and falls back to the
  // name map, which is exactly as good as it was before and no worse.
  byNK.set(r.name_key, byNK.has(r.name_key) ? null : r.player_sk);
}
db.close();

const bySk = {};
let resolved = 0, ambiguous = 0, unknown = 0;
for (const [key, u] of Object.entries(model.players ?? {})) {
  const i = key.indexOf("|");
  const season = key.slice(0, i), name = key.slice(i + 1);
  const sk = byNK.get(nameKey(name));
  if (sk === undefined) { unknown++; continue; }
  if (sk === null) { ambiguous++; continue; }
  bySk[`${season}|${sk}`] = u;
  resolved++;
}
model.bySk = bySk;
writeFileSync(path, JSON.stringify(model, null, 2));

// The fitted model must be BYTE-IDENTICAL apart from the new key. Asserted rather than assumed,
// because "I only added a field" is exactly the claim that turns out to be false.
const after = JSON.parse(readFileSync(path, "utf8"));
const unchanged = JSON.stringify({ pos: after.pos, amplitude: after.amplitude, bucketMeans: after.bucketMeans }) === before;
console.log(`opportunity-model.json: ${resolved} usage records keyed by player_sk`);
console.log(`  ${ambiguous} skipped (name shared by more than one player -- falls back to the name map)`);
console.log(`  ${unknown} skipped (registry does not know the name)`);
console.log(`  fitted coefficients unchanged: ${unchanged ? "YES" : "*** NO -- something else was modified ***"}`);
if (!unchanged) process.exit(1);
