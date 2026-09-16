// Ground-truth YAHOO_129048_SCORING against real player-weeks: compute OUR Yahoo score from the
// nflverse stats_player_week feed and print a full component breakdown, so it can be checked against
// Yahoo's own applied points (charter rule 4 -- verify against the other side's numbers). Read-only.
import { fetchCsvCached, playerWeekUrl, cacheTag, pick } from "../src/data/nflverse.ts";
import { scoreWeek, YAHOO_129048_SCORING } from "../src/draft/scoring.ts";

const season = Number(process.argv[2] ?? 2026);
const weeks = (process.argv[3] ?? "1,2").split(",").map(Number);
const names = (process.argv[4] ?? "").split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);

const rows = await fetchCsvCached(playerWeekUrl(season), cacheTag.playerWeek(season));
const nz = (r, k) => { const v = Number(r[k]); return Number.isFinite(v) ? v : 0; };
const want = (n) => names.length === 0 || names.some((q) => n.toLowerCase().includes(q));

const out = [];
for (const r of rows) {
  if (pick(r, "season_type") !== "REG") continue;
  const wk = Number(pick(r, "week")); if (!weeks.includes(wk)) continue;
  const name = pick(r, "player_display_name"); if (!name || !want(name)) continue;
  const pos = pick(r, "position").toUpperCase();
  if (!["QB", "RB", "WR", "TE"].includes(pos)) continue;
  const total = scoreWeek(r, YAHOO_129048_SCORING, pos);
  out.push({
    name, pos, wk,
    pyd: nz(r, "passing_yards"), ptd: nz(r, "passing_tds"), int: nz(r, "passing_interceptions"),
    ryd: nz(r, "rushing_yards"), rtd: nz(r, "rushing_tds"),
    recyd: nz(r, "receiving_yards"), rectd: nz(r, "receiving_tds"), rec: nz(r, "receptions"),
    p1d: nz(r, "passing_first_downs"), ru1d: nz(r, "rushing_first_downs"), re1d: nz(r, "receiving_first_downs"),
    p40: nz(r, "passing_40"), ru40: nz(r, "rushing_40"), re40: nz(r, "receiving_40"),
    total: Math.round(total * 100) / 100,
  });
}
out.sort((a, b) => a.name.localeCompare(b.name) || a.wk - b.wk);
for (const o of out) {
  console.log(
    `${o.name} (${o.pos}) wk${o.wk}: OURS=${o.total}  | ` +
    `pass ${o.pyd}yд/${o.ptd}td/${o.int}int/${o.p1d}fd/${o.p40}@40 | ` +
    `rush ${o.ryd}yд/${o.rtd}td/${o.ru1d}fd/${o.ru40}@40 | ` +
    `rec ${o.rec}c/${o.recyd}yд/${o.rectd}td/${o.re1d}fd/${o.re40}@40`,
  );
}
console.log(`\n${out.length} player-weeks (season ${season}, weeks ${weeks.join(",")})`);
