/**
 * fact_draft_pick -- one row per pick this league actually made, with the market consensus as it
 * stood and the auction state at the moment of the pick.
 *
 * WHY IT IS NOT `draft_pick`. That table is draft-RUNTIME state: keyed by a live `draft_id`, written
 * per tick during a draft, and empty between drafts (it holds 0 rows in the shipped store). A price
 * model needs the historical record, not the runtime one, and conflating them would mean the
 * training set disappears the next time a draft ends.
 *
 * THE SOURCE MOVED, AND THAT IS THE POINT OF PHASE 2C. It used to be `data/recaps.json` -- ESPN
 * recap pages scraped by hand into a gitignored file -- which covered FOUR seasons, 738 picks, and
 * could not be rebuilt by re-fetching. `raw_league_pick` now holds NINE seasons and 1,658 picks
 * through a real ingest verb, so this reads the raw table. A fact table whose only home was a file
 * nobody could regenerate was one `rm` away from being the most league-specific data we own.
 *
 * THE CONSENSUS COLUMNS are what make a price interpretable. A price on its own says what somebody
 * paid; a price beside "and the market had him WR14 with a dispersion of 4.2" says what they paid
 * RELATIVE to public information, which is the quantity a price model is about.
 *
 * WE DO NOT KNOW THE DRAFT DATES. ESPN's history gives the picks and not the day, so `draft_date` is
 * NULL and the consensus is read from the LATEST PRESEASON SCRAPE of that season -- August or the
 * first week of September. Every row says which scrape (`consensus_asof`), because "the consensus at
 * the draft" and "the last consensus before week 1" are different quantities and a model fitted on
 * one while believing the other is a silent error. Seasons the ECR archive does not reach carry a
 * NULL consensus and say so, rather than borrowing a neighbouring year's.
 *
 * THE AUCTION STATE columns -- money and slots remaining, and the room's total -- are computed by
 * replaying the picks in the order the source returned them. `price_share` normalises across the
 * 14-team and 16-team eras: a $2,800 room and a $3,200 room are different currencies and a model
 * comparing raw dollars across them is comparing two things.
 */
