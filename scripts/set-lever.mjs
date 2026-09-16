// Patch ONE lever in a league's PERSISTED config and read it back.
// getConfig() merges stored levers OVER the code defaults, so changing DEFAULT_LEVERS alone does
// nothing for the live agent -- and the write must be verified by re-reading, not trusted.
//
//   node scripts/set-lever.mjs benchDiscount 0.25 [--league <id>]
//
// It writes through `setConfig`, not by UPDATEing `settings.config`. That key is now a derived MIRROR
// of whichever league is active; patching it directly wrote a lever into a row no code reads and left
// the real per-league config untouched.
import Database from "better-sqlite3";
import { importTs } from "./lib/ensure-tsx.mjs";

const { getConfig, setConfig, activeLeagueId } = await importTs("../src/db/db.ts", import.meta.url);

const argv = process.argv.slice(2);
const li = argv.indexOf("--league");
const asked = li >= 0 ? argv[li + 1] : undefined;
const positional = argv.filter((a, i) => !a.startsWith("--") && !(li >= 0 && i === li + 1));
const [key, rawVal] = positional;
if (!key || rawVal === undefined) { console.error("usage: node scripts/set-lever.mjs <lever> <value> [--league <id>]"); process.exit(2); }
const val = Number(rawVal);
if (!Number.isFinite(val)) { console.error("value must be numeric"); process.exit(2); }

const db = new Database("data/ff.db");
if (asked && !db.prepare("SELECT 1 FROM league WHERE league_id = ?").get(asked)) {
  console.error(`no league "${asked}" in the store`);
  process.exit(2);
}
const leagueId = asked ?? activeLeagueId(db);
if (!leagueId) { console.error("no league in the store -- a config belongs to a league"); process.exit(1); }

const before = getConfig(db, leagueId).levers?.[key];
setConfig(db, { levers: { ...getConfig(db, leagueId).levers, [key]: val } }, leagueId);

// Read back from a FRESH read -- the point is to observe what is stored, not what we just built.
const after = getConfig(db, leagueId);
db.close();
const got = after.levers?.[key];
console.log(`league ${leagueId} -- ${key}: ${before === undefined ? "(unset)" : before} -> ${got}`);
console.log("levers now:", JSON.stringify(after.levers));
if (got !== val) { console.error(`READ-BACK MISMATCH: expected ${val}, stored ${got}`); process.exit(1); }
console.log("read-back OK");
