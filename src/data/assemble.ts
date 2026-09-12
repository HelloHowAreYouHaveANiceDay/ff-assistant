// TS port of the assembler (was tools/build_report.py). Reads reference data from the store (ECR,
// bio, byes, news -- all put there by `ff ingest`), ports the two remaining fetches (ESPN draft
// ranks + last-year actuals aggregation), runs the existing TS computeValues on the projections,
// computes every derived field (rank/pos_rank/tier/vsECR/age/ht/espn_pos), and writes L1 player_value
// + L2 board + the ESPN ranking. Only remaining Python after this: build_projections (the curve).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fetchCsv, pick, NFLVERSE } from "./nflverse.js";
import { nameKey, computeValues, resolveValueLeague, type PointsRow } from "../draft/values.js";
import { scoreWeek, type ScoringRules } from "../draft/scoring.js";
import { openDb, getConfig, nowIso } from "../db/db.js";
import { dataPath } from "./paths.js";
import { boardSpreads } from "../draft/spread.js";
import { loadEligibilityMap } from "./eligibility.js";

// last-year (season-1) REG fantasy points + games played under the LEAGUE's scoring, keyed by name_key
async function lastYear(season: number, scoring: ScoringRules): Promise<Map<string, { pts: number; gms: number }>> {
  const rows = await fetchCsv(`${NFLVERSE}/stats_player/stats_player_week_${season - 1}.csv`);
  const agg = new Map<string, { pts: number; weeks: Set<number> }>();
  for (const r of rows) {
    if (pick(r, "season_type") !== "REG") continue;
    const name = pick(r, "player_display_name"); if (!name) continue;
    const fp = scoreWeek(r, scoring);
    const k = nameKey(name);
    if (!agg.has(k)) agg.set(k, { pts: 0, weeks: new Set() });
    const a = agg.get(k)!; a.pts += fp; const wk = Number(pick(r, "week")); if (wk) a.weeks.add(wk);
  }
  const out = new Map<string, { pts: number; gms: number }>();
  for (const [k, a] of agg) out.set(k, { pts: Math.round(a.pts * 10) / 10, gms: a.weeks.size });
  return out;
}

// ESPN draft rank (STANDARD) + ADP, keyed by name_key
async function espnRanks(season: number): Promise<Map<string, { rank: number; adp: number | null }>> {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const filter = JSON.stringify({ players: { limit: 900, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: "STANDARD" } } });
  const out = new Map<string, { rank: number; adp: number | null }>();
  try {
    const res = await fetch(url, { headers: { "x-fantasy-filter": filter } });
    const data = await res.json() as { players?: { player?: { fullName?: string; draftRanksByRankType?: { STANDARD?: { rank?: number } }; ownership?: { averageDraftPosition?: number } } }[] };
    for (const p of data.players ?? []) {
      const pp = p.player ?? {};
      const rank = pp.draftRanksByRankType?.STANDARD?.rank;
      const adp = pp.ownership?.averageDraftPosition;
      const k = nameKey(pp.fullName ?? "");
      if (k && rank != null && !out.has(k)) out.set(k, { rank, adp: adp != null && adp > 0 ? Math.round(adp * 10) / 10 : null });
    }
  } catch { /* best-effort second source */ }
  return out;
}

