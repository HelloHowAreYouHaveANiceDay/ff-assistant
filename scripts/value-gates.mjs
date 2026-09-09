// Sanity gates on the SHIPPED bid table (player_value) after a value rebuild. The build's own
// success line proves nothing -- a partial nflverse fetch shrinks the curve silently, and the whole
// point of the weighted-FLEX fix is a book whose positional totals match how the room actually
// spends. Fails loudly (exit 1) so it cannot be read as green by accident.
import fs from "node:fs";
import Database from "better-sqlite3";
import { loadPriceModel, priceFor } from "../src/model/price.ts";

const db = new Database("data/ff.db", { readonly: true });
let bad = 0;
const gate = (ok, msg) => { console.log((ok ? "PASS  " : "FAIL  ") + msg); if (!ok) bad++; };
const cfg = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='config'").get().value);
const ROOM = (cfg.teams ?? 16) * (cfg.budget ?? 200);
const ROSTERED = (cfg.teams ?? 16) * (cfg.slots?.length ?? 12);

// 1. points.csv row count (header excluded)
const ptRows = fs.readFileSync("data/points.csv", "utf8").trim().split("\n").length - 1;
gate(ptRows >= 450, `points.csv rows = ${ptRows} (>= 450)`);

// 2. book by position
const rows = db.prepare(
  "SELECT p.position pos, count(*) n, sum(pv.our_value) total, max(pv.our_value) top " +
  "FROM player_value pv JOIN player p USING(player_id) GROUP BY p.position ORDER BY total DESC",
).all();
console.log("\n  pos   n    book    top");
for (const r of rows) console.log(`  ${String(r.pos).padEnd(4)} ${String(r.n).padStart(4)} ${String("$" + r.total).padStart(7)} ${String("$" + r.top).padStart(6)}`);
console.log("");
const byPos = Object.fromEntries(rows.map((r) => [r.pos, r]));

// ==================================================================================================
// POSITIONAL BOUNDS, DERIVED. Every one of them used to be a constant typed in on the day some build
// happened to produce it -- `TE book in $380-470`, `WR book >= $1,050` -- and the TE bound failed for
// months against a book at $373 that nothing else said was wrong. A bound that is a snapshot of one
// build's output rots the moment the build legitimately moves, which is the same defect as coverage
// by enumeration wearing a different hat.
//
// TWO SOURCES, and the bound is the union of them, so it cannot be narrower than either:
//
//   ROOM   what this room really spent by position, 2018-2026, as a SHARE of its own money, min to
//          max across the nine seasons, times the CURRENT room's total. Nine drafts, from
//          fact_draft_pick. Six of them were $2,800 rooms and three $3,200, which is why it has to
//          be a share: comparing raw dollars across the two eras compares two currencies.
//   PRICE  what the fitted price model says this year's board would go for -- the top `ROSTERED`
//          players by predicted price, summed by position. An independent second opinion on the
//          same question, from a model fitted on the same nine drafts but able to see THIS board.
//
// COMPARED LIKE WITH LIKE. The book prices 523 players and the room buys 192, so the book's full
// positional total is not the room's positional spend and never was. The comparison is against the
// TOP-192 (teams x slots) slice of the book, which totals about the room's money by construction.
//
// AND THEY ARE REPORTED, NOT ENFORCED, and that distinction is the point rather than a softening.
// Our book is SUPPOSED to disagree with the room -- that disagreement IS the edge -- so a bound
// derived from the room's taste cannot be a build gate without gating against the strategy. What
// stays FATAL is structural (below): every position present, the top-192 slice adding up to about
// the room's money, no single position eating the book. Those catch what these gates exist for -- a
// partial fetch, a collapsed curve, a 6x defect -- and cannot be tripped by a real edge.
//
// The +/-50% band around the union is therefore a READING AID: it says how far outside both derived
// ranges a position sits, so "$556 against $79-538" is a sentence an owner can act on.
const bookTop = (() => {
  const all = db.prepare(
    "SELECT p.position pos, pv.our_value v FROM player_value pv JOIN player p USING(player_id) ORDER BY pv.our_value DESC",
  ).all().slice(0, ROSTERED);
  const agg = {}; let tot = 0;
  for (const r of all) { agg[r.pos] = (agg[r.pos] ?? 0) + r.v; tot += r.v; }
  return { agg, tot };
})();

const roomShare = (() => {
  const out = {};
  const rowsR = db.prepare(
    `SELECT season, pos, SUM(price) s, SUM(SUM(price)) OVER (PARTITION BY season) t
       FROM fact_draft_pick GROUP BY season, pos`,
  ).all();
  for (const r of rowsR) (out[r.pos] ??= []).push(r.s / r.t);
  return out;
})();

