// Projection curve. A player's projection = the mean historical (last 6 completed seasons) REG points
// -- scored under the LEAGUE's scoring model -- of the k-th best player at their position, where k is
// their within-position ECR rank. K/DST get a small nominal (they
// stream; computeValues clamps their $). Writes data/points.csv. Reads current ECR from the store,
// so run after `ff ingest`. Formula is LINEAR, so summing per-week == Python's sum-then-formula.
import { writeFileSync } from "node:fs";
import { fetchCsv, pick, NFLVERSE } from "./nflverse.js";
import { openDb, getConfig } from "../db/db.js";
import { scoreWeek, type ScoringRules } from "../draft/scoring.js";
import { dataPath } from "./paths.js";

const CURVE_POS = ["QB", "RB", "WR", "TE"] as const;

// curve[pos][k] = mean across seasons of the k-th best player's season points at that position,
// scored under the LEAGUE's scoring model (so the curve is in league points, not generic No-PPR)
async function buildCurve(scoring: ScoringRules, season: number): Promise<Record<string, number[]>> {
  const seasons = Array.from({ length: 6 }, (_, i) => season - 6 + i); // the 6 completed seasons before `season`
  const perSeason: Record<string, number[][]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const yr of seasons) {
    const rows = await fetchCsv(`${NFLVERSE}/stats_player/stats_player_week_${yr}.csv`);
    const totals = new Map<string, { pos: string; pts: number }>(); // player|pos -> season pts
    for (const r of rows) {
      if (pick(r, "season_type") !== "REG") continue;
      const pos = pick(r, "position"); if (!(CURVE_POS as readonly string[]).includes(pos)) continue;
      const name = pick(r, "player_display_name"); if (!name) continue;
      const key = `${name}|${pos}`;
      const t = totals.get(key) ?? { pos, pts: 0 }; t.pts += scoreWeek(r, scoring); totals.set(key, t);
    }
    const byPos: Record<string, number[]> = { QB: [], RB: [], WR: [], TE: [] };
    for (const t of totals.values()) byPos[t.pos].push(Math.max(0, t.pts));
    for (const p of CURVE_POS) { byPos[p].sort((a, b) => b - a); perSeason[p].push(byPos[p]); }
  }
  const curve: Record<string, number[]> = {};
  for (const p of CURVE_POS) {
    const lists = perSeason[p];
    const maxlen = Math.max(0, ...lists.map((l) => l.length));
    curve[p] = [];
    for (let k = 0; k < maxlen; k++) { let sum = 0, cnt = 0; for (const l of lists) if (k < l.length) { sum += l[k]; cnt++; } curve[p][k] = cnt ? sum / cnt : 0; }
  }
  return curve;
}

export async function project(dbPath?: string, outPath = dataPath("points.csv")): Promise<number> {
  const db = openDb(dbPath);
  const cfg = getConfig(db);
  const season = cfg.season;
  const curve = await buildCurve(cfg.scoring_rules, season);
  const proj = (pos: string, r: number) => { const cv = curve[pos]; return cv && cv.length ? cv[Math.min(r, cv.length - 1)] : 0; };

  // ECR players ordered by ecr; within-position 0-indexed rank = k for the curve lookup
  const ecrRows = db.prepare("SELECT p.name, p.position AS pos, r.overall_rank AS ecr FROM ranking r JOIN player p USING(player_id) WHERE r.source='fantasypros_ecr' AND r.season=@s ORDER BY r.overall_rank").all({ s: season }) as { name: string; pos: string; ecr: number }[];
  db.close();

  const posCount: Record<string, number> = {};
  const out: [string, string, number][] = [];
  for (const row of ecrRows) {
    const pos = row.pos;
    const r = posCount[pos] ?? 0; posCount[pos] = r + 1; // 0-indexed within position
    const p = (pos === "K" || pos === "DST")
      ? Math.round(Math.max(1, 20 - r * 0.1) * 10) / 10   // nominal streaming value, keeps ECR order
      : Math.round(proj(pos, r) * 10) / 10;
    // DST names are already canonical ("SF D/ST") from ingest -- use as-is
    if (p > 0) out.push([row.name, pos, p]);
  }
  out.sort((a, b) => b[2] - a[2]);
  writeFileSync(outPath, "player,pos,points\n" + out.map(([n, p, pt]) => `${n},${p},${pt}`).join("\n") + "\n", "utf8");
  return out.length;
}
