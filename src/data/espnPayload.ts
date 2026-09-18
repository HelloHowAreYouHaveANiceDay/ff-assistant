/**
 * INGEST A SAVED ESPN PAYLOAD, through the same pure parsers the live path uses.
 *
 * WHY THIS EXISTS. The repo assumed the ESPN login lived in the Electron app's webview and that any
 * caller could speak that app's bridge protocol. An agent whose login lives in a server-side browser
 * can do neither: it can drive a page and SAVE what comes back, but it cannot serve a bridge. Its
 * only route in was to read a payload and describe it in prose -- and a 2.27 MB boxscore
 * hand-summarised into a chat message is not a payload. It has lost the identity fields the guards
 * check, the hollow-payload shape the refusals look for, and every field nobody thought to mention.
 *
 * So the handoff is a FILE. The browser task saves the API JSON into the workspace, this reads it,
 * and the SAME functions that parse a live response parse the saved one -- `espnSettingsFromPayload`,
 * `espnRostersFromPayload`, `parseRosterWeek`, `parseTransactionWeek`. Every refusal they make, they
 * still make. Nothing here re-implements a parser, because a second implementation is a second thing
 * to drift.
 *
 * THE KIND IS DECLARED, NOT SNIFFED. `--kind` is required. A settings payload and a boxscore payload
 * share a shape at the top level (both carry `id`, `seasonId`, `teams`), so a sniffer would guess,
 * and guessing which view a file is means writing one view's data under another's name. `detectKind`
 * exists only to say "this does not look like what you said it was", which is a refusal, not a guess.
 */
import { readFileSync } from "node:fs";
import { openDb, nowIso, type DB } from "../db/db.js";
import { espnRoot } from "./leagueRosters.js";

export const PAYLOAD_KINDS = ["settings", "rosters", "draft", "boxscore", "transactions"] as const;
export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

/** Which ESPN `view` produces each kind -- the same table `docs/browser-sync.md` publishes, kept
 *  here as data so the doc and the verb cannot disagree about which URL to save. */
export const KIND_VIEW: Record<PayloadKind, string> = {
  settings: "mSettings&view=mTeam",
  // BOTH VIEWS. `espnRostersFromPayload` reads `members` for the manager display names, and
  // `members` comes from mTeam, not mRoster -- so a file saved from `view=mRoster` alone parses
  // but names every owner "Team <id>". Found by cross-reading the parser's own contract against
  // this table; the two live roster call sites request both views for the same reason.
  rosters: "mRoster&view=mTeam",
  draft: "mDraftDetail",
  boxscore: "mBoxscore",
  transactions: "mTransactions2",
};

export interface PayloadIngestResult {
  kind: PayloadKind;
  leagueId: string;
  season: number;
  rows: number;
  note: string;
  /** What the payload's own fields say it is, so a caller can see the file was what they thought. */
  identity: { id: string | null; seasonId: number | null; teams: number | null; hasSettings: boolean };
}

/**
 * What the payload's own top-level fields say. Reported on EVERY ingest, so the operator can see
 * that the file they saved is the league and season they meant -- the cheapest possible guard
 * against a file-handoff loop quietly ingesting yesterday's download.
 */
export function payloadIdentity(payload: unknown): PayloadIngestResult["identity"] {
  const j = espnRoot(payload) as { id?: unknown; seasonId?: unknown; teams?: unknown[]; settings?: unknown };
  return {
    id: j.id == null ? null : String(j.id),
    seasonId: j.seasonId == null ? null : Number(j.seasonId),
    teams: Array.isArray(j.teams) ? j.teams.length : null,
    hasSettings: j.settings != null,
  };
}

/**
 * Does this payload plausibly hold the declared kind? Returns a REASON when it does not.
 *
 * Deliberately weak: it checks for the one field the kind cannot be without, and says nothing
 * otherwise. A strong sniffer would start making decisions, and the decision about which view a file
 * holds belongs to whoever saved it.
 */
