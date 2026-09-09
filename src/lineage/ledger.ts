// THE PREREGISTERED-PREDICTION LEDGER: loads data/predictions.json (the checked-in transcription of
// every P<n>/W<n> row in docs/redesign-2026-09.md's two prediction tables) into `fact_prediction`, so
// the Model page can show it and a test can prove it stays complete against the doc.
import { readFileSync } from "node:fs";
import { nowIso, type DB } from "../db/db.js";
import { dataPath } from "../data/paths.js";

export interface PredictionRow {
  id: string;
  docSection: string;
  claim: string;
  outcome: "held" | "failed" | "split" | "pending";
  measured: string;
}

export function loadPredictionsJson(path = dataPath("predictions.json")): PredictionRow[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of predictions`);
  return raw as PredictionRow[];
}

/** Rebuild `fact_prediction` from data/predictions.json. Deletes rows for ids no longer in the file
 *  (a prediction transcribed in error should not linger), then upserts every current one. */
export function syncLedger(db: DB, rows: PredictionRow[] = loadPredictionsJson()): { n: number } {
  const now = nowIso();
  const up = db.prepare(
    `INSERT INTO fact_prediction (id, doc_section, claim, outcome, measured, synced_at)
     VALUES (@id, @docSection, @claim, @outcome, @measured, @now)
     ON CONFLICT(id) DO UPDATE SET
       doc_section=excluded.doc_section, claim=excluded.claim, outcome=excluded.outcome,
       measured=excluded.measured, synced_at=excluded.synced_at`,
  );
  const ids = new Set(rows.map((r) => r.id));
  const run = db.transaction(() => {
    for (const existing of db.prepare(`SELECT id FROM fact_prediction`).all() as { id: string }[]) {
      if (!ids.has(existing.id)) db.prepare(`DELETE FROM fact_prediction WHERE id = ?`).run(existing.id);
    }
    for (const r of rows) up.run({ ...r, now });
  });
  run();
  return { n: rows.length };
}

/** Read the current ledger back out of the store, plus a count-by-outcome summary -- what the Model
 *  page and `ff models --json` both show. */
export function ledgerSummary(db: DB): { rows: PredictionRow[]; counts: Record<string, number> } {
  const rows = (db.prepare(
    `SELECT id, doc_section AS docSection, claim, outcome, measured FROM fact_prediction ORDER BY
       CASE substr(id, 1, 1) WHEN 'P' THEN 0 ELSE 1 END, CAST(substr(id, 2) AS INTEGER)`,
  ).all() as PredictionRow[]);
  const counts: Record<string, number> = { held: 0, failed: 0, split: 0, pending: 0 };
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return { rows, counts };
}

/** Every id the doc's own prediction TABLE ROWS name, scraped from docs/redesign-2026-09.md rather
 *  than retyped -- the completeness test's ground truth. Deliberately restricted to `| id | ... | ... |`
 *  table rows, not the whole document: the prose around the tables mentions "P21-P24 were never
 *  issued", and a scan of the whole file would demand ledger rows for predictions that were, by the
 *  doc's own account, never made. A row range like "P38-P39" expands to both ids; a summary row like
 *  "W1-W6" over ids already recorded individually contributes nothing new. */
export function docPredictionIds(docPath = "docs/redesign-2026-09.md"): Set<string> {
  const doc = readFileSync(docPath, "utf8");
  const ids = new Set<string>();
  for (const line of doc.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\*{0,2}[A-Za-z0-9-]+\*{0,2})\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (!m) continue;
    const rawId = m[1].replace(/\*/g, "");
    for (const im of rawId.matchAll(/([PW]\d+)/g)) ids.add(im[1]);
  }
  return ids;
}
