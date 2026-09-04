# Plan 2026-09-03: value-curve fix (weighted FLEX baselines) + pre-draft hardening round 2

**Deadline: the real draft (league 462233, seacaptaindate.com) is ~2026-09-06.** Everything in
Steps 0-8 must land before it. Step 9 items are optional / needs-human.

This plan comes out of a deep adversarial review (2026-09-03) of the draft/levers engine. The
review left NO code changes in the tree (HEAD at review time: `f138f12`); its measurements were
made with a temporary env-gated patch (Appendix A) that was applied, run, and reverted.

---

## The headline finding (why this plan exists)

`baselines()` in `src/draft/values.ts` splits the league's 32 FLEX slots evenly across RB/WR/TE
(`round(flexTotal / 3)` = 11 each). Filling those 32 slots with the best leftover players by
projected points instead gives **RB 13 / WR 19 / TE 0**. The even split therefore takes TE's
replacement baseline at TE28 (71.0 pts on the current 2026 curve) instead of TE17 (103.1 pts),
inflating every TE's VOR by that gap -- and symmetrically starving WR (real baseline WR36 @
143.5, not WR28 @ 159.8).

Consequences in the SHIPPED bid table (`player_value`, the table `auto-draft` bids from):

| | current (even split) | fair (weighted) | room's REAL 2025 spend |
|---|---|---|---|
| TE book total | **$803** | $421 | ~$206 |
| WR book total | $843 | **$1,127** | ~$1,291 |
| RB book total | $1,087 | $1,187 | ~$1,292 |
| QB book total | $704 | $707 | ~$328 (deliberate contrarian stance -- keep) |

Per player: Bowers $90 -> $72, McBride $66 -> $49, Kelce $35 -> $17, Kraft $38 -> $21; Chase
$90 -> $99, Nacua $72 -> $81, Jefferson $41 -> $50, Lamb $47 -> $56; Gibbs $107 -> $111.

**Measured impact (A/B on the repo's own championship harness, Appendix B):** fixing OUR values
while leaving the sim market on the old book moves full-system no-lookahead championships
**13.6% -> 22.2%** (playoffs 70% -> 83%), better in 8 of 9 seasons, n=400/season. That is the
same order of gain as the entire Step-5 balanced-defaults re-tune.

**Why no existing check caught it:** the sim's bot book (`trueVal` in `sim.ts`) is computed by
the SAME `baselines()` -- the whole backtest ecosystem shares the artifact, so it grades its own
homework. The unit tests use fixture tables. Live, the room prices TEs at real market, so the
artifact only bites in the real draft: the agent would systematically "win" mid-TEs at a
discount vs OUR (wrong) book, stuff both FLEX slots with them, and underbid WRs -- in a
half-PPR league.

## Secondary findings folded into this plan

- **F2 (HIGH): stale/diverging value surfaces.** `data/values.csv` (Sep 3 20:06) was built from
  an OLDER points.csv than the current one (20:59); the DB `player_value` (22:34, what
  auto-draft actually uses) differs from the CSV; `data/cheatsheet.md` is from Sep 2. The
  runbook's "add `--csv data/values.csv`" advice would override the fresh DB with the stale CSV.
- **F3 (HIGH): DST names never join live.** Table stores `"HOU D/ST"` (nameKey `hou`); ESPN's
  draft room displays `"Texans D/ST"` (nameKey `texans`). `values-check --season 2025` shows all
  16 drafted D/STs in the "absent (expected)" bucket -- the guard buries the miss. The $2 K/DST
  cap lives only in the table build, so a live DST bid falls back to ESPN's on-screen value
  UNCAPPED (strategy has no K/DST clamp of its own).
- **F4 (MEDIUM): live nomination policy is unvalidated and bad in a real room.** The backtested
  "value-greedy default" is the SIM's internal nomination (best available); the live
  `v2.nominate` is different: first player with value <= $1, else the lowest-value VISIBLE
  player. Early draft the virtualized board shows only ~18 top players -> it nominates a
  mid-tier player (possibly our own target) at $1. Late it nominates scrubs we explicitly do
  not want -- and in a real room an unwanted $1 nomination often has no other bidder, so WE win
  the player we chose for being unwanted, burning one of 4 bench slots.
- **F5 (MEDIUM): docs contradict the synced scoring.** The synced ESPN settings say HALF-PPR
  (ppr 0.5); `league-tendencies.md`, `values.md`, `value-methods.md` say No-PPR in ~5 places.
  The engine already uses the synced rules (correct). Fix the docs so a future session does not
  "correct" the config the wrong way; optionally verify whether the league CHANGED scoring for
  2026 (if so, expect the room to pay hotter for WRs than the 2023-25 recap history suggests).
- **F6 (LOW):** `validation.md` says "top 6" playoffs but the synced config is `playoffTeams: 7`
  (harness already uses 7); `test/draft-composition.test.ts` comment claims reserve 20 is "the
  live default" (it is 15); `reserveForOthers` treats K/DST as $15 starters (self-consistent
  with how the plateau was tuned -- do NOT change it now, just know the effective per-real-
  starter reserve is higher than the dial reads); a stray 2027 league row (id 211696) sits in
  the DB (inert while config.season = 2026).

