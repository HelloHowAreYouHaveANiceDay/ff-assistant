# Architecture review -- multi-league / multi-format state of the repo (2026-09-16)

Read-only review of `main` @ 0835e7a by five parallel reviewers (storage seam, format/model layer,
platform layer + app, in-season copilot, docs/hygiene), cross-checked against the live store and the
running app. This file is the consolidated finding list, the target architecture, and the work plan
the fix session executes against. Line numbers are as of 0835e7a.

**Pre-change baseline (the incumbent's byte-identity gate):** `backtest --full --no-lookahead
--inflation --seasons 1999-2024 --n 150` at 0835e7a = **39.5% championships / 96% playoffs**, per-season
line `2000:28 2001:31 2002:44 2003:47 2004:32 2005:29 2006:49 2007:19 2008:47 2009:55 2010:44 2011:62
2012:47 2013:41 2014:29 2015:38 2016:29 2017:33 2018:41 2019:36 2020:43 2021:35 2022:54 2023:33 2024:40`.
Every wave below must reproduce this line exactly (CRN seeds make the trials a matched pair; a
different season number means an input drifted). Store backup taken before any migration:
`data/ff.db.bak-prearchfix-2026-09-16` (integrity ok, 3 league rows, 24,367 fact_roster_week rows).

Tooling state at 0835e7a: `tsc` clean; `eslint` 0 errors / 49 warnings (`no-useless-assignment`);
`npm test` 508 pass, 1 FAIL -- `test/roster-completeness.test.ts` HANGS for 9 minutes whenever the app
is running (see I-8 below), then is reported failed by the runner.

## 1. What is actually true today (live store, 2026-09-16)

- `league` rows: **462233** espn (team 8, scoring_json present, synced 09-13); **129048** yahoo
  (`team_id NULL`, `scoring_json NULL`, synced 09-16 -- the NEWEST); **211696** espn 2027 stub (name
  NULL, no config; a `discover_leagues` artifact of a link scrape).
- `settings.active_league = 462233`. So `activeLeagueId()` says ESPN while every
  `ORDER BY last_synced_at DESC LIMIT 1` resolver says Yahoo. Both are live in the same process.
- `config:129048` is a byte-copy of the ESPN config with `teams`, `slots` and `scoring:"STD"` edited.
  It still carries ESPN's `format` block verbatim (13 reg weeks, 7-team playoff wk14-16, four ESPN
  divisions with ESPN team ids, `source:"espn"`), ESPN's half-PPR `scoring_rules` (`rec 0.5`), ESPN's
  `kicker`/`defense`/`posMax`/`rosterSettings` ("League Name: seacaptaindate.com", "Draft Type: Salary
  Cap"), `budget 200`, `flex_ok [RB,WR,TE]` beside a `SUPERFLEX` slot, and no `platform`. Root cause:
  `getConfig(db, id)` falls back to the legacy `config` MIRROR (another league's config) when
  `config:<id>` is absent, and `setConfig` merges on top of that (db.ts:329, :341).
- The ground-truthed Yahoo scoring exists only as the constant `YAHOO_129048_SCORING`
  (scoring.ts:68); nothing in `src/` reads it, and `scoringKey(config:129048.scoring_rules)` =
  `sc-f6143a8dfb13` = the ESPN key, not the Yahoo dir `sc-a845f67652fb`.
- `data/formats/sc-a845f67652fb/` holds history CSVs, `features.db`, a trained projection artifact and
  a hand-built `fa-pool.json`. Nothing under `src/` reads `data/formats/` at all; the Yahoo model is
  reachable only from five `scripts/yahoo-*.mjs` / `value-format-compare.mjs` that hardcode the key
  and the league id. `feat_player_week_model` inside the format DB is a row-for-row half-PPR copy
  (measured), so any weekly serve off it would be half-PPR.
- `.gitignore:9` carried a trailing `# comment` on the `data/formats/` pattern line; git does not
  support inline comments, so the ~1GB format dir was NOT ignored (`git add --dry-run` staged it).
  Fixed in this session.
- The app: one Electron instance (pid 39000, CDP 9223), two guests -- `espnview` at
  fantasy.espn.com/football/ (home page) and `yahooview` at the Yahoo fantasy home.
  `mcp read_league` returns "could not read league (auth?)".

## 2. Findings, by seam (BLOCKER = wrong numbers / data loss / wrong-league action, silently)

### S. Storage + LeagueContext seam

- **S-1 BLOCKER. Four disagreeing "which league" resolvers.** `activeLeagueId` (db.ts:303) honours
  `settings.active_league`; `currentLeagueId` (leagueHistory.ts:37) and `activeLeague`
  (agent.ts:690) use last-synced only; `simContext.ts:96` and `proposeTrade.ts:41` do
  `WHERE season=? AND team_id IS NOT NULL` with `.get()` (arbitrary row). ~16 more inline
  last-synced queries: espn.ts:85, ff.ts:427/464/748/1646/1711/2118/4041, backtest/faab.ts:104,
  copilotStore.ts:198. `REAL_LEAGUE="462233"` hardcoded at ff.ts:725.
- **S-2 BLOCKER. Writers stamp `league_id` from the wrong resolver.** leagueRosters.ts:314,
  leagueTransactions.ts:200/230, rosterState.ts:324, leagueHistory.ts:164 use `currentLeagueId`
  -> today they would fetch ESPN 462233 data and write it under `league_id='129048'`.
- **S-3 BLOCKER. `league_sync` reads league A and writes league B.** agent.ts:388 picks by
  last-synced (Yahoo), :391 fetches ESPN `leagues/129048`, :412 UPDATEs the Yahoo row with ESPN
  scoring, :449 `setConfig(db, ...)` with no id -> lands on the ACTIVE league (ESPN). The
  degenerate-read guard (:445) checks emptiness, not identity.
- **S-4 BLOCKER. `fact_team_season` / `fact_matchup` wiped for ALL leagues** on rebuild
  (picks.ts:303-304, `DELETE` with no WHERE) -- the `DELETE FROM team_odds` lesson recorded in
  docs/multi-league-refactor.md:130-133, still present.
- **S-5 BLOCKER. `fact_draft_pick`, `fact_team_season`, `fact_matchup` have `league_id` as a
  column but NOT in the PK** (live PKs `[season,team_name,pick_order]`, `[season,team_id]`,
  `[season,week,home_id]`); upserts at picks.ts:101/287/299 collide across leagues. The refactor
  doc's "already keyed (18)" list is wrong for these three.
- **S-6 BLOCKER. The feeds of those tables are unfiltered** (picks.ts:58/85/89/250/255/263 read
  `raw_league_*` by season only; `shape.get(yr)` returns whichever league loaded last).
- **S-7 BLOCKER. New-league config is seeded from the active league** (db.ts:329/341) -- the
  root cause of section 1's fabricated Yahoo config. `validateFormat` (league/index.ts:100) checks
  shape only, so a copied block passes.
- **S-8 BLOCKER. Switching the active league does not rebuild or invalidate `board` /
  `player_value` / `player_value_position`.** `setActiveLeagueId` (db.ts:314) writes two settings
  and stops; the "rebuilt on switch" claim in multi-league-refactor.md:134-136 describes code that
  does not exist. 529 ESPN half-PPR auction rows would be served as Yahoo values by appdata.ts:10/50,
  copilotStore.ts:97/133, simContext.ts:107, ff.ts:384/1097/3143, agent.ts:33.
- **S-9 BLOCKER. 21 unfiltered readers of the Phase-2b league-keyed tables** (`fact_roster_week`,
  `fact_lineup_week`, `fact_fa_pool_week`, `fact_waiver_claim`): inseason/faab.ts:104/192/292-311,
  backtest/{faab,waiver,lineup,winprobLineup,harness,streaming}.ts, population.ts:150/177,
  streamingEvaluate.ts:316, proposeTrade.ts:34/52, scorecard.ts:412, ff.ts:2084/2688, plus
  `raw_league_transaction` readers (faab.ts:129, backtest/waiver.ts:84/109, inseason/faab.ts:257).
  Team ids collide numerically across platforms (ESPN 1-18, Yahoo 1-12).
- **S-10 SHOULD-FIX. `resolveLeagueContext` has zero production callers and ignores its own
  argument** (leagueContext.ts:30-34: `id` from one resolver, `getConfig(db)` from another). Phase 1
  "swap the call sites" was never done.
- **S-11 SHOULD-FIX. 12 direct `settings WHERE key='config'` readers** bypass `getConfig`
  (league/index.ts:125/134/203, espn.ts:88, copilotStore.ts:34, simContext.ts:95, stgPlayer.ts:190,
  ff.ts:374/1028/1033) plus scripts (`read-config`, `set-lever` WRITES it, `lever-connected`,
  `value-gates`, `waiver-sweep`, `sim-convergence`, `validate-scoring`, `audit-selfref`,
  `lib/deps.mjs`). `setConfig`'s `!id` branch (db.ts:344) can write the mirror with no league.
- **S-12 SHOULD-FIX. `openLeague` dispatches on `cfg.platform`, a field `AppConfig` does not have**
  (league/index.ts:205-218) -- the loud "no adaptor" refusal is unreachable; the Yahoo league gets an
  ESPN adaptor holding id 129048. `AppConfig` also has no `draftType`.
- **S-13 SHOULD-FIX. `draft`/`draft_state`/`draft_pick`/`my_roster` share one `'local'` session
  across leagues; `action_log` has no `league_id`; `decision_snapshot`'s own CREATE (decisionSnapshot.ts:19)
  lacks the `league_id` its INSERT (:46) uses; `migrateLeagueIdPk` drops indexes it cannot restore
  (db.ts:115 runs after schema.sql, not before); `scheduler`/`season`/`last_ingest` settings and
  `data/live-state.json` are single-slot.**
- **S-14 NIT.** Junk league row 211696; `discover_leagues` writes `name NULL` and any leagueId in any
  href (agent.ts:373); four copies of the ESPN slot/pos id maps (agent.ts:16, ff.ts:1720,
  leagueRosters.ts:51, espnSlots.ts).

### F. Format / model layer

- **F-1 BLOCKER.** `scoringKey(config:129048)` = the ESPN key (section 1). Any naive resolver routes
  Yahoo to the ESPN model.
- **F-2 BLOCKER. Nothing in `src/` computes a format key or reads `data/formats/`**; `valueKey` and
  `formatKey` do not exist as functions (formatKey.ts exports `canonicalJson` + `scoringKey` only;
  D24's text claims all three). No `config -> format -> artifact paths` resolver exists.
- **F-3 BLOCKER. The ESPN incumbent has no format dir and no alias rule.** `scoringKey(DEFAULT_SCORING)`
  = `sc-f6143a8dfb13`; every ESPN artifact is read from the `data/` root via `dataPath()`. A resolver
  that silently falls back to `data/` for a missing key would serve every unbuilt format the ESPN
  numbers -- the exact blocker shape.
- **F-4 BLOCKER. The weekly track has no format axis.** `loadWeeklyBaseArtifact` defaults to the
  ESPN projection artifact (weekly/features.ts:585); `WEEKLY_SERVE` files resolve through `dataPath`
  (streamingServe.ts:102-109, :206); scorecard.ts:510/529 the same; the format DB's
  `feat_player_week_model` is a stale half-PPR copy (build-format-features.mjs never rebuilds it).
- **F-5 SHOULD-FIX.** Format dir carries no `scoring.json`/`features.json`/`golden.json` preimage
  (design doc:102-110 specifies them); the key is unverifiable against anything but the constant.
- **F-6 SHOULD-FIX.** All five format scripts hardcode `"sc-a845f67652fb"` and `"129048"`; the two
  builders hardcode the constant (`SCORINGS = { yahoo: YAHOO_129048_SCORING }`).
- **F-7 SHOULD-FIX.** Per-scoring artifacts read from the ESPN root regardless of league:
  `points.csv`, `values.csv`, `current-actuals.csv` (one file, active league's scoring,
  history.ts:179-196), `variance-model.json`, `rank-outcomes.json`, `correlation-model.json` (all three
  feed the D18 seeded simulator), `def-ratings.csv`, `fold-artifacts-d16`, `managers.json` (ESPN
  owners), `faab-model.json`. Correctly shared: injury-duration, opponent-correlation, age-curve,
  opportunity-model, nflverse cache, identity, `raw_pbp_player_week`, `ros-blend.json` (K, asserted
  NFL-level).
- **F-8 SHOULD-FIX.** The format target CSVs include the LIVE season (2026) while the ESPN target
  stops at 2025 (history.ts:166-177 says history-*.csv are frozen backtest inputs); 421 of 590 2026
  rows carry a partial-season `pts`.
- **F-9 SHOULD-FIX.** No `--league`/`--format` axis on `cmdBacktest` (ff.ts:2179-2188) or
  `cpcv.mjs`; the golden (`GOLDEN=96.0`) and the ledger are not keyed by format.
- **F-10 NIT.** `scripts/read-config.mjs:11` prints `scoring rec: undefined` (reads `cfg.scoring`, a
  string, not `cfg.scoring_rules`) -- the repo's "trust this" reader shows nothing about scoring.
  `AppConfig.format` (playoff calendar) vs "format" (ruleset identity) is an overloaded word.

### P. Platform layer + app

- **P-1 BLOCKER. No platform dispatch on discover/sync.** `discover_leagues` hardcodes `'espn'`
  (agent.ts:373); `league_sync`, `read_league`, `sync-rosters` (ff.ts:1711-1766, DELETE + reinsert
  under the last-synced id), `ingestAll`'s league sources (ingest.ts:227/447/461) all build ESPN
  URLs for whatever league id they resolve.
- **P-2 BLOCKER (latent). `propose_trade` picks its league with an unordered `.get()`**
  (proposeTrade.ts:41) and POSTs to ESPN (:90) -- the system's only outward write; excluded from the
  Yahoo row only because its `team_id` is NULL today.
- **P-3 SHOULD-FIX. The app bridge's host filter falls back to ANY guest** (app/main.js:458
  `onHost.length ? onHost : guests`): with no guest on espn.com, `/read-frame` and `/click` act on
  the Yahoo webview silently. `/fetch` hardcodes `espnview` (:680) with an espn.com-only allowlist;
  `bridgeFetch`/`bridgeReadFrame`/`bridgeClick` (appBridge.ts:44/114/146) take no host/platform.
- **P-4 SHOULD-FIX. Renderer page tabs build ESPN URLs for every league** (app.js:48-58, `espnGo`
  :60 always targets `#espnview`); `switchLeague` (:98-104) calls `setView("live")` BEFORE
  `setBrowserPlatform`, so every switch first navigates the hidden ESPN webview to
  `fantasy.espn.com/football/draft?leagueId=129048` -- a different, real ESPN league -- and that URL
  becomes the longest espn.com url the bridge prefers.
- **P-5 SHOULD-FIX. No Yahoo adaptor exists** (`src/league/` has espn only); the Yahoo roster is a
  hardcoded 18-name array in `scripts/yahoo-waiver-trade.mjs:15`; the Yahoo `league` row and
  `config:129048` were created by hand (no verb writes `platform='yahoo'`).
- **P-6. MCP: 0 of 39 tools take a league argument; 14 are ESPN-hardcoded with no platform check;
  3 (`league_sync`, `read_league`, `refresh`) resolve by a rule the app's tabs do not use.**
- **P-7 NIT.** `attachWebview`/`rendererPage` hardcode CDP port 9223 while the bridge file names the
  newest instance -- with two platform webviews per instance a split-brain can pick the wrong
  PLATFORM, not just the wrong page.

### I. In-season copilot

- **I-1 BLOCKER.** `loadSimContext` is single-league by construction (S-1) and reads the raw
  `config` mirror (simContext.ts:95), the single-slot board (:107), `points.csv` pool ranks (:149),
  and the ESPN variance/rank-outcomes/correlation artifacts (:90-92).
- **I-2 BLOCKER. The lineup optimizer and `rosterGaps` have their own literal-FLEX rule** instead of
  `slotEligibility` (lineup.ts:59-66, season.ts:361-365/394-397): a `SUPERFLEX` slot matches nobody
  (lineup silently scores it 0; `assertRostersCanFillLineup` refuses every Yahoo roster so six verbs
  throw). `values.ts:108-123` already parses SUPERFLEX/`Q/W/R/T`/`W/R/T` correctly.
- **I-3 SHOULD-FIX. Four enumerations of "bench"** (lineup.ts:62 and winprob.ts:476 `BE|BENCH`;
  season.ts:362 `+IR`; values.ts:154 `+IR|ER`) -> Yahoo's two IR slots become two permanent
  "no available player to fill IR" flags.
- **I-4 BLOCKER. FAAB is ESPN-only** in model (`faab-model.json` fitted on 462233), queries
  (inseason/faab.ts:249-259/296-298 season-only), and rules (`AcquisitionRules` exists,
  types.ts:252, implemented once, ZERO consumers). Yahoo FAB 2-day rolling has no representation.
- **I-5 BLOCKER. `scorecard_prediction`/`scorecard_result` are shared across FORMATS** with PK
  `(season, week, kind, model, subject)` and `INSERT OR IGNORE` everywhere (scorecard.ts:571-734): the
  second format's rows are silently dropped, and `odds` subjects (team ids) collide outright.
  Sharing is correct per format, false across formats.
- **I-6 SHOULD-FIX.** `scripts/yahoo-ros-analysis.mjs` re-implements the ROS rate with a DIFFERENT
  denominator (rows present vs scheduled non-bye weeks, simContext.ts:240-258 -- the frame K was
  fitted in), its own greedy lineup fill, a hardcoded roster and its own FA pool.
- **I-7 SHOULD-FIX.** `action_log` and `routines` are league-blind; `ff copilot` has no `--league`
  and silently ignores an unknown flag (ff.ts:3788-3805); `regWeeksFor` (regWeeks.ts:15) takes
  `MAX(reg_weeks)` across leagues; `NFL_WEEKS=17` vs `regWeeks` as "a week" divisor (copilot.ts:53
  vs simContext.ts:359).
- **I-8 BLOCKER (test hygiene). `loadSimContext` "auto" opens the live league over CDP with NO
  timeout** (simContext.ts:273-292) and `test/roster-completeness.test.ts:162` calls it -> the unit
  suite hangs ~9 minutes whenever the app is running (measured: 533 s, 1.25 s CPU). The test also
  reads the config mirror and the ambiguous league query.

### D. Docs / hygiene

- AGENTS.md:57 says the Electron app "is the part still to be scaffolded" (it is built, AGENTS.md:9).
- README.md:282 "35-tool" (truth: `TOOL_NAMES.length` = 39); README.md:48-50 lists multi-league
  fan-out as "not yet built"; README.md:316-317 "Shipped levers" is pre-D14/D15/D21 (benchDiscount
  0.35, consensusBlend 1); README Layout tree omits `src/{features,league,lineage,model,util,weekly}`;
  "(D0-D11)" at README.md:116/444, AGENTS.md:19, CLAUDE.md:264 while decisions run to D24;
  docs/validation.md:4559 names `sim-calibration.mjs` (renamed `season-calibration.mjs` in d8a7fc3);
  D24 (decisions.md:831) claims `valueKey`/`formatKey` exist.
- No test for `formatKey` canonicalization (key-order / float-noise / tier-order invariance + a
  positive control that a real rule change moves the key); no test for `config:<id>` isolation; no
  test that a second league's rows leave the first league's reads unchanged.
- `data/experiments.jsonl` (+2 appended ledger rows) and `data/player-report.csv` (ADP drift only)
  are regenerated output, not hand edits.

## 3. Target architecture (what "done" means for this pass)

```
LeagueContext (src/data/leagueContext.ts)  -- THE ONLY WAY code learns which league / config / model
  { leagueId, platform, config: AppConfig(+platform,+draftType), format: ResolvedFormat }
  resolved ONCE per verb from activeLeagueId(db) or --league <id>; threaded, never re-derived.
  currentLeagueId / activeLeague / inline last-synced queries / REAL_LEAGUE: DELETED.
  getConfig(db, explicitId): config:<id> else DEFAULT_CONFIG  (NEVER another league's mirror).
  legacy `config` key: a derived mirror written only by setActiveLeagueId; no reader left.

ResolvedFormat (src/data/formatResolve.ts)
  keys: scoringKey(LeagueScoring incl. kicker/defense) / valueKey(resolveValueLeague shape + draftType)
        / formatKey(valueKey + calendar)     -- all via canonicalJson; tested for invariance.
  model: ModelHandle = every per-scoring/per-value path a format owns (history CSVs, current-actuals,
        features.db, projection + fold + weekly artifacts, variance/rank-outcomes/correlation,
        points/values csv, golden.json).
  INCUMBENT ALIAS: scoringKey(ESPN) -> data/ root, pinned as a constant AND asserted at load.
  any other key -> data/formats/<key>/ must exist AND <dir>/scoring.json must re-hash to the key;
  a MISS THROWS naming the build command -- never a fallback to data/.
  SHARED-NFL artifacts (injury, opponent-corr, age, opportunity, ros-blend K) stay at the root.

Platform (src/league/platform.ts)  -- the SYNC/DISCOVER/URL half beside the read-side LeagueProvider
  { id, urls{home,league,team,scoreboard,standings,draftRoom}, webview{elementId,host,partition},
    discover, syncSettings -> LeagueSettings{scoring,kicker|null,defense|null,slots,teams,draftType,
    budget|null,format(+leagueId,+platform),acquisition}, syncRosters, syncTransactions?, readTeam }
  espn: lifted from agent.ts/espnApi/leagueRosters/leagueTransactions/espn.ts.
  yahoo: NET-NEW DOM reader through the yahooview guest (bridge routes take a host).
  openLeague / every sync verb dispatch on the LEAGUE ROW's platform; an absent adaptor REFUSES BY NAME.

Storage
  league_id in the PK of every per-league table (adds fact_draft_pick, fact_team_season, fact_matchup;
  draft_id league-qualified; action_log.league_id); every reader filtered by ctx.leagueId; every DELETE
  scoped. board/player_value* carry a league+valueKey stamp; readers REFUSE on mismatch; league-set-active
  invalidates and rebuilds. scorecard_* keyed by format_key.

In-season
  slot matching = slotEligibility everywhere (lineup, rosterGaps, winprob); one isBenchSlot;
  loadSimContext(ctx) with a TIMEOUT on the live read; weekly serve per format (refuse or fall back to
  the format's own season line, named in basisNote); FAAB per league (rule basis when no fitted model);
  --league on ff copilot + optional league on MCP; provenance names league + format.

App
  league switch = one transactional engine call returning the context; platform set BEFORE view;
  page URLs platform-dispatched through activeWv(); bridge guest resolution by host with NO fallback.
```

## 4. Work packages (owner / executor model / gate)

Each WP: tsc clean, `npm test` green (and not hanging with the app up), the golden line above
byte-identical, plus the WP's own positive control and fault injection. Commits per WP with explicit
paths. ESPN behaviour must not move in WP1-WP5; Yahoo becomes correct or REFUSES loudly, never
silently ESPN-shaped.

- **WP1 (opus) -- One resolver + the context seam.** S-1, S-2, S-3, S-7, S-10, S-11, S-12, S-14
  (name/season on discover; junk row), I-7 `--league` flag + MCP arg, I-8 timeout. Adds `platform`
  + `draftType` to AppConfig. Tests: config isolation, explicit-id no-inheritance (fault injection),
  resolver agreement, league_sync identity guard.
  **DONE 2026-09-16 (working tree, uncommitted).** `resolveLeagueContext` is the only resolver;
  `currentLeagueId`/`activeLeague`/`REAL_LEAGUE` and every inline last-synced league query are gone
  (`src` now has `last_synced_at DESC` only inside `activeLeagueId` and the `league-list` ORDER BY);
  no reader of `settings key='config'` is left in `src/` or `scripts/`. `getConfig(db, <explicit id>)`
  falls back to `DEFAULT_CONFIG`, never the mirror; `setConfig` refuses a league-less write.
  `openLeague` dispatches on the league ROW's platform and its refusal is now reachable and tested.
  `--league <id>` on the CLI + an optional `league` on all ten MCP copilot tools; `ff copilot` rejects
  unknown flags. `loadSimContext`'s live read is bounded by `FF_LIVE_READ_TIMEOUT_MS` (default 15 s;
  positive control `scripts/live-read-timeout-probe.mjs`), so `npm test` now finishes in ~185 s with
  the app running (was 533 s + 1 fail). Junk league row 211696 deleted. Gate: `backtest --full
  --no-lookahead --inflation --seasons 1999-2024 --n 150` = 39.5% / 96% with the per-season line
  byte-identical to the baseline above. Not done in WP1: `app/engine/ff.cjs` is a stale build artifact
  (`npm run build:engine` regenerates it); `ingest-source` has no `--league` passthrough yet (its
  league sources resolve the active league and refuse a non-ESPN platform by name).
