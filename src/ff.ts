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
  if (!/mockdraftlobby/.test(page.url())) {
    await page.goto("https://fantasy.espn.com/football/mockdraftlobby", {
      waitUntil: "domcontentloaded",
    });
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
  // Step 2: in the modal, start the draft (opens the draft app via window.open).
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
