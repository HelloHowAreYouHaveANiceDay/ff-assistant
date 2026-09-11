// Is a lever CONNECTED? A flat backtest result means "no effect on championships" only if the lever
// actually changes what we draft. A dead lever produces the identical flat line, and the two are
// indistinguishable from the championship number alone.
//
//   node scripts/lever-connected.mjs benchNonFlex 1 0.2
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { draftFieldSeats, SIM_LEAGUE } from "../src/draft/sim.ts";
import { DEFAULT_LEVERS } from "../src/draft/levers.ts";

const [, , lever, aRaw, bRaw] = process.argv;
if (!lever) { console.error("usage: lever-connected.mjs <lever> <valueA> <valueB>   (values may be JSON)"); process.exit(2); }
// Levers are not all scalars -- posMult is an object. Passing a number where an object is expected
// silently exercises nothing and reports DEAD, which is a bug in the CHECK, not in the lever.
const parse = (v) => { try { return JSON.parse(v); } catch { return Number(v); } };
const A = parse(aRaw), B = parse(bRaw);
if (JSON.stringify(A) === JSON.stringify(B)) { console.error("valueA and valueB are identical -- that cannot detect anything"); process.exit(2); }

const readCsv = (p) => readFileSync(p, "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
const points = readCsv("data/points.csv").map((f) => ({ name: f[0].trim(), pos: f[1].trim().toUpperCase(), points: Number(f[2]) })).filter((p) => p.name && p.points);
const ourValues = new Map();
for (const f of readCsv("data/values.csv")) ourValues.set(f[0].trim(), Number(f[2]));
// Read the SHIPPED levers rather than hardcoding them -- a stale baseline here silently tests the
// lever against a config we no longer ship, so a "DEAD" verdict could be an artifact of the wrong
// base. This mirrors getConfig()'s merge (stored levers OVER code defaults) without opening the DB
// for writes (openDb migrates + seeds): read-only, exactly like scripts/read-config.mjs.
const db = new Database("data/ff.db", { readonly: true });
const storedRow = db.prepare("SELECT value FROM settings WHERE key='config'").get();
const storedLevers = storedRow ? (JSON.parse(storedRow.value).levers ?? {}) : {};
db.close();
const base = { values: Object.fromEntries(ourValues), ...DEFAULT_LEVERS, ...storedLevers };

const N = 40;
const measure = (v) => {
  const cfg = { ...base, [lever]: v };
  const posTot = {}, spends = [];
  let rosters = 0;
  for (let s = 1; s <= N; s++) {
    const { picks } = draftFieldSeats(points, ourValues, cfg, s, SIM_LEAGUE);
    const mine = picks.filter((p) => p.team === 0);
    rosters++;
    spends.push(mine.reduce((a, b) => a + b.price, 0));
    for (const p of mine) posTot[p.pos] = (posTot[p.pos] || 0) + 1;
  }
  const per = {};
  for (const k of Object.keys(posTot)) per[k] = (posTot[k] / rosters).toFixed(2);
  return { per, spend: (spends.reduce((a, b) => a + b, 0) / spends.length).toFixed(1) };
};

const a = measure(A), b = measure(B);
console.log(`${lever} = ${A}  ->  avg spend $${a.spend}  ${JSON.stringify(a.per)}`);
console.log(`${lever} = ${B}  ->  avg spend $${b.spend}  ${JSON.stringify(b.per)}`);
const changed = JSON.stringify(a.per) !== JSON.stringify(b.per) || a.spend !== b.spend;
console.log(changed
  ? `\nCONNECTED: the lever changes what we draft, so a flat championship result is a REAL null.`
  : `\nDEAD LEVER: identical rosters at both settings -- the backtest sweep measured nothing.`);
process.exit(changed ? 0 : 1);