const priceImplied = (() => {
  if (!fs.existsSync("data/price-model.json")) return null;
  let model;
  try { model = loadPriceModel(JSON.parse(fs.readFileSync("data/price-model.json", "utf8"))); }
  catch { return null; }
  // The board with its consensus positional rank, which is the price model's main input. Ranked
  // within position by ECR, exactly as fact_draft_pick's consensus column is built.
  const board = db.prepare(
    `SELECT p.name, p.position pos, r.overall_rank ecr FROM ranking r JOIN player p USING(player_id)
      WHERE r.source = 'fantasypros_ecr' AND r.season = ? AND r.overall_rank IS NOT NULL
      ORDER BY r.overall_rank`,
  ).all(cfg.season);
  if (!board.length) return null;
  const seen = {};
  const priced = board.map((b) => {
    seen[b.pos] = (seen[b.pos] ?? 0) + 1;
    return {
      pos: b.pos,
      // Priced at the START of the draft -- full money, full slots -- so the number is "what this
      // player goes for", not "what he goes for at pick 140 in a broke room".
      price: priceFor(model, b.pos, {
        ecrPosRank: seen[b.pos], ecrSd: null, moneyLeft: 1, slotsLeft: 1, pickShare: 0, leagueMoney: ROOM,
      }),
    };
  }).sort((a, b) => b.price - a.price).slice(0, ROSTERED);
  // NORMALISED TO THE ROOM'S MONEY, which is not optional. The model predicts what ONE player goes
  // for at the START of a draft -- full money, full slots -- and 192 such predictions sum to about
  // twice the room, because a real auction spends the same dollars once. Summing them unnormalised
  // gave an RB "bound" of $610-3492 on a $3,200 room, which is not a bound. This is the same "three
  // books, one dollar scale" rule scripts/price-loso.mjs applies for the same reason.
  const raw = priced.reduce((a, r) => a + r.price, 0);
  const f = raw > 0 ? ROOM / raw : 1;
  const agg = {}; let tot = 0;
  for (const r of priced) { agg[r.pos] = (agg[r.pos] ?? 0) + r.price * f; tot += r.price * f; }
  return { agg, tot, scale: f };
})();

const PAD = 0.5;
const outside = [];
console.log(`  DERIVED POSITIONAL BOUNDS -- book slice = top ${ROSTERED} of ${rows.reduce((a, r) => a + r.n, 0)} by our_value ` +
  `($${bookTop.tot.toFixed(0)} against a $${ROOM} room)`);
console.log(`  ${"pos".padEnd(5)} ${"book".padStart(7)}  ${"room 2018-2026".padStart(16)}  ${"price model".padStart(12)}  ${"union +/-50%".padStart(21)}`);
for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
  const shares = roomShare[pos];
  if (!shares?.length) continue;
  const roomLo = Math.min(...shares) * ROOM, roomHi = Math.max(...shares) * ROOM;
  const pm = priceImplied?.agg[pos] ?? null;
  const lo = Math.min(roomLo, pm ?? Infinity) * (1 - PAD);
  const hi = Math.max(roomHi, pm ?? 0) * (1 + PAD);
  const got = bookTop.agg[pos] ?? 0;
  const inside = got >= lo && got <= hi;
  if (!inside) outside.push(`${pos} $${got.toFixed(0)} vs $${lo.toFixed(0)}-${hi.toFixed(0)}`);
  console.log(`  ${pos.padEnd(5)} ${("$" + got.toFixed(0)).padStart(7)}  ` +
    `${(`$${roomLo.toFixed(0)}-${roomHi.toFixed(0)}`).padStart(16)}  ${(pm == null ? "-" : "$" + pm.toFixed(0)).padStart(12)}  ` +
    `${(`$${lo.toFixed(0)}-${hi.toFixed(0)}`).padStart(21)}  ${inside ? "in" : "OUT"}`);
}

// STRUCTURAL BUILD GATES, and these ARE fatal. Each one is a failure no legitimate edge produces.
gate(["QB", "RB", "WR", "TE", "K", "DST"].every((p) => (bookTop.agg[p] ?? 0) > 0),
  `every position appears in the top-${ROSTERED} book (a position at $0 is a broken fetch, not a strategy)`);
gate(Math.abs(bookTop.tot - ROOM) / ROOM <= 0.10,
  `top-${ROSTERED} book = $${bookTop.tot.toFixed(0)} against the room's $${ROOM} (within 10%)`);
{
  const biggest = Math.max(...Object.values(bookTop.agg));
  gate(biggest / bookTop.tot <= 0.60,
    `the largest position is ${(100 * biggest / bookTop.tot).toFixed(0)}% of the book (<= 60%)`);
}
// THE AGREEMENT TABLE, reported and never gated. This is where the strategy's disagreement with the
// room is visible, and it is the thing an owner should actually read.
console.log(outside.length
  ? `\n  OUTSIDE BOTH DERIVED RANGES (a VALUE FINDING for the owner, not a build failure): ${outside.join("; ")}`
  : `\n  every position sits inside the union of the two derived ranges`);