- **WP2 (opus) -- Storage integrity.** S-4, S-5, S-6, S-8 (stamp + refuse + rebuild hook), S-9, S-13,
  I-5 (format_key on scorecard_*), P-2. Migration is idempotent, runs against the backed-up store.
  Test: synthetic second-league rows in every keyed table leave every ESPN read byte-identical.
- **WP3 (opus) -- Format resolver + artifact chokepoint.** F-2..F-9, F-10, I-1 (artifact side).
  `formatResolve.ts`, `valueKey`/`formatKey`, `scoring.json` preimage, `models.ts` registry through
  `ModelHandle`, weekly/scorecard/simContext loaders threaded, `build-format-*` write the preimage and
  rebuild the weekly table, scripts use the resolver, `current-actuals` per format, format target
  frozen at settled seasons. Tests: incumbent path identity; miss throws; positive resolve to the
  Yahoo dir; formatKey invariance.
- **WP4 (opus, needs the live app) -- Yahoo config + Platform + app switch.** Correct
  `config:129048` from the LIVE Yahoo settings page (not from the recon note); `src/league/yahoo.ts`
  + `platform.ts`; bridge host param + no-fallback (P-3); renderer P-4; `league-set-active` returns
  the context and triggers the board rebuild (S-8 rebuild half). Positive control: Yahoo roster read
  live = 18 names matching the array in `scripts/yahoo-waiver-trade.mjs`, 12 teams, the schedule.
