#!/usr/bin/env tsx
// The `ff` CLI -- the engine (D7). Runnable in a terminal for iteration; the
// unattended agent will later reach a constrained subset of these as tools.
//
//   npm run ff -- attach            test the copresent CDP connection, list tabs
//   npm run ff -- inspect-draft     dump the live ESPN draft-room DOM to a file
//   npm run ff -- rank              print top players by VOR from the rankings CSV
//   npm run ff -- mock              run the draft loop (needs real selectors first)

import { attach, attachBro, findPage, detach, type Attached } from "./browser/attach.js";
import { passthrough as broPassthrough } from "./browser/bro.js";
import { inspectDraftDom } from "./draft/espnReader.js";
import { loadRankings } from "./data/rankings.js";
import { replacementBaselines, withVOR, type LeagueSettings } from "./draft/rank.js";
import { runDraft } from "./draft/loop.js";

const DEFAULT_LEAGUE: LeagueSettings = {
  teams: 10,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "bro":
      // Passthrough to the bro CLI: `ff bro session start espn`, `ff bro sessions`, ...
      return void process.exit(broPassthrough(rest));
    case "attach":
      return cmdAttach(rest);
    case "goto":
      return cmdGoto(rest);
    case "click":
      return cmdClick(rest);
    case "text":
      return cmdText(rest);
    case "launch-practice":
      return cmdLaunchPractice(rest);
    case "read-block":
      return cmdReadBlock(rest);
    case "bid":
      return cmdBid(rest);
    case "roster":
      return cmdRoster(rest);
    case "auto-bid":
      return cmdAutoBid(rest);
    case "auto-draft":
      return cmdAutoDraft(rest);
    case "inspect-draft":
      return cmdInspect(rest);
    case "rank":
      return cmdRank(rest);
    case "mock":
      return cmdMock(rest);
    default:
      console.log(
        "commands:\n" +
          "  bro <args...>              passthrough to the bro CLI (e.g. bro session start espn)\n" +
          "  attach [--site espn|--port N]   test the copresent connection to bro's session\n" +
          "  goto <url> [--site]        navigate the copresent session\n" +
          "  inspect-draft [--out FILE] dump the live ESPN draft-room DOM\n" +
          "  rank [--csv FILE]          top players by VOR (offline)\n" +
          "  mock [--csv FILE]          run the draft loop (needs real selectors)",
      );
  }
}

// Attach via bro's session by default; allow --port for a manually-launched browser.
async function attachFor(rest: string[]): Promise<Attached> {
  const port = valueOf(rest, "--port");
  if (port) return attach(Number(port));
  const site = valueOf(rest, "--site") ?? "espn";
  return attachBro(site);
}

async function cmdAttach(rest: string[]) {
  const a = await attachFor(rest);
  console.log("Attached. Open tabs:");
  for (const p of a.pages) console.log("  -", p.url());
  const espn = findPage(a, "espn.com");
  console.log(espn ? `\nESPN tab found: ${espn.url()}` : "\nNo espn.com tab open yet.");
  await detach(a);
}

// The agent navigating the copresent session itself (D0): drive the user's own
// browser to a URL -- e.g. the ESPN mock-draft lobby -- then act from there.
async function cmdGoto(rest: string[]) {
  const url = rest.find((r) => !r.startsWith("--"));
  if (!url) {
    console.error("usage: ff goto <url>  (e.g. https://fantasy.espn.com/football/mockdraftlobby)");
    process.exit(2);
  }
  const a = await attachFor(rest);
  // Prefer an existing ESPN tab so we stay in the user's logged-in context.
  const page = findPage(a, "espn.com") ?? a.pages[0];
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log(`Navigated to ${page.url()}`);
  await detach(a);
}

// Click the first visible link/button whose text contains <text> (copresent action).
async function cmdClick(rest: string[]) {
  const text = rest.find((r) => !r.startsWith("--"));
  if (!text) {
    console.error('usage: ff click "<visible text>"');
    process.exit(2);
  }
  const exact = rest.includes("--exact");
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com") ?? a.pages[0];
  // Prefer a real button/link (by accessible name) over any text node that merely
  // CONTAINS the string (e.g. a heading) -- that was silently clicking the wrong element.
  const byRole = page.getByRole("button", { name: text, exact }).or(
    page.getByRole("link", { name: text, exact }),
  );
  const loc = (await byRole.count()) > 0 ? byRole.first() : page.getByText(text, { exact }).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  // A practice-draft launch may open a popup; capture it if so.
  const popupP = page.waitForEvent("popup", { timeout: 4000 }).catch(() => null);
  await loc.click({ timeout: 8000 });
  const popup = await popupP;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    console.log(`Clicked "${text}". Popup opened: ${popup.url()}`);
  } else {
    console.log(`Clicked "${text}". Now at: ${page.url()}`);
  }
  await detach(a);
}

