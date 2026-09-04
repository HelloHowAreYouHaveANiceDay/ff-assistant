// Positive control for the webview Page shim. `read-block` returning nulls outside a draft room is
// CORRECT, and therefore proves nothing -- a shim that always returns null looks identical. This
// drives the shim against DOM we know exists and asserts it comes back non-empty, exercising every
// operation espnAuction depends on: evaluate, locator+css, hasText, has, first, count, isDisabled,
// boundingBox, and goto.
import { attachWebview } from "../src/browser/webviewPage.ts";

let bad = 0;
const gate = (ok, msg, extra = "") => { console.log((ok ? "PASS  " : "FAIL  ") + msg + (extra ? "  " + extra : "")); if (!ok) bad++; };

const { browser, raw } = await attachWebview();
try {
  await raw.goto("https://fantasy.espn.com/football/mockdraftlobby");
  const url = await raw.refreshUrl();
  gate(/mockdraftlobby/.test(url), "goto navigated the guest", url);

  const title = await raw.title();
  gate(/mock draft/i.test(title), "evaluate reads document.title", title);

  const len = await raw.evaluate("(document.body.innerText||'').length");
  gate(Number(len) > 500, "evaluate returns real page text", `${len} chars`);

  const anchors = await raw.locator("a").count();
  gate(anchors > 10, "locator(css).count()", `${anchors} anchors`);

  // The exact control the practice launcher needs.
  const btn = raw.locator("button", { hasText: /^Practice Draft$/ }).first();
  const n = await btn.count();
  gate(n === 1, "locator + hasText finds the Practice Draft button", `count=${n}`);
  if (n === 1) {
    gate((await btn.isDisabled()) === false, "isDisabled() returns FALSE for an enabled button");
    const box = await btn.boundingBox();
    gate(!!box && box.width > 0, "boundingBox() returns real geometry", JSON.stringify(box));
  }

  // `has` (used by nominate to find a board row containing a player cell).
  const rowsWithLink = await raw.locator("tr", { has: raw.locator("a") }).count();
  const rowsAll = await raw.locator("tr").count();
  gate(rowsAll > 0 && rowsWithLink <= rowsAll, "locator({has}) filters rows", `${rowsWithLink}/${rowsAll}`);

  // A selector that must NOT match -- proves the resolver can also return zero (not just "always 1").
  const none = await raw.locator("button", { hasText: /ZZZ_no_such_button_ZZZ/ }).count();
  gate(none === 0, "a non-matching hasText returns 0 (resolver is not stuck)", `count=${none}`);
} finally {
  await browser.close().catch(() => {});
}
console.log(bad === 0 ? "\nWEBVIEW SHIM SELFTEST PASSED" : `\n${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
