// ESPN AUCTION draft-room reader/actor (copresent, D0). Selectors captured + verified live
// (league 462233 = 16-team $200 salary-cap auction). Anchor on data-testid / semantic classes.
//
// STATUS (verified live 2026-08-31):
//   readBlock()  -- WORKS. readRoster() -- WORKS (reads the real POS/Player/$/BYE panel).
//   quickBid()   -- WORKS and WINS: won RB A. Jeanty $71, WR N. Collins $60 via the poll loop.
//   The earlier "won nothing" was a broken reader (it read the QUEUE, not the roster).
//   ESPN's "Manual offer (max $X)" already reserves $ to complete a legal roster -> trust myMax
//   as the legal cap (no separate affordability math needed to avoid stranding).

import type { Page } from "playwright-core";

export interface BlockState {
  onBlock: boolean;
  player: string | null;
  pos: string | null; // QB/RB/WR/TE/K/DST extracted from the block
  currentOffer: number | null;
  myMax: number | null; // ESPN's legal max for us (reserve already applied)
  preDraftVal: number | null;
  quickBidLabel: string | null; // "Offer $N"
  canBid: boolean; // quick-bid button present + enabled (disabled ~= we're high bidder / locked)
}

export interface RosterSlot {
  slot: string; // QB/RB/WR/TE/FLEX/D-ST/K/BE
  player: string | null; // null when Empty
  price: number | null;
}
export interface Roster {
  slots: RosterSlot[];
  filled: number;
  open: number;
  spent: number;
  openByBase: Record<string, number>; // open DEDICATED slots per base pos
  flexOpen: number;
  benchOpen: number;
}

const FLEX_ELIGIBLE = new Set(["RB", "WR", "TE"]);
const num = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/\$?(\d+)/);
  return m ? Number(m[1]) : null;
};

export async function readBlock(page: Page): Promise<BlockState> {
  const snap = (await page.evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const txt = (el) => (el && el.textContent ? el.textContent.trim() : null);
    const sel = q('[data-testid="player-selected"]');
    const name = txt(q('[data-testid="player-selected"] .playerinfo__playername'));
    const posEl = txt(q('[data-testid="player-selected"] .playerinfo__playerpos'));
    const blockText = sel ? (sel.textContent||'').replace(/\\s+/g,' ') : '';
    const nominated = txt(q('.current-amount')) ? (txt(q('.current-amount')) + ' ' + (txt(q('.manual-bid'))||'')) : txt(q('[class*="player-nominated-fo"]'));
    const preVal = txt(q('.player-default-bid'));
    const btn = Array.from(document.querySelectorAll('button.bid-player__button')).find((b) => /offer\\s*\\$\\d+/i.test(b.textContent||''));
    return { hasBlock: !!sel, name, posEl, blockText, nominated, preVal, bidBtn: btn ? btn.textContent.trim() : null, btnDisabled: btn ? btn.disabled : true };
  })()`)) as { hasBlock: boolean; name: string | null; posEl: string | null; blockText: string; nominated: string | null; preVal: string | null; bidBtn: string | null; btnDisabled: boolean };

  // pos: prefer a dedicated element; else parse the block text after the player name.
  let pos: string | null = snap.posEl && /^(QB|RB|WR|TE|K|D\/?ST)$/i.test(snap.posEl.trim()) ? snap.posEl.trim().toUpperCase().replace("/", "") : null;
  if (!pos && snap.blockText) {
    const after = snap.name ? snap.blockText.replace(snap.name, "") : snap.blockText;
    const m = after.match(/\b(QB|RB|WR|TE|K)\b|D\/?ST/) || after.match(/(QB|RB|WR|TE|K|DST)/);
    if (m) pos = (m[0] || "").toUpperCase().replace("/", "");
  }
  if (pos === "DST") pos = "DST";

  let currentOffer: number | null = null;
  let myMax: number | null = null;
  if (snap.nominated) {
    const nums = snap.nominated.replace(/,/g, "").match(/\$(\d+)/g) || [];
    if (nums[0]) currentOffer = Number(nums[0].slice(1));
    if (nums[1]) myMax = Number(nums[1].slice(1));
  }
  return {
    onBlock: snap.hasBlock,
    player: snap.name,
    pos,
    currentOffer,
    myMax,
    preDraftVal: num(snap.preVal),
    quickBidLabel: snap.bidBtn,
    canBid: snap.hasBlock && !!snap.bidBtn && !snap.btnDisabled,
  };
}

/** Read our real roster panel (the POS/Player/$/BYE table), not the queue. */
export async function readRoster(page: Page): Promise<Roster> {
  const rows = (await page.evaluate(`(() => {
    const tables = Array.from(document.querySelectorAll('table, .Table'));
    const roster = tables.find((t) => /POS/i.test(t.textContent||'') && /BYE/i.test(t.textContent||'') && /(QB|RB|WR|TE)/.test(t.textContent||''));
    if (!roster) return [];
    const trs = Array.from(roster.querySelectorAll('tr, .Table__TR'));
    return trs.map((tr) => Array.from(tr.querySelectorAll('td, th, .Table__TD, .Table__TH')).map((c) => (c.textContent||'').replace(/\\s+/g,' ').trim()));
  })()`)) as string[][];

  const slots: RosterSlot[] = [];
  for (const cells of rows) {
    if (cells.length < 2) continue;
    const slot = cells[0];
    if (!/^(QB|RB|WR|TE|FLEX|D\/?ST|K|BE|BENCH|IR)$/i.test(slot)) continue; // skip header/junk
    const playerCell = cells[1] || "";
    const player = /^empty$/i.test(playerCell) || playerCell === "--" || playerCell === "" ? null : playerCell;
    const price = num(cells[2]);
    slots.push({ slot: slot.toUpperCase().replace("/", "-"), player, price });
  }

  const openByBase: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
  let flexOpen = 0, benchOpen = 0, filled = 0, spent = 0;
  for (const s of slots) {
    const isOpen = !s.player;
    if (s.player) { filled++; spent += s.price ?? 0; }
    const base = s.slot === "D-ST" ? "DST" : s.slot;
    if (s.slot === "FLEX") { if (isOpen) flexOpen++; }
    else if (s.slot === "BE" || s.slot === "BENCH") { if (isOpen) benchOpen++; }
    else if (base in openByBase) { if (isOpen) openByBase[base]++; }
  }
  const open = slots.filter((s) => !s.player).length;
  return { slots, filled, open, spent, openByBase, flexOpen, benchOpen };
}

/** True if a player of base position `pos` can fill some open slot (dedicated, FLEX, or bench). */
export function hasOpenSlotFor(r: Roster, pos: string): boolean {
  const base = pos === "D/ST" ? "DST" : pos;
  if ((r.openByBase[base] ?? 0) > 0) return true;
  if (FLEX_ELIGIBLE.has(base) && r.flexOpen > 0) return true;
  return r.benchOpen > 0;
}

/** Place the one-click quick bid ("Offer $current+1"). */
export async function quickBid(page: Page): Promise<boolean> {
  const btn = page.locator("button.bid-player__button", { hasText: /Offer\s*\$\d+/i }).first();
  if ((await btn.count()) === 0 || (await btn.isDisabled().catch(() => true))) return false;
  await btn.click({ timeout: 4000 }).catch(() => {});
  return true;
}

// TODO: nominate(playerName) when it's our nomination turn (pick from board + confirm);
// readBoard() from .fixedDataTableLayout_main for nomination targets.
