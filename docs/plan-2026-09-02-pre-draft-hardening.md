# Plan: pre-draft hardening (from the 2026-09-02 adversarial review)

Status: PLANNED. Owner: execution session. Target: land Tier 1 + Tier 2 before the real
draft (league 462233); Tier 3 after. Each step has acceptance criteria that can FAIL and
a fault-injection check; a step is not done until both have been run and the numbers are
written back into this file (the `Result:` line under each step).

## Why this plan exists (verified findings, with evidence)

The engine works and the harness is real, but the repo's own trustworthy harness contradicts
the shipped defaults, the simulator models the wrong roster shape, and several live-draft paths
are untested. Verified 2026-09-02 at HEAD `f2b280f` (`npm test` 34/34, `tsc --noEmit` clean):

1. **Bench K/DST.** `hasOpenSlotFor` (`src/draft/espnAuction.ts:124-129`) accepts any position
   while bench is open; v2 then bids `value + premium` for a bench-only K/DST
   (`src/draft/strategy.ts:159-188`). `data/values.csv` prices K/DST at $4-13 because
   `tools/build_projections.py:40-42,55-59` gives them 125-150 nominal points, and 5 kickers are
   duplicated by the hardcoded append. In the repo's own sim (`draftFieldSeats`, live default
   config, n=40) our team averaged **5.0 K/DST beyond the two starters per draft**.
   `docs/league-tendencies.md:44` says "Punt K/DST at $1. Do not let the agent bid more" and
   nothing in code enforces it.
2. **Roster shape.** The league is 16 teams x **12** slots (2025 recap: 192 picks in
   `data/recaps.json`; league-specific practice room: `ul.picklist rows=16`,
   `table.Table rows=13`, `PK n OF 192` in `docs/espn-draft-flow.md:83-86`). `SIM_LEAGUE.slots`
   has 16 slots / 7 bench (`src/draft/sim.ts:12-15`), `DEFAULT_VALUE_LEAGUE.rosterSpots = 16`
   (`src/draft/values.ts:15`), and the roadmap/MVP doc say "16-man roster". Every backtest ran on
   250-pick drafts with 7-deep benches.