// Dump the current page's visible text (copresent read).
async function cmdText(rest: string[]) {
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com") ?? a.pages[0];
  const txt = await page.evaluate("document.body.innerText");
  console.log(String(txt).replace(/\n{3,}/g, "\n\n").slice(0, 3000));
  await detach(a);
}

// Launch the league-specific practice draft AS THE AGENT (no human click). The
// "Practice Draft" button opens the draft app via window.open, which the popup blocker
// drops for programmatic clicks -- so we shim window.open to capture the target URL and
// navigate to it ourselves. This is the draft-day launch path.
async function cmdLaunchPractice(rest: string[]) {
  const a = await attachFor(rest);
  // Use a non-draft page as our working tab; if none, make one. NEVER close the last
  // page (that quits Chrome and ends the bro session).
  let page = a.pages.find((p) => !/\/football\/draft/.test(p.url()));
  if (!page) page = await a.context.newPage();
  // Now close any OTHER draft tabs -- ESPN allows only ONE draft connection; a duplicate
  // triggers "disconnected... from another location". Our working page is not a draft tab.
  for (const p of a.pages) {
    if (p !== page && /\/football\/draft/.test(p.url())) await p.close().catch(() => {});
  }
  // Always land on a freshly-loaded lobby (a finished-draft tab won't have the button).
  const openBtnSel = () => page.getByRole("button", { name: "Practice Draft", exact: true }).first();
  await page.goto("https://fantasy.espn.com/football/mockdraftlobby", { waitUntil: "networkidle" }).catch(() => {});
  let ready = await openBtnSel().waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
  if (!ready) {
    await page.reload({ waitUntil: "networkidle" }).catch(() => {});
    ready = await openBtnSel().waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
  }
  if (!ready) {
    console.error("lobby 'Practice Draft' button never rendered -- aborting launch.");
    await detach(a);
    return;
  }
  // Shim window.open to RECORD the URL only -- do NOT open the real popup (that would
  // create a second draft tab -> duplicate-connection kick). We navigate our one tab.
  await page.evaluate(
    "window.__ffOpen=null; if(!window.__ffPatched){window.__ffPatched=1; window.open=function(u){try{window.__ffOpen=String(u||'');}catch(e){} return {closed:false,focus:function(){},blur:function(){},close:function(){},postMessage:function(){}};};}",
  );
  // Step 1: open the "Configure Practice Draft" modal (retry -- the React app renders late).
  const openBtn = page.getByRole("button", { name: "Practice Draft", exact: true });
  const startBtn = page.getByRole("button", { name: "Start Practice Draft", exact: true });
  await openBtn.first().waitFor({ state: "visible", timeout: 20000 }).catch(() => console.error("Practice Draft button never rendered"));
  let modalOpen = false;
  for (let i = 0; i < 3 && !modalOpen; i++) {
    await openBtn.first().scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await openBtn.first().click({ timeout: 6000 }).catch((e) => console.error(`open-modal try ${i}:`, e.message));
    modalOpen = await startBtn
      .first()
      .waitFor({ state: "visible", timeout: 6000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!modalOpen) console.error("Configure-practice modal did not open after retries");
  // Step 1b: pick a draft position -- "Start" silently no-ops until one is chosen. It's a
  // native <select>; choose a concrete option (index 1 skips the placeholder).
  const posSel = page.locator("select").filter({ hasNot: page.locator("option:only-child") }).first();
  if ((await page.locator("select").count()) > 0) {
    const sel = page.locator("select").last();
    await sel.selectOption({ index: 1 }).catch(async () => {
      // Fallback: pick the last option (a concrete position, not the placeholder).
      const opts = await sel.locator("option").count();
      if (opts > 1) await sel.selectOption({ index: opts - 1 }).catch(() => {});
    });
    console.log("Selected a draft position.");
  } else {
    console.error("No <select> for draft position found.");
  }
  void posSel;
  // Step 2: start the draft (opens the draft app via window.open, captured by the shim).
  await startBtn.first().click({ timeout: 8000 }).catch((e) => console.error("start-click:", e.message));
  await page.waitForTimeout(1500);
  // window.open fires synchronously inside the handler; read what it targeted.
  const opened = (await page.evaluate("window.__ffOpen")) as string | null;
  if (opened) {
    const url = opened.startsWith("http") ? opened : new URL(opened, page.url()).href;
    console.log(`Practice draft opened window -> ${url}. Navigating there.`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    console.log(`Now at: ${page.url()} | title: ${await page.title()}`);
  } else {
    console.log(`No window.open captured. Current URL: ${page.url()} | title: ${await page.title()}`);
  }
  await detach(a);
}

async function cmdReadBlock(rest: string[]) {
  const { readBlock } = await import("./draft/espnAuction.js");
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const state = await readBlock(page);
  console.log(JSON.stringify(state, null, 2));
  await detach(a);
}

// Place the quick bid (Offer $current+1) unless the current offer already exceeds --max.
async function cmdBid(rest: string[]) {
  const { readBlock, quickBid } = await import("./draft/espnAuction.js");
  const maxArg = valueOf(rest, "--max");
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const before = await readBlock(page);
  const cap = maxArg ? Number(maxArg) : Infinity;
  if (!before.onBlock) {
    console.log("no player on the block");
  } else if ((before.currentOffer ?? 0) >= cap) {
    console.log(`skip: offer ${before.currentOffer} >= max ${cap} for ${before.player}`);
  } else {
    const ok = await quickBid(page);
    console.log(`${ok ? "BID" : "no-bid"} on ${before.player} (was $${before.currentOffer})`);
  }
  await detach(a);
}

// Read our real drafted roster (POS/Player/$/BYE panel) to verify wins + open slots.
async function cmdRoster(rest: string[]) {
  const { readRoster } = await import("./draft/espnAuction.js");
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const r = await readRoster(page);
  const won = r.slots.filter((s) => s.player).map((s) => `${s.slot} ${s.player} $${s.price}`);
  console.log(`filled ${r.filled}/${r.filled + r.open}  spent $${r.spent}  open ${r.open}`);
  console.log(`open: dedicated=${JSON.stringify(r.openByBase)} flex=${r.flexOpen} bench=${r.benchOpen}`);
  console.log(`won: ${won.join(" | ") || "(none)"}`);
  await detach(a);
}

// v1 auction bidder core: one connection, loop -- bid on whatever is on the block up to
// (Pre-Draft Val + overpay), stop when our roster grows (a win) or rounds run out. Proves
// the actor loop end-to-end. Strategy tuning (nomination, targets) comes later.
async function cmdAutoBid(rest: string[]) {
  const { readBlock, quickBid } = await import("./draft/espnAuction.js");
  const rounds = Number(valueOf(rest, "--rounds") ?? 40);
  const overpay = Number(valueOf(rest, "--overpay") ?? 2);
  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  const rosterCount = async () =>
    (await page.evaluate(
      `Array.from(new Set(Array.from(document.querySelectorAll('table.Table .playerinfo__playername')).map(e=>(e.textContent||'').trim()).filter(Boolean))).length`,
    )) as number;
  const startRoster = await rosterCount();
  console.log(`starting roster size: ${startRoster}`);
  for (let i = 0; i < rounds; i++) {
    const s = await readBlock(page);
    const now = await rosterCount();
    if (now > startRoster) {
      console.log(`WON a player -- roster grew ${startRoster} -> ${now}.`);
      break;
    }
    if (s.onBlock && s.player) {
      const max = (s.preDraftVal ?? s.currentOffer ?? 0) + overpay;
      if ((s.currentOffer ?? 0) < max && (s.myMax ?? 0) >= (s.currentOffer ?? 0) + 1) {
        const ok = await quickBid(page);
        console.log(`r${i}: ${ok ? "BID" : "no-bid"} ${s.player} $${s.currentOffer}->+1 (val ${s.preDraftVal}, max ${max})`);
      } else {
        console.log(`r${i}: hold ${s.player} $${s.currentOffer} (val ${s.preDraftVal}, our cap ${max})`);
      }
    } else {
      console.log(`r${i}: no player on block`);
    }
    await page.waitForTimeout(2000);
  }
  console.log(`final roster size: ${await rosterCount()}`);
  await detach(a);
}

// Full-auto auction engine (MVP): fill a complete legal roster in budget. Bots nominate
// (ESPN auto-nominates on our turn); we bid on any on-block player that fills an open slot,
// up to min(our value / ESPN pre-draft val / floor, ESPN's legal max). ESPN's myMax already
// reserves $1/open slot, so we can never strand a slot -> the done-bar is structurally safe.
async function cmdAutoDraft(rest: string[]) {
  const { readBlock, readRoster, hasOpenSlotFor, quickBid } = await import("./draft/espnAuction.js");
  const { loadRankings } = await import("./data/rankings.js");
  const rounds = Number(valueOf(rest, "--rounds") ?? 400);
  const floor = Number(valueOf(rest, "--floor") ?? 2); // min we'll pay for a needed filler
  const csv = valueOf(rest, "--csv") ?? "data/rankings.sample.csv";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const ranks = new Map<string, { pos: string; value: number }>();
  try {
    for (const p of loadRankings(csv)) ranks.set(norm(p.name), { pos: p.pos, value: Math.round(p.proj / 10) });
  } catch { /* rankings optional */ }

  const a = await attachFor(rest);
  const page = findPage(a, "/football/draft") ?? findPage(a, "espn.com") ?? a.pages[0];
  let lastPlayer = "";
  let emptyReads = 0;
  for (let i = 0; i < rounds; i++) {
    const r = await readRoster(page);
    if (r.filled === 0 && r.open === 0) {
      // Roster panel not rendered yet (pre-draft countdown) OR not in a draft. Tolerate a
      // startup window before giving up.
      if (++emptyReads > 25) {
        console.log(`no draft roster after ${emptyReads} reads -- not in a draft room. Stopping.`);
        break;
      }
      await page.waitForTimeout(1400);
      continue;
    }
    emptyReads = 0;
    if (r.open === 0) {
      console.log(`DONE: full roster (${r.filled} slots), spent $${r.spent}.`);
      break;
    }
    const b = await readBlock(page);
    if (b.onBlock && b.player && b.canBid) {
      const rk = ranks.get(norm(b.player));
      const pos = b.pos ?? rk?.pos ?? null;
      const need = pos ? hasOpenSlotFor(r, pos) : r.benchOpen > 0; // unknown pos -> only for bench
      // v1 "balanced fill" strategy: spread remaining budget across open slots so we win mid-tier
      // players throughout (bidding only to consensus value loses everything to 16 rival bots).
      const budgetLeft = 200 - r.spent;
      const perSlot = Math.max(floor, Math.floor(budgetLeft / Math.max(1, r.open)));
      // v1 fill: bots clear AT consensus value, so to actually WIN we bid just ABOVE it
      // (value + premium). ESPN's myMax reserve keeps a legal roster completable, so once
      // budget draws down it forces cheap fills automatically -> natural stars-and-scrubs
      // that still fills every slot in budget. (Balanced value targeting is the next layer.)
      const premium = Number(valueOf(rest, "--premium") ?? 2);
      const paceK = Number(valueOf(rest, "--pace") ?? 3); // max multiple of per-slot share per player
      const val = b.preDraftVal ?? rk?.value ?? perSlot;
      // Pace: never spend more than paceK x our per-slot share on one player, so budget lasts to
      // fill all slots (prevents blowing $80 on one stud and starving the rest). ESPN myMax is
      // the hard reserve; this is the softer even-fill governor.
      const cap = Math.min(b.myMax ?? 0, val + premium, paceK * perSlot);
      const offer = b.currentOffer ?? 0;
      if (need && offer < cap) {
        const ok = await quickBid(page);
        if (b.player !== lastPlayer)
          console.log(`r${i}: bid ${b.player} (${pos}) $${offer}->+1 cap=${cap} myMax=${b.myMax} [open ${r.open}] ${ok ? "" : "(noclick)"}`);
        lastPlayer = b.player;
      } else if (b.player !== lastPlayer) {
        console.log(`r${i}: pass ${b.player} (${pos}) $${offer} cap=${cap} need=${need} [open ${r.open}]`);
        lastPlayer = b.player;
      }
    }
    await page.waitForTimeout(1400);
  }
  const fin = await readRoster(page);
  console.log(`final: filled ${fin.filled}/${fin.filled + fin.open} spent $${fin.spent} open ${fin.open}`);
  await detach(a);
}

async function cmdInspect(rest: string[]) {
  const out = valueOf(rest, "--out") ?? "data/draft-dom-snapshot.json";
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com");
  if (!page) {
    console.error("No espn.com tab open. Navigate into an ESPN mock draft first.");
    await detach(a);
    process.exit(2);
  }
  const path = await inspectDraftDom(page, out);
  console.log(`Draft-room DOM snapshot written to ${path}`);
  console.log(`Page: ${page.url()}`);
  await detach(a);
}

function cmdRank(rest: string[]) {
  const csv = valueOf(rest, "--csv") ?? "data/rankings.sample.csv";
  const rankings = loadRankings(csv);
  const baselines = replacementBaselines(rankings, DEFAULT_LEAGUE);
  const valued = withVOR(rankings, baselines).sort((x, y) => y.vor - x.vor);
  console.log(`Top 15 by VOR (baselines: ${JSON.stringify(baselines)}):`);
  for (const p of valued.slice(0, 15)) {
    console.log(`  ${p.vor.toFixed(1).padStart(6)}  ${p.pos.padEnd(3)} ${p.name} (${p.team})`);
  }
}

async function cmdMock(rest: string[]) {
  const csv = valueOf(rest, "--csv") ?? "data/rankings.sample.csv";
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com");
  if (!page) {
    console.error("No espn.com tab open. Join an ESPN mock draft first.");
    await detach(a);
    process.exit(2);
  }
  await runDraft(page, {
    rankingsPath: csv,
    league: DEFAULT_LEAGUE,
    overrideWindowSec: 8,
    pollMs: 1500,
  });
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
