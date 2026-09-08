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
import { nameKey } from "../draft/values.js";
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

// ==================================================================================================
// THE CONDITIONAL CURVE -- and why the order-statistic curve above is the wrong quantity.
//
// `buildCurveFromHistory` averages the k-th best FINISHER's season, then applies that number to the
// player ranked k in PRESEASON ECR. Those are not the same quantity and the gap is not small. The
// k-th best finisher is an ORDER STATISTIC: it is by construction the best of everyone who could
// have finished there, so it carries the winner's luck of whoever happened to win that slot. What
// the board needs is a CONDITIONAL EXPECTATION -- E[points | this player is ranked k going in] --
// which is the average over everyone who entered at k, busts included.
//
// Measured on data/history-points.csv (1999-2025), the two differ by 20-35% at the top:
//
//   pos  k    order-stat   E[pts | prior-year finish rank k]   E[pts | preseason ECR rank k]
//   QB   1       400              264 (n 51)                        341 (n 12, 2020-25)
//   RB   1       345              225 (n 51)                        189
//   WR   1       326              212 (n 52)                        213
//   TE   1       238              160 (n 51)                        173
//
// The consequence is concentrated exactly where a dollar error is most expensive. VOR of the #1
// player -- the number the whole auction book is scaled from -- under the two curves:
// QB 169 -> 74, RB 203 -> 121, WR 182 -> 99, TE 134 -> 79. The shipped book therefore over-pays the
// top of the board, and QB worst of all ($689 of book against a room that spends $240-330).
//
// This is regression to the mean, and it had been noticed three times before -- in the age fit, in
// the opportunity fit, and in the bootstrap calibration -- and NORMALISED AWAY each time as a
// nuisance level shift. It was never a nuisance. It was this curve, seen from three directions.
//
// HOW THE TWO CONDITIONALS COMBINE, and why neither alone is used.
//
//   SHAPE comes from the prior-year-finish conditional. It spans 25 season pairs with n = 50-130
//   per rank, so its rank-to-rank shape is stable. But it is conditioned on the wrong variable:
//   finishing RB5 is not the same evidence as being ranked RB5 by the market in August.
//
//   LEVEL comes from the preseason-ECR conditional, which IS conditioned on the variable the board
//   actually indexes (`project` looks the curve up at a player's ECR rank). But it has only six
//   seasons (2020-2025, n = 12-30 per rank), far too thin to take a shape from -- its RB curve is
//   not even monotone (RB1 189 < RB5 242, on n=12).
//
// So: take the shape from the long series and rescale it per position so that its mean over ranks
// 1-24 matches the ECR conditional's mean over the same ranks. Each half is used for the thing it
// is actually good for, and the result is stated in the units of the recent scoring era.
//
// THE KNOWN BIAS, stated rather than buried: the ECR conditional can only score players who
// actually posted a season. 400 of 2,949 ranked player-seasons never appear in history-points.csv
// -- a preseason-ranked player who never played is a hidden zero that is dropped rather than
// averaged in. That biases the ECR level UP, so the level correction here is if anything
// CONSERVATIVE: the true conditional expectation is lower still.
// ==================================================================================================

/** Which curve `project` and the backtest build. "orderstat" is the pre-2026-09-08 behaviour, kept
 *  reachable so the two can be measured against each other rather than argued about. */
export type CurveKind = "orderstat" | "conditional";

const CURVE_POS = ["QB", "RB", "WR", "TE", "K", "DST"];
/** Below this many observations a rank has no honest mean of its own. */
const MIN_OBS = 20;
/** The ECR curve gets a lower bar because it structurally CANNOT reach 20: it spans six seasons,
 *  so rank 1 over a +/-1 window holds ~12-18 observations and no amount of correct code will make it
 *  more. Reusing MIN_OBS here truncated the ECR curve at rank 0, every level factor defaulted to 1,
 *  and the conditional curve shipped unscaled -- passing every other test in this file, because a
 *  missing level correction looks exactly like a correct one that happened to be 1.00. */
const ECR_MIN_OBS = 10;
/** Ranks 1-3 are averaged over a +/-1 window, deeper ranks over +/-2 -- the top of the board is
 *  where the curve is steepest, so a wide window there would flatten the very thing being measured. */
const windowFor = (k: number) => (k <= 3 ? 1 : 2);

interface PlayerSeason { season: number; name: string; pos: string; pts: number }

