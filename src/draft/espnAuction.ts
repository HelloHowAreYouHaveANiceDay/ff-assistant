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
    const isRoster = (t) => /POS/i.test(t.textContent||'') && /BYE/i.test(t.textContent||'') && /(QB|RB|WR|TE)/.test(t.textContent||'');
    const rosters = tables.filter(isRoster);
    // Anchor on OUR persistent draft-room roster panel (wrapped in .players-table), not blindly on
    // 'the first POS/BYE table' -- if a human opens ANOTHER team's roster a second such table renders
    // and the first-match could be theirs (finding #8 / Step 9c). One-table case is unchanged.
    const roster = rosters.find((t) => t.closest('.players-table')) || rosters[0];
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

/** Jump-bid a specific dollar amount via the manual-offer input (leapfrogs the +1 button, which
 *  is too slow to win fast-rising stud auctions). Returns false if the field/submit isn't usable. */
export async function jumpBid(page: Page, amount: number): Promise<boolean> {
  const custom = page.locator("form.bidding-form__custom");
  if ((await custom.count()) === 0) return false;
  const input = custom.locator("input").first();
  if ((await input.count()) === 0) return false;
  await input.fill(String(Math.floor(amount))).catch(() => {});
  await page.waitForTimeout(120); // let the submit enable
  const submit = custom.locator("button", { hasText: /Offer/i }).first();
  if ((await submit.count()) === 0 || (await submit.isDisabled().catch(() => true))) return false;
  await submit.click({ timeout: 3000 }).catch(() => {});
  return true;
}

export interface BoardPlayer {
  name: string;
  pos: string | null;
  value: number | null; // ESPN's $ value shown on the board
}

/** Read the visible available-players board (virtualized -- only on-screen rows are in the DOM). */
export async function readBoard(page: Page): Promise<BoardPlayer[]> {
  return (await page.evaluate(`(() => {
    const board = document.querySelector('.fixedDataTableLayout_main');
    if (!board) return [];
    const rows = Array.from(board.querySelectorAll('.public_fixedDataTableRow_main'));
    const out = [];
    for (const r of rows) {
      const nameEl = r.querySelector('.player-news[title]');
      const name = nameEl ? nameEl.getAttribute('title') : null;
      if (!name) continue;
      const cells = Array.from(r.querySelectorAll('.public_fixedDataTableCell_cellContent')).map((c) => (c.textContent||'').trim());
      const valTxt = cells.find((t) => /^\\$\\d+$/.test(t));
      const posCell = cells.find((t) => t.indexOf(name) === 0) || '';
      const pm = posCell.replace(name, '').match(/(QB|RB|WR|TE|K|DST)$/) || posCell.match(/D\\/?ST/);
      out.push({ name, pos: pm ? pm[0].replace('/','') : null, value: valTxt ? Number(valTxt.slice(1)) : null });
    }
    return out;
  })()`)) as BoardPlayer[];
}

export interface DraftPick { pick: number; name: string; pos: string | null; nflTeam: string | null; fantasyTeam: string; price: number; proj: number | null; }
/** Read the FULL draft log from the pick-history feed (one virtualized table per round). Gives every
 *  pick's player, pos, fantasy team (owner) + price -> exact remaining book value (inflation), true
 *  positional supply gone, and per-opponent roster construction. Robust to re-reads (idempotent). */
export async function readDraft(page: Page): Promise<DraftPick[]> {
  return (await page.evaluate(`(() => {
    const out = [];
    const POS = /(QB|RB|WR|TE|K|DST)$/;
    for (const tbl of Array.from(document.querySelectorAll('.pick-history-table'))) {
      for (const r of Array.from(tbl.querySelectorAll('.public_fixedDataTableRow_main'))) {
        const cells = Array.from(r.querySelectorAll('.public_fixedDataTableCell_cellContent')).map((c) => (c.textContent||'').trim());
        if (cells.length < 6) continue;
        const pick = Number(cells[0]); if (!Number.isFinite(pick)) continue; // skip header
        const nameEl = r.querySelector('[title]');
        const name = nameEl ? nameEl.getAttribute('title') : null; if (!name) continue;
        const combo = cells[1].replace(name, ''); // "ATLRB" -> nflTeam + pos
        const pm = combo.match(POS) || combo.match(/D\\/?ST/);
        const pos = pm ? pm[0].replace('/','') : null;
        const nflTeam = pos ? combo.slice(0, combo.length - (pm[0].length)) : combo;
        const priceM = (cells[5]||'').match(/\\$(\\d+)/);
        out.push({ pick, name, pos, nflTeam: nflTeam || null, fantasyTeam: cells[2]||'', price: priceM ? Number(priceM[1]) : 0, proj: cells[4] ? Number(cells[4]) : null });
      }
    }
    // dedupe by pick number (tables can double-render the viewing round)
    const seen = new Set(); const uniq = [];
    for (const p of out) { if (seen.has(p.pick)) continue; seen.add(p.pick); uniq.push(p); }
    return uniq.sort((a,b)=>a.pick-b.pick);
  })()`)) as DraftPick[];
}

