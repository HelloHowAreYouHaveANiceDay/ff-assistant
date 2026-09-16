// PHASE 4 (A6 continuous loop): the DEPENDENCY FINGERPRINT that turns the hand-maintained
// re-measurement registry (docs/edges.md) into a MECHANICAL one.
//
// An arbiter result in data/experiments.jsonl is only true CONDITIONAL on the inputs it read: the
// history it replayed, the raw signals it priced, the stored levers, and the CODE that defines the
// backtest. When any of those shifts, the result is STALE until re-run -- exactly the rule the edges.md
// registry states in prose. This computes a single deterministic hash over that dependency set, so a
// checker can recompute it later and SEE whether it moved, instead of a human remembering to.
//
// DESIGN RULE: never UNDER-flag. It is safe to re-run a still-valid experiment (waste), catastrophic to
// trust a stale one (a wrong number in a durable record). So the manifest is deliberately BROAD -- any
// change to a file that DEFINES the draft arbiter flags every draft-arbiter experiment stale, even if
// that particular edit could not have moved the number. Over-flagging is the correct direction here.
//
// CHEAP BY CONSTRUCTION: CSVs and code are hashed by content (they are small); DB tables are versioned
// by (row count, max fetched_at) rather than a full row hash -- every ingest path upserts fetched_at
// (ON CONFLICT ... SET fetched_at=excluded.fetched_at), so a refresh always bumps it, and a checker
// that hashed 6k+ rows on every call would be too slow to run on every refresh.
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

/**
 * THE LEAGUE OF THE PROCESS THAT IS ASKING, as a DEFAULT for the `leagueId` argument.
 *
 * Both callers of this module are arbiter scripts whose whole run is defined by their argv, and the
 * one that takes `--league` (`scripts/cpcv.mjs`) calls `fingerprintDraftArbiter(ddb)` with no second
 * argument. Without this default the per-format fingerprint below would be correct code that nothing
 * ever reaches -- a lever that is defined but not wired, which reads exactly like a lever that does
 * nothing. An explicit argument always wins, and `experiments-status.mjs` (which has no `--league`)
 * is unchanged. The one-line `fingerprintDraftArbiter(ddb, LEAGUE)` in cpcv.mjs is the better
 * spelling and should replace this when that file is next touched.
 */
function argvLeague() {
  const i = process.argv.indexOf("--league");
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

// --- the draft-arbiter dependency manifest ----------------------------------------------------------
// Everything `ff backtest --full --no-lookahead --inflation [...]` reads or is defined by. The four
// consensus-blend experiments and the A3.1 references all live under this one manifest.
export const DRAFT_ARBITER_DEPS = {
  // Replayed history + the bot book. Content-hashed (these are modest CSV/JSON files).
  files: [
    "data/history-points.csv",   // the season point totals the projection/pool is built from
    "data/history-weekly.csv",   // weekly scoring the sim scores lineups against
    "data/managers.json",        // the bot field
  ],
  // Raw signals the arbiter can price, plus the stored levers. Versioned by (rows, max fetched_at).
  tables: [
    "raw_fftoday_proj",          // the consensus-blend signal
    "raw_nfl_draft_pick",        // rookie draft-capital pricing
  ],
  // The per-fold trained artifacts (--projection artifact). Directory content-hash (file names+sizes+mtimes).
  dirs: ["data/fold-artifacts-2b"],
  // The CODE that DEFINES the backtest. A change here can move any number, so all are in the fingerprint.
  code: [
    "src/ff.ts",                       // the backtest command + the consensus-blend lever
    "src/draft/backtest.ts",
    "src/draft/sim.ts",
    "src/draft/strategy.ts",
    "src/draft/levers.ts",
    "src/draft/values.ts",
    "src/draft/consensusBlend.ts",     // the FFToday consensus re-rank the backtest lever applies
    "src/draft/rookieModel.ts",
    "src/model/projector.ts",          // artifact-mode projection
    "src/inseason/lineup.ts",          // --full real lineup optimizer
  ],
};

function hashFile(p) {
  if (!existsSync(p)) return `MISSING:${p}`;
  return sha(readFileSync(p)).slice(0, 16);
}

// A directory's content version: sorted (name, size, mtimeMs) of its files. Catches a regenerated
// artifact set (new mtime/size) without reading every byte of every artifact.
function hashDir(p) {
  if (!existsSync(p)) return `MISSING:${p}`;
  const entries = readdirSync(p).filter((f) => !f.startsWith(".")).sort()
    .map((f) => { const st = statSync(`${p}/${f}`); return `${f}:${st.size}:${Math.round(st.mtimeMs)}`; });
  return sha(entries.join("|")).slice(0, 16);
}

// A DB table's cheap version: (row count, max fetched_at). Requires a `fetched_at` column (every raw_*
// ingest has one); falls back to a full ordered-row hash for a table without it.
function tableVersion(db, table) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.length) return `MISSING:${table}`;
    const n = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    if (cols.includes("fetched_at")) {
      const mx = db.prepare(`SELECT MAX(fetched_at) m FROM ${table}`).get().m ?? "";
      return `${n}:${mx}`;
    }
    // no freshness column -> ordered content hash (only used for small tables)
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    return `${n}:${sha(JSON.stringify(rows)).slice(0, 16)}`;
  } catch {
    return `ERR:${table}`;
  }
}

