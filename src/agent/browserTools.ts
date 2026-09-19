// The BROWSER + LIVE DRAFT half of the control surface, factored out of agent.ts so the surface can
// grow without that file becoming unreadable. Everything here is exposed to BOTH consumers (the
// in-app Assistant and any external MCP client) because they are built from one tool array.
//
// Two groups:
//   1. Generic page primitives -- fill / scroll / read_dom / wait_for. The surface previously had
//      only navigate + read_page + click_page, which meant an external agent could browse and click
//      but could not type, so it could not complete a form (jump-bidding needs exactly that).
//   2. LIVE DRAFT reads and actions -- these delegate to src/draft/espnAuction.ts through the
//      webview Page shim. They do NOT reimplement any reader or actor: espnAuction is the
//      live-verified layer and a second copy of it would drift from the one the engine uses.
//
// DECISION NOTE (extends D10): the deterministic `auto-draft` loop is unchanged and remains the way
// the draft is actually run. These tools add a MANUAL/agent-driven path beside it, for a human or an
// external agent to read state and act deliberately. Nothing here runs inside the bid loop.
import { z } from "zod";
import type { Page } from "playwright-core";

type Tool = (name: string, desc: string, schema: Record<string, z.ZodTypeAny>, fn: (a: Record<string, never>) => Promise<{ content: { type: "text"; text: string }[] }>) => unknown;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Attach to the app's embedded ESPN webview as a Playwright-shaped Page. Every draft tool below
 *  goes through this, so they all see exactly what `ff auto-draft --app` sees. */
