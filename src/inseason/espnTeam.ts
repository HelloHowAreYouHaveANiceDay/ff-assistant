// Copresent reads/writes for the in-season ESPN TEAM page (roster + weekly lineup). Same pattern as
// the draft's espnAuction: selectors are pinned from the LIVE page. The team/lineup UI is only
// available once the season starts (no active roster/matchup in the preseason draft window), so
// readRoster/setLineup are scaffolded now and get real selectors on a live team page (like the draft
// room, G1). The optimizer (lineup.ts) is fully built + tested and drives these.

import type { Page } from "playwright-core";

export interface RosteredPlayer { name: string; pos: string; opponent?: string; starting: boolean; injuryStatus?: string; }

/** Read our team's roster from the ESPN team/lineup page: each player's name, pos, this week's
 *  opponent, whether currently starting, and injury/bye status. VERIFY selectors on a live team
 *  page at season start (the lineup UI differs from the draft room). */
export async function readRoster(_page: Page): Promise<RosteredPlayer[]> {
  throw new Error("espnTeam.readRoster: selectors not yet pinned -- verify on the live team page once the season starts.");
}

/** Move players between starting slots and bench to realize a target lineup, then verify by re-read.
 *  VERIFY on a live team page (drag/drop vs 'Move' buttons). */
export async function setLineup(_page: Page, _starters: string[]): Promise<boolean> {
  throw new Error("espnTeam.setLineup: selectors not yet pinned -- verify on the live team page once the season starts.");
}

/** A player is startable if not on a bye and not ruled OUT (the big weekly lever). */
export function isAvailable(p: RosteredPlayer): boolean {
  const bye = p.opponent?.toUpperCase() === "BYE";
  const out = p.injuryStatus?.toUpperCase() === "OUT";
  return !bye && !out;
}
