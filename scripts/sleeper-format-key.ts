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
import { scoringKey } from "../src/data/formatKey.js";
import { sleeperScoringRules, sleeperScoringBucket } from "../src/league/sleeper.js";
import { DEFAULT_SCORING, type ScoringRules } from "../src/draft/scoring.js";

const lg = JSON.parse(readFileSync("test/fixtures/sleeper/league.json", "utf8")) as { scoring_settings: Record<string, number> };
const sleeper = sleeperScoringRules(lg.scoring_settings);

const db = new Database("data/ff.db", { readonly: true });
const rows = db.prepare("SELECT league_id, platform, name, scoring_json FROM league").all() as { league_id: string; platform: string; name: string; scoring_json: string | null }[];

const show = (label: string, s: ScoringRules): string => {
  const k = scoringKey(s);
  console.log(`${label.padEnd(34)} ${k}`);
  console.log(`${"".padEnd(34)} rec=${s.rec} passTD=${s.passTD} int=${s.int} passYd=${s.passYd} rushTD=${s.rushTD} fumble=${s.fumble} twoPt=${s.twoPt}`);
  return k;
};

console.log("SCORING KEYS -- two leagues share a model only when these match\n");
const sleeperKey = show("sleeper 1353038434335195136", sleeper);
console.log(`${"".padEnd(34)} bucket=${sleeperScoringBucket(lg.scoring_settings)}\n`);

for (const r of rows) {
  let s: ScoringRules = DEFAULT_SCORING;
  let how = "DEFAULT_SCORING (row carries no scoring_rules)";
  try {
    const cfg = JSON.parse(r.scoring_json ?? "{}") as { scoring_rules?: ScoringRules };
    if (cfg.scoring_rules) { s = cfg.scoring_rules; how = "row's scoring_rules"; }
  } catch { /* fall through to the default, and say so */ }
  const k = show(`${r.platform} ${r.league_id} (${r.name ?? "?"})`, s);
  console.log(`${"".padEnd(34)} from ${how}`);
  console.log(`${"".padEnd(34)} ${k === sleeperKey ? "*** SAME KEY AS SLEEPER -- shares a model ***" : "different key -- needs its own model"}\n`);
}
db.close();