import { readFileSync, existsSync } from "node:fs";
import { openDb, nowIso, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";
import { nameKey } from "../draft/values.js";
import { buildSkResolver } from "../data/skResolve.js";
import { normPos } from "../data/stgPlayer.js";

interface RecapTeam { season: number; name: string; picks: { pick: number; player: string; pos: string; price: number }[] }

export interface PicksResult {
  rows: number;
  perSeason: {
    season: number; picks: number; total: number; resolved: number; withConsensus: number;
    asOf: string | null; rawTotal: number; teams: number; budget: number;
  }[];
  /** Seasons in raw_league_pick whose dollar total does NOT match the fact table. Must be empty. */
  mismatched: number[];
  source: "raw_league_pick" | "recaps.json";
}

export function buildDraftPicks(opts: { dbPath?: string; recapPath?: string } = {}): PicksResult {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const resolver = buildSkResolver(db);
  const res: PicksResult = { rows: 0, perSeason: [], mismatched: [], source: "raw_league_pick" };

  let raw = db.prepare(
    "SELECT league_id, season, pick_no, team_id, name, pos, price FROM raw_league_pick ORDER BY season, pick_no",
  ).all() as { league_id: string; season: number; pick_no: number; team_id: string | null; name: string; pos: string | null; price: number }[];

  // FALLBACK to the old recap file, and it is a fallback rather than a second source of truth: a
  // store that has not run `ff ingest-raw league-history` yet still gets a table, and the result
  // says which source it came from so nobody has to infer it from a row count.
  if (!raw.length) {
    const recapPath = opts.recapPath ?? dataPath("recaps.json");
    if (!existsSync(recapPath)) { db.close(); return res; }
    res.source = "recaps.json";
    const teamId = new Map<string, string>();
    for (const t of db.prepare("SELECT season, team_id, name FROM raw_league_team_season").all() as { season: number; team_id: string; name: string }[]) {
      teamId.set(`${t.season}|${t.name}`, t.team_id);
    }
    raw = (JSON.parse(readFileSync(recapPath, "utf8")) as RecapTeam[]).flatMap((t) =>
      t.picks.map((p) => ({
        league_id: "", season: t.season, pick_no: p.pick, team_id: teamId.get(`${t.season}|${t.name}`) ?? null,
        name: p.player, pos: p.pos, price: p.price,
      })));
    raw.sort((a, b) => a.season - b.season || a.pick_no - b.pick_no);
  }

  // Team identity and the room's shape, per season. Both come from the raw league tables; a season
  // missing a settings row keeps NULLs rather than inheriting last year's budget.
  const team = new Map<string, { name: string | null; owner: string | null }>();
  for (const t of db.prepare("SELECT season, team_id, name, owner FROM raw_league_team_season").all() as { season: number; team_id: string; name: string | null; owner: string | null }[]) {
    team.set(`${t.season}|${t.team_id}`, { name: t.name, owner: t.owner });
  }
  const shape = new Map<number, { size: number; budget: number; slots: number }>();
  for (const s of db.prepare("SELECT season, size, auction_budget, slot_counts_json FROM raw_league_season WHERE available = 1").all() as { season: number; size: number; auction_budget: number; slot_counts_json: string | null }[]) {
    let slots = 0;
    try { for (const v of Object.values(JSON.parse(s.slot_counts_json ?? "{}") as Record<string, number>)) slots += Number(v) || 0; } catch { /* no slot map */ }
    shape.set(s.season, { size: s.size, budget: s.auction_budget, slots });
  }

  const ins = db.prepare(
    `INSERT INTO fact_draft_pick (season, league_id, team_id, owner, team_name, player_sk, name, name_key,
       pos, price, pick_order, draft_date, consensus_asof, consensus_pos_rank_asof, consensus_sd_asof,
       money_remaining, slots_remaining, season_total_money, price_share, updated_at)
     VALUES (@season,@lg,@teamId,@owner,@teamName,@sk,@name,@nk,@pos,@price,@order,@date,@asOf,@rank,@sd,
       @money,@slots,@pool,@share,@now)
     ON CONFLICT(season, team_name, pick_order) DO UPDATE SET
       player_sk=excluded.player_sk, name=excluded.name, pos=excluded.pos, price=excluded.price,
       owner=excluded.owner, team_id=excluded.team_id, consensus_asof=excluded.consensus_asof,
       consensus_pos_rank_asof=excluded.consensus_pos_rank_asof,
       consensus_sd_asof=excluded.consensus_sd_asof, money_remaining=excluded.money_remaining,
       slots_remaining=excluded.slots_remaining, season_total_money=excluded.season_total_money,
       price_share=excluded.price_share, updated_at=excluded.updated_at`,
  );

  const seasons = [...new Set(raw.map((r) => r.season))].sort((a, b) => a - b);
  for (const yr of seasons) {
    const { rank: cons, asOf } = preseasonConsensus(db, yr);
    const sh = shape.get(yr);
    const pool = sh ? sh.size * sh.budget : 0;
    const spent = new Map<string, number>(), taken = new Map<string, number>();
    const mine = raw.filter((r) => r.season === yr);
    let picks = 0, total = 0, resolved = 0, withCons = 0;
    db.transaction(() => {
      // REPLACE THE SEASON. The upsert keys on team_name, which comes from a source table that can
      // change (a team renames), so a rebuild after a rename would leave the old rows in place --
      // the same shape of defect the feature tables carried.
      db.prepare("DELETE FROM fact_draft_pick WHERE season = ?").run(yr);
      for (const p of mine) {
        const pos = normPos((p.pos ?? "").toUpperCase());
        const nk = nameKey(p.name);
        // (name_key, position) through staging. `raw_league_pick` carries no player id and no NFL
        // team -- ESPN's history gives a display name -- so this is the strongest evidence there is,
        // and it is still not a bare name: a pair two staged players share resolves to NOBODY.
        const sk = resolver.resolve({ name: p.name, pos });
        const c = cons.get(`${nk}|${pos}`);
        const tk = `${yr}|${p.team_id ?? ""}`;
        const t = team.get(tk);
        const before = spent.get(tk) ?? 0, count = taken.get(tk) ?? 0;
        ins.run({
          season: yr, lg: p.league_id || null, teamId: p.team_id, owner: t?.owner || null,
          teamName: t?.name ?? p.team_id ?? null,
          sk, name: p.name, nk, pos, price: p.price, order: p.pick_no,
          date: null, asOf, rank: c?.rank ?? null, sd: c?.sd ?? null,
          money: sh ? sh.budget - before : null,
          slots: sh && sh.slots ? sh.slots - count : null,
          pool: pool || null,
          share: pool ? p.price / pool : null,
          now,
        });
        spent.set(tk, before + p.price); taken.set(tk, count + 1);
        picks++; total += p.price; if (sk) resolved++; if (c) withCons++;
      }
    })();
    const rawTotal = mine.reduce((a, b) => a + b.price, 0);
    if (Math.round(total) !== Math.round(rawTotal)) res.mismatched.push(yr);
    res.rows += picks;
    res.perSeason.push({
      season: yr, picks, total, resolved, withConsensus: withCons, asOf,
      rawTotal, teams: sh?.size ?? 0, budget: sh?.budget ?? 0,
    });
  }
  db.close();
  return res;
}

/**
 * Positional rank + dispersion from the LATEST preseason scrape of that season.
 *
 * THE LIVE SEASON IS NOT IN THE ARCHIVE. `ranking_history` is an archive of past scrapes; the season
 * being played has its consensus in `ranking`, which is the table the live board is built from. So
 * the live season reads that instead -- the same rule `src/features/build.ts` already applies, and
 * for the same reason: this feature has to be the number the auction was actually priced against,
 * not a slightly different one from a parallel source.
 *
 * A season that is in NEITHER gets a NULL consensus and an `asOf` of null, and says so. Borrowing a
 * neighbouring year's ranks would be indistinguishable, on the row, from having them.
 */
function preseasonConsensus(db: DB, yr: number): { rank: Map<string, { rank: number; sd: number | null }>; asOf: string | null } {
  const out = new Map<string, { rank: number; sd: number | null }>();
  let raw: { scrape_date: string; name: string; pos: string; ecr: number; sd: number | null }[] = [];
  try {
    raw = db.prepare(
      "SELECT scrape_date, name, pos, ecr, sd FROM ranking_history " +
      "WHERE ecr_type='ro' AND source='fantasypros' AND season=@s AND ecr IS NOT NULL " +
      "AND (substr(scrape_date,6,2)='08' OR (substr(scrape_date,6,2)='09' AND CAST(substr(scrape_date,9,2) AS INTEGER)<=7))",
    ).all({ s: yr }) as typeof raw;
  } catch { return { rank: out, asOf: null }; }
  if (!raw.length) return liveConsensus(db, yr, out);
  let latest = "";
  for (const r of raw) if (r.scrape_date > latest) latest = r.scrape_date;
  const byPos = new Map<string, typeof raw>();
  for (const r of raw) {
    if (r.scrape_date !== latest) continue;
    const pos = normPos((r.pos ?? "").toUpperCase());
    (byPos.get(pos) ?? byPos.set(pos, []).get(pos)!).push(r);
  }
  for (const [pos, list] of byPos) {
    list.sort((a, b) => a.ecr - b.ecr);
    list.forEach((r, i) => out.set(`${nameKey(r.name)}|${pos}`, { rank: i + 1, sd: r.sd ?? null }));
  }
  return { rank: out, asOf: latest };
}

/** The live season's consensus, from the table the board is built from. `sd` is not carried there,
 *  so it stays NULL rather than being filled with a plausible number. */
function liveConsensus(db: DB, yr: number, out: Map<string, { rank: number; sd: number | null }>): { rank: Map<string, { rank: number; sd: number | null }>; asOf: string | null } {
  let rows: { name: string; pos: string; ecr: number; fetched: string | null }[] = [];
  try {
    rows = db.prepare(
      "SELECT p.name, p.position AS pos, r.overall_rank AS ecr, r.fetched_at AS fetched FROM ranking r " +
      "JOIN player p USING(player_id) WHERE r.source='fantasypros_ecr' AND r.season=@s AND r.overall_rank IS NOT NULL " +
      "ORDER BY r.overall_rank",
    ).all({ s: yr }) as typeof rows;
  } catch { return { rank: out, asOf: null }; }
  if (!rows.length) return { rank: out, asOf: null };
  const seen: Record<string, number> = {};
  let asOf = "";
  for (const r of rows) {
    const pos = normPos((r.pos ?? "").toUpperCase());
    seen[pos] = (seen[pos] ?? 0) + 1;
    out.set(`${nameKey(r.name)}|${pos}`, { rank: seen[pos], sd: null });
    const d = (r.fetched ?? "").slice(0, 10);
    if (d > asOf) asOf = d;
  }
  return { rank: out, asOf: asOf || null };
}

// ==================================================================================================
// THE OTHER TWO FACTS: what each team did with the roster it drafted, and who it played.
// ==================================================================================================

export interface LeagueFactsResult {
  teamSeasons: number; matchups: number;
  perSeason: { season: number; teams: number; games: number; champion: string | null; settled: boolean; playoffField: number; fieldSource: string; seedsAgree: boolean | null }[];
}

/**
 * `fact_team_season` + `fact_matchup`, from the raw league tables.
 *
 * ALMOST NO DERIVATION, deliberately. `champion` is `final_rank = 1` and `made_playoffs` is
 * `playoff_seed <= the field`, and both are computed HERE, once, rather than in each consumer -- the
 * repo has already paid for prior-year finish rank being re-derived in five scripts.
 *
 * `settled` is the one judgement, and it is made from the DATA rather than from the calendar: a
 * season is settled when every team has a `final_rank` and at least one of them is 1. The season in
 * progress has neither, and a consumer scoring a simulation against it would be scoring against a
 * placeholder that looks exactly like a result.
 */
export function buildLeagueFacts(opts: { dbPath?: string } = {}): LeagueFactsResult {
  const db = openDb(opts.dbPath);
  const now = nowIso();
  const res: LeagueFactsResult = { teamSeasons: 0, matchups: 0, perSeason: [] };

  const rows = db.prepare(
    `SELECT league_id, season, team_id, name, owner_id, owner, wins, losses, points_for, final_rank,
            playoff_seed, acquisitions, faab_spent, drops, trades, lineup_moves
       FROM raw_league_team_season ORDER BY season, CAST(team_id AS INTEGER)`,
  ).all() as Record<string, string | number | null>[];
  const games = db.prepare(
    "SELECT league_id, season, week, home_id, away_id FROM raw_league_matchup ORDER BY season, week, home_id",
  ).all() as { league_id: string; season: number; week: number; home_id: string; away_id: string }[];
  // THE SEASON'S OWN FORMAT, read from ESPN per season by `ingest-raw league-history`. Before this
  // existed the field size was inferred from the team COUNT (`playoffFieldFor`), which is a proxy
  // that happens to be right for this league's history and cannot ever be wrong out loud. Now the
  // real number is available and the proxy is the fallback, reported when it is used.
  const fmtBySeason = new Map<number, { regWeeks: number | null; playoffTeams: number | null; playoffReseed: number | null; seedingRule: string | null; divisionCount: number | null }>();
  for (const r of db.prepare(
    "SELECT season, reg_weeks, playoff_teams, playoff_reseed, seeding_rule, division_count FROM raw_league_season",
  ).all() as Record<string, number | string | null>[]) {
    fmtBySeason.set(Number(r.season), {
      regWeeks: r.reg_weeks == null ? null : Number(r.reg_weeks),
      playoffTeams: r.playoff_teams == null ? null : Number(r.playoff_teams),
      playoffReseed: r.playoff_reseed == null ? null : Number(r.playoff_reseed),
      seedingRule: r.seeding_rule == null ? null : String(r.seeding_rule),
      divisionCount: r.division_count == null ? null : Number(r.division_count),
    });
  }

  const bySeason = new Map<number, Record<string, string | number | null>[]>();
  for (const r of rows) {
    const s = Number(r.season);
    (bySeason.get(s) ?? bySeason.set(s, []).get(s)!).push(r);
  }

  const insT = db.prepare(
    `INSERT INTO fact_team_season (league_id, season, team_id, team_name, owner_id, owner, wins, losses,
       points_for, playoff_seed, final_rank, champion, made_playoffs, settled, acquisitions, faab_spent,
       drops, trades, lineup_moves, updated_at,
       reg_weeks, playoff_teams, playoff_reseed, seeding_rule, division_count)
     VALUES (@lg,@season,@team,@name,@oid,@owner,@w,@l,@pf,@seed,@rank,@champ,@playoffs,@settled,@acq,@faab,@drops,@trades,@moves,@now,
       @rw,@pt,@prs,@sr,@dc)
     ON CONFLICT(season, team_id) DO UPDATE SET
       team_name=excluded.team_name, owner=excluded.owner, owner_id=excluded.owner_id, wins=excluded.wins,
       losses=excluded.losses, points_for=excluded.points_for, playoff_seed=excluded.playoff_seed,
       final_rank=excluded.final_rank, champion=excluded.champion, made_playoffs=excluded.made_playoffs,
       settled=excluded.settled, acquisitions=excluded.acquisitions, faab_spent=excluded.faab_spent,
       drops=excluded.drops, trades=excluded.trades, lineup_moves=excluded.lineup_moves,
       updated_at=excluded.updated_at, reg_weeks=excluded.reg_weeks, playoff_teams=excluded.playoff_teams,
       playoff_reseed=excluded.playoff_reseed, seeding_rule=excluded.seeding_rule, division_count=excluded.division_count`,
  );
  const insM = db.prepare(
    `INSERT INTO fact_matchup (league_id, season, week, home_id, away_id, updated_at)
     VALUES (@lg,@season,@week,@home,@away,@now)
     ON CONFLICT(season, week, home_id) DO UPDATE SET away_id=excluded.away_id, updated_at=excluded.updated_at`,
  );

  db.transaction(() => {
    db.prepare("DELETE FROM fact_team_season").run();
    db.prepare("DELETE FROM fact_matchup").run();
    for (const [season, list] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
      const settled = list.every((r) => r.final_rank != null) && list.some((r) => Number(r.final_rank) === 1);
      // THE PLAYOFF FIELD is a stated constant per era -- see playoffFieldFor for why it cannot be
      // derived from these columns -- and the top-k agreement check is reported beside it so a
      // season where the two disagree is visible rather than silently absorbed.
      const seeded = list.map((r) => ({
        seed: r.playoff_seed == null ? null : Number(r.playoff_seed),
        rank: r.final_rank == null ? null : Number(r.final_rank),
      }));
      // ESPN'S OWN NUMBER FIRST, the size proxy only when ESPN has none for that season.
      const sf = fmtBySeason.get(season);
      const fieldSource = sf?.playoffTeams != null ? "espn" : "team-count proxy";
      const field = sf?.playoffTeams ?? playoffFieldFor(list.length);
      const agrees = seedsAgreeAtField(seeded, field);
      let champion: string | null = null;
      for (const r of list) {
        const rank = r.final_rank == null ? null : Number(r.final_rank);
        const seed = r.playoff_seed == null ? null : Number(r.playoff_seed);
        const champ = settled && rank === 1 ? 1 : 0;
        if (champ) champion = String(r.owner ?? r.name ?? r.team_id);
        insT.run({
          lg: r.league_id, season, team: String(r.team_id), name: r.name, oid: r.owner_id, owner: r.owner,
          w: r.wins, l: r.losses, pf: r.points_for, seed, rank, champ,
          playoffs: seed == null ? null : (seed <= field ? 1 : 0),
          settled: settled ? 1 : 0,
          acq: r.acquisitions, faab: r.faab_spent, drops: r.drops, trades: r.trades, moves: r.lineup_moves,
          now,
          rw: sf?.regWeeks ?? null, pt: sf?.playoffTeams ?? null, prs: sf?.playoffReseed ?? null,
          sr: sf?.seedingRule ?? null, dc: sf?.divisionCount ?? null,
        });
        res.teamSeasons++;
      }
      const g = games.filter((x) => x.season === season);
      for (const x of g) { insM.run({ lg: x.league_id, season, week: x.week, home: x.home_id, away: x.away_id, now }); res.matchups++; }
      res.perSeason.push({ season, teams: list.length, games: g.length, champion, settled, playoffField: field, fieldSource, seedsAgree: agrees });
    }
  })();
  db.close();
  return res;
}

/**
 * How many teams make the playoffs. A STATED CONSTANT per era, and the attempt to derive it is
 * recorded here because the attempt failing is the useful part.
 *
 * THE DERIVATION THAT DOES NOT WORK. A bracket looks as though it should be readable off the
 * finishes: the teams that finish 1..k ought to be exactly the teams seeded 1..k, for k the size of
 * the field. It fails twice over.
 *
 *   - k = teams satisfies it TRIVIALLY (all n seeds are a permutation of 1..n), so "the largest k
 *     that satisfies it" is always the whole league. A first cut did exactly that, was always
 *     rejected as impossible, and always returned its fallback -- right for every real season, and
 *     structurally incapable of returning anything else. Only a fault injection found it.
 *   - Bounded to a plausible bracket it is still not identifiable. Across the six settled 14-team
 *     seasons the largest satisfying k is 6, 8, 6, 4, 6, 8 -- because ESPN's `final_rank` is a
 *     consolation-inclusive ordering whose relationship to the bracket varies by season. In 2021 the
 *     8 seed finished FIFTH and the 6 seed seventh, which no six-team bracket can produce.
 *
 * So the field is not derived. It is 6 in the 14-team era and 7 in the 16-team one -- the value the
 * league's own `settings.config.playoffTeams` records for the current era, and the value the top-k
 * check agrees with in four of the six settled 14-team seasons and in 2025. `seedsAgreeAtField`
 * exposes that check so the disagreement is a number somebody can look at rather than a silence.
 */
export function playoffFieldFor(teams: number): number {
  return teams >= 16 ? 7 : 6;
}

/** Do the top `field` finishers form exactly the top `field` seeds? Null when the season has no
 *  finishes to read. This is EVIDENCE about the field, not the field itself -- see above. */
export function seedsAgreeAtField(rows: { seed: number | null; rank: number | null }[], field: number): boolean | null {
  const seedOfRank = new Map<number, number>();
  for (const r of rows) if (r.rank != null && r.seed != null) seedOfRank.set(r.rank, r.seed);
  const seeds = new Set<number>();
  for (let k = 1; k <= field; k++) {
    const s = seedOfRank.get(k);
    if (s == null) return null;
    seeds.add(s);
  }
  return seeds.size === field && Math.max(...seeds) === field;
}
