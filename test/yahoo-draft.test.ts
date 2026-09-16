/**
 * THE LEAGUE'S OWN DRAFT, FROM THE PAGE TO THE STORE (M2e).
 *
 * Three layers, each with a fault injection, because every one of them can fail by returning
 * something PLAUSIBLE:
 *
 *   the parsers   a draft-results page that came back short, or in the wrong order, still parses.
 *                 It happened: the first cell parser did not recognise Yahoo's team-DEFENSE anchor
 *                 (`/nfl/teams/<slug>/` rather than `/nfl/players/<id>`), so league 129048's 2025
 *                 draft came back with 169 of its 180 picks AND every pick after a defense shifted
 *                 one slot earlier. Both fixtures are pinned here and the 2025 one is that regression.
 *   the checks    `yahooDraftFromHtml` refuses a draft that is not rectangular, not serpentine, or
 *                 not agreed between the two tabs. A guard that can only ever say "no" is dead code
 *                 and a guard that can only ever say "yes" is worse, so each is exercised BOTH ways.
 *   the loader    `loadYahooDraftHistory` writes 129048's rows and must not touch another league's.
 *                 Two leagues in one store is the only condition under which that is observable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, nowIso, type DB } from "../src/db/db.js";
import { parseYahooDraftByTeam, parseYahooDraftPeriods, parseYahooDraftResults } from "../src/league/yahooDom.js";
import { yahooDraftFromHtml } from "../src/league/yahoo.js";
import { loadYahooDraftHistory } from "../src/data/leagueHistory.js";
import { serpentineOrder } from "../src/draft/draftModel.js";

const fx = (n: string) => readFileSync(join("test/fixtures/yahoo", n), "utf8");
const R26 = fx("draft-round-2026-129048.html"), T26 = fx("draft-team-2026-129048.html");
const R25 = fx("draft-round-2025-129048.html"), T25 = fx("draft-team-2025-129048.html");

test("the season selector names its seasons, and a label with no year is refused", () => {
  const ps = parseYahooDraftPeriods(R26);
  assert.deepEqual(ps.map((p) => [p.value, p.season]), [["current", 2026], ["previous", 2025]]);
  // FAULT INJECTION: a label Yahoo could plausibly print that names no season must throw rather than
  // default to "this year" -- a prior season silently stamped 2026 would overwrite the real one.
  const broken = R26.replace("2026 draft order", "Current draft order");
  assert.throws(() => parseYahooDraftPeriods(broken), /names no four-digit season/);
});

test("2026: the round tab is 204 picks, 17 rounds, 12 teams, in pick order", () => {
  const picks = parseYahooDraftResults(R26, 12);
  assert.equal(picks.length, 204);
  assert.equal(Math.max(...picks.map((p) => p.round)), 17);
  assert.equal(new Set(picks.map((p) => p.teamName)).size, 12);
  assert.equal(picks[0].name, "Jahmyr Gibbs");
  assert.equal(picks[0].pos, "RB");
  assert.equal(picks[0].overallPick, 1);
  assert.equal(picks[203].overallPick, 204);
  // Every pick number appears exactly once.
  assert.equal(new Set(picks.map((p) => p.overallPick)).size, 204);
});

test("2025: a TEAM DEFENSE is a pick -- 180 of them, not 169 (the shift regression)", () => {
  const picks = parseYahooDraftResults(R25, 12);
  assert.equal(picks.length, 180, "a defense row must consume its pick slot, not be skipped");
  const defs = picks.filter((p) => p.pos === "DEF");
  assert.equal(defs.length, 11);
  assert.ok(defs.every((d) => d.playerId.startsWith("def:")), "a defense has no numeric Yahoo player id and must not be given one");
  // The 2025 draft also carries two picks Yahoo no longer names. They are kept verbatim rather than
  // dropped: a missing pick would shift every later one, which is the same defect in another costume.
  assert.equal(picks.filter((p) => p.name === "--empty--").length, 2);
});

test("the two tabs agree on every overall pick number, in both seasons", () => {
  for (const [round, team, n] of [[R26, T26, 204], [R25, T25, 180]] as const) {
    const picks = parseYahooDraftResults(round, 12);
    const byTeam = parseYahooDraftByTeam(team);
    assert.equal(byTeam.length, 12);
    assert.equal(byTeam.reduce((a, b) => a + b.picks.length, 0), n);
    const overall = new Map(byTeam.flatMap((t) => t.picks.map((p) => [p.playerId, p.overallPick] as const)));
    for (const p of picks) assert.equal(overall.get(p.playerId), p.overallPick, `${p.name}`);
  }
});

test("the draft is serpentine, and it is the SnakeModel's own serpentine", () => {
  const d = yahooDraftFromHtml(R26, T26, { season: 2026, period: "current", teams: 12 });
  assert.equal(d.rounds, 17);
  // THE POSITIVE HALF, against the model rather than against a restatement of the check. The order
  // the real league drafted in must be the order `serpentineOrder(12, 17)` generates -- if the two
  // ever disagree, one of them is not a snake draft.
  const model = serpentineOrder(12, 17);
  d.picks.forEach((p, i) => assert.equal(d.slotOf.get(p.teamName), model[i], `pick ${p.overallPick}`));
});

/** The `<tbody>` of one round of the round tab, so an injection can edit exactly that round. */
function roundBody(html: string, round: number): string {
  const m = new RegExp(`<th[^>]*>\\s*Round\\s+${round}\\s*</th>[\\s\\S]*?<tbody>([\\s\\S]*?)</tbody>`, "i").exec(html);
  assert.ok(m, `fixture has no round ${round}`);
  return m[1];
}
/** The team names of one round's rows, in row order. */
const teamCells = (body: string) => [...body.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);

