// Survey the DynastyProcess historical FantasyPros ECR archive.
//
//   node scripts/survey-fpecr.mjs <path-to-db_fpecr.csv.gz>
//
// This is the file I told the user we did not have. data/board carries ECR best/worst for TODAY, so
// the per-player-uncertainty idea could be described but never tested -- there was no history to
// test it against. db_fpecr.csv.gz is that history: ecr, sd, best and worst per player per
// scrape_date, going back years.
//
// Streamed rather than loaded. The file is ~100 MB gzipped and expands past a gigabyte; reading it
// into memory to answer "what is in here" would be a slow way to fail.
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const path = process.argv[2];
if (!path) { console.log("usage: node scripts/survey-fpecr.mjs <db_fpecr.csv.gz>"); process.exit(1); }

const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
let header = null, idx = {}, n = 0;
const byType = new Map(), byYear = new Map(), sdByType = new Map();
const posSeen = new Set();

for await (const line of rl) {
  if (!header) {
    header = line.split(",");
    header.forEach((h, i) => (idx[h.trim()] = i));
    continue;
  }
  // Naive split is safe for the columns we read: they sit before any quoted free-text field, and we
  // only touch numeric/short-token columns. Checked against the head of the file.
  const f = line.split(",");
  const type = f[idx.ecr_type], date = f[idx.scrape_date], pos = f[idx.pos], sd = Number(f[idx.sd]);
  if (!type || !date) continue;
  n++;
  byType.set(type, (byType.get(type) ?? 0) + 1);
  const yr = date.slice(0, 4);
  byYear.set(yr, (byYear.get(yr) ?? 0) + 1);
  if (pos) posSeen.add(pos);
  if (Number.isFinite(sd)) {
    const a = sdByType.get(type) ?? { n: 0, sum: 0, zero: 0 };
    a.n++; a.sum += sd; if (sd === 0) a.zero++;
    sdByType.set(type, a);
  }
}
console.log(`${n.toLocaleString()} rows\n`);
console.log("rows by ecr_type (which ranking list):");
for (const [t, c] of [...byType].sort((a, b) => b[1] - a[1])) {
  const s = sdByType.get(t);
  console.log(`  ${t.padEnd(10)} ${String(c).padStart(9)}   mean sd ${s ? (s.sum / s.n).toFixed(2).padStart(6) : "   n/a"}   ${s ? ((100 * s.zero) / s.n).toFixed(0) + "% have sd=0" : ""}`);
}
console.log("\nrows by year:");
for (const [y, c] of [...byYear].sort()) console.log(`  ${y}  ${String(c).padStart(9)}`);
console.log(`\npositions: ${[...posSeen].sort().join(", ")}`);
console.log(`
The type that matters for us is the PRESEASON REDRAFT list -- our board is a redraft board and the
projection curve is applied at redraft ECR. A dynasty or best-ball list measures a different quantity
and would answer a different question.`);
