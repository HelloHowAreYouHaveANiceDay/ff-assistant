// MIGRATE THE FITTED ARTIFACTS' `bySk` MAPS through identity_rekey.
//
//   node scripts/migrate-sk-maps.mjs [--dry]
//
// WHY THIS IS NOT OPTIONAL, even though both artifacts are RETIRED. `data/age-curve.json` and
// `data/opportunity-model.json` each carry a `bySk` map keyed by `player_sk`, and Phase 2c moved
// 11,946 of those keys. A stale map is not merely useless: the new key space REUSES the same small
// integers, so old key 7278 and new key 7278 are DIFFERENT MEN. The stable-key path would therefore
// return another player's birth year -- which is, precisely, the Antonio Williams defect that made
// the surrogate key necessary, restored by the fix that was supposed to end it.
//
// No caller passes an `sk` to `ageFactor` or `opportunityFactor` today, so nothing is reading it.
// That is exactly why it has to be fixed now rather than when somebody starts.
//
// THE AMBIGUOUS CASE IS DROPPED, NOT GUESSED. Where one old key became several (a `split` -- the row
// stood for more than one man), the map cannot say which of them the fitted value belongs to, so the
// entry is removed and counted. `ageFactor` already treats a missing entry as "fall through", and
// `models.ts` checks the map is still populated, so a drop is visible in both directions.
//
// Idempotent by a STAMP rather than by inspection: a migrated map and a fresh one both hold keys in
// 1..12122 and are indistinguishable by value. `skRebuiltAt` records the rekey this file was
// migrated for, and a second run against the same rekey is a no-op that says so.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";

const DRY = process.argv.includes("--dry");
const db = new Database("data/ff.db", { readonly: true });

let rekey;
try {
  rekey = db.prepare("SELECT old_sk, new_sk, reason, rebuilt_at FROM identity_rekey WHERE new_sk IS NOT NULL").all();
} catch { console.log("no identity_rekey table -- nothing to migrate"); process.exit(0); }
db.close();
if (!rekey.length) { console.log("identity_rekey is empty -- nothing to migrate"); process.exit(0); }

const STAMP = rekey[0].rebuilt_at;
const map = new Map();
for (const r of rekey) (map.get(r.old_sk) ?? map.set(r.old_sk, []).get(r.old_sk)).push(r.new_sk);

/** old sk -> the single new sk, or null where the old key split into several. */
const one = (old) => {
  const v = map.get(Number(old));
  return v && v.length === 1 ? v[0] : null;
};

const FILES = [
  { path: "data/age-curve.json", key: (k) => k, unkey: (k) => String(k) },
  // "season|player_sk" -- the season half is untouched, the sk half migrates.
  { path: "data/opportunity-model.json", key: (k) => k.split("|")[1], unkey: (k, orig) => `${orig.split("|")[0]}|${k}` },
];

for (const f of FILES) {
  if (!existsSync(f.path)) { console.log(`${f.path}: absent`); continue; }
  const j = JSON.parse(readFileSync(f.path, "utf8"));
  if (!j.bySk || typeof j.bySk !== "object") { console.log(`${f.path}: no bySk map`); continue; }
  if (j.skRebuiltAt === STAMP) { console.log(`${f.path}: already migrated for this rekey (${STAMP})`); continue; }
  const out = {};
  let moved = 0, kept = 0, split = 0, unmapped = 0, collided = 0;
  for (const [k, v] of Object.entries(j.bySk)) {
    const old = f.key(k);
    const n = one(old);
    if (n == null) {
      if (map.has(Number(old))) split++; else unmapped++;
      continue;
    }
    const nk = f.unkey(String(n), k);
    if (nk in out) { collided++; continue; }        // a merge: the first fitted value stands
    out[nk] = v;
    if (String(n) === String(old)) kept++; else moved++;
  }
  const before = Object.keys(j.bySk).length, after = Object.keys(out).length;
  console.log(`${f.path}: ${before} -> ${after} entries  (${moved} moved, ${kept} unchanged, ` +
    `${split} dropped as SPLIT, ${unmapped} dropped as unmapped, ${collided} dropped on a merge collision)`);
  if (DRY) continue;
  j.bySk = out;
  j.skRebuiltAt = STAMP;
  // Written with the SAME shape the fitter emits -- two-space indent, CRLF -- so the diff is the
  // keys that moved and not a reformat of a 660kb file on top of them.
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  writeFileSync(f.path, JSON.stringify(j, null, 2).split(LF).join(CR + LF), "utf8");
}
console.log(DRY ? "\n(dry run -- nothing written)" : "\ndone");