## Environment snapshot the measurements depend on

The backtest is **fully deterministic per seed** (mulberry32; seed = s + 1 + yr*1000). The
numbers in this plan reproduce EXACTLY iff these inputs are unchanged:

- `data/history-points.csv` / `data/history-weekly.csv` as of Sep 3 20:21 (half-PPR rescored).
  Do NOT rebuild them; the fix does not touch scoring.
- DB config (settings key `config`): season 2026, 16 teams, $200, slots
  `QB,RB,WR,TE,FLEX,FLEX,DST,K,BE,BE,BE,BE`, scoring HALF (rec 0.5), levers { tierBreak 0.75,
  maxKDst 2, starterReserve 15, benchReserve 1, maxShare 0.35, aggr 1, premium 2,
  sleeperThreshold 5 }, playoffTeams 7, regWeeks 14.
- `data/managers.json` as of Sep 3 20:50.

If a reproduction number does not match, STOP and find which input drifted before proceeding --
do not shrug it off as noise (it cannot be noise; the harness is seeded).

---

## Steps

Work in `H:/working/ff-assistant`. One commit per step, explicit paths only, `npm test` green
before every commit. Each step names its acceptance criteria (AC) and, where a guard is added,
the fault injection (FI) that proves the guard is connected.

### Step 0 -- reproduce the baseline BEFORE changing anything

```
npm test                                                   # expect 50/50 pass
npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 400
npm run ff -- values-check --season 2025
```

AC: tests 50/50; backtest prints EXACTLY `CHAMPIONSHIPS: 13.6%` / `playoffs: 70%` with
per-season `2016:13% 2017:11% 2018:11% 2019:14% 2020:13% 2021:14% 2022:18% 2023:17% 2024:12%`;
values-check shows fuzzy-only misses = 0 (all 16 D/STs will appear under "absent" -- that is
finding F3, expected here). No commit for this step.

### Step 1 -- reproduce the review's A/B (proves the measurement chain)

Apply the env-gated patch in Appendix A verbatim (it changes OUR values only; the sim market
keeps the even-split book). Then:

```
FF_FLEX_WEIGHTED=1 npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 400
```

AC: EXACTLY `CHAMPIONSHIPS: 22.2%` / `playoffs: 83%`, per-season
`2016:13% 2017:19% 2018:19% 2019:25% 2020:22% 2021:30% 2022:29% 2023:27% 2024:18%`.
Then REVERT the patch (`git checkout -- src/draft/values.ts src/draft/backtest.ts`) -- Step 2
lands the production version instead. No commit.

### Step 2 -- land the production fix: weighted FLEX baselines by default

In `src/draft/values.ts`:
- `baselines(points, lg, flexWeighted = true)` -- add the parameter, DEFAULT TRUE. Weighted
  path: pool every FLEX_ELIGIBLE player beyond that position's dedicated starters
  (`lg.starters[pos] * lg.teams`), sort the pool by points desc, count the top
  `lg.starters.FLEX * lg.teams` by position; that count replaces the even `flexTotal/3` share.
  Keep the even-split branch reachable via `flexWeighted = false` (regression tests need it).
- `computeValues(points, lg, maxKDst, flexWeighted = true)` -- thread it through.

In `src/draft/rank.ts`: mirror the same weighted allocation in `replacementBaselines` (it is
only used by the offline `ff rank`, but leaving the old math there invites the next session to
"fix" values.ts back by analogy).

