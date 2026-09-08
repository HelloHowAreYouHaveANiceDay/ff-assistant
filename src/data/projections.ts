// Projection curve. A player's projection = the mean historical (last 6 completed seasons) REG points
// -- scored under the LEAGUE's scoring model -- of the k-th best player at their position, where k is
// their within-position ECR rank. Writes data/points.csv. Reads current ECR from the store, so run
// after `ff ingest`.
//
// THE CURVE NOW READS history-points.csv INSTEAD OF RE-FETCHING AND RE-SCORING.
// It used to download stats_player_week for six seasons and re-implement the scoring inline, which
// was a second copy of what history.ts already does -- and copies drift. Reading the built history
// means the curve automatically inherits every scoring correction (the ground-truthed K/DST rules,
// 2-point conversions) and every position history.ts emits, including IDP, with no second place to
// update.
//
// WHY K AND DST USED TO BE FAKED, AND WHY THAT IS NOW FIXED.
// K/DST were excluded from the curve and given a hardcoded nominal of `20 - rank*0.1` points -- a
// ~20-point SEASON against a real ~130-190 for a kicker. It was deliberate: a near-zero projection
// gives near-zero VOR, so the bidder never pays for a streamable position. But that is a STRATEGY
// decision encoded in the DATA layer, and it is wrong everywhere the data is used for anything else
// -- the season simulator caught it as a 6x projection error that would have deleted ~120 points a
// season per team. Projections are now TRUE for every position; the streaming policy lives where it
// belongs, in the `maxKDst` lever that already caps their price.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { ageFactor, ageCoverage, type AgeCurve } from "../draft/age.js";
import { opportunityFactor, opportunityCoverage, type OpportunityModel } from "../draft/opportunity.js";
import { openDb, getConfig } from "../db/db.js";
import { dataPath } from "./paths.js";

/**
 * curve[pos][k] = mean across the last `nSeasons` completed seasons of the k-th best player's season
 * total at that position, in LEAGUE points. Built from history-points.csv.
 */
export function buildCurveFromHistory(season: number, nSeasons = 6, path = dataPath("history-points.csv")): Record<string, number[]> {
  if (!existsSync(path)) {
    throw new Error(`${path} missing -- the projection curve is built from it.
  rebuild with:  npm run ff -- build-history --seasons 1999-${season - 1}`);
  }
  const want = new Set(Array.from({ length: nSeasons }, (_, i) => season - nSeasons + i));
  const perSeason: Record<string, Map<number, number[]>> = {};
  for (const line of readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    const yr = Number(f[0]), pos = (f[2] ?? "").trim().toUpperCase(), pts = Number(f[3]);
    if (!want.has(yr) || !pos || !Number.isFinite(pts)) continue;
    (perSeason[pos] ??= new Map());
    const l = perSeason[pos].get(yr) ?? [];
    l.push(Math.max(0, pts));
    perSeason[pos].set(yr, l);
  }
  const curve: Record<string, number[]> = {};
  for (const [pos, byYear] of Object.entries(perSeason)) {
    const lists = [...byYear.values()].map((l) => l.sort((a, b) => b - a));
    const maxlen = Math.max(0, ...lists.map((l) => l.length));
    curve[pos] = [];
    for (let k = 0; k < maxlen; k++) {
      let sum = 0, cnt = 0;
      for (const l of lists) if (k < l.length) { sum += l[k]; cnt++; }
      curve[pos][k] = cnt ? sum / cnt : 0;
    }
  }
  return curve;
}

/** The fitted age curve, or null if it has not been built. Absent, every multiplier is 1 and the
 *  projection is exactly what it was before the curve existed. */
function loadAgeCurve(): AgeCurve | null {
  const p = dataPath("age-curve.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as AgeCurve; } catch { return null; }
}

/** The fitted opportunity model, or null if it has not been built -- same contract as the age curve:
 *  absent, every multiplier is 1 and the projection is exactly what it was before it existed. */
function loadOpportunity(): OpportunityModel | null {
  const p = dataPath("opportunity-model.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as OpportunityModel; } catch { return null; }
}

export async function project(dbPath?: string, outPath = dataPath("points.csv"), useAge = true, useOpp = true): Promise<number> {
  const db = openDb(dbPath);
  const cfg = getConfig(db);
  const season = cfg.season;
  const curve = buildCurveFromHistory(season);
  const age = useAge ? loadAgeCurve() : null;
  const opp = useOpp ? loadOpportunity() : null;
  const proj = (pos: string, r: number) => { const cv = curve[pos]; return cv && cv.length ? cv[Math.min(r, cv.length - 1)] : 0; };

  // ECR players ordered by ecr; within-position 0-indexed rank = k for the curve lookup
  const ecrRows = db.prepare("SELECT p.name, p.position AS pos, r.overall_rank AS ecr FROM ranking r JOIN player p USING(player_id) WHERE r.source='fantasypros_ecr' AND r.season=@s ORDER BY r.overall_rank").all({ s: season }) as { name: string; pos: string; ecr: number }[];
  db.close();

  const posCount: Record<string, number> = {};
  const out: [string, string, number][] = [];
  for (const row of ecrRows) {
    const pos = row.pos;
    const r = posCount[pos] ?? 0; posCount[pos] = r + 1; // 0-indexed within position
    // TWO MULTIPLIERS ON THE RANK CURVE, each 1 when its input is unknown.
    //   AGE          -- who holds the rank (draft/age.ts)
    //   OPPORTUNITY  -- how he earned it last season (draft/opportunity.ts)
    // They are independent questions and multiply: a 30-year-old back whose usage also collapsed
    // gets both haircuts, which is the intended reading. Both are clamped to +/-25% before their
    // per-position amplitude is applied, so the compounded worst case is bounded rather than
    // unbounded -- worth stating because two stacked multipliers is exactly where a projection can
    // quietly run away.
    const usageRank = r + 1;                    // opportunity buckets are 1-based; `r` is 0-indexed
    const p = Math.round(
      proj(pos, r)
      * ageFactor(age, row.name, pos, season)
      * opportunityFactor(opp, row.name, pos, usageRank, season)
      * 10) / 10;
    // DST names are already canonical ("SF D/ST") from ingest -- use as-is
    if (p > 0) out.push([row.name, pos, p]);
  }
  if (age) {
    const cov = ageCoverage(age, out.map((o) => ({ name: o[0], pos: o[1] })));
    console.log(`  age curve applied to ${cov.known}/${cov.total} players (the rest keep a multiplier of 1)`);
  }
  if (opp) {
    const cov = opportunityCoverage(opp, out.map((o) => o[0]), season);
    console.log(`  opportunity applied to ${cov.known}/${cov.total} players (QB is flat by measurement; rookies keep 1)`);
  }
  out.sort((a, b) => b[2] - a[2]);
  writeFileSync(outPath, "player,pos,points\n" + out.map(([n, p, pt]) => `${n},${p},${pt}`).join("\n") + "\n", "utf8");
  return out.length;
}
