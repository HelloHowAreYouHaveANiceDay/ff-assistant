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

export function browserTools(tool: Tool): unknown[] {
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

    // --- LIVE DRAFT: reads --------------------------------------------------------------------
    tool(
      "read_block",
      "Read the player currently ON THE BLOCK in the live auction: name, position, current offer, ESPN's pre-draft value, your legal max bid, and whether you can bid right now. This is the engine's own reader (espnAuction.readBlock), not a text scrape.",
      {},
      (async () => {
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
