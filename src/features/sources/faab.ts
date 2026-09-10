/**
 * `fact_waiver_claim` -- this league's own FAAB bid history, as a fact table.
 *
 * WHY THIS TABLE EXISTS. The copilot's waiver rows have carried a FAAB number since Phase 3 and it
 * has always been a STATED RULE -- ten percent of the budget per point of playoff probability,
 * capped at half -- labelled as a rule of thumb because there was nothing to fit it on. There is.
 * The store holds 7,480 transaction items over 2018-2026 with `bid_amount` intact, and ESPN
 * publishes the LOSING bids too: a claim that was outbid comes back as
 * `FAILED_INVALIDPLAYERSOURCE` carrying the amount that lost. So the room's clearing price and
 * P(win | bid) are both observable, and the rule of thumb can be replaced by a measurement.
 *
 * THE EVIDENCE THAT THOSE FAILURES REALLY ARE LOSING BIDS, rather than some other refusal wearing
 * the same status: across every contested player-week in the log, exactly one claim EXECUTED, and
 * no `FAILED_INVALIDPLAYERSOURCE` bid ever EXCEEDS the executed one. That is a property an
 * unrelated failure mode has no reason to satisfy, and it holds on 104 of 104 contested weeks.
 * `scripts/faab-coverage.mjs` re-runs the check; it is the positive control for this whole track.
 *
 * WHAT IS DELIBERATELY EXCLUDED.
 *   - PENDING      -- a claim ESPN never resolved in the retained payload. It has a bid but no
 *                     outcome, so counting it as a win would invent 1,027 wins and counting it as a
 *                     loss would invent 1,027 losses. 2018 is almost entirely PENDING, which is why
 *                     2018 contributes winners only.
 *   - CANCELED     -- withdrawn before the run; bid is 0 by construction.
 *   - a claim with NO recoverable claimant -- a row with no team cannot carry a remaining-budget
 *                     feature. In practice there are none: see the next paragraph.
 *
 * THE CLAIMANT IS `to_team_id`, NOT `team_id`. On 2018's EXECUTED waivers ESPN publishes
 * `teamId = -2147483648` (Integer.MIN_VALUE, its null sentinel) on all 92 rows, and reading the
 * claimant off `team_id` silently DROPPED every 2018 winner -- the season came back 39 rows, all of
 * them rule-failures, and the table looked merely thin rather than wrong. The ADD item's
 * `toTeamId` is the acquiring team and is populated on every row; where `team_id` is real the two
 * agree on 702 of 702, so this is a fallback that has been checked against the column it replaces
 * rather than assumed to be equivalent.
 * Failures for RULE reasons (roster limit, acquisition limit, budget exceeded) are kept with
 * `won = NULL`: they were real bids, but they did not lose an auction, so they inform the price
 * distribution and must not inform P(win).
 *
 * POINT-IN-TIME. Every feature column is computed from state STRICTLY BEFORE this claim's own
 * waiver run -- and "before the run", not "before the row", because a waiver run processes an
 * entire batch at one timestamp and every bid in it was placed blind to the others. The remaining
 * budgets therefore step once per run, not once per claim. `ros_pts`/`ros_games` are the outcome
 * the claim bought and are targets; `competing_bids` is knowable only afterwards and is stored for
 * reporting, never as a feature. `scripts/faab-leakage.mjs` is the guard, and it fault-injects.
 */
import { nowIso, type DB } from "../../db/db.js";

/** ESPN's Integer.MIN_VALUE null sentinel, which appears as a team id on unresolved claims. */
export const NULL_TEAM = "-2147483648";
/** Statuses that mean "this claim was never processed", so it has no outcome to learn from. */
export const UNPROCESSED = new Set(["PENDING", "CANCELED"]);
/** The status ESPN returns for a claim that was OUTBID. The bid it carries is the losing amount. */
export const OUTBID = "FAILED_INVALIDPLAYERSOURCE";

export interface ClaimSeasonCoverage {
  season: number;
  claims: number;
  winners: number;
  losers: number;
  unscored: number;
  nonzeroBidPct: number;
  contestedPlayerWeeks: number;
  resolvedPct: number;
  withFeaturesPct: number;
  teams: number;
  budget: number;
}

export interface BuildFaabResult {
  rows: number;
  perSeason: ClaimSeasonCoverage[];
  losingBidsExist: boolean;
  losingBidSeasons: number[];
  /** Contested player-weeks where a loser out-bid the winner. MUST be 0; see the header. */
  orderViolations: number;
}

interface RawClaim {
  league_id: string; season: number; week: number; transaction_id: string; team_id: string;
  espn_player_id: string; bid_amount: number | null; status: string;
  executed_at: string | null; proposed_at_ms: number | null; to_team_id: string | null;
}

