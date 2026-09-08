/**
 * ONE PIPELINE that builds the point-in-time feature tables. `ff build-features --seasons 1999-2025`.
 *
 * WHAT IT REPLACES. Prior-year finish rank was derived independently in nested-cv.mjs,
 * residual-analysis.mjs, feature-sweep.mjs, feature-value.mjs and fit-opportunity.mjs. Prior-season
 * usage was aggregated independently in three of those. The rank curve had at least three separate
 * builders in scripts/, none of them the one src/data/projections.ts ships. Every one of those
 * copies joined on a display NAME, so each reproduced the identity collisions Phase 1 fixed on the
 * board -- and a fit script that silently joins the wrong man produces a coefficient, not an error.
 *
 * THE INVARIANT THIS TABLE EXISTS TO HOLD: nothing in a row may depend on information that did not
 * exist at `as_of`. That is why the curve columns are rebuilt PER SEASON with an expanding window
 * (`buildConditionalCurve(db, Y, path, Y)` -- season pairs and ECR scrapes strictly before Y) rather
 * than fitted once on everything. A curve fitted on all 27 seasons and then used as a feature for
 * 2010 is lookahead moved one level up, into the model, where no data-level check can see it.
 *
 * TARGETS LIVE IN THE SAME TABLE, deliberately: `pts` and `games` are what a model is fitted
 * against, and a feature table you have to join to a second table to train from is a feature table
 * people bypass. They are named as targets in the schema comment and the projector's input type
 * cannot see them.
 */
import { readFileSync, existsSync } from "node:fs";
import { openDb, getConfig, nowIso, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import { nameKey } from "../draft/values.js";
import { buildConditionalCurve, buildCurveFromHistory } from "../data/projections.js";
import { buildSkResolver, type SkResolver } from "../data/skResolve.js";
import { fetchCsvCached, playerWeekUrl, cacheTag, canonTeam, pick, URLS, draftPicksUrl } from "../data/nflverse.js";
import { normPos } from "../data/stgPlayer.js";

/** The positions a fantasy roster is made of. IDP rows exist in the history files and are left out
 *  here on purpose: this league does not start them, and carrying 20k rows nothing reads would make
 *  every count in this table mean something other than what it says. */
export const FEAT_POS = ["QB", "RB", "WR", "TE", "K", "DST"];

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const orNull = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : x);

/** The row key: the stable player key where identity resolved, and an explicitly-marked name key
 *  where it did not. An unresolved row is KEPT -- dropping it would shrink the training set in a way
 *  nothing downstream could notice. */
const featKey = (sk: string | null, nk: string, pos: string) => sk ?? `NK:${nk}|${pos}`;

interface SeasonRow {
  key: string; sk: string | null; name: string; nameKey: string; pos: string;
  pts: number; games: number; team: string | null;
}

/** history-points.csv + history-weekly.csv, by season. The files carry `player_sk` as their last
 *  column since Phase 2a; a file without it still loads and every row simply reads unresolved. */
