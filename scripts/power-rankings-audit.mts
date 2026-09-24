// DEEP CHECK ON THE POWER RANKING: reproduce `startPts` by hand and find what drives it.
//
// `powerRankings` reports us #1 of 16 on 1407 projected starter points, +131 over the league mean,
// while we sit 5th of 16 on points ACTUALLY scored through two weeks. Both can be true -- one is a
// projection and the other a result -- but a gap that large deserves to be opened rather than
// explained away.
//
// THREE THINGS THIS CHECKS, because "is 1407 right" is really three questions:
//   1. REPRODUCIBILITY -- recompute the optimal-8 sum from the same context and see if it matches.
//      If it does not, the number is wrong for a reason that has nothing to do with football.
//   2. CONCENTRATION -- is the lead one inflated player, or spread across the lineup? A +131 edge
//      that is one man's projection is a different claim from one that is eight men's.
//   3. AGREEMENT WITH REALITY -- each starter's projection against what he has actually averaged.
//      A roster whose projections sit far above its own production is a roster the model likes and
//      the field has not yet seen.
//
// `available: true` FOR EVERYONE is how powerRankings scores a roster, deliberately -- it grades the
// roster, not this week's availability. So an injured man still counts, and that is worth showing
// explicitly rather than leaving in a docstring: Michael Pittman Jr. is OUT and still contributes.
import { loadSimContext } from "../src/draft/simContext.ts";
import { optimalLineup } from "../src/inseason/lineup.ts";
import Database from "better-sqlite3";

const LEAGUE = "462233";
const ctx = await loadSimContext({ leagueId: LEAGUE, schedule: "real" });
const db = new Database("data/ff.db", { readonly: true });

// What each man has ACTUALLY averaged per game in the settled weeks -- an independent yardstick.
const actual = new Map<string, { pts: number; n: number }>();
for (const r of db.prepare(
  `SELECT name, SUM(applied_points) pts, COUNT(*) n FROM raw_league_roster_week
    WHERE league_id=? AND season=2026 AND week<=2 AND is_starter=1 AND applied_points IS NOT NULL
    GROUP BY name`,
).all(LEAGUE) as { name: string; pts: number; n: number }[]) actual.set(r.name, { pts: r.pts, n: r.n });

const rows = ctx.teams.map((t, i) => {
  const starters = optimalLineup(t.roster.map((p) => ({ ...p, available: true })), ctx.slots, ctx.flexOk).starters;
  return {
    id: t.id, name: t.name, us: i === ctx.meIdx,
    startPts: Math.round(starters.reduce((a, s) => a + s.proj, 0)),
    starters,
  };
}).sort((a, b) => b.startPts - a.startPts);

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const leagueMean = Math.round(mean(rows.map((r) => r.startPts)));
console.log(`recomputed from the same context: league mean ${leagueMean}`);
console.log("rank team        startPts   vs mean");
rows.forEach((r, i) => console.log(
  `  ${String(i + 1).padStart(2)}  ${r.name.padEnd(11)} ${String(r.startPts).padStart(8)} ${((r.startPts - leagueMean >= 0 ? "+" : "") + (r.startPts - leagueMean)).padStart(9)}${r.us ? "   <-- US" : ""}`,
));

const ours = rows.find((r) => r.us)!;
const second = rows.filter((r) => !r.us)[0];
console.log(`\nOUR OPTIMAL 8 (the 1407), against what each man has actually averaged:`);
console.log("  slot  player                  proj    per-gm   actual/gm   gap");
for (const s of ours.starters) {
  const a = actual.get(s.name);
  const perGm = s.proj / 13;                    // 13 remaining scheduled weeks in this format
  const act = a && a.n ? a.pts / a.n : null;
  console.log(
    `  ${String(s.slot).padEnd(5)} ${String(s.name).padEnd(22)} ${s.proj.toFixed(1).padStart(6)} ` +
    `${perGm.toFixed(1).padStart(8)} ${(act == null ? "-" : act.toFixed(1)).padStart(11)} ` +
    `${(act == null ? "-" : ((perGm - act >= 0 ? "+" : "") + (perGm - act).toFixed(1))).padStart(6)}`,
  );
}

// CONCENTRATION: how much of the lead over second place is one man?
console.log(`\nCONCENTRATION -- our lead over ${second.name} is ${ours.startPts - second.startPts} pts`);
const ourSorted = [...ours.starters].sort((a, b) => b.proj - a.proj);
const secSorted = [...second.starters].sort((a, b) => b.proj - a.proj);
console.log("  slot-for-slot, best to worst:");
for (let i = 0; i < Math.max(ourSorted.length, secSorted.length); i++) {
  const a = ourSorted[i], b = secSorted[i];
  const d = (a?.proj ?? 0) - (b?.proj ?? 0);
  console.log(
    `   ${String(i + 1).padStart(2)}. ${String(a?.name ?? "-").padEnd(22)} ${(a?.proj ?? 0).toFixed(1).padStart(6)}   ` +
    `${String(b?.name ?? "-").padEnd(22)} ${(b?.proj ?? 0).toFixed(1).padStart(6)}   ${((d >= 0 ? "+" : "") + d.toFixed(1)).padStart(7)}`,
  );
}
db.close();
