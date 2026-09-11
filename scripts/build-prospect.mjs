// Build feat_player_prospect (athletic + college rookie priors) and validate against known players.
//   node --import tsx scripts/build-prospect.mjs
import { buildProspectFeatures } from "../src/features/prospect.ts";
import { openDb } from "../src/db/db.ts";

const r = buildProspectFeatures();
console.log(`feat_player_prospect built: ${r.rows} players -- ${r.athletic} with an athletic score, ${r.college} with college production (${r.collegeSafe} name+school+year safe).`);

const db = openDb();

// Validate: spot-check well-known athletic + college profiles.
console.log("\nVALIDATION -- known profiles (athletic 0-10, dominator 0-1):");
const rows = db.prepare(
  `SELECT fp.player_sk, fp.pos, fp.athletic_score, fp.athletic_n, fp.forty, fp.dominator, fp.dominator_season, fp.breakout_age, fp.college_match,
          c.player_name
     FROM feat_player_prospect fp
     JOIN raw_combine c ON c.pfr_player_id = (SELECT source_id FROM player_xref WHERE source='pfr' AND CAST(player_sk AS TEXT)=CAST(fp.player_sk AS TEXT) LIMIT 1)
    WHERE c.player_name IN ('Saquon Barkley','Marvin Harrison','Ja''Marr Chase','Bijan Robinson','Bo Nix','Christian McCaffrey','Puka Nacua','Jayden Daniels')
    GROUP BY fp.player_sk`).all();
for (const r of rows)
  console.log(`  ${r.player_name.padEnd(20)} ${String(r.pos).padEnd(3)} RAS ${r.athletic_score==null?' - ':r.athletic_score.toFixed(1)} (n${r.athletic_n})  40 ${r.forty??'-'}  dom ${r.dominator==null?'  -  ':r.dominator.toFixed(3)} (${r.dominator_season??'-'})  breakout ${r.breakout_age==null?'-':r.breakout_age.toFixed(1)}  [${r.college_match??'-'}]`);

// distribution sanity
const d = db.prepare("SELECT COUNT(*) n, ROUND(AVG(athletic_score),2) avgRas, ROUND(AVG(dominator),3) avgDom, COUNT(breakout_age) withBreakout FROM feat_player_prospect WHERE athletic_score IS NOT NULL").get();
console.log(`\ndistribution: ${d.n} scored, mean RAS ${d.avgRas} (should be ~5), mean dominator ${d.avgDom}, ${d.withBreakout} with breakout age`);
db.close();
