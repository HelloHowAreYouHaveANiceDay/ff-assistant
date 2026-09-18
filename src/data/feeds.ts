/**
 * WHAT THIS STORE HOLDS, HOW OLD IT IS, AND WHAT TO RUN WHEN IT IS TOO OLD.
 *
 * Commit 2 of docs/week-state-design-2026-09-18.md.
 *
 * WHY. Across the ten copilot verbs, feed freshness reached ZERO of them. Not "reached some" -- none.
 * A verb read whatever the store held and reported a confident number, and a store whose ESPN cache
 * had been frozen for nine days produced output indistinguishable from a store synced a minute ago.
 * That is how a waiver verb came to recommend bidding on a man who had been dropped two days
 * earlier, and how a lineup came to be built from a roster that predated a trade.
 *
 * The staleness was never hidden. It was simply never asked for: every feed stamps its rows, and
 * nothing read the stamps.
 *
 * THE REGISTRY IS THE POINT, not the individual numbers. One table maps feed -> where it lives, how
 * to date it, how old is too old, and the exact command that refreshes it. `ff doctor` reads it, the
 * serve's caveat reads it, and a new feed is added in one place rather than in each consumer -- which
 * is the coverage-by-enumeration rot this repo has paid for three times already.
 *
 * DEGRADE AND SAY SO, decided by the owner on 2026-09-18. A stale feed does not refuse: nflverse's
 * injury file lags by days and the tool has to stay usable. It prints, by name, with the command.
 *
 * AND IT IS SILENT WHEN EVERYTHING IS FRESH. A caveat that appears on every run stops being read,
 * which would leave us exactly where we started with extra noise. Only stale feeds are named.
 */
import type { DB } from "../db/db.js";

export type FeedVerdict = "fresh" | "stale" | "absent" | "unknown";

export interface FeedSpec {
  id: string;
  /** The table whose rows date this feed. */
  table: string;
  /** The column holding the stamp, and whether it is an ISO instant or a plain date. */
  asOfColumn: string;
  /**
   * How old the NEWEST row may be, in hours, during the season. A feed past this is reported, not
   * refused. The numbers are chosen from how often the source itself changes, and each says why --
   * a threshold nobody can justify is a threshold that gets raised the first time it fires.
   */
  maxAgeHours: number;
  /** What breaks when it is stale -- so a reader knows whether to care about THIS number. */
  powers: string;
  /** The exact command that refreshes it. Copy-pasteable; no "re-run the sync". */
  refresh: string;
  /**
   * WHY this feed's refresh command cannot be checked against an asset's declared `writes:` list.
   *
   * `test/feed-registry.test.ts` asserts that every `ingest-source X` / `ingest-raw X` named here is
   * an asset that actually declares the feed's table -- the check that caught `player-status`
   * pointing at a command which did not refresh it. An exemption must therefore carry a REASON, per
   * item, so a blanket suppression cannot creep in: this repo has a recorded incident of a
   * baseline that muted a whole subject rather than one check.
   */
  refreshNotDeclared?: string;
}

/**
 * THE FEEDS THE IN-SEASON SURFACES ACTUALLY DEPEND ON.
 *
 * Deliberately not every table in the store. A registry that listed all ninety would be a thing
 * nobody reads, and the point is a short list a reader can hold in their head while looking at a
 * recommendation.
 */