/** The team that made the claim. See the header: `team_id` is ESPN's null sentinel on every 2018
 *  EXECUTED waiver, and `to_team_id` on an ADD item is the acquiring team on all of them. */
export const claimantOf = (c: { team_id: string; to_team_id: string | null }): string | null => {
  const t = c.to_team_id && c.to_team_id !== NULL_TEAM && c.to_team_id !== "-1" ? c.to_team_id : c.team_id;
  return t && t !== NULL_TEAM && t !== "" ? t : null;
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** ESPN player id -> `player_sk`. `player_xref` covers real players; D/ST carry NEGATIVE ids that
 *  the cross-source id file has no row for, and the roster fact table is where their `DST:XX` key
 *  is already written. Both together resolve 100% of this league's waiver claims. */
export function espnToSk(db: DB): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.prepare(`SELECT source_id id, CAST(player_sk AS TEXT) sk FROM player_xref WHERE source='espn'`)
    .all() as { id: string; sk: string }[]) m.set(r.id, r.sk);
  for (const r of db.prepare(`SELECT DISTINCT espn_player_id id, player_sk sk FROM fact_roster_week WHERE espn_player_id IS NOT NULL`)
    .all() as { id: string; sk: string }[]) if (!m.has(r.id)) m.set(r.id, r.sk);
  return m;
}

/**
 * The league's FAAB budget per team per season.
 *
 * NOT a constant typed into the source. `fact_team_season.faab_spent` is ESPN's own
 * `acquisitionBudgetSpent` off the team card -- a DIFFERENT feed from the transaction log -- and a
 * league where somebody drains to zero puts its maximum exactly at the budget. Where no team ever
 * maxed out, the observed spend is a lower bound and the fallback applies; the read-back prints the
 * value so a season with a different budget is a visible row rather than a silent rescaling.
 */
export function budgetFor(db: DB, season: number, fallback = 100): number {
  const r = db.prepare(`SELECT MAX(faab_spent) mx FROM fact_team_season WHERE season = ?`).get(season) as { mx: number | null };
  const mx = r?.mx ?? 0;
  return mx >= fallback ? Math.round(mx) : fallback;
}

