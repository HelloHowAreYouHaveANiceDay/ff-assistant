// Rankings loader (the "easiest" projections/ADP source per the sprint decision):
// a local CSV of player, position, team, projected season points, and ADP.
// Swap data/rankings.csv for any free export (FantasyPros, etc.); the copresent
// fallback is to read ESPN's own on-screen ranking, added later.

import { readFileSync } from "node:fs";

export type Pos = "QB" | "RB" | "WR" | "TE" | "K" | "DST";

export interface PlayerRank {
  name: string;
  pos: Pos;
  team: string;
  proj: number; // projected season fantasy points (0 if absent)
  adp: number; // average draft position (0 if absent)
  value?: number; // OUR auction $ value (the "our values" column; optional)
}

/** Minimal CSV parse. Requires `player` + `pos`; `team`/`proj`/`adp`/`value` are optional, so a
 *  values table (player,pos,value) OR a projections table (player,pos,team,proj,adp) both load. */
export function loadRankings(path: string): PlayerRank[] {
  const text = readFileSync(path, "utf8").trim();
  const [header, ...rows] = text.split(/\r?\n/);
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  const idx = (name: string) => cols.indexOf(name);
  const iName = idx("player"), iPos = idx("pos"), iTeam = idx("team");
  const iProj = idx("proj"), iAdp = idx("adp"), iValue = idx("value");
  if (iName < 0 || iPos < 0) throw new Error(`CSV must have 'player' and 'pos' columns (have: ${cols.join(",")})`);
  const at = (f: string[], i: number) => (i >= 0 && f[i] != null ? f[i].trim() : "");

  return rows
    .filter((r) => r.trim().length > 0)
    .map((r) => {
      const f = r.split(",");
      const rank: PlayerRank = {
        name: at(f, iName),
        pos: at(f, iPos).toUpperCase() as Pos,
        team: at(f, iTeam).toUpperCase(),
        proj: Number(at(f, iProj)) || 0,
        adp: Number(at(f, iAdp)) || 0,
      };
      const v = Number(at(f, iValue));
      if (iValue >= 0 && !Number.isNaN(v)) rank.value = v;
      return rank;
    });
}
