/**
 * ONE definition of "the league, ready to simulate".
 *
 * WHY THIS EXISTS. Six scripts -- trade-odds, trade-check, waiver-check, positional-value,
 * sim-convergence, season-odds -- each rebuilt the same context by hand: load three fitted models,
 * read the board, group rosters by team, resolve byes, compute pool ranks, build a schedule, assemble
 * the options object. Fifty-odd lines, copy-pasted six times, and they had already drifted:
 *
 *   - only trade-odds had the offline fallback for when the app is unreachable
 *   - season-odds, waiver-check and trade-odds used the REAL schedule; positional-value,
 *     sim-convergence and trade-check silently used a GENERATED one
 *   - every one of them hardcoded `playoffTeams: 7` and `projSd: 0.30` while config holds the real
 *     values
 *
 * The consequence was not theoretical. The same roster returned a base title probability of 4.17%,
 * 4.56% and 5.1% depending on which tool asked, and those numbers were compared against each other
 * as though they measured the same thing. A shared context is not tidiness here; it is the only way
 * two tools can be talking about the same league.
 *
 * CONFIG IS THE SOURCE, not the caller. playoffTeams, regWeeks, slots and flex_ok come from the
 * store. A hardcoded 7 that happens to match today is the same defect as the hardcoded FLEX_OK found
 * in the lineup optimiser: correct by coincidence, and silently wrong the moment the league changes.
 */
import { readFileSync } from "node:fs";
import { loadWeekState } from "../inseason/weekState.js";
import Database from "better-sqlite3";
import { simulateSeasons, LEVEL_PRIOR_WEEKS, type SeasonTeamInput, type SeasonOdds, type VarianceModel } from "./season.js";
import { buildSchedule } from "./schedule.js";
import { nameKey, dstAliasKey } from "./values.js";
import { loadRosBlendFor, rosPerGame } from "./rosBlend.js";
import { dataPath } from "../data/paths.js";
import { loadEligibilityMap } from "../data/eligibility.js";

export interface SimContext {
  teams: SeasonTeamInput[];
  weeks: [number, number][][];
  meIdx: number;
  season: number;
  /** True when the schedule was generated because the real one was unreachable. */
  syntheticSchedule: boolean;
  /** Ready-made options; callers override only `trials` and `seed`. */
  opts: (trials: number, seed: number) => Parameters<typeof simulateSeasons>[3];
  /** `extra` overrides individual season options -- in practice only `playoffWeekStrength`, which
   *  costs three extra scored weeks per team per trial and is therefore asked for rather than always
   *  paid for. Everything else stays where it belongs: in the shared context. */
  run: (teams: SeasonTeamInput[], trials: number, seed: number, extra?: Partial<Parameters<typeof simulateSeasons>[3]>) => SeasonOdds[];
  /** Deep copy, so a caller can mutate a roster without touching the shared base. */
  clone: (t?: SeasonTeamInput[]) => SeasonTeamInput[];
  /** `eligible` is ESPN's own eligible-position SET, present only for a player who is startable at
   *  more than one of QB/RB/WR/TE. Absent means "[his own position]", which is every player on the
   *  2026 board -- so a consumer that ignores the field behaves exactly as it did. */
  board: Map<string, { name: string; pos: string; proj: number; team: string; eligible?: string[] }>;
  ownedIds: Set<string>;
  /** The league's starting template and FLEX eligibility, so a caller building a hypothetical roster
   *  can ask whether it is legal (rosterGaps) instead of finding out when the simulator refuses. */
  slots: string[];
  flexOk?: string[];
  /** Per-position ROSTER MAXIMUMS, from `ff sync-settings` (they are absent from the mSettings API).
   *  Undefined when that verb has never run -- and undefined must mean "unknown", never "unlimited",
   *  so `rosterOverfills` returns no problems rather than pretending the roster is legal. */
  posMax?: Record<string, number>;
  /** Per-position WEEKLY points freely available off waivers -- the streaming floor. */
  replacement: Record<string, number>;
  /** The league's calendar and playoff format, WITH its provenance. Consumers that need the playoff
   *  weeks or the field size read them here rather than re-deriving them from a literal. */
  format: import("../league/types.js").LeagueFormat;
  /** THE SEASON SO FAR (D18): how many weeks seeded the standings and from what, the week the
   *  simulation starts at, and the rest-of-season blend applied to rostered men. Carried so every
   *  consumer can PRINT it beside its number rather than leave a reader to guess whether a
   *  September odds figure knows it is October. */
  played: {
    weeks: number; nextWeek: number; source: string[]; rosBlendK: number;
    rosBlendSource: "fitted" | "absent"; rosApplied: number; today: string;
    /** Why `weeks` is 0 even though weeks HAVE been played, when that is the case. Null otherwise.
     *  Carried so a caveat can say "not seeded, and here is why" rather than reading like a league
     *  whose season has not started. */
    seedBlocked: string | null;
  };
  /**
   * WHAT THIS WEEK IS (2026-09-18): who cannot play, who is locked, what is already scored.
   *
   * Carried here for the same reason `played` above is -- so every consumer reads ONE assembled
   * answer instead of re-deriving it at its own call site -- and REQUIRED for a stronger reason:
   * while it was a per-verb optional it reached 2 of the 10 copilot verbs, and the eight that missed
   * it returned confident advice about men who could not play. See src/inseason/weekState.ts.
   *
   * A caller with no live week (a historical replay, a fold, a fixture) says so explicitly with
   * `emptyWeekState(season, week)`, which is greppable; omitting it is not expressible.
   */
  week: import("../inseason/weekState.js").WeekState;
}

