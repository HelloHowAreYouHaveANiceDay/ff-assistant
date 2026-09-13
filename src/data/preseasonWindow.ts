// The preseason draft-window filter on ranking_history.scrape_date: all of August, plus September
// 1-7 (up to draft day). Byte-identical in three query builders (data/projections, features/build,
// features/picks) -- and LEAKAGE-relevant, so it lives ONCE. Changing the cutoff in two of three
// would silently train the board/features on a different window than the projection curve, the exact
// kind of drift the repo's leak guards exist to catch. A leaf module: no imports, no cycle risk.
export const PRESEASON_WINDOW_SQL =
  "AND (substr(scrape_date,6,2)='08' OR (substr(scrape_date,6,2)='09' AND CAST(substr(scrape_date,9,2) AS INTEGER)<=7))";
