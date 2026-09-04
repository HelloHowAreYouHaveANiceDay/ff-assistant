// Build per-manager draft tendencies from real auction history (TS port of analyze.mjs, config-driven
// so it works for ANY league). Each owner's signature = positional $ share + top-3 concentration +
// biggest buy + cheap-pick count, averaged over their seasons. The sim (managers.ts) turns each
// signature into a bidder that reproduces that owner's appetite + stars-and-scrubs degree.
import type { ManagerProfile, ManagerData } from "./managers.js";

export interface Recap { season: number; owner: string; abbrev: string; picks: { pos: string; price: number }[]; }

const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Money-weighted positional spend mix over a set of team-seasons. */
function posShareOf(teams: Recap[]): Record<string, number> {
  const acc: Record<string, number> = Object.fromEntries(POS.map((p) => [p, 0]));
  let tot = 0;
  for (const t of teams) for (const p of t.picks) { if (p.pos in acc) acc[p.pos] += p.price; tot += p.price; }
  return Object.fromEntries(POS.map((p) => [p, tot ? acc[p] / tot : 0]));
}
const conc = (t: Recap) => { const s = t.picks.map((p) => p.price).sort((a, b) => b - a); const tot = s.reduce((a, b) => a + b, 0); return tot ? s.slice(0, 3).reduce((a, b) => a + b, 0) / tot : 0; };
const maxBuy = (t: Recap) => Math.max(0, ...t.picks.map((p) => p.price));
const cheap = (t: Recap) => t.picks.filter((p) => p.price <= 5).length;

/** Recaps (one per team-season) -> {leagueShare, per-owner profiles} for the sim bot field. */
export function buildManagerProfiles(recaps: Recap[]): ManagerData {
  const leagueShare = posShareOf(recaps);
  const byOwner = new Map<string, Recap[]>();
  for (const t of recaps) { if (!t.owner) continue; (byOwner.get(t.owner) ?? byOwner.set(t.owner, []).get(t.owner)!).push(t); }
  const profiles: ManagerProfile[] = [];
  for (const [owner, teams] of byOwner) {
    teams.sort((a, b) => a.season - b.season);
    profiles.push({
      owner,
      abbrev: teams[teams.length - 1].abbrev || owner.slice(0, 4),
      seasons: teams.map((t) => t.season),
      share: posShareOf(teams),
      conc: mean(teams.map(conc)),
      maxBuy: mean(teams.map(maxBuy)),
      cheap: mean(teams.map(cheap)),
    });
  }
  return { leagueShare, profiles };
}
