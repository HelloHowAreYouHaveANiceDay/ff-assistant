// PROBE: confirm the join, target, and floor for a real K/DST matchup model.
// Read-only. node scripts/kdst-stream-probe.mjs
import Database from "better-sqlite3";
const db = new Database("data/ff.db", { readonly: true });

console.log("JOIN test (stream x model) for K/DST, 2012-2025:");
const q = db.prepare(`
  SELECT s.pos, COUNT(*) n,
    SUM(CASE WHEN m.pts IS NOT NULL THEN 1 ELSE 0 END) haspts,
    SUM(CASE WHEN m.season_line_pg IS NOT NULL THEN 1 ELSE 0 END) hasline,
    SUM(CASE WHEN m.in_population=1 THEN 1 ELSE 0 END) inpop,
    SUM(CASE WHEN m.in_population=1 AND m.pts IS NOT NULL AND m.season_line_pg IS NOT NULL THEN 1 ELSE 0 END) usable
  FROM feat_player_week_stream s
  JOIN feat_player_week_model m ON m.feat_key=s.feat_key AND m.season=s.season AND m.week=s.week
  WHERE s.pos IN ('K','DST') AND s.season BETWEEN 2012 AND 2025
  GROUP BY s.pos`);
for (const r of q.all()) console.log("  ", r.pos, "joined=" + r.n, "haspts=" + r.haspts, "hasline=" + r.hasline, "inpop=" + r.inpop, "usable=" + r.usable);

// per-season usable counts
console.log("\nUsable (inpop, pts, line) rows per season:");
const bys = db.prepare(`
  SELECT s.season, s.pos, COUNT(*) n
  FROM feat_player_week_stream s
  JOIN feat_player_week_model m ON m.feat_key=s.feat_key AND m.season=s.season AND m.week=s.week
  WHERE s.pos IN ('K','DST') AND m.in_population=1 AND m.pts IS NOT NULL AND m.season_line_pg IS NOT NULL
  GROUP BY s.season, s.pos ORDER BY s.season`).all();
const bySeason = {};
for (const r of bys) { (bySeason[r.season] ??= {})[r.pos] = r.n; }
for (const [y, o] of Object.entries(bySeason)) console.log("  ", y, "K=" + (o.K || 0), "DST=" + (o.DST || 0));

// target scoring check: does m.pts look like weekly fantasy points? distribution for K and DST
console.log("\nTarget (m.pts) distribution 2012-2025 inpop:");
for (const pos of ["K", "DST"]) {
  const vals = db.prepare(`
    SELECT m.pts p FROM feat_player_week_stream s
    JOIN feat_player_week_model m ON m.feat_key=s.feat_key AND m.season=s.season AND m.week=s.week
    WHERE s.pos=? AND m.in_population=1 AND m.pts IS NOT NULL AND s.season BETWEEN 2012 AND 2025`).all(pos).map(r => r.p).sort((a, b) => a - b);
  const mean = vals.reduce((a, x) => a + x, 0) / vals.length;
  const p = (q) => vals[Math.floor(vals.length * q)];
  console.log("  ", pos, "n=" + vals.length, "mean=" + mean.toFixed(2), "min=" + vals[0], "p10=" + p(.1), "p50=" + p(.5), "p90=" + p(.9), "max=" + vals[vals.length - 1]);
}

// season_line_pg distribution + how it compares to pts (is the floor a per-game constant?)
console.log("\nseason_line_pg distribution + distinct-per-player check:");
for (const pos of ["K", "DST"]) {
  const rows = db.prepare(`
    SELECT s.season, s.week, m.season_line_pg line, m.pts pts, s.player_sk psk FROM feat_player_week_stream s
    JOIN feat_player_week_model m ON m.feat_key=s.feat_key AND m.season=s.season AND m.week=s.week
    WHERE s.pos=? AND m.in_population=1 AND m.pts IS NOT NULL AND m.season_line_pg IS NOT NULL AND s.season BETWEEN 2012 AND 2025`).all(pos);
  const lines = rows.map(r => r.line).sort((a, b) => a - b);
  const meanL = lines.reduce((a, x) => a + x, 0) / lines.length;
  const meanP = rows.reduce((a, r) => a + r.pts, 0) / rows.length;
  console.log("  ", pos, "line mean=" + meanL.toFixed(2), "(vs pts mean " + meanP.toFixed(2) + ")", "line range", lines[0].toFixed(1) + ".." + lines[lines.length - 1].toFixed(1));
}

// feature coverage: how many usable rows have opp_pa_pos non-null, opp_pa_pos_n>0, opp_implied_total etc
console.log("\nFeature coverage (usable K/DST rows):");
const feats = ["opp_pa_pos", "opp_pa_pos_n", "opp_off_sacks_allowed_pg", "opp_off_giveaways_pg", "opp_implied_total", "opp_def_sacks_pg", "opp_def_takeaways_pg", "opp_pass_yds_allowed_pg", "opp_rush_yds_allowed_pg", "roof_dome", "team_fga_pg", "team_pat_pg"];
for (const pos of ["K", "DST"]) {
  const rows = db.prepare(`
    SELECT ${feats.map(f => "s." + f).join(",")} FROM feat_player_week_stream s
    JOIN feat_player_week_model m ON m.feat_key=s.feat_key AND m.season=s.season AND m.week=s.week
    WHERE s.pos=? AND m.in_population=1 AND m.pts IS NOT NULL AND m.season_line_pg IS NOT NULL AND s.season BETWEEN 2012 AND 2025`).all(pos);
  console.log("  == " + pos + " (n=" + rows.length + ") ==");
  for (const f of feats) {
    const nonNull = rows.filter(r => r[f] != null).length;
    const vals = rows.map(r => r[f]).filter(v => v != null);
    const mean = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : NaN;
    console.log("     " + f.padEnd(28) + " nonNull=" + nonNull + "/" + rows.length + " mean=" + (Number.isFinite(mean) ? mean.toFixed(3) : "NA"));
  }
}
