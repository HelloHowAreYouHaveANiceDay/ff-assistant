// The refresh pipeline as ONE function, so the `ff refresh` CLI verb and the MCP `refresh` tool run
// the exact same three steps and cannot drift: ingest the sources, rebuild projections, assemble the
// board. Kept deliberately thin -- it is the sequence, not any of the logic, that was duplicated
// inline in cmdRefresh; the work still lives in ingest.ts / projections.ts / assemble.ts.
import { ingestAll } from "./ingest.js";
import { project } from "./projections.js";
import { assemble } from "./assemble.js";

export interface RefreshResult { projected: number; assembled: number }

/** Ingest → project → assemble. `dbPath` is the same optional store path every verb takes. */
export async function runRefresh(dbPath?: string): Promise<RefreshResult> {
  await ingestAll(dbPath);
  const projected = await project(dbPath);
  const assembled = await assemble(dbPath);
  return { projected, assembled };
}
