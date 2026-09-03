// The app's data payload (board + news + config), read from the store. Shared by `ff app-data`
// (one-shot) and `ff serve` (the persistent helper), so there's one definition.
import { getConfig, type DB } from "../db/db.js";

const NUM = new Set(["Rank", "Bye", "Age", "Wt", "40yd", "OurValue$", "vsECR", "ProjPts", "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "ESPN_ADP", "Rostered%", "Depth"]);

export function appDataPayload(db: DB, season: number) {
  const players = (db.prepare(
    "SELECT row_json FROM board WHERE season = ? ORDER BY CAST(json_extract(row_json,'$.Rank') AS INTEGER)",
  ).all(season) as { row_json: string }[]).map((r) => JSON.parse(r.row_json) as Record<string, unknown>);
  for (const p of players) for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === "" || v == null) continue;
    if (NUM.has(k) || k.endsWith("Pts") || k.endsWith("Gms")) {
      const n = typeof v === "number" ? v : (String(v).includes(".") ? parseFloat(String(v)) : parseInt(String(v), 10));
      if (!Number.isNaN(n)) p[k] = n;
    }
  }
  const news = db.prepare(
    "SELECT player_name AS player, pos, team, category, severity, detail, source, asof, url FROM news WHERE category IN ('injury','headline','trending') ORDER BY id",
  ).all();
  const lastYr = players.length
    ? (Object.keys(players[0]).find((k) => k.endsWith("Gms") && /^\d{4}/.test(k))?.slice(0, 4) ?? "LastYr")
    : "LastYr";
  const config = { ...getConfig(db), season };
  return { players, news, config, lastYr };
}