export function kindMismatch(payload: unknown, kind: PayloadKind): string | null {
  const j = espnRoot(payload) as Record<string, unknown>;
  const need: Record<PayloadKind, [string, boolean]> = {
    settings: ["settings", j.settings != null],
    rosters: ["teams[].roster", Array.isArray(j.teams) && (j.teams as { roster?: unknown }[]).some((t) => t?.roster != null)],
    draft: ["draftDetail", j.draftDetail != null],
    boxscore: ["schedule", Array.isArray(j.schedule)],
    transactions: ["transactions", Array.isArray(j.transactions)],
  };
  const [field, ok] = need[kind];
  return ok ? null : `declared --kind ${kind} but the payload has no \`${field}\`. ` +
    `Save it with \`view=${KIND_VIEW[kind]}\` (see docs/browser-sync.md). Nothing was written.`;
}

/** Read and parse the file. Separated from the write so a caller can validate without a db. */
export function readPayload(file: string): unknown {
  const raw = readFileSync(file, "utf8");
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`${file} is not JSON (${(e as Error).message.slice(0, 120)}). ` +
      "Save the raw API response, not a rendered page or a summary of it.");
  }
}

/**
 * Ingest one saved payload. The db is opened by the caller so several files can land in one
 * transaction-free sequence without reopening, and so a dry run can pass none.
 */