test("each of the three checks REFUSES when its invariant is broken", () => {
  const opts = { season: 2026, period: "current", teams: 12 } as const;

  // (1) THE TABS DISAGREE. Move one pick's overall number on the team tab only.
  const shifted = T26.replace('<td class="pick Px-xs">(24)</td>', '<td class="pick Px-xs">(23)</td>');
  assert.notEqual(shifted, T26, "the fault injection must actually change the fixture");
  assert.throws(() => yahooDraftFromHtml(R26, shifted, opts), /disagree on 1 pick/);

  // (2) NOT RECTANGULAR. Give round 4's first pick to the team that made its second, so one team has
  // 18 picks and another 16. The team COLUMN is the only thing that moves, and check 1 does not read
  // it -- which is what makes this reach check 2 rather than being caught upstream. (Passing a wrong
  // `teams` count does NOT reach it: the round tab's overall numbers are derived from that count, so
  // check 1 fires first. That is the cross-check doing its job, not this guard failing to.)
  const b4 = roundBody(R26, 4);
  const [a4, c4] = teamCells(b4);
  assert.notEqual(a4, c4);
  const dup = R26.replace(b4, b4.replace(new RegExp(`title="${a4}"`), `title="${c4}"`).replace(`>${a4}<`, `>${c4}<`));
  assert.notEqual(dup, R26);
  assert.throws(() => yahooDraftFromHtml(dup, T26, opts), /has 1[68] picks, not 17/);

  // (3) NOT SERPENTINE, with the counts intact. Transpose two team cells INSIDE round 3: every team
  // still has 17 picks and every overall number still agrees, so only the order check can see it.
  const b3 = roundBody(R26, 3);
  const [a3, c3] = teamCells(b3);
  const swapped = b3.replace(new RegExp(`title="${a3}"`), 'title="__A__"').replace(new RegExp(`title="${c3}"`), `title="${a3}"`).replace('title="__A__"', `title="${c3}"`);
  assert.notEqual(swapped, b3);
  assert.throws(() => yahooDraftFromHtml(R26.replace(b3, swapped), T26, opts), /not the serpentine/);

  // THE POSITIVE HALF: the unmutated pages pass all three.
  assert.equal(yahooDraftFromHtml(R26, T26, opts).picks.length, 204);
});