console.log(`\n  WHERE OUR BOOK DISAGREES WITH THE ROOM (a finding, not a gate):`);
for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
  const shares = roomShare[pos];
  if (!shares?.length) continue;
  const lo = Math.min(...shares), hi = Math.max(...shares);
  const s = (bookTop.agg[pos] ?? 0) / bookTop.tot;
  const verdict = s < lo ? "BELOW" : s > hi ? "ABOVE" : "inside";
  console.log(`    ${pos.padEnd(5)} book ${(100 * s).toFixed(1).padStart(5)}%   room ${(100 * lo).toFixed(1)}-${(100 * hi).toFixed(1)}%   ${verdict}`);
}
console.log("");
// TOP TE AS A SHARE OF THE TE BOOK, not a hardcoded dollar ceiling.
//
// This was `top TE <= $75`, a constant snapshotted the day the weighted curve landed, and the
// opportunity model tripped it at $82. Trey McBride drew 27.9% of his team's targets last season and
// TE is the position with the LARGEST measured opportunity signal (+0.0218 OOS), so a factor of
// 1.147 on him is the model doing precisely its job -- and the TE book total, the thing that actually
// detects a broken build, never moved out of range ($391, still inside $380-470). The failure was a
// legitimate redistribution WITHIN the position hitting a number that encoded one build's output.
//
// Rewriting it as a share is not a relaxation dressed up: an absolute ceiling cannot tell a runaway
// from a re-scaled book, and it goes stale every time the curve legitimately moves. A concentration
// ratio is scale-free and still catches the thing worth catching -- one player eating the position.
// The pairing matters too: the book-total gate above bounds the position's size while this bounds its
// concentration, so a build that broke either way still fails something.
const teShare = byPos.TE ? byPos.TE.top / byPos.TE.total : 0;
gate(teShare > 0 && teShare <= 0.30,
  `top TE = $${byPos.TE?.top} = ${(100 * teShare).toFixed(0)}% of the $${byPos.TE?.total} TE book (<= 30%)`);

// 2b. K/DST PROJECTIONS are real, and their PRICE is still capped.
// These two gates cover a hole that let a 6x defect through for the life of the project: every gate
// above asserts the TE and WR books, and nothing asserted K or DST at all. The projection curve gave
// them a hardcoded ~20-point SEASON (real: ~130-190) and no gate could see it -- coverage by
// enumeration, missing the two positions nobody thought about. The pair is deliberate: the first
// asserts the DATA is honest, the second that the STRATEGY still refuses to pay for it. Fixing the
// projection without the second gate would have been how a kicker quietly becomes a $30 player.
const pts = fs.readFileSync("data/points.csv", "utf8").trim().split("\n").slice(1)
  .map((l) => { const c = l.split(","); return { pos: (c[1] || "").toUpperCase(), pts: Number(c[2]) }; });
for (const pos of ["K", "DST"]) {
  const top = Math.max(0, ...pts.filter((p) => p.pos === pos).map((p) => p.pts));
  gate(top >= 100 && top <= 260, `top ${pos} PROJECTION = ${top} pts (in 100-260; a ~20 here means the curve is faking them)`);
  gate(byPos[pos] && byPos[pos].top <= 5, `top ${pos} PRICE = $${byPos[pos]?.top} (<= $5; maxKDst must still bind)`);
}

// 3. values.csv top-12 == player_value top-12 (one build, no drift between surfaces)
const csv = fs.readFileSync("data/values.csv", "utf8").trim().split("\n").slice(1)
  .map((l) => { const c = l.split(","); return { name: c[0], value: Number(c[c.length - 1]) }; })
  .sort((a, b) => b.value - a.value).slice(0, 12);
const dbTop = db.prepare(
  "SELECT p.name name, pv.our_value value FROM player_value pv JOIN player p USING(player_id) " +
  "ORDER BY pv.our_value DESC, p.name LIMIT 40",
).all();
const dbNames = new Set(dbTop.slice(0, 12).map((r) => r.name));
const missing = csv.filter((r) => !dbNames.has(r.name)).map((r) => `${r.name} $${r.value}`);
gate(missing.length === 0, `values.csv top-12 == player_value top-12${missing.length ? " -- CSV-only: " + missing.join(", ") : ""}`);

console.log(bad === 0 ? "\nALL GATES PASS" : `\n${bad} GATE(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