export async function ingestEspnPayload(opts: {
  file: string; kind: PayloadKind; leagueId: string; season: number;
  db?: DB; dbPath?: string; swid?: string | null; week?: number; dryRun?: boolean;
}): Promise<PayloadIngestResult> {
  // UNWRAPPED ONCE, HERE. ESPN answers some endpoints with a one-element ARRAY and others with the
  // object. `parseRosterWeek`/`parseTransactionWeek` unwrap internally but `espnRostersFromPayload`
  // reads `payload.teams` directly, so an array-shaped mRoster file passed both guards (which DO
  // unwrap) and then parsed to zero rosters -- landing in the refuse-empty-wipe branch, which reads
  // like a logged-out session rather than a shape mismatch. Unwrapping for everyone removes the
  // disagreement instead of teaching each caller about it. `espnRoot` is a no-op on a plain object.
  const payload = espnRoot(readPayload(opts.file));
  const identity = payloadIdentity(payload);

  const mismatch = kindMismatch(payload, opts.kind);
  if (mismatch) throw new Error(`ingest-espn-payload REFUSED: ${mismatch}`);

  // THE SAME IDENTITY GUARD THE LIVE PATH USES, applied before anything is written. A file handoff
  // makes it MORE important, not less: a live fetch at least asked for the league it got, whereas a
  // file on disk carries no record of what was requested.
  if (identity.id != null && String(identity.id) !== String(opts.leagueId)) {
    throw new Error(`ingest-espn-payload REFUSED: asked for league ${opts.leagueId} but the file is ` +
      `league ${identity.id}. Reading one league and writing another is how a league inherits ` +
      "another league's rules. Nothing was written.");
  }
  if (identity.seasonId != null && Number(identity.seasonId) !== Number(opts.season)) {
    throw new Error(`ingest-espn-payload REFUSED: asked for season ${opts.season} but the file is ` +
      `season ${identity.seasonId}. Nothing was written.`);
  }

  // THE DATABASE IS OPENED LAZILY, and a dry run that needs none never opens one. This used to be
  // `opts.db ?? openDb(opts.dbPath)` before the switch, so `--dry-run` with no explicit path opened
  // the caller's real `data/ff.db` -- a "dry" run that touches production is a contradiction, and
  // the comment above it claimed the opposite. Only the `settings` case reads the store (for the
  // previous budget/size), so only it opens anything in dry-run mode.
  // A HOLDER, not a bare `let`: TypeScript's control-flow analysis narrows a closure-assigned local
  // to `null` at the `finally`, so `opened?.close()` would not typecheck and, worse, could be
  // "fixed" by dropping the close and leaking the handle.
  const held: { db: DB | null } = { db: null };
  const useDb = (): DB => (opts.db ?? (held.db ??= openDb(opts.dbPath)));
  try {
    switch (opts.kind) {
      case "settings": {
        const { espnSettingsFromPayload } = await import("../league/espnPlatform.js");
        const prev = useDb().prepare("SELECT scoring_json FROM league WHERE league_id=?").get(opts.leagueId) as { scoring_json?: string } | undefined;
        const prevJson = prev?.scoring_json ? JSON.parse(prev.scoring_json) as { auctionBudget?: number; size?: number } : {};
        const settings = espnSettingsFromPayload(payload, {
          leagueId: opts.leagueId, season: opts.season, swid: opts.swid ?? null,
          prevBudget: prevJson.auctionBudget ?? 200, prevTeams: prevJson.size ?? 0,
        });
        if (opts.dryRun) return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: 0, identity, note: "DRY RUN -- parsed and validated, nothing written" };
        useDb().prepare(
          `INSERT INTO league (league_id, platform, name, season, team_id, scoring_json, last_synced_at)
           VALUES (@id,'espn',@name,@season,@team,@json,@now)
           ON CONFLICT(league_id) DO UPDATE SET name=excluded.name, season=excluded.season,
             scoring_json=excluded.scoring_json, last_synced_at=excluded.last_synced_at`,
        ).run({
          id: opts.leagueId, name: settings.name, season: opts.season,
          team: settings.teamId ?? null, json: JSON.stringify(settings.scoring), now: nowIso(),
        });
        return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: 1, identity,
          note: `league "${settings.name}", ${identity.teams ?? "?"} teams, scoring written` };
      }
      case "boxscore": {
        const { parseRosterWeek, loadLeagueRosterWeeks } = await import("./leagueRosters.js");
        if (opts.week == null) throw new Error("ingest-espn-payload REFUSED: --kind boxscore needs --week (the scoringPeriodId the file was saved for).");
        const parsed = parseRosterWeek(payload, opts.season, opts.week);
        if (opts.dryRun) return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: parsed.rows.length, identity, note: `DRY RUN -- ${parsed.rows.length} roster rows parsed` };
        const c = loadLeagueRosterWeeks(useDb(), opts.leagueId, [parsed], nowIso());
        return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: c.rows, identity,
          note: `${c.rows} roster rows, ${c.starters} starters, ${c.removed} stale removed${parsed.note ? ` (${parsed.note})` : ""}` };
      }
      case "transactions": {
        const { parseTransactionWeek, loadLeagueTransactions } = await import("./leagueTransactions.js");
        if (opts.week == null) throw new Error("ingest-espn-payload REFUSED: --kind transactions needs --week (the scoringPeriodId the file was saved for).");
        const parsed = parseTransactionWeek(payload, opts.season, opts.week);
        if (opts.dryRun) return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: parsed.rows.length, identity, note: `DRY RUN -- ${parsed.rows.length} item rows parsed` };
        const c = loadLeagueTransactions(useDb(), opts.leagueId, [parsed], nowIso());
        return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: c.rows, identity,
          note: `${c.rows} item rows over ${c.transactions} transaction(s)` +
            (parsed.itemless.length ? `; ${parsed.itemless.length} carried NO items and are not in the table` : "") };
      }
      case "rosters": {
        const { espnRostersFromPayload } = await import("../league/espnPlatform.js");
        const { writeOwnership } = await import("./ownershipSync.js");
        const rosters = espnRostersFromPayload(payload);
        if (opts.dryRun) return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: rosters.reduce((a, t) => a + t.players.length, 0), identity, note: `DRY RUN -- ${rosters.length} team rosters parsed` };
        // THE SAME WRITER THE LIVE SYNC USES, including its refuse-empty-wipe guard. A file handoff
        // is exactly when that guard matters most: a payload saved from a logged-out session parses
        // cleanly into zero rostered players, and writing that would erase the real rosters.
        const w = writeOwnership(useDb(), opts.leagueId, rosters, nowIso());
        if (w.decision === "refuse-empty-wipe") {
          throw new Error(`ingest-espn-payload REFUSED: the file parses to 0 rostered players across ` +
            `${rosters.length} teams, but ${w.existing} are already stored. That is what a payload saved ` +
            "from a logged-out session looks like. The existing rows are kept; nothing was written.");
        }
        if (w.decision === "noop-empty") {
          return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: 0, identity,
            note: "0 rostered players (pre-draft or empty league) -- nothing written" };
        }
        return { kind: opts.kind, leagueId: opts.leagueId, season: opts.season, rows: w.rows, identity,
          note: `${w.rows} rostered players across ${w.teams} teams` };
      }
      case "draft":
      default:
        throw new Error("ingest-espn-payload: --kind draft is not wired yet. The draft reader still " +
          "lives behind `ff ingest-raw league-history`; wiring it here is the same shape as the " +
          "boxscore case above and is deliberately NOT stubbed, because a verb that accepts a file " +
          "and writes nothing is worse than one that refuses.");
    }
  } finally { held.db?.close(); }
}