function readHistory(pointsPath: string, weeklyPath: string): { season: Map<number, Map<string, SeasonRow>>; games: Map<string, number> } {
  const season = new Map<number, Map<string, SeasonRow>>();
  const games = new Map<string, number>();
  for (const line of readFileSync(weeklyPath, "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    const yr = Number(f[0]); if (!Number.isFinite(yr)) continue;
    const k = `${yr}|${f[1]}|${f[2]}`;
    games.set(k, (games.get(k) ?? 0) + 1);
  }
  for (const line of readFileSync(pointsPath, "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    const yr = Number(f[0]), name = (f[1] ?? "").trim(), pos = (f[2] ?? "").trim().toUpperCase();
    const pts = Number(f[3]), sk = (f[4] ?? "").trim() || null;
    if (!Number.isFinite(yr) || !name || !FEAT_POS.includes(pos)) continue;
    const m = season.get(yr) ?? season.set(yr, new Map()).get(yr)!;
    const nk = nameKey(name);
    m.set(featKey(sk, nk, pos), {
      key: featKey(sk, nk, pos), sk, name, nameKey: nk, pos,
      pts: Math.max(0, pts), games: games.get(`${yr}|${name}|${pos}`) ?? 0, team: null,
    });
  }
  return { season, games };
}

interface Usage { games: number; fd: number; ts: number; attempts: number; rushYards: number; ays: number; wopr: number; team: string | null }

/** Prior-season usage, aggregated ONCE, from the cached nflverse player-week feed. Shares (target
 *  share, air-yards share, wopr) are averaged over games played; counting stats are summed and then
 *  divided by games. Both are "per game" and the distinction matters -- summing a share would make
 *  a durable player look like a high-share one. */
async function seasonUsage(yr: number, resolver: SkResolver): Promise<Map<string, Usage>> {
  const out = new Map<string, Usage>();
  let rows: Record<string, string>[];
  try { rows = await fetchCsvCached(playerWeekUrl(yr), cacheTag.playerWeek(yr)); } catch { return out; }
  for (const r of rows) {
    if (pick(r, "season_type") !== "REG") continue;
    const name = pick(r, "player_display_name"); if (!name) continue;
    const pos = normPos(pick(r, "position").toUpperCase());
    if (!FEAT_POS.includes(pos)) continue;
    const team = canonTeam(pick(r, "team"));
    const sk = resolver.resolve({ gsis: pick(r, "player_id"), name, pos, team });
    const k = featKey(sk, nameKey(name), pos);
    const u = out.get(k) ?? { games: 0, fd: 0, ts: 0, attempts: 0, rushYards: 0, ays: 0, wopr: 0, team: null };
    u.games++;
    // `fd` is RECEIVING plus RUSHING first downs, matching the definition the shipped opportunity
    // model was fitted on. Receiving alone would score a running back on the smaller half of his
    // own workload -- and would silently change the artifact the moment its fit script read this
    // column instead of re-deriving its own.
    u.fd += num(r.receiving_first_downs) + num(r.rushing_first_downs);
    u.ts += num(r.target_share);
    u.attempts += num(r.attempts);
    u.rushYards += num(r.rushing_yards);
    u.ays += num(r.air_yards_share);
    u.wopr += num(r.wopr);
    u.team = team || u.team;
    out.set(k, u);
  }
  return out;
}

interface EcrRow { rank: number; sd: number | null; name: string; pos: string; team: string | null }

/**
 * Preseason consensus positional rank for a season.
 *
 * PAST seasons come from the `ranking_history` archive, restricted to the LATEST scrape in August or
 * the first week of September -- the last consensus published before anyone plays. An in-season
 * scrape here would be lookahead wearing a preseason label.
 *
 * The CURRENT season comes from `ranking` instead, because that is the table the live board is built
 * from and this feature has to be the same number the board indexes its curve at. Reading the
 * archive for the live season would give the model a slightly different consensus from the one the
 * auction is actually priced against.
 */
function ecrForSeason(db: DB, yr: number, currentSeason: number, resolver: SkResolver): Map<string, EcrRow> {
  const out = new Map<string, EcrRow>();
  if (yr === currentSeason) {
    const rows = db.prepare(
      "SELECT p.name, p.position AS pos, p.nfl_team AS team, r.overall_rank AS ecr FROM ranking r " +
      "JOIN player p USING(player_id) WHERE r.source='fantasypros_ecr' AND r.season=@s ORDER BY r.overall_rank",
    ).all({ s: yr }) as { name: string; pos: string; team: string | null; ecr: number }[];
    const seen: Record<string, number> = {};
    for (const r of rows) {
      const pos = normPos(r.pos ?? "");
      if (!FEAT_POS.includes(pos)) continue;
      seen[pos] = (seen[pos] ?? 0) + 1;
      const sk = resolver.resolve({ name: r.name, pos, team: r.team });
      out.set(featKey(sk, nameKey(r.name), pos), { rank: seen[pos], sd: null, name: r.name, pos, team: r.team ?? null });
    }
    return out;
  }
  let raw: { scrape_date: string; name: string; pos: string; team: string | null; ecr: number; sd: number | null }[] = [];
  try {
    raw = db.prepare(
      "SELECT scrape_date, name, pos, team, ecr, sd FROM ranking_history " +
      "WHERE ecr_type='ro' AND source='fantasypros' AND season=@s AND ecr IS NOT NULL " +
      "AND (substr(scrape_date,6,2)='08' OR (substr(scrape_date,6,2)='09' AND CAST(substr(scrape_date,9,2) AS INTEGER)<=7))",
    ).all({ s: yr }) as typeof raw;
  } catch { return out; }
  if (!raw.length) return out;
  let latest = "";
  for (const r of raw) if (r.scrape_date > latest) latest = r.scrape_date;
  const byPos = new Map<string, typeof raw>();
  for (const r of raw) {
    if (r.scrape_date !== latest) continue;
    const pos = normPos((r.pos ?? "").toUpperCase());
    if (!FEAT_POS.includes(pos)) continue;
    (byPos.get(pos) ?? byPos.set(pos, []).get(pos)!).push(r);
  }
  for (const [pos, list] of byPos) {
    list.sort((a, b) => a.ecr - b.ecr);
    list.forEach((r, i) => {
      const sk = resolver.resolve({ name: r.name, pos, team: r.team });
      out.set(featKey(sk, nameKey(r.name), pos), { rank: i + 1, sd: orNull(r.sd), name: r.name, pos, team: r.team ?? null });
    });
  }
  return out;
}

/** nflverse draft picks, keyed the same way as everything else. A ROOKIE PRIOR: it is the only thing
 *  we know about a player with no prior season at all, and it is the feature most likely to matter
 *  for exactly the rows where every other prior column is null. */
async function draftCapital(resolver: SkResolver): Promise<Map<string, { year: number; round: number; pick: number }>> {
  const out = new Map<string, { year: number; round: number; pick: number }>();
  let rows: Record<string, string>[];
  try { rows = await fetchCsvCached(draftPicksUrl, cacheTag.draftPicks); } catch { return out; }
  for (const r of rows) {
    const name = pick(r, "pfr_player_name"); if (!name) continue;
    const pos = normPos(pick(r, "position").toUpperCase());
    if (!FEAT_POS.includes(pos)) continue;
    // The feed's gsis_id is a legacy PFR-style token for old drafts and a real gsis for modern ones;
    // only the modern form can match, and the resolver falls through on the rest by itself.
    const g = pick(r, "gsis_id");
    const sk = resolver.resolve({ gsis: /^\d\d-\d+$/.test(g) ? g : null, name, pos, team: canonTeam(pick(r, "team")) });
    const k = featKey(sk, nameKey(name), pos);
    if (out.has(k)) continue;                        // first (earliest) draft row wins; nobody is drafted twice
    out.set(k, { year: num(r.season), round: num(r.round), pick: num(r.pick) });
  }
  return out;
}

export interface BuildFeaturesResult {
  seasons: number[];
  seasonRows: number; seasonResolved: number;
  weekRows: number; weekResolved: number;
  perSeason: { season: number; rows: number; scored: number; withEcr: number; withUsage: number; withAge: number }[];
}

export async function buildFeatures(opts: {
  dbPath?: string; seasons: number[];
  pointsPath?: string; weeklyPath?: string;
  weeks?: boolean;
}): Promise<BuildFeaturesResult> {
  const db = openDb(opts.dbPath);
  const cfg = getConfig(db);
  const now = nowIso();
  const resolver = buildSkResolver(db);
  const pointsPath = opts.pointsPath ?? dataPath("history-points.csv");
  const weeklyPath = opts.weeklyPath ?? dataPath("history-weekly.csv");
  if (!existsSync(pointsPath)) throw new Error(`${pointsPath} missing -- run \`ff build-history\` first`);
  const { season: hist } = readHistory(pointsPath, weeklyPath);

  // birthdate by surrogate key. The registry is the ONLY age source here; the name-keyed player_bio
  // row is what put a linebacker's birth year on a receiver, and a feature table is precisely where
  // that would be laundered into a coefficient.
  const birth = new Map<string, string>();
  for (const r of db.prepare("SELECT player_sk, birthdate FROM stg_player WHERE birthdate IS NOT NULL AND birthdate != ''")
    .all() as { player_sk: number; birthdate: string }[]) birth.set(String(r.player_sk), r.birthdate);

  const drafted = await draftCapital(resolver);

  const seasons = opts.seasons.slice().sort((a, b) => a - b);
  const usageCache = new Map<number, Map<string, Usage>>();
  const usageFor = async (yr: number) => {
    if (!usageCache.has(yr)) usageCache.set(yr, await seasonUsage(yr, resolver));
    return usageCache.get(yr)!;
  };

  const ins = db.prepare(
    `INSERT INTO feat_player_season (feat_key, player_sk, season, as_of, name, name_key, pos, team,
      prior_pos_rank, prior_pts, prior_games, age, prior_fd, prior_ts, prior_attempts, prior_rush_yards,
      prior_air_yards_share, prior_wopr, team_changed, draft_year, draft_round, draft_pick,
      ecr_pos_rank, ecr_sd, curve_value_prior, curve_value_ecr, curve_value_orderstat, pts, games, pos_rank, updated_at)
     VALUES (@key,@sk,@season,@asOf,@name,@nk,@pos,@team,@priorRank,@priorPts,@priorGames,@age,@fd,@ts,
             @att,@ry,@ays,@wopr,@changed,@dy,@dr,@dp,@ecr,@ecrSd,@cvPrior,@cvEcr,@cvOs,@pts,@games,@posRank,@now)
     ON CONFLICT(season, feat_key) DO UPDATE SET
       player_sk=excluded.player_sk, as_of=excluded.as_of, name=excluded.name, pos=excluded.pos,
       team=excluded.team, prior_pos_rank=excluded.prior_pos_rank, prior_pts=excluded.prior_pts,
       prior_games=excluded.prior_games, age=excluded.age, prior_fd=excluded.prior_fd,
       prior_ts=excluded.prior_ts, prior_attempts=excluded.prior_attempts,
       prior_rush_yards=excluded.prior_rush_yards, prior_air_yards_share=excluded.prior_air_yards_share,
       prior_wopr=excluded.prior_wopr, team_changed=excluded.team_changed, draft_year=excluded.draft_year,
       draft_round=excluded.draft_round, draft_pick=excluded.draft_pick, ecr_pos_rank=excluded.ecr_pos_rank,
       ecr_sd=excluded.ecr_sd, curve_value_prior=excluded.curve_value_prior,
       curve_value_ecr=excluded.curve_value_ecr, curve_value_orderstat=excluded.curve_value_orderstat,
       pts=excluded.pts, games=excluded.games, pos_rank=excluded.pos_rank, updated_at=excluded.updated_at`,
  );
  const insCurve = db.prepare(
    `INSERT INTO feat_curve (season, kind, pos, rank, value, updated_at) VALUES (@s,@k,@p,@r,@v,@now)
     ON CONFLICT(season, kind, pos, rank) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  );

  const res: BuildFeaturesResult = { seasons: [], seasonRows: 0, seasonResolved: 0, weekRows: 0, weekResolved: 0, perSeason: [] };

  for (const yr of seasons) {
    const rows = hist.get(yr);
    const isCurrent = yr === cfg.season;
    if (!rows && !isCurrent) continue;
    const prior = hist.get(yr - 1);
    const priorUsage = await usageFor(yr - 1);
    // The CURRENT season's feed too, for `team` and `team_changed`. Not a leak: which shirt a man
    // wears is settled before week 1, which is what `as_of` is anchored to. Reading it from the
    // cache map keyed by year -- as an earlier version did -- silently returned undefined for every
    // row, because that map is only populated one season BEHIND the loop, and `team_changed` was
    // therefore null on all 17,189 rows while looking perfectly well-formed.
    const curUsage = await usageFor(yr);
    const ecr = ecrForSeason(db, yr, cfg.season, resolver);

    // POINT-IN-TIME CURVES: fitted on seasons strictly before yr. Rebuilt per season rather than
    // once, which is the whole reason this column can be a feature at all.
    const { curve: condCurve } = buildConditionalCurve(db, yr, pointsPath, yr);
    let osCurve: Record<string, number[]> = {};
    try { osCurve = buildCurveFromHistory(yr, 6, pointsPath); } catch { /* too few prior seasons */ }
    const at = (c: Record<string, number[]>, pos: string, rank: number | null): number | null => {
      const v = c[pos];
      if (!v || !v.length || rank == null || rank < 1) return null;
      return v[Math.min(rank - 1, v.length - 1)];
    };

    // Finish rank within position, computed ONCE here from the same row set the table is built
    // from. The prior season's ranks index the curve; this season's are stored so next season's
    // build does not derive them a second time and differently.
    const rankOf = (set: Map<string, SeasonRow> | undefined) => {
      const m = new Map<string, number>();
      if (!set) return m;
      const byPos = new Map<string, SeasonRow[]>();
      for (const r of set.values()) (byPos.get(r.pos) ?? byPos.set(r.pos, []).get(r.pos)!).push(r);
      for (const list of byPos.values()) {
        list.sort((a, b) => b.pts - a.pts);
        list.forEach((r, i) => m.set(r.key, i + 1));
      }
      return m;
    };
    const priorRank = rankOf(prior);
    const ownRank = rankOf(rows);

    // The curve itself, so a consumer can read season yr at ANY rank rather than only at the ranks
    // that happen to appear on a feature row.
    db.transaction(() => {
      for (const [kind, c] of [["conditional", condCurve], ["orderstat", osCurve]] as const) {
        for (const [pos, v] of Object.entries(c)) {
          for (let i = 0; i < v.length; i++) insCurve.run({ s: yr, k: kind, p: pos, r: i + 1, v: v[i], now });
        }
      }
    })();

    // The universe. A completed season is everyone who was SCORED; the live season has no scored
    // players yet, so it is everyone the consensus ranks.
    const keys = new Set<string>(rows ? [...rows.keys()] : []);
    if (isCurrent) for (const k of ecr.keys()) keys.add(k);

    const asOf = `${yr}-09-01`;
    let withEcr = 0, withUsage = 0, withAge = 0, n = 0, resolved = 0;
    db.transaction(() => {
      for (const key of keys) {
        const r = rows?.get(key);
        const e = ecr.get(key);
        const pu = priorUsage.get(key);
        const pr = prior?.get(key);
        const sk = r?.sk ?? (key.startsWith("NK:") ? null : key);
        // Name and position come from whichever source knows this row. For the LIVE season there is
        // no scored history at all, so the consensus is the only source -- and taking the position
        // from the key instead (`key.split("|").pop()`) silently returned the surrogate key itself
        // for every resolved player, which produced a board of one row and no error.
        const pos = r?.pos ?? e?.pos ?? "";
        const name = r?.name ?? e?.name ?? "";
        // Age at as_of, from the registry. Missing stays NULL -- never a league-average guess, which
        // would move a projection for a player we know nothing about.
        const bd = sk ? birth.get(sk) : undefined;
        const age = bd ? (Date.parse(`${yr}-09-01T00:00:00Z`) - Date.parse(`${bd}T00:00:00Z`)) / 3.15576e10 : null;
        const cur2 = curUsage.get(key)?.team ?? null;
        const team = cur2 ?? e?.team ?? pu?.team ?? r?.team ?? null;
        const priorTeam = pu?.team ?? null;
        const dc = drafted.get(key);
        const g = pu?.games ?? 0;
        const rank = priorRank.get(key) ?? null;
        ins.run({
          key, sk, season: yr, asOf, name, nk: r?.nameKey ?? nameKey(name), pos, team,
          priorRank: rank, priorPts: orNull(pr?.pts ?? null), priorGames: pr ? (pr.games || null) : null,
          age: age != null && age > 15 && age < 50 ? Math.round(age * 100) / 100 : null,
          fd: g ? pu!.fd / g : null, ts: g ? pu!.ts / g : null,
          att: g ? pu!.attempts / g : null, ry: g ? pu!.rushYards / g : null,
          ays: g ? pu!.ays / g : null, wopr: g ? pu!.wopr / g : null,
          changed: priorTeam && cur2 ? (priorTeam === cur2 ? 0 : 1) : null,
          dy: dc?.year ?? null, dr: dc?.round ?? null, dp: dc?.pick ?? null,
          ecr: e?.rank ?? null, ecrSd: e?.sd ?? null,
          cvPrior: orNull(at(condCurve, pos, rank)), cvEcr: orNull(at(condCurve, pos, e?.rank ?? null)),
          cvOs: orNull(at(osCurve, pos, rank)),
          pts: r ? r.pts : null, games: r ? r.games : null,
          posRank: ownRank.get(key) ?? null,
          now,
        });
        n++; if (sk) resolved++;
        if (e) withEcr++; if (g) withUsage++; if (age != null) withAge++;
      }
    })();
    res.seasons.push(yr); res.seasonRows += n; res.seasonResolved += resolved;
    res.perSeason.push({ season: yr, rows: n, scored: rows?.size ?? 0, withEcr, withUsage, withAge });
  }

  if (opts.weeks !== false) {
    const w = await buildWeekFeatures(db, seasons, weeklyPath, resolver, now);
    res.weekRows = w.rows; res.weekResolved = w.resolved;
  }
  db.close();
  return res;
}

// ==================================================================================================
// WEEK-LEVEL FEATURES.
//
// Kept to what the feeds actually provide. `spread_line` and `total_line` are read from the nflverse
// schedules file as published, and `implied_team_total` is the one derivation -- half the total plus
// half the spread, from THIS team's point of view -- because that is the quantity a weekly model
// wants and computing it in five consumers is how the two halves end up with different sign
// conventions. Nothing here is invented: a week with no line carries NULL rather than a mean.
// ==================================================================================================
async function buildWeekFeatures(db: DB, seasons: number[], weeklyPath: string, resolver: SkResolver, now: string): Promise<{ rows: number; resolved: number }> {
  const want = new Set(seasons);
  const games = await fetchCsvCached(URLS.schedules, cacheTag.schedules);
  // (season, team, week) -> the game, from that team's side.
  const sched = new Map<string, { opp: string; home: number; spread: number | null; total: number | null; implied: number | null; day: string }>();
  const weekDays = new Map<string, string[]>();
  for (const g of games) {
    const yr = Number(pick(g, "season")); if (!want.has(yr) || pick(g, "game_type") !== "REG") continue;
    const wk = Number(pick(g, "week")); if (!wk) continue;
    const home = canonTeam(pick(g, "home_team")), away = canonTeam(pick(g, "away_team"));
    const day = pick(g, "gameday");
    const sp = g.spread_line === "" || g.spread_line == null ? null : Number(g.spread_line);
    const tl = g.total_line === "" || g.total_line == null ? null : Number(g.total_line);
    const half = tl != null ? tl / 2 : null;
    // nflverse publishes spread_line from the HOME team's perspective (positive = home favoured).
    sched.set(`${yr}|${home}|${wk}`, { opp: away, home: 1, spread: sp, total: tl, implied: half != null && sp != null ? half + sp / 2 : null, day });
    sched.set(`${yr}|${away}|${wk}`, { opp: home, home: 0, spread: sp != null ? -sp : null, total: tl, implied: half != null && sp != null ? half - sp / 2 : null, day });
    if (day) (weekDays.get(`${yr}|${wk}`) ?? weekDays.set(`${yr}|${wk}`, []).get(`${yr}|${wk}`)!).push(day);
  }
  // The fallback as_of when a week has no derivable game day: its own Tuesday, i.e. the earliest
  // gameday in that week minus its weekday offset. Where even that is unavailable the row carries
  // the season's September 1 anchor rather than a fabricated date.
  const weekAnchor = new Map<string, string>();
  for (const [k, days] of weekDays) { days.sort(); weekAnchor.set(k, days[0]); }
  const dayBefore = (iso: string): string => {
    const t = Date.parse(`${iso}T00:00:00Z`);
    return Number.isFinite(t) ? new Date(t - 864e5).toISOString().slice(0, 10) : iso;
  };

  // per (season, key) weekly rows from the built history, which is already scored under OUR rules.
  interface WkRow { week: number; pts: number; team: string; name: string; pos: string; sk: string | null }
  const bySeason = new Map<number, Map<string, WkRow[]>>();
  for (const line of readFileSync(weeklyPath, "utf8").trim().split(/\r?\n/).slice(1)) {
    const f = line.split(",");
    const yr = Number(f[0]); if (!want.has(yr)) continue;
    const pos = (f[2] ?? "").toUpperCase(); if (!FEAT_POS.includes(pos)) continue;
    const name = (f[1] ?? "").trim();
    const sk = (f[6] ?? "").trim() || null;
    const key = featKey(sk, nameKey(name), pos);
    const m = bySeason.get(yr) ?? bySeason.set(yr, new Map()).get(yr)!;
    (m.get(key) ?? m.set(key, []).get(key)!).push({ week: Number(f[3]), pts: Number(f[4]), team: (f[5] ?? "").trim(), name, pos, sk });
  }

  const ins = db.prepare(
    `INSERT INTO feat_player_week (feat_key, player_sk, season, week, as_of, name, pos, team, opponent,
       home, spread_line, total_line, implied_team_total, is_bye, td_games, td_fd, td_ts, td_attempts,
       td_rush_yards, td_pts, pts, updated_at)
     VALUES (@key,@sk,@season,@week,@asOf,@name,@pos,@team,@opp,@home,@spread,@total,@implied,@bye,
             @tg,@tfd,@tts,@tatt,@try,@tpts,@pts,@now)
     ON CONFLICT(season, week, feat_key) DO UPDATE SET
       player_sk=excluded.player_sk, as_of=excluded.as_of, team=excluded.team, opponent=excluded.opponent,
       home=excluded.home, spread_line=excluded.spread_line, total_line=excluded.total_line,
       implied_team_total=excluded.implied_team_total, is_bye=excluded.is_bye, td_games=excluded.td_games,
       td_fd=excluded.td_fd, td_ts=excluded.td_ts, td_attempts=excluded.td_attempts,
       td_rush_yards=excluded.td_rush_yards, td_pts=excluded.td_pts, pts=excluded.pts,
       updated_at=excluded.updated_at`,
  );

  let rows = 0, resolved = 0;
  for (const yr of seasons) {
    const m = bySeason.get(yr); if (!m) continue;
    // per-week usage, so "to date" is a running sum rather than a re-derivation per week.
    const perWeek = new Map<string, Map<number, { fd: number; ts: number; att: number; ry: number }>>();
    let pw: Record<string, string>[] = [];
    try { pw = await fetchCsvCached(playerWeekUrl(yr), cacheTag.playerWeek(yr)); } catch { /* usage columns stay null */ }
    for (const r of pw) {
      if (pick(r, "season_type") !== "REG") continue;
      const name = pick(r, "player_display_name"); if (!name) continue;
      const pos = normPos(pick(r, "position").toUpperCase());
      if (!FEAT_POS.includes(pos)) continue;
      const sk = resolver.resolve({ gsis: pick(r, "player_id"), name, pos, team: canonTeam(pick(r, "team")) });
      const key = featKey(sk, nameKey(name), pos);
      const wk = Number(pick(r, "week")); if (!wk) continue;
      (perWeek.get(key) ?? perWeek.set(key, new Map()).get(key)!)
        .set(wk, { fd: num(r.receiving_first_downs) + num(r.rushing_first_downs), ts: num(r.target_share), att: num(r.attempts), ry: num(r.rushing_yards) });
    }
    const maxWeek = Math.max(0, ...[...m.values()].flat().map((r) => r.week));
    db.transaction(() => {
      for (const [key, list] of m) {
        const played = new Map(list.map((r) => [r.week, r]));
        const team = list[list.length - 1].team;
        const sk = list[0].sk;
        const acc = { fd: 0, ts: 0, att: 0, ry: 0, pts: 0, g: 0 };
        for (let wk = 1; wk <= maxWeek; wk++) {
          const p = played.get(wk);
          const tm = p?.team || team;
          const s = sched.get(`${yr}|${tm}|${wk}`);
          const anchor = s?.day ?? weekAnchor.get(`${yr}|${wk}`) ?? null;
          ins.run({
            key, sk, season: yr, week: wk,
            asOf: anchor ? dayBefore(anchor) : `${yr}-09-01`,
            name: list[0].name, pos: list[0].pos, team: tm,
            opp: s?.opp ?? null, home: s ? s.home : null,
            spread: s?.spread ?? null, total: s?.total ?? null, implied: s?.implied ?? null,
            bye: s ? 0 : 1,
            tg: acc.g, tfd: acc.g ? acc.fd / acc.g : null, tts: acc.g ? acc.ts / acc.g : null,
            tatt: acc.g ? acc.att / acc.g : null, try: acc.g ? acc.ry / acc.g : null,
            tpts: acc.g ? acc.pts / acc.g : null,
            pts: p ? p.pts : null,
            now,
          });
          rows++; if (sk) resolved++;
          // Accumulate AFTER writing the row, so week W's features contain weeks 1..W-1 and nothing
          // of week W. Accumulating first is the one-line version of lookahead, and it would make
          // every weekly model in this repo look excellent and be worthless.
          if (p) {
            const u = perWeek.get(key)?.get(wk);
            acc.g++; acc.pts += p.pts;
            if (u) { acc.fd += u.fd; acc.ts += u.ts; acc.att += u.att; acc.ry += u.ry; }
          }
        }
      }
    })();
  }
  return { rows, resolved };
}
