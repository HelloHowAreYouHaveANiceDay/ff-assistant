// Build the multi-season backtest history (history-points.csv + history-weekly.csv) scored under the
// LEAGUE's scoring model, so the championship backtest validates the strategy on the SAME ruleset the
// league uses (half-PPR, PPR, standard...). Was a Python one-off (build_history.py) hardcoded to
// No-PPR; this is the config-driven TS port. Fetches nflverse stats_player_week per season.
import { writeFileSync } from "node:fs";
import { fetchCsv, pick, NFLVERSE } from "./nflverse.js";
import { scoreWeek, type ScoringRules } from "../draft/scoring.js";
import { dataPath } from "./paths.js";

const FANTASY_POS = new Set(["QB", "RB", "WR", "TE"]); // skill positions (K/DST aren't in this feed)
const clean = (s: string) => s.replace(/,/g, " ").trim();

/** Rebuild history-points (season totals) + history-weekly (per-week) under `scoring`, for `seasons`. */
export async function buildHistory(seasons: number[], scoring: ScoringRules): Promise<{ points: number; weekly: number; seasons: number[] }> {
  const ptLines = ["season,name,pos,points"];
  const wkLines = ["season,name,pos,week,points"];
  let nP = 0, nW = 0; const got: number[] = [];
  for (const yr of seasons) {
    let rows: Record<string, string>[];
    try { rows = await fetchCsv(`${NFLVERSE}/stats_player/stats_player_week_${yr}.csv`); } catch { continue; }
    if (!rows.length) continue;
    got.push(yr);
    const seasonAgg = new Map<string, { pos: string; pts: number }>();
    for (const r of rows) {
      if (pick(r, "season_type") !== "REG") continue;
      const name = pick(r, "player_display_name"); if (!name) continue;
      const pos = pick(r, "position").toUpperCase(); if (!FANTASY_POS.has(pos)) continue;
      const week = Number(pick(r, "week")); if (!week) continue;
      const pts = Math.round(scoreWeek(r, scoring) * 10) / 10;
      wkLines.push(`${yr},${clean(name)},${pos},${week},${pts}`); nW++;
      const a = seasonAgg.get(name) ?? { pos, pts: 0 }; a.pts += pts; seasonAgg.set(name, a);
    }
    for (const [name, a] of seasonAgg) { ptLines.push(`${yr},${clean(name)},${a.pos},${Math.round(a.pts * 10) / 10}`); nP++; }
  }
  writeFileSync(dataPath("history-points.csv"), ptLines.join("\n") + "\n", "utf8");
  writeFileSync(dataPath("history-weekly.csv"), wkLines.join("\n") + "\n", "utf8");
  return { points: nP, weekly: nW, seasons: got };
}
