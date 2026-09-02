// LAYER 2 (tailoring) helpers over the general league-neutral feed (data/player-news.csv, built by
// tools/build_player_news.py). Layer 1 is source-agnostic and makes no league assumptions; this
// layer turns a feed item's (category, severity) into an actionable draft flag for OUR league. Pure
// + unit-tested. `ff news` joins the feed to our value table by nameKey and renders it.

export interface NewsItem {
  player: string; pos: string; team: string;
  category: string;  // injury | role | headline | ...
  severity: string;  // high | medium | low (general fantasy-relevance hint from Layer 1)
  detail: string; source: string; asof: string;
}

/** An actionable draft flag for a feed item, or "" if it is informational only (headlines, and
 *  low-severity role notes an RB2/WR2 gets). Tailors on (category, severity) -- the league-neutral
 *  signal Layer 1 already computed -- NOT on raw injury text or depth, so Layer 1 can add sources
 *  without this changing. Pure. */
export function classifyNews(category: string, severity: string): string {
  if (category === "injury") return severity === "high" ? "AVOID" : "WATCH";
  if (category === "role" && (severity === "high" || severity === "medium")) return "BURIED";
  return ""; // headline, or low-severity role -> informational, not a flag
}
