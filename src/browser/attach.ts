// Copresent browser attach (D0): connect to the USER'S already-running, logged-in
// Chrome/Edge over the DevTools Protocol -- mirrors the bro pattern
// (chromium.connectOverCDP on a --remote-debugging-port). We never launch a fresh,
// logged-out browser for real actions; we join the session the user is present in.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export interface Attached {
  browser: Browser;
  context: BrowserContext;
  /** All open pages across the connected browser's contexts. */
  pages: Page[];
}

const DEFAULT_PORT = 9222;

/** Connect to a running browser exposing a CDP endpoint on 127.0.0.1:<port>. */
export async function attach(port: number = DEFAULT_PORT): Promise<Attached> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (err) {
    throw new Error(
      `Could not attach to a browser on CDP port ${port}. ` +
        `Launch one first (npm run chrome), and make sure you are logged into ESPN in it. ` +
        `Underlying error: ${(err as Error).message}`,
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
