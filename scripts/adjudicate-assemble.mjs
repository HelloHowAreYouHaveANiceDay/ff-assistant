// EDGE-OR-BIAS adjudication: assemble per-player-season (projector vs market vs realized).
// READ-ONLY. Emits a CSV to the path given as argv[2].
//   node --import tsx scripts/adjudicate-assemble.mjs <out.csv>
// projectorProj comes from the BLIND fold artifact (data/fold-artifacts-d16/artifact-Y.json,
// holdoutSeason must equal Y). market = FFToday pts (NOT independent, D16 feature), ADP (independent),
// ECR pos-rank (independent, 2020+). realized = feat_player_season.pts.
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { boardProjection } from "../src/model/features.ts";
import { loadArtifact } from "../src/model/projector.ts";

const out = process.argv[2];
if (!out) throw new Error("need out path");
const db = new Database("data/ff.db", { readonly: true });
const POS = new Set(["QB", "RB", "WR", "TE"]);
const rows = [];

for (let yr = 2013; yr <= 2024; yr++) {
  const apath = `data/fold-artifacts-d16/artifact-${yr}.json`;
  const raw = JSON.parse(readFileSync(apath, "utf8"));
  if (Number(raw.holdoutSeason) !== yr) throw new Error(`BLIND VIOLATION: artifact-${yr} holdoutSeason=${raw.holdoutSeason}`);
  const artifact = loadArtifact(raw);

  // projector board projection (the "QB4" number), keyed by player_sk
  const proj = new Map(); // player_sk -> mean
  for (const p of boardProjection(db, yr, artifact)) if (p.player_sk != null) proj.set(String(p.player_sk), p.mean);

  // anchor rows: feat_player_season for the season
  const fps = db.prepare(
    `SELECT player_sk, name_key, pos, pts AS realized, ecr_pos_rank
       FROM feat_player_season WHERE season=? AND pts IS NOT NULL AND player_sk IS NOT NULL`,
  ).all(yr);

  const ff = new Map(); // pos|name_key -> proj_fpts
  for (const r of db.prepare(`SELECT name_key, pos, proj_fpts FROM raw_fftoday_proj WHERE season=?`).all(yr)) ff.set(`${r.pos}|${r.name_key}`, r.proj_fpts);
  const adp = new Map(); // player_sk -> adp
  for (const r of db.prepare(`SELECT CAST(player_sk AS TEXT) sk, adp FROM feat_player_season_ext WHERE season=? AND adp IS NOT NULL`).all(yr)) adp.set(r.sk, r.adp);

  for (const r of fps) {
    if (!POS.has(r.pos)) continue;
    const sk = String(r.player_sk);
    const pm = proj.get(sk);
    if (pm == null) continue;                 // no projector projection -> excluded
    rows.push({
      season: yr, pos: r.pos, name_key: r.name_key,
      proj: pm,
      ff: ff.get(`${r.pos}|${r.name_key}`) ?? "",
      adp: adp.get(sk) ?? "",
      ecr: r.ecr_pos_rank ?? "",
      realized: r.realized,
    });
  }
}
db.close();
const header = "season,pos,name_key,proj,ff,adp,ecr,realized";
const body = rows.map((r) => [r.season, r.pos, r.name_key, r.proj, r.ff, r.adp, r.ecr, r.realized].join(",")).join("\n");
writeFileSync(out, header + "\n" + body + "\n");
console.log(`wrote ${rows.length} player-seasons to ${out}`);
