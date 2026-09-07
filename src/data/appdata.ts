// The app's data payload (board + news + config), read from the store. Shared by `ff app-data`
// (one-shot) and `ff serve` (the persistent helper), so there's one definition.
import { getConfig, type DB } from "../db/db.js";
import { LEVER_SPECS } from "../draft/levers.js";

const NUM = new Set(["Rank", "Bye", "Age", "Wt", "40yd", "OurValue$", "vsECR", "ProjPts", "ECR", "ECR_Best", "ECR_Worst", "ESPN_Rank", "ESPN_ADP", "Rostered%", "Depth"]);

export function appDataPayload(db: DB, season: number) {
  const players = (db.prepare(
    "SELECT row_json FROM board WHERE season = ? ORDER BY CAST(json_extract(row_json,'$.Rank') AS INTEGER)",
  ).all(season) as { row_json: string }[]).map((r) => JSON.parse(r.row_json) as Record<string, unknown>);
  for (const p of players) for (const k of Object.keys(p)) {
    const v = p[k];
    if (v === "" || v == null) continue;
    if (NUM.has(k) || k.endsWith("Pts") || k.endsWith("Gms")) {
      const n = typeof v === "number" ? v : (String(v).includes(".") ? parseFloat(String(v)) : parseInt(String(v), 10));
      if (!Number.isNaN(n)) p[k] = n;
    }
  }
  const news = db.prepare(
    "SELECT player_name AS player, pos, team, category, severity, detail, source, asof, url FROM news WHERE category IN ('injury','headline','trending') ORDER BY id",
  ).all();
  const lastYr = players.length
    ? (Object.keys(players[0]).find((k) => k.endsWith("Gms") && /^\d{4}/.test(k))?.slice(0, 4) ?? "LastYr")
    : "LastYr";
  const config = { ...getConfig(db), season };
  // Ship the lever REGISTRY to the renderer so the Settings UI is generated from it. The renderer
  // used to carry its own `LEVERS_UI` table, which had drifted to 8 of the 13 levers -- benchDiscount
  // (the largest measured win, 24.4% -> 28.0%) and all four positional multipliers were invisible
  // and uneditable in the app. Sent as a sibling of `config`, NOT inside it, so this derived data can
  // never round-trip back through `setConfig` and get persisted as if it were stored state.
  // WHEN the board was built, so the renderer can show its age and notice a rebuild that happened
  // underneath a running app. The app loads the board once at boot; a `ff refresh` run from a
  // terminal changes SQLite and nothing tells the window, so a correctly-rebuilt board sits
  // invisible behind a correctly-loaded stale one. Both halves of that are silent without this.
  const builtAt = (db.prepare("SELECT MAX(updated_at) AS m FROM board WHERE season = ?")
    .get(season) as { m: string | null } | undefined)?.m ?? null;
  return { players, news, config, lastYr, leverSpecs: LEVER_SPECS, builtAt };
}

/** OUR value book as the BIDDER sees it: player_value, the store the live auto-draft reads
 *  (`sqlite:player_value(...)`). Every surface that shows or reasons about our values should come
 *  through here so the cheatsheet, the news digest and the bidder can never disagree.
 *
 *  data/values.csv is a checked-in SEED (it makes a fresh clone work before any refresh), not a
 *  second source of truth -- callers fall back to it only when the table is empty, and say so.
 *  scripts/value-gates.mjs asserts the two agree after a build. */
export function valueBook(db: DB, season: number): { name: string; pos: string; value: number }[] {
  return (db.prepare(
    "SELECT p.name AS name, p.position AS pos, pv.our_value AS value FROM player_value pv " +
    "JOIN player p USING(player_id) WHERE pv.season = ? ORDER BY pv.our_value DESC",
  ).all(season) as { name: string; pos: string; value: number }[])
    .filter((r) => r.name && typeof r.value === "number" && !Number.isNaN(r.value));
}