export function buildWaiverClaimsOn(db: DB, seasons?: number[]): BuildFaabResult {
  const sk = espnToSk(db);
  const all = db.prepare(
    `SELECT league_id, season, week, transaction_id, team_id, to_team_id, espn_player_id, bid_amount, status,
            executed_at, proposed_at_ms
       FROM raw_league_transaction
      WHERE type='WAIVER' AND item_type='ADD' AND status IS NOT NULL
      ORDER BY season, COALESCE(proposed_at_ms, 0), transaction_id`).all() as RawClaim[];

  const wanted = seasons ? new Set(seasons) : null;
  const claims = all.filter((c) =>
    (!wanted || wanted.has(c.season)) &&
    !UNPROCESSED.has(c.status) &&
    claimantOf(c) != null &&
    c.bid_amount != null);

  // ---- per-season scaffolding -------------------------------------------------------------------
  const seasonsPresent = [...new Set(claims.map((c) => c.season))].sort();
  const teamsOf = new Map<number, number>();
  const budgetOf = new Map<number, number>();
  for (const s of seasonsPresent) {
    const t = db.prepare(`SELECT COUNT(*) n FROM fact_team_season WHERE season = ?`).get(s) as { n: number };
    teamsOf.set(s, t.n || 12);
    budgetOf.set(s, budgetFor(db, s));
  }

  // Position ranks by the PRESEASON season line, per (season, week, pos). Preseason, so knowing it
  // in week 9 is not knowing anything about week 9.
  const rankOf = new Map<string, number>();
  const nameOf = new Map<string, { name: string | null; pos: string | null }>();
  {
    const rows = db.prepare(
      `SELECT season, week, pos, player_sk, name, season_line_pg
         FROM feat_player_week_model
        WHERE season IN (${seasonsPresent.join(",") || "-1"})`)
      .all() as { season: number; week: number; pos: string | null; player_sk: string | null; name: string | null; season_line_pg: number | null }[];
    const buckets = new Map<string, { sk: string; v: number }[]>();
    for (const r of rows) {
      if (!r.player_sk) continue;
      nameOf.set(`${r.season}|${r.player_sk}`, { name: r.name, pos: r.pos });
      if (r.season_line_pg == null || !r.pos) continue;
      const k = `${r.season}|${r.week}|${r.pos}`;
      const b = buckets.get(k) ?? [];
      b.push({ sk: r.player_sk, v: r.season_line_pg });
      buckets.set(k, b);
    }
    for (const [k, b] of buckets) {
      b.sort((a, c) => c.v - a.v);
      b.forEach((x, i) => rankOf.set(`${k}|${x.sk}`, i + 1));
    }
  }

  const featRow = db.prepare(
    `SELECT pos, name, season_line_pg, td_ppg, td_games, t4_mean, pts
       FROM feat_player_week_model WHERE season=? AND week=? AND player_sk=?`);
  const rosRow = db.prepare(
    `SELECT SUM(pts) p, COUNT(pts) g FROM feat_player_week_model WHERE season=? AND week>=? AND player_sk=? AND pts IS NOT NULL`);

  // teams carrying fewer at a position than the league median, read off the roster the week BEFORE.
  const needCache = new Map<string, { need: number; teams: number }>();
  const needAt = (season: number, week: number, pos: string | null): { need: number; teams: number } => {
    if (!pos) return { need: 0, teams: 0 };
    const w = Math.max(1, week - 1);
    const k = `${season}|${w}|${pos}`;
    const hit = needCache.get(k);
    if (hit) return hit;
    const rows = db.prepare(
      `SELECT team_id, SUM(CASE WHEN pos = ? THEN 1 ELSE 0 END) n
         FROM fact_roster_week WHERE season=? AND week=? GROUP BY team_id`)
      .all(pos, season, w) as { team_id: string; n: number }[];
    const med = median(rows.map((r) => r.n));
    const out = { need: rows.filter((r) => r.n < med).length, teams: rows.length };
    needCache.set(k, out);
    return out;
  };

  // competing_bids: OTHER processed claims on the same player-week. Reporting only.
  const contest = new Map<string, number>();
  for (const c of claims) contest.set(`${c.season}|${c.week}|${c.espn_player_id}`, (contest.get(`${c.season}|${c.week}|${c.espn_player_id}`) ?? 0) + 1);

  // ---- the walk: one waiver RUN at a time, budgets frozen for the whole batch --------------------
  const spentByTeam = new Map<string, number>();   // `${season}|${team}` -> EXECUTED dollars so far
  const spentBySeason = new Map<number, number>();
  const out: Record<string, unknown>[] = [];
  const built = nowIso();

  let i = 0;
  while (i < claims.length) {
    const head = claims[i];
    let j = i;
    while (j < claims.length && claims[j].season === head.season && claims[j].proposed_at_ms === head.proposed_at_ms) j++;
    const run = claims.slice(i, j);
    const budget = budgetOf.get(head.season) ?? 100;
    const teams = teamsOf.get(head.season) ?? 12;
    const leagueLeft = teams * budget - (spentBySeason.get(head.season) ?? 0);

    for (const c of run) {
      const team = claimantOf(c) as string;
      const key = sk.get(c.espn_player_id) ?? null;
      const f = key ? featRow.get(c.season, c.week, key) as
        { pos: string | null; name: string | null; season_line_pg: number | null; td_ppg: number | null; td_games: number | null; t4_mean: number | null; pts: number | null } | undefined
        : undefined;
      const prev = key && c.week > 1
        ? (featRow.get(c.season, c.week - 1, key) as { pts: number | null } | undefined)
        : undefined;
      const ros = key ? rosRow.get(c.season, c.week, key) as { p: number | null; g: number } : { p: null, g: 0 };
      const pos = f?.pos ?? nameOf.get(`${c.season}|${key}`)?.pos ?? null;
      const need = needAt(c.season, c.week, pos);
      const teamLeft = budget - (spentByTeam.get(`${c.season}|${team}`) ?? 0);
      out.push({
        season: c.season, week: c.week, transaction_id: c.transaction_id, team_id: team,
        espn_player_id: c.espn_player_id, player_sk: key,
        name: f?.name ?? nameOf.get(`${c.season}|${key}`)?.name ?? null, pos,
        bid_amount: c.bid_amount, status: c.status,
        won: c.status === "EXECUTED" ? 1 : c.status === OUTBID ? 0 : null,
        competing_bids: (contest.get(`${c.season}|${c.week}|${c.espn_player_id}`) ?? 1) - 1,
        executed_at: c.executed_at, proposed_at_ms: c.proposed_at_ms,
        season_line_pg: f?.season_line_pg ?? null,
        pos_line_rank: key && pos ? rankOf.get(`${c.season}|${c.week}|${pos}|${key}`) ?? null : null,
        td_ppg: f?.td_ppg ?? null, td_games: f?.td_games ?? null, t4_mean: f?.t4_mean ?? null,
        prior_pts: prev?.pts ?? null,
        team_faab_left: teamLeft, league_faab_left: leagueLeft,
        team_faab_share: teamLeft / budget, league_faab_share: leagueLeft / (teams * budget),
        teams_need_pos: need.need, teams_counted: need.teams, budget,
        ros_pts: ros.p ?? null, ros_games: ros.g ?? 0,
        built_at: built,
      });
    }
    // Only EXECUTED dollars leave a budget, and only AFTER the whole run is priced.
    for (const c of run) {
      if (c.status !== "EXECUTED") continue;
      const t = claimantOf(c) as string;
      spentByTeam.set(`${c.season}|${t}`, (spentByTeam.get(`${c.season}|${t}`) ?? 0) + (c.bid_amount ?? 0));
      spentBySeason.set(c.season, (spentBySeason.get(c.season) ?? 0) + (c.bid_amount ?? 0));
    }
    i = j;
  }

  const cols = [
    "season", "week", "transaction_id", "team_id", "espn_player_id", "player_sk", "name", "pos",
    "bid_amount", "status", "won", "competing_bids", "executed_at", "proposed_at_ms",
    "season_line_pg", "pos_line_rank", "td_ppg", "td_games", "t4_mean", "prior_pts",
    "team_faab_left", "league_faab_left", "team_faab_share", "league_faab_share",
    "teams_need_pos", "teams_counted", "budget", "ros_pts", "ros_games", "built_at",
  ];
  const ins = db.prepare(
    `INSERT INTO fact_waiver_claim (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})
     ON CONFLICT(season, transaction_id, espn_player_id) DO UPDATE SET
       ${cols.filter((c) => !["season", "transaction_id", "espn_player_id"].includes(c)).map((c) => `${c}=excluded.${c}`).join(", ")}`);
  db.transaction(() => { for (const r of out) ins.run(r); })();

  return { rows: out.length, ...coverage(db, seasonsPresent) };
}

