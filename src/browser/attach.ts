// Copresent browser attach (D0): connect to the USER'S already-running, logged-in
// browser over the DevTools Protocol. The session is OWNED BY bro (D2) -- bro launched
// it with a persistent profile and holds the login; ff just joins it via
// chromium.connectOverCDP. We never launch or log in a browser ourselves.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { resolveLivePort } from "./bro.js";

// Domain that identifies each bro site's live browser (for robust port resolution).
const SITE_DOMAIN: Record<string, string> = { espn: "espn.com", yahoo: "yahoo.com" };

export interface Attached {
  browser: Browser;
  context: BrowserContext;
  /** All open pages across the connected browser's contexts. */
  pages: Page[];
}

/** Attach to the browser bro is holding for `site`. Resolves the CDP port robustly (bro's
 *  registry port can be stale -- verify by finding the port whose tabs contain the site domain). */
export async function attachBro(site = "espn"): Promise<Attached> {
  const domain = SITE_DOMAIN[site] ?? `${site}.com`;
  const port = await resolveLivePort(site, domain);
  return attach(port);
}

/** Connect to a running browser exposing a CDP endpoint on 127.0.0.1:<port>. */
export async function attach(port: number): Promise<Attached> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (err) {
    throw new Error(
      `Could not attach to a browser on CDP port ${port}. ` +
        `Start a bro session first (npm run ff -- bro session start espn) and log in. ` +
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
