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
  const a = await attachFor(rest);
  const page = findPage(a, "espn.com") ?? a.pages[0];
  const loc = page.getByText(text, { exact: false }).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await loc.click({ timeout: 8000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  console.log(`Clicked "${text}". Now at: ${page.url()}`);
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
