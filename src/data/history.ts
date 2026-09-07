// Build the multi-season backtest history (history-points.csv + history-weekly.csv) scored under the
// LEAGUE's scoring model, so the championship backtest validates the strategy on the SAME ruleset the
// league uses (half-PPR, PPR, standard...). Was a Python one-off (build_history.py) hardcoded to
// No-PPR; this is the config-driven TS port. Fetches nflverse stats_player_week per season.
import { writeFileSync } from "node:fs";
import { fetchCsv, pick, URLS, playerWeekUrl, teamWeekUrl, canonTeam } from "./nflverse.js";
import { scoreWeek, scoreKickerWeek, scoreDefenseWeek, scoreIdpWeek, idpGroup, DEFAULT_LEAGUE_SCORING, type LeagueScoring, type ScoringRules } from "../draft/scoring.js";
import { dataPath } from "./paths.js";

const SKILL_POS = new Set(["QB", "RB", "WR", "TE"]);
const clean = (s: string) => s.replace(/,/g, " ").trim();

/**
 * K and DST were excluded here for the life of this file, behind the comment "K/DST aren't in this
 * feed". That was simply WRONG, and it cost more than it looked: history-points.csv had no kickers
 * or defenses, so the championship backtest drafted from a pool without them and ran every season
 * with two starting slots permanently EMPTY for all 16 teams -- while the live board (points.csv)
 * carries 34 K and 32 DST. It also left `maxKDst` inert: --max-kdst 2 and --max-kdst 60 returned
 * an identical 36.5%, because a cap on K/DST spending cannot bind when there is nothing to buy.
 *
 * Kickers ARE in stats_player_week (569 rows in 2024) with full distance-tiered columns.
 * Team defenses are not player rows at all -- they are built here from stats_team_week plus the
 * points each defense allowed, which comes from the schedule.
 */


/** points ALLOWED by each team, per week, from the schedule's final scores. */
async function pointsAllowed(yr: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const games = await fetchCsv(URLS.schedules);
  for (const g of games) {
    if (Number(pick(g, "season")) !== yr) continue;
    if (pick(g, "game_type") !== "REG") continue;
    const wk = Number(pick(g, "week"));
    const home = canonTeam(pick(g, "home_team")), away = canonTeam(pick(g, "away_team"));
    const hs = Number(pick(g, "home_score")), as = Number(pick(g, "away_score"));
    if (!wk || !home || !away || !Number.isFinite(hs) || !Number.isFinite(as)) continue;
    out.set(`${home}|${wk}`, as);   // home defense allowed the away score
    out.set(`${away}|${wk}`, hs);
  }
  return out;
}

/** Rebuild history-points (season totals) + history-weekly (per-week) under `scoring`, for `seasons`. */
/**
 * `scoring` accepts either the full LeagueScoring model or a bare ScoringRules. The bare form is the
 * legacy call shape and means "offence from the league, K/DST from the defaults" -- which is exactly
 * the gap this parameter exists to close, so it is accepted but normalized here rather than left to
 * each call site to remember.
 */
export async function buildHistory(seasons: number[], scoring: ScoringRules | LeagueScoring): Promise<{ points: number; weekly: number; seasons: number[] }> {
  const model: LeagueScoring = "rules" in scoring
    ? scoring as LeagueScoring
    : { ...DEFAULT_LEAGUE_SCORING(), rules: scoring as ScoringRules };
  const ptLines = ["season,name,pos,points"];
  // `team` is APPENDED as the last column: both existing consumers (ff.ts backtest loader,
  // fit-variance.mjs) read fields 0-4 positionally, so adding at the end cannot shift them.
  // It is needed to measure and then MODEL correlation between rostered NFL teammates.
  const wkLines = ["season,name,pos,week,points,team"];
  let nP = 0, nW = 0; const got: number[] = [];
  for (const yr of seasons) {
    let rows: Record<string, string>[];
    try { rows = await fetchCsv(playerWeekUrl(yr)); } catch { continue; }
    if (!rows.length) continue;
    got.push(yr);
    const seasonAgg = new Map<string, { pos: string; pts: number }>();
    for (const r of rows) {
      if (pick(r, "season_type") !== "REG") continue;
      const name = pick(r, "player_display_name"); if (!name) continue;
      const rawPos = pick(r, "position").toUpperCase();
      const isK = rawPos === "K";
      // IDP players are emitted under their FANTASY GROUP (DL/LB/DB), not their depth-chart position,
      // because that is the unit a roster slot is defined in. Included even though this league does
      // not use IDP -- see the benchmark note on DEFAULT_IDP.
      const idp = (!SKILL_POS.has(rawPos) && !isK) ? idpGroup(rawPos) : null;
      if (!SKILL_POS.has(rawPos) && !isK && !idp) continue;
      const pos = idp ?? rawPos;
      const week = Number(pick(r, "week")); if (!week) continue;
      const raw = idp ? scoreIdpWeek(r, model.idp) : isK ? scoreKickerWeek(r, model.kicker) : scoreWeek(r, model.rules);
      const pts = Math.round(raw * 10) / 10;
      wkLines.push(`${yr},${clean(name)},${pos},${week},${pts},${canonTeam(pick(r, "team"))}`); nW++;
      const a = seasonAgg.get(name) ?? { pos, pts: 0 }; a.pts += pts; seasonAgg.set(name, a);
    }

    // --- team defenses, from the TEAM feed + points allowed ------------------------------------
    try {
      const teamRows = await fetchCsv(teamWeekUrl(yr));
      const pa = await pointsAllowed(yr);
      for (const r of teamRows) {
        if (pick(r, "season_type") !== "REG") continue;
        const team = canonTeam(pick(r, "team")); if (!team) continue;
        const week = Number(pick(r, "week")); if (!week) continue;
        const allowed = pa.get(`${team}|${week}`);
        if (allowed == null) continue;   // no final score -> cannot score the PA ladder; skip, never assume 0
        const pts = Math.round(scoreDefenseWeek(r, allowed, model.defense) * 10) / 10;
        const name = `${team} DST`;
        wkLines.push(`${yr},${name},DST,${week},${pts},${team}`); nW++;
        const a = seasonAgg.get(name) ?? { pos: "DST", pts: 0 }; a.pts += pts; seasonAgg.set(name, a);
      }
    } catch { /* team feed absent for very old seasons -> that year simply has no DST */ }
    for (const [name, a] of seasonAgg) { ptLines.push(`${yr},${clean(name)},${a.pos},${Math.round(a.pts * 10) / 10}`); nP++; }
  }
  writeFileSync(dataPath("history-points.csv"), ptLines.join("\n") + "\n", "utf8");
  writeFileSync(dataPath("history-weekly.csv"), wkLines.join("\n") + "\n", "utf8");
  return { points: nP, weekly: nW, seasons: got };
}
