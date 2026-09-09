/**
 * `node --import tsx scripts/faab-leakage.mjs [--inject <mode>]`
 *
 * THE POINT-IN-TIME GUARD for `fact_waiver_claim`, and the reason it takes an `--inject` flag.
 *
 * A leakage check that only ever passes is indistinguishable from one whose input never reaches the
 * thing it checks -- this repo has paid for that four times. So each guard here is paired with a
 * mutation that MUST break it, and `--inject <mode>` applies that mutation to the rows before the
 * guards run. A run with no flag must be all-PASS; every injected run must FAIL the named guard and
 * only that guard.
 *
 *   faab-includes-self   the claiming team's remaining budget is charged its OWN bid  -> G1
 *   prior-is-current     `prior_pts` reads week w instead of week w-1                 -> G2
 *   need-current-week    positional need is read off the week-w roster, after the run -> G3
 *   rank-from-outcome    `pos_line_rank` is re-derived from rest-of-season points     -> G4
 *   leak-feature         the model artifact lists a target column as an input         -> G5
 *
 * Each guard recomputes its column from the RAW log or the roster fact table -- a second path to the
 * same number, never the stored column compared against itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "../src/db/db.js";
import { claimantOf, NULL_TEAM, UNPROCESSED } from "../src/features/sources/faab.js";

const argv = process.argv.slice(2);
const inject = argv.includes("--inject") ? argv[argv.indexOf("--inject") + 1] : null;
const dbPath = (argv.includes("--db") ? argv[argv.indexOf("--db") + 1] : undefined) ?? "data/ff.db";
const ARTIFACT = "data/faab-model.json";
const db = openDb(dbPath);

const rows = db.prepare("SELECT * FROM fact_waiver_claim ORDER BY season, proposed_at_ms, transaction_id").all();
if (!rows.length) { console.log("fact_waiver_claim is empty -- run scripts/faab-coverage.mjs --build first."); process.exit(1); }

const results = [];
const check = (id, what, ok, detail) => { results.push({ id, what, ok, detail }); };

// ---- G1: the claiming team's remaining budget, recomputed from the raw log --------------------
{
  const raw = db.prepare(
    `SELECT season, transaction_id, team_id, to_team_id, espn_player_id, bid_amount, status, proposed_at_ms
       FROM raw_league_transaction
      WHERE type='WAIVER' AND item_type='ADD' AND status IS NOT NULL
      ORDER BY season, COALESCE(proposed_at_ms,0), transaction_id`).all()
    .filter((c) => !UNPROCESSED.has(c.status) && claimantOf(c) != null && c.bid_amount != null && c.team_id !== undefined);
  const expect = new Map();
  const spent = new Map();
  let i = 0;
  while (i < raw.length) {
    const head = raw[i];
    let j = i;
    while (j < raw.length && raw[j].season === head.season && raw[j].proposed_at_ms === head.proposed_at_ms) j++;
    const budget = 100;
    for (const c of raw.slice(i, j)) {
      const t = claimantOf(c);
      expect.set(`${c.season}|${c.transaction_id}|${c.espn_player_id}`, budget - (spent.get(`${c.season}|${t}`) ?? 0));
    }
    for (const c of raw.slice(i, j)) {
      if (c.status !== "EXECUTED") continue;
      const t = claimantOf(c);
      spent.set(`${c.season}|${t}`, (spent.get(`${c.season}|${t}`) ?? 0) + c.bid_amount);
    }
    i = j;
  }
  const seen = rows.map((r) => ({
    ...r,
    team_faab_left: inject === "faab-includes-self" && r.won === 1 ? r.team_faab_left - r.bid_amount : r.team_faab_left,
  }));
  const bad = seen.filter((r) => {
    const e = expect.get(`${r.season}|${r.transaction_id}|${r.espn_player_id}`);
    return e == null || Math.abs(e - r.team_faab_left) > 1e-6;
  });
  check("G1", "team_faab_left counts only spend from waiver runs STRICTLY BEFORE this one",
    bad.length === 0, `${bad.length}/${seen.length} rows disagree with the independently walked log`);
  const neg = seen.filter((r) => r.team_faab_left < 0 || r.team_faab_left > r.budget);
  check("G1b", "remaining budget stays inside [0, budget]", neg.length === 0, `${neg.length} rows outside`);
}

// ---- G2: prior_pts is week w-1, never week w ---------------------------------------------------
{
  const pts = db.prepare("SELECT season, week, player_sk, pts FROM feat_player_week_model WHERE pts IS NOT NULL").all();
  const P = new Map(pts.map((p) => [`${p.season}|${p.week}|${p.player_sk}`, p.pts]));
  const seen = rows.map((r) => ({
    ...r,
    prior_pts: inject === "prior-is-current" ? P.get(`${r.season}|${r.week}|${r.player_sk}`) ?? null : r.prior_pts,
  }));
  const scope = seen.filter((r) => r.player_sk && r.week > 1);
  const bad = scope.filter((r) => {
    const want = P.get(`${r.season}|${r.week - 1}|${r.player_sk}`) ?? null;
    return (want == null) !== (r.prior_pts == null) || (want != null && Math.abs(want - r.prior_pts) > 1e-6);
  });
  check("G2", "prior_pts is the player's week w-1 points, read from feat_player_week_model",
    bad.length === 0, `${bad.length}/${scope.length} rows disagree with the w-1 row`);
  const w1 = rows.filter((r) => r.week === 1 && r.prior_pts != null);
  check("G2b", "week 1 has no prior week, so prior_pts is NULL there", w1.length === 0, `${w1.length} week-1 rows carry a value`);
}

// ---- G3: positional need is read off the roster BEFORE the run ---------------------------------
{
  const med = (xs) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const cache = new Map();
  const needAt = (season, week, pos) => {
    const k = `${season}|${week}|${pos}`;
    if (cache.has(k)) return cache.get(k);
    const r = db.prepare("SELECT team_id, SUM(CASE WHEN pos = ? THEN 1 ELSE 0 END) n FROM fact_roster_week WHERE season=? AND week=? GROUP BY team_id")
      .all(pos, season, week);
    const m = med(r.map((x) => x.n));
    const v = { need: r.filter((x) => x.n < m).length, teams: r.length };
    cache.set(k, v); return v;
  };
  const bad = rows.filter((r) => {
    if (!r.pos) return false;
    const w = inject === "need-current-week" ? r.week : Math.max(1, r.week - 1);
    const got = inject === "need-current-week" ? needAt(r.season, w, r.pos).need : r.teams_need_pos;
    return got !== needAt(r.season, Math.max(1, r.week - 1), r.pos).need;
  });
  check("G3", "teams_need_pos is counted on the week w-1 roster, not the post-run one",
    bad.length === 0, `${bad.length}/${rows.filter((r) => r.pos).length} rows disagree with the w-1 roster`);
}

// ---- G4: pos_line_rank orders the PRESEASON line, and nothing else ------------------------------
{
  const seen = inject === "rank-from-outcome"
    ? (() => {
        const by = new Map();
        for (const r of rows) { const k = `${r.season}|${r.week}|${r.pos}`; (by.get(k) ?? by.set(k, []).get(k)).push(r); }
        const out = [];
        for (const [, g] of by) {
          const s = [...g].sort((a, b) => (b.ros_pts ?? -1) - (a.ros_pts ?? -1));
          s.forEach((r, i) => out.push({ ...r, pos_line_rank: i + 1 }));
        }
        return out;
      })()
    : rows;
  // Inside one (season, week, pos), a HIGHER preseason line must carry a LOWER rank number. Any
  // inversion means the rank was computed from something other than season_line_pg.
  const by = new Map();
  for (const r of seen) {
    if (r.pos_line_rank == null || r.season_line_pg == null) continue;
    const k = `${r.season}|${r.week}|${r.pos}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  let pairs = 0, inv = 0;
  for (const [, g] of by) for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
    if (g[a].season_line_pg === g[b].season_line_pg) continue;
    pairs++;
    const hi = g[a].season_line_pg > g[b].season_line_pg ? g[a] : g[b];
    const lo = hi === g[a] ? g[b] : g[a];
    if (hi.pos_line_rank >= lo.pos_line_rank) inv++;
  }
  check("G4", "pos_line_rank orders the preseason season line (no inversions)",
    inv === 0, `${inv}/${pairs} same-week same-position pairs inverted`);
}

// ---- G5: the model artifact must not list a target column as an input --------------------------
{
  const FORBIDDEN = new Set(["ros_pts", "ros_games", "won", "competing_bids", "status", "bid_amount"]);
  if (!existsSync(ARTIFACT)) {
    check("G5", "the fitted artifact lists no target column among its inputs", true, `${ARTIFACT} not built yet -- guard is armed, not run`);
  } else {
    const a = JSON.parse(readFileSync(ARTIFACT, "utf8"));
    const feats = [...(a.features ?? [])];
    if (inject === "leak-feature") feats.push("ros_pts");
    const hit = feats.filter((f) => FORBIDDEN.has(String(f).replace(/^(pos|is)_/, "")) || FORBIDDEN.has(String(f)));
    check("G5", "the fitted artifact lists no target column among its inputs",
      hit.length === 0, hit.length ? `inputs include ${hit.join(", ")}` : `${feats.length} inputs, none of them a target`);
  }
}

// ---- report -----------------------------------------------------------------------------------
console.log(`fact_waiver_claim leakage guard -- ${rows.length} rows${inject ? `   [INJECTED: ${inject}]` : ""}\n`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.what}\n           ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} guards pass`);
if (inject) {
  console.log(failed.length
    ? `  the injection was CAUGHT by ${failed.map((f) => f.id).join(", ")} -- the guard is connected.`
    : `  THE INJECTION WAS NOT CAUGHT. This guard cannot see the leak it exists for.`);
  process.exitCode = failed.length ? 0 : 1;
} else {
  process.exitCode = failed.length ? 1 : 0;
}
db.close();