function fmtHt(h: string): string {
  if (!h) return "";
  const m = h.match(/^(\d)[-'](\d{1,2})/); if (m) return `${m[1]}'${m[2]}"`;
  const inches = parseInt(h, 10);
  return Number.isFinite(inches) ? `${Math.floor(inches / 12)}'${inches % 12}"` : h;
}

/** One staged identity row: who this name stands for, per the registry. */
export interface StgIdentity { position: string | null; team: string | null; birthdate: string | null; sk?: number }
/** The bio columns age/experience were being read from, keyed by NAME ALONE -- which is the defect. */
export interface BioRow { birth_date?: string | null; exp?: number | null }

/**
 * Pick the staged row that is actually THIS board row's player, or null if none can be trusted.
 *
 * Position alone is not enough, and the case that proves it is Marvin Harrison Jr. `nameKey` strips
 * generational suffixes -- deliberately, so "Odell Beckham Jr." matches across sources -- which means
 * father and son collapse to the same key. Staging holds only the FATHER (WR, IND, born 1973), so a
 * name+position lookup returns a Hall of Famer who retired in 2008 and puts age 53 on a 24-year-old.
 * That is the same wrong-person defect as the Jeffersons, arriving from the opposite direction: there
 * the registry knew about both men, here it knows about the wrong one.
 *
 * TEAM is what separates them, and it is already on the board row. So:
 *   - position AND team both match, uniquely      -> that is him
 *   - a unique candidate whose team does not CONTRADICT the board's -> accept (teams are sometimes
 *     blank, and an offseason trade should degrade to the bio row rather than to a stranger)
 *   - anything else                                -> null, and the caller falls back or blanks
 */
export function pickStaged(candidates: StgIdentity[], pos: string, team: string): StgIdentity | null {
  const P = (pos ?? "").toUpperCase(), T = (team ?? "").toUpperCase();
  const agrees = (r: StgIdentity) => !r.team || !T || r.team.toUpperCase() === T;
  const exact = candidates.filter((r) => (r.position ?? "").toUpperCase() === P && agrees(r) && r.team && T);
  if (exact.length === 1) return exact[0];
  const byPos = candidates.filter((r) => (r.position ?? "").toUpperCase() === P && agrees(r));
  if (byPos.length === 1) return byPos[0];
  const any = candidates.filter(agrees);
  if (any.length === 1) return any[0];
  return null;
}

/**
 * Age and experience for one board row, resolved through the identity registry.
 *
 * Pure and exported so the two-Justin-Jeffersons case can be tested without a database. The rule:
 *
 *   1. Birth date comes from the staged row `pickStaged` selected, when it has one.
 *   2. Otherwise from the bio row -- but only if the name is not one staging knows to be shared. A
 *      shared name with no usable staged row is a coin flip between two people, and a blank cell
 *      beats a confidently wrong age.
 *   3. Experience has no staged equivalent (stg_player carries identity, not career history), so the
 *      bio value is kept only where that bio row can be shown to describe the SAME MAN: its birth
 *      date must agree with staging's. Where they disagree the bio row is somebody else's and its
 *      `exp` is his too -- which is exactly how a seventh-year receiver got a rookie badge.
 */
export function resolveAgeExp(
  stg: StgIdentity | null,
  bio: BioRow | null,
  nameShared: boolean,
  asof: number,
): { age: number | ""; exp: string | number } {
  const stgBirth = stg?.birthdate || null;
  const birth = stgBirth ?? (nameShared ? null : (bio?.birth_date ?? null));
  let age: number | "" = "";
  if (birth) {
    const d = Date.parse(String(birth).slice(0, 10));
    if (!Number.isNaN(d)) age = Math.round((asof - d) / (365.25 * 864e5) * 10) / 10;
  }
  const bioMatches = !!bio?.birth_date && !!stgBirth
    && String(bio.birth_date).slice(0, 10) === String(stgBirth).slice(0, 10);
  const expOk = stgBirth ? bioMatches : !nameShared;
  const exp: string | number = expOk ? (bio?.exp === 0 ? "R" : (bio?.exp ?? "")) : "";
  return { age, exp };
}

type Row = Record<string, string | number>;
const COLS = ["rank", "player", "pos", "pos_rank", "ecr_pos", "espn_pos", "tier", "team", "bye", "age", "exp", "ht", "wt", "forty",
  "our_value", "edge", "adp", "vs_adp", "mkt_trend", "proj_pts", "p10", "p50", "p90", "last_pts", "last_gms", "ecr", "best", "worst", "espn_rank", "espn_adp", "rostered", "buzz", "depth", "news", "news_url",
  // APPENDED, not inserted. Every existing key keeps its position in the board's row_json, so a
  // consumer reading by name is unaffected and one reading by index is not silently shifted.
  "eligible"];
const header = (lastYr: number) => ["Rank", "Player", "Pos", "Us_Pos", "ECR_Pos", "ESPN_Pos", "Tier", "Team", "Bye", "Age", "Exp", "Ht", "Wt", "40yd",
  "OurValue$", "vsECR", "ADP", "vsADP", "Mkt30d", "ProjPts", "P10", "P50", "P90", `${lastYr}Pts`, `${lastYr}Gms`, "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "ESPN_ADP", "Rostered%", "SleeperBuzz", "Depth", "Latest News", "NewsURL", "Eligible"];

export async function assemble(dbPath?: string, pointsPath = dataPath("points.csv")): Promise<number> {
  const db = openDb(dbPath);
  const cfg = getConfig(db);
  const season = cfg.season;
  const asof = Date.UTC(season, 8, 1); // Sep 1

  // 1. projections -> our values (existing TS computeValues)
  if (!existsSync(pointsPath)) throw new Error(`missing ${pointsPath} (run build_projections first)`);
  let points: PointsRow[] = readFileSync(pointsPath, "utf8").trim().split(/\r?\n/).slice(1).map((l) => {
    const [name, pos, pts] = l.split(","); return { name: (name || "").trim(), pos: (pos || "").trim().toUpperCase(), points: Number(pts) };
  }).filter((p) => p.name && Number.isFinite(p.points));
  // CONSENSUS BLEND (the shipped FFToday edge). Re-rank the board's ORDERING toward the FFToday expert
  // consensus per the `consensusBlend` lever, BEFORE pricing, so both the value and the displayed
  // proj_pts reflect it. The transform is shared with the arbiter (src/draft/consensusBlend.ts), so the
  // live board gets exactly what the CPCV backtest validated (~+2.8pp titles). A no-op when the lever is
  // 0, and identity for any player FFToday does not rank (or a season it does not cover).
  const consensusBlend = cfg.levers.consensusBlend ?? 0;
  if (consensusBlend > 0) {
    const { loadConsensusPct, blendConsensus } = await import("../draft/consensusBlend.js");
    const pct = loadConsensusPct(db);
    const ranked = points.filter((p) => pct.has(`${season}|${p.pos}|${nameKey(p.name)}`)).length;
    points = blendConsensus(points, (pos, name) => pct.get(`${season}|${pos}|${nameKey(name)}`) ?? null, consensusBlend);
    console.log(`  consensus-blend ${consensusBlend}: re-ranked the board toward FFToday (${ranked}/${points.length} players ranked, season ${season})`);
  }
  const projByName = new Map(points.map((p) => [p.name, p.points]));
  // ESPN'S OWN ELIGIBILITY, when it has been ingested. `loadEligibilityMap` carries only players who
  // are startable at more than one of QB/RB/WR/TE, so on a board where nobody is -- which is every
  // player on the 2026 board, measured -- the map is EMPTY and computeValues is byte-for-byte the
  // function that shipped. `eligKnown` is what separates "measured, and he is single-eligible" from
  // "never ingested": without it the Eligible column would assert a fact it does not have.
  const eligKnown = (db.prepare("SELECT COUNT(*) AS n FROM raw_espn_eligibility WHERE season=@s").get({ s: season }) as { n: number }).n > 0;
  const elig = eligKnown ? loadEligibilityMap(db, season) : new Map<string, string[]>();
  const values = computeValues(points, resolveValueLeague(cfg), cfg.levers.maxKDst, true, elig);

  // 2-4. external fetches (ported): last-year actuals + ESPN ranks
  const [ly, espn] = await Promise.all([lastYear(season, cfg.scoring_rules), espnRanks(season)]);

  // 5. reference data from the store, keyed by name_key
  type Ecr = { team: string; ecr: number; ecr_pos: string; best: number; worst: number; rostered: number };
  const ecr = new Map<string, Ecr>();
  for (const r of db.prepare("SELECT p.player_id, p.name, p.position, p.nfl_team AS team, r.overall_rank AS ecr, r.pos_rank AS ecr_pos, r.best, r.worst, r.rostered_pct AS rostered FROM ranking r JOIN player p USING(player_id) WHERE r.source='fantasypros_ecr' AND r.season=@s").all({ s: season }) as (Ecr & { player_id: string; name: string; position: string })[]) {
    const e: Ecr = { team: r.team, ecr: r.ecr, ecr_pos: r.ecr_pos, best: r.best, worst: r.worst, rostered: r.rostered };
    ecr.set(r.player_id, e); // DST now key consistently by team abbr from ingest -- no nickname hack needed
  }
  const bio = new Map<string, { height: string; weight: number; forty: number; birth_date: string; exp: number }>();
  for (const b of db.prepare("SELECT player_id, height, weight, forty, birth_date, exp FROM player_bio").all() as { player_id: string; height: string; weight: number; forty: number; birth_date: string; exp: number }[]) bio.set(b.player_id, b);

  // IDENTITY FOR AGE AND EXPERIENCE COMES FROM STAGING, NOT FROM A NAME-KEYED BIO ROW.
  //
  // `player_bio` is keyed by name_key alone, so two real people who share a name share a row and the
  // last writer wins. On the live board that put the LINEBACKER Justin Jefferson's birth date
  // (2003-03-20) on the WIDE RECEIVER at ECR 9 -- age 23.5 and a rookie badge on a 27-year-old in his
  // seventh season -- and did the same to DeVonta Smith (23.7 and "R", against a real 27.8). This is
  // the highest-traffic surface in the system and it was the one consumer still joining on a name.
  //
  // `stg_player` already resolves this: it holds BOTH Justin Jeffersons as separate rows with their
  // own birth dates and marks the name `ambiguous`. The resolution rule is the same one this function
  // already uses two hundred lines below to pick `player_sk` -- position first, then name alone but
  // only when that name belongs to exactly one player -- because a consumer that resolved identity by
  // a DIFFERENT rule than the layer above it is the whole failure being retired.
  const stgByName = new Map<string, StgIdentity[]>();
  for (const r of db.prepare("SELECT name_key, position, birthdate, team, player_sk FROM stg_player").all() as { name_key: string; position: string; birthdate: string; team: string; player_sk: number }[]) {
    (stgByName.get(r.name_key) ?? stgByName.set(r.name_key, []).get(r.name_key)!)
      .push({ position: r.position, team: r.team, birthdate: r.birthdate, sk: r.player_sk });
  }
  const byes = new Map<string, number>();
  for (const t of db.prepare("SELECT team, bye FROM team_bye WHERE season=@s").all({ s: season }) as { team: string; bye: number }[]) byes.set(t.team, t.bye);
  // FFC draft-market ADP + FantasyCalc 30-day momentum, keyed by name_key
  const adpMap = new Map<string, number>();
  for (const a of db.prepare("SELECT player_id, adp FROM adp").all() as { player_id: string; adp: number }[]) adpMap.set(a.player_id, a.adp);
  const trendMap = new Map<string, number>();
  for (const m of db.prepare("SELECT player_id, trend_30d FROM market_value").all() as { player_id: string; trend_30d: number }[]) if (m.trend_30d != null) trendMap.set(m.player_id, m.trend_30d);
  const newsByKey = new Map<string, { injury: string; depth: string; buzz: string; news: string; url: string }>();
  for (const r of db.prepare("SELECT player_id, category, detail, source, url FROM news ORDER BY id").all() as { player_id: string; category: string; detail: string; source: string; url: string }[]) {
    const d = newsByKey.get(r.player_id) ?? { injury: "", depth: "", buzz: "", news: "", url: "" };
    if (r.category === "injury" && !d.injury) d.injury = r.detail;
    else if (r.category === "role" && !d.depth) { const m = /depth (\d+)/.exec(r.detail); if (m) d.depth = m[1]; }
    else if (r.category === "trending" && !d.buzz) d.buzz = /add/.test(r.source) ? "ADD" : "DROP";
    else if (r.category === "headline" && !d.news) { d.news = `${r.detail} (${r.source})`; d.url = r.url; }
    newsByKey.set(r.player_id, d);
  }

  // 6. assemble one row per valued player
  const rows: Row[] = [];
  for (const v of values) {
    const k = nameKey(v.name);
    const m = ecr.get(k); const b = bio.get(k); const nd = newsByKey.get(k);
    const team = m?.team ?? "";
    const cands = stgByName.get(k) ?? [];
    // ONE identity decision per board row, made HERE, and its answer supplies both the age and the
    // surrogate key. They used to be decided separately -- `pickStaged` for the age, a (name_key,
    // position) lookup plus a name-only fallback for the key -- so one board row could be aged as
    // one man and keyed as another. `pickStaged` is the stricter of the two (it uses TEAM), which is
    // what lets Marvin Harrison Jr. resolve at all now that his father is also staged.
    const staged = pickStaged(cands, v.pos, team);
    const { age, exp } = resolveAgeExp(staged, b ?? null, cands.length > 1, asof);
    const lyRow = ly.get(k); const es = espn.get(k);
    rows.push({
      player_sk: staged?.sk ?? "",
      player: v.name, pos: v.pos.toUpperCase(), team, bye: byes.get(team) ?? "",
      age, exp, ht: fmtHt(b?.height ?? ""), wt: b?.weight ?? "", forty: b?.forty ?? "",
      our_value: Math.round(v.value), adp: adpMap.get(k) ?? "", mkt_trend: trendMap.get(k) ?? "",
      proj_pts: Math.round((projByName.get(v.name) ?? 0) * 10) / 10,
      last_pts: lyRow ? lyRow.pts : "", last_gms: lyRow ? lyRow.gms : "",
      ecr: m?.ecr ?? "", ecr_pos: m?.ecr_pos ?? "", best: m?.best ?? "", worst: m?.worst ?? "",
      espn_rank: es?.rank ?? "", espn_adp: es?.adp ?? "", rostered: m?.rostered != null ? Math.round(m.rostered) : "",
      injury: nd?.injury ?? "", depth: nd?.depth ?? "", buzz: nd?.buzz ?? "", news: nd?.news ?? "", news_url: nd?.url ?? "",
      // ESPN's eligible SET, "RB/WR" style. Blank means never ingested -- not "single-eligible":
      // a blank and a confident wrong answer look identical downstream and only one says so.
      eligible: eligKnown ? (elig.get(k) ?? [v.pos.toUpperCase()]).join("/") : "",
      value_pos: v.valuePos ?? v.pos,
    });
  }
  rows.sort((a, b) => (b.our_value as number) - (a.our_value as number));

  // rank / pos_rank / tier / vsECR
  const posSeen: Record<string, number> = {}, tierTop: Record<string, number> = {}, tierNo: Record<string, number> = {};
  rows.forEach((r, i) => {
    r.rank = i + 1; const p = r.pos as string;
    posSeen[p] = (posSeen[p] ?? 0) + 1; r.pos_rank = `${p}${posSeen[p]}`;
    r.edge = typeof r.ecr === "number" ? Math.round((r.ecr as number) - (r.rank as number)) : "";
    // vsADP: market's ADP minus our rank. POSITIVE = the room lets them fall past where we value them (a bargain).
    r.vs_adp = typeof r.adp === "number" ? Math.round((r.adp as number) - (r.rank as number)) : "";
    if (!(p in tierTop) || (r.our_value as number) < tierTop[p] * cfg.levers.tierBreak) { tierNo[p] = (tierNo[p] ?? 0) + 1; tierTop[p] = r.our_value as number; }
    r.tier = `${p}-T${tierNo[p]}`;
  });
  // 6b. THE BAND BEHIND EACH PROJECTION (p10/p90 of the season total).
  //
  // Runs AFTER pos_rank is assigned, because the bootstrap pools are joined on preseason positional
  // rank -- that join is the whole mechanism, and doing this earlier would silently pass rank 0 for
  // every player and hand back one identical band for the entire board. A uniform band is exactly
  // the kind of wrong answer that looks like a working feature.
  try {
    const outcomes = JSON.parse(readFileSync(dataPath("rank-outcomes.json"), "utf8"));
    const corrModel = JSON.parse(readFileSync(dataPath("correlation-model.json"), "utf8"));
    const inputs = rows.map((r) => ({
      name: r.player as string, pos: r.pos as string, team: (r.team as string) || undefined,
      posRank: Number(String(r.pos_rank).replace(/^[A-Z]+/, "")) || 0,
      projPts: typeof r.proj_pts === "number" ? r.proj_pts : 0,
    }));
    const { spreads, uncalibrated } = boardSpreads(inputs, outcomes, corrModel);
    for (const r of rows) {
      const s = spreads.get(r.player as string);
      r.p10 = s ? s.p10 : "";
      r.p50 = s ? s.p50 : "";
      r.p90 = s ? s.p90 : "";
    }
    const banded = rows.filter((r) => r.p10 !== "").length;
    console.log(`  spread: p10/p90 on ${banded}/${rows.length} players` +
      (uncalibrated.length ? ` (${uncalibrated.length} left uncalibrated -- pool/projection ratio outside [0.5, 2.0])` : ""));
  } catch (e) {
    // A missing fitted model must not take the board down -- but it must not be silent either, or
    // the column just quietly empties and looks like players legitimately having no band.
    console.log(`  spread: SKIPPED -- ${(e as Error).message}`);
    for (const r of rows) { r.p10 = ""; r.p50 = ""; r.p90 = ""; }
  }

  // ESPN positional rank (within pos, by ESPN overall)
  const byPos: Record<string, Row[]> = {};
  for (const r of rows) if (typeof r.espn_rank === "number") (byPos[r.pos as string] ??= []).push(r);
  for (const p in byPos) { byPos[p].sort((a, b) => (a.espn_rank as number) - (b.espn_rank as number)); byPos[p].forEach((r, i) => (r.espn_pos = `${p}${i + 1}`)); }
  for (const r of rows) if (r.espn_pos == null) r.espn_pos = "";

  // 7. write L1 player_value + ESPN ranking + L2 board (full-refresh for the season)
  const HEAD = header(season - 1);
  const now = nowIso();
  // Board players staging could not identify. COUNTED and named rather than guessed at -- a column
  // of nulls and a column of confident wrong ids look identical downstream, and only one of them
  // announces itself.
  const unresolved: string[] = [];
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM player_value WHERE season=@s").run({ s: season });
    db.prepare("DELETE FROM ranking WHERE source='espn' AND season=@s").run({ s: season });
    db.prepare("DELETE FROM board WHERE season=@s").run({ s: season });
    const upPlayer = db.prepare("INSERT INTO player (player_id, name, position, updated_at) VALUES (?,?,?,?) ON CONFLICT(player_id) DO NOTHING");
    // player_sk comes from STAGING, looked up by (name_key, position). Consumers get the stable id so
    // they can stop joining on names; player_id stays for the callers not yet migrated.
    // The key was decided ONCE, up in the row loop, by `pickStaged` -- position, then team, then a
    // unique candidate, and null rather than a guess. The name-only fallback that used to sit here
    // is gone: the layering rules forbid a consumer deciding identity, and "the name belongs to
    // exactly one staged player" is a decision -- one that silently reattaches a man his sources
    // reclassified to whoever else holds his name.
    const upVal = db.prepare("INSERT INTO player_value (player_id, player_sk, season, our_value, our_rank, pos_rank, tier, proj_pts, last_pts, last_gms, updated_at) VALUES (@id,@sk,@s,@v,@rk,@pr,@t,@pp,@lp,@lg,@now)");
    const upRank = db.prepare("INSERT INTO ranking (player_id, source, season, overall_rank, pos_rank, adp, fetched_at) VALUES (@id,'espn',@s,@rank,@pos,@adp,@now) ON CONFLICT(player_id,source,season) DO UPDATE SET overall_rank=excluded.overall_rank, pos_rank=excluded.pos_rank, adp=excluded.adp, fetched_at=excluded.fetched_at");
    const upBoard = db.prepare("INSERT INTO board (player_id, player_sk, season, row_json, updated_at) VALUES (@id,@sk,@s,@json,@now)");
    const numOrNull = (x: unknown) => typeof x === "number" ? x : null;
    for (const r of rows) {
      const id = nameKey(r.player as string); if (!id) continue;
      upPlayer.run(id, r.player, r.pos, now);
      // Unresolved is a STATE, not an error: `sk` stays null, the row is counted below, and nothing
      // is guessed. A board player the crosswalk classifies differently (our board had Max Bredeson
      // at RB, the crosswalk at TE) reads as unresolved rather than as a confident wrong id -- and
      // staging already adds a board-sourced row for exactly those men, so the fix belongs there,
      // in the layer whose job identity is.
      const sk = typeof r.player_sk === "number" ? r.player_sk : null;
      if (sk == null) unresolved.push(String(r.player));
      upVal.run({ id, sk, s: season, v: r.our_value, rk: r.rank, pr: r.pos_rank, t: r.tier, pp: numOrNull(r.proj_pts), lp: numOrNull(r.last_pts), lg: numOrNull(r.last_gms), now });
      if (typeof r.espn_rank === "number") upRank.run({ id, s: season, rank: r.espn_rank, pos: r.espn_pos || null, adp: numOrNull(r.espn_adp), now });
      const obj: Record<string, unknown> = {}; COLS.forEach((c, i) => (obj[HEAD[i]] = r[c]));
      upBoard.run({ id, sk, s: season, json: JSON.stringify(obj), now });
    }
  });
  tx();
  if (unresolved.length) {
    console.log(`  player_sk: ${rows.length - unresolved.length}/${rows.length} board rows resolved into staging;` +
      ` ${unresolved.length} unresolved (kept, with a NULL key): ${unresolved.slice(0, 8).join(", ")}${unresolved.length > 8 ? " ..." : ""}`);
  }

  // player-report.csv for compat/validation (build_app_data no longer needs it; kept during transition)
  const san = (x: unknown) => String(x ?? "").replace(/,/g, " ").replace(/\n/g, " ").trim();
  const lines = [HEAD.join(",")];
  for (const r of rows) lines.push(COLS.map((c) => san(r[c])).join(","));
  writeFileSync(dataPath("player-report.csv"), lines.join("\n") + "\n", "utf8");
  db.close();
  return rows.length;
}
