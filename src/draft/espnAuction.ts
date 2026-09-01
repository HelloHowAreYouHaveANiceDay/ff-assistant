// ESPN AUCTION draft-room reader/actor (copresent, D0). Grounded in selectors captured
// live from a real practice auction (league 462233 is a 16-team $200 salary-cap auction).
// Anchor on data-testid and semantic classes, NOT the volatile jsx-<hash> classes.
//
// Key finding: ESPN renders a per-player "Pre-Draft Val: $N" (span.player-default-bid) --
// a ready-made auction value we can use as the valuation baseline for v1 bidding.

import type { Page } from "playwright-core";

export interface BlockState {
  onBlock: boolean;
  player: string | null; // player currently nominated / on the block
  currentOffer: number | null; // current high bid, $
  myMax: number | null; // our max allowed bid, $ ("Manual offer (max $X)")
  preDraftVal: number | null; // ESPN's suggested auction value for the player, $
  quickBidLabel: string | null; // e.g. "Offer $100" (current + 1)
}

const dollars = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$(\d+)/);
  return m ? Number(m[1]) : null;
};

/** Read who is on the block, the current offer, our max, and ESPN's pre-draft value. */
export async function readBlock(page: Page): Promise<BlockState> {
  const snap = (await page.evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const txt = (el) => (el && el.textContent ? el.textContent.trim() : null);
    const sel = q('[data-testid="player-selected"]');
    const name = txt(q('[data-testid="player-selected"] .playerinfo__playername'));
    const nominated = txt(q('[class*="player-nominated-fo"]'));   // "Current offer: $99 Manual offer (max $189)"
    const preVal = txt(q('.player-default-bid'));                 // "Pre-Draft Val: $98"
    const bidBtn = Array.from(document.querySelectorAll('button.bid-player__button'))
      .map((b) => (b.textContent || '').trim()).find((t) => /offer\\s*\\$\\d+/i.test(t)) || null;
    return { hasBlock: !!sel, name, nominated, preVal, bidBtn };
  })()`)) as { hasBlock: boolean; name: string | null; nominated: string | null; preVal: string | null; bidBtn: string | null };

  // "Current offer: $99 Manual offer (max $189)" -> two numbers.
  let currentOffer: number | null = null;
  let myMax: number | null = null;
  if (snap.nominated) {
    const nums = snap.nominated.replace(/,/g, "").match(/\$(\d+)/g) || [];
    if (nums[0]) currentOffer = Number(nums[0].slice(1));
    if (nums[1]) myMax = Number(nums[1].slice(1));
  }
  return {
    onBlock: snap.hasBlock,
    player: snap.name,
    currentOffer,
    myMax,
    preDraftVal: dollars(snap.preVal),
    quickBidLabel: snap.bidBtn,
  };
}

/** Place the one-click quick bid (the "Offer $X" button = current high + $1). */
export async function quickBid(page: Page): Promise<boolean> {
  const btn = page.locator("button.bid-player__button", { hasText: /Offer\s*\$\d+/i }).first();
  if ((await btn.count()) === 0 || (await btn.isDisabled().catch(() => true))) return false;
  await btn.click({ timeout: 4000 }).catch(() => {});
  return true;
}

// TODO (grounded, from data/auction-live.json):
// - readBudgets(): ul.picklist rows -> per-team remaining $ (the "$200 / $null" list).
// - readBoard(): div.fixedDataTableLayout_main (virtualized; scroll to read all) -> available
//   players + their Pre-Draft Val, to decide WHAT to nominate and our max per player.
// - nominate(playerName): when it's our nomination turn, pick from the board + confirm.
// - bidHistory(): ul.bid-history__list li.bid -> "$62 <team>" for pace/read.
