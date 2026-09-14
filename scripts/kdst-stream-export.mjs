// Export the joined K/DST matchup-feature table for the Python fit. Read-only.
// node scripts/kdst-stream-export.mjs > <outfile.csv>  (or --out path)
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
const db = new Database("data/ff.db", { readonly: true });
const argv = process.argv.slice(2);
const outI = argv.indexOf("--out");
const out = outI >= 0 ? argv[outI + 1] : "C:/Users/TLDR/AppData/Local/Temp/claude/H--working-ff-assistant/0e2ed616-d41b-4735-a4f5-bfdc903296fa/scratchpad/kdst.csv";

const feats = ["opp_pa_pos", "opp_pa_pos_n", "opp_off_sacks_allowed_pg", "opp_off_giveaways_pg", "opp_implied_total", "opp_def_sacks_pg", "opp_def_takeaways_pg", "opp_pass_yds_allowed_pg", "opp_rush_yds_allowed_pg", "roof_dome", "team_fga_pg", "team_pat_pg"];
const rows = db.prepare(`
  SELECT s.season, s.week, s.pos, s.player_sk psk, s.team, s.opponent,
    ${feats.map(f => "s." + f).join(",")},
    m.pts target, m.season_line_pg floor, m.spread_line, m.total_line, m.implied_team_total
  FROM feat_player_week_stream s
  JOIN feat_player_week_model m ON m.feat_key=s.feat_key AND m.season=s.season AND m.week=s.week
  WHERE s.pos IN ('K','DST') AND m.in_population=1 AND m.pts IS NOT NULL AND m.season_line_pg IS NOT NULL
    AND s.season BETWEEN 2012 AND 2025
  ORDER BY s.season, s.week, s.pos`).all();

const cols = ["season", "week", "pos", "psk", "team", "opponent", ...feats, "target", "floor", "spread_line", "total_line", "implied_team_total"];
const lines = [cols.join(",")];
for (const r of rows) lines.push(cols.map(c => { const v = r[c]; return v == null ? "" : v; }).join(","));
writeFileSync(out, lines.join("\n"));
console.log("wrote " + rows.length + " rows to " + out);

// pick-pool sizes per season-week
const cnt = {};
for (const r of rows) { const k = r.season + "|" + r.week + "|" + r.pos; cnt[k] = (cnt[k] || 0) + 1; }
const kSizes = Object.entries(cnt).filter(([k]) => k.endsWith("K")).map(([, v]) => v);
const dSizes = Object.entries(cnt).filter(([k]) => k.endsWith("DST")).map(([, v]) => v);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log("K pool per season-week: mean " + mean(kSizes).toFixed(1) + " min " + Math.min(...kSizes) + " max " + Math.max(...kSizes));
console.log("DST pool per season-week: mean " + mean(dSizes).toFixed(1) + " min " + Math.min(...dSizes) + " max " + Math.max(...dSizes));
