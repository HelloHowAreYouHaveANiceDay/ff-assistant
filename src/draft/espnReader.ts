// ESPN draft-room reader (copresent, D0). Selectors are UNKNOWN until we inspect a
// live mock-draft room -- that is what `inspectDraftDom` is for. Once we see the real
// DOM, `readBoard` and `makePick` get concrete selectors and this file stops being a
// stub. Do NOT guess selectors before inspecting; write them from evidence.

import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";

/**
 * Dump a broad snapshot of the current page's DOM to a JSON file so we can identify
 * the draft board, the pick timer, the on-the-clock indicator, and the roster. This
 * is the first tool to run inside a live ESPN mock-draft room.
 */
// The collection script is passed to page.evaluate AS A STRING on purpose: tsx/esbuild
// injects a `__name` helper into compiled function expressions, which is undefined in
// the page context and makes a function-form evaluate throw "__name is not defined".
const COLLECT_DOM = `(() => {
  const KEY = /available|player|pick|clock|round|roster|timer|on the clock|draft|queue/i;
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    cls: (el.getAttribute("class") || "").slice(0, 120) || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    role: el.getAttribute("role") || undefined,
    text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80) || undefined,
  });
  const all = Array.from(document.querySelectorAll("*"));
  const candidates = all.filter((el) => {
    const hay = (el.getAttribute("class") || "") + " " + (el.getAttribute("data-testid") || "") + " " + (el.textContent || "").slice(0, 60);
    return KEY.test(hay);
  }).slice(0, 400).map(describe);
  const containers = Array.from(document.querySelectorAll("table, [role='grid'], [role='table'], ul, ol"))
    .filter((el) => el.querySelectorAll("tr,li,[role='row']").length >= 5)
    .slice(0, 40)
    .map((el) => Object.assign(describe(el), { rowCount: el.querySelectorAll("tr,li,[role='row']").length }));
  const buttons = Array.from(document.querySelectorAll("button, a[role='button'], a.btn, [class*='btn'], a[href]"))
    .slice(0, 200)
    .map(describe)
    .filter((b) => b.text);
  const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => ({
    src: f.getAttribute("src") || undefined,
    id: f.id || undefined,
    cls: (f.getAttribute("class") || "").slice(0, 80) || undefined,
  }));
  return { url: location.href, title: document.title, candidateCount: candidates.length, candidates, containers, buttons, iframes };
})()`;

export async function inspectDraftDom(page: Page, outPath: string): Promise<string> {
  const snapshot = await page.evaluate(COLLECT_DOM);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  return outPath;
}

// --- To be implemented from the inspection evidence -------------------------------

export interface BoardState {
  onTheClock: boolean;
  secondsLeft: number | null;
  availableNames: string[]; // names as ESPN renders them (map to rankings by name)
  myRoster: string[];
}

export async function readBoard(_page: Page): Promise<BoardState> {
  throw new Error("readBoard: selectors not yet known -- run `ff inspect-draft` first.");
}

export async function makePick(_page: Page, _playerName: string): Promise<void> {
  throw new Error("makePick: selectors not yet known -- run `ff inspect-draft` first.");
}
