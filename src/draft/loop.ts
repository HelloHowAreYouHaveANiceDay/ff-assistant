// The draft loop (D8) with the copresent override window (D0): each time we are on
// the clock, rank the board, surface the intended pick, wait a short override window
// for the user to grab the wheel, and pick if they don't. Actions are stubbed until
// espnReader has real selectors.

import type { Page } from "playwright-core";
import { readBoard, makePick, type BoardState } from "./espnReader.js";
import { loadRankings } from "../data/rankings.js";
import { replacementBaselines, withVOR, rankForPick, type LeagueSettings } from "./rank.js";

export interface DraftConfig {
  rankingsPath: string;
  league: LeagueSettings;
  /** Seconds to let the user override before we auto-pick. */
  overrideWindowSec: number;
  /** Poll interval while waiting for our turn. */
  pollMs: number;
}

export async function runDraft(page: Page, cfg: DraftConfig): Promise<void> {
  const rankings = loadRankings(cfg.rankingsPath);
  const baselines = replacementBaselines(rankings, cfg.league);
  const valued = withVOR(rankings, baselines);

  // Simple loop; refined once readBoard/makePick are real.
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const board: BoardState = await readBoard(page);
    if (!board.onTheClock) {
      await sleep(cfg.pollMs);
      continue;
    }

    const drafted = new Set(board.availableNames.length ? [] : []); // board gives available already
    const availableSet = new Set(board.availableNames.map(norm));
    const available = valued.filter((p) => availableSet.has(norm(p.name)));
    const ranked = rankForPick(available);
    const pick = ranked[0];
    if (!pick) {
      console.warn("No ranked player matched the board -- deferring to user.");
      await sleep(cfg.pollMs);
      continue;
    }

    console.log(
      `ON THE CLOCK. Intended pick: ${pick.name} (${pick.pos}, ${pick.team}) ` +
        `score=${pick.score.toFixed(1)} vor=${pick.vor.toFixed(1)}. ` +
        `Override window: ${cfg.overrideWindowSec}s.`,
    );
    // Override window: if the user picks manually, the next readBoard will show we are
    // no longer on the clock and we simply continue.
    await sleep(cfg.overrideWindowSec * 1000);
    const still = await readBoard(page);
    if (!still.onTheClock) {
      console.log("User made the pick during the override window -- handing back.");
      continue;
    }
    await makePick(page, pick.name);
    console.log(`Picked ${pick.name}.`);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