export const FEEDS: FeedSpec[] = [
  {
    id: "gameday-status",
    table: "raw_gameday_status",
    asOfColumn: "fetched_at",
    // ESPN republishes designations through the week and the ~90-minute inactive list on game day.
    // A day old is already past at least one publication.
    maxAgeHours: 24,
    powers: "who can play -- the lineup, the waiver pool and the trade finder all exclude OUT men",
    refresh: "npm run ff -- ingest-raw gameday-status",
  },
  {
    id: "ownership",
    table: "ownership",
    asOfColumn: "updated_at",
    // Rosters change on any add, drop or trade -- several times a week in an active league.
    maxAgeHours: 24,
    powers: "who is on which roster, and every lineup slot",
    refresh: "npm run ff -- sync-rosters",
  },
  {
    id: "player-status",
    table: "player_status",
    asOfColumn: "updated_at",
    maxAgeHours: 48,
    powers: "the structured injury designation, which ESCALATES into availability",
    // `ingest-source status`, NOT `news`. The first version of this registry said `news`, and running
    // it left the feed exactly as stale -- caught by running the command the registry printed and
    // watching the feed not move. A registry whose refresh command does not refresh is worse than no
    // registry: it converts a visible staleness into a believed fix. `player_status` is written by
    // the `status` asset (Sleeper), declared at src/data/ingest.ts as writing
    // ["player_status", "trending"].
    refresh: "npm run ff -- ingest-source status",
  },
  {
    id: "news",
    table: "news",
    asOfColumn: "asof",
    // The feed publishes only its latest scrape; a missed day cannot be backfilled.
    maxAgeHours: 24,
    powers: "high-severity injury headlines, which can rule a man OUT before his status refreshes",
    refresh: "npm run ff -- ingest-source news",
  },
  {
    id: "league-rosters",
    table: "raw_league_roster_week",
    asOfColumn: "fetched_at",
    maxAgeHours: 24,
    powers: "started lineups, applied points, and the settled-week seed",
    refresh: "npm run ff -- ingest-raw league-rosters",
  },
  {
    id: "transactions",
    table: "raw_league_transaction",
    asOfColumn: "fetched_at",
    maxAgeHours: 24,
    powers: "the add/drop/waiver/trade log, and the FAAB bid history",
    refresh: "npm run ff -- ingest-raw league-transactions",
  },
  {
    id: "nfl-schedule",
    table: "raw_nfl_game",
    asOfColumn: "fetched_at",
    // Kickoff times move rarely, and results land well after the game -- but the kickoff LOCK and
    // the settled-week rule both read this table, so a badly stale one mis-times both.
    maxAgeHours: 72,
    powers: "kickoff locks, the settled-week rule, and which week it is",
    refresh: "npm run ff -- ingest-raw nfl-games",
  },
  {
    id: "injuries",
    table: "raw_injury",
    asOfColumn: "fetched_at",
    // nflverse lags -- on 2026-09-18 its 2026 file covered four teams. The threshold is generous
    // BECAUSE of that, and the gameday feed above is what carries availability in the meantime.
    maxAgeHours: 72,
    powers: "the conditional injury-horizon model (handcuffs); NOT availability, which uses gameday",
    refresh: "npm run ff -- ingest-raw injuries",
  },
  {
    id: "board",
    table: "board",
    asOfColumn: "updated_at",
    maxAgeHours: 48,
    powers: "every projection and dollar value the verbs rank on",
    refresh: "npm run ff -- ingest-source news",
    // MEASURED, not assumed: running that command took `board` from stale to 0h old, and its output
    // says "materialized news: 147 rows + rebuilt board". The board is rebuilt as a step of the
    // ingest-source pipeline rather than by one asset's declared writes, so no `writes:` list names
    // it and the static check cannot confirm it. Any `ingest-source` asset rebuilds it.
    refreshNotDeclared: "the board is rebuilt by the ingest-source pipeline, not by a single asset's writes: list -- verified by running the command and watching the feed go fresh",
  },
];

export interface FeedStatus {
  id: string;
  table: string;
  asOf: string | null;
  ageHours: number | null;
  maxAgeHours: number;
  verdict: FeedVerdict;
  powers: string;
  refresh: string;
  /** One line, only worth printing when the verdict is not `fresh`. */
  note: string;
}

/** Hours between an ISO-ish stamp and now. Null when the stamp is unparseable, which is reported as
 *  `unknown` rather than as fresh -- an undatable feed is not a healthy one. */
function ageHoursOf(asOf: string | null, now: Date): number | null {
  if (!asOf) return null;
  const t = Date.parse(asOf.length === 10 ? `${asOf}T23:59:59Z` : asOf);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

/**
 * Date every registered feed against the store.
 *
 * A MISSING TABLE IS `absent`, NOT `stale`. They have different fixes -- one needs a sync, the other
 * needs the asset to exist at all -- and a store built from a fresh clone would otherwise report
 * nine stale feeds and tell the reader to re-run syncs that have never run.
 */
export function feedStatus(db: DB, now: Date = new Date(), feeds: FeedSpec[] = FEEDS): FeedStatus[] {
  return feeds.map((f) => {
    let asOf: string | null = null;
    let missing = false;
    try {
      const r = db.prepare(`SELECT MAX(${f.asOfColumn}) AS m, COUNT(*) AS n FROM ${f.table}`).get() as { m: string | null; n: number };
      asOf = r?.m ?? null;
      missing = !r || r.n === 0;
    } catch { missing = true; }               // no such table

    const ageHours = ageHoursOf(asOf, now);
    const verdict: FeedVerdict = missing || asOf == null
      ? "absent"
      : ageHours == null ? "unknown"
      : ageHours > f.maxAgeHours ? "stale" : "fresh";

    const age = ageHours == null ? "unknown age" : `${ageHours.toFixed(1)}h old`;
    const note = verdict === "fresh"
      ? `${f.id}: fresh (${age})`
      : verdict === "absent"
        ? `${f.id}: NO ROWS in ${f.table} -- ${f.powers} has nothing behind it. Run: ${f.refresh}`
        : verdict === "unknown"
          ? `${f.id}: ${f.table}.${f.asOfColumn} is not a readable date, so its age cannot be judged. Run: ${f.refresh}`
          : `${f.id}: ${age}, past the ${f.maxAgeHours}h limit -- ${f.powers}. Run: ${f.refresh}`;

    return { id: f.id, table: f.table, asOf, ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10, maxAgeHours: f.maxAgeHours, verdict, powers: f.powers, refresh: f.refresh, note };
  });
}

/**
 * THE ONE LINE A SERVE PRINTS, or null when there is nothing to say.
 *
 * Null when every feed is fresh is not an optimisation -- it is the design. A DEGRADED banner on
 * every run is wallpaper within a week, and the next real staleness scrolls past unread.
 */
export function stalenessCaveat(statuses: FeedStatus[]): string | null {
  const bad = statuses.filter((s) => s.verdict !== "fresh");
  if (!bad.length) return null;
  return `DEGRADED -- ${bad.length} feed(s) are not fresh and this answer is built on them: ` +
    bad.map((s) => s.note).join("; ");
}
