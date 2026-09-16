// Read back the PERSISTED config for a league -- the live agent merges these levers OVER the code
// defaults, so a DEFAULT_LEVERS change alone does not move live behavior. THIS is what the engine
// will actually use; trust it, not the source.
//
//   node scripts/read-config.mjs [--league <id>]     (default: the ACTIVE league)
//
// It goes through `getConfig` rather than reading `settings.config` directly: that key is now only a
// derived MIRROR of whichever league is active, so reading it answered for the wrong league the
// moment a second league existed.
import Database from "better-sqlite3";
import { importTs } from "./lib/ensure-tsx.mjs";

const { getConfig, activeLeagueId } = await importTs("../src/db/db.ts", import.meta.url);
const { scoringKey } = await importTs("../src/data/formatKey.ts", import.meta.url);

const i = process.argv.indexOf("--league");
const asked = i >= 0 ? process.argv[i + 1] : undefined;

const db = new Database("data/ff.db", { readonly: true });
const leagueId = asked ?? activeLeagueId(db);
if (asked && !db.prepare("SELECT 1 FROM league WHERE league_id = ?").get(asked)) {
  console.error(`no league "${asked}" in the store`);
  process.exit(2);
}
const cfg = getConfig(db, leagueId);
const row = leagueId
  ? db.prepare("SELECT platform, name FROM league WHERE league_id = ?").get(leagueId)
  : undefined;
db.close();

console.log("league:", leagueId ?? "(none -- defaults)", row?.name ? `"${row.name}"` : "", `platform ${row?.platform ?? "?"}`);
console.log("season:", cfg.season, "teams:", cfg.teams, "budget:", cfg.budget, "draftType:", cfg.draftType);
console.log("slots:", (cfg.slots || []).join(","));
console.log("playoffTeams:", cfg.playoffTeams, "regWeeks:", cfg.regWeeks);
console.log("levers:", JSON.stringify(cfg.levers));
// F-10: this line read `cfg.scoring` (the STD/HALF/PPR bucket STRING) and printed
// `scoring rec: undefined`, so the repo's "trust this" reader said nothing at all about scoring.
// The per-stat model is `scoring_rules`, and its content hash is what routes a league to a model.
console.log("scoring bucket:", cfg.scoring);
console.log("scoring_rules:", JSON.stringify(cfg.scoring_rules));
console.log("scoringKey(scoring_rules):", scoringKey(cfg.scoring_rules));
