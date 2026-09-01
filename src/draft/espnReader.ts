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
export async function inspectDraftDom(page: Page, outPath: string): Promise<string> {
  const snapshot = await page.evaluate(() => {
    const KEY = /available|player|pick|clock|round|roster|timer|on the clock|draft|queue/i;

    const describe = (el: Element) => ({
      tag: el.tagName.toLowerCase(),
      id: (el as HTMLElement).id || undefined,
      cls: (el.getAttribute("class") || "").slice(0, 120) || undefined,
      testid: el.getAttribute("data-testid") || undefined,
      role: el.getAttribute("role") || undefined,
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) || undefined,
    });

    // Elements whose text or class hints at draft concepts.
    const all = Array.from(document.querySelectorAll("*"));
    const candidates = all
      .filter((el) => {
        const hay = `${el.getAttribute("class") || ""} ${el.getAttribute("data-testid") || ""} ${
          (el.textContent || "").slice(0, 60)
        }`;
        return KEY.test(hay);
      })
      .slice(0, 400)
      .map(describe);

    // Likely tabular/list containers (the board is usually a table or big list).
    const containers = Array.from(
      document.querySelectorAll("table, [role='grid'], [role='table'], ul, ol"),
    )
      .filter((el) => (el.querySelectorAll("tr,li,[role='row']").length ?? 0) >= 5)
      .slice(0, 40)
      .map((el) => ({
        ...describe(el),
        rowCount: el.querySelectorAll("tr,li,[role='row']").length,
      }));

    return {
      url: location.href,
      title: document.title,
      timestamp_note: "captured live from the draft-room DOM",
      candidateCount: candidates.length,
      candidates,
      containers,
    };
  });

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
