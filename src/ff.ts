#!/usr/bin/env tsx
// The `ff` CLI -- the engine (D7). Runnable in a terminal for iteration; the
// unattended agent will later reach a constrained subset of these as tools.
//
//   npm run ff -- attach            test the copresent CDP connection, list tabs
//   npm run ff -- inspect-draft     dump the live ESPN draft-room DOM to a file
//   npm run ff -- rank              print top players by VOR from the rankings CSV
//   npm run ff -- mock              run the draft loop (needs real selectors first)

import { attach, findPage, detach } from "./browser/attach.js";
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
    case "attach":
      return cmdAttach();
    case "goto":
      return cmdGoto(rest);
    case "inspect-draft":
      return cmdInspect(rest);
    case "rank":
      return cmdRank(rest);
    case "mock":
      return cmdMock(rest);
    default:
      console.log(
        "commands: attach | goto <url> | inspect-draft [--port N] [--out FILE] | rank [--csv FILE] | mock [--csv FILE]",
      );
  }
}

async function cmdAttach() {
  const a = await attach(portFrom(process.argv));
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
  const a = await attach(portFrom(process.argv));
  // Prefer an existing ESPN tab so we stay in the user's logged-in context.
  const page = findPage(a, "espn.com") ?? a.pages[0];
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log(`Navigated to ${page.url()}`);
  await detach(a);
}

async function cmdInspect(rest: string[]) {
  const out = valueOf(rest, "--out") ?? "data/draft-dom-snapshot.json";
  const a = await attach(portFrom(process.argv));
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
  const a = await attach(portFrom(process.argv));
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
function portFrom(argv: string[]): number {
  const v = valueOf(argv, "--port");
  return v ? Number(v) : 9222;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