New tests (in `test/legality.test.ts` or a new `test/values.test.ts`):
1. Weighted fill: a fixture where all leftover TEs score below all leftover RB/WR ->
   TE baseline index == dedicated count (no flex share), RB+WR flex counts sum to flexTotal.
2. Regression lock: same fixture with `flexWeighted = false` reproduces the old even-split
   baseline indices (documents the old behavior instead of deleting knowledge of it).
3. FI: assert the weighted TE value of an elite TE fixture is LOWER than its even-split value;
   temporarily hardcoding `flexWeighted = false` in `baselines` must make this test fail
   (run once to see it fail, then restore).

AC: `npm test` green including the new tests; the FI was observed to fail when injected.
Commit: `values: FLEX baseline allocation is points-weighted, not an even 3-way split`.

### Step 3 -- measure the conservative frame + re-check bot calibration

Landing Step 2 flips the sim market book to weighted as well (sim.ts `trueVal` calls
`computeValues` with defaults). That is measurement M3 ("us weighted vs a market that is also
rational"), the conservative bound; M2 (22.2%) is the optimistic bound.

```
npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 400
npm run ff -- calibrate --n 300
```

Decision gate:
- If M3 championships >= 13.6% AND calibrate mean-abs-error does not materially degrade vs the
  documented fit (QB 7% / RB 8% / TE 2% / conc 8%; WR ~18% is the known soft spot; "materially"
  = any position worsening by > 5 pts) -> proceed with weighted-everywhere (one behavior).
  Expect calibration to IMPROVE on TE/WR: the room's real TE share is ~7%, and a lower-TE book
  makes bots spend less there.
- If M3 < 13.6% or calibration collapses -> STOP, record both numbers, and fall back to
  two-track: pass `flexWeighted = false` explicitly at the `trueVal` call in `sim.ts` (market
  keeps the even book; only OUR values are weighted). Then re-measure and document why.

AC: record M3 + calibration table in `docs/validation.md` (Step 8 does the prose).
Commit (docs only if no code change): fold into Step 8, or if two-track was needed:
`sim: market book stays even-split (calibration evidence)`.

### Step 4 -- re-verify the strategy defaults under the new curve

The reserve-15 / max-share-0.35 defaults were tuned under the old curve. Re-run a 3x3:

```
for reserve in 10 15 20:
  for share in 0.25 0.35 0.45:
    npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 150 \
      --starter-reserve $reserve --max-share $share
```

(9 runs, ~30-60s each.) SE at n=150 x 9 seasons is ~1.0 pt.

- If 15/0.35 is within ~2 SE of the best cell -> keep the defaults, record the table.
- If a different cell wins decisively -> update `DEFAULT_LEVERS` in `src/draft/levers.ts` AND
  **the persisted DB config** -- this is a trap: `getConfig` merges stored levers OVER code
  defaults, so changing `DEFAULT_LEVERS` alone changes NOTHING for the live agent. Update the
  stored value too (easiest: a 5-line better-sqlite3 script that reads settings key `config`,
  patches `levers`, writes it back -- write the script with the Write tool, run with
  `node <file>` from the repo root so module resolution finds better-sqlite3).

AC: table recorded; live config verified by re-reading it (`SELECT value FROM settings WHERE
key='config'`) -- do not trust the write, read it back.
Commit: `levers: re-verified (or re-tuned) reserve/max-share under the weighted curve`.

### Step 5 -- K/DST clamp inside the strategy (defense in depth for F3)

In `src/draft/strategy.ts`:
- `V2Config` gains `maxKDst?: number` (default 2).
- In `maxBid`, cap the final bid for `base === "K" || base === "DST"` at `cfg.maxKDst ?? 2`
  (after premium/inflation, alongside the shareCap min).
- Wire `maxKDst: lv.maxKDst` in `cmdAutoDraft`'s `makeV2Strategy` config (ff.ts) -- and in
  `cmdSim`/`cmdBacktest` cfg objects for consistency.

Test: DST on the block, DST starter slot open, no table entry, `espnPreDraftVal: 8` ->
`maxBid <= 2`. FI: pass `maxKDst: 99` -> maxBid rises to ~10 (proves the clamp is the thing
doing the capping, not a coincidence).

AC: test green, FI observed. Commit: `strategy: hard K/DST cap in maxBid (DST names miss the
value table live -- espn fallback was uncapped)`.

### Step 6 -- live nomination policy (F4)

Rewrite `v2.nominate` in `src/draft/strategy.ts` (the sim does NOT call it -- `draftField` has
its own nomination paths -- so this is live-only behavior; backtest numbers will not move):

```ts
nominate(state) {
  const rostered = new Set(state.myRoster.map((r) => r.name));
  const avail = state.board.filter((p) => !rostered.has(p.name));
  const byVal = avail.slice().sort((a, b) => val(b) - val(a));
  const fills = (p: PlayerRef) => (state.mySlots[p.pos] ?? 0) > 0
    || (["RB", "WR", "TE"].includes(p.pos) && (state.mySlots.FLEX ?? 0) > 0)
    || (state.mySlots.BENCH ?? 0) > 0;
  // our live targets: the top-N fillable players by OUR value (N=8, a judgment call)
  const targets = new Set(byVal.filter(fills).slice(0, 8).map((p) => p.name));
  // EARLY/MID: drain -- the most expensive visible player we are NOT targeting. No self-win
  // risk (the room bids real $ on a real player) and our targets come up later, when the
  // room is poorer.
  const drain = byVal.find((p) => !targets.has(p.name) && val(p) >= 10);
  if (drain) return { player: drain, openingBid: 1, reason: `drain non-target $${val(drain)}` };
  // LATE: everything visible is cheap -- nominate the best cheap player WE'D BE HAPPY TO OWN
  // (self-win is a feature: our best remaining sleeper fills a bench slot at $1).
  const keeper = byVal.find((p) => fills(p) && p.pos !== "K" && p.pos !== "DST")
    ?? byVal[0] ?? state.board[0];
  return { player: keeper, openingBid: 1, reason: "late: best cheap keeper" };
}
```

Rationale it replaces: the old policy (first val<=1, else lowest-visible) nominated a mid-tier
player early (the board virtualizes to ~18 rows, all valuable) and unwanted scrubs late (which
a real room hands BACK to the nominator at $1).

Tests: (a) early fixture (rich board) -> nominates an expensive non-target, never the #1 OUR
value; (b) late fixture (all <= $3) -> nominates the best fillable non-K/DST; (c) FI: shrink
`targets` to size 0 -> the #1-value player gets nominated -> assertion fails (proves target
protection is connected).

