// Why does the auction render a selected player but NO bid controls? A prime suspect is page
// visibility/focus: a backgrounded or hidden webview reports document.hidden, and ESPN's draft
// client can render a reduced UI. Also dump the selected-player panel so we can see what IS there.
import { attachWebview } from "../src/browser/webviewPage.ts";

const { browser, raw } = await attachWebview();
try {
  const out = await raw.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="player-selected"]');
    const panel = sel ? (sel.closest('div[class*="auction"],div[class*="Auction"],section,div') || sel) : null;
    return {
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      selectedText: sel ? (sel.innerText||'').replace(/\\n/g,' | ').slice(0,300) : null,
      panelText: panel ? (panel.innerText||'').replace(/\\n/g,' | ').slice(0,600) : null,
      // Anything that looks like the bid area, by any name
      classHits: Array.from(document.querySelectorAll('*'))
        .filter(e => /bid|offer|nominat/i.test((e.className||'').toString()))
        .map(e => e.tagName + '.' + (e.className||'').toString().slice(0,60)).slice(0,20),
      myTeamRow: (() => {
        const el = Array.from(document.querySelectorAll('*')).find(e => /King Henry/.test(e.textContent||'') && (e.children||[]).length < 5);
        return el ? (el.textContent||'').slice(0,120) : null;
      })(),
    };
  })()`);
  console.log(JSON.stringify(out, null, 1).slice(0, 2500));
} finally {
  await browser.close().catch(() => {});
}
