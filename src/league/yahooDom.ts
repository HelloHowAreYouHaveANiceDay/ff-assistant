/**
 * YAHOO DOM/HTML PARSERS -- every Yahoo selector this repo owns, in ONE file, each naming the page it
 * was read from.
 *
 * WHY HTML AND NOT AN API. ESPN publishes `lm-api-reads` JSON that the logged-in webview can fetch.
 * Yahoo publishes no equivalent this repo can reach without an OAuth app, so the adaptor reads the
 * same pages a person reads. That is fine because those pages are SERVER-RENDERED (verified
 * 2026-09-16: the settings, all-rosters, managers and scoreboard markup all carry their data in the
 * initial HTML), so a credentialed GET through the app's `yahooview` guest returns everything.
 *
 * WHY PURE FUNCTIONS OVER STRINGS. Every function here takes HTML and returns data, with no browser
 * and no network, so each is pinned to a SAVED FIXTURE in test/fixtures/yahoo/ (test/yahoo-*.test.ts).
 * A Yahoo redesign then fails a unit test instead of quietly returning an empty roster -- and an empty
 * roster that does not throw is the failure mode src/league/types.ts warns about at length.
 *
 * PAGES, and what each is the source of truth for (league 129048, read 2026-09-16):
 *   /f1/<id>/settings           the settings table + the four per-position scoring tables
 *   /f1/<id>/starters           all twelve rosters, each in `<table id="Tst-team-N">`
 *   /f1/<id>/teams              the Managers table: team name, manager, FAB balance, waiver priority
 *   /f1/<id>/?matchup_week=N    the week-N scoreboard; each game is a `matchup?week=N&mid1=A&mid2=B`
 *                               link, and each side carries its FINAL SCORE and its projection
 *   /f1/<id>/<team>?week=N      ONE team's week-N roster in `<table id="statTable0">`: the slot each
 *                               man occupied THAT WEEK and his ACTUAL points. This is the only page
 *                               that carries both, and it is what the D18 seed needs (WP9).
 *   /f1/<id>/players?status=A   the AVAILABLE pool, 25 per page, `count` is the offset
 *   /f1/<id>/transactions       the league's add/drop/trade log, with the FAB bid on each claim
 *   /f1/myleagues               "My Teams & Leagues": one row per league with its team
 */
import type { ScoringRules } from "../draft/scoring.js";

/**
 * THE SUBSTRING OF `html` HOLDING THE TABLE THAT `open` MATCHES, INNER HTML ONLY, NESTING-AWARE.
 *
 * WHY NOT `/<table...>([\s\S]*?)<\/table>/`. Yahoo's players page renders a `<table class='Tst-forecast'>`
 * INSIDE a cell of the players table, so a non-greedy scan stops at the nested `</table>` and returns
 * the first row and a half. Measured: the lazy form found 1 player on `?sort=OR` and 25 on
 * `?sort=OR&stat1=...` -- the same page, the same parser, a different answer depending on where the
 * popup markup happened to land. A parser whose result depends on that is not a parser.
 *
 * So the scan counts `<table` / `</table>` and returns the body at depth 0. Returns null when the
 * opening tag is absent, which callers turn into a named refusal rather than an empty list.
 */
export function tableBody(html: string, open: RegExp): string | null {
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  const tag = /<(\/?)table\b/gi;
  tag.lastIndex = start;
  for (let t = tag.exec(html); t; t = tag.exec(html)) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}

/** The `<tr>` bodies of a table body, nesting-aware for the same reason `tableBody` is: a row that
 *  contains a nested table contains that table's `</tr>`s too. Rows of NESTED tables are skipped. */
export function tableRows(body: string): string[] {
  const out: string[] = [];
  const tag = /<(\/?)(table|tr)\b[^>]*>/gi;
  let depth = 0, rowStart = -1, rowDepth = -1;
  for (let t = tag.exec(body); t; t = tag.exec(body)) {
    const close = !!t[1], what = t[2].toLowerCase();
    if (what === "table") { depth += close ? -1 : 1; continue; }
    if (!close) { if (rowStart < 0) { rowStart = t.index + t[0].length; rowDepth = depth; } continue; }
    if (rowStart >= 0 && depth === rowDepth) { if (depth === 0) out.push(body.slice(rowStart, t.index)); rowStart = -1; }
  }
  return out;
}

/** The `<td>`/`<th>` bodies of ONE row, nesting-aware. Same hazard, same fix. */
export function rowCells(row: string): string[] {
  return rowCellsTagged(row).map((c) => c.body);
}