AC: tests green, FI observed. Commit: `strategy: live nomination = drain expensive non-targets,
late-keep sleepers (old policy self-won scrubs)`.

### Step 7 -- rebuild every value surface from ONE build + sanity-assert the output

```
npm run ff -- refresh          # ingest -> project (network: nflverse 6 seasons) -> assemble
npm run ff -- values           # -> data/values.csv (now weighted)
npm run ff -- cheatsheet       # -> data/cheatsheet.md (same build)
npm run ff -- values-check --season 2025
npm test                       # draft-composition reads the fresh data files
```

Sanity gates (run the SQL against `data/ff.db`, e.g. a small better-sqlite3 script):
- `points.csv` >= 450 rows (a partial nflverse fetch shrinks it silently -- check, don't trust
  the success line);
- book by position: TE total in ~$380-470, WR total >= $1,050, top TE <= ~$75 (query:
  `SELECT p.position, count(*), sum(pv.our_value) FROM player_value pv JOIN player p
  USING(player_id) GROUP BY p.position`);
- `values-check`: fuzzy-only misses = 0 (D/STs still land in "absent" -- known F3 limitation
  unless Step 9a is done);
- top-12 of `values.csv` == top-12 of `player_value` (same build, no drift).

AC: all four gates pass; tests green. Commit data files + a one-line note in the runbook:
`data: rebuild values/board/cheatsheet under the weighted curve (one build, all surfaces agree)`.

### Step 8 -- documentation truth pass

- `docs/draft-day-runbook.md`: (1) the canonical pre-draft sequence is
  `ff refresh` -> `ff values` -> `ff cheatsheet` (the Python `tools/build_projections.py` path
  is the legacy pipeline -- say so); (2) REMOVE/REWRITE the "add `--csv data/values.csv`"
  advice: auto-draft prefers the SQLite `player_value` (fresher); `--csv` OVERRIDES it and is
  only for forcing an experiment table; (3) add "check the `[auto-draft] value source:` line
  says `sqlite:player_value(...)` at startup".
