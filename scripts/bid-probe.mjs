// Does a BID actually land through the webview shim? Bidding and losing looks exactly like clicking
// into the void: both leave us with 0 players and $200. This drives the real quickBid()/jumpBid()
// from espnAuction.ts and checks the auction state CHANGED as a result -- the only signal that
// separates the two.
import { attachWebview } from "../src/browser/webviewPage.ts";
import { readBlock, quickBid, jumpBid } from "../src/draft/espnAuction.ts";

const mode = process.argv[2] === "jump" ? "jump" : "quick";
const { browser, page, raw } = await attachWebview();
try {
  const before = await readBlock(page);
  console.log("BEFORE:", JSON.stringify(before));
  if (!before.onBlock) { console.log("nothing on the block -- rerun during an active nomination"); process.exit(2); }

  // Is the control even there? A disabled/absent button is a different failure than a dead click.
  const btn = raw.locator("button.bid-player__button", { hasText: /Offer\s*\$\d+/i }).first();
  console.log(`bid button: count=${await btn.count()} disabled=${await btn.isDisabled()}`);
  const custom = raw.locator("form.bidding-form__custom");
  console.log(`custom offer form: count=${await custom.count()}`);

  const ok = mode === "jump"
    ? await jumpBid(page, Math.max(2, (before.currentOffer ?? 1) + 3))
    : await quickBid(page);
  console.log(`${mode}Bid() returned: ${ok}`);

  await new Promise((r) => setTimeout(r, 2500));
  const after = await readBlock(page);
  console.log("AFTER: ", JSON.stringify(after));

  const moved = (after.currentOffer ?? 0) > (before.currentOffer ?? 0)
    || after.quickBidLabel !== before.quickBidLabel
    || after.canBid !== before.canBid;
  console.log(moved
    ? "\nRESULT: the auction state CHANGED -- the click reached ESPN."
    : "\nRESULT: NOTHING CHANGED -- the bid did not land (or we were already high bidder).");
} finally {
  await browser.close().catch(() => {});
}
