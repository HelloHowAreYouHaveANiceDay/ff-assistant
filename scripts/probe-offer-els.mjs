// Pin down the ACTUAL offer controls. espnAuction expects button.bid-player__button and
// form.bidding-form__custom; the room renders bidding-form__* and no matching <button>. Dump the
// real tag/class/attrs of everything whose text is an OFFER control, plus the form + inputs.
import { attachWebview } from "../src/browser/webviewPage.ts";

const { browser, raw } = await attachWebview();
try {
  const out = await raw.evaluate(`(() => {
    const desc = (e) => ({
      tag: e.tagName,
      type: e.getAttribute('type'),
      cls: (e.className||'').toString().slice(0,90),
      text: (e.innerText||e.value||'').trim().slice(0,30),
      disabled: !!e.disabled,
      kids: e.children.length,
    });
    const all = Array.from(document.querySelectorAll('*'));
    const offers = all.filter(e => e.children.length <= 1 && /^offer(\\s*\\$\\d+)?$/i.test(((e.innerText||e.value||'')+'').trim()));
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      cls: (f.className||'').toString().slice(0,90),
      inputs: Array.from(f.querySelectorAll('input')).map(desc),
      btns: Array.from(f.querySelectorAll('button,input[type=submit]')).map(desc),
    }));
    return { offers: offers.map(desc), forms };
  })()`);
  console.log(JSON.stringify(out, null, 1).slice(0, 3000));
} finally {
  await browser.close().catch(() => {});
}
