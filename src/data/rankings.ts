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
  proj: number; // projected season fantasy points
  adp: number; // average draft position
}

/** Minimal CSV parse (no quoted-comma support needed for these files). */
export function loadRankings(path: string): PlayerRank[] {
  const text = readFileSync(path, "utf8").trim();
  const [header, ...rows] = text.split(/\r?\n/);
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  const idx = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`rankings CSV missing column: ${name} (have: ${cols.join(",")})`);
    return i;
  };
  const iName = idx("player");
  const iPos = idx("pos");
  const iTeam = idx("team");
  const iProj = idx("proj");
  const iAdp = idx("adp");

  return rows
    .filter((r) => r.trim().length > 0)
    .map((r) => {
      const f = r.split(",");
      return {
        name: f[iName].trim(),
        pos: f[iPos].trim().toUpperCase() as Pos,
        team: f[iTeam].trim().toUpperCase(),
        proj: Number(f[iProj]),
        adp: Number(f[iAdp]),
      };
    });
}
