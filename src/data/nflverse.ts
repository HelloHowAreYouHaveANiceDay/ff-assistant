// Direct downloads from the nflverse / ffverse data commons -- plain CSV over HTTPS from stable
// release URLs, no Python and no parquet lib. (Verified 2026-09: every nflverse-data type ships a
// .csv asset; FantasyPros ECR lives in dynastyprocess/data as db_fpecr_latest.csv.)
import { gunzipSync } from "node:zlib";

export const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
export const DPROC = "https://raw.githubusercontent.com/dynastyprocess/data/master/files";

/** Canonical source URLs. Kept in one place so a nflverse asset rename is a one-line fix. */
export const URLS = {
  players: `${NFLVERSE}/players/players.csv`,
  schedules: `${NFLVERSE}/schedules/games.csv`,
  combine: `${NFLVERSE}/combine/combine.csv`,
  ecr: `${DPROC}/db_fpecr_latest.csv`,
} as const;

/** Per-season assets. These were built inline at every call site, which quietly broke the promise
 *  the comment above makes -- a nflverse rename would have been a hunt, not a one-line fix. */
export const playerWeekUrl = (season: number) => `${NFLVERSE}/stats_player/stats_player_week_${season}.csv`;
export const teamWeekUrl = (season: number) => `${NFLVERSE}/stats_team/stats_team_week_${season}.csv`;

/**
 * nflverse team abbreviations -> the ECR/FantasyPros canonical ones.
 *
 * ONE copy. This table existed identically in ingest.ts and history.ts; two copies of a mapping
 * that must agree is a drift waiting to happen, and the join it feeds (player.nfl_team, points
 * allowed by team-week) fails SILENTLY when they disagree -- a team simply matches nothing.
 */
export const TEAM_ALIAS: Record<string, string> = { LA: "LAR", JAX: "JAC", OAK: "LV", SD: "LAC", STL: "LAR", WSH: "WAS", ARZ: "ARI" };
export const canonTeam = (t: string): string => TEAM_ALIAS[t] ?? t;

export async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch text, transparently gunzipping a .gz URL. */
export async function fetchText(url: string): Promise<string> {
  const buf = await fetchBytes(url);
  return (url.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
}

/** Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas/quotes/newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* ignore CR */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0];
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue; // trailing blank line
    const o: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) o[header[j]] = cells[j] ?? "";
    out.push(o);
  }
  return out;
}

export async function fetchCsv(url: string): Promise<Record<string, string>[]> {
  return parseCsv(await fetchText(url));
}

/** First present, non-empty value among candidate column names (defends against schema drift). */
export function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) { const v = row[k]; if (v != null && v !== "") return v; }
  return "";
}

// ==================================================================================================
// DISK-CACHED FETCH.
//
// Several fit scripts grew their own copy of this (feature-sweep.mjs had the canonical one) while
// the SHIPPED path -- history.ts -- had none and re-downloaded ~300MB of season files on every
// rebuild. That asymmetry is why `build-history` could not run offline, and why every script that
// wanted the same columns went and fetched them again, differently.
//
// One copy, in the module that owns the URLs. The on-disk layout is `data/cache/<tag>.csv.gz`, the
// same names the scripts already write, so an existing cache is picked up rather than re-fetched.
// ==================================================================================================

/** Cache tags for the per-season assets, so a tag is never typed twice. */
export const cacheTag = {
  playerWeek: (s: number) => `pw-${s}`,
  teamWeek: (s: number) => `tw-${s}`,
  schedules: "schedules",
  players: "players",
  draftPicks: "draft-picks",
} as const;

export const draftPicksUrl = `${NFLVERSE}/draft_picks/draft_picks.csv`;

export async function fetchCsvCached(url: string, tag: string, refresh = false): Promise<Record<string, string>[]> {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { gzipSync, gunzipSync: gunzip } = await import("node:zlib");
  const { dataPath } = await import("./paths.js");
  const dir = dataPath("cache");
  const p = `${dir}/${tag}.csv.gz`;
  if (!refresh && existsSync(p)) return parseCsv(gunzip(readFileSync(p)).toString("utf8"));
  const text = await fetchText(url);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, gzipSync(Buffer.from(text)));
  return parseCsv(text);
}
