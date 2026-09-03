// Where the engine writes its intermediate files (points.csv, player-report.csv). Defaults to the
// repo's data/ for dev/source-run; a packaged install sets FF_DATA to a WRITABLE userData dir (the
// install dir under Program Files is not writable). Mirrors FF_DB for the store.
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const DATA_ROOT = process.env.FF_DATA ?? "data";
export function dataPath(file: string): string {
  try { mkdirSync(DATA_ROOT, { recursive: true }); } catch { /* exists */ }
  return join(DATA_ROOT, file);
}