/**
 * Fingerprint the draft-arbiter dependency set. Returns { hash, parts } where parts is the per-input
 * breakdown (so a checker can show WHICH input drifted, not just that something did). Deterministic.
 * The stored levers are included via the `settings` config row when a db handle is supplied.
 */
// --- WHICH FORMAT'S INPUTS A RUN ACTUALLY READ (WP13) -------------------------------------------
//
// THE DEFECT. `files` above names `data/history-points.csv` and `data/history-weekly.csv` as string
// literals. Those are the INCUMBENT format's target: a `cpcv --league 129048` run replays
// `data/formats/sc-a845f67652fb/history-*.csv`, and every ledger row it wrote recorded the hashes of
// files it never opened. That is worse than no fingerprint -- the staleness check would call a Yahoo
// row CURRENT while the Yahoo target it was measured on had been rebuilt underneath it, and would
// call it STALE when the ESPN target moved and nothing about that run had changed.
//
// THE RULE. The fingerprint follows `resolveFormat`, exactly as every other per-format read in the
// repo now does. The incumbent's PART SET IS FROZEN -- same keys, same values, so every historical
// ledger row keeps its meaning and its hash (asserted in test/wp13-wiring.test.ts) -- and a format
// directory swaps the two history files for its own and ADDS its projection artifact, which is the
// model the snake room's board is built from and which the root path never carried for it.
//
// Keys are written with forward slashes whatever `path.join` produced, because the key string is IN
// the hash: `data\history-points.csv` and `data/history-points.csv` are the same file and must not be
// two different fingerprints.
const slash = (p) => String(p).replace(/\\/g, "/");

/**
 * WHICH FORMAT DIRECTORY A LEAGUE'S ARBITER RUN READ -- resolved SYNCHRONOUSLY, and from evidence.
 *
 * This module cannot call `resolveFormat`: it is loaded by plain-`node` scripts that cannot import
 * TypeScript, and `fingerprintDraftArbiter` is called synchronously by both of them, so it cannot
 * become async without silently handing each caller a Promise to hash. So the match is made against
 * the thing `resolveFormat`'s own preimage check is made against -- `data/formats/<key>/scoring.json`,
 * the rules the directory DECLARES -- compared to the league's stored `scoring_rules`/`kicker`/
 * `defense`. Same evidence, one rule short (the key is not re-hashed here; `resolveFormat` does that
 * on every real read and refuses the directory outright if it fails).
 *
 * `manifest.leagueId` is used only as a fallback, and is recorded as such in `how`, because it says
 * which league BUILT the directory rather than which rules it holds.
 *
 * No match at all -> `null` -> the incumbent's root files, which is correct for every ESPN league and
 * is stamped in the parts so it cannot pass silently.
 */
function formatDirForLeague(db, leagueId) {
  const canon = (o) => (o == null ? "null" : JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])));
  let cfg = null;
  try {
    const row = db?.prepare("SELECT value FROM settings WHERE key = ?").get(`config:${leagueId}`);
    if (row) cfg = JSON.parse(String(row.value));
  } catch { /* no store handle, or no row -- the manifest fallback below still applies */ }
  let dirs;
  try { dirs = readdirSync("data/formats"); } catch { return null; }
  let byManifest = null;
  for (const d of dirs) {
    const sp = `data/formats/${d}/scoring.json`;
    if (cfg && existsSync(sp)) {
      try {
        const sc = JSON.parse(readFileSync(sp, "utf8"));
        if (canon(sc.rules) === canon(cfg.scoring_rules) && canon(sc.kicker ?? null) === canon(cfg.kicker ?? null)
          && canon(sc.defense ?? null) === canon(cfg.defense ?? null)) {
          return { dir: `data/formats/${d}`, key: d, how: "scoring.json" };
        }
      } catch { /* unparseable -- not a match */ }
    }
    const mp = `data/formats/${d}/manifest.json`;
    if (!byManifest && existsSync(mp)) {
      try {
        const m = JSON.parse(readFileSync(mp, "utf8"));
        if (String(m.leagueId ?? "") === String(leagueId)) byManifest = { dir: `data/formats/${d}`, key: d, how: "manifest.leagueId" };
      } catch { /* unparseable -- not a match */ }
    }
  }
  return byManifest;
}

