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
