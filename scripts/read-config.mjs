// Read back the PERSISTED config (settings key 'config') -- the live agent merges these levers
// OVER the code defaults, so a DEFAULT_LEVERS change alone does not move live behavior.
import Database from "better-sqlite3";
const db = new Database("data/ff.db", { readonly: true });
const row = db.prepare("SELECT value FROM settings WHERE key='config'").get();
const cfg = JSON.parse(row.value);
console.log("season:", cfg.season, "teams:", cfg.teams, "budget:", cfg.budget);
console.log("slots:", (cfg.slots || []).join(","));
console.log("playoffTeams:", cfg.playoffTeams, "regWeeks:", cfg.regWeeks);
console.log("levers:", JSON.stringify(cfg.levers));
console.log("scoring rec:", cfg.scoring && cfg.scoring.rec);