/**
 * The cells of one row WITH their opening tags.
 *
 * The tag is kept because a column's identity lives there and not in its position: Yahoo marks the
 * fantasy-points cell `class="... pts ..."`, and the alternative -- counting columns -- is wrong on
 * any page that renders an extra action cell. See `parseYahooTeamWeek`.
 */
export function rowCellsTagged(row: string): { tag: string; body: string }[] {
  const out: { tag: string; body: string }[] = [];
  const tag = /<(\/?)(table|t[dh])\b[^>]*>/gi;
  let depth = 0, cellStart = -1, openTag = "";
  for (let t = tag.exec(row); t; t = tag.exec(row)) {
    const close = !!t[1], what = t[2].toLowerCase();
    if (what === "table") { depth += close ? -1 : 1; continue; }
    if (depth !== 0) continue;
    if (!close) { if (cellStart < 0) { cellStart = t.index + t[0].length; openTag = t[0]; } continue; }
    if (cellStart >= 0) { out.push({ tag: openTag, body: row.slice(cellStart, t.index) }); cellStart = -1; }
  }
  return out;
}

/** Strip tags and decode the handful of entities Yahoo's markup actually uses. */
export function htmlText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&rsquo;|&#8217;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/settings -- the general settings table
// ---------------------------------------------------------------------------------------------

/**
 * The settings table as `label -> value`, e.g. `"Max Teams" -> "12"`.
 *
 * Yahoo's markup is a plain two-column table, `id="settings-table"`. Most rows carry
 * `class="typeStandard"` on both cells -- but NOT all of them: the very first row, `League ID#`, is a
 * bare `<td>` pair. Keying on `typeStandard` therefore dropped exactly the row the identity guard
 * needs, which is why the scope here is THE TABLE, not a class on a cell.
 *
 * Labels keep their `&nbsp;` (so "Roster Positions" arrives as `Roster&nbsp;Positions:`) -- `htmlText`
 * normalizes that, and the trailing colon is stripped, so a caller asks for the label as it READS on
 * the page.
 */
export function parseYahooSettingsTable(html: string): Record<string, string> {
  const t = /<table[^>]*id="settings-table"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  const scope = t ? t[1] : html;
  const out: Record<string, string> = {};
  for (const m of scope.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length !== 2) continue;
    const label = htmlText(cells[0]).replace(/:\s*$/, "");
    const value = htmlText(cells[1]);
    if (label) out[label] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/settings -- the per-position scoring tables (`id="settings-stat-mod-table"`)
// ---------------------------------------------------------------------------------------------

/** One scoring table: the position group it heads ("QB"/"RB"/"WR"/"TE"), and its rows as
 *  `stat label -> the LEAGUE VALUE cell verbatim` (Yahoo's own words, e.g. "25 yards per point;
 *  2 points at 300 yards; 3 points at 400 yards"). */
export interface YahooScoringTable { group: string; rows: Record<string, string> }

/**
 * The four per-position scoring groups.
 *
 * MARKUP TRAP, and it cost a wrong answer before it cost a test: the four groups are NOT four
 * `<table>` elements. Yahoo renders ONE `<table id="settings-stat-mod-table">` containing FOUR
 * `<thead>`/`<tbody>` pairs, one per position. Splitting on `</table>` therefore returned only the QB
 * group -- and since QB carries every stat, the result looked complete and would have silently given
 * the TE-premium reception rate to every position. So the split is on the thead/tbody PAIR.
 */
export function parseYahooScoringTables(html: string): YahooScoringTable[] {
  const out: YahooScoringTable[] = [];
  for (const g of html.matchAll(/<thead[^>]*>([\s\S]*?)<\/thead>\s*<tbody[^>]*>([\s\S]*?)<\/tbody>/gi)) {
    const head = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(g[1]);
    const title = head ? htmlText(head[1]) : "";
    const m = /\(([^)]+)\)/.exec(title);
    if (!m) continue;                                   // not a "Offense (QB)"-shaped group header
    const group = m[1].trim().toUpperCase();
    const rows: Record<string, string> = {};
    for (const r of g[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
      if (cells.length < 2) continue;
      // The label cell carries a "Yahoo Default" badge <div> for any overridden stat; drop it.
      const label = htmlText(cells[0].replace(/<div[\s\S]*?<\/div>/gi, " "));
      if (!label) continue;
      rows[label] = htmlText(cells[1]);
    }
    if (Object.keys(rows).length) out.push({ group, rows });
  }
  return out;
}

/** "25 yards per point" -> 1/25. Throws rather than defaulting: a yardage rate we cannot read is not
 *  a rate we may guess -- every point of every yardage stat depends on it. */
function yardsPerPoint(cell: string, what: string): number {
  const m = /([\d.]+)\s*yards?\s*per\s*point/i.exec(cell);
  if (!m) throw new Error(`yahoo scoring: "${what}" does not state a yards-per-point rate (got "${cell}")`);
  return 1 / Number(m[1]);
}

/** "...; 2 points at 300 yards; 3 points at 400 yards" -> [[300,2],[400,3]]. `[]` when absent. */
function milestones(cell: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of cell.matchAll(/(-?[\d.]+)\s*points?\s*at\s*([\d.]+)\s*yards?/gi)) out.push([Number(m[2]), Number(m[1])]);
  return out.sort((a, b) => a[0] - b[0]);
}