function readHistory(path: string, season: number): PlayerSeason[] {
  if (!existsSync(path)) {
    throw new Error(`${path} missing -- the projection curve is built from it.
  rebuild with:  npm run ff -- build-history --seasons 1999-${season - 1}`);
  }
  const out: PlayerSeason[] = [];
  for (const line of readFileSync(path, "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    const yr = Number(f[0]), name = (f[1] ?? "").trim(), pos = (f[2] ?? "").trim().toUpperCase(), pts = Number(f[3]);
    if (!Number.isFinite(yr) || !name || !pos || !Number.isFinite(pts)) continue;
    out.push({ season: yr, name, pos, pts: Math.max(0, pts) });
  }
  return out;
}

/** finish rank (1-based, by season total) per `${season}|${name}` within position. */
function finishRanks(rows: PlayerSeason[]): Map<string, number> {
  const rank = new Map<string, number>();
  const byGroup = new Map<string, PlayerSeason[]>();
  for (const r of rows) {
    const g = `${r.season}|${r.pos}`;
    (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(r);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => b.pts - a.pts);
    list.forEach((r, i) => rank.set(`${r.season}|${r.name}`, i + 1));
  }
  return rank;
}

/**
 * ISOTONIC (monotone non-increasing) repair by a cumulative-min pass.
 *
 * A windowed mean over finite samples wobbles -- WR rank 20 can come out above rank 16 on n=126 --
 * and a curve that rises with rank is not merely untidy: `baselines()` reads a specific rank off it
 * as the replacement level, and `computeValues` subtracts that from everyone. A non-monotone curve
 * therefore hands a WORSE-ranked player a HIGHER VOR, which is the ordering the whole book exists to
 * express, inverted.
 *
 * A cumulative min is the projection onto the monotone cone from above: it never invents a value, it
 * only refuses to let the curve climb.
 */
export function isotonicNonIncreasing(v: number[]): number[] {
  const out = v.slice();
  for (let i = 1; i < out.length; i++) if (out[i] > out[i - 1]) out[i] = out[i - 1];
  return out;
}

/**
 * curve[pos][k-1] = E[points in season Y | this player's finish rank at that position in Y-1 was k],
 * pooled over every season pair in the history, windowed and then made monotone.
 *
 * `beforeSeason` restricts the pairs to seasons strictly earlier than the given year, which is what
 * the backtest's expanding window needs: a curve built for 2010 must not have seen 2011.
 */
export function buildPriorRankCurve(
  season: number,
  path = dataPath("history-points.csv"),
  beforeSeason?: number,
  rows?: PlayerSeason[],
): { curve: Record<string, number[]>; pairs: number } {
  const all = rows ?? readHistory(path, season);
  const rank = finishRanks(all);
  // (pos, prior rank) -> the season totals those players went on to post
  const obs: Record<string, Map<number, number[]>> = {};
  const pairSeasons = new Set<number>();
  for (const r of all) {
    if (beforeSeason != null && r.season >= beforeSeason) continue;
    const prior = rank.get(`${r.season - 1}|${r.name}`);
    if (prior == null) continue;                     // no prior season -> no preseason rank proxy
    (obs[r.pos] ??= new Map());
    (obs[r.pos].get(prior) ?? obs[r.pos].set(prior, []).get(prior)!).push(r.pts);
    pairSeasons.add(r.season);
  }
  const curve: Record<string, number[]> = {};
  for (const [pos, byRank] of Object.entries(obs)) {
    const maxRank = Math.max(...byRank.keys());
    const raw: number[] = [];
    for (let k = 1; k <= maxRank; k++) {
      const w = windowFor(k);
      let sum = 0, n = 0;
      for (let j = k - w; j <= k + w; j++) for (const y of byRank.get(j) ?? []) { sum += y; n++; }
      if (n < MIN_OBS) break;                        // the honest end of the fitted range
      raw.push(sum / n);
    }
    if (raw.length) curve[pos] = isotonicNonIncreasing(raw);
  }
  return { curve, pairs: pairSeasons.size };
}

/**
 * curve[pos][k-1] = E[actual season points | preseason ECR positional rank k], from the FantasyPros
 * archive in `ranking_history` joined to history-points.csv by name key.
 *
 * PRESEASON means the LATEST scrape in August or the first week of September -- the last consensus
 * before anyone plays. Mixing an in-season scrape in would be lookahead wearing a preseason label.
 */
export function buildEcrCurve(
  db: ReturnType<typeof openDb>,
  season: number,
  path = dataPath("history-points.csv"),
  rows?: PlayerSeason[],
): { curve: Record<string, number[]>; seasons: number[]; joined: number; unmatched: number } {
  const all = rows ?? readHistory(path, season);
  const actual = new Map<string, number>();
  for (const r of all) actual.set(`${r.season}|${nameKey(r.name)}|${r.pos}`, r.pts);

  let raw: { season: number; scrape_date: string; player_id: string; pos: string; ecr: number }[] = [];
  try {
    raw = db.prepare(
      "SELECT season, scrape_date, player_id, pos, ecr FROM ranking_history " +
      "WHERE ecr_type='ro' AND source='fantasypros' AND ecr IS NOT NULL " +
      "AND (substr(scrape_date,6,2)='08' OR (substr(scrape_date,6,2)='09' AND CAST(substr(scrape_date,9,2) AS INTEGER)<=7))",
    ).all() as typeof raw;
  } catch { return { curve: {}, seasons: [], joined: 0, unmatched: 0 }; }

  const latest = new Map<number, string>();
  for (const r of raw) { const d = latest.get(r.season); if (!d || r.scrape_date > d) latest.set(r.season, r.scrape_date); }
  const pre = new Map<number, Map<string, { pid: string; ecr: number }[]>>();
  for (const r of raw) {
    if (r.scrape_date !== latest.get(r.season)) continue;
    const pos = (r.pos ?? "").toUpperCase();
    if (!CURVE_POS.includes(pos)) continue;
    const m = pre.get(r.season) ?? pre.set(r.season, new Map()).get(r.season)!;
    (m.get(pos) ?? m.set(pos, []).get(pos)!).push({ pid: r.player_id, ecr: r.ecr });
  }
  const byRank: Record<string, Map<number, number[]>> = {};
  const seasonsUsed = new Set<number>();
  let joined = 0, unmatched = 0;
  for (const [yr, m] of pre) {
    if (yr >= season) continue;                      // only completed seasons can be scored
    for (const [pos, list] of m) {
      list.sort((a, b) => a.ecr - b.ecr);
      list.forEach((p, i) => {
        const y = actual.get(`${yr}|${p.pid}|${pos}`);
        // A ranked player with no scored season is a hidden ZERO. Dropping him biases these means
        // UP; that is stated in the header rather than silently corrected, because inventing a 0 for
        // a player who was cut in August would bias them DOWN by at least as much.
        if (y == null) { unmatched++; return; }
        joined++; seasonsUsed.add(yr);
        (byRank[pos] ??= new Map());
        const k = i + 1;
        (byRank[pos].get(k) ?? byRank[pos].set(k, []).get(k)!).push(y);
      });
    }
  }
  const curve: Record<string, number[]> = {};
  for (const [pos, m] of Object.entries(byRank)) {
    const maxRank = Math.max(...m.keys());
    const out: number[] = [];
    for (let k = 1; k <= maxRank; k++) {
      const w = windowFor(k);
      let sum = 0, n = 0;
      for (let j = k - w; j <= k + w; j++) for (const y of m.get(j) ?? []) { sum += y; n++; }
      if (n < ECR_MIN_OBS) break;
      out.push(sum / n);
    }
    if (out.length) curve[pos] = out;                // NOT isotonic: this one is only a LEVEL source
  }
  return { curve, seasons: [...seasonsUsed].sort(), joined, unmatched };
}

/** Ranks 1-24 are the region the level is matched on: deep enough to average out a single position's
 *  noise, shallow enough to stay inside the range both curves actually cover. */
const LEVEL_RANKS = 24;
const meanOf = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

/**
 * The shipped conditional curve: the prior-rank SHAPE, rescaled per position to the preseason-ECR
 * LEVEL over ranks 1-24. A position with no usable ECR coverage keeps its shape unscaled (factor 1)
 * rather than being dropped -- a curve in slightly the wrong units still beats no curve at all, and
 * the factor is returned so a caller can see which positions were actually corrected.
 */
export function buildConditionalCurve(
  db: ReturnType<typeof openDb> | null,
  season: number,
  path = dataPath("history-points.csv"),
  beforeSeason?: number,
): { curve: Record<string, number[]>; levelFactor: Record<string, number>; pairs: number } {
  const rows = readHistory(path, season);
  const { curve: shape, pairs } = buildPriorRankCurve(season, path, beforeSeason, rows);
  const ecr = db ? buildEcrCurve(db, beforeSeason ?? season, path, rows).curve : {};
  const curve: Record<string, number[]> = {};
  const levelFactor: Record<string, number> = {};
  for (const [pos, sh] of Object.entries(shape)) {
    const e = ecr[pos];
    const n = Math.min(LEVEL_RANKS, sh.length, e?.length ?? 0);
    let f = 1;
    if (e && n >= 12) {
      const num = meanOf(e.slice(0, n)), den = meanOf(sh.slice(0, n));
      // A factor far from 1 is a broken join, not a level correction -- the same guard shape the
      // bootstrap calibration uses, and for the same reason: a silent 3x here would move every
      // dollar on the board.
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num / den >= 0.5 && num / den <= 2.0) f = num / den;
    }
    levelFactor[pos] = f;
    curve[pos] = sh.map((v) => v * f);
  }
  return { curve, levelFactor, pairs };
}

