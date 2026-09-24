// WHICH OF THE SERVED MODEL'S FEATURES ACTUALLY REACH A LIVE DECISION?
//
// The second round of feature exploration turned this up before it found a candidate, and it is
// worth more: several feeds the weekly model FITS are dead or dying in the live season, so the
// board is served from a degraded design no matter what is added to it.
//
// The logic is the same one that made `ecr_wk_rank` the most valuable thing in the model: a feature
// is worth its admission number ONLY on the weeks it is present. A column fitted on fourteen
// seasons and absent at serve contributes nothing, and worse than nothing if the trees learned to
// lean on it -- that is D19's gate-7 collapse in miniature.
//
// TWO POPULATIONS, because they answer different questions:
//   ALL      every skill row in the week. Says whether a FEED is alive.
//   OURS     our own rostered men. Says whether THIS WEEK'S DECISION had the information, which is
//            the only thing that changes a lineup.
// A feed can look healthy league-wide and be missing exactly the men we start, or the reverse --
// the panel does not rank deep bench, so league-wide coverage understates what a starter gets.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const SEASON = Number(process.argv[2] ?? 2026);
const WEEK = Number(process.argv[3] ?? 3);
const TEAM = 8;
const db = new Database("data/ff.db", { readonly: true });

const art = JSON.parse(readFileSync("data/weekly-artifact.json", "utf8"));
const FEATS = art.features.map((f) => f.name);
const cols = new Set(db.prepare("PRAGMA table_info(feat_player_week_model)").all().map((c) => c.name));
const present = FEATS.filter((f) => cols.has(f) || f === "week_no");

const SKILL = "('QB','RB','WR','TE')";
const rows = db.prepare(
  `SELECT name, pos, ${present.filter((f) => f !== "week_no").map((f) => f).join(", ")}
     FROM feat_player_week_model WHERE season=? AND week=? AND pos IN ${SKILL}`,
).all(SEASON, WEEK);

// `String(TEAM)`, NOT `TEAM`. `raw_league_roster_week.team_id` is declared TEXT, and a BOUND
// PARAMETER carries no affinity, so `team_id = ?` with the integer 8 matches ZERO rows -- while the
// literal `team_id = 8` written into the SQL matches 12, because a literal does get coerced. The
// first version of this audit reported that our own starters had 0% coverage on every feature,
// which is both alarming and false. Measured: bound 0 rows, literal 12, typeof(team_id) = 'text'.
const mine = new Set(db.prepare(
  `SELECT name FROM raw_league_roster_week WHERE season=? AND week=? AND team_id=?`,
).all(SEASON, WEEK, String(TEAM)).map((r) => r.name));
if (!mine.size) {
  console.error(`no roster rows for team ${TEAM} in ${SEASON} week ${WEEK} -- the OURS column would`);
  console.error("be a silent 0% on every feature, so this refuses rather than reporting it.");
  process.exit(1);
}
const ours = rows.filter((r) => mine.has(r.name));

// A HISTORICAL COMPARISON IS WHAT MAKES A LOW NUMBER READABLE. Some columns are legitimately sparse
// everywhere (rookies have no prior season); what matters is a column that WAS present historically
// at the same week and is not now. Without this baseline a structural 60% reads as an outage.
const hist = db.prepare(
  `SELECT ${present.filter((f) => f !== "week_no").map((f) => `AVG(${f} IS NOT NULL) AS ${f}`).join(", ")}
     FROM feat_player_week_model WHERE week=? AND season BETWEEN 2018 AND 2024 AND pos IN ${SKILL}`,
).get(WEEK);

const pct = (list, f) => (list.length ? (100 * list.filter((r) => r[f] != null).length) / list.length : 0);
const f1 = (x) => (x == null ? "  n/a" : x.toFixed(1).padStart(5) + "%");

console.log(`LIVE FEATURE AUDIT -- season ${SEASON} week ${WEEK} | ${rows.length} skill rows, ${ours.length} of them ours`);
console.log(`the served artifact declares ${FEATS.length} features; ${present.length} resolve to a stored column\n`);
console.log("feature                    ALL     OURS    2018-24 wk" + WEEK + "   status");

const flags = [];
for (const f of present) {
  if (f === "week_no") continue;
  const a = pct(rows, f), o = pct(ours, f), h = 100 * Number(hist[f] ?? 0);
  // DEGRADED means "present historically at this week, and not now" -- a drop of 25+ points against
  // the same week in prior seasons. That is a feed problem. A column that was always sparse is not.
  const dead = a < 1 && h >= 25;
  const degraded = !dead && h - a >= 25;
  const status = dead ? "DEAD" : degraded ? "DEGRADED" : "";
  if (status) flags.push({ f, a, o, h, status });
  console.log(f.padEnd(26), f1(a), f1(o), f1(h).padStart(11), "  " + status);
}

console.log("");
if (!flags.length) {
  console.log("no feature is materially worse at serve than it was at the same week historically.");
} else {
  console.log(`${flags.length} FEATURE(S) THE MODEL FITS ARE NOT REACHING THIS DECISION:`);
  for (const x of flags) {
    console.log(`  ${x.status.padEnd(9)} ${x.f.padEnd(24)} ours ${x.o.toFixed(0)}% vs ${x.h.toFixed(0)}% historically`);
  }
  console.log("\nThe projector serves each as its declared missing value, so these rows lean harder on");
  console.log("the season-line anchor than any fitted season did. That is a live degradation of the");
  console.log("SHIPPED model, and no new feature can compensate for it.");
}
db.close();
