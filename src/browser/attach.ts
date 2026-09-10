// Low-level CDP attach. The DESKTOP APP is the browser -- it holds the authenticated ESPN session in
// its own persistent partition and is always a CDP target (see browser/webviewPage.ts, which is what
// every verb goes through). This file is the raw connect underneath that, plus the `--port` escape
// hatch for a manually-launched Chrome.
//
// The `bro` subdriver this was written for is gone. It owned a SECOND browser with a second login and
// a second profile the user had to remember to start, and it was the DEFAULT while the app was the
// special case -- the dependency backwards from what the app made possible.

import { type Browser, type BrowserContext, type Page } from "playwright-core";

export interface Attached {
  browser: Browser;
  context: BrowserContext;
  /** All open pages across the connected browser's contexts. */
  pages: Page[];
}

/** Return the first open page whose URL matches a substring (e.g. "espn.com"). */
export function findPage(a: Attached, urlSubstring: string): Page | undefined {
  return a.pages.find((p) => p.url().includes(urlSubstring));
}

/** Detach WITHOUT closing the user's browser -- we only disconnect our client. */
export async function detach(a: Attached): Promise<void> {
  // With connectOverCDP, browser.close() disconnects the client; it does not kill
  // the user's browser process. That is exactly the copresent contract.
  await a.browser.close();
}