export interface LeagueState { remainingDollars: number; teams: number; }
/** Read the league-wide money still on the table: every team's remaining budget from the auction
 *  draft-room team strip (each team shows a `.cash` = $N). Used for LIVE inflation repricing. */
export async function readLeague(page: Page): Promise<LeagueState> {
  return (await page.evaluate(`(() => {
    const cash = Array.from(document.querySelectorAll('.cash'))
      .map((c) => { const m = (c.textContent||'').match(/\\$(\\d+)/); return m ? Number(m[1]) : null; })
      .filter((v) => v != null);
    return { remainingDollars: cash.reduce((s, v) => s + v, 0), teams: cash.length };
  })()`)) as LeagueState;
}

/** Scroll the full available-players board and collect every player's ESPN $ value. The board is
 *  virtualized (only ~18 rows in the DOM at once), so we scroll and accumulate until it stops
 *  yielding new names. Gives a complete values table calibrated to THIS league's settings. */
export async function dumpValues(page: Page, maxScrolls = 120): Promise<BoardPlayer[]> {
  const byName = new Map<string, BoardPlayer>();
  const board = page.locator(".fixedDataTableLayout_main").first();
  const box = await board.boundingBox().catch(() => null);
  let stagnant = 0;
  for (let i = 0; i < maxScrolls && stagnant < 4; i++) {
    const before = byName.size;
    for (const p of await readBoard(page)) if (p.name && !byName.has(p.name)) byName.set(p.name, p);
    stagnant = byName.size > before ? 0 : stagnant + 1;
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 600); }
    await page.waitForTimeout(250);
  }
  return [...byName.values()];
}

export interface TurnState {
  ourNomination: boolean; // is it OUR turn to nominate a player?
  nominatingTeam: string | null; // best-effort current nominator (may be null)
}

/** Read whether it is OUR nomination turn. ESPN enables the board's "Select" (nominate) buttons
 *  ONLY on your nomination turn, and only when no player is on the block -- so an enabled Select
 *  with an empty block IS the turn signal (Step 7). nominatingTeam is best-effort from the picklist
 *  (not load-bearing). Never true during the pre-draft countdown (no Select buttons render then). */
export async function readTurn(page: Page): Promise<TurnState> {
  return (await page.evaluate(`(() => {
    const onBlock = !!document.querySelector('[data-testid="player-selected"] .playerinfo__playername');
    const selects = Array.from(document.querySelectorAll('button')).filter((b) => /^select$/i.test((b.textContent||'').trim()));
    const anyEnabled = selects.some((b) => !b.disabled);
    let nominatingTeam = null;
    const active = document.querySelector('ul.picklist .on-the-clock, ul.picklist .picklist--item--active, ul.picklist .picklist--current, ul.picklist .is-current');
    if (active) nominatingTeam = (active.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 40);
    return { ourNomination: !onBlock && anyEnabled, nominatingTeam };
  })()`)) as TurnState;
}

/** Nominate a player by clicking the "Select" button in their board row. Returns false if the
 *  player isn't visible on the board or Select isn't available (e.g. not our nomination turn). */
export async function nominate(page: Page, playerName: string): Promise<boolean> {
  const row = page.locator(".public_fixedDataTableRow_main", {
    has: page.locator(`.player-news[title="${playerName.replace(/"/g, '\\"')}"]`),
  }).first();
  if ((await row.count()) === 0) return false;
  const btn = row.locator("button", { hasText: /^Select$/i }).first();
  if ((await btn.count()) === 0 || (await btn.isDisabled().catch(() => true))) return false;
  await btn.click({ timeout: 4000 }).catch(() => {});
  return true;
}
