// Sanity gates on the SHIPPED bid table (player_value) after a value rebuild. The build's own
// success line proves nothing -- a partial nflverse fetch shrinks the curve silently, and the whole
// point of the weighted-FLEX fix is a book whose positional totals match how the room actually
// spends. Fails loudly (exit 1) so it cannot be read as green by accident.
import fs from "node:fs";
import Database from "better-sqlite3";

const db = new Database("data/ff.db", { readonly: true });
let bad = 0;
const gate = (ok, msg) => { console.log((ok ? "PASS  " : "FAIL  ") + msg); if (!ok) bad++; };

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
gate(byPos.TE && byPos.TE.total >= 380 && byPos.TE.total <= 470, `TE book = $${byPos.TE?.total} (in $380-470)`);
gate(byPos.WR && byPos.WR.total >= 1050, `WR book = $${byPos.WR?.total} (>= $1,050)`);
gate(byPos.TE && byPos.TE.top <= 75, `top TE = $${byPos.TE?.top} (<= $75)`);

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