function withStore(fn: (db: DB) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ff-m2e-"));
  const db = openDb(join(dir, "t.db"));
  try { fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("the loader writes only its own league's rows, and writes NULL where Yahoo has no number", () => {
  withStore((db) => {
    const now = nowIso();
    // An ESPN-shaped auction pick already in the store -- another league, with a real price.
    db.prepare("INSERT INTO raw_league_pick (league_id,season,pick_no,team_id,name,pos,price,owner_id,owner,fetched_at) VALUES ('E1',2024,1,'3','Someone','RB',42,'o','Owner',?)").run(now);
    const d = yahooDraftFromHtml(R26, T26, { season: 2026, period: "current", teams: 12 });
    const teams = [...d.slotOf.keys()].map((n) => ({ teamId: n, name: n }));
    const counts = loadYahooDraftHistory(db, "129048", [{
      season: 2026, teams, slotCounts: { QB: 1, BE: 7 },
      picks: d.picks.map((p) => ({ pickNo: p.overallPick, teamId: p.teamName, name: p.name, pos: p.pos })),
      note: "test",
    }], now);
    assert.equal(counts.picks, 204);
    assert.equal(counts.teams, 12);

    // THE TWO-LEAGUE DIFFERENTIAL. E1's row is byte-identical afterwards; 129048's 204 are present.
    const espn = db.prepare("SELECT * FROM raw_league_pick WHERE league_id='E1'").all() as Record<string, unknown>[];
    assert.equal(espn.length, 1);
    assert.equal(espn[0].price, 42);
    assert.equal(espn[0].owner, "Owner");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM raw_league_pick WHERE league_id='129048'").get<{ n: number }>().n, 204);

    // A SNAKE PICK HAS NO PRICE, and the column says so rather than saying $0.
    const prices = db.prepare("SELECT DISTINCT price FROM raw_league_pick WHERE league_id='129048'").all() as { price: number | null }[];
    assert.deepEqual(prices, [{ price: null }]);
    const s = db.prepare("SELECT size, auction_budget, ppr_points FROM raw_league_season WHERE league_id='129048' AND season=2026").get() as Record<string, unknown>;
    assert.equal(s.size, 12);
    assert.equal(s.auction_budget, null, "a snake has no budget and must not be given one");
    assert.equal(s.ppr_points, null);

    // THE SERPENTINE SURVIVES THE ROUND TRIP. Read the rows back in pick order and check the order
    // against the model -- the invariant is asserted on what is IN THE STORE, not on what was parsed.
    const rows = db.prepare("SELECT pick_no, team_id FROM raw_league_pick WHERE league_id='129048' AND season=2026 ORDER BY pick_no").all() as { pick_no: number; team_id: string }[];
    assert.equal(rows.length, 204);
    const slot = new Map<string, number>();
    rows.slice(0, 12).forEach((r, i) => slot.set(r.team_id, i));
    const model = serpentineOrder(12, 17);
    rows.forEach((r, i) => assert.equal(slot.get(r.team_id), model[i], `stored pick ${r.pick_no}`));
    // Every team has exactly 17.
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.team_id, (per.get(r.team_id) ?? 0) + 1);
    assert.deepEqual([...new Set(per.values())], [17]);
  });
});

test("re-loading a season REPLACES its picks rather than accumulating ghosts", () => {
  withStore((db) => {
    const now = nowIso();
    const d = yahooDraftFromHtml(R26, T26, { season: 2026, period: "current", teams: 12 });
    const arg = (picks: typeof d.picks) => [{
      season: 2026, teams: [...d.slotOf.keys()].map((n) => ({ teamId: n, name: n })), slotCounts: {},
      picks: picks.map((p) => ({ pickNo: p.overallPick, teamId: p.teamName, name: p.name, pos: p.pos })),
      note: "test",
    }];
    loadYahooDraftHistory(db, "129048", arg(d.picks), now);
    // A SHORTER DRAFT (the 2025 shape) must leave no rounds 15-17 behind. Without the delete the
    // season would read 204 picks forever, 36 of them from a roster template that no longer exists.
    loadYahooDraftHistory(db, "129048", arg(d.picks.filter((p) => p.round <= 14)), now);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM raw_league_pick WHERE league_id='129048'").get<{ n: number }>().n, 168);
  });
});
