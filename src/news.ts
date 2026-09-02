// Player NEWS layer: injury status + depth-chart role -> a draft/lineup signal, folded on top of
// the (consensus-derived) value table. Data comes from tools/build_news.py (data/news.csv); this
// module holds the PURE classification so it is unit-testable. The ff CLI joins it to OUR values by
// nameKey and prints it (`ff news`); it does NOT change values today (a deliberate later step).

export interface NewsRow { player: string; pos: string; team: string; status: string; injury: string; depth: string; }

/** Classify one player's news into a draft flag, or "" if nothing is worth flagging.
 *  - An injury designation (Out/Doubtful/Questionable) ALWAYS flags.
 *  - Depth-chart backup is NOISY for RB/WR (an RB2/WR2 still starts in fantasy), so RB/WR flag only
 *    when clearly BURIED (depth >= 3); QB/TE/K flag at depth >= 2 (a true backup).
 *  Pure -- injecting a bad status/depth must change the result. */
export function classifyNews(status: string, pos: string, depth: number | null): string {
  if (status === "Out") return "AVOID (OUT)";
  if (status === "Doubtful") return "RISK (Doubtful)";
  if (status === "Questionable") return "WATCH (Questionable)";
  const buriedThreshold = ["RB", "WR"].includes(pos) ? 3 : 2;
  if (depth != null && Number.isFinite(depth) && depth >= buriedThreshold) return `BURIED (depth ${depth})`;
  return "";
}
