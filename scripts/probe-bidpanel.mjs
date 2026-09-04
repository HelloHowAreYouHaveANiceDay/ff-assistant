// The bid controls espnAuction expects (button.bid-player__button, form.bidding-form__custom) are
// absent. Find out what the room actually renders: any Offer-ish button, anything class-matching
// bid/offer, and whether the draft app is in an iframe.
import { attachWebview } from "../src/browser/webviewPage.ts";

const { browser, raw } = await attachWebview();
try {
  const out = await raw.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({
      t: (b.innerText||'').trim().slice(0,40), c: (b.className||'').toString().slice(0,60), d: !!b.disabled,
    })).filter(b => b.t);
    const bidish = Array.from(document.querySelectorAll('[class*="bid"],[class*="Bid"],[class*="offer"],[class*="Offer"]'))
      .map(e => e.tagName + '.' + (e.className||'').toString().slice(0,70)).slice(0,25);
    return {
      url: location.href,
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => (f.src||'').slice(0,80)),
      nButtons: btns.length,
      buttons: btns.slice(0, 30),
      bidish,
      hasSelected: !!document.querySelector('[data-testid="player-selected"]'),
      bodyLen: (document.body.innerText||'').length,
    };
  })()`);
  console.log(JSON.stringify(out, null, 1).slice(0, 3000));
} finally {
  await browser.close().catch(() => {});
}
