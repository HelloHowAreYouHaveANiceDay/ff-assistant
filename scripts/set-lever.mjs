// Patch ONE lever in the PERSISTED config (settings key 'config') and read it back.
// getConfig() merges stored levers OVER the code defaults, so changing DEFAULT_LEVERS alone does
// nothing for the live agent -- and the write must be verified by re-reading, not trusted.
//
//   node scripts/set-lever.mjs benchDiscount 0.25
import Database from "better-sqlite3";

const [, , key, rawVal] = process.argv;
if (!key || rawVal === undefined) { console.error("usage: node scripts/set-lever.mjs <lever> <value>"); process.exit(2); }
const val = Number(rawVal);
if (!Number.isFinite(val)) { console.error("value must be numeric"); process.exit(2); }

const db = new Database("data/ff.db");
const row = db.prepare("SELECT value FROM settings WHERE key='config'").get();
if (!row) { console.error("no config row in settings"); process.exit(1); }
const cfg = JSON.parse(row.value);
cfg.levers = cfg.levers || {};
const before = cfg.levers[key];
cfg.levers[key] = val;
db.prepare("UPDATE settings SET value=@v WHERE key='config'").run({ v: JSON.stringify(cfg) });

// Read back from a FRESH query -- the point is to observe what is stored, not what we just built.
const after = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
db.close();
const got = after.levers?.[key];
console.log(`${key}: ${before === undefined ? "(unset)" : before} -> ${got}`);
console.log("levers now:", JSON.stringify(after.levers));
if (got !== val) { console.error(`READ-BACK MISMATCH: expected ${val}, stored ${got}`); process.exit(1); }
console.log("read-back OK");