function plainNumber(cell: string, what: string): number {
  const n = Number(String(cell).trim());
  if (!Number.isFinite(n)) throw new Error(`yahoo scoring: "${what}" is not a number (got "${cell}")`);
  return n;
}

/**
 * The four per-position scoring tables -> our `ScoringRules`.
 *
 * WHAT MAKES THIS HONEST. Every field is read from a named cell; nothing falls back to a default. The
 * ONE thing the reader must decide is which position's table supplies each flat term: Yahoo publishes
 * a FULL table per position, and in this league every term is identical across QB/RB/WR except
 * Receptions (1) vs TE (1.5). So the flat terms are read from the QB table and then CROSS-CHECKED
 * against every other table -- a disagreement throws, naming the stat and the two positions, rather
 * than silently taking the first one. That is the difference between "this league is expressible as
 * one rule set" being verified and being assumed.
 *
 * Receptions are the deliberate exception: a per-position difference there is expected and is carried
 * as `recByPos`.
 *
 * NOT EXPRESSIBLE, and therefore REPORTED rather than dropped silently: `Return Touchdowns` and
 * `Offensive Fumble Return TD` have no field in `ScoringRules`. They are returned in `unmapped` so a
 * caller can say so; see the WP4 report.
 */
export function yahooScoringFromTables(tables: YahooScoringTable[]): { rules: ScoringRules; unmapped: Record<string, string> } {
  const byGroup = new Map(tables.map((t) => [t.group, t.rows]));
  const qb = byGroup.get("QB");
  if (!qb) throw new Error(`yahoo scoring: no "Offense (QB)" table on the settings page (saw ${[...byGroup.keys()].join(", ") || "nothing"})`);
  const need = (rows: Record<string, string>, label: string): string => {
    const v = rows[label];
    if (v == null) throw new Error(`yahoo scoring: the settings page has no "${label}" row -- refusing to default it.`);
    return v;
  };

  // Flat terms, from the QB table, then cross-checked against every other position's table.
  const FLAT: [string, keyof ScoringRules][] = [
    ["Passing Touchdowns", "passTD"], ["Interceptions", "int"], ["Rushing Touchdowns", "rushTD"],
    ["Receiving Touchdowns", "recTD"], ["2-Point Conversions", "twoPt"], ["Fumbles Lost", "fumble"],
    ["40+ Yard Completions", "cmp40"], ["40+ Yard Run", "rush40"], ["40+ Yard Receptions", "rec40"],
    ["Passing 1st Downs", "passFirstDown"], ["Receiving 1st Downs", "recFirstDown"], ["Rushing 1st Downs", "rushFirstDown"],
  ];
  const rules = {} as ScoringRules;
  for (const [label, key] of FLAT) {
    const v = plainNumber(need(qb, label), label);
    for (const [g, rows] of byGroup) {
      if (g === "QB" || rows[label] == null) continue;
      const other = plainNumber(rows[label], `${label} (${g})`);
      if (other !== v) throw new Error(`yahoo scoring: "${label}" is ${v} for QB but ${other} for ${g} -- this league is not expressible as one rule set and must not be flattened into one.`);
    }
    (rules as unknown as Record<string, number>)[key as string] = v;
  }

  const passCell = need(qb, "Passing Yards");
  const rushCell = need(qb, "Rushing Yards");
  const recCell = need(qb, "Receiving Yards");
  rules.passYd = yardsPerPoint(passCell, "Passing Yards");
  rules.rushYd = yardsPerPoint(rushCell, "Rushing Yards");
  rules.recYd = yardsPerPoint(recCell, "Receiving Yards");
  const pb = milestones(passCell), rb = milestones(rushCell), cb = milestones(recCell);
  if (pb.length) rules.passYdBonus = pb;
  if (rb.length) rules.rushYdBonus = rb;
  if (cb.length) rules.recYdBonus = cb;

  // Receptions: the one term that legitimately varies by position (TE premium).
  const recByPos: Record<string, number> = {};
  for (const [g, rows] of byGroup) recByPos[g] = plainNumber(need(rows, "Receptions"), `Receptions (${g})`);
  // The flat `rec` is the value the MAJORITY of positions carry; anything that differs is carried in
  // recByPos. With QB/RB/WR at 1 and TE at 1.5 that is rec=1, recByPos={TE:1.5}.
  const counts = new Map<number, number>();
  for (const v of Object.values(recByPos)) counts.set(v, (counts.get(v) ?? 0) + 1);
  const flatRec = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  rules.rec = flatRec;
  const overrides: Record<string, number> = {};
  for (const [g, v] of Object.entries(recByPos)) if (v !== flatRec) overrides[g] = v;
  if (Object.keys(overrides).length) rules.recByPos = overrides;

  const mapped = new Set([...FLAT.map(([l]) => l), "Passing Yards", "Rushing Yards", "Receiving Yards", "Receptions"]);
  const unmapped: Record<string, string> = {};
  for (const label of Object.keys(qb)) if (!mapped.has(label) && label !== "Offense") unmapped[label] = qb[label];
  return { rules, unmapped };
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/starters -- all twelve rosters
// ---------------------------------------------------------------------------------------------

export interface YahooRosterRow { slot: string; name: string; pos: string; team: string }
export interface YahooRoster { teamId: string; teamName: string; players: YahooRosterRow[] }

/**
 * Every team's roster from the all-rosters page.
 *
 * Markup, read 2026-09-16: each team is `<p ...><a href="/f1/<lg>/<teamId>">Team Name</a>...</p>`
 * followed by `<table id="Tst-team-<teamId>">`, whose rows are `<td>SLOT</td><td>... <a class="...
 * name ..." title="Player Name">...</a> ... <span class="Fz-xxs">Chi - RB</span> ...</td>`. Slot is
 * Yahoo's own token (QB/RB/WR/TE/W/R/T/Q/W/R/T/BN/IR) and is NOT normalized here -- normalization is
 * one decision and it lives in yahoo.ts beside the slot map it uses.
 *
 * THROWS when it finds no team at all, per the adaptor contract in ./types.ts: an empty roster list
 * and a failed read look identical to a caller, and a trade script that scores an empty roster
 * reports a confident wrong answer with no error anywhere.
 */
export function parseYahooRosters(html: string): YahooRoster[] {
  const out: YahooRoster[] = [];
  const nameById = new Map<string, string>();
  for (const m of html.matchAll(/<a[^>]+href="\/f1\/\d+\/(\d+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const t = htmlText(m[2]);
    if (t && !nameById.has(m[1])) nameById.set(m[1], t);
  }
  for (const t of html.matchAll(/<table[^>]*id="Tst-team-(\d+)"[^>]*>([\s\S]*?)<\/table>/gi)) {
    const teamId = t[1];
    const players: YahooRosterRow[] = [];
    for (const r of t[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
      if (cells.length < 2) continue;
      const slot = htmlText(cells[0]);
      const nameM = /<a[^>]+class="[^"]*\bname\b[^"]*"[^>]*title="([^"]+)"/i.exec(cells[1]);
      if (!slot || !nameM) continue;              // an EMPTY slot row -- a real, ordinary fact
      const metaM = /<span class="Fz-xxs">([\s\S]*?)<\/span>/i.exec(cells[1]);
      const meta = metaM ? htmlText(metaM[1]) : "";
      const parts = meta.split(/\s*-\s*/);
      players.push({
        slot,
        name: htmlText(nameM[1]),
        pos: (parts[1] ?? "").trim().toUpperCase(),
        team: (parts[0] ?? "").trim().toUpperCase(),
      });
    }
    out.push({ teamId, teamName: nameById.get(teamId) ?? `Team ${teamId}`, players });
  }
  if (!out.length) throw new Error("yahoo rosters: the all-rosters page carried no `Tst-team-N` table -- not logged in, wrong league, or Yahoo changed the markup. Refusing to report an empty league.");
  return out;
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/teams -- the Managers table
// ---------------------------------------------------------------------------------------------

export interface YahooManagerRow { teamName: string; manager: string; faabRemaining: number | null; waiverPriority: number | null; moves: number | null }

export function parseYahooManagers(html: string): YahooManagerRow[] {
  const out: YahooManagerRow[] = [];
  for (const r of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => htmlText(c[1]));
    if (cells.length < 5) continue;
    const teamName = cells[0];
    if (!teamName || /^co-manager$/i.test(teamName)) continue;
    const money = /^\$(\d+)$/.exec(cells[3] ?? "");
    const num = (s: string): number | null => { const n = Number(s); return Number.isFinite(n) && s.trim() !== "" ? n : null; };
    out.push({
      teamName, manager: cells[1] ?? "",
      faabRemaining: money ? Number(money[1]) : null,
      waiverPriority: num(cells[4] ?? ""),
      moves: num(cells[5] ?? ""),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/?matchup_week=N -- the week scoreboard
// ---------------------------------------------------------------------------------------------

/** The week-N games, from the `matchup?week=N&mid1=A&mid2=B` links the scoreboard renders. Only
 *  links for the REQUESTED week are kept: the page also carries "last week's recap" links, and
 *  taking those too is how a schedule reader reports last week's pairings as this week's. */
export function parseYahooScheduleWeek(html: string, week: number): { week: number; homeId: string; awayId: string }[] {
  const seen = new Set<string>();
  const out: { week: number; homeId: string; awayId: string }[] = [];
  for (const m of html.matchAll(/matchup\?week=(\d+)&(?:amp;)?mid1=(\d+)&(?:amp;)?mid2=(\d+)/gi)) {
    if (Number(m[1]) !== week) continue;
    const key = [m[2], m[3]].sort().join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ week, homeId: m[2], awayId: m[3] });
  }
  return out;
}

/**
 * THE WEEK'S GAMES WITH THEIR FINAL SCORES, from the same scoreboard page.
 *
 * Separate from `parseYahooScheduleWeek` rather than replacing it, because the two answer different
 * questions and one of them must keep working before a week is played: the SCHEDULE is published in
 * August and `matchups()` reads all fourteen weeks of it, while a SCORE exists only once the games
 * have been played. Merging them would have made `matchups()` refuse a schedule it can read.
 *
 * `homePts`/`awayPts` are null when the page prints no number for that side (a future week), which is
 * a fact, not a zero -- a zero would be a real, terrible score.
 *
 * Markup, read 2026-09-16: one `<li ... data-target='/f1/<lg>/matchup?week=N&mid1=A&mid2=B'>` per
 * game, and within it two `<div class='Fz-lg ...'>` -- mid1's score then mid2's. The `F-shade` div
 * that follows each is the PROJECTION, and taking it by position instead of by class is how a
 * scoreboard reader ends up reporting projections as results.
 */
export function parseYahooScoreboardWeek(html: string, week: number): { week: number; homeId: string; awayId: string; homePts: number | null; awayPts: number | null }[] {
  const out: { week: number; homeId: string; awayId: string; homePts: number | null; awayPts: number | null }[] = [];
  const seen = new Set<string>();
  for (const li of html.matchAll(/<li[^>]*data-target=['"][^'"]*matchup\?week=(\d+)&(?:amp;)?mid1=(\d+)&(?:amp;)?mid2=(\d+)['"][^>]*>([\s\S]*?)<\/li>/gi)) {
    if (Number(li[1]) !== week) continue;
    const key = [li[2], li[3]].sort().join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    // The SCORE divs only -- `Fz-lg` with no `F-shade`. The projection sits in a `F-shade` sibling.
    const pts = [...li[4].matchAll(/<div\s+class=['"]([^'"]*\bFz-lg\b[^'"]*)['"]\s*>([^<]*)<\/div>/gi)]
      .filter((m) => !/\bF-shade\b/.test(m[1]))
      .map((m) => { const n = Number(htmlText(m[2]).replace(/,/g, "")); return Number.isFinite(n) ? n : null; });
    out.push({ week, homeId: li[2], awayId: li[3], homePts: pts[0] ?? null, awayPts: pts[1] ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The PLAYER CELL -- one markup block, shared by three pages
// ---------------------------------------------------------------------------------------------

export interface YahooPlayerCell { playerId: string; name: string; pos: string; team: string }

/**
 * The player block Yahoo renders inside a roster/players cell.
 *
 * `data-ys-playerid` is YAHOO'S OWN player id and is the identity this repo carries for a Yahoo row.
 * It is NOT an ESPN id and must never be stored as one unprefixed: 3,618 of the 8,099 `player_xref`
 * ESPN ids are five digits or fewer, which is exactly the shape of a Yahoo id, so an unprefixed
 * Yahoo id would resolve through the ESPN cross-reference to a DIFFERENT PLAYER with nothing
 * anywhere saying so. See `YAHOO_ID_PREFIX` in ./yahoo.ts.
 *
 * Returns null for a cell with no player -- an empty roster slot, a spacer row, a header.
 */
export function parseYahooPlayerCell(cell: string): YahooPlayerCell | null {
  const a = /<a[^>]+class="[^"]*\bname\b[^"]*"[^>]*>/i.exec(cell);
  if (!a) return null;
  const id = /data-ys-playerid="(\d+)"/i.exec(a[0]);
  const title = /title="([^"]+)"/i.exec(a[0]);
  if (!id || !title) return null;
  const metaM = /<span class="Fz-xxs">([\s\S]*?)<\/span>/i.exec(cell);
  const parts = (metaM ? htmlText(metaM[1]) : "").split(/\s*-\s*/);
  return {
    playerId: id[1],
    name: htmlText(title[1]),
    pos: (parts[1] ?? "").trim().toUpperCase(),
    team: (parts[0] ?? "").trim().toUpperCase(),
  };
}

/** A points cell: "20.96" -> 20.96, "-" / "" -> null. NEVER 0 for an absent number: a zero score is
 *  a real and common result, so conflating the two would invent a week of goose eggs. */
function pointsCell(cell: string | undefined): number | null {
  const t = htmlText(cell ?? "").replace(/,/g, "");
  if (!t || !/^-?[\d.]+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/<team>?week=N -- ONE team's roster AS IT STOOD IN WEEK N, with that week's points
// ---------------------------------------------------------------------------------------------

export interface YahooTeamWeekRow extends YahooPlayerCell { slot: string; points: number | null; proj: number | null }

/**
 * The week-N lineup of one team: Yahoo's own slot token, the player, his ACTUAL points and his
 * projection.
 *
 * WHY THIS PAGE AND NOT `/starters?week=N`. The all-rosters page is week-aware and carries every
 * team at once (which is cheaper), but it has exactly two columns -- Pos and Player -- and no points
 * at all. The D18 seed scores each settled week from the started lineup, so a source with no points
 * cannot seed it. Twelve fetches a week for a number that is right beats one fetch for a number that
 * is missing.
 *
 * Markup, read 2026-09-16: `<table id="statTable0">`, a two-deep header, then one row per rostered
 * man. A slot with nobody in it renders a row with no player block and is SKIPPED -- an empty IR slot
 * is an ordinary fact, and inventing a row for it would put a phantom man on the roster.
 *
 * THE COLUMN INDICES ARE NOT FIXED, AND ASSUMING THEY WERE PRODUCED A REAL, SILENT WRONG ANSWER.
 * OUR OWN team's page renders `Pos | Player | Bye | Fan Pts | Proj Pts | ...`; ANOTHER manager's
 * renders two extra action cells (Propose Trade, Add to Watch List) after the player, so Fan Pts sits
 * at index 5, not 3. Reading index 3 there returns the BYE WEEK where a score belongs -- except it
 * does not even do that, because the two header cells and the four data cells do not line up either.
 * Measured before this was fixed: 110 of the league's 120 week-1 starters landed with a NULL score,
 * every team but ours, which made the D18 seed silently fall back to the SHARED NFL actuals table --
 * i.e. to this league's points computed under ANOTHER league's scoring rules. Every team's points-for
 * was then ~30% low while the win/loss column stayed right, which is exactly the shape of a defect
 * that survives an eyeball check.
 *
 * So the score column is found by Yahoo's own marker, `class="... pts ..."` on the cell, which is
 * present and identical in both layouts; the projection is the cell after it, and the player is
 * whichever cell holds the name anchor. A row whose score column is absent is REPORTED (points null)
 * rather than guessed at from a position.
 */
export function parseYahooTeamWeek(html: string): YahooTeamWeekRow[] {
  const body = tableBody(html, /<table[^>]*id="statTable0"[^>]*>/i);
  if (body == null) {
    throw new Error("yahoo team-week: the team page carried no `statTable0` -- not logged in, wrong league/team, or Yahoo changed the markup. Refusing to report an empty lineup.");
  }
  const out: YahooTeamWeekRow[] = [];
  for (const row of tableRows(body)) {
    const cells = rowCellsTagged(row);
    if (cells.length < 5) continue;
    const pIdx = cells.findIndex((c) => parseYahooPlayerCell(c.body) != null);
    if (pIdx < 0) continue;                      // header row, or a slot nobody is in
    const player = parseYahooPlayerCell(cells[pIdx].body)!;
    const slot = htmlText(cells[0].body);
    if (!slot) continue;
    const ptsIdx = cells.findIndex((c, i) => i > pIdx && /\bclass="[^"]*\bpts\b[^"]*"/i.test(c.tag));
    out.push({
      ...player, slot,
      points: ptsIdx < 0 ? null : pointsCell(cells[ptsIdx].body),
      proj: ptsIdx < 0 ? null : pointsCell(cells[ptsIdx + 1]?.body),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/players?status=A -- the AVAILABLE pool
// ---------------------------------------------------------------------------------------------

export interface YahooAvailableRow extends YahooPlayerCell { status: string; pctRostered: number | null }

/**
 * One page (25 rows) of the available-player table.
 *
 * `status` is Yahoo's own Roster Status cell verbatim -- "FA" for a straight free agent, "W (Sep 19)"
 * for a man still on waivers. The distinction is carried rather than flattened because a claim and an
 * add are different actions with different costs, which is what `FreeAgent.waivers` means.
 *
 * THROWS when the table is absent, for the reason `types.ts` gives at length: an empty pool and a
 * failed read look identical, and a waiver script that scores an empty pool reports "no upgrade".
 */
export function parseYahooAvailable(html: string): YahooAvailableRow[] {
  const body = tableBody(html, /<table[^>]*class="[^"]*\bTable-interactive\b[^"]*"[^>]*>/i);
  if (body == null) {
    throw new Error("yahoo players: the players page carried no available-player table -- not logged in, wrong league, or Yahoo changed the markup. Refusing to report an empty free-agent pool.");
  }
  const out: YahooAvailableRow[] = [];
  for (const row of tableRows(body)) {
    const cells = rowCells(row);
    if (cells.length < 10) continue;
    // BY MARKER, NOT BY INDEX -- the same rule `parseYahooTeamWeek` documents at length. Yahoo's
    // leading cells are icon columns whose count varies with what actions the page offers.
    const pIdx = cells.findIndex((c) => parseYahooPlayerCell(c) != null);
    if (pIdx < 0) continue;
    const player = parseYahooPlayerCell(cells[pIdx])!;
    // The ONLY percentage column on this table is "% Ros"; found by shape rather than counted to.
    const pctIdx = cells.findIndex((c, i) => i > pIdx && /^-?[\d.]+\s*%$/.test(htmlText(c)));
    const pct = pctIdx < 0 ? null : /(-?[\d.]+)/.exec(htmlText(cells[pctIdx]));
    out.push({ ...player, status: htmlText(cells[pIdx + 1]), pctRostered: pct ? Number(pct[1]) : null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// /f1/<id>/transactions -- the add/drop/trade log, WITH the FAB bid
// ---------------------------------------------------------------------------------------------

export interface YahooTransactionRow {
  /**
   * Yahoo publishes no transaction id, so one is DERIVED -- and it is derived from the EVENT, never
   * from its position on the page: the team, the timestamp text, and the player ids involved, sorted.
   * A key containing the row's ordinal would change for every past transaction as soon as a new one
   * is added above it, so a re-ingest would insert the whole history again under fresh primary keys
   * and the count would just keep growing. Stated here because a derived key that looks like a
   * published one is the trap `raw_league_pick` already documents.
   */
  key: string;
  teamId: string | null; teamName: string;
  when: string;                       // Yahoo's own timestamp text, e.g. "Sep 16, 4:55 am"
  items: { action: "add" | "drop"; playerId: string; name: string; pos: string; team: string; bid: number | null; via: string }[];
}

/**
 * The transactions page.
 *
 * WHAT YAHOO PUBLISHES AND WHAT IT DOES NOT. Each row carries the team, a local timestamp, and one
 * `<div>` per player with his id, his "Cle - QB" meta and an `<h6>` note that is either "$N Waiver"
 * (a claim, with the winning bid -- FOR EVERY TEAM, not just ours) or " To Waivers" / "Free Agent".
 * There is NO transaction id, NO absolute date (only "Sep 16, 4:55 am" in the viewer's zone) and NO
 * losing bid. Those three are therefore absent from the row rather than reconstructed.
 */
export function parseYahooTransactions(html: string, leagueId: string): YahooTransactionRow[] {
  const body = tableBody(html, /<table[^>]*class="[^"]*\bTst-transaction-table\b[^"]*"[^>]*>/i);
  if (body == null) {
    throw new Error("yahoo transactions: the transactions page carried no `Tst-transaction-table` -- not logged in, wrong league, or Yahoo changed the markup.");
  }
  const out: YahooTransactionRow[] = [];
  for (const row of tableRows(body)) {
    const cells = rowCells(row);
    if (cells.length < 3) continue;
    const body2 = cells[cells.length - 2];
    const meta = cells[cells.length - 1];
    const teamHref = new RegExp(`/f1/${leagueId}/(\\d+)`).exec(meta);
    const teamNameM = /<a[^>]*class="[^"]*Tst-team-name[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(meta);
    const whenM = /<span[^>]*class="[^"]*F-timestamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(meta);
    const items: YahooTransactionRow["items"] = [];
    for (const d of body2.matchAll(/<div class="Pbot-xs">([\s\S]*?)<\/div>/gi)) {
      const idM = /data-ys-playerid="(\d+)"/i.exec(d[1]);
      const nameM = /<a[^>]+href="[^"]*\/nfl\/players\/\d+"[^>]*>([\s\S]*?)<\/a>/i.exec(d[1]);
      if (!idM || !nameM) continue;
      const posM = /<span class="F-position[^"]*">([\s\S]*?)<\/span>/i.exec(d[1]);
      const parts = (posM ? htmlText(posM[1]) : "").split(/\s*-\s*/);
      const noteM = /<h6[^>]*>([\s\S]*?)<\/h6>/i.exec(d[1]);
      const note = noteM ? htmlText(noteM[1]) : "";
      const bidM = /\$(\d+(?:\.\d+)?)/.exec(note);
      // "To Waivers" / "Dropped" = a DROP. Everything else on this page is an add (a waiver claim,
      // a free-agent add, or the incoming half of a trade), which is what the +/- icons say too.
      const action: "add" | "drop" = /waivers?$|^dropped/i.test(note.trim()) && !bidM ? "drop" : "add";
      items.push({
        action, playerId: idM[1], name: htmlText(nameM[1]),
        pos: (parts[1] ?? "").trim().toUpperCase(), team: (parts[0] ?? "").trim().toUpperCase(),
        bid: bidM ? Number(bidM[1]) : null, via: note,
      });
    }
    if (!items.length) continue;
    const teamId = teamHref ? teamHref[1] : null;
    const when = whenM ? htmlText(whenM[1]) : "";
    const ids = items.map((i) => i.playerId).sort().join(".");
    out.push({ key: `y-${teamId ?? "?"}-${when.replace(/[^0-9A-Za-z]+/g, "")}-${ids}`, teamId, teamName: teamNameM ? htmlText(teamNameM[1]) : "", when, items });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// /f1/myleagues -- "My Teams & Leagues"
// ---------------------------------------------------------------------------------------------

export interface YahooMyLeagueRow { leagueId: string; name: string | null; teamId: string | null; teamName: string | null }

/**
 * Every league this login is in, with OUR team in it.
 *
 * WHY THIS PAGE. `/` (the fantasy home) renders a mini-home for whichever league you looked at last
 * and its markup differs with how many leagues you have; `/f1/myleagues` is a plain four-column table
 * that is the same shape for one league and for ten. It is also the only surface that names our TEAM
 * beside the league, which is the field `discover_leagues` must not blank.
 *
 * SEASON IS NOT ON THIS PAGE, and is not invented here. `football.fantasysports.yahoo.com/f1/<id>`
 * with no year prefix serves the CURRENT NFL season, so the caller supplies it; the parser returns
 * what the page says and nothing more.
 */
export function parseYahooMyLeagues(html: string): YahooMyLeagueRow[] {
  const out: YahooMyLeagueRow[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const lg = /<a[^>]+href="[^"]*\/f1\/(\d+)"[^>]*>([\s\S]*?)<\/a>/i.exec(row[1]);
    if (!lg || seen.has(lg[1])) continue;
    const tm = new RegExp(`<a[^>]+href="[^"]*/f1/${lg[1]}/(\\d+)"[^>]*>([\\s\\S]*?)</a>`, "i").exec(row[1]);
    seen.add(lg[1]);
    out.push({
      leagueId: lg[1], name: htmlText(lg[2]) || null,
      teamId: tm ? tm[1] : null, teamName: tm ? htmlText(tm[2]) || null : null,
    });
  }
  return out;
}