/** The curve `project` and the backtest use, selected by kind. */
export function buildCurve(
  kind: CurveKind,
  season: number,
  db: ReturnType<typeof openDb> | null = null,
  path = dataPath("history-points.csv"),
): Record<string, number[]> {
  return kind === "orderstat" ? buildCurveFromHistory(season, 6, path) : buildConditionalCurve(db, season, path).curve;
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

export async function project(dbPath?: string, outPath = dataPath("points.csv"), useAge = true, useOpp = true, curveKind: CurveKind = "conditional"): Promise<number> {
  const db = openDb(dbPath);
  const cfg = getConfig(db);
  const season = cfg.season;
  const curve = buildCurve(curveKind, season, db);
  if (curveKind === "conditional") {
    const { levelFactor } = buildConditionalCurve(db, season);
    console.log(`  curve: CONDITIONAL (E[pts | rank]) -- ECR level factor ` +
      Object.entries(levelFactor).map(([p, f]) => `${p} ${f.toFixed(2)}`).join(" "));
  } else {
    console.log(`  curve: ORDER-STATISTIC (k-th best finisher) -- the pre-2026-09-08 behaviour`);
  }
  const age = useAge ? loadAgeCurve() : null;
  const opp = useOpp ? loadOpportunity() : null;
  const proj = (pos: string, r: number) => { const cv = curve[pos]; return cv && cv.length ? cv[Math.min(r, cv.length - 1)] : 0; };

  // ECR players ordered by ecr; within-position 0-indexed rank = k for the curve lookup
  const ecrRows = db.prepare("SELECT p.name, p.position AS pos, r.overall_rank AS ecr FROM ranking r JOIN player p USING(player_id) WHERE r.source='fantasypros_ecr' AND r.season=@s ORDER BY r.overall_rank").all({ s: season }) as { name: string; pos: string; ecr: number }[];
  // THE STABLE KEY, resolved once here and carried into points.csv. Everything downstream -- values,
  // the board, the simulator, the age and opportunity models -- has been joining on a normalised
  // NAME, which is what let a father's birth year be applied to his son. Resolving identity at the
  // point the projection is produced means no consumer has to do it again, differently.
  const skRows = db.prepare("SELECT name_key, position, player_sk FROM stg_player").all() as { name_key: string; position: string; player_sk: number }[];
  const skOf = new Map<string, number>(), skByName = new Map<string, number | null>();
  for (const r of skRows) {
    skOf.set(`${r.name_key}|${r.position}`, r.player_sk);
    skByName.set(r.name_key, skByName.has(r.name_key) ? null : r.player_sk);   // null = shared name
  }
  db.close();
  const resolveSk = (name: string, pos: string): number | null =>
    skOf.get(`${nameKey(name)}|${pos.toUpperCase()}`) ?? skByName.get(nameKey(name)) ?? null;

  const posCount: Record<string, number> = {};
  const out: [string, string, number, number | null][] = [];
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
    const sk = resolveSk(row.name, pos);
    const p = Math.round(
      proj(pos, r)
      * ageFactor(age, row.name, pos, season, sk)
      * opportunityFactor(opp, row.name, pos, usageRank, season, sk)
      * 10) / 10;
    // DST names are already canonical ("SF D/ST") from ingest -- use as-is
    if (p > 0) out.push([row.name, pos, p, sk]);
  }
  const withSk = out.filter((o) => o[3] != null).length;
  console.log(`  player_sk resolved for ${withSk}/${out.length} projections`);
  if (age) {
    const cov = ageCoverage(age, out.map((o) => ({ name: o[0], pos: o[1], sk: o[3] })));
    console.log(`  age curve applied to ${cov.known}/${cov.total} players (the rest keep a multiplier of 1)`);
  }
  if (opp) {
    const cov = opportunityCoverage(opp, out.map((o) => ({ name: o[0], sk: o[3] })), season);
    console.log(`  opportunity applied to ${cov.known}/${cov.total} players (QB is flat by measurement; rookies keep 1)`);
  }
  out.sort((a, b) => b[2] - a[2]);
  // player_sk is APPENDED, never inserted. Fifty-odd readers destructure the first three columns
  // positionally (`const [name, pos, pts] = line.split(",")`), so a new column at the end is
  // invisible to them and a new column in the middle would silently shift every value they read.
  writeFileSync(outPath, "player,pos,points,player_sk\n" + out.map(([n, p, pt, sk]) => `${n},${p},${pt},${sk ?? ""}`).join("\n") + "\n", "utf8");
  return out.length;
}