- **WP5 (opus) -- In-season format correctness.** I-2, I-3, I-4, I-6, I-7 (action_log/routines/
  regWeeks), F-4 serve rule, `loadSimContext(ctx)` league side. ESPN byte-identity via the existing
  lineup/values regression locks.
- **WP6 (sonnet) -- Docs + hygiene.** Section D; D24 accuracy; refactor doc corrections (the three
  half-keyed tables, "rebuilt on switch"); lint warnings; this file's status.
- **WP7 -- Per-format gate + Yahoo in-season odds** (after WP1-5): `cpcv --league`, per-format
  `golden.json`, `ff copilot season-odds --league 129048` from the seeded simulator.
- **Model improvement (after the architecture is at target):** re-screen the feature library under
  the Yahoo target (pre-filter first), Yahoo-native market anchors, K refit per format, the snake
  draft `DraftModel`.

Execution order: WP1 + WP6 in parallel (disjoint files) -> WP2 -> WP3 -> WP4 + WP5 (disjoint) -> WP7.

**WP6 status (2026-09-16): DONE.** AGENTS.md/README.md/CLAUDE.md D0-D11 refs and the stale "still to be scaffolded" line fixed; README 35-tool/Not-yet-built/Shipped-levers/Layout-tree corrected; docs/validation.md sim-calibration rename noted; D24 valueKey/formatKey claim corrected; multi-league-refactor.md S-5/S-8/S-9 corrections added; multi-format-design.md Status note added.
