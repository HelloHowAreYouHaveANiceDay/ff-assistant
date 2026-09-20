/**
 * DOES THE DY-NASTY NEED ITS OWN MODEL? -- `npx tsx scripts/sleeper-format-key.ts`
 *
 * The multi-format design keys a model by its SCORING CONTENT HASH, so two leagues whose rules match
 * share a trained projector and a value book, and only a genuine rules difference forces a new one.
 * This prints the Sleeper league's key beside the incumbent ESPN league's and says whether they
 * match -- which is the difference between "onboard it in minutes" and "build a ~1GB features.db and
 * train a projector for it".
 *
 * It opens the store READ-ONLY and writes nothing.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { scoringKeyFor } from "../src/data/formatKey.js";
import { sleeperScoringRules, sleeperScoringBucket, sleeperDefenseRules } from "../src/league/sleeper.js";
import { DEFAULT_SCORING, type ScoringRules } from "../src/draft/scoring.js";

const lg = JSON.parse(readFileSync("test/fixtures/sleeper/league.json", "utf8")) as { scoring_settings: Record<string, number> };
const sleeper = sleeperScoringRules(lg.scoring_settings);

const db = new Database("data/ff.db", { readonly: true });
const rows = db.prepare("SELECT league_id, platform, name, scoring_json FROM league").all() as { league_id: string; platform: string; name: string; scoring_json: string | null }[];

/**
 * `scoringKeyFor`, NOT `scoringKey`. The bare offense hash is NOT the key that selects a model
 * directory: `resolveFormat` calls `scoringKeyFor({rules, kicker, defense})`, which folds in the
 * kicker and defense blocks whenever they differ from the defaults. Using the offense-only hash here
 * printed `sc-f29ac5025aff` for The Dy-nasty while the build actually produced `sc-4b895724c893` --
 * a number that looked authoritative and named a directory that will never exist.
 */
const show = (label: string, s: ScoringRules, kicker: unknown = null, defense: unknown = null): string => {
  const k = scoringKeyFor({ rules: s, kicker: kicker as never, defense: defense as never });
  console.log(`${label.padEnd(34)} ${k}`);
  console.log(`${"".padEnd(34)} rec=${s.rec} passTD=${s.passTD} int=${s.int} passYd=${s.passYd} rushTD=${s.rushTD} fumble=${s.fumble} twoPt=${s.twoPt}`);
  return k;
};

console.log("SCORING KEYS -- two leagues share a model only when these match\n");
// The DEFENSE block is passed because this league rosters a DEF and its rules are not the defaults,
// so it is part of the key. (No kicker: the league has no K slot, so its kicker rules are null.)
const sleeperKey = show("sleeper 1353038434335195136", sleeper, null, sleeperDefenseRules(lg.scoring_settings));
console.log(`${"".padEnd(34)} bucket=${sleeperScoringBucket(lg.scoring_settings)}\n`);

for (const r of rows) {
  let s: ScoringRules = DEFAULT_SCORING;
  let how = "DEFAULT_SCORING (row carries no scoring_rules)";
  try {
    const cfg = JSON.parse(r.scoring_json ?? "{}") as { scoring_rules?: ScoringRules };
    if (cfg.scoring_rules) { s = cfg.scoring_rules; how = "row's scoring_rules"; }
    // NOTE: `league.scoring_json` is not where a league's rules live -- `settings.config:<id>` is.
    // This leg therefore reports DEFAULT_SCORING for both shipped leagues and is only meaningful as
    // "what the incumbent default hashes to". It is NOT a reading of the Yahoo league's real format,
    // whose key is sc-a845f67652fb.
  } catch { /* fall through to the default, and say so */ }
  const k = show(`${r.platform} ${r.league_id} (${r.name ?? "?"})`, s);
  console.log(`${"".padEnd(34)} from ${how}`);
  console.log(`${"".padEnd(34)} ${k === sleeperKey ? "*** SAME KEY AS SLEEPER -- shares a model ***" : "different key -- needs its own model"}\n`);
}
db.close();
