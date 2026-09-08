// Low-level CDP attach. The DESKTOP APP is the browser -- it holds the authenticated ESPN session in
// its own persistent partition and is always a CDP target (see browser/webviewPage.ts, which is what
// every verb goes through). This file is the raw connect underneath that, plus the `--port` escape
// hatch for a manually-launched Chrome.
//
// The `bro` subdriver this was written for is gone. It owned a SECOND browser with a second login and
// a second profile the user had to remember to start, and it was the DEFAULT while the app was the
// special case -- the dependency backwards from what the app made possible.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export interface Attached {
  browser: Browser;
  context: BrowserContext;
  /** All open pages across the connected browser's contexts. */
  pages: Page[];
}

/** Connect to a running browser exposing a CDP endpoint on 127.0.0.1:<port>. */
export async function attach(port: number): Promise<Attached> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (err) {
    throw new Error(
      `Could not attach to a browser on CDP port ${port}.\n` +
        `  Open the desktop app (cd app && npm start) -- it exposes CDP on 9223 and holds the ESPN login.\n` +
        `  If it IS open, its debugging port did not bind: check MC_NO_CDP is unset, or pass MC_CDP_PORT.\n` +
        `  Underlying error: ${(err as Error).message}`,
    );
  }
  // connectOverCDP exposes the real browser's existing context(s), not a fresh one.
  const context = browser.contexts()[0];
  if (!context) throw new Error("Attached browser has no context/tab open.");
  const pages = browser.contexts().flatMap((c) => c.pages());
  return { browser, context, pages };
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