3. **Default posture is the worst of three under the harness the docs call trustworthy.**
   `docs/validation.md:43` and `docs/edges.md:38-41` say aggression is ~neutral; that was the
   OLD uniform bot with lookahead, and `validation.md:31-34` asserts "directions still hold"
   without re-measuring. Re-run of `runBacktest` (2019-2024, n=360/cell, market sd 0.30):

   | mode | roster | default r5/0.6/infl | balanced r20/0.25 | stars prem30/0.85 |
   |---|---|---|---|---|
   | full-system, no-lookahead | sim 16x16 | 17.8% | 30.8% | 9.4% |
   | full-system, no-lookahead | real 16x12 | 12.8% | 21.9% | 6.1% |
   | draft-only, lookahead | sim 16x16 | 20.8% | 37.5% | -- |
   | draft-only, lookahead | real 16x12 | 12.5% | 27.5% | -- |

   Balanced beats the live default by +9..+17 championship points in every cell (SE ~2). The
   default was chosen from `ff sim` (season points), which `validation.md:166-172` itself says
   over-rewards top-heavy rosters. Sim clearing prices (#1 $135, #3 $107) also exceed the real
   room's all-time max ($106), so the bot field overpays studs MORE than the real room.
4. **Value scale + independence.** `values.csv` top: Gibbs $122, Bijan $106 vs ESPN $99/$98 and
   the room's historical top $88-106. With inflation x1.03-1.1 and premium $2, `maxShare 0.6`
   ($120) binds, so the agent is configured to be the room's top stud payer. The values' only
   "independence" is dollar SCALE (VOR spread over ONE season's actual points-by-rank curve with
   rosterSpots 16); the player opinions are FantasyPros ECR rank-mapped (`build_projections.py`).
5. **Exact-name value lookup silently falls back.** `strategy.ts:150` keys on ESPN's display
   name; `ff.ts:706` stores raw CSV names; `nkey` (`ff.ts:742`) exists but is not used for the
   lookup. Against 2025 ESPN recap names: "Patrick Mahomes II" -> "Patrick Mahomes" misses; all
   38 DST rows miss ("Broncos" vs "Broncos D/ST"). The `reason` string prints the number, not the
   source, so a miss is invisible in the bid log.
6. **Nomination seam bypassed.** `strat.nominate` is never called; `myRoster: []` always
   (`ff.ts:801`). The live anti-stall nominates the cheapest VISIBLE row of a value-sorted
   virtualized board (`ff.ts:842-852`) -- roughly the ~18th-best remaining player -- and fires a
   `nominate` click after ~5.6s of ANY idle block (other teams' turns, pre-draft countdown). The
   success path is untested (G3).
7. **Jump-bid overpays relative to the sim.** The sim clears at `min(ourMax, second+1)`
   (`sim.ts:134`); live jumps by `max($5, 34% of gap)` each time we are outbid
   (`ff.ts:817-822`), paying the first jump target above the runner-up: ~$3-8 per contested
   player, $10-25/draft -- the size of the whole "+2 pts" inflation edge. Tuned only vs ESPN bots.
8. **Copresent override is a done-bar criterion, claimed, not implemented.** No code yields to a
   human bid; if the human bids above the agent's cap and is outbid, the agent passes
   (`ff.ts:829`). `readRoster` takes the FIRST POS/BYE table (`espnAuction.ts:91-92`); if the
   human views another team's full roster the engine may print DONE and exit (`ff.ts:764-767`).
9. Smaller live risks: `secondsLeft` never read; 5-min stall guard exits on a commissioner
   pause (`ff.ts:787`); `myMax` parse failure -> `cap = 0` -> silent pass on everything
   (`ff.ts:810`); live `--scarcity` passes `teams=[ours]` so `remainingSlots` = OUR open slots
   (`ff.ts:808`, `strategy.ts:171,176`); stale "~90s" comment (`ff.ts:782`).
10. Data pipeline: `build_history.py`, `build_points.py`, `build_weekly.py`, `build_projections.py`
    do not filter to the regular season (`build_def_ratings.py` / `validate_matchup.py` do);
    `history-weekly.csv` carries 2,099 postseason player-weeks, so backtest "truth" totals include
    playoff games. The in-season "+5-7 pts" / "41% -> 69%" numbers come from noise around ACTUAL
    weekly points (`backtest.ts:77`, an oracle); the `--full` path uses season/17 with no weekly
    info (`backtest.ts:46,72`), so `projections.week()` has never been exercised end-to-end;
    `validate_matchup.py`'s 0.72 correlation is in-sample.
11. Docs/wiki drift: wiki TL;DR/Status describe an Agent-SDK + SQLite app "in design phase";
    `src/` has no LLM/SQLite/Electron; `decisions.md` D7 still says the CLI is Python; the wiki
    decision log stops at the validation-harness commit (~17 later commits unrecorded); roadmap
    Phase 2 "ACHIEVED" with done-bar #4 unmet; "16-man" everywhere; defaults quoted three ways
    (5/0.6, 8/0.5, 10/0.45); `AGENTS.md` says "docs-only, nothing to test"; cheat-sheet budget
    line is self-contradictory (`ff.ts:394`); `validation.md:120,125` still quote 36% after
    `:76` retracts it.

## Ground rules for every step

- One commit per step, explicit paths only, message `ff: <step> -- <one line>`. Never
  `git add -A`. Run `npm test` and `npm run typecheck` before each commit.
- ASCII-only in source, docs, and output.
- Every guard/test added must be shown to FAIL (inject the bad input) AND to PASS on a real
  positive case. Record both in the `Result:` line.
- Numbers quoted in docs must come from ONE invocation whose command is written next to them.
  Backtest cells need n >= 150 per season (SE ~2 pts at n=360 aggregate).
- Practice rooms only. Do NOT run `ff enter-draft` against the real league without the human
  present and explicitly saying go (it is the same single-connection room as the real draft).
- A live step needs a human-started bro session (`cd H:/working/bro && npm run -s bro -- session
  start espn`, log in). `npm run ff -- preflight` must print OK before any live step. If the
  session is not up, do the offline steps and STOP with a clear ask; do not launch a browser.

---

## Tier 1 -- offline, must land before the draft (strategy correctness)

### Step 1. Fix the roster shape everywhere the sim/values assume it
Change: `SIM_LEAGUE.slots` -> `["QB","RB","RB","WR","WR","TE","FLEX","K","DST","BE","BE","BE"]`
(`src/draft/sim.ts`); `DEFAULT_VALUE_LEAGUE.rosterSpots` -> derive from `SIM_LEAGUE.slots.length`
(or set 12 with a test that binds the two). In `cmdAutoDraft`, after the first successful
`readRoster`, log `roster slots live=<n> sim=<SIM_LEAGUE.slots.length>` and a WARN line if they
differ (do not stop; the live engine adapts). Replace "16-man" with "12-man (16 teams)" in
`docs/mvp-draft-auction.md`, `docs/draft-execution-gaps.md` (G4), `docs/validation.md`.
Acceptance: a test asserts `SIM_LEAGUE.slots.length === 12` and
`DEFAULT_VALUE_LEAGUE.rosterSpots === SIM_LEAGUE.slots.length`; `grep -rn "16-man" docs src`
returns nothing. Fault injection: temporarily set rosterSpots 16 -> the binding test fails.
Result: DONE. `SIM_LEAGUE.slots` now 12 (QB/RB/RB/WR/WR/TE/FLEX/K/DST/BE/BE/BE);
`DEFAULT_VALUE_LEAGUE.rosterSpots` 16->12 (kept a literal + bound by test to avoid a circular
import). Added binding test "ROSTER SHAPE" in test/legality.test.ts. `npm test` 35/35, `npm run
typecheck` clean. `grep -rn "16-man" docs src | grep -v plan-2026-09-02` -> NONE (validation.md
had no "16-man" occurrence; the plan file quotes the term as its problem statement and is excluded).
Fault injection: set rosterSpots=16 -> ROSTER SHAPE test FAILED (pass 34 / fail 1); restored ->
35/35. cmdAutoDraft logs `roster slots live=<n> sim=12` once + a WARN if they differ (live-only,
untestable offline; verified by code read). Docs updated: mvp-draft-auction.md (2 lines),
draft-execution-gaps.md G4.

### Step 2. Stop the agent buying bench kickers/defenses; price K/DST like the room does
Change (strategy, the live path): in `makeV2Strategy.maxBid`, if `fillingBench` and
`p.pos in {K, DST}` return `{ maxBid: 0, reason: "bench K/DST" }`. Change (values): in
`computeValues` clamp K/DST to `min(value, 2)` (option `maxKDst`, default 2, documented as the
league's observed $1-2), and in `tools/build_projections.py` dedupe by name (skip the hardcoded
K/DST append when the name already came from ECR; keep one row per name). Regenerate
`data/values.csv` and `data/values-2024.csv` (`npm run ff -- values`, and the 2024 variant).
Acceptance: (a) unit test: K slot filled + bench open + on-block K value 13 -> maxBid 0; K slot
OPEN + same player -> maxBid >= 1 (the positive case); (b) sim check: 20 seeds of
`draftFieldSeats` with the live default config -> our team has EXACTLY 2 K/DST in every seed;
(c) `data/values.csv` has no K/DST above $2 and no duplicate names
(`cut -d, -f1 data/values.csv | sort | uniq -d` is empty).
Fault injection: remove the bench guard -> (b) fails with >2 K/DST.
Result: DONE, with a plan correction. Changes: strategy.ts bench-K/DST guard (`fillingBench` &&
pos in {K,DST} -> maxBid 0, reason "bench K/DST"); values.ts `computeValues` gained `maxKDst=2`
clamp; build_projections.py dedupes the hardcoded K/DST append (skip names already from ECR).
Regenerated: `uv run --with nflreadpy --with polars tools/build_projections.py` (513 players, was
518 w/ 5 dup kickers), `npm run ff -- values` -> data/values.csv, `npm run ff -- values --points
data/points-2024.csv --out data/values-2024.csv`.
(a) PASS -- unit tests "v2 bench K/DST" (K value 13 on bench -> maxBid 0; K slot open -> >=1; DST
bench -> 0). (b) PASS -- test "SIM COMPOSITION" (`npm test`): 20 seeds of draftFieldSeats @ live
default (then-live 5/0.6, later updated to 20/0.35 in Step 5) -> exactly 2 K/DST every seed. (c) PASS --
`cut -d, -f1 data/values.csv | sort | uniq -d` empty; `awk -F, 'NR>1 && ($2=="K"||$2=="DST") &&
$3>2' data/values.csv` empty; same for data/values-2024.csv. `npm test` 38/38, typecheck clean.
FAULT INJECTION -- the plan got this partly wrong: removing the bench guard did NOT make (b) fail.
The two UNIT tests (a) correctly went red (pass 36/fail 2), but SIM COMPOSITION stayed green at
exactly 2. I then compound-injected (guard removed AND K/DST values recomputed with maxKDst=999):
still exactly 2 across 20 seeds. Reason: the sim's nomination is value-greedy and K/DST are the
lowest-value players (trueVal via computeValues, itself clamped), so they are nominated only after
every bench fills -- the sim structurally never floods us with cheap K/DST regardless of the guard.
So the UNIT tests, not (b), are the valid fault-injection lever for the guard; (b) is a real
composition regression guard but is insensitive to guard removal. The guard still matters on the
LIVE path, where a bot/human/ESPN can nominate a K/DST early with our bench open -- exactly the case
the unit tests cover.

### Step 3. Make the value lookup survive ESPN name spelling; log the value source
Change: one normalizer `nameKey(s)` in `src/draft/values.ts` (or a new `names.ts`): lowercase,
drop suffix tokens (jr|sr|ii|iii|iv|v), drop a trailing `d/st`/`dst` token, strip non-letters.
Use it for `values`, `posByName`, and `universe` in `cmdAutoDraft` (replace both `norm` and
`nkey`), and add `nameKey?: (s: string) => string` to `V2Config` (default identity) so
`makeV2Strategy` looks up `cfg.values[nameKey(p.name)]`. Extend the `reason` string with
`src=ours` / `src=espn` / `src=floor` so a fallback is visible in the bid log.
Acceptance: unit tests: values `{"Patrick Mahomes": 40}` + on-block "Patrick Mahomes II" ->
maxBid uses 40 and reason contains `src=ours`; values `{"Broncos": 2}` + on-block
"Broncos D/ST" -> 2; an absent name -> reason contains `src=espn`. Offline check: keys of
`data/values.csv` top-150 vs 2025 names in `data/recaps.json` -> 0 "fuzzy-only" misses (a small
script under `tools/` or a `ff values-check --recap data/recaps.json` command; absent rookies are
expected and listed, not counted as failures).
Fault injection: pass the identity normalizer -> the Mahomes test fails.
Result: DONE, with one data-form fix the plan implied. Added `nameKey(s)` to values.ts (lowercase;
drop jr|sr|ii|iii|iv|v; drop a d/st|dst token; strip non-letters). Added `nameKey?` to V2Config
(default identity); `makeV2Strategy` now resolves value + source via `valSrc` and looks up
`cfg.values[nameKey(name)]`; `reason` carries `src=ours|espn|floor`. cmdAutoDraft keys values,
posByName and universe by nameKey and passes nameKey to the strategy (both `norm` and `nkey`
removed). Added `ff values-check` (reuses the REAL nameKey -- no reimplementation) to join a recap
season against our top-N value keys.
(a) PASS -- unit tests: "Patrick Mahomes II" -> src=ours + value 40 drives bid; identity normalizer
FAULT -> src=espn (the load-bearing proof, kept permanent); "Broncos D/ST" -> our $2; absent ->
src=espn. `npm test` 43/43, typecheck clean.
Offline check: `npm run ff -- values-check` -> 192 drafted (2025), exact 105, nameKey 117, rescued
12 (11 D/ST + Patrick Mahomes), FUZZY-ONLY misses 0, absent 75 (rookies/outside top-150, expected).
exit 0.
PLAN CORRECTION: the plan's D/ST example ("Broncos vs Broncos D/ST") only worked for the 6 hardcoded
nicknames -- ECR stores D/ST as FULL CITY names ("Kansas City Chiefs"), which nameKey ("d/st" drop)
cannot bridge to "Chiefs D/ST". Minimal fix: build_projections.py now emits D/ST as the team
nickname (last token), so all 32 bridge. Regenerated points.csv + values.csv. This also revealed my
first values-check surname heuristic was buggy (took "Jr." as the surname), which I fixed
(strip suffix/dst before the last token) -- without it, it falsely flagged 2 absent rookies.

### Step 4. Rebuild the projection curve from several seasons, regular season only
Change (`tools/build_projections.py`): points-by-rank curve = MEAN over seasons 2019-2024 of the
rank-k regular-season points per position (uses `season_type == "REG"` or `week <= 18`), not
2024 alone; drop the hardcoded K/DST curves in favour of the same $1-2 clamp (Step 2). Apply the
regular-season filter in `build_history.py`, `build_points.py`, `build_weekly.py` too and rebuild
`data/history-*.csv`, `data/points-2024.csv`, `data/weekly.csv`. Then `npm run ff -- values` and
`npm run ff -- cheatsheet`.
Acceptance: `awk -F, 'NR>1 && $4>18' data/history-weekly.csv | wc -l` prints 0; top-3 values in
`data/values.csv` land inside the room's observed band ($80-110) -- if they do not, do NOT hand-
edit: report the top-10 with ESPN's `data/values.espn.csv` beside them and let Step 5's
`maxShare` sweep cap exposure. Record the before/after top-10 in this file.
Fault injection: none needed -- the postseason count is the guard (it was 2099 before).
Result: DONE. build_projections.py curve is now the MEAN of 2019-2024 REG points-by-rank per pos
(was 2024 only); K/DST get a small descending nominal + the Step-2 $2 clamp (elaborate curves and
the hardcoded named append dropped -- ECR gives 35 K / 32 DST full coverage). Added
`season_type=="REG"` filter to build_history.py, build_points.py, build_weekly.py (build_points.py
NOT run -- it clobbers points.csv; points.csv comes from build_projections). Rebuilt:
`tools/build_history.py 2014 2024`, `tools/build_weekly.py`, `tools/build_projections.py`, then
`npm run ff -- values`, the values-2024 variant, and `cheatsheet`.
ACCEPTANCE: `awk -F, 'NR>1 && $4>18' data/history-weekly.csv | wc -l` -> 0 (was 2099; weekly weeks
now 1-18). Top-3 values now inside the $80-110 band. dups + K/DST>2 empty; values-check 0 fuzzy.
`npm test` 43/43, typecheck clean.
BEFORE top-10 (2024-only curve): Gibbs 126, Bijan 109, McCaffrey 100, J.Allen 90, L.Jackson 78,
J.Taylor 78, Cook 75, C.Brown 74, D.Maye 68, Achane 68.
AFTER top-10 (2019-2024 REG mean): Gibbs 110, Bijan 90, J.Allen 86, McCaffrey 84, Ja'Marr Chase 74,
J.Taylor 73, L.Jackson 70, Cook 67, D.Maye 65, Puka Nacua 62. (Gibbs 126->110 and Bijan 109->90
pulled the top into band, as intended.)
NOTE: with K/DST on a low nominal, most defenses now rank outside the values-check top-150 window
(rescued fell 12->6), but all 32 DST / 35 K remain in values.csv at $2 and the LIVE lookup uses the
full map, so coverage is unaffected; only the 150-row diagnostic view shows fewer.

### Step 5. Re-choose the bidding defaults with the trustworthy harness on the real roster
Change: after Steps 1-4, sweep `starterReserve in {5,10,15,20,25}` x `maxShare in
{0.25,0.35,0.45,0.6}`, inflation ON, with
`npm run ff -- backtest --full --no-lookahead --seasons 2015-2024 --n 150 --starter-reserve R --max-share S`
(also run the top-3 candidates with `--no-inflation`, and draft-only lookahead as a cross-check).
Pick by championship %, tie-break playoff %. Set that ONE pair as the default in `cmdAutoDraft`,
in `makeV2Strategy`'s fallbacks, and in every doc that quotes defaults (`docs/draft-day-runbook.md`,
`docs/validation.md`, `docs/league-tendencies.md`, `docs/mvp-draft-auction.md`, cheat-sheet text
in `ff.ts`). Replace the "aggression is neutral" paragraphs in `docs/validation.md` and
`docs/edges.md` with the new table and the sentence: measured against the realistic
per-manager field on the 12-slot roster; the earlier neutrality was the uniform bot.
Acceptance: the chosen default beats the previous default (5/0.6) by more than 2 SE in the
full-system no-lookahead cell; all doc mentions of defaults agree (`grep -rn "starter-reserve\|starterReserve\|max-share\|maxShare" docs src | grep -i default`).
Fault injection: none -- but the sweep table must be pasted here with the exact command.
Result: DONE. Command per cell:
`npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n 150 --starter-reserve R --max-share S`
(no-lookahead drops the first year, so 2016-2024 = 9 seasons evaluated). Championship %:

| reserve \ max-share | 0.25 | 0.35 | 0.45 | 0.60 |
|---|---|---|---|---|
| 5  (old default) | 20.1 | 17.6 | 16.6 | 15.7 |
| 10 | 22.2 | 22.6 | 20.7 | 19.2 |
| 15 | 23.3 | 24.5 | 23.9 | 23.9 |
| 20 (new default) | 24.1 | 24.1 | 24.1 | 24.1 |
| 25 | 2.8 | 2.8 | 2.8 | 2.8 |

Championship rises with per-starter reserve to a plateau at reserve 15-20 (~24%), then collapses at
25 (8 starters x $25 = whole $200 -> $1 scraps). At reserve 20, max-share is non-binding (all equal).
Disambiguated the top cells at n=400: R15/0.35=24.2%/81, R20/0.25=24.2%/82, R20/0.35=24.2%/82 (tie
on championship; R20 wins the playoff tie-break). CHOSEN: **reserve 20 / max-share 0.35 / premium 2**.
CROSS-CHECKS (n=400): without inflation the top cells fall to 20.3% (inflation stays ON, +~4 pts);
draft-only lookahead `backtest --inflation --seasons 2015-2024 --n 400`: R20/0.35 = 25.4%/84 vs old
5/0.6 = 19.7%/77.
ACCEPTANCE: chosen (24.2%) beats old default 5/0.6 (15.7%, re-measured now) by +8.5 pts >> 2 SE
(SE ~0.6 pts at n=400 aggregate ~3600 sims). Defaults set to 20/0.35 in cmdAutoDraft, cmdSim,
cmdBacktest, and makeV2Strategy fallbacks; every doc default mention updated (runbook, validation.md,
edges.md, league-tendencies.md, values.md, mvp-draft-auction.md, cheat-sheet text in ff.ts). The
"aggression is neutral" paragraphs in validation.md + edges.md replaced with the table + the sentence
"measured against the realistic per-manager field on the 12-slot roster; the earlier neutrality was
the uniform bot." `grep -rn ... | grep -i default` all agree. `npm test` 43/43, typecheck clean.
NOTE: numbers shifted up vs the plan's finding-table baseline (old default 12.8% -> 15.7%) because
Steps 1-4 (12-slot roster, K/DST clamp, multi-season REG curve) changed the harness; the DIRECTION
(balanced >> aggressive) is unchanged and stronger.

### Step 6. Small live guards (offline-testable)
- `myMax` unreadable -> log `WARN myMax unreadable`, fall back to `affordableMax(state)` (unit-
  verified to equal ESPN's reserve) instead of `cap = 0`.
- Stall guard: `--stall-min N` (default 10), log a WARN at 3 min quiet.
- Remove `--scarcity` from `auto-draft` (rejected feature; live wiring is wrong) and from the
  runbook toggles; keep it in `backtest`.
- Premium: apply `premium` only when `liveVal >= 5` (no $2 overpay on the $1 tail).
- Fix the stale "~90s" comment at `ff.ts:782`.
Acceptance: unit test for the myMax fallback (null myMax -> cap = affordableMax, not 0); premium
test ($1 value -> maxBid 1; $30 value -> 30 + premium).
Result: DONE. (1) myMax: added pure `legalCap(maxBid, myMax, state)` = min(maxBid, myMax ??
affordableMax(state)); cmdAutoDraft uses it + logs `WARN myMax unreadable` when null (was cap=0).
(2) Stall guard: `--stall-min N` (default 10), WARN once at ~3 min quiet; refresh cadence ~5.6s so
stop at ~N*10.7 refreshes. (3) Removed `--scarcity` from auto-draft (still in backtest); dropped it
from the runbook toggles. (4) Premium only when `liveVal >= 5` (no $2 overpay on the $1 tail).
(5) Fixed the stale "~90s"/"~5 min" comment.
Unit tests (test/legality.test.ts): "legalCap" (null/undefined myMax -> affordableMax 60, readable
myMax 45 binds, own bid 30 binds); "v2 premium" ($1 value -> maxBid 1; $30 value -> 32 = 30 +
premium 2). `npm test` 45/45, typecheck clean.
FAULT INJECTION: reverted legalCap to `?? 0` and premium to always-add -> both tests went red
(pass 43 / fail 2); restored -> 45/45.

## Tier 2 -- needs a live practice room (bro session up), must land before the draft

### Step 7. Nominate only on our turn, through the Strategy seam
Change: (a) capture the DOM signal for "our nomination turn" (the `ul.picklist` highlighted
entry / any "your turn" indicator) with `ff inspect-draft` during a practice room; add
`readTurn(page): { ourNomination: boolean, nominatingTeam: string|null }` to `espnAuction.ts`;
(b) gate `nominate` on `readTurn().ourNomination` (fallback ONLY if no signal exists: idle >= 20s
AND picks.length > 0, i.e. never during the countdown); (c) build the choice via
`strat.nominate(state)` with `state.board = readBoard()` and `state.myRoster` from `readRoster`
names; the drain policy nominates a top-value player we do not need, which is visible on the
value-sorted board, so `nominate(page, name)` can click it.
Acceptance: one practice auction where the log shows `NOMINATE` fired ONLY on our turns (count
~= our nomination turns, ~12 on a 12-slot roster), zero `(failed -- maybe not our turn)` lines,
and no NOMINATE line before the first pick. Fault injection: force `ourNomination=true` on a
foreign turn -> `nominate` returns false (Select disabled) and the log says so.
Result: CODE DONE, live-verified partially. Added `readTurn(page)` to espnAuction.ts: `ourNomination
= (no player on block) AND (>=1 ENABLED board "Select" button)` -- ESPN enables Select only on your
nomination turn (captured via `ff inspect-draft` on a live mock: picklist rows carry no per-row
turn marker, so the enabled-Select signal is the robust one; nominatingTeam is best-effort/null).
cmdAutoDraft now gates nomination on `readTurn().ourNomination` (fallback: idle>=20s AND
picks.length>0, never during countdown) and builds the pick through `strat.nominate(state)`.
The OLD code's failure mode was reproduced live in this run (`NOMINATE DeVonta Smith (failed --
maybe not our turn)` at r401, then success at r421) -- exactly what the gate removes. Full live
verification of the clean-count acceptance is blocked: the ESPN mock auto-nominates for most seats,
so our manual nomination turns are rare there; the count/0-failures check wants the real draft (our
seat, auto off). typecheck clean.

### Step 8. Bid pacing: fixed jump + tick flag; read the league's bid timer
Change: extract `jumpTarget(offer, cap, jump)` (pure) = `min(cap, offer + jump)`; default
`--jump 5` (drop the 34%-of-gap term); add `--tick ms` (default 1400). `ff preflight` prints the
league's auction bid/nomination timer from the ESPN league-settings page (selector to pin live)
and the runbook says: timer <= 6s -> run `--tick 700 --jump 8`.
Acceptance: unit test for `jumpTarget`; a practice auction still wins >= 2 players over $40 and
the draft log shows our winning prices within $jump of the runner-up where the bid history is
readable (`ul.bid-history__list`). Fault injection: `--jump 0` -> engine falls back to +1 quick
bids only (log shows no jump lines).
Result: CODE DONE. Extracted pure `jumpTarget(offer, cap, jump) = min(cap, offer + jump)` (dropped
the 34%-of-gap term); cmdAutoDraft uses it with `--jump` (default 5) and `--tick` (default 1400ms).
`--jump 0` short-circuits the jump path (`jump > 0 && ...`) -> +1 quick bids only. Unit test
"jumpTarget" (15/50-clamp/at-cap/8) green. The ">= 2 players over $40" live acceptance was NOT met
in the mock -- see Step 10; the balanced default + deflating live inflation kept our caps ~$13-20
against ESPN mock bots that pay more, so we win at value but rarely over $40 there. `ff preflight`
timer-print not yet added (needs the league-settings selector; deferred with Step 9's live items).

### Step 9. Copresent override that actually exists
Change: (a) PAUSE: if `data/PAUSE` exists the engine reads but never bids/nominates and logs
`PAUSED` once per state change; delete the file to resume. (b) Human-bid respect: read
`ul.bid-history__list` each tick; if OUR team placed a bid above the agent's cap for the on-block
player, mark that player human-owned and stay out for the rest of that auction (log
`HUMAN driving <player>`). (c) Roster read anchoring: in a practice room click another team's
roster and run `ff roster`; if the output changes, anchor `readRoster` on our team's panel
(team name / data-testid), not "first POS/BYE table". Fix `docs/draft-day-runbook.md:61` (the
yield description is backwards) and G11 in `docs/draft-execution-gaps.md`.
Acceptance: practice auction: create `data/PAUSE` mid-draft -> no bids for >= 3 nominations,
remove -> bidding resumes (both visible in the log); human places one bid above cap -> the agent
does not re-bid that player; `ff roster` returns OUR roster while another team's panel is open.
Result: PARTIAL. (a) PAUSE: implemented -- `data/PAUSE` present -> engine reads but does not bid or
nominate, logs `PAUSED`/`RESUMED` once per transition. Code + gating in cmdAutoDraft; live-verify on
a fresh mock pending (blocked by the running mock -- one draft connection). PAUSE later VERIFIED
LIVE (see the Step 10 addendum): `PAUSED` then `RESUMED` with no bids between.
(c) roster anchoring: DONE defensively -- readRoster now anchors on OUR persistent roster panel,
`rosters.find(t => t.closest('.players-table')) || rosters[0]`, instead of blindly taking the first
POS/BYE table (evidence: `ff inspect-draft` showed our roster table wrapped in
`.ResponsiveTable.players-table`). One-table case is unchanged (verified live: reads our full 12/12
roster). The two-table case (a human opens another team's panel) still needs a human-present check.
Runbook "Watch + override" rewritten -- the old "yields when not the high bidder" was BACKWARDS: the
agent simply never overpays OUR value, so you take a player by bidding above its cap; PAUSE + the
ESPN-auto interaction documented. G11 -> [PARTIAL].
(b) Human-bid respect (stay out of a player the human is driving even BELOW cap): still not
implemented -- needs a human to place the bid to build + verify against. `npm test` 46/46.

### Step 10. Three consecutive practice auctions to the NEW done-bar
Done-bar (replaces the MVP one): 12/12 legal, spent <= $200, exactly 2 K/DST, >= 2 players over
$40, NOMINATE only on our turns with 0 failures, PAUSE test passed once, `WARN` lines = 0, and
the per-draft log in `data/draft-log-*.json` reviewed. Then update the runbook and this file.
Result: NOT MET in the mock, by design mismatch (surfaced to the user). One live mock auction (leagueId
250551923, our seat "Bronchos", 12 slots -- a DIFFERENT shape than the real 2RB/2WR/1FLEX league, so
the engine adapted and logged `roster slots live=12 sim=12`). Tier 1 mechanics VALIDATED LIVE: value
lookup resolves (`src=ours` on every bid), live inflation drifts (0.97 -> 0.70), `myMax` read, won
QB Josh Allen at our exact cap $56. BUT the balanced default is calibrated to the SIM's real-league
bot field (61% of picks $1-5, value left late); ESPN's generic mock bots pay near-full value on
everything, so after Allen our per-starter reserve capped bids at ~$20 and deflating inflation
(0.70, UNBOUNDED on the live path -- the docs' [0.8,1.4] bound is not applied here) pushed effective
caps to $13-20 while RBs we value $36-47 cleared at $25-40 -> we won almost nothing else. So ">= 2
over $40" cannot be met in the mock. The mock tests ENGINE MECHANICS (which pass), not the strategy's
win rate (only the calibrated field / real league can). Open items needing the user present: the
strategy's live aggression decision, the human-bid-respect + roster-anchor code, and the clean
NOMINATE-count verification.

TIER 2 DIAGNOSIS + FIXES (user approved "diagnose & fix both", 2026-09-02):
- BUG: `computeInflation` clamped to [0.7, 2.0], NOT the documented [0.8, 1.4] -> live inflation hit
  0.70 and crushed our caps to $13-20. FIXED to [0.8, 1.4] (inflation.ts). Verified live on a fresh
  mock: caps rose from $13-20 to $31-70 (max-share governed). Backtest re-run confirms the default
  cell barely moved (reserve 20/0.35: 24.2 -> 24.0%). Test "FAULT: short board pads..." updated
  (both sides were clamping at the new 1.4 ceiling).
- RESERVE: reserve 20 STRANDS budget live -- after one buy the reserve binds and the soft cap
  collapses to ~$20, so we win 1 player + $1 scraps. Changed default 20 -> **15** (cmdAutoDraft,
  cmdSim, cmdBacktest, makeV2Strategy, all docs): sim-tied (23.7 vs 24.0, plateau 12-20 within SE)
  but at 15 the max-share cap governs ($70) and the soft cap stays ~$58 after a buy, so we keep
  competing. Verified live: at reserve 15 caps stayed healthy.
- Live-verified this session: readTurn-gated NOMINATE fired "(our turn)" with 0 "(failed)" lines;
  PAUSE file -> `PAUSED` then `RESUMED` with no bids between (Step 9a).
- REMAINING CAVEAT: even fixed, we win few players in the ESPN mock because its generic bots overpay
  UNIFORMLY vs our (real-league-calibrated) VOR values (e.g. a $22 WR cleared at $24 > our cap). The
  mock validates ENGINE MECHANICS + guards (all pass); it is NOT a valid test of the strategy's win
  rate -- only the real seacaptaindate.com field is. Do NOT over-tune to the mock. `npm test` 46/46.

## Tier 3 -- after the draft (honesty of the in-season claims + docs)

### Step 11. In-season numbers: measure the projection layer, not an oracle
- `validate_matchup.py`: make it out-of-sample (talent = mean of PRIOR weeks only, min 4 games).
- Add a backtest mode where OUR weekly selection uses `projections.week()` with `def-ratings`
  built from the PRIOR season, and report it beside the naive and oracle rows.
- Rewrite `docs/edges.md` #4 and `docs/in-season-design.md`: the 41%/69%/+5-7 rows are an
  oracle upper bound; put the measured number next to them.

### Step 12. Docs + wiki reconciliation
Repo: `docs/decisions.md` add **D10** (engine is TypeScript + deterministic; no LLM in the bid
loop; Agent SDK/Electron/SQLite deferred to the packaged-app phase) instead of leaving D7 reversed;
`AGENTS.md` (tests exist; D0-D9; the D3 action-log rule applies to the packaged app, the engine
writes `data/draft-log-*.json`); `README.md` D-range; `docs/validation.md` remove the retracted
36% quotes; cheat-sheet budget sentence; one defaults table.
Wiki (`H:/working/wiki/wiki/projects/project--ff-assistant.md` + `roadmap--ff-assistant.md`):
rewrite the TL;DR and Status (what exists: a TS CLI engine + harness; the packaged app is a later
phase); add decision-log entries for the unrecorded commits (per-manager bot field, inflation ON,
per-position inflation REJECTED, waivers REJECTED, cheat sheet + runbook, enter-draft/preflight,
stall guard) and for this review + the Step 5 outcome (aggression NOT neutral vs the realistic
field; new defaults; roster is 12-man); roadmap: "12-man (16 teams)", drop "Python ff CLI", mark
done-bar #4 honestly (implemented in Step 9 or still open), fix "Decisions Needed"; log entry in
`wiki/log.md` (`Read(limit=3)` then `Edit` on the header anchor). Register nothing new in indexes
unless a page is created.
Result (REPO HALF DONE 2026-09-02): Added **D10** to decisions.md (engine is TypeScript +
deterministic, no LLM in the bid loop, Agent SDK/Electron/SQLite = unbuilt packaged-app phase;
corrects D7's "Python CLI" framing). AGENTS.md fixed: D-range D0-D10, the "docs-only, nothing to
test" line replaced with the real Build/Test/Run (npm test/typecheck/ff, uv data rebuild), and the
D3 action-log rule scoped to the packaged app (engine writes `data/draft-log-*.json`). README D-range
-> D0-D10 + D10 note. Retracted 36% figures reconciled to "direction only, old uniform-bot baseline"
in validation.md + edges.md (league-managers.md:63 kept as retraction CONTEXT). Stale headline
champ-rates (~18%/~13%) updated to the balanced default's ~25%/~24% in README, runbook,
league-managers.md. Defaults table already single-sourced (Step 5 grep agrees). WIKI HALF was done
earlier (project + roadmap + log). REMAINING: Step 11 (in-season out-of-sample validate_matchup +
projection-layer backtest mode) -- deferred to post-draft per the plan.

## Verification commands (copy/paste)

```
cd H:/working/ff-assistant
npm test && npm run typecheck
npm run ff -- values && npm run ff -- cheatsheet
npm run ff -- backtest --full --no-lookahead --seasons 2015-2024 --n 150            # default
npm run ff -- backtest --full --no-lookahead --seasons 2015-2024 --n 150 --starter-reserve 20 --max-share 0.25
npm run ff -- calibrate --n 300
awk -F, 'NR>1 && $4>18' data/history-weekly.csv | wc -l                              # must be 0 after Step 4
cut -d, -f1 data/values.csv | sort | uniq -d                                         # must be empty after Step 2
# live (bro session up):
npm run ff -- preflight && npm run ff -- launch-practice && npm run ff -- auto-draft
```

## Out of scope for this plan
Electron/Agent SDK packaging; Yahoo; trades; a real multi-source projection model (the curve
fix in Step 4 is the cheap version). Do not "tidy" the value formula beyond what Step 2/4 say.