async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T | string> {
  const { attachWebview } = await import("../browser/webviewPage.js");
  let browser;
  try {
    const w = await attachWebview();
    browser = w.browser;
    await w.raw.refreshUrl();
    return await fn(w.page);
  } catch (e) {
    return `app/webview not available: ${String(e).slice(0, 160)}`;
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Run JS inside the webview guest via the renderer, JSON round-tripped. */
async function guestEval(js: string): Promise<unknown> {
  return await withPage(async (page) => (page as unknown as { evaluate: (s: string) => Promise<unknown> }).evaluate(js));
}

/**
 * THE ACTIVE LEAGUE'S PLATFORM AND THE GUEST THAT HOLDS ITS LOGIN (P-6).
 *
 * The app mounts ONE webview per platform, each on its own persistent partition, so both stay signed
 * in at once. Every tool below used to address the ESPN one unconditionally: on a Yahoo active league
 * `read_frame`/`press` read and clicked ESPN's pages and returned the result as the answer about a
 * league that is not on ESPN. Passing the host from the league row is what makes that impossible.
 *
 * Falls back to ESPN when the store cannot be read or names no league, which is exactly the old
 * behaviour for the one case where the old behaviour was right.
 */
async function activePlatform(dbPath?: string): Promise<{ id: string; host: string; known: boolean }> {
  try {
    const { openDb } = await import("../db/db.js");
    const { resolveLeagueContext } = await import("../data/leagueContext.js");
    const db = openDb(dbPath);
    let raw: string | null;
    try { raw = resolveLeagueContext(db, undefined).platformRaw; } finally { db.close(); }
    if (!raw) return { id: "espn", host: "espn.com", known: true };
    const { platformFor } = await import("../league/platform.js");
    try { const p = await platformFor(raw); return { id: p.id, host: p.host, known: true }; }
    catch { return { id: raw, host: "", known: false }; }
  } catch { return { id: "espn", host: "espn.com", known: true }; }
}

/**
 * REFUSE AN ESPN-DRAFT-ROOM TOOL ON A NON-ESPN LEAGUE, BY NAME.
 *
 * `read_block`/`read_turn`/`read_draft_roster`/`place_bid`/`nominate_player` speak ESPN's auction DOM
 * through `src/draft/espnAuction.ts`. There is no platform-neutral version of them and there cannot
 * be one until another platform's draft room is read; pointing them at a Yahoo league would return
 * ESPN's room, or nothing, with no way for the reader to tell which. `place_bid` is the one that
 * spends money, so this guard is in front of an irreversible act, not only a read.
 */
async function draftRoomRefusal(dbPath: string | undefined, toolName: string): Promise<string | null> {
  const p = await activePlatform(dbPath);
  if (p.id === "espn") return null;
  return `${toolName} REFUSED: the active league is on "${p.id}" and this tool drives the ESPN auction draft room (src/draft/espnAuction.ts). ` +
    `There is no ${p.id} draft-room adaptor. Switch the active league to an ESPN one (the app's league tabs) or read the room by hand.`;
}

export function browserTools(tool: Tool, dbPath?: string): unknown[] {
  return [
    tool(
      "fill_page",
      "Type a value into an input/textarea in the embedded ESPN page, by CSS selector. Uses the native value setter + input/change events so REACT actually registers it (a plain assignment is silently ignored by React-controlled fields). Needed for any form, including the draft room's manual-offer box.",
      {
        selector: z.string().describe("CSS selector of the input, e.g. 'form.bidding-form__custom input'"),
        value: z.string().describe("text to type"),
      },
      (async (args: { selector: string; value: string }) => {
        const js = `(() => {
          const e = document.querySelector(${JSON.stringify(args.selector)});
          if (!e) return "NOTFOUND";
          const proto = e.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          e.focus(); setter.call(e, ${JSON.stringify(args.value)});
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
          return "OK:" + e.value;
        })()`;
        const r = await guestEval(js);
        return text(r === "NOTFOUND" ? `no element matched ${args.selector}` : String(r));
      }) as never,
    ),
    tool(
      "scroll_page",
      "Scroll the embedded page, or a scrollable element within it. ESPN's draft board is VIRTUALISED -- only ~18 rows exist in the DOM at once -- so reading the full board requires scrolling between reads.",
      {
        selector: z.string().optional().describe("CSS selector of the scrollable element; omit to scroll the window"),
        dy: z.number().optional().describe("pixels to scroll vertically, default 400; negative scrolls up"),
      },
      (async (args: { selector?: string; dy?: number }) => {
        const dy = Math.round(args.dy ?? 400);
        // ESPN's draft board is a VIRTUALISED fixed-data-table: it renders ~18 rows and listens for
        // WHEEL events. Assigning scrollTop on it does nothing (verified live -- it stayed 0), so
        // scroll by (a) walking up to a genuinely scrollable ancestor and setting scrollTop, AND
        // (b) dispatching a real wheel event, which is what the virtualiser actually consumes.
        const js = args.selector
          ? `(() => {
              const t = document.querySelector(${JSON.stringify(args.selector)});
              if (!t) return "NOTFOUND";
              let e = t, before = -1;
              while (e && e.scrollHeight <= e.clientHeight) e = e.parentElement;
              if (e) { before = e.scrollTop; e.scrollTop += ${dy}; }
              t.dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy}, bubbles: true, cancelable: true }));
              const after = e ? e.scrollTop : null;
              return JSON.stringify({ scrolledEl: e ? (e.className||e.tagName).toString().slice(0,40) : null,
                                      before, after, wheel: ${dy} });
            })()`
          : `(() => { window.scrollBy(0, ${dy}); return "y=" + window.scrollY; })()`;
        const r = await guestEval(js);
        return text(r === "NOTFOUND" ? `no element matched ${args.selector}` : String(r));
      }) as never,
    ),
    tool(
      "read_dom",
      "Read STRUCTURED elements from the embedded page (tag, text, key attributes, disabled state) rather than the flat visible text read_page gives. Use when you need to know what is clickable, what a button's exact label is, or whether a control is disabled.",
      {
        selector: z.string().describe("CSS selector, e.g. 'button' or '.players-table tr'"),
        limit: z.number().optional().describe("max elements, default 25"),
      },
      (async (args: { selector: string; limit?: number }) => {
        const lim = Math.min(Math.max(1, args.limit ?? 25), 100);
        const js = `(() => {
          const out = [];
          const els = document.querySelectorAll(${JSON.stringify(args.selector)});
          for (let i = 0; i < els.length && out.length < ${lim}; i++) {
            const e = els[i];
            const r = e.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            out.push({ tag: e.tagName, text: (e.innerText || e.value || '').trim().slice(0, 80),
              cls: (e.className || '').toString().slice(0, 60), disabled: !!e.disabled,
              href: e.getAttribute && e.getAttribute('href') || undefined });
          }
          return JSON.stringify({ matched: els.length, shown: out.length, els: out });
        })()`;
        return text(String(await guestEval(js)).slice(0, 3500));
      }) as never,
    ),
    tool(
      "wait_for",
      "Wait until text or a selector appears in the embedded page (polls up to timeoutMs). ESPN renders late and asynchronously; without this an agent reads an empty page and wrongly concludes something is absent.",
      {
        text: z.string().optional().describe("visible text to wait for"),
        selector: z.string().optional().describe("CSS selector to wait for"),
        timeoutMs: z.number().optional().describe("give up after this long, default 15000, max 60000"),
      },
      (async (args: { text?: string; selector?: string; timeoutMs?: number }) => {
        const deadline = Date.now() + Math.min(args.timeoutMs ?? 15000, 60000);
        const probe = args.selector
          ? `(() => !!document.querySelector(${JSON.stringify(args.selector)}))()`
          : `(() => ((document.body && document.body.innerText) || '').indexOf(${JSON.stringify(args.text ?? "")}) >= 0)()`;
        for (;;) {
          if (await guestEval(probe) === true) return text("found");
          if (Date.now() >= deadline) return text(`TIMEOUT: ${args.selector ?? args.text} did not appear`);
          await new Promise((r) => setTimeout(r, 400));
        }
      }) as never,
    ),
    tool(
      "read_frame",
      "Read text from a NESTED IFRAME inside the embedded ESPN page -- e.g. the Fantasy Chat / direct-message panel, which read_page and read_dom CANNOT see because it is a cross-origin child frame walled off from the top document. Call with NO `match` to list every frame's URL; call with `match` (a substring of the target frame's URL) to get that frame's visible text, optionally scoped to a CSS `selector`. Open the chat panel in the UI first so the frame exists.",
      {
        match: z.string().optional().describe("substring of the target frame's URL; omit to list all frames"),
        selector: z.string().optional().describe("CSS selector within the frame to scope the read; omit for the whole frame body"),
        scrollUp: z.boolean().optional().describe("wheel the frame's largest scrollable area to the top before reading, to load earlier messages in a virtualized chat list"),
      },
      (async (args: { match?: string; selector?: string; scrollUp?: boolean }) => {
        try {
          const { bridgeReadFrame } = await import("../browser/appBridge.js");
          // THE GUEST THAT HOLDS THE ACTIVE LEAGUE'S LOGIN, not always ESPN's (P-6).
          const plat = await activePlatform(dbPath);
          if (!plat.known) return text(`read_frame REFUSED: the active league is on "${plat.id}", which this build has no webview for -- there is nothing to read.`);
          const r = await bridgeReadFrame({ match: args.match, selector: args.selector, scrollUp: args.scrollUp, host: plat.host });
          if (r.frames) return text("frames (" + r.frames.length + "):\n" + r.frames.map((f) => `- ${f.name || "(top)"}: ${f.url}`).join("\n"));
          if (r.text === "__NOSEL__") return text(`frame ${r.url}: no element matched ${args.selector}`);
          return text(`[${r.url}]\n` + String(r.text ?? "").slice(0, 8000));
        } catch (e) {
          return text(`read_frame failed: ${String(e).slice(0, 200)}`);
        }
      }) as never,
    ),
    tool(
      "press",
      "HARDENED click for controls that a plain click_page does not activate -- e.g. the Fantasy Chat toggle or any React onClick on a non-button element. It dispatches the full bubbling pointer/mouse/click sequence (the fill_page lesson, for clicks), not just el.click(). Target by CSS `selector` or visible `text`; the smallest visible match wins. Pass `frame` (a substring of a nested iframe's URL, e.g. 'chat.espn.com') to click INSIDE that cross-origin frame, which read_page/click_page cannot reach. Use click_page for ordinary buttons/links; reach for this when a click seems to do nothing or the target is inside an iframe.",
      {
        selector: z.string().optional().describe("CSS selector of the control to click"),
        text: z.string().optional().describe("visible text of the control (used when selector is omitted)"),
        nth: z.number().optional().describe("which match to click when several tie, 0-based (default 0)"),
        frame: z.string().optional().describe("substring of a nested iframe's URL to click inside (e.g. 'chat.espn.com'); omit for the top document"),
      },
      (async (args: { selector?: string; text?: string; nth?: number; frame?: string }) => {
        if (!args.selector && !args.text) return text("give a selector or text");
        try {
          const { bridgeClick } = await import("../browser/appBridge.js");
          const plat = await activePlatform(dbPath);
          if (!plat.known) return text(`press REFUSED: the active league is on "${plat.id}", which this build has no webview for -- there is nothing to click.`);
          const r = await bridgeClick({ selector: args.selector, text: args.text, nth: args.nth, frame: args.frame, host: plat.host });
          if (!r.ok) return text(`press: ${r.err === "NOMATCH" ? `no visible element matched ${args.selector ?? `"${args.text}"`}` : (r.err ?? "failed")}`);
          return text(`pressed: ${r.clicked}${r.popup ? ` (captured popup -> ${r.popup})` : ""}`);
        } catch (e) {
          return text(`press failed: ${String(e).slice(0, 200)}`);
        }
      }) as never,
    ),

    // --- LIVE DRAFT: reads --------------------------------------------------------------------
    tool(
      "read_block",
      "Read the player currently ON THE BLOCK in the live auction: name, position, current offer, ESPN's pre-draft value, your legal max bid, and whether you can bid right now. This is the engine's own reader (espnAuction.readBlock), not a text scrape.",
      {},
      (async () => {
        const refuse = await draftRoomRefusal(dbPath, "read_block");
        if (refuse) return text(refuse);
        const r = await withPage(async (page) => {
          const { readBlock } = await import("../draft/espnAuction.js");
          return await readBlock(page);
        });
        return text(typeof r === "string" ? r : JSON.stringify(r, null, 1));
      }) as never,
    ),
    tool(
      "read_turn",
      "Is it OUR turn to nominate? Reads the live draft room (espnAuction.readTurn): whether a player is on the block, whether a nomination control is enabled, and which team is nominating.",
      {},
      (async () => {
        const refuse = await draftRoomRefusal(dbPath, "read_turn");
        if (refuse) return text(refuse);
        const r = await withPage(async (page) => {
          const { readTurn } = await import("../draft/espnAuction.js");
          return await readTurn(page);
        });
        return text(typeof r === "string" ? r : JSON.stringify(r));
      }) as never,
    ),
    tool(
      "read_draft_roster",
      "Read MY roster AS ESPN SEES IT in the live draft room -- filled/open slots, spend, and who occupies each slot. Distinct from read_my_team, which reads our own local store; use this one to check what actually happened in the room.",
      {},
      (async () => {
        const refuse = await draftRoomRefusal(dbPath, "read_draft_roster");
        if (refuse) return text(refuse);
        const r = await withPage(async (page) => {
          const { readRoster } = await import("../draft/espnAuction.js");
          const x = await readRoster(page);
          return { filled: x.filled, open: x.open, spent: x.spent, openByBase: x.openByBase,
            flexOpen: x.flexOpen, benchOpen: x.benchOpen,
            slots: x.slots.filter((s) => s.player).map((s) => `${s.slot} ${s.player} $${s.price}`) };
        });
        return text(typeof r === "string" ? r : JSON.stringify(r, null, 1));
      }) as never,
    ),

    // --- LIVE DRAFT: actions ------------------------------------------------------------------
    tool(
      "place_bid",
      "Place a REAL bid on the player currently on the block. Omit `amount` for the one-click quick bid (current offer + 1). With `amount`, jump-bids to that figure. HARD GUARD: the bid is clamped to ESPN's own legal max for your budget, and refused outright if nothing is on the block or you cannot bid. This spends real money in a live auction -- read_block first.",
      {
        amount: z.number().optional().describe("jump-bid to this dollar figure; omit for a +1 quick bid"),
        confirm: z.boolean().optional().describe("must be true to place a jump bid above the quick-bid amount"),
      },
      (async (args: { amount?: number; confirm?: boolean }) => {
        const refuse = await draftRoomRefusal(dbPath, "place_bid");
        if (refuse) return text(refuse);
        const r = await withPage(async (page) => {
          const { readBlock, quickBid, jumpBid } = await import("../draft/espnAuction.js");
          const b = await readBlock(page);
          if (!b.onBlock || !b.player) return "nothing is on the block";
          if (!b.canBid) return `cannot bid on ${b.player} right now (you may already be high bidder)`;
          if (args.amount == null) {
            const ok = await quickBid(page);
            return ok ? `quick bid placed on ${b.player} (was $${b.currentOffer})` : `quick bid FAILED on ${b.player}`;
          }
          // A jump bid is the one that can overspend, so it needs an explicit confirm AND is clamped
          // to ESPN's legal max -- an agent cannot talk itself past the budget.
          if (args.confirm !== true) return `refused: jump-bidding $${args.amount} on ${b.player} needs confirm:true`;
          const legal = b.myMax ?? Infinity;
          const amt = Math.min(Math.floor(args.amount), legal);
          if (!(amt > (b.currentOffer ?? 0))) return `refused: $${amt} is not above the current offer $${b.currentOffer}`;
          const ok = await jumpBid(page, amt);
          return ok
            ? `jump bid $${amt} placed on ${b.player}${amt !== Math.floor(args.amount) ? ` (clamped from $${args.amount} by ESPN max $${legal})` : ""}`
            : `jump bid FAILED on ${b.player}`;
        });
        return text(String(r));
      }) as never,
    ),
    tool(
      "nominate_player",
      "Nominate a player in the live draft room (clicks their board Select). Only works on our nomination turn and only for a player currently VISIBLE on the virtualised board -- scroll_page the board first if they are not. Check read_turn before calling.",
      { name: z.string().describe("exact player name as ESPN shows it") },
      (async (args: { name: string }) => {
        const refuse = await draftRoomRefusal(dbPath, "nominate_player");
        if (refuse) return text(refuse);
        const r = await withPage(async (page) => {
          const { nominate } = await import("../draft/espnAuction.js");
          const ok = await nominate(page, args.name);
          return ok ? `nominated ${args.name}` : `could not nominate ${args.name} (not our turn, or not visible on the board)`;
        });
        return text(String(r));
      }) as never,
    ),
  ];
}