- `docs/league-tendencies.md`, `docs/values.md`, `docs/value-methods.md`: every "No-PPR" ->
  the truth: the SYNCED 2026 league settings are HALF-PPR (ppr 0.5, `league.scoring_json`).
  Where a doc reasoned from No-PPR (e.g. "No-PPR RB premium"), keep the historical claim but
  mark it as the old assumption.
- `docs/validation.md` + `docs/edges.md`: add the weighted-curve finding + the M1/M2/M3 numbers
  (Appendix B format), note `playoffTeams` comes from the synced config (currently 7; the "top
  6" text was stale), and RETIRE the old 13.6%-era headline numbers the same way the 36% figures
  were retired -- state which curve a number was measured under.
- `test/draft-composition.test.ts`: fix the comment (live default is reserve 15, not 20), and
  align the pinned cfg with the post-Step-4 default.

AC: `grep -rn "No-PPR" docs/` returns only deliberately-historical mentions; runbook sequence
matches what Step 7 actually ran. Commit: `docs: half-PPR truth, one-build value surfaces,
weighted-curve validation numbers`.

### Step 9 -- optional / needs-human (do only if time remains before the draft)

- **9a DST alias join:** a 32-entry nickname<->abbr map (`texans` -> `hou`, ...) applied in the
  live value lookup when a DST misses, so DSTs resolve `src=ours` and drafted DSTs leave the
  inflation universe. Bounded value (~$1-3 per DST + ~$40 of phantom book); the Step 5 clamp
  already removes the overpay risk.
- **9b Scoring-change check:** fetch prior seasons' settings
  (`.../seasons/<yr>/segments/0/leagues/462233?view=mSettings`, credentialed via the app
  webview or bro session -- see `cmdScrapeLeague` for the fetch pattern) and diff `rec` across
  2023-2026. If the league moved 0 -> 0.5 this year, add a runbook note: expect the room to pay
  hotter for WR/pass-catchers than the recap history suggests.
- **9c Live mock smoke (NEEDS the bro espn session + a human to start it):** one practice
  auction with the new values -- watch that the agent no longer chases mid-TEs, that a DST bid
  caps at $2, and that a nomination turn picks an expensive non-target. This is the only
  end-to-end layer; the sim cannot see it.

### Step 10 -- close out

- Append a Decision Log entry to `H:/working/wiki/wiki/projects/project--ff-assistant.md`
  (date 2026-09-0X, the fix + measured numbers + what was re-tuned) and prepend a `log.md`
  entry in the wiki (`Read(wiki/log.md, limit=3)` then `Edit` on the `# Ingest Log` anchor --
  never a shell script; see the wiki CLAUDE.md warning).
- Final state: `npm test` green, backtest headline reproduced at n=400 and recorded, tree
  committed step-by-step, no stray files (`git status --short` clean).

---

## Hard rules for the implementing session

1. **Reproduce before you change** (Step 0/1). The harness is deterministic; a mismatch means
   an input drifted -- find it first.
2. **Every guard/test you add: inject its failure once and watch it fail** before trusting it
   green (the FI lines above are not optional ceremony).
3. **Content with quotes/backticks or >10 lines goes through the Write/Edit tools, never a
   shell heredoc or `python -c`/`node -e` string** (this machine's shells eat backslashes and
   execute backticks; both failure modes report success).
4. Bash-tool cwd resets between calls: every call starts `cd H:/working/ff-assistant && ...`.
5. Node scripts that import `better-sqlite3` must RUN from the repo root (module resolution);
   a script in the OS temp dir will not resolve it.
6. Stage explicit paths only; one commit per step; ASCII-only in CLI output and docs.
7. Do NOT: rebuild `history-*.csv` (scoring unchanged); enable rejected features
   (`--scarcity`, `--pos-inflation`, `--drain-nom`, `--waivers`); tune anything against
   `ff sim` (season-points proxy -- the championship backtest is the only arbiter); touch the
   `app/` UI; run `ff enter-draft` against the real league (the room is not open yet and a
   duplicate draft connection kicks the seat).
8. If a decision gate fails (Step 3), STOP and report rather than improvising past it.

---

## Appendix A -- the reproduction patch (verbatim, env-gated; revert after Step 1)

`src/draft/values.ts` -- replace `baselines` and the `computeValues` signature:

```ts
export function baselines(points: PointsRow[], lg: ValueLeague, flexWeighted = false): Record<string, number> {
  const byPos: Record<string, number[]> = {};
  for (const p of points) (byPos[p.pos] ??= []).push(p.points);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b - a);
  const flexTotal = (lg.starters.FLEX ?? 0) * lg.teams;
  let flexCount: Record<string, number> | null = null;
  if (flexWeighted) {
    const pool: { pos: string; pts: number }[] = [];
    for (const pos of FLEX_ELIGIBLE) {
      const dedicated = (lg.starters[pos] ?? 0) * lg.teams;
      const arr = byPos[pos] ?? [];
      for (let i = dedicated; i < arr.length; i++) pool.push({ pos, pts: arr[i] });
    }
    pool.sort((a, b) => b.pts - a.pts);
    flexCount = { RB: 0, WR: 0, TE: 0 };
    for (const p of pool.slice(0, flexTotal)) flexCount[p.pos]++;
  }
  const out: Record<string, number> = {};
  for (const pos of Object.keys(byPos)) {
    const dedicated = (lg.starters[pos] ?? 0) * lg.teams;
    const flexShare = FLEX_ELIGIBLE.includes(pos)
      ? (flexCount ? flexCount[pos] : Math.round(flexTotal / FLEX_ELIGIBLE.length))
      : 0;
    const startable = dedicated + flexShare;
    const arr = byPos[pos];
    out[pos] = arr[startable] ?? arr[arr.length - 1] ?? 0;
  }
  return out;
}
```

```ts
export function computeValues(points: PointsRow[], lg: ValueLeague = DEFAULT_VALUE_LEAGUE, maxKDst = 2, flexWeighted = false): ValueRow[] {
  const base = baselines(points, lg, flexWeighted);
  // ... rest unchanged
```

`src/draft/backtest.ts` -- the `useValues` line (~line 83) becomes:

```ts
const useValues = new Map(computeValues(seasonPoints.map((p) => ({ ...p, points: projUs.get(p.name) ?? 0 })), undefined, 2, process.env.FF_FLEX_WEIGHTED === "1").map((v) => {
```

This gates ONLY our values; `sim.ts` `trueVal` (the market book) stays even-split in both arms.

## Appendix B -- measured evidence (2026-09-03 review session)

Command (both arms):
`npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 400`

| arm | our book | market book | championships | playoffs | per season 2016..2024 |
|---|---|---|---|---|---|
| M1 (shipped) | even | even | **13.6%** | 70% | 13 11 11 14 13 14 18 17 12 |
| M2 (fix, env-gated) | weighted | even | **22.2%** | 83% | 13 19 19 25 22 30 29 27 18 |
| M3 (Step 3 measures) | weighted | weighted | TBD | TBD | TBD |

n = 400 x 9 scored seasons = 3,600 trials/arm; SE ~0.6 pts; random baseline 6.3%. Deterministic
per seed -- these exact numbers are the Step 0/1 acceptance criteria.

Weighted-flex evidence on the current 2026 `points.csv`: flex fill RB 13 / WR 19 / TE 0 (of
32); baselines even {QB 229.1 @17th, RB 147.7 @28th, WR 159.8 @28th, TE 71.0 @28th} ->
weighted {RB 141.1 @30th, WR 143.5 @36th, TE 103.1 @17th} (QB unchanged).

`values-check --season 2025` (current table): exact 105, nameKey 106, rescued 1
("Patrick Mahomes"), fuzzy 0, absent 86 -- including ALL 16 D/STs (recap style "Seahawks
D/ST" vs table style "SEA D/ST") = finding F3.

## Appendix C -- glossary of the moving parts

- `player_value` (SQLite): what `auto-draft` bids from (preferred source; `--csv` overrides).
- `data/values.csv`: offline mirror used by `ff cheatsheet`, `ff sim`, tests, `values-check`.
- `data/points.csv`: the projection curve output (ECR rank -> 6-season mean points, league
  scoring); input to both of the above.
- `ff refresh` = ingest (ECR/news/bio/ADP) -> project (curve) -> assemble (player_value+board).
- Backtest reads `data/history-{points,weekly}.csv` + DB config; it computes values internally
  from prior-season actuals -- it does NOT read values.csv/player_value.