/**
 * Fingerprint the draft-arbiter dependency set. Returns { hash, parts } where parts is the per-input
 * breakdown (so a checker can show WHICH input drifted, not just that something did). Deterministic.
 * The stored levers are included via the `settings` config row when a db handle is supplied.
 *
 * `leagueId` names WHICH LEAGUE the arbiter run is for. Omitted = the incumbent (and the ACTIVE
 * league's config row), which is every historical ledger row and is unchanged to the byte.
 */
export function fingerprintDraftArbiter(db, leagueId = argvLeague()) {
  const parts = {};
  const fmt = leagueId != null ? formatDirForLeague(db, leagueId) : null;
  const fmtDir = fmt?.dir ?? null;
  // The two history CSVs follow the format; `managers.json` is the bot field, which is a property of
  // the LEAGUE's owners and lives at the root for both today (noted, not silently re-pointed).
  const FMT_FILES = { "data/history-points.csv": "history-points.csv", "data/history-weekly.csv": "history-weekly.csv" };
  for (const f of DRAFT_ARBITER_DEPS.files) {
    const rel = FMT_FILES[f];
    const p = fmtDir && rel ? `${fmtDir}/${rel}` : f;
    parts[`file:${slash(p)}`] = hashFile(p);
  }
  if (fmtDir) {
    // The projector the format's board is built from. Only on the format branch: adding it to the
    // incumbent's part set would move the hash of every row already in the ledger.
    parts[`file:${slash(`${fmtDir}/projection-artifact.json`)}`] = hashFile(`${fmtDir}/projection-artifact.json`);
    parts[`dir:${slash(`${fmtDir}/fold-artifacts`)}`] = hashDir(`${fmtDir}/fold-artifacts`);
    parts[`format:${leagueId}`] = `${fmt.key}:${fmt.how}`;
  }
  // A NAMED league with NO format directory adds nothing at all, deliberately: it read the root's
  // files, so `--league 462233` and a flagless run must fingerprint IDENTICALLY or every historical
  // ledger row would read STALE the moment an ESPN run named its league. (A league whose rules are
  // neither the incumbent's nor a built directory's cannot reach here in practice -- `resolveFormat`
  // refuses it by name long before the arbiter runs.)
  for (const d of DRAFT_ARBITER_DEPS.dirs) parts[`dir:${d}`] = hashDir(d);
  for (const c of DRAFT_ARBITER_DEPS.code) parts[`code:${c}`] = hashFile(c);
  if (db) {
    for (const t of DRAFT_ARBITER_DEPS.tables) parts[`table:${t}`] = tableVersion(db, t);
    // THE ACTIVE LEAGUE'S OWN CONFIG ROW, not the legacy `config` mirror. The mirror is derived from
    // whichever league was made active last, so on a two-league store it fingerprints a league the
    // arbiter may not be running for. Resolved the same way `activeLeagueId` does (explicit selection
    // first, then most-recently-synced); spelled out here rather than imported because this file is
    // loaded by plain-`node` scripts that cannot load TypeScript.
    // ...and an EXPLICIT league wins over the active one, for the same reason the files above do: the
    // levers a `--league 129048` run read are that league's, not whichever league was made active last.
    try {
      const sel = db.prepare("SELECT value FROM settings WHERE key = 'active_league'").get();
      const id = leagueId != null
        ? String(leagueId)
        : (sel && db.prepare("SELECT 1 FROM league WHERE league_id = ?").get(String(sel.value)))
          ? String(sel.value)
          : db.prepare("SELECT league_id FROM league ORDER BY last_synced_at DESC LIMIT 1").get()?.league_id;
      const cfg = id ? db.prepare("SELECT value FROM settings WHERE key = ?").get(`config:${id}`) : undefined;
      parts["config:settings.config"] = cfg ? sha(String(cfg.value)).slice(0, 16) : "UNSET";
    } catch { parts["config:settings.config"] = "ERR"; }
  }
  const hash = sha(JSON.stringify(Object.keys(parts).sort().map((k) => [k, parts[k]]))).slice(0, 16);
  return { hash, parts };
}
