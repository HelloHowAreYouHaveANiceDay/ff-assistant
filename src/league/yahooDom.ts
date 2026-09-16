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
 *   /f1/<id>/?matchup_week=N    the week-N scoreboard; each game is a `matchup?week=N&mid1=A&mid2=B` link
 */
import type { ScoringRules } from "../draft/scoring.js";

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