/** Read the table back per season -- including the property that proves the failures are LOSING
 *  BIDS rather than some other refusal, which is the fact this whole track rests on. */
export function coverage(db: DB, seasons: number[]): Omit<BuildFaabResult, "rows"> & { perSeason: ClaimSeasonCoverage[] } {
  const perSeason: ClaimSeasonCoverage[] = [];
  for (const s of seasons) {
    const r = db.prepare(
      `SELECT COUNT(*) claims,
              SUM(won=1) winners, SUM(won=0) losers, SUM(won IS NULL) unscored,
              SUM(bid_amount > 0) nz,
              SUM(player_sk IS NOT NULL) resolved,
              SUM(season_line_pg IS NOT NULL OR td_ppg IS NOT NULL) feats,
              MAX(budget) budget
         FROM fact_waiver_claim WHERE season = ?`).get(s) as Record<string, number | null>;
    const contested = db.prepare(
      `SELECT COUNT(*) n FROM (SELECT season, week, espn_player_id FROM fact_waiver_claim
         WHERE season=? AND won IS NOT NULL GROUP BY 1,2,3 HAVING SUM(won=0) > 0 AND SUM(won=1) > 0)`).get(s) as { n: number };
    const teams = db.prepare(`SELECT MAX(teams_counted) n FROM fact_waiver_claim WHERE season=?`).get(s) as { n: number | null };
    const c = r.claims ?? 0;
    perSeason.push({
      season: s, claims: c, winners: r.winners ?? 0, losers: r.losers ?? 0, unscored: r.unscored ?? 0,
      nonzeroBidPct: c ? Math.round((1000 * (r.nz ?? 0)) / c) / 10 : 0,
      contestedPlayerWeeks: contested.n,
      resolvedPct: c ? Math.round((1000 * (r.resolved ?? 0)) / c) / 10 : 0,
      withFeaturesPct: c ? Math.round((1000 * (r.feats ?? 0)) / c) / 10 : 0,
      teams: teams.n ?? 0, budget: r.budget ?? 0,
    });
  }
  const viol = db.prepare(
    `SELECT COUNT(*) n FROM (
       SELECT season, week, espn_player_id, MAX(CASE WHEN won=1 THEN bid_amount END) wb,
              MAX(CASE WHEN won=0 THEN bid_amount END) lb
         FROM fact_waiver_claim WHERE won IS NOT NULL GROUP BY 1,2,3)
      WHERE wb IS NOT NULL AND lb IS NOT NULL AND lb > wb`).get() as { n: number };
  const losingSeasons = perSeason.filter((p) => p.losers > 0).map((p) => p.season);
  return {
    perSeason,
    losingBidsExist: losingSeasons.length > 0,
    losingBidSeasons: losingSeasons,
    orderViolations: viol.n,
  };
}
