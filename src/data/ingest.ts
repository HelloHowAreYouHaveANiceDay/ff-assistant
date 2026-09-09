// Ingest reference data straight from nflverse/ffverse into the SQLite store. First cut:
// FantasyPros ECR (drives player + ranking), player bio + combine 40s (enriched by name_key),
// and schedule-derived team byes. The projection-curve port stays in Python until a validated
// row-diff pass (that's the one place silent numeric drift hides).
import { openDb, nowIso, setSetting, type DB } from "../db/db.js";
import { fetchCsv, URLS, pick, canonTeam } from "./nflverse.js";
import { nameKey } from "../draft/values.js";

const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const num = (s: string): number | null => { if (s == null || s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

/** FantasyPros redraft-overall ECR -> player + ranking(source='fantasypros_ecr'). */
async function ingestEcr(db: DB, SEASON: number): Promise<{ players: number; rankings: number }> {
  const rows = (await fetchCsv(URLS.ecr))
    .filter((r) => pick(r, "page_type") === "redraft-overall")
    .filter((r) => FANTASY_POS.has(pick(r, "pos").toUpperCase()))
    .map((r) => ({ r, ecr: num(pick(r, "ecr")) }))
    .filter((x) => x.ecr != null)
    .sort((a, b) => a.ecr! - b.ecr!);
  if (rows.length === 0) throw new Error("ECR ingest produced 0 rows -- source shape changed?");

  const upPlayer = db.prepare(
    `INSERT INTO player (player_id, name, position, nfl_team, fp_id, updated_at)
     VALUES (@id, @name, @pos, @team, @fp_id, @ts)
     ON CONFLICT(player_id) DO UPDATE SET
       name=excluded.name, position=excluded.position, nfl_team=excluded.nfl_team,
       fp_id=excluded.fp_id, updated_at=excluded.updated_at`,
  );
  const upRank = db.prepare(
    `INSERT INTO ranking (player_id, source, season, overall_rank, pos_rank, best, worst, rostered_pct, bye, fetched_at)
     VALUES (@id, 'fantasypros_ecr', @season, @ecr, @pos_rank, @best, @worst, @owned, @bye, @ts)
     ON CONFLICT(player_id, source, season) DO UPDATE SET
       overall_rank=excluded.overall_rank, pos_rank=excluded.pos_rank, best=excluded.best,
       worst=excluded.worst, rostered_pct=excluded.rostered_pct, bye=excluded.bye, fetched_at=excluded.fetched_at`,
  );

  const posSeen: Record<string, number> = {};
  const ts = nowIso();
  const run = db.transaction(() => {
    // full refresh: a player who dropped out of ECR should not linger
    db.prepare(`DELETE FROM ranking WHERE source = 'fantasypros_ecr' AND season = ?`).run(SEASON);
    for (const { r, ecr } of rows) {
      const pos = pick(r, "pos").toUpperCase();
      const team = pick(r, "team", "tm");
      // DST canonical identity = the TEAM ABBREVIATION, so the whole pipeline keys them consistently.
      // (ECR names DST inconsistently -- "Arizona Cardinals" vs "49ers"; nameKey even mangles "49ers"
      // -> "ers". Keying by team + a clean "SF D/ST" name -- whose nameKey is the same "sf" -- fixes
      // the double-count and the broken keys.)
      const isDst = pos === "DST" && !!team;
      const id = isDst ? team.toLowerCase().replace(/[^a-z]/g, "") : nameKey(pick(r, "player"));
      const name = isDst ? `${team} D/ST` : pick(r, "player");
      if (!id) continue;
      posSeen[pos] = (posSeen[pos] ?? 0) + 1;
      upPlayer.run({ id, name, pos, team, fp_id: pick(r, "id"), ts });
      upRank.run({
        id, season: SEASON, ecr, pos_rank: `${pos}${posSeen[pos]}`,
        best: num(pick(r, "best")), worst: num(pick(r, "worst")),
        owned: num(pick(r, "player_owned_avg")), bye: num(pick(r, "bye")), ts,
      });
    }
  });
  run();
  return { players: rows.length, rankings: rows.length };
}

/** Enrich bio (physicals + combine 40) for players already known from ECR, matched by name_key. */
async function ingestBio(db: DB, SEASON: number): Promise<number> {
  const known = new Set((db.prepare(`SELECT player_id FROM player`).all() as { player_id: string }[]).map((x) => x.player_id));
  const [players, combine] = await Promise.all([fetchCsv(URLS.players), fetchCsv(URLS.combine)]);

  // combine 40s keyed by name_key (any non-empty; collisions across decades are rare + low-stakes)
  const forty = new Map<string, number>();
  for (const r of combine) {
    const id = nameKey(pick(r, "player_name", "pfr_player_name", "player"));
    const f = num(pick(r, "forty"));
    if (id && f != null && !forty.has(id)) forty.set(id, f);
  }

  const up = db.prepare(
    `INSERT INTO player_bio (player_id, height, weight, forty, birth_date, rookie_season, exp, college, updated_at)
     VALUES (@id, @height, @weight, @forty, @birth, @rookie, @exp, @college, @ts)
     ON CONFLICT(player_id) DO UPDATE SET
       height=excluded.height, weight=excluded.weight, forty=excluded.forty, birth_date=excluded.birth_date,
       rookie_season=excluded.rookie_season, exp=excluded.exp, college=excluded.college, updated_at=excluded.updated_at`,
  );
  const ts = nowIso();
  let n = 0;
  const run = db.transaction(() => {
    for (const r of players) {
      const id = nameKey(pick(r, "display_name", "full_name", "football_name"));
      if (!id || !known.has(id)) continue;
      const rookie = num(pick(r, "rookie_season", "rookie_year"));
      const exp = num(pick(r, "years_of_experience")) ?? (rookie != null ? SEASON - rookie : null);
      up.run({
        id, height: pick(r, "height") || null, weight: num(pick(r, "weight")),
        forty: forty.get(id) ?? null, birth: pick(r, "birth_date") || null,
        rookie, exp, college: pick(r, "college_name", "college") || null, ts,
      });
      n++;
    }
  });
  run();
  return n;
}

// nflverse schedule abbreviations -> the ECR/FantasyPros canonical ones (so team_bye joins player.nfl_team).


/**
 * Persist the season schedule and derive each team's bye (the week it plays no game).
 *
 * One fetch answers both. The bye is a by-product of the opponent map, so keeping the map costs a
 * table write and unlocks every opponent-by-week question -- most importantly playoff-weeks SOS,
 * which season-total projections structurally cannot see.
 */
async function ingestByes(db: DB, SEASON: number): Promise<number> {
  const games = (await fetchCsv(URLS.schedules)).filter((r) => num(pick(r, "season")) === SEASON);
  const weeksByTeam = new Map<string, Set<number>>();
  // one row per TEAM per game (both directions) -- see schema.sql `game`
  const sched: { wk: number; team: string; opp: string; home: number; sp: number | null; tot: number | null }[] = [];
  for (const g of games) {
    const wk = num(pick(g, "week"));
    if (wk == null) continue;
    const away = canonTeam(pick(g, "away_team")), home = canonTeam(pick(g, "home_team"));
    // nflverse: spread_line POSITIVE = home favoured. We store team-relative, NEGATIVE = favoured
    // (matching team_odds), so the home row flips sign and the away row keeps it.
    const raw = num(pick(g, "spread_line"));
    const tot = num(pick(g, "total_line"));
    if (home && away) {
      sched.push({ wk, team: home, opp: away, home: 1, sp: raw == null ? null : -raw, tot });
      sched.push({ wk, team: away, opp: home, home: 0, sp: raw, tot });
    }
    for (const t of [away, home]) {
      if (!t) continue;
      if (!weeksByTeam.has(t)) weeksByTeam.set(t, new Set());
      weeksByTeam.get(t)!.add(wk);
    }
  }
  const maxWk = Math.max(18, ...[...weeksByTeam.values()].flatMap((s) => [...s]));
  const up = db.prepare(
    `INSERT INTO team_bye (season, team, bye) VALUES (?, ?, ?)
     ON CONFLICT(season, team) DO UPDATE SET bye=excluded.bye`,
  );
  const upGame = db.prepare(
    `INSERT INTO game (season, week, team, opponent, home, spread_line, total_line)
     VALUES (@season, @wk, @team, @opp, @home, @sp, @tot)
     ON CONFLICT(season, week, team) DO UPDATE SET
       opponent=excluded.opponent, home=excluded.home,
       spread_line=excluded.spread_line, total_line=excluded.total_line`,
  );
  let n = 0;
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM team_bye WHERE season = ?`).run(SEASON); // full refresh (drop renamed teams)
    for (const [team, weeks] of weeksByTeam) {
      let bye: number | null = null;
      for (let w = 1; w <= maxWk; w++) if (!weeks.has(w)) { bye = w; break; }
      if (bye != null) { up.run(SEASON, team, bye); n++; }
    }
    db.prepare(`DELETE FROM game WHERE season = ?`).run(SEASON); // full refresh (schedule can move)
    for (const s of sched) upGame.run({ season: SEASON, ...s });
  });
  run();
  return n;
}

export async function ingestAll(dbPath?: string): Promise<void> {
  const { ingestNews } = await import("./news.js");
  const { ingestAdvanced, ingestTradeValues, ingestWeekly, ingestSleeper, ingestOdds, ingestBorisTiers, ingestAdp, ingestMarketValue } = await import("./advanced.js");
  const { getConfig } = await import("../db/db.js");
  const db = openDb(dbPath);
  const cfg = getConfig(db);
  const SEASON = Number(process.env.FF_SEASON ?? cfg.season);
  const teams = cfg.teams;
  const t0 = Date.now();
  const ecr = await ingestEcr(db, SEASON);
  const bio = await ingestBio(db, SEASON);
  const byes = await ingestByes(db, SEASON);
  const news = await ingestNews(db, SEASON); // needs the player table (ecr) for RSS tagging
  const adv = await ingestAdvanced(db, SEASON); // snap % + PFR efficiency
  const tv = await ingestTradeValues(db);       // trade values
  const wk = await ingestWeekly(db);            // FantasyPros weekly ranks
  const scoring = cfg.scoring;
  const sleeper = await ingestSleeper(db);      // Sleeper live injury/depth + add/drop trending
  const odds = await ingestOdds(db);            // ESPN Vegas implied team totals
  const boris = await ingestBorisTiers(db, scoring); // Boris Chen positional tiers
  const numQbs = cfg.slots.filter((s) => s === "QB" || s === "OP" || s === "SUPERFLEX" || s === "SF").length || 1; // superflex-aware
  const adp = await ingestAdp(db, SEASON, scoring, teams);  // FFC real draft-market ADP (league size)
  const mkt = await ingestMarketValue(db, scoring, teams, numQbs);  // FantasyCalc market values (league size + QBs)
  setSetting(db, "last_ingest", nowIso());
  setSetting(db, "season", String(SEASON));
  const newsTotal = Object.values(news).reduce((a, b) => a + b, 0);
  console.log(`ingest ok (${Date.now() - t0}ms, season ${SEASON}): players=${ecr.players} ecr=${ecr.rankings} bio=${bio} byes=${byes} news=${newsTotal} advanced(snap=${adv.snap} pfr=${adv.pfr}) trade_values=${tv} weekly=${wk} status=${sleeper.status} trending=${sleeper.trending} odds=${odds} boris=${boris} adp=${adp} market=${mkt}`);
  db.close();
}

// ==================================================================================================
// THE RAW-ASSET REGISTRY.
//
// Every entry writes exactly ONE raw_* table and nothing else. That is the whole distinction from
// the switch below: those sources feed the live board, so materializing one has to re-assemble it;
// these are point-in-time history that models are FITTED on, and the board never reads them.
//
// One list, so `ff ingest-source --list` and docs/data-sources.md cannot disagree about what exists.
// A source that is documented but unregistered reads exactly like one that is registered and broken.
// ==================================================================================================
export interface RawAsset {
  /** The id `ff ingest-source <id>` takes. */
  id: string;
  /** The single raw table it writes. */
  table: string;
  /** One line: what the source is. Printed by `--list` and quoted in docs/data-sources.md. */
  what: string;
  /** Default season range when `--seasons` is omitted, or null for a season-less feed. */
  defaultSeasons: [number, number] | null;
  run(dbPath: string | undefined, seasons: number[]): Promise<number>;
}

export const RAW_ASSETS: RawAsset[] = [
  {
    id: "league-history",
    table: "raw_league_season (+team_season, pick, matchup, division)",
    what: "this league's own past seasons through the desktop app's ESPN session: format, auction prices, activity, finish, schedule",
    defaultSeasons: [2018, new Date().getFullYear()],
    async run(dbPath, seasons) {
      const { ingestLeagueHistory } = await import("./leagueHistory.js");
      const r = await ingestLeagueHistory({ dbPath, seasons });
      return r.counts.picks;
    },
  },
  {
    id: "nfl-games",
    table: "raw_nfl_game",
    what: "nflverse schedules: every NFL game 1999-2026 with the closing Vegas line, weather, roof, surface, rest days and starting QBs",
    defaultSeasons: null,
    async run(dbPath, seasons) {
      const { ingestRawGames } = await import("./rawSources.js");
      const r = await ingestRawGames({ dbPath, seasons });
      return r.total;
    },
  },
];

const RAW_ONLY_ASSETS = new Set(RAW_ASSETS.map((a) => a.id));

async function ingestRawOnly(dbPath: string | undefined, id: string, opts: { seasons?: number[] }): Promise<{ rows: number }> {
  const asset = RAW_ASSETS.find((a) => a.id === id)!;
  let seasons = opts.seasons ?? [];
  if (!seasons.length && asset.defaultSeasons) {
    const [lo, hi] = asset.defaultSeasons;
    for (let y = lo; y <= hi; y++) seasons.push(y);
  }
  seasons = seasons.slice().sort((a, b) => a - b);
  return { rows: await asset.run(dbPath, seasons) };
}

// Materialize ONE source (asset) + only its affected downstream: ECR feeds the projection curve, so
// it re-projects then re-assembles; every other source feeds the board directly, so it just
// re-assembles. This is the per-node "materialize" behind the pipeline DAG view.
export async function ingestOne(dbPath: string | undefined, id: string, opts: { seasons?: number[] } = {}): Promise<{ rows: number }> {
  // RAW-ONLY ASSETS return before the shared tail below. They write a raw_* table and feed nothing
  // the board is assembled from, so re-projecting and re-assembling afterwards would be a five-second
  // no-op that also rewrites consumer tables for no reason. Registered here rather than in the switch
  // because that switch's contract is "this source feeds the board".
  if (RAW_ONLY_ASSETS.has(id)) return ingestRawOnly(dbPath, id, opts);
  const { ingestNews } = await import("./news.js");
  const { ingestAdvanced, ingestTradeValues, ingestWeekly, ingestSleeper, ingestOdds, ingestBorisTiers, ingestAdp, ingestMarketValue } = await import("./advanced.js");
  const { getConfig } = await import("../db/db.js");
  const { project } = await import("./projections.js");
  const { assemble } = await import("./assemble.js");
  const db = openDb(dbPath);
  const cfg = getConfig(db);
  const SEASON = Number(process.env.FF_SEASON ?? cfg.season);
  const teams = cfg.teams, scoring = cfg.scoring;
  const numQbs = cfg.slots.filter((s) => s === "QB" || s === "OP" || s === "SUPERFLEX" || s === "SF").length || 1;
  let rows = 0;
  switch (id) {
    case "ecr": rows = (await ingestEcr(db, SEASON)).players; break;
    case "bio": rows = await ingestBio(db, SEASON); break;
    case "byes": rows = await ingestByes(db, SEASON); break;
    case "advanced": rows = (await ingestAdvanced(db, SEASON)).snap; break;
    case "trade": rows = await ingestTradeValues(db); break;
    case "weekly": rows = await ingestWeekly(db); break;
    case "status": rows = (await ingestSleeper(db)).status; break;
    case "odds": rows = await ingestOdds(db); break;
    case "boris": rows = await ingestBorisTiers(db, scoring); break;
    case "adp": rows = await ingestAdp(db, SEASON, scoring, teams); break;
    case "market": rows = await ingestMarketValue(db, scoring, teams, numQbs); break;
    case "news": rows = Object.values(await ingestNews(db, SEASON)).reduce((a, b) => a + b, 0); break;
    default: db.close(); throw new Error(`unknown source: ${id}`);
  }
  db.close();
  if (id === "ecr") await project(dbPath); // ECR changes the within-position rank -> re-derive the curve
  await assemble(dbPath);                  // every source feeds the board -> rebuild it
  return { rows };
}

// standalone: tsx src/data/ingest.ts
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ingest.ts")) {
  ingestAll().catch((e) => { console.error(String(e)); process.exit(1); });
}