/**
 * `schedule` decides where the weeks come from:
 *   "real"      fetch through the league adaptor; throws if unreachable
 *   "generated" always build one; deterministic and offline
 *   "auto"      real when reachable, generated otherwise, and SAYS WHICH
 *
 * "auto" is the default because a tool that silently swaps schedules produces numbers that cannot be
 * compared with each other -- which is exactly what happened. The flag is on the returned context so
 * a caller can print it rather than assume.
 */
/** Local calendar date, YYYY-MM-DD. A football game day is a local date; UTC would settle a Monday
 *  night game on the wrong day for anyone west of Greenwich. Same rule as the scorecard's. */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export async function loadSimContext(opts: {
  schedule?: "real" | "generated" | "auto";
  /** YYYY-MM-DD; defaults to today. A backtest or a test passes the day it is asking about. */
  today?: string;
  /** WHICH LEAGUE. Omitted = the ACTIVE league. Everything below -- the config, the ownership rows,
   *  the live schedule read -- comes from this one id, rather than from three different queries. */
  leagueId?: string | null;
  /** WHICH STORE. Omitted = data/ff.db. `ff --db <path>` threads its path here so a
   *  counterfactual copy of the store (a trade reversed, a roster edited) is what gets simulated;
   *  before 2026-09-17 the flag reached the provenance loaders but this context always opened the
   *  live store, and a `--db` run answered from the live rosters while saying nothing. */
  dbPath?: string;
} = {}): Promise<SimContext> {
  const want = opts.schedule ?? "auto";

  const db = new Database(opts.dbPath ?? dataPath("ff.db"), { readonly: true });
  // ONE RESOLVER, ONE CONFIG. This read the legacy `config` mirror (whichever league was active last)
  // and then picked its league row with an UNORDERED `.get()` over `season=? AND team_id IS NOT NULL`
  // -- an arbitrary row once a second league exists. Both now come from the same context.
  const { resolveLeagueContext, requireTeamId } = await import("../data/leagueContext.js");
  const ctx = resolveLeagueContext(db as unknown as import("../db/db.js").DB, opts.leagueId);
  const cfg = ctx.config;
  const lgRow = { league_id: ctx.leagueId as string, team_id: requireTeamId(ctx, "loadSimContext") };

  const byeOf = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT p.name, r.bye FROM player p JOIN ranking r ON r.player_id=p.player_id AND r.source='fantasypros_ecr' AND r.season=?",
  ).all(cfg.season) as { name: string; bye: number }[]) byeOf.set(nameKey(r.name), r.bye);

  // ESPN's eligibility, read from the STAGED table rather than re-derived from the board's Eligible
  // string: the board column is a display of this, and two readings of one fact is how they drift.
  const eligByKey = loadEligibilityMap(db, cfg.season);
  // S-8: the board is single-slot and stamped. A simulation run on another league's dollars would
  // produce a confident, wrong title probability with nothing anywhere saying which league's values
  // it priced -- so this refuses by name instead.
  const { assertBoardFor } = await import("../db/db.js");
  assertBoardFor(db as unknown as import("../db/db.js").DB, ctx.leagueId, "loadSimContext");
  // I-1 (artifact side, WP3). The three fitted models below and the pool-rank pool further down were
  // read from `dataPath(...)` -- i.e. the incumbent ESPN format -- for whatever league this context
  // was for. A superflex league seeded with half-PPR variance, half-PPR rank-outcome pools and a
  // half-PPR projection pool produces a confident title probability about a league that does not
  // exist. They come from the league's OWN format now, and an unbuilt format REFUSES by name.
  const { resolveFormat } = await import("../data/formatResolve.js");
  const fmt = resolveFormat(db as unknown as import("../db/db.js").DB, ctx.leagueId);
  const vm = JSON.parse(readFileSync(fmt.model.require("variance"), "utf8")) as VarianceModel;
  const outcomes = JSON.parse(readFileSync(fmt.model.require("rank-outcomes"), "utf8"));
  const corr = JSON.parse(readFileSync(fmt.model.require("correlation"), "utf8"));
  const board = new Map<string, { name: string; pos: string; proj: number; team: string; eligible?: string[] }>();
  for (const r of db.prepare("SELECT player_id, row_json FROM board WHERE season=?").all(cfg.season) as { player_id: string; row_json: string }[]) {
    const j = JSON.parse(r.row_json) as Record<string, unknown>;
    const eligible = eligByKey.get(r.player_id);
    board.set(r.player_id, { name: String(j.Player), pos: String(j.Pos), proj: Number(j.ProjPts) || 0, team: String(j.Team ?? ""), ...(eligible ? { eligible } : {}) });
  }
  const ownedIds = new Set<string>();
  const byTeam = new Map<string, SeasonTeamInput>();
  const unmatched: string[] = [];
  // `slot` is carried so a surface that must know WHERE a man currently sits can ask -- the lineup
  // serve needs it to honour a kickoff lock (src/inseason/kickoffLock.ts): a locked man holds the
  // slot he is in, and "which slot" is a fact about the league roster, not about the board.
  for (const r of db.prepare("SELECT player_id, team_id, team_abbrev, owner, slot FROM ownership WHERE league_id=?").all(lgRow.league_id) as { player_id: string; team_id: string; team_abbrev: string; owner: string; slot: string | null }[]) {
    ownedIds.add(r.player_id);
    // ESPN keys defenses by NICKNAME ("packers"); the board keys them by ABBREVIATION ("gb"). The
    // alias table for exactly this has existed in values.ts since the draft-room lookup needed it,
    // and was simply never applied here -- so every one of the sixteen rosters silently lost its
    // defense, and every title probability this tool has ever produced was computed with all sixteen
    // teams fielding an empty DST slot.
    const alias = dstAliasKey(r.player_id);
    const b = board.get(r.player_id) ?? (alias ? board.get(alias) : undefined);
    if (!b) { unmatched.push(r.player_id); continue; }
    if (alias) ownedIds.add(alias);
    if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, { id: r.team_id, name: r.team_abbrev || r.owner, roster: [] });
    byTeam.get(r.team_id)!.roster.push({ ...b, bye: byeOf.get(nameKey(b.name)) ?? null, slot: r.slot ?? null, playerId: r.player_id });
  }
  // A roster row that matches nothing used to be skipped in silence, which is why the defect above
  // survived: an incomplete roster and a correct one produce the same output, and the simulator
  // happily fields an empty slot rather than complaining. Anything unmatched is now reported.
  if (unmatched.length) {
    console.warn(`WARNING: ${unmatched.length} rostered players matched no board row and were dropped from the simulation: ${unmatched.slice(0, 12).join(", ")}${unmatched.length > 12 ? " ..." : ""}`);
  }
  // The structural consequence -- a roster that cannot fill the lineup -- is NOT checked here. It is
  // enforced in simulateSeasons, which every path reaches and this one does not: six scripts build
  // their teams without ever calling loadSimContext. Checking it in both places would mean two
  // sources of truth for the same rule, and the weaker one warns where the other refuses.
  const teams = [...byTeam.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const meIdx = teams.findIndex((t) => t.id === String(lgRow.team_id));

  // Pool ranks from the FULL projection pool: the variance model's tiers are fractions of that, and
  // ranking within rostered players instead maps a 16-team league's WR4 onto the historical
  // "barely plays" tier. This subtlety is exactly the kind that a copy-pasted context gets wrong in
  // one place and right in five.
  const poolRank = new Map<string, { rank: number; of: number }>();
  {
    const byPos: Record<string, { name: string; pts: number }[]> = {};
    for (const line of readFileSync(fmt.model.require("points"), "utf8").trim().split(/\r?\n/).slice(1)) {
      const f = line.split(",");
      if (!f[0] || !f[2]) continue;
      (byPos[f[1].trim().toUpperCase()] ??= []).push({ name: f[0].trim(), pts: Number(f[2]) });
    }
    for (const l of Object.values(byPos)) { l.sort((a, b) => b.pts - a.pts); l.forEach((x, i) => poolRank.set(x.name, { rank: i, of: l.length })); }
  }
  // THE STORED SCHEDULE, read while the handle is open, for the fallback below. `ff league-sync`
  // writes this league's matchups here; the ids are the same ESPN team ids `ownership` keys on.
  const storedMatchups = db.prepare(
    "SELECT week, home_id, away_id, fetched_at FROM raw_league_matchup WHERE season=? AND league_id=? ORDER BY week",
  ).all(cfg.season, lgRow.league_id) as { week: number; home_id: string; away_id: string; fetched_at: string }[];

  // =============================================================================================
  // THE SEASON SO FAR (D18, 2026-09-14). Read here, while the handle is open; applied below.
  //
  // A week is SETTLED when its last NFL game day is strictly before today AND the store holds scored
  // rows for it -- a week in the past with an unsynced actuals file is missing data, not a week of
  // zeros. A week with one game still to play is NOT settled: a team's score is not a score until
  // its last starter has played, so the Monday-night week stays "unplayed" until Tuesday.
  // =============================================================================================
  const today = opts.today ?? localIso(new Date());
  const settled: number[] = [];
  for (const r of db.prepare(
    "SELECT g.week, MAX(g.gameday) last FROM raw_nfl_game g WHERE g.season=? AND g.game_type='REG' AND g.gameday IS NOT NULL GROUP BY g.week ORDER BY g.week",
  ).all(cfg.season) as { week: number; last: string }[]) {
    if (!(r.last < today)) break;
    const scored = (db.prepare("SELECT COUNT(*) c FROM feat_player_week WHERE season=? AND week=? AND pts IS NOT NULL").get(cfg.season, r.week) as { c: number }).c;
    if (!scored) break;                        // contiguous from week 1: a gap means unsynced data
    settled.push(r.week);
  }
  // A SETTLED WEEK WITH NO ROSTER SNAPSHOT IS NOT A SEEDABLE WEEK (WP7).
  //
  // The seed below scores each team's week from `raw_league_roster_week` -- the STARTED lineup, per
  // team, per week. That table is written by the ESPN roster-week ingester and exists for 462233
  // only; the Yahoo league's weekly starters are not read by anything in this repo. With no rows the
  // loop below scores every team 0, every matchup ties, the tie goes to the home side, and the
  // simulator is handed a fabricated set of standings that looks exactly like a real one. So a league
  // with no snapshot for the settled weeks is seeded from NOTHING and says so -- a full-season
  // simulation from preseason lines, which is a worse answer than seeding but an honest one.
  const snapshotWeeks = settled.length
    ? (db.prepare(
      "SELECT COUNT(DISTINCT week) c FROM raw_league_roster_week WHERE league_id=? AND season=? AND week<=? AND is_starter=1",
    ).get(lgRow.league_id, cfg.season, settled[settled.length - 1]) as { c: number }).c
    : 0;
  const seedBlocked = settled.length > 0 && snapshotWeeks === 0
    ? `league ${lgRow.league_id} has ${settled.length} settled week(s) but NO started-lineup rows in raw_league_roster_week, ` +
      "so the standings cannot be seeded from what actually happened -- simulating the full season from preseason lines instead"
    : null;
  if (seedBlocked) { settled.length = 0; console.warn(`season so far: NOT SEEDED -- ${seedBlocked}`); }
  const playedWeeks = settled.length;
  const nextWeek = playedWeeks + 1;
  // Team scores for the settled weeks: the STARTED lineup ESPN applied, from the roster snapshot,
  // scored by ESPN's applied points where the snapshot was taken after the games, else by the store's
  // synced actuals for the same men (the snapshot was taken before kickoff and still holds the
  // lineup as then set -- a change made Sunday morning is invisible to it, and the build says so).
  const teamIds = [...byTeam.keys()];
  const weekScore = new Map<string, number>();     // `${week}|${teamId}` -> started points
  const seedSource: string[] = [];
  if (playedWeeks > 0) {
    const actualByName = new Map<string, number>();
    for (const r of db.prepare(
      "SELECT week, name, pos, pts FROM feat_player_week WHERE season=? AND week<=? AND pts IS NOT NULL",
    ).all(cfg.season, playedWeeks) as { week: number; name: string; pos: string; pts: number }[]) {
      actualByName.set(`${r.week}|${nameKey(r.name)}|${r.pos}`, r.pts);
    }
    for (const w of settled) {
      const starters = db.prepare(
        "SELECT team_id, espn_player_id, name, position, applied_points FROM raw_league_roster_week WHERE league_id=? AND season=? AND week=? AND is_starter=1",
      ).all(lgRow.league_id, cfg.season, w) as { team_id: string; espn_player_id: string; name: string; position: string; applied_points: number | null }[];
      const applied = starters.filter((s) => s.applied_points != null && s.applied_points !== 0).length;
      const useApplied = applied >= starters.length / 2;
      const missing: string[] = [];
      for (const s of starters) {
        let v: number | null = useApplied ? (s.applied_points ?? 0) : null;
        if (v == null) {
          const pos = s.position === "D/ST" ? "DST" : s.position;
          // ESPN spells a defense "Bears D/ST"; the feature table says "CHI DST". Same alias the
          // calibration harness uses, keyed on the NICKNAME, not on the numeric id.
          const alias = pos === "DST" ? dstAliasKey(s.name.replace(/\s*D\/?ST\s*$/i, "").trim()) : null;
          v = actualByName.get(`${w}|${nameKey(s.name)}|${pos}`) ?? (alias ? actualByName.get(`${w}|${nameKey(`${alias} DST`)}|DST`) : undefined) ?? null;
          if (v == null) { missing.push(`${s.name} (${pos})`); v = 0; }
        }
        const k = `${w}|${s.team_id}`;
        weekScore.set(k, (weekScore.get(k) ?? 0) + v);
      }
      // The unmatched are NAMED, because two very different things land here: a man whose game is
      // not synced yet (a data gap, fix by syncing) and a name the two tables spell differently (a
      // join gap, fix in code). A count cannot tell them apart; a list can.
      // The platform's own applied points, named by platform: this caveat read "ESPN applied points"
      // for the Yahoo league too (WP9, 2026-09-16), and a caveat that names the wrong platform is a
      // caveat nobody can trust.
      seedSource.push(`wk${w}: ${useApplied ? `${ctx.platformRaw ?? ctx.platform ?? "the platform's"} applied points` : "synced actuals for the snapshotted lineup"}` +
        (missing.length ? ` (${missing.length} starters unmatched, scored 0: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""})` : ""));
    }
  }
  const playedWins = new Map<string, number>(teamIds.map((t) => [t, 0]));
  const playedPts = new Map<string, number>(teamIds.map((t) => [t, 0]));
  for (const w of settled) {
    for (const t of teamIds) playedPts.set(t, (playedPts.get(t) ?? 0) + (weekScore.get(`${w}|${t}`) ?? 0));
    for (const m of storedMatchups.filter((x) => x.week === w)) {
      const h = String(m.home_id), a = String(m.away_id);
      if (!playedWins.has(h) || !playedWins.has(a)) continue;
      const hs = weekScore.get(`${w}|${h}`) ?? 0, as = weekScore.get(`${w}|${a}`) ?? 0;
      if (hs >= as) playedWins.set(h, playedWins.get(h)! + 1); else playedWins.set(a, playedWins.get(a)! + 1);
    }
  }
  // REST-OF-SEASON LINE per rostered man: the preseason per-week line updated on the SETTLED weeks,
  // by the fitted weight (src/draft/rosBlend.ts), IN THE FRAME IT WAS FITTED IN: k = the settled
  // non-bye weeks, rate = his points over those weeks with a missed game counted as zero -- the same
  // per-scheduled-week frame `proj / 17` is in. (Not the data track's to-date columns, which are per
  // game played and on a different scale; that mismatch is what the first fit of K measured.)
  // K is PER FORMAT (WP8): it minimises RMSE in points on a format's own lines (ESPN 6, Yahoo 5), so
  // the live caveat must quote the format's fit, not the incumbent's.
  const { blend: rosBlend, source: rosSource } = loadRosBlendFor(fmt.model);
  const rateByName = new Map<string, { k: number; pts: number }>();
  if (playedWeeks > 0) {
    for (const r of db.prepare(
      "SELECT name, pos, week, pts, is_bye FROM feat_player_week WHERE season=? AND week<=?",
    ).all(cfg.season, playedWeeks) as { name: string; pos: string; week: number; pts: number | null; is_bye: number | null }[]) {
      if (r.is_bye) continue;
      const key = `${nameKey(r.name)}|${r.pos}`;
      const cur = rateByName.get(key) ?? rateByName.set(key, { k: 0, pts: 0 }).get(key)!;
      cur.k++; cur.pts += r.pts ?? 0;
    }
  }
  let rosApplied = 0;
  for (const tm of byTeam.values()) {
    for (const p of tm.roster) {
      const td = rateByName.get(`${nameKey(p.name)}|${p.pos}`);
      if (!td || td.k <= 0 || rosBlend.K === Infinity) continue;
      const ros = rosPerGame(p.proj / 17, td.k, td.pts, rosBlend.K);
      if (ros != null) { p.rosPerGame = ros; rosApplied++; }
    }
  }
  // THE WEEK'S STATE, read BEFORE the handle closes. It is assembled here rather than lazily on the
  // returned object because a context that reads the store after `db.close()` is a context that
  // works in a test and throws in the CLI -- which is exactly what the first version of this did.
  const week = loadWeekState(db, { season: cfg.season, week: nextWeek, leagueId: lgRow.league_id });
  db.close();

  // THE FORMAT, from the block that has a source. `cfg.regWeeks ?? 14` used to live here, alongside
  // `playoffTeams ?? 7` below, and the file's own header already called that out as "correct by
  // coincidence" -- the coincidence just had no way to stop being one until the block existed.
  const { effectiveFormat } = await import("../league/index.js");
  const format = effectiveFormat(cfg);
  const regWeeks = format.regWeeks;
  let weeks: [number, number][][] = [];
  let syntheticSchedule = true;
  /** team index -> division index, in the order `teams` is built (ascending team id). Only the
   *  GENERATED schedule can supply this; the real one is read back below from the format block. */
  let divisionOf: number[] | undefined;
  if (want !== "generated") {
    let liveErr: Error | null = null;
    try {
      // A TIMEOUT, BECAUSE "auto" MUST NOT BE ABLE TO BLOCK (I-8). This read opens the league over the
      // app's CDP port; with the app RUNNING but its ESPN page slow to answer, the whole call used to
      // sit there -- `test/roster-completeness.test.ts` measured 533 s of wall clock for 1.25 s of CPU,
      // and the unit suite simply hung. "auto" already means "real when reachable, generated
      // otherwise", and a read that never returns is not reachable. The handle is closed on the
      // timeout path too, or the CDP connection keeps the process alive after the answer is in.
      const budgetMs = Number(process.env.FF_LIVE_READ_TIMEOUT_MS ?? 15000);
      const { openLeague } = await import("../league/index.js");
      const live = (async () => {
        const lg = await openLeague({ leagueId: ctx.leagueId });
        try {
          const sched = lg.provider.matchups ? await lg.provider.matchups() : null;
          const idx = new Map(lg.teams.map((t, i) => [t.id, i]));
          return { sched, idx };
        } finally { await lg.close().catch(() => {}); }
      })();
      // Attached IMMEDIATELY, not after the race: the loser of a race still rejects, and a rejection
      // with no handler at that moment is an unhandled-rejection crash in the test runner.
      live.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { sched, idx } = await Promise.race([
        live,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`live league read exceeded ${budgetMs}ms (FF_LIVE_READ_TIMEOUT_MS)`)), budgetMs);
          // Do not let the timer itself hold the event loop open once the race is decided.
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (sched) {
        for (let w = 1; w <= regWeeks; w++) {
          const g = sched.games.filter((x) => x.week === w)
            .map((x) => [idx.get(x.homeId), idx.get(x.awayId)] as [number, number])
            .filter(([a, b]) => a != null && b != null);
          if (g.length) weeks.push(g);
        }
        if (weeks.length) syntheticSchedule = false;
      }
    } catch (e) {
      liveErr = e as Error;
    }
    // THE STORED FALLBACK (2026-09-14). The live read goes through the app's embedded ESPN page over
    // its CDP port, and an app instance that did not get the port at launch (another instance had it)
    // runs fine with no CDP at all -- so "real schedule unavailable" was reporting a transport
    // problem as a data problem while the league's actual matchups sat in the store from the last
    // sync. This league's schedule does not change mid-season; the synced copy IS the real one.
    // Which source served is printed, because a REAL label that could mean two things is a label.
    if (!weeks.length && storedMatchups.length) {
      const idx = new Map(teams.map((t, i) => [String(t.id), i]));
      for (let w = 1; w <= regWeeks; w++) {
        const g = storedMatchups.filter((x) => x.week === w)
          .map((x) => [idx.get(String(x.home_id)), idx.get(String(x.away_id))] as [number, number])
          .filter(([a, b]) => a != null && b != null);
        if (g.length) weeks.push(g);
      }
      if (weeks.length) {
        syntheticSchedule = false;
        console.warn(`schedule: REAL, from the store's synced matchups (${storedMatchups.length} games, synced ${storedMatchups[0].fetched_at})` +
          (liveErr ? ` -- the live read failed: ${liveErr.message.split("\n")[0]}` : " -- the live read returned nothing"));
      }
    }
    if (!weeks.length && want === "real") {
      throw new Error(`real schedule unavailable: ${liveErr?.message ?? "the provider returned no games"}; and the store holds no synced matchups for this league-season (run ff league-sync)`, { cause: liveErr ?? undefined });
    }
  }
  if (!weeks.length) {
    const built = buildSchedule(teams.length, regWeeks, Math.max(1, format.divisions.length));
    weeks = built.weeks as [number, number][][];
    divisionOf = built.divisional ? built.divisionOf : undefined;
    syntheticSchedule = true;
  }
  // REAL schedule: divisions come from the format block, matched by ESPN team id. A team the block
  // does not place is NOT silently dropped into division 0 -- that would hand it a division to win.
  if (!syntheticSchedule && format.divisions.length > 1) {
    const dOf = new Map<string, number>();
    format.divisions.forEach((d, i) => d.teamIds.forEach((id) => dOf.set(String(id), i)));
    const mapped = teams.map((t) => dOf.get(String(t.id)));
    if (mapped.every((d) => d != null)) divisionOf = mapped as number[];
    else console.warn(`WARNING: ${mapped.filter((d) => d == null).length} team(s) are in no division in the format block -- seeding falls back to record.`);
  }

  /**
   * STREAMING FLOOR, measured from the actual free-agent pool rather than assumed.
   *
   * QB, K and DST are streamable in every real league: if your starter is on bye you add whoever is
   * free that week, and at those positions the free option is close to the rostered one. The
   * simulator scored an unfillable slot as ZERO, which is a penalty nobody actually pays and which
   * falls entirely on rosters carrying one body at a mandatory slot -- ours carries one QB, one K,
   * one DST and one RB, so it was taking four guaranteed zeroes a season that would never happen.
   *
   * NOT the best free agent: fifteen other managers stream too, and the top man is gone by the time
   * most of them look. The SECOND-best available is a deliberately modest stand-in for that
   * competition. It is a judgement call, so it is stated here rather than buried, and the resolved
   * values are printed by `ff models`.
   *
   * THE WEEK FRAME IS `NFL_WEEKS`, NOT `regWeeks` (D25, 2026-09-16). This divided a season projection
   * by the LEAGUE's regular season (13 here) while every consumer compares the result against a
   * `proj / 17` quantity: `season.ts:503` prices every rostered man at `rosPerGame ?? proj / 17`, and
   * `emptySlotPoints` puts this floor straight beside those numbers. The floor was therefore high by
   * 17/regWeeks -- 1.3077x for ESPN 462233 -- which made a slot nobody can fill worth MORE than it is
   * and systematically flattened the cost of thin depth (every empty-slot week, every bye the bench
   * cannot cover, every `assertRostersCanFillLineup` shortfall). A season projection is a 17-game
   * total; spreading it over the league's 13-week regular season is the wrong arithmetic regardless
   * of which quantity it is compared against, so the fix is here, at the producer, and there is now
   * exactly ONE frame in the in-season stack. `src/draft/sim.ts:291` already used `/ NFL_WEEKS`; this
   * was the odd one out. Arbiter: scripts/season-calibration.mjs (D18's four arms) -- see D25.
   */
  const REPLACEMENT_INDEX = 1;
  /** The frame a SEASON PROJECTION is in -- 17 scheduled NFL games. Deliberately NOT `regWeeks`; see
   *  above. Kept as a local literal because `src/inseason/copilot.ts` (which exports `NFL_WEEKS`)
   *  imports this module, and the cycle would be a startup failure rather than a wrong number. */
  const NFL_WEEKS = 17;
  const replacement: Record<string, number> = {};
  {
    const freeByPos: Record<string, number[]> = {};
    for (const [id, p] of board) {
      if (ownedIds.has(id)) continue;
      (freeByPos[p.pos] ??= []).push(p.proj);
    }
    for (const [pos, list] of Object.entries(freeByPos)) {
      list.sort((a, b) => b - a);
      const seasonPts = list[Math.min(REPLACEMENT_INDEX, list.length - 1)] ?? 0;
      // Season projection -> per SCHEDULED NFL WEEK. A streamed player is started for one week, not a
      // season -- and the number he is compared against is `proj / 17`, so this divides by 17 too.
      replacement[pos] = Math.max(0, seasonPts / NFL_WEEKS);
    }
  }

  // The seeded standings, in `teams` order (ascending team id -- the same order the schedule's
  // indices refer to). Empty when no week is settled, which is byte-identical to the old simulator.
  const played = playedWeeks > 0
    ? {
      weeks: playedWeeks, wins: teams.map((t) => playedWins.get(t.id) ?? 0), pts: teams.map((t) => playedPts.get(t.id) ?? 0),
      // THE LEVEL'S OWN PRIOR WEIGHT (D28, 2026-09-16). This used to be `rosBlend.K` -- the weight
      // the rest-of-season MEAN blend was fitted to -- and it is now `LEVEL_PRIOR_WEEKS` (= 1),
      // measured for the SPREAD it actually governs (src/draft/season.ts carries the numbers). Two
      // consequences worth naming: the weight no longer varies by format (the MEAN blend's K still
      // does, and still updates the lines above), and it no longer depends on a ros-blend fit
      // EXISTING -- a format with no fitted K used to get no level shrink at all, which was an
      // accident of borrowing rather than a decision about uncertainty.
      priorWeeks: LEVEL_PRIOR_WEEKS,
    }
    : undefined;
  if (playedWeeks > 0) {
    console.warn(`season so far: ${playedWeeks} settled week(s) seed the standings (${seedSource.join("; ")}); ` +
      `rest-of-season lines blend K=${rosBlend.K === Infinity ? "Infinity (line only)" : rosBlend.K} (${rosSource}) on ${rosApplied} rostered men with games played`);
  }

  const mkOpts = (trials: number, seed: number) => ({
    weeks: weeks.length,
    played,
    playoffTeams: format.playoffTeams,       // FROM THE FORMAT BLOCK -- a hardcoded 7 was right by coincidence
    seeding: format.seeding,
    // ESPN's own bracket rule and its own bracket LENGTH. Both were constants before: the simulator
    // always reseeded, and always ran three playoff weeks. Both were right for this league and
    // neither had ever been read.
    playoffReseed: format.playoffReseed,
    playoffWeekCount: format.playoffWeeks.length,
    divisionOf,
    slots: cfg.slots,
    // The league's own FLEX eligibility, which was being dropped here. optimalLineup defaults to
    // RB/WR/TE, which happens to be right for this league and would be silently wrong for a
    // superflex one -- a config value the code ignores reads as configured behaviour.
    flexOk: cfg.flex_ok,
    projSd: 0.30,
    replacement,
    trials, seed, poolRank,
    bootstrap: { outcomes, corr, calibration: "scale" as const },
  });
  return {
    teams, weeks, meIdx, season: cfg.season, syntheticSchedule, board, ownedIds, format,
    slots: cfg.slots as string[], flexOk: cfg.flex_ok as string[] | undefined, replacement,
    posMax: (cfg as { posMax?: Record<string, number> }).posMax,
    played: { weeks: playedWeeks, nextWeek, source: seedSource, rosBlendK: rosBlend.K, rosBlendSource: rosSource, rosApplied, today, seedBlocked },
    // ASSEMBLED ONCE, above. Every verb reads `ctx.week` rather than loading availability, locks and
    // settled points for itself -- the per-call-site loading is what left eight of ten verbs without
    // any of it. The week is `nextWeek`: the one a decision taken now is about.
    week,
    opts: mkOpts,
    run: (t, trials, seed, extra) => simulateSeasons(t, weeks, vm, { ...mkOpts(trials, seed), ...extra }),
    clone: (t) => (t ?? teams).map((x) => ({ ...x, roster: x.roster.map((p) => ({ ...p })) })),
  };
}
