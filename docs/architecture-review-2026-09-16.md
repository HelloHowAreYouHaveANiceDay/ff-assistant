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
  **DONE 2026-09-16 (working tree, uncommitted).** `league_id` now leads the PK of `fact_draft_pick`/`fact_team_season`/`fact_matchup` (live rows preserved 1658/130/1050, indexes recreated + asserted); `buildLeagueFacts`'s two bare `DELETE FROM`s are scoped; every `fact_*`/`raw_league_*` reader in `src/` is filtered (test/league-isolation-readers.test.ts is differential -- league A's reads on a two-league store vs an A-only store -- and four filters were fault-injected to prove it fails); the local draft session is `local:<leagueId>`, `action_log.league_id` exists and `logAction` records it, `decision_snapshot`'s divergent CREATE moved into schema.sql; `scorecard_*` are keyed by `format_key` (3650 rows backfilled `sc-f6143a8dfb13`, asserted); `board`/`player_value` carry a league stamp and every reader calls `assertBoardFor`, with `ff league-set-active`/the serve RPC clearing + rebuilding through `switchActiveLeague`. Golden 39.5%/96%, per-season line byte-identical. NOT done: `tools/train_{price,faab}.py` still read their fact tables unfiltered; `player_value_position` has no producer and no `CREATE` in schema.sql (noted there); `liveFaabState`/`buildPopulation`/`realFaPool` take an optional `leagueId` that defaults to the active league because their callers (copilot.ts, weekly/features.ts) are WP5/WP3's to thread.
- **WP3 (opus) -- Format resolver + artifact chokepoint.** F-2..F-9, F-10, I-1 (artifact side).
  `formatResolve.ts`, `valueKey`/`formatKey`, `scoring.json` preimage, `models.ts` registry through
  `ModelHandle`, weekly/scorecard/simContext loaders threaded, `build-format-*` write the preimage and
  rebuild the weekly table, scripts use the resolver, `current-actuals` per format, format target
  frozen at settled seasons. Tests: incumbent path identity; miss throws; positive resolve to the
  Yahoo dir; formatKey invariance.
  **DONE 2026-09-16 (working tree, uncommitted).** `src/data/formatResolve.ts` is the one map from league to model files: the incumbent key aliases the `data/` root (pinned as `INCUMBENT_SCORING_KEY` in formatKey.ts, asserted at module load against `DEFAULT_SCORING`; `db.ts`'s `ESPN_SCORING_KEY` is now an alias of it), any other key must have `data/formats/<key>/` AND a `scoring.json` whose canonical re-hash equals the dir name, and a miss THROWS naming the build command -- never a fallback to the root. `valueKey`/`formatKey` are real functions; `scoringKeyFor` folds kicker/defense in by DEFAULT-ELISION, which keeps both live keys (`sc-f6143a8dfb13`, `sc-a845f67652fb`) unchanged while a non-default K or DST table moves the key (both proven in test/format-key.test.ts). Threaded through `assemble` (WP2's blanket refusal replaced by the resolver -- a format-dir league now BUILDS its board, generating its `points.csv` from its own artifact through the same `project` path), `simContext` (variance/rank-outcomes/correlation + the pool ranks), the weekly serve and scorecard, `models.ts`, `projections.ts`, `history.ts` (`current-actuals` per format; the format target frozen at SETTLED seasons, F-8) and the `ff` verbs (`project`/`assemble`/`values`/`simulate`/`calibrate`/`cheatsheet`/`sync-actuals`/`handcuffs`/`backtest`). The Yahoo format's `feat_player_week_model` was REBUILT under its own scoring (F-4): against the main store's table, 1102 of 1670 shared 2025 wk1-4 rows differ in `pts` (max |d| 20.5) and 1563 differ in `season_line_pg`, and `manifest.weekly.seasonLineBlind: false` records that no fold set exists for it yet. `player_value_position`'s producer, `CREATE` and lineage entry are restored, so `switchActiveLeague` clears all three tables. Positive controls: on a copy of the live store, switching to 129048 builds a 574-row Yahoo board stamped `sc-a845f67652fb` from the YAHOO artifact (QB 6/24 of the top value against ESPN's 1/24; `value-format-compare` on 2025 still reproduces this doc's 8/24 with Hurts $55 / Lamar $47 vs Bijan $103); the live ESPN board is byte-identical to the backup and the store is left ACTIVE = 462233. Gates: tsc clean; 886 tests / 884 pass / 2 skip; eslint 0 errors, no new warnings; golden 39.5% / 96% with the per-season line byte-identical (run twice). NOT done: `cpcv.mjs` has no `--league` and there is no per-format `golden.json`, so F-9 is only half closed (`ff backtest --league` reads the right target but the gate number is still the incumbent's); `price-model.json`/`faab-model.json` are per-LEAGUE, not per-format, and stay at the root with that stated on the registry; `src/draft/sim.ts` and `src/inseason/**` still read `variance-model.json`/`correlation-model.json`/`projection-artifact.json` through `dataPath` (other WPs' files -- see the WP3 report); the Yahoo format has no `current-actuals`, weekly artifact, variance/rank-outcomes/correlation or fold set, so its board carries no p10/p90 band and the in-season copilot on it falls back by name.
- **WP4 (opus, needs the live app) -- Yahoo config + Platform + app switch.** Correct
  `config:129048` from the LIVE Yahoo settings page (not from the recon note); `src/league/yahoo.ts`
  + `platform.ts`; bridge host param + no-fallback (P-3); renderer P-4; `league-set-active` returns
  the context and triggers the board rebuild (S-8 rebuild half). Positive control: Yahoo roster read
  live = 18 names matching the array in `scripts/yahoo-waiver-trade.mjs`, 12 teams, the schedule.
  **DONE 2026-09-16 (working tree, uncommitted).** `config:129048` rebuilt BY CODE from the live settings page (`yahooPlatform.syncSettings`, not by hand): 12 teams, snake, PPR, slots QB/WR2/RB2/TE/FLEX3/SUPERFLEX/BE7/IR2, format 14 reg weeks + 8-team playoff wk15-17 reseeding, no divisions, `kicker`/`defense`/`posMax` explicitly null (no K/DST slot), FAB $100 2-day continual, `source:"owner-override"` with a `note` naming the page; all 20 scoring terms verified term-by-term against `YAHOO_129048_SCORING` (0 mismatches) and `scoringKey` = `sc-a845f67652fb`, the existing Yahoo model dir; `league` row 129048 gets `team_id=11`, `scoring_json`, name. New `src/league/{platform,espnPlatform,yahooDom,yahoo}.ts` + `openLeague`'s `yahoo` case; bridge `/fetch`,`/read-frame`,`/click` take a `host` with a per-platform allowlist (`app/bridgeHosts.js`) and the guest resolver's any-guest fallback is GONE; renderer page tabs are per-platform through `activeWv()`, `switchLeague` sets the platform BEFORE the view and renders what `league-set-active` returns. Positive controls: live Yahoo 12 teams / 18-of-18 roster match / 14x6 = 84 schedule games; ESPN 462233 unchanged (16 teams, 13 reg weeks); bridge refuses an unknown host, a crossed-over url and a missing guest (fault-injected by driving the Yahoo guest off its host); app ESPN->Yahoo->ESPN shows the right webview and never navigates the ESPN guest to 129048. Not done here: `agent.ts`/`ff.ts` still call their own ESPN sync bodies (WP5 wiring); `app/engine/ff.cjs` is stale so the app's `league-set-active` returns only `{active}` until `npm run build:engine`; `YahooLeague.freeAgents` refuses by name (unbuilt).
- **WP5 (opus) -- In-season format correctness.** I-2, I-3, I-4, I-6, I-7 (action_log/routines/
  regWeeks), F-4 serve rule, `loadSimContext(ctx)` league side. ESPN byte-identity via the existing
  lineup/values regression locks.
  **DONE 2026-09-16 (working tree, uncommitted).** Slot vocabulary is ONE module (`src/draft/slots.ts`: `slotEligibility`/`isBenchSlot`/`slotAdmits`/`startingSlots`/`splitTemplate`), imported by lineup.ts, winprob.ts, season.ts, values.ts, lineupMarginal.ts and rosterMarginal.ts -- six hand-typed bench enumerations and five literal-`FLEX` rules gone; `flex_ok` still overrides the literal `FLEX` token and nothing else, so ESPN is unmoved. A Yahoo roster now fills `SUPERFLEX` with the spare QB and its two `IR` slots are never flagged unfillable; `rosterGaps` fills flex GROUPS narrowest-first (laminar, so exactly optimal) and `assertRostersCanFillLineup` accepts a legal superflex roster while still refusing the systematic shortfall. FAAB is per league (`faabArtifactFor`: `FF_FAAB_MODEL` > `data/faab-model.<id>.json` > the pinned incumbent 462233; any other league gets `faabBasis:"rule"` naming the artifact it would need) and `AcquisitionRules` has consumers at last (budget + process day, via `loadAcquisition`). Every copilot `Provenance` carries `leagueId`/`platform`/`scoringKey` and the caveat sentence leads with them; `runCopilot` stamps `action_log.league_id`; `refreshDecisionSnapshot` resolves the league ONCE and stamps from that instead of re-reading `activeLeagueId` after the three simulations. Routines are league-aware (`planRoutines`/`routineLeagues`; per-league `scheduler:<id>` with the global row as the default) and skip a platform BY NAME. Platform wiring: `discover_leagues` uses `espnDiscoverFromLinks` and stamps `platform` from the adaptor; `league_sync` dispatches through `platformFor(ctx.platformRaw).syncSettings` over a bridge `PlatformIO` and maps `LeagueSettings` (now carrying `teamId`) onto the row + `setConfig`; `read_league` sends a non-ESPN league through `openLeague`; the browse tools drive the ACTIVE platform's guest and the five ESPN draft-room tools refuse by name. `LeagueContext.platformRaw` lets every refusal name the platform, and `requirePlatform(..., adaptorMethod)` names the missing method. Gates: `tsc` clean in every WP5 file; `npm test` 885 tests, 881 pass, 2 skip, 2 failures BOTH in WP3's concurrently-edited `src/data/formatResolve.ts`; eslint 0 errors, no new warnings; golden **39.5% / 96% with the per-season line byte-identical**; live Yahoo `openLeague` still 12 teams / 18-man roster; `ff copilot lineup --league 129048` REFUSES by name (board stamp). NOT done: the `NFL_WEEKS`-vs-`regWeeks` divisor is DOCUMENTED, not unified -- `simContext.ts:399` builds `replacement` as `seasonPts / regWeeks` while every consumer is in the `proj / 17` frame (~1.31x high here); that file is WP3's and the fix moves live ESPN in-season numbers, so it needs owner sign-off. `lineupMarginal.baselines()` still builds its flex pool from `flexOk` only, so a SUPERFLEX group does not move QB replacement level there (values.ts `flexGroups` does). `ingestLeagueRosters`/`ingestLeagueTransactions` still refuse non-ESPN rather than dispatching to `yahooPlatform.syncRosters`.
- **WP6 (sonnet) -- Docs + hygiene.** Section D; D24 accuracy; refactor doc corrections (the three
  half-keyed tables, "rebuilt on switch"); lint warnings; this file's status.
- **WP7 -- Per-format gate + Yahoo in-season odds** (after WP1-5): `cpcv --league`, per-format
  `golden.json`, `ff copilot season-odds --league 129048` from the seeded simulator.
  **DONE 2026-09-16 (commit 8edb34e).** `ff sync-rosters` is PLATFORM-DISPATCHED: it resolves
  the league once, hands `platformFor(ctx.platformRaw)` one authenticated GET inside that platform's own
  guest (`bridgePlatformIO`), and writes through one shared writer (`src/data/ownershipSync.ts`) that
  keys every row by `nameKey` with the DST nickname->abbreviation alias applied on POSITION. The ESPN
  rows it produces are **byte-identical** to the ones the old ESPN-only body wrote (192 rows compared
  field-for-field before and after); Yahoo 129048 now holds **207 ownership rows across 12 teams**
  (17-18 each), our 18 matching the live team page name-for-name. New `ff sync-schedule [--league]`
  writes `raw_league_matchup` through any platform's `provider.matchups()`: **84 games over 14 weeks**
  for 129048, ESPN's 1042 untouched. `raw_league_matchup` carries pairings only (no score columns), and
  the Yahoo league has no started-lineup snapshot, so `loadSimContext` now REFUSES to seed a league whose
  settled weeks have no `raw_league_roster_week` rows -- previously every team scored 0, every matchup
  tied, and the home side "won", i.e. fabricated standings that render exactly like real ones. The
  refusal is carried into `assumptions.played.seedBlocked` and leads the caveat as "NOT SEEDED: ...".
  `fit-variance` / `fit-correlation` / `fit-bootstrap` take `--league` (`scripts/lib/format-paths.mjs`):
  with no flag they return the historical literals BY CONSTRUCTION, opening no store -- re-run flagless
  they reproduced `variance-model.json` and `rank-outcomes.json` BYTE-IDENTICAL and
  `correlation-model.json` identical modulo the CRLF the git checkout applies (the writer emits LF;
  `git diff` is empty). All three are now fitted into `data/formats/sc-a845f67652fb/` from the Yahoo
  target: 16 of 24 CV cells differ from ESPN's (K and DST are identical, because the Yahoo target still
  scores them under the default rules -- the league rosters neither, so nothing consumes them, but it is
  a cosmetic untruth in that file). `ff sync-actuals --league 129048` writes the format's own
  `current-actuals.csv` (Rodgers wk1 16.5 PPR vs the root's 12.5 half-PPR) and REFUSES the forward-board
  rebuild by name, because `buildForwardBoard` writes the shared `feat_player_week*` tables that hold the
  INCUMBENT's scored target; its scoring model now comes from the same resolved context as its output
  path (it took the ACTIVE league's rules while writing another league's file). `scripts/cpcv.mjs` gains
  `--league`: it resolves the format, passes `--league` down to both child backtests, reads
  `<dir>/golden.json` (new `data/golden.json` pins the incumbent's 96.0 / 38.5 / 3.0pp), stamps
  `league`+`format_key` on the ledger row, and for 129048 REFUSES by name ("format sc-a845f67652fb has no
  golden -- a pre-draft gate needs the snake DraftModel; in-season odds are reachable but ungated"),
  running nothing and appending nothing. Flagless it reads 96.0/38.5 from `data/golden.json` and is
  otherwise unchanged (verified end-to-end on cached dumps). The leftover `dataPath` per-format reads are
  closed: `copilotStore` (handcuff variance model, provenance variance + projection stamps, and the two
  weekly loaders, all now per league), `backtest/scorers.ts`, `backtest/winprobLineup.ts`,
  `injuryHorizon.ts` (variance per format; `injury-duration-artifact.json` confirmed SHARED-NFL and read
  through `model.shared`), and `draft/sim.ts` (a `variancePath` threaded from the backtest's resolved
  format through `DraftFieldOpts`). LIVE RUN on 129048: playoff shares sum to **exactly 8.0000** over 12
  teams and title shares to 1.0000; the lineup fills SUPERFLEX with Jared Goff beside Burrow at QB and
  flags no IR slot; the weekly serve falls back BY NAME to the format's season line
  (`basisNote: "no weekly projector was supplied..."`); waivers report `faabBasis: "rule"` on a $100
  budget. `copilot-crosscheck.mjs --league 129048`: ALL CHECKS PASSED, fault injection included. ESPN
  identity after switching back: `player_value` 529 rows byte-identical to the backup, `board` differs
  only in `ESPN_ADP` on 151 players (live market drift of 0.1, diagnosed field-by-field), the week-2
  lineup JSON identical to its pre-switch capture, golden **39.5% / 96%** with the per-season line
  byte-identical. Gates: tsc clean; 898 tests / 896 pass / 2 skip / 0 fail; eslint 0 errors, 47 warnings
  (two fewer than the 0835e7a baseline); `active_league = 462233`. NOT done: the Yahoo format has no
  weekly/streaming artifact and no fold set, so the weekly serve and the D18 seed both degrade and say so;
  `player_value_position` went 523 -> 529 rows on the ESPN rebuild because this was the first ESPN board
  rebuild since WP3 restored its producer (the backup's 523 is the pre-WP3 table) -- the six additions are
  board rows that previously had no pvp row at all; the Yahoo board still carries K and DST players even
  though the league rosters neither, so `waivers` can suggest a kicker.
- **Model improvement (after the architecture is at target):** re-screen the feature library under
  the Yahoo target (pre-filter first), Yahoo-native market anchors, K refit per format, the snake
  draft `DraftModel`.
  **M1 DONE 2026-09-16 -- the Yahoo re-screen is MEASURED and the projection-layer edge thesis is NOT supported (`docs/format-edge-screen-2026-09-16.md`):** Yahoo baseline nested CV recorded (trained RMSE 71.3 / pinball 15.7 pooled over 13 blind folds, beating the free curve at every position); 18 paired-floor screens under the Yahoo target with the identical 18 run against `data/ff.db` in the same session -- **zero ADMITs**, the only near-miss `prior_adot` TE (+0.0582 vs floor 0.0633, ESPN -0.0387, holdout reverses to -0.2708); `prior_carries_per_game` QB rejects, so superflex is a Layer-2 value effect not a projection effect, as the design doc already argued from the other side; the half-PPR-scaled `fftoday_proj` anchor still KEEPs strongly under Yahoo (+0.5698, 8/8), so that approximation is flagged but not costly. Nothing shipped; new read-only `scripts/prefilter-feature.mjs`; no Yahoo championship gate exists (F-9/WP7), so any admission would have been pinball-floor-only.
  **M2a DONE 2026-09-16 -- the WEEKLY expert consensus ADMITS on the measurement and is BLOCKED AT SERVE (`docs/weekly-ecr-screen-2026-09-16.md`):** `ecr_wk_rank`/`ecr_wk_sd` (FantasyPros `ranking_history.wp`, latest scrape at or before this team's kickoff-minus-two) declared not fitted on `feat_player_week_model`, D19-contract compliant (explicit missing, NaN passthrough, own `ecr` mask group at 0.97); new `scripts/ecr-week-leak-guard.mjs` holds with BOTH fault injections firing (leaked cutoff 6,893 rows, anchor shifted 24,133). Pre-filter is the strongest yet -- partial corr with points **-0.18 to -0.23 at QB/RB/WR/TE** after the level AND the form are partialled out -- and the paired-season floor on the covered seasons is **+0.0413 CRPS, 5/5, floor 0.0165, CI [0.032, 0.051]**, the largest weekly effect measured here, with a clean **negative control** on the 8 uncovered seasons (+0.00015, 3/5). All three gate clauses still pass; lineup regret +0.19/+0.24 pooled. **NOT SHIPPABLE:** the archive ends 2024-12-27 and the live `weekly_rank` table is truncated on every ingest and carries no (season, week) -- so a fitted coefficient serves zero to a 2026 lineup. The owner decision is the `weekly_rank` retention, not the feature. Step 4 (`scripts/inseason-backtest-lineup.mjs`) could not be run: it has no artifact flag. Nothing shipped; all four served weekly artifacts byte-identical; backtest 39.5%/96%.
  **M2b DONE 2026-09-16 -- the serve boundary is GONE; the candidate is READY FOR SIGN-OFF, nothing promoted (`docs/weekly-ecr-screen-2026-09-16.md` sections 11-17, `docs/decisions.md` D27 PENDING):** `ingestWeekly` now ALSO appends each scrape into `ranking_history` as `ecr_type='wp'` on the archive's own PK (`appendWeeklyRankSnapshot`, INSERT OR IGNORE -- never DELETE, never UPDATE), so `ecrWeekTable` serves 2026 with no change of its own; first retained scrape **2026-09-16, 815 rows, all six fielded positions**, and a second run adds **0** rows while reporting **815** conflicts (idempotent AND demonstrably ran). Backfill is impossible (one-scrape feed, permanent 2025-01..2026-09-15 hole). **The live week is WEEK 2, not week 3** (week 1 is settled; week 2's `as_of` is 2026-09-16, the last legal snapshot day): 395/532 rows carry a value, 236/295 of the decision population, 8/12 of our roster -- the 19 BUF/DET NULLs are the Thursday game whose kickoff-minus-two anchor precedes the scrape. Leak guard holds over 2020-2026 with **both injections firing on the 2026 rows specifically** (48 / 369), and its era bound was repaired from a literal `2019..2024` to a list derived from `ranking_history`. Candidate at `data/weekly-artifact.candidate-ecr.json` (27 features, golden recomputed to 1e-6); **the 25-feature refit control reproduces the served artifact BYTE-FOR-BYTE**, so every delta is the two columns' presence. **The caution:** of a 0.548-pt mean live move only **0.238** is the column's VALUE (WR: 0.198 of 0.770; Nacua's -15.11 survives blanking the column) -- the rest is the refit re-splitting trees under the new `ecr` mask group, in the D19 all-imputed 2026 regime; the lever IS connected (Lamar Jackson +5.02 on the value alone, Goff 0.00 where the column is NULL). **The live starting eleven and all four streaming picks are UNCHANGED.** New write-once scorecard kind `weekly_ecr_candidate` froze 530 week-2 rows (re-freeze refuses) so the record accrues regardless of sign-off timing. A `rankings` routine (`ff ingest-source weekly`) is first in the registry and in `DEFAULT_ROUTINES`, verified end-to-end through `ff inseason-tick --routines rankings` (1/1 ok, +0 new / 815 already held), with `ingest-source` added to the tick's HANDLERS map -- `test/routines.test.ts` caught that the routine had first named `ingest-raw`, which refuses a non-RAW id, and a verb with no handler is SKIPPED SILENTLY. The STORED scheduler row overrides `DEFAULT_ROUTINES`, so **enabling the cadence is left for the owner** and is worth doing even if the model is rejected. Yahoo NOT run: the per-format `features.db` carries its own `ranking_history` frozen at 67,991 rows and `--weekly-only` never refreshes it, so a rebuild today would write an all-NULL column. Nothing promoted; all four served weekly artifacts byte-identical; backtest 39.5%/96% with the per-season line byte-for-byte.
  **M2h DONE 2026-09-16 -- the SERVE-TIME missingness ablation: the feed to harden is the DEPTH CHART, and one live regression is already costing 0.71 points a lineup every week (`docs/weekly-missingness-ablation-2026-09-16.md`):** each served column and each `MASKABLE_GROUPS` family masked at SERVE only on the canonical 14-season nested evaluation (fit-with / serve-without; 37 arms, one fold set trained once and reused, ~30s per arm), paired by season with the lineup-regret decision metric beside CRPS. **`depth_rank` is the most expensive column in the model by 2x -- +0.5376 +/- 0.0300 CRPS, 14/14 seasons, -0.83 pts/lineup, and the only single mask that damages calibration (0.844 -> 0.811)** -- ahead of `t4_mean` (+0.2503), the level covariate (+0.0921) and `td_ppg` (+0.0892); the whole injury-designation block is +0.0456 and practice status +0.0188, i.e. a seventeenth of the depth chart, which agrees with the prior log-loss reading. **A PARTIAL feed failure is WORSE than a total one in two of the four groups:** `family:usage` +0.375 against `depth_rank` ALONE +0.538, and `family:form` +0.054 against `t4_mean` ALONE +0.250 -- D19's augmentation masks whole GROUPS (`MASK_DROP_P`), and one column going dark inside a present block is the out-of-distribution case it does not cover (a per-COLUMN dropout arm is the follow-up worth measuring; not proposed as a ship). **Two premises were STALE and are corrected on measurement:** the injury feed did NOT stay dark -- 2025 runs `inj_feed` mean **1.000** with normal designation rates, and the dark block at the live 2026 week-2 serve is a different one, **seven columns 100% NULL (`prior_snap_share`, `prior_route_share`, the four to-date production ratios, `t4_sd`)** where 2023-2025 were 78-93% populated at the same week; masking exactly that set costs **+0.0647 +/- 0.0062 CRPS, 14/14, -0.71 std15 / -0.91 deep18 points per lineup, every week** -- a live regression, not a risk, and fixable in the 2026 snap-count/pbp ingest with no model change. **`inj_feed` is a measured NULL (0.0000 in all 14 seasons):** it is constant at 1 in every fitted row, so no tree ever split on it, proved not-the-instrument by `family:avail` (which contains it) moving +0.1443. **The D27 candidate's serve exposure is small and bounded:** masking the consensus costs **+0.0362 +/- 0.0077 on the 6 covered seasons, 6/6** against M2a's measured GAIN of +0.0413 -- a missing Friday scrape gives back the gain and nothing more (coverage 0.845 -> 0.848, lineup -0.08), and the Thursday-only real exposure prorates to ~+0.002, so the admission creates no fragility worth blocking on. Controls all arms: mask-everything -8.75/-10.12 pts per lineup; `home` +0.0006; a column already 100% missing in a season is EXACTLY 0.000000 there (`prior_route_share` 2012-2015, `ecr_*` in 8 of 14); **`week_no` is NOT ~0 (+0.0197, 14/14) and the pre-registered expectation is recorded as wrong rather than restated.** Also found: **`ff evaluate-weekly`'s flagless `--features all` now trains 29-feature folds while the served artifact carries 25** (`rz_share_td`, `prior_vol_cv` and the two M2a columns were declared after it was built), so the canonical evaluation no longer measures the shipped feature set -- this driver pins `--features` to the artifact's own list. Nothing shipped, no default moved; the only `src/` change lifts D19's existing inline serve mask into an exported `applyServeMask` with identical semantics (default-off proven structurally + by `test/weekly-missingness.test.ts`); new `scripts/weekly-missingness-ablation.mjs`; read-only on `data/ff.db`; `npm run typecheck` clean, 1045 tests green, served artifacts byte-identical (`a3871f4c...` / `d2982b1c...`).
  **M2f DONE 2026-09-16 -- the projector's CONTRIBUTION LEDGER: ONE of eleven fitted features clears the floor, and it is the external projection (`docs/contribution-ledger-2026-09-16.md`):** a leave-one-out ablation of every DEFAULT fitted feature (enumerated from the trainer and cross-checked against the shipped artifact's `coef` keys -- **`docs/feature-frontier.md`'s opening list is STALE**: of the ten "fitted workload shares" it names, only `depth_rank_sep1` and `team_changed` are actually fitted, the rest are declared-not-fitted `EXT_CENTER` candidates), plus a leave-FAMILY-out over a five-family partition, 2013-2025, decision 2013-2020 / holdout 2021-2025, WS1 floor + BH FDR across the eleven LOO rows. **`fftoday_proj` +0.4491 +/- 0.0570 pinball, 8/8 seasons, floor 0.1653, holdout +0.2438 CONFIRMED, BH q 0.000 -- the only KEEP, and 53% of the +0.851 total the whole fitted set adds on top of the rank curve.** The other ten are individually unresolvable (next-best q 0.089). **One DROP candidate, as a JOINT selection of four:** the rank-bucket production ratios `prior_fd,prior_ts,prior_attempts,prior_rush_yards` removed TOGETHER cost **-0.0330 +/- 0.0845 (3/8) on the decision block and -0.0401 (2/5) on the holdout** -- negative in both eras -- against a sum-of-members of +0.062 (they are mutually redundant and redundant with the anchor); inside the floor, so the claim is "no measurable contribution", not "harmful", and it needs the D13 playoff gate + sign-off. **Two features are explicitly NOT drop candidates despite a DROP verdict:** `depth_rank_sep1` and `team_changed` are both holdout-CONFIRMED (+0.1386 and +0.1108, **5/5 seasons each**; jointly +0.2776, 5/5) -- a regime split of the `prior_vol_cv`/`hist_ppg_w` shape, `+` in every recent season and mixed before 2019. **Yahoo contrast: the same family carries the model in the same proportion** -- `fftoday_proj` +0.5698, 8/8 (3.49% of Yahoo pinball vs 3.76% of ESPN's), while `prior_pos_rank`/`team_changed` are inside the floor under both; the Yahoo arm reproduces M1's recorded `+0.5698 +/- 0.0941, 8/8, floor 0.2729` to four decimals from a different session and a fresh fold set. Positive controls: the ledger returns KEEP (rule 4), and a family arm was proved to remove BOTH members by reading the emitted artifact's `coef` keys. Nothing shipped; **`tools/train_projection.py` byte-for-byte untouched** (`--remove-features` already took a comma list); read-only on both DBs; new `scripts/contribution-ledger.mjs` + `test/contribution-ledger.test.ts` and a `--baseline-cache`/`--json` option on `admit-feature.mjs` (the full-default arm is shared across rows, so it is fitted once). Reading: feature work on the SEASON projector is saturated at this power (floor = 0.5-2% of the loss on 8 decision seasons); the levers with leverage are more external judgement or more decision seasons, not another derived usage share -- the third independent measurement pointing at the VALUE/DECISION layer.
  **M2e DONE 2026-09-16 -- the Yahoo room is CALIBRATED against the league's own draft and the asserted `marketSd 0.30` SURVIVES (`docs/validation.md` "Yahoo room calibration (M2e)", `data/formats/sc-a845f67652fb/golden.candidate-m2e.json`):** league 129048's real draft is in the store -- **384 `raw_league_pick` rows** (2026: 204 = 12 x 17, 2025: 180 = 12 x 15) read from both tabs of `/f1/129048/draftresults` through the app's Yahoo guest and refused unless the two tabs agree on every pick, the draft is rectangular, and the order IS `serpentineOrder(12,17)`; the team-tab cross-check caught a parser that dropped all 11 team defenses and shifted every later 2025 pick. Simulation-based method of moments on that draft (`scripts/snake-room-error.mjs`) brackets the constant at **0.244 (logGap) to 0.335 (rankGapTop) against the asserted 0.30**, and the gate under the endpoints is **34.2%/98% -- 39.8%/99% (flagless, reproduced EXACTLY incl. all 26 per-season cells) -- 44.3%/100%**. `--bot-noise` is **not identifiable** from one draft (the fitted shared term moves <=0.04 across 0/0.20/0.40). Two limits recorded rather than fitted away: the room model **cannot reach the real draft's tail at any marketSd** (`vorBook` floors sub-replacement VOR to 0 and the error is multiplicative, so a noised zero is a zero -- real rank-gap 44.3 vs a simulated ceiling of 41.9), and the fit attributes ALL disagreement to room error, so it is an UPPER bound -- the new `--snake-adp league` arm, giving the room the league's REAL 2025 order, returns **0.0% titles / 59% playoffs** against 35%/100% for the gate's own room (n=1 season, diagnostic only; `--snake-adp ppr` independently agrees at 0.8%/79%, which contradicts this document's own "it FLATTERS us" argument). **RECOMMENDATION: do not re-pin -- `golden.json` is untouched and 0.30 is now measured rather than asserted.** `picks.ts` fixed to write `money_remaining` NULL for a snake (it was writing $0), and `test/picks.test.ts` -- which read `fact_draft_pick` with NO league filter in six places and read 2025 as 372 picks against the recorded 192 the moment a second league existed -- is scoped to 462233 with a new test asserting the filter is load-bearing (five of its six unfiltered reads had kept PASSING on the contaminated population). Nothing shipped; ESPN's 1,658 `fact_draft_pick` rows byte-identical to `data/ff.db.bak-prem2e-2026-09-16` incl. `updated_at`; backtest 39.5%/96% with the per-season line byte-for-byte (`2000:28 2001:31 2002:44 2003:47 2004:32 2005:29 2006:49 2007:19 2008:47 2009:55 2010:44 2011:62 2012:47 2013:41 2014:29 2015:38 2016:29 2017:33 2018:41 2019:36 2020:43 2021:35 2022:54 2023:33 2024:40`).
  **M2d DONE 2026-09-16 -- the season simulator is NOT over-confident (that claim is stale), and the one dispersion term that IS wrong is the D18 level prior (`docs/season-sim-calibration-2026-09-16.md`):** five dispersion knobs swept through a new `--sweep KNOB=v1,v2,...` axis on `scripts/season-calibration.mjs`, every arm from ONE script version on a `VACUUM INTO` snapshot, controls reproducing D25 EXACTLY (preseason 0.2297 playoff / 0.0636 title, week 4 arm D 0.2004, week 8 arm D 0.1336) and every lever fault-injected so no null is a disconnected knob. **The README's "50-70% band realises 46%" predates D16 and D25.1:** on the current stack that band is 32 rows at predicted 55.8% -> **observed 59.4%**, 102 of 114 team-seasons sit in 30-70%, and there is no bin above 70% -- the preseason arm is UNDER-RESOLVED, not over-confident, and 46% is what an over-SHARPENED sim looks like (`FF_SIM_LEVEL_SCALE=0` reproduces it). Preseason: LOSO picks the SHIPPED value 8/8 for all five knobs (level spread, roster-level common factor, weekly variance, and both copula stages), so widening dispersion is the rejected uniform shrink wearing a mechanism's costume -- the new `FF_SIM_TEAM_SD` at 0.25 collapses 96 of 114 rows into one bin (`sd(p)` 0.109 -> 0.067) and loses +0.0037. Week-to-week persistence is NOT missing (schema 2 draws whole player-seasons and permutes weeks within them), and `calibration:"scale"` already preserves the pool's shape, so (b) and (d) have no term to add. **FINDING, in-season, pending sign-off:** D18 reuses the ROS-blend's K=6 as the prior weight for the LEVEL's posterior SPREAD, an untested transfer, and it is ~6x too weak -- **K_u = 1** gives week 8 **0.1336 -> 0.1297** (paired -0.0039, CI [-0.0067, -0.0007], 7/8), week 11 **0.0867 -> 0.0851** (-0.0017, CI [-0.0030, -0.0002], 6/8), week 4 a dead null, preseason identical by construction, with the top reliability bin's gap +10.4 -> +6.7 (a sharpening: `sd(p)` 0.2994 -> 0.3120) and the D18 seeded/unseeded margin GROWING at every value (8/8). The grid's LOSO optimum is the boundary `K_u = 0`, which is NOT proposed and is said so. Nothing shipped, no default moved; `copilot-crosscheck --schedule real` ALL CHECKS PASSED and `ff copilot season-odds --league 462233` byte-identical to D25 (us 66.45/13.50, MILE 54.05); backtest 39.5%/96% with the per-season line byte-for-byte (`2000:28 2001:31 2002:44 2003:47 2004:32 2005:29 2006:49 2007:19 2008:47 2009:55 2010:44 2011:62 2012:47 2013:41 2014:29 2015:38 2016:29 2017:33 2018:41 2019:36 2020:43 2021:35 2022:54 2023:33 2024:40`).
  **M2g DONE 2026-09-16 -- the WEEKLY model's CONTRIBUTION LEDGER: a leave-one-out measures REDUNDANCY, a serve mask measures RELIANCE, and for this model they are nearly unrelated (`docs/weekly-contribution-ledger-2026-09-16.md`):** 31 retrained arms x 14 leave-one-season-out folds (434 fold trainings, 0 failures) plus 31 fold-reusing serve-mask arms, window 2012-2025, decision 2012-2020 / holdout 2021-2025, WS1 2.9*SE floor + BH FDR across the 21 measurable LOO rows. **Six of 21 clear the floor and `season_line_pg` (+0.03344 +/- 0.00189, 9/9, holdout +0.03436 5/5 CONFIRMED) is 48% of the +0.0698 CRPS the whole fitted set adds on top of the line -- 2.5% of a 2.7647 loss.** The trainer REFUSES a two-part fit without `inj_out`/`depth_rank`/`teammates_out`/`prior_snap_share`, so those four have a SERVE-TIME MASK row instead of a LOO row and are labelled as a different quantity, never mixed into the LOO table or its BH family. **Two DROP candidates: `inj_feed` alone -- retrained-without and served-without are BIT-IDENTICAL on all 14 seasons because the column is a CONSTANT (one distinct non-null value, 1, in every season of the 70,011-row population); and the five droppable usage columns `td_fd,td_ts,td_attempts,td_rush_yards,prior_route_share` as a JOINT selection of five (+0.00131 +/- 0.00147, 4/9, floor 0.00425; holdout +0.00472 4/5; lineup regret +0.010/+0.093, i.e. fractionally better without them).** Families: joint-minus-sum masking of +0.0218 (context), +0.0142 (avail), +0.0094 (form) -- and across the design the 20 non-floor columns sum to +0.0363 individually against +0.1029 jointly, a 2.8x redundancy. Knock-in from the 5-column floor ADMITs all four families 9/9 (form +0.0389, context +0.0281, avail +0.0270, usage +0.0227). **THE HEADLINE IS THE SERVE/TRAIN SPLIT:** eight columns FLIP SIGN between the tables (`t4_mean` LOO -0.0018 vs mask +0.2036 9/9) and the family ordering inverts -- usage is the least valuable family to remove from the design (+0.0013, DROP) and by far the most expensive to lose at serve (+0.3995), with `depth_rank`'s mask +0.5605 the largest number in the study, 5x what the entire non-floor design is worth as a fit. Decision layer re-orders again (level -0.60/lineup > avail -0.35 > context -0.18 > form -0.13 > usage +0.01); the whole 20-column apparatus beyond the floor is ~1.1 pts a lineup of the model's +8.6 over shipped `week()`. Controls: the full arm reproduces M2a's baseline on ALL 14 per-season CRPS to four decimals and on both lineup scenarios (cross-session, different driver); the trainer is byte-deterministic across sessions AND thread counts; `full_dup` (re-scored LAST) returns DEGENERATE with max |delta| 0.0e+0; and `--verify` asserts all 434 folds carry exactly their arm's feature list, learner, zero model and population contract. Engineering finding worth reusing: 26-way fold concurrency ran at 20-24 min/fold until each child was pinned to ONE OpenMP thread (sklearn defaults to one thread per core, so 26 x 32 = 832 threads on 32 cores) -- 706-835s after, ~10x the serial rate, and byte-identical output. Nothing shipped; `tools/train_weekly.py` and `src/weekly/**` untouched; read-only on a `VACUUM INTO` snapshot; new `scripts/weekly-contribution-ledger.mjs` + `test/weekly-contribution-ledger.test.ts`; typecheck clean, 1045 tests green, all four served weekly artifacts byte-identical. Reading: weekly FEATURE engineering is closed at this power (the floor is 0.07-0.5% of the loss on 9 decision seasons), but weekly FEED engineering -- keeping `depth_rank`, the snap/route shares and the injury designations alive and dated on the live week -- is worth 4-5x more than any column anyone could add, which is the same wall D19 and M2a/M2b hit from the other side.
  **M2c DONE 2026-09-16 -- the AVAILABILITY information gap is MEASURED, BOUNDED and closed as a routine; nothing shipped (`docs/availability-gap-2026-09-16.md`):** new read-only `scripts/availability-gap.mjs` classifies every zero-scoring START over 1,896 team-weeks (462233, 2018-2025) into Friday-knowable / game-day-inactive / played-and-scored-zero / DST, ours and the MANAGERS' side by side, behind a positive control on the instrument (**99.6%** of scoring players carry a PFR snap row -- class `inactive` is an ABSENCE, and a broken crosswalk manufactures them; fault-injected to 0 in the tests). **The headline zero rate is no longer the gap -- the composition is:** on the SERVED arm ours is **3.49% against the managers' 3.49%**, but we lose **2.01%** of starts to game-day inactives against their **1.40%**, while **68** of their zeros were men already designated Out/Doubtful on the Friday report that our rule refuses to start. **Class (a) in our own started set is ZERO in all 1,896 team-weeks** -- the availability path is connected, so the residue is information we never had, not information we dropped. **The recoverable bound is an ORACLE upper bound of +1.231 pts/team-week, season bootstrap [0.908, 1.625]** (floor arm +3.027) -- and **edges.md #11's 1.79 cannot be reproduced: both files it cites (`scripts/inseason-backtest-lineup-info.mjs`, `src/inseason/backtest/playProb.ts`) are ABSENT from the repo**; the served-vs-floor spread says the projector already took most of it. The workflow: a new write-once scorecard kind **`weekly_sunday`** (rows COPIED from the frozen `weekly` rows and zeroed for game-day OUTs, so the only variable is availability; `as_of` = the re-read moment; in `WHOLE_FIELD_KINDS` so its lineup column scores against Friday's), a **`sunday` routine** on `DEFAULT_ROUTINES` after `scorecard`, and `ff sunday-refresh`, whose **window is a REFUSAL evaluated BEFORE the network** -- two ET windows a Sunday (11:30-13:00 and 14:35-16:05, 90 min per wave), everything in America/New_York rather than machine-local. **Live control: the real run today REFUSED** ("2026-09-16 is not an NFL Sunday") and wrote nothing; the Sunday path was driven on a SCRATCH copy from a saved game-day fixture with two of our starters flipped Out -- the lineup moved them out (per-SLOT diff: the QB slot empties, the WR cascade pulls Harrison off the bench), the kind froze 530 rows with the swap in `meta`, a second call in the same window wrote **0**, the late window wrote its own series, and `ff scorecard` SCORES both -- proved, not assumed, by filling scratch actuals. `test/routines.test.ts`'s handler-map check was a hand-kept ENUMERATION mirror of `HANDLERS` and now PARSES it out of `src/ff.ts` with a control on the parse, fault-injected both ways. Nothing shipped; no served artifact touched; **the production store was not written at all** (backup `data/ff.db.bak-prem2c-2026-09-16`, integrity ok); ESPN read only through the public keyless scoreboard; backtest 39.5%/96% with the per-season line byte-for-byte.
  **M2i DONE 2026-09-16 -- the LEARNED marginal surrogate is the FOURTH V3 NULL, and the binding constraint is the LABEL, not the learner (`docs/marginal-surrogate-2026-09-16.md`):** an MLP (256,128,64, alpha 0.01) fitted on the SIMULATED roster marginal from 230 real replayed-draft states over ten training seasons (2013-2022, both bidders; 158 degenerate dropped, 4,320 rows) and scored on 266 held-out-season states (2023-2024 x 6 seeds x {v2,v3}, buys 0-11, 2025 refused by the script). Pre-registered H1 (rank corr >= 0.60 after six buys, after nine, and in the 37-60 band) **FAILED: learned 0.078 / -0.148 / 0.151** -- but the registered POSITIVE CONTROL decided it: the simulated marginal re-simulated on the SAME states at a second book seed agrees with ITSELF at only **0.452 / 0.238 / 0.251 (ceiling 0.336 over 71 usable pairs)**, so **H1 is unreachable there by any model at this trial count**, exactly the contingency the pre-registration names. **The trial count is not the lever:** a same-states probe gives rho 0.323 at 100 trials vs 0.345 at 300 (a third of the cost for 0.02 of rho), and a 900-trial arm (n=3 states, 1 usable pair) shows the live-row count for one state is not even monotone in trials (44/43 at 100, 5/6 at 300, 3/4 at 900). **153 of 266 test states are degenerate**, rising to 19 of 24 by the ninth buy -- late in a draft most of the board's true marginal really is under a dollar. The learned column also **does not beat the analytic one** where it matters (0.078 vs 0.445 after six buys; 0.312 vs 0.396 in the top band), and the analytic column re-measured IN THE SAME INVOCATION reads far better than Track G's cross-run -0.29/-0.51, which is why the pre-registration forbade the cross-run comparison. **STOP RULE FIRED: no backtest arm run, `FF_V3_MARGINAL` never wired into `strategyV3.ts`, no default moved, V2 untouched.** Controls: shuffled-label fault injection **0.002** over all states; walker-vs-scikit-learn golden to **1e-6** on the real `data/marginal-surrogate.candidate.json` (8/8 in `test/marginal-surrogate.test.ts`, including the injections that make the golden check and the permuted-feature check FAIL); flagless golden backtest **39.5%/96%** with the per-season line byte-for-byte. New read-only `scripts/marginal-surrogate-noise.mjs` and an `--only-buys` filter on the label harness; ~1,700 core-minutes of labelling in ~75 min of wall clock at 20-29 shard workers. Reading: Track G's ordering residual cannot be closed by fitting a better approximation of this quantity -- the supervision is not there; a different LABEL (variance-reduced, coarser, or defined on the draft outcome) is the only remaining door, and none is proposed here.

Execution order: WP1 + WP6 in parallel (disjoint files) -> WP2 -> WP3 -> WP4 + WP5 (disjoint) -> WP7.

**WP6 status (2026-09-16): DONE.** AGENTS.md/README.md/CLAUDE.md D0-D11 refs and the stale "still to be scaffolded" line fixed; README 35-tool/Not-yet-built/Shipped-levers/Layout-tree corrected; docs/validation.md sim-calibration rename noted; D24 valueKey/formatKey claim corrected; multi-league-refactor.md S-5/S-8/S-9 corrections added; multi-format-design.md Status note added.

## 5. Status at the end of the session (2026-09-16)

Commits, in order: bbd4e79 (review + docs + .gitignore), 3777546 (WP1), 72efc6b (WP4), 4b52583 (WP2),
37e96fd (WP5), 84a9f0d (WP3), 8edb34e (WP7), then the M1 screen + the admit-feature guard. Every wave
was gated on the same three facts, measured by the orchestrator independently of the executor: tsc
clean, the full suite green with the app running (508 -> 898 tests), and the golden line
39.5% / 96% byte-identical to the pre-change baseline. The ESPN board's values, ranks and tiers are
byte-identical to `data/ff.db.bak-prearchfix-2026-09-16`; the only board difference is the live
`ESPN_ADP` market column. The store is left with `active_league = 462233`.

**At target (section 3):** one resolver and a real LeagueContext; per-league config isolated;
`league_id` in every per-league PK with every reader filtered and every DELETE scoped; a format
resolver with the incumbent alias and no silent fallback; every per-format artifact resolved through
the league's format (the shared-NFL set classified individually); one slot-eligibility module; FAAB
per league; the Platform seam with an ESPN and a Yahoo adaptor; bridge guest resolution by host with
no fallback; the app switch per platform with a board stamp that refuses the wrong league; `--league`
on the verbs and an optional `league` on the copilot MCP tools; cpcv reads a per-format golden and
refuses a format without one. The Yahoo league runs end to end from its own artifact and config.

**Open, needing OWNER SIGN-OFF (each moves a live ESPN in-season number; charter rule 1):**
1. `simContext.ts` builds the streaming replacement level as `seasonPts / regWeeks` while every consumer
   compares it against `proj / 17` quantities -- the floor is high by 17/regWeeks (~1.31x under 13 weeks).
2. The handcuff horizon uses `NFL_WEEKS` (17) where the question is weeks left in the LEAGUE's season
   (ESPN ends week 16); `leagueSeasonWeeks(ctx)` exists, the default is not flipped.
3. `lineupMarginal.baselines()` builds its flex pool from `flex_ok` only, so a SUPERFLEX group does not
   raise QB replacement level there (values.ts `flexGroups` already does) -- a value-book change, so
   it belongs behind the arbiter.

**WP10 status (2026-09-16): DONE -- all three SIGNED OFF and APPLIED. Full before/after tables in
`docs/decisions.md` D25** (`D25.1` frame, `D25.2` horizon, `D25.3` superflex baselines).

- **(1) APPLIED.** `simContext.ts` divides by `NFL_WEEKS`; one frame in the in-season stack, recorded at
  `copilot.ts`'s `NFL_WEEKS` block. Arbiter `scripts/season-calibration.mjs` (D18's four arms) held a
  SECOND COPY of the same rule and was corrected with it behind a new `--replacement-frame nfl|reg`
  (default `nfl`; `reg` reproduces the pre-change run exactly -- the positive control that the flag is
  the lever). Pooled playoff Brier improves in **all eight** arm/week cells (week 8 D 0.1351 -> 0.1336;
  week 4 D 0.2007 -> 0.2004); paired on arm D week 8, -0.00155 +/- 0.00104 (6/8 seasons), i.e. better
  but inside noise. The PRESEASON arm is flat-to-fractionally-worse and that is the gate that had to be
  passed: playoff Brier 0.2294 -> 0.2297, paired **+0.00020 +/- 0.00106, t 0.19, 5/8** -- not worse
  beyond noise; title Brier (context only, D13) improves 0.0641 -> 0.0636. `copilot-crosscheck
  --schedule real` ALL CHECKS PASSED, all 15 lines byte-identical, shares 7.0000 / 1.0000. Live moves:
  our playoff odds 65.75 -> 66.45, `waivers` base 66.6 -> 67.1 with the recommended DROP changing from
  Michael Pittman Jr. to Isaiah Likely on 3 of 4 rows, `depth-risk` Breece Hall costPp **18.2 -> 21.75**
  (thin depth was being under-priced by ~3.5pp), `stream` unchanged.
- **(2) APPLIED.** `copilotActions.ts` uses `leagueSeasonWeeks(ctx)` (16 for 462233, 17 for 129048).
  Both in-season backtests are **byte-identical** before and after -- and that is STRUCTURAL, not a
  null: `backtest/handcuffSignal.ts` hardcodes `weeks: 1` and the promotion script never reaches the
  copilot, so neither arbiter CAN see this lever. Said plainly rather than quoted as evidence.
  **A dead arbiter was found and fixed first:** `scripts/inseason-backtest-handcuff.mjs` still picked
  its league by `ORDER BY last_synced_at DESC LIMIT 1` (an S-1 resolver left behind in `scripts/`),
  which today resolves to Yahoo 129048 -- a league with no `fact_roster_week` rows -- so it evaluated
  ZERO decisions and printed `0.000 (differed 0)` with a **0.0 positive control**. It now resolves
  through `resolveLeagueContext` (`--league`), threads the league into both scorers, and REFUSES on an
  empty decision set. Connected, it reports REALIZED +0.015 CI [-0.13, 0.15] over 37 differed decisions
  with a -36.6 pt positive control. Live: `handcuffs` per-week magnitudes x 17/16 = 1.0625, `expectedPts`
  unchanged on tier rows, basisNote now says "over 16 weeks", 64 of 66 rows in the same order.
- **(3) APPLIED.** `starterBaselines` fills by group via `splitTemplate`; `expectedWeekPoints` prices a
  flex slot against its OWN group cutoff. ESPN is **byte-identical** (0 differing keys vs the pre-change
  implementation on the live 529-row board at openFraction 1 / 0.5 / 0.25); Yahoo's QB baseline drops
  12.935 -> 10.594 pts/wk (deeper replacement, QB VOR rises) and a `SUPERFLEX` cutoff appears; the
  fault injection (delete the `SUPERFLEX` token) returns every key exactly to the old answer. Locked in
  `test/marginal-superflex.test.ts`, itself fault-injected (3 of 5 fail when the group fill is broken).
  **Which live verbs move: none today.** `starterBaselines` has one production consumer, `strategyV3.ts`,
  and V2 is the default bidder (`sim.ts:439`, verified by grep) -- so this lands ahead of a Yahoo/snake
  pre-draft path rather than changing a served number.
- **Gates.** `tsc` clean; `eslint` 0 errors / 48 warnings, **none in a WP10 file** (WP7 left 47; the
  extra one is in a concurrently-edited file); `npm test` 946 tests, 943 pass, 2 skip, **1 fail --
  `test/wp7-platform-sync-gate.test.ts:249`, WP11's**, asserting a `cpcv.mjs` refusal message its own
  comment says "WP11 moved" and which is not yet in the in-flight `scripts/cpcv.mjs`. Golden
  **39.5% / 96%**, per-season line matching the baseline on 24 of 25 seasons; **2017 reads 34% vs 33%** [RESOLVED: WP11 scorer summation order, see section 5]
  and that drift is NOT WP10's -- a 2016-2018 run with `lineupMarginal.ts` restored to git HEAD prints
  the identical `2017:34%`, and neither `simContext.ts` nor `copilot*.ts` is on the draft path. It
  belongs to the concurrently edited `src/draft/{values,backtest,rosBlend}.ts`.
- **NOT done.** The laminar flex fill now exists twice (`values.ts baselines()` and
  `lineupMarginal.starterBaselines`); neither `values.ts` nor `slots.ts` exports it as a primitive and
  both are other executors' files this pass, so the duplication is recorded rather than removed -- the
  fix is one exported `laminarFlexFill` in `slots.ts` with both call sites on it. `handcuffBoard` still
  uses one `weeks` for two things (spreading a SEASON projection into per-week points, and the length
  of the payoff horizon), which is exact in preseason and increasingly approximate at `--week W`; that
  is a separate, unapproved question. The calibration arbiter had to be pointed at a VACUUM snapshot
  (new `--db` flag) because a concurrent executor's mid-run store migration made it report
  `SKIPPED -- no rosters for week 8` for all eight seasons -- a substrate change that reads exactly
  like a data absence.

**Open, engineering (no sign-off needed, not started):**
- Snake `DraftModel` (design doc phase 5): the only route to a Yahoo pre-draft gate / golden.
- Yahoo weekly + streaming artifacts and a per-season BLIND fold set (`tools/train_*.py` runs; the
  format's `manifest.weekly.seasonLineBlind: false` says why the current season lines are lookahead).
- Yahoo started-lineup ingestion (a `raw_league_roster_week` equivalent) and scores on
  `raw_league_matchup`, so the D18 seed can run for Yahoo instead of refusing by name.
- A per-format forward board (`buildForwardBoard` writes the shared `feat_player_week*` tables).
- **DONE (WP12, 2026-09-16):** `tools/train_price.py`, `tools/train_faab.py`, and the seven one-off
  scripts (kdst-analysis, manager-stability, format-history, schedule-balance, stream-horizon,
  inseason-lineup-diagnose, face-validity) all now take `--league <id>` (default: `settings.active_league`,
  else most-recently-synced -- mirrors `activeLeagueId` in `src/db/db.ts`) and filter every league-keyed
  read. Caught live: `scripts/schedule-balance.mjs`'s unfiltered `raw_league_matchup` read was already
  mixing Yahoo 129048's 84 2026 games into ESPN 462233's 104 (188 total, "games per team: 27,13,14"
  instead of a clean 13) -- fixed by this change. `ingest-source` still has no `--league` passthrough
  (the league sources resolve the active league and refuse non-ESPN) -- out of WP12's scope.
- The Yahoo format's target still scores K/DST under the default rules and its board carries K/DST
  players although the league rosters neither (cosmetic; `waivers` can suggest a kicker).
- `YahooLeague.freeAgents` is unbuilt (the FA pool is the hand-built `fa-pool.json`); `discover` for
  Yahoo is unbuilt (the league row was created by hand); Return TD / Offensive Fumble Return TD are
  Yahoo scoring terms `ScoringRules` cannot express (carried in `rosterSettings`, do not move the key).
- eslint: 47 warnings (`no-useless-assignment`), 0 errors -- untouched.
- Operational: `app/engine/ff.cjs` is rebuilt (`npm run build:engine`) but an EXTERNAL Claude Code
  session's `ff-draft` MCP server keeps the process it started with -- restart it to see the new tools.

**Model improvement, first pass (M1, `docs/format-edge-screen-2026-09-16.md`):** the projection-layer
format-edge thesis is NOT supported -- 18 candidates screened under the Yahoo target and the same 18
under ESPN in one session, zero ADMITs, the ESPN arm reproducing the recorded frontier numbers to four
decimals, positive controls passing (the screen returns KEEP for `fftoday_proj` under both targets).
Two arms were DEGENERATE rather than null (`prior_cpoe` QB, `prior_ryoe` RB: below the trainer's
coverage floor on the decision seasons, so both arms were the same model and printed REJECT);
`scripts/admit-feature.mjs` now refuses a verdict on identical decision arms, fault-injected on that
exact candidate. The first honest accuracy figure for the Yahoo format is recorded (trained RMSE 71.3
/ pinball 15.7 pooled over 13 blind folds). Where the edge is, on the evidence: the VALUE and DECISION
layer (superflex is a Layer-2 effect -- QB 6/24 of top value on the 2026 Yahoo board vs 1/24 under
ESPN; item 3 above; the frontier doc's own reading), not the projector.

## WP11 -- the snake DraftModel and the Yahoo gate (2026-09-16)

**Closes:** "Snake `DraftModel` (design doc phase 5): the only route to a Yahoo pre-draft gate /
golden" and "the Yahoo format's board carries K/DST players although the league rosters neither", both
from the open lists above. `docs/multi-format-design.md` wall 2 is marked CLOSED with the full design.

**What landed.** `src/draft/draftModel.ts`: a `DraftModel` interface, `AuctionModel` (a wrapper over
the existing `draftField` call, argument for argument), `SnakeModel` (serpentine order, a
best-available room off a shared book with an independent per-bot view, and one hard legality rule --
a pick is legal only while the picks remaining cover every unfilled starting slot, which is
`starterReserve`'s semantics with picks in place of dollars). `runBacktest` takes a `DraftOptions`;
`ff backtest` resolves the model from `draftType` instead of calling `requireAuction`, and refuses by
name for a draft type with no model. `weekScore` and the waiver floor in `backtest.ts` now go through
`splitTemplate` -- they tested `slot === "FLEX"` / `s !== "BE"` against literals, so a Yahoo
`SUPERFLEX` slot scored zero for every bot lineup and each `IR` slot became a phantom starting
position. New: `--our-slot N`, `--snake-adp <format>`, `startablePositions`/`filterToStartable`
(values.ts). `scripts/cpcv.mjs --league 129048` now RUNS: it strips auction-only base flags for a
snake format, loudly, and stamps `draft_type` on the ledger row.

**Gates.** tsc clean (the two pre-existing unused-import errors in `src/league/yahoo.ts` and
`src/weekly/evaluate.ts` belong to concurrent executors); 946 tests, 943 pass / 2 skipped / 1 updated
(`wp7-platform-sync-gate`'s golden-refusal assertion, because the refusal message legitimately
changed -- the snake engine now exists, so "missing" means "nobody pinned a number" and the message
says how to pin one); 17 new tests across `draft-model` / `snake-legality` / `snake-kdst` /
`snake-face-validity` (18 with the connected-lever check). The incumbent golden line is unchanged at **39.5% / 96%**, per-season line
byte-identical, run before and after the seam.

**The Yahoo gate number: 99.18% playoffs / 39.82% titles** (`--full --no-lookahead --seasons
1999-2025 --n 150`), pinned as a CANDIDATE golden in `data/formats/sc-a845f67652fb/golden.json` with a
`provenance` block. **It is a regression tripwire, not an edge claim, and the PRIMARY axis is nearly
saturated** -- 95%-100% per season, because the field is 8-of-12 and because a snake converts the
room's projection error into ROSTER where an auction converts it into PRICE. Sensitivity on the one
unmeasured constant driving it (`marketSd`): 0.30 -> 40.0% titles / 99% playoffs, 0.15 -> 24.8% / 96%,
0.05 -> 13.4% / 80% -- while the per-bot view is nearly irrelevant (--bot-noise 0/0.20/0.40 ->
40.2%/40.0%/41.4%).

**The defect this wave found and fixed, which is more useful than the number.** The first measurement
read 99.77% / 45.69% and looked entirely plausible while the model drafted **18% of every roster as
dead weight**: the Yahoo pool carries the incumbent's IDP rows, a position with no slot floors at VOR
0, and the only thing ordering that tail was a RAW-POINTS tie-break -- so a 200-point linebacker beat
every sub-replacement receiver and rounds 12-17 filled with unstartable men (149 of 816 drafted
players). Every roster was legal, every face-validity check passed, and nothing failed. `vorBook` now
prices a position with no slot at exactly zero. It is a reminder that the checks answer the questions
they were asked: "what positions are actually ON these rosters?" was not one of them. A SECOND defect
of the same family followed: `--bot-noise` reaches the auction only through `market.idioSd`, which
only `--market ecr` populates, so the snake room ran with ZERO per-bot disagreement while the banner
printed `per-bot view 0.2` -- a disconnected lever, now on its own channel with a connected-lever test.

**The near-miss worth recording.** A literal reading of "exclude positions the league has no slot for"
also deletes the 24,579 IDP rows (LB/DB/DL) in the INCUMBENT's own history CSV -- they are drafted as
bench filler and their VOR is in `computeValues`'s denominator -- and the first post-seam golden run
came back **36.0% / 94%**. The tripwire caught it. The filter is scoped to the six priced positions;
"should the arbiter draft IDP bench filler at all?" is now an open, gated question with its number
attached (-3.5pp titles / -2pp playoffs to remove them).

**Still open after WP11.** No superflex ADP exists anywhere in the store (`raw_adp_history` is FFC
12-team one-QB `standard`/`ppr`/`half-ppr`; `ranking_history` is 1-QB FantasyPros ECR), so the
honest-arbiter `--market ecr` analogue can only be run on a 1-QB consensus and FLATTERS us; the store
holds no `raw_league_pick` for 129048, so the room is generic rather than this league's owners; the
format has no blind fold set, so `--projection artifact` cannot run for it; and
`scripts/lib/deps.mjs`'s arbiter fingerprint still hashes the ROOT `history-*.csv` regardless of
`--league`, so a Yahoo ledger row records the incumbent's data hashes (noted, not fixed -- that file
is outside WP11's ownership).

## WP8 -- the Yahoo format's MODEL track (2026-09-16, working tree, uncommitted)

**DONE.** The Yahoo superflex format now has the same weekly track the ESPN league ships (D16/D17/
D19/D23), and it is gated on its own measurement rather than on the incumbent's. Full write-up with
every number: `docs/multi-format-design.md`, "The Yahoo weekly track (WP8)".

- **Blind fold set**: 14 artifacts, `--holdout-season Y` for 2012-2025, into
  `data/formats/sc-a845f67652fb/fold-artifacts/` on the format projector's own recipe (gbm, depth 3,
  300 rounds). Blind proof is three facts, not one: each declares `holdoutSeason: Y` with `seasons`
  ending at Y-1; each loads through the CONSUMER's loader with its golden block re-checked to 1e-6;
  each serves Yahoo-SCALED projections (top QB 395-617 vs the ~300 a half-PPR artifact gives the same
  men). This also unblocks WP11's noted gap -- `--projection artifact` can now run for this format.
- **Weekly table rebuilt on blind lines** (`--weekly-only --weekly-seasons 2012-2026 --prune-weekly`).
  `manifest.weekly.seasonLineBlind` is now decided PER SEASON from each artifact's own header rather
  than from `existsSync(foldDir)` (a directory is not a line), with `blindSeasons`/`notBlindSeasons`
  beside it; it reads `true`. The lookahead it removed was large: mean |delta| in `season_line_pg`
  QB 1.589 (22.6%), RB 0.851 (21.7%), TE 0.707 (20.4%), WR 0.645 (15.6%), and the lines moved DOWN.
- **Weekly artifacts trained + consumer-golden-checked**: `weekly-artifact.json` (two-part, gbm, 27
  features, 70,266 population rows, `rowFilter: in_population`) and `weekly-artifact-lineonly.json`
  (the floor the serve table names at K).
- **Evaluated nested-by-season on the format DB, 2012-2025**, against the format's own roster template
  (`scenariosForSlots` -- QB/WR2/RB2/TE/FLEXx3/SUPERFLEX; the ESPN `SCENARIOS` constant stays pinned
  and is asserted by `test/weekly-scenarios.test.ts`). **GATE PASSED on all three clauses**: (a) CRPS
  3.5889 vs the shipped baseline's 4.5292, (b) coverage-given-positive 0.843 with every position
  inside, (c) zero share 0.240 vs 0.245. Per position the verdict is the ESPN one: QB/RB/WR/TE ship
  the form model, K/DST tie the floor in the third decimal and keep it -- so `WEEKLY_SERVE` needs no
  per-format variant. Decision metric (lineup regret, 72,900 paired rosters): **+15.11 pts/lineup at
  standard-15 (winShare 0.810), +18.92 at deep-18 (0.823)** -- large mostly because this template
  starts ten men including a superflex, which is a structural fact about the league, not a claim that
  this model is better than the ESPN one. Early/late halves agree (CRPS gain 0.89 / 0.92).
- **ROS blend K is per format now**: Yahoo K = **5**, ESPN K = **6**, both beating line-only and
  rate-only. `ros-blend.json` moved from the resolver's SHARED-NFL set into the per-format artifact
  table (K is fitted by minimising RMSE in POINTS on a format's own lines -- not a constant of
  football); the incumbent's path is unchanged and the flagless refit reproduces the shipped file
  byte-for-byte apart from `fittedAt`.
- **Serving live**: `ff copilot lineup --league 129048 --week 2` now says `every point total is from
  the weekly projector` (was `no weekly projector was supplied`), 163.2 projected against WP7's 150.4,
  SUPERFLEX filled by the second QB; `artifactByPos` names the FORMAT's files at QB/RB/WR/TE/K and
  `missing ["DST"]` by name. Two seams had to close for that to be a correct number: the weekly ROWS
  now follow the format (a Yahoo artifact on incumbent rows multiplies a superflex ratio by a half-PPR
  line -- F-4 one table down), and the format's live-season rows exist at all
  (`build-format-features.mjs --forward-only` runs the two forward builders against the format's own
  `features.db`, which is precisely the precondition `ff sync-actuals`'s refusal names).

**Gates.** `tsc` clean in every WP8 file (the tree carries two errors in other executors' in-flight
files, `src/league/yahoo.ts` and `src/data/leagueTransactions.ts`). eslint: 0 errors, no new warnings
(the four in `evaluate.ts` are the pre-existing `no-useless-assignment` ones, identical at HEAD).
`npm test`: every weekly/format test green (66/66 weekly, 10/10 format-resolve, 4/4 the new
`weekly-scenarios`); the full-suite run also showed 9 failures in `inseason-backtest-state` /
`weekly-population` caused by another executor's concurrent `raw_league_roster_week` schema + data
change (the fixture inserts 16 values into a 17-column table), and `weekly-population` passes when run
alone. Golden: **39.5% championships / 96% playoffs**, per-season line identical to the pinned
baseline in 24 of 25 seasons -- 2017 reads 34 where the baseline says 33, reproducibly (two runs,
identical line, so it is a tree change and not Monte-Carlo noise). [RESOLVED by the orchestrator's
bisect: WP11's `weekScore` summed the same starters in a different ORDER and floating-point addition is
not associative -- see section 5 and docs/validation.md; fixed, 2017 = 33 again.] That is not WP8: none of
this pass's modules is on the backtest's import graph (`backtest.ts` -> sim / values / slots /
draftModel / lineup / schedule; `sim.ts`'s only resolver use is `INCUMBENT_MODEL.path("variance")`,
which adding an artifact name cannot move), while `src/draft/{values,backtest,simContext}.ts` and the
new `draftModel.ts` are WP11's live, uncommitted value-layer rewrite. It needs WP11's own golden run
to attribute.

**Open, and each is one line in a file WP8 does not own:** `simContext.ts` still calls
`loadRosBlend()` (root K=6) where `loadRosBlendFor(model)` would give this format its fitted 5;
`ff evaluate-weekly` has no `--league` axis (the function takes `model`/`scenarios`/`flexOk`/`label`,
`src/ff.ts` does not pass them, so the evaluation ran from a scratch runner); `ff sync-actuals
--league <id>` should now call the forward builders instead of printing its refusal. On the gate: WP11
landed a CANDIDATE `golden.json` for this format while this pass ran, so it is no longer ungated
outright -- but nothing in the WEEKLY track is checked against it, and WP11's own file excludes the
`--projection artifact` arm "because this format does not have a blind per-season fold set", which
WP8 has now built; that arm is newly runnable and a re-pin is a deliberate act, not a side effect.
Nothing refreshes the format's live weekly rows when Yahoo actuals land.

## WP13 -- the last wiring package (2026-09-16)

**Closes the "Open, and each is one line in a file WP8 does not own" list above, WP9's accuracy gap,
and WP11's noted `deps.mjs` gap.** Five seams where the wrong answer RENDERED PERFECTLY; none of them
was failing, each was answering a different question under the same column heading.

1. **`ff evaluate-weekly --league <id>` (WP8).** The verb resolves the league's format and passes the
   four arguments `evaluateWeekly` has accepted since WP8: `dbPath = model.require("features-db")`,
   `model`, `scenarios = scenariosForSlots(cfg.slots, cfg.flex_ok)`, `flexOk`, plus a `label`. The
   season window is READ from the format's `manifest.weekly.blindSeasons` (2012-2025 for
   `sc-a845f67652fb`, 14 blind seasons) rather than retyped -- a season whose line was not fitted
   blind cannot be evaluated honestly. **The incumbent path is deliberately unchanged and not by
   accident of equality:** `scenarios`/`flexOk`/`label` stay OMITTED, because `scenariosForSlots` does
   NOT reproduce the pinned `SCENARIOS` (the stored ESPN config says RB1/WR1 where the pinned template
   says RB2/WR2 -- `test/weekly-scenarios.test.ts` asserts exactly that), and deriving it would
   silently re-measure every published weekly number on a different roster shape. New `--resolve-only`
   prints the resolved option object and runs nothing, which is how the control below was taken
   without training fourteen folds. **Controls.** Flagless: `seasons 2012-2025`, `trainSeasons
   2010-2025`, `rosters 300`, `features all`, no `dbPath`, no scenarios/flexOk/label, model
   `data` / `sc-f6143a8dfb13` / `data\weekly-artifact.json` -- i.e. argument for argument what it
   resolved before. `--league 129048`: `data\formats\sc-a845f67652fb\features.db`, 2012-2025 both,
   template `QB/WR/WR/RB/RB/TE/FLEX/FLEX/FLEX/SUPERFLEX`, the format's own weekly artifact. A real
   one-fold run (`--seasons 2025 --train-seasons 2012-2025 --rosters 60`) completes and names the
   format: pooled weekly CRPS 3.582 vs season_line 4.483, ships QB/WR/TE (a single fold, NOT a gate --
   WP8's 14-season verdict stands).
2. **`ff sync-actuals --league <id>` rebuilds the format's forward board (WP8).** WP7's refusal is
   replaced by the two builders `scripts/build-format-features.mjs --forward-only` runs --
   `buildForwardBoard` and `buildForwardWeeks`, IMPORTED, not shelled out -- against the format dir's
   own `features.db` with the format's actuals and projector. The incumbent branch is untouched; the
   one-slot `data/actuals-state.json` change gate stays the incumbent's (a second format sharing it
   would make each run look unchanged to the other), so a format rebuild is unconditional.
   **Control** (`--league 129048`): 1039 weekly rows to the format's `current-actuals.csv`, forward
   board 590 players x 18 weeks -> 10,620 rows (422 with actual pts), `feat_player_week_model` 10,620
   rows, 10,404 with a season line, week 1 played. `data/current-actuals.csv` md5
   `8a7095cb...f654` UNCHANGED; the main store's `feat_player_week` (297,463) and
   `feat_player_week_model` (187,728) unchanged by count AND by a checksum of every 2026 row. The
   decision-snapshot refresh after it is best-effort and REFUSED BY NAME ("board is built for league
   462233"), which is correct: the ESPN board was active.
3. **`--league` through `ingest-raw` and the routine planner (WP9).** `RawAsset.run` takes an options
   bag (`RawAssetRunOpts`) rather than a widened positional signature, so the eleven league-less feeds
   are untouched; the four league-shaped assets read `leagueId`. `league-rosters` and
   `league-transactions` now DISPATCH ON PLATFORM: ESPN calls exactly what it called before, anything
   else goes through `ingestPlatformRosterWeeks` / the new `ingestPlatformTransactions`, and a
   platform with no reader is refused by name having written nothing. `refresh-decisions`, `scorecard`
   and `sync-pending-trades` take `--league`; `sync-league` already forwarded every flag but `--tier`.
   `Routine.leagueScoped` is `true` for all four. **Controls.** `planRoutines` now lists
   `sync-actuals`/`scorecard`/`refresh-decisions` for BOTH leagues with `--league <id>` appended, and
   still skips Yahoo's `roster` by name ("no yahoo adaptor -- its step(s) `sync-league` are
   espn-only"). Live: `ff ingest-raw league-rosters --league 129048` -> "via the yahoo adaptor: weeks
   1, 207 rows (120 starters)"; `ff ingest-raw league-transactions --league 129048` -> "18
   transactions, 33 item rows, 10 with a FAB bid", both matching WP9's numbers.
4. **The Yahoo lineup facts are in Yahoo's currency (WP9's accuracy gap).** `buildRosterState` takes a
   `pointsDb`; `buildRosterStateInto` opens the format's `features.db` READ-ONLY for a league whose
   format resolves to a directory, and the incumbent keeps the shared table. The FREE-AGENT POOL reads
   the same handle -- a pool priced in one scoring system and the rosters it is compared against in
   another is the same defect one table over. **Control, `fact_lineup_week` 2026 week 1 vs Yahoo's own
   published totals:** team 11 **138.00 vs 138.00**; teams 1-10 agree within **0.08** (1/1000 of the
   total; the format table stores `pts` to one decimal). Team 12 reads 135.40 against 138.72 and the
   gap is DIAGNOSED, not waved past: Kenny Gainwell has TWO surrogate keys, and the roster resolver
   takes `12112` (`pts` NULL) while his 3.3 points sit on `1834`. That is an identity-layer duplicate,
   not a currency error, and it is unfixed (see below). Before this change every team was ~30% light
   (team 11 read 96.7). **ESPN is untouched and was not rebuilt:** `fact_lineup_week` 1896 rows /
   `f1a5ae574119934e`, `fact_roster_week` 24,367 / `895b06e28c37f695`, `fact_fa_pool_week` 64,865 /
   `7fcf555a62935694`, all three identical before and after over `(league_id, season, week, team_id,
   started_pts, optimal_pts)` and the roster/pool equivalents. Yahoo's pool went 323 -> 380 rows,
   which is the format table carrying rows the shared one does not.
5. **The arbiter fingerprint follows `resolveFormat` (WP11's noted gap).** `scripts/lib/deps.mjs`
   hashed `data/history-{points,weekly}.csv` as string literals, so every `cpcv --league 129048`
   ledger row recorded hashes of files that run never opened -- and would have read CURRENT while the
   Yahoo target moved underneath it. A league now resolves its format directory and hashes ITS target
   plus its projection artifact and fold-artifact directory. The resolution is SYNCHRONOUS and made
   against the same evidence `resolveFormat`'s preimage check uses (`scoring.json`'s declared rules vs
   the league's stored rules), because this file is loaded by plain-`node` scripts that cannot import
   TypeScript and both callers call it synchronously. **Controls.** Flagless `04efd89da036a121` at HEAD
   and `04efd89da036a121` after -- byte-identical, and `--league 462233` gives the SAME hash (an
   unmatched league reads the root's files, deliberately, or the first named-ESPN run would make the
   whole ledger read STALE). `--league 129048` gives `ab3d921db95c24c7`, carrying
   `file:data/formats/sc-a845f67652fb/history-{points,weekly}.csv`, that dir's
   `projection-artifact.json` and `fold-artifacts`, and `format:129048 = sc-a845f67652fb:scoring.json`,
   with the incumbent's two history keys ABSENT.

**Gates.** `tsc` clean. `npm test`: **955 tests, 953 pass, 2 skipped, 0 fail** (206 s, app running).
eslint 0 errors, **46 warnings, none in a WP13 line** (all `no-useless-assignment`/`no-explicit-any`
identical at HEAD). Golden, run with the league named explicitly:
`backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150` ->
**CHAMPIONSHIPS: 39.5% | playoffs: 96%**, per-season line byte-for-byte identical to this session's
pre-WP13 baseline:

```
  per season: 2000:28%  2001:31%  2002:44%  2003:47%  2004:32%  2005:29%  2006:49%  2007:19%  2008:47%  2009:55%  2010:44%  2011:62%  2012:47%  2013:41%  2014:29%  2015:38%  2016:29%  2017:33%  2018:41%  2019:36%  2020:43%  2021:35%  2022:54%  2023:33%  2024:40%
```

`npm run build:engine` rebuilt `app/engine/ff.cjs` (2.1mb). League round-trip 129048 -> 462233: stamps
`sc-a845f67652fb` then `sc-f6143a8dfb13` restored, `board-keys-diff.mjs` reports **ESPN_ADP as the
only differing key** against `ff.db.bak-prearchfix-2026-09-16` (322 of 529 rows, max 10.3 -- live
market drift, the same single-key story WP7 recorded). Store left at `active_league = 462233`.
Backup `data/ff.db.bak-prewp13-2026-09-16` (integrity ok) taken before the first write.

**Tests.** `test/wp13-wiring.test.ts` (6): the points handle, positive AND negative (no handle must
still read the shared table, or the test cannot tell "follows the handle" from "always reads the
second database"); the FA pool on the same handle; `leagueScoped` + the per-league plan + the
platform skip that survives it; a raw asset refusing an unknown platform having written nothing; the
transaction dispatcher naming ESPN's own reader; and the fingerprint, with the incumbent frozen and a
FAULT INJECTION (add one scoring term to the config and the format match must be lost).
FAULT-INJECTED for real: reverting `pts.prepare` to `db.prepare` in `rosterState.ts` fails the lineup
test and leaves the FA test green, which is the separation intended.
`test/wp5-slots-league.test.ts`'s I-7 routine assertion was INVERTED on purpose, with a comment saying
what changed and why: it asserted that a non-active league is REPORTED rather than run, which was the
honest answer while the verbs took no flag.

**Unfinished, with the reason.**
- **Kenny Gainwell has two surrogate keys**, which is the whole of team 12's 3.32-point gap. Both
  `stg_player`/identity resolution and `skResolve` are outside this package's file allowlist, and the
  fix is an identity-layer decision (which key is canonical, and what happens to the rows already
  written under the other), not a wiring one.
- **`ff scorecard --league <id>` is wired but was NOT exercised on the Yahoo league.** Running it
  writes `scorecard_prediction` rows, which are WRITE-ONCE, and this package's store-write contract is
  `129048` rows in `fact_*`/`raw_league_*` plus the format directory. A write-once table is exactly
  the kind of thing not to seed as a side effect of a wiring test; it needs its own run with sign-off.
- **`runScorecard` still reads its weekly ROWS from the main store** even for a format league (it
  resolves the format for ARTIFACTS, which WP3 did). `src/weekly/scorecard.ts` was league-arg-only in
  this package's scope. The forward-features rebuild inside `ff scorecard` does follow the format now.
- **`scripts/cpcv.mjs` calls `fingerprintDraftArbiter(ddb)` with no league**, so the per-format
  fingerprint is reached through a documented `--league` argv default in `deps.mjs` rather than the
  one-line `fingerprintDraftArbiter(ddb, LEAGUE)` that file should carry. `cpcv.mjs` is outside this
  package's allowlist; the argv default exists so the feature is CONNECTED rather than correct code
  nothing reaches, and it says so at the function.
- **`ingest-source` still has no `--league` passthrough** (unchanged from WP12), and
  `ingestPlatformRosterWeeks` ignores `--seasons`: it writes the SETTLED weeks of the current season,
  which is the only window a Yahoo team page can be read for safely (partial in-progress points are
  indistinguishable from final ones in the store).

## WP14 -- the minimal UI (2026-09-16)

**Owner direction:** *"update the UI. there's a lot of dead code/old modules that aren't used. UI
buttons don't work correctly. we probably don't need as many buttons in the new paradigm where we are
running it as a claude code agent cli/mcp"* -> *"go ahead with the minimal UI once the audit lands."*
The audit landed as `docs/ui-audit-2026-09-16.md` (755 lines, a verdict + evidence per control,
reached twice: by reading the chain and by driving the running renderer over CDP). This package
implements its section 5.4 proposal and appends a **Result** section to it.

**The decision that had to come first.** The audit's one unsettled finding (5.3) was that the in-app
Assistant had been removed in code, recorded NOWHERE, while README, `docs/mcp.md` and
`docs/architecture.md` all still described it as live -- and that the panel returned at its second
line. That is now **D26**: *the in-app Assistant is retired; Claude Code + MCP is the agent surface;
the app is the login/bridge/board cockpit.* All four documents were made to agree.

**What shipped.** Three pages -- **Board** (the dense read surface), **Browser** (the two logged-in
guests + the livebar, with the four ex-page-tabs demoted to a link row), **Status** (active league +
platform + scoring key + board stamp, lineage freshness, the in-app scheduler's last tick WITH
failures in red, both guests' current url and whether each is on its platform, the bridge port/pid,
the store path, and `claude mcp add ff-draft -- npx tsx <repo>/src/ff.ts mcp`). `app/renderer/app.js`
1,416 -> 780 lines, `app.css` 321 -> 168, `main.js` 735 -> 594, preload 36 APIs -> 15,
`ipcMain.handle` 31 -> 12, `data.js` (291 KB) and the vendored dagre (49 KB) deleted.

**Two defects fixed, both of which had been running silently.**
1. `src/weekly/scorecard.ts:696` -- the `stream` kind's INSERT bound no `fk`, so the scheduler's
   `scorecard --no-forward --no-odds` routine threw `RangeError: Missing named parameter "fk"` every
   15 minutes, into an app with no surface on which `ok:false` could appear. WP2's `format_key`
   migration fixed five of six call sites. `test/scorecard-stream-fk.test.ts` was written first and
   reproduced the exact RangeError; after the fix the live tick reads
   `ok   scorecard --no-forward --no-odds     0.5s` / `3/3 steps ok in 59.0s`, and Status shows
   `stream: 1 week frozen, 12 models` -- rows the broken insert could never write.
2. `/write-transaction` was the last bridge route resolving its guest by
   `getElementById("espnview")` -- the pattern the P-3 no-fallback fix converted its five siblings
   off on 2026-09-16. Now `guestWebContents({host:"espn.com"})` with a named 503. Not exercised live
   (it writes to a league).

Also applied: FIX 1 from the audit (nine `.catch(() => null)` handlers -> one `rpcOr()` returning
`{error}`, rendered), and a FOURTH broken control the audit did not find -- `.off` on a `<webview>`
had no CSS rule at all, so both guests were laid out simultaneously and the platform toggle only
changed which one the toolbar acted on. Fixed with an off-screen shift (never `display:none`, which
detaches the guest and drops its CDP target).

**A regression this package caused and the live pass caught**, recorded because it is the house
failure mode: deleting `data.js` deleted `window.LAST_YR`, the only setter of the prior-season column
KEY, so two columns were keyed on fields no row has and rendered BLANK. Nothing threw; an empty cell
reads as "no data for this player". Found only by clicking every sort header against the live app,
not by any test. `setLastYr(d.lastYr)` takes it from the engine payload now, locked both ways.

**The bridge contract is untouched**, which was the hard constraint: `data/app-bridge.json`, the five
routes, the host-keyed guest resolution and CDP 9223 all keep their shape.

- **Live click-through** (raw CDP on 9223, one instance asserted, console + exception capture): every
  surviving control clicked. **Zero console errors and zero exceptions** -- only the two pre-existing
  Electron security warnings (CSP, allowpopups) that the audit also recorded. Notably the three
  `ERR_ABORTED (-3)` unhandled rejections the audit captured on every probe are GONE (`platformGo`
  now catches). Board: pills ALL/RB/QB 529/144/59, search "mahomes" 1, Sleepers 152, **all 24 sort
  headers move and reverse from a clean Rank baseline** (including **Owner**, which the audit
  measured as `NO-REORDER`), 529 band cells with 135 correct blanks. Browser: the tab reveals without
  navigating (the audit's "every league switch lands on the Draft Room" is gone), the platform toggle
  shows/hides with neither guest reloading or losing its url, the Standings link drives the right
  guest to the right league, back/home/reload work. League switch both ways: `129048` ->
  `sc-a845f67652fb` / 505 rows / 207 owners, `462233` -> **`sc-f6143a8dfb13`** / 529 rows / 192
  owners, the ESPN guest untouched by the Yahoo switch (P-4 holds), the page unchanged. Status: no
  empty sections.
- **Positive controls.** `scripts/copilot-mcp-smoke.mjs` **PASSED** (39 tools, `TOOL_NAMES` assertion,
  a real `season_odds` call with its invariants OK). `bridgeFetch` of the ESPN league settings through
  the ESPN guest returned 9,126 bytes with `id=462233`, `name=seacaptaindate.com`,
  `scoringType=H2H_POINTS`; `bridgeReadFrame` on the YAHOO guest enumerated 34 frames and read 5,899
  bytes of the top frame. `scripts/webview-selftest.mjs` fails 1 of 8 -- **environmental, not
  WP14**, proven by a live probe rather than a git diff: the lobby page carries the text "Practice
  Draft" but exactly ONE `<button>` ELEMENT (`hsb.accessibility.skipContent`), so the selector has
  nothing to match; the other seven checks pass including the resolver's negative control, and
  `src/browser/webviewPage.ts` is not a WP14 file. (A CONCURRENT executor has since modified that
  script's import to WP1's `ensure-tsx` bootstrap -- not WP14's edit, and not the selector.)
- **Gates.** `tsc` clean. `npm test` **965 tests, 963 pass, 0 fail, 2 skip**. `npx eslint .` **0
  errors, 46 warnings** (WP13's baseline was 46; none in a WP14 line). `npm run build:engine` clean.
  Golden `backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150`:
  **`CHAMPIONSHIPS: 39.5%  (random 6.3%)  |  playoffs: 96%`**, with the per-season line
  BYTE-IDENTICAL to the baseline recorded at line 718 of this file (compared programmatically, not
  by eye). The scorecard fix touches `src/weekly/`, which the draft path never loads.
- **Tests.** Added `test/app-ipc-map.test.ts` (the audit's hand-built IPC map, now mechanical: six
  directions across the real bytes of main/preload/renderer, plus two fault injections) and
  `test/scorecard-stream-fk.test.ts`. Updated `test/stale-banner.test.ts` (the banner now says NO
  LIVE BOARD rather than SNAPSHOT DATA, because there is no snapshot to fall back to; it asserts
  data.js STAYS deleted), `test/board-stamp.test.ts` (one slice boundary), `test/model-page.test.ts`
  (two renderers instead of three; the ledger's engine-side test is untouched),
  `test/dag-derivation.test.ts` and `test/model-graph-derivation.test.ts` (the renderer pass-through
  halves went with the DAG canvases they protected; every ENGINE assertion, including the anti-rot
  guard, stays). No test was deleted to make anything pass.

**Not done, with the reason.** `tools/push_sheet.py` is left on disk -- its button and IPC are gone,
but it is a directly runnable script and both it and `tools/README.md` are outside this package's
ownership. The `webview-selftest` selector belongs to `scripts/` + `src/draft/`. And the app cannot
onboard a non-terminal user any more: that is D26's accepted constraint, with `app/README.md`
carrying the control-to-verb map.

## WP15 -- the independent QA pass's findings, fixed (2026-09-16)

An independent reviewer ran the wave end to end and filed eight discrepancies and five weak tests.
Four of the eight were mine to close (D-1, D-2, D-5, D-6) plus the weak tests; the rest are doc lines
in files another executor held this pass and are handed back in the report.

**D-1 -- `node scripts/cpcv.mjs` was DEAD, and the arbiter is the thing that died.** WP7 added an
unconditional `await import("../src/data/formatResolve.ts")`, so the invocation printed in the file's
own USAGE block and twice in `docs/edges.md` crashed at startup with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`
before parsing an argument. It now loads TypeScript through WP1's `scripts/lib/ensure-tsx.mjs`
one-hop re-exec. A grep for every other `.mjs` that statically imports a `.ts` module found 84; the
seven whose OWN header or the docs document a plain-`node` invocation were given the same bootstrap
(`cpcv`, `value-gates`, `scoring-history`, `webview-selftest`, `face-validity`, `lever-connected`,
`roster-strength`, plus `format-fetch` which was fixed for D-2 anyway). The other 77 document
`node --import tsx` and are correct as they stand; converting them would be churn with no defect
behind it. **New `--resolve-only`**, because there was no cheap way to exercise the gate wiring: every
other invocation starts two 150-trial backtests and APPENDS to `data/experiments.jsonl`, and the
reviewer accidentally began a real run by passing `--help` (also now handled, printing usage and
stopping). **Controls, all under plain `node`:** `node scripts/cpcv.mjs --resolve-only` ->
`no --league (THE INCUMBENT) -> scoring sc-f6143a8dfb13 ... golden 96% playoffs (+/-3pp) from
data\golden.json`; `--league 129048 --resolve-only` -> drops `--inflation` as auction-only, then
`scoring sc-a845f67652fb, format fk-3a298dfdeb32, draft snake; golden 99.2% ... from
data\formats\sc-a845f67652fb\golden.json`; `node --import tsx scripts/cpcv.mjs --league 462233
--resolve-only` still works (the import succeeds, nothing re-execs). `value-gates`,
`scoring-history`, `face-validity` and `roster-strength` were each run to completion under plain
`node`; `webview-selftest` needs the desktop app and was not run (same mechanism, one line).

**D-2 -- fourteen dead-arbiter resolvers, the D25.2 shape left in thirteen siblings.** Every one of
`scripts/inseason-backtest-{bench,drop,lineup,stream,trade,trade-package,waiver,waiver-value}.mjs`,
`faab-replay`, `faab-leakage` (its FAAB-budget read), `format-fetch`, `waiver-horizon`,
`weekly-espn-probe` and `winprob-backtest` picked its league with `ORDER BY last_synced_at DESC
LIMIT 1`. On this store that is YAHOO 129048 -- zero `fact_roster_week` rows -- so each scored an
EMPTY SET and printed a confident `0.000` beside a `0.0` positive control. All fourteen now resolve
through `resolveLeagueContext` (ACTIVE league by default, `--league <id>` to override), thread the
league into the readers that take one (`makeCeilingFn`, `makeSimExpectedScorer`), and the two
ESPN-only fetchers (`format-fetch`, `weekly-espn-probe`) additionally go through `requirePlatform`
so they cannot build ESPN URLs under a Yahoo id. **Every one of the eight arbiters now REFUSES an
empty decision set BY NAME with exit 3**, as `inseason-backtest-handcuff.mjs` does.

*Controls (`--seasons 2024-2024` where the script allows a window).* `--league 129048`: all eight
refuse by name, exit 3 (`bench`/`lineup` verified by exit code directly), as do `faab-replay`,
`waiver-horizon` and `winprob-backtest`. FLAGLESS vs `--league 462233`, headline for headline:
bench `REALIZED diff/decision 0.327 CI [0.33, 0.33] P(upside better) 100% (differed 5)`; drop
`protect {TE} -0.159 ... (differed 26)` and `QB 4 -6.45`; stream `QB 17.90/18.07/0.16 ... 196` and
`TE 7.91/7.25/-0.66 ... 196`; trade `our diff/decision 7.707 where-traded 7.84 ... (traded 180/182)`;
trade-package `1-for-1 (#10) 7.707 [7.71, 7.71] 100% 180 -0.87`; waiver `pool 89.9% ... room 6.81
ours 7.7`; waiver-value `add-best-FA REALIZED 2.685 ... (claimed 182 of 182)`; lineup `our lineup,
scored 86.04 / 90.5 / 90.95`. IDENTICAL in both columns -- flagless is the active ESPN league, which
is what it always should have been. **A pre-change flagless headline is deliberately NOT quoted: on
this store the pre-change flagless run resolved YAHOO and scored nothing, so "the same number as
before" is not available and its absence IS the finding.** The `--league 129048` refusal is exactly
what the old flagless run used to print as `0.000`.

**D-5 -- `--seasons 2024-2025` scoring only 2025.** Documented behaviour (the first season supplies
the book the draft is built from), not a bug, and now said out loud: `ff backtest --help` exists
(it used to fall through and start a full run) and its `--seasons` paragraph names the rule and
points the reader at the `per season:` line rather than the flag.

**D-6 -- `player_value_position` at 0 rows. ROOT CAUSE: not a disconnected producer.** Verified
read-only on the live store: `board`, `player_value` and `player_value_position` all hold 529 rows
for 2026 and share ONE `updated_at` to the millisecond (`2026-09-16T15:03:46.639Z`, stamped
`builtAt ...:46.651Z`) -- they are written in a single transaction in `assemble`, so a completed
build cannot produce a full board beside an empty value-position table. The ONLY branch that can is
`eligKnown === false`, i.e. `raw_espn_eligibility` holding no row for the board's season; that table
holds 1036 rows for 2026 with `fetched_at` 2026-09-10 and was not re-ingested at any point today, so
that branch is excluded for the 14:09:53Z snapshot as well. I could not reproduce the observed state
and will not invent a mechanism for it; the live round trip the reviewer asked for has since happened
twice (14:23:44Z and 15:03:46Z, both by the concurrent app executor) and repopulated 529 rows each
time. **What WAS a real defect is the silence**, and that is fixed: `assemble` now STATES the outcome
on every build -- `player_value_position: 529 rows for season 2026 (N players ESPN lists as
multi-eligible)`, or, on the empty branch, a named line saying eligibility was never ingested for that
season and that the position is therefore NOT MEASURED, with the ingest command. Both branches were
observed in the new test's output. `test/board-league-stamp.test.ts` gains a real A -> B -> A round
trip through `assemble` (network stubbed, report CSV redirected) asserting REPOPULATION: one
`player_value_position` row per board row, the same `updated_at` as the board, and the dual-eligible
man carrying `["RB","WR"]` from `player_eligibility` rather than his board position. **Fault
injection:** with the `upValPos.run` suppressed, the new test fails (`must have one row per board row
after a rebuild`) and the old clearing test still PASSES -- which is precisely the W-2 gap. `assemble`
and `switchActiveLeague` take an optional `reportPath` purely so a test can run a real rebuild
without overwriting the repo's `data/player-report.csv` (which the pre-existing clearing test was
doing silently on every `npm test`).

**Weak tests.** `test/league-isolation-readers.test.ts` gains the six readers the enumeration missed
-- `backtest/{waiver,lineup,winprobLineup,harness,streaming}.ts` and `weekly/population.ts` -- on the
same two-store differential, and each is asserted to have MEASURED something (A: 6 lineup and
win-prob team-weeks, 1 waiver-claim week, 6 streaming team-weeks, a non-zero harness decision count,
and a population membership that can only come from league A's own roster feed). Making them
non-trivial needed three fixture additions, each of which is a fact about the system worth recording:
the availability columns are added by the feature BUILDER not by `schema.sql`; the as-of roster feed
resolves through `player_identity`/`player_xref`, which are GLOBAL tables (so the fixture now has one
man rostered in BOTH leagues, as two real leagues do); and the win-probability backtest needs BOTH
sides of a matchup to have a lineup row. `scored`/`inPopulation` are deliberately excluded from the
differential with the reason stated -- `feat_player_week_model` has no league dimension, so its raw
counts move with the fixture, not with a leak. **Fault injection:** weakening `league_id=?` to
`(league_id=? OR 1=1)` in `backtest/lineup.ts`'s per-week read fails the file by name; weakening its
`SELECT DISTINCT week` read does NOT, and that is recorded in the header because it says exactly how
far the fixture reaches. `test/wp13-wiring.test.ts`'s name-keyed `/no yahoo adaptor/` is replaced by
the structural outcome: the expectation is DERIVED from `ROUTINES.roster.steps`, the plan is driven
through a recording runner, and zero calls may be recorded for the Yahoo league's ESPN-only steps --
with two positive controls (the ESPN league DOES run every roster step; the platform-neutral routine
runs for BOTH) so the recorder cannot pass by being empty. New `test/wp15-yahoo-golden-gate.test.ts`
closes W-4: a league whose config carries this format's own scoring rules (read from the directory's
`scoring.json`, never retyped) walks the same two calls `cpcv` makes and lands on 99.2 / 39.8 in
`data/formats/sc-a845f67652fb/golden.json`, asserts it is NOT the incumbent's 96.0, asserts the
CANDIDATE-GOLDEN provenance travels with the number, and carries a PERMANENT fault injection -- one
changed scoring rule must move the hash and be REFUSED by name rather than still arriving at this
golden.

**Gates.** `npx tsc --noEmit` clean. `npx eslint .` 0 errors, 46 warnings (16 `no-useless-assignment`,
30 `no-explicit-any`) -- unchanged. `npm test` 970 tests, 968 pass, 0 fail, 2 skipped, 219 s. The one
arbiter run, `backtest --league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150`:
**CHAMPIONSHIPS 39.5% | playoffs 96%**, per-season line byte-for-byte the pinned baseline.

**Not done, with the reason.** `scripts/webview-selftest.mjs`'s bootstrap is unverified (it needs the
desktop app, which another executor is driving). `scripts/waiver-horizon.mjs` prints `zeroed 0
dvp_mult coefficients ... DISCONNECTED` on a flagless run -- PRE-EXISTING and unrelated to the league
fix: `data/weekly-artifact.json` is a schema-2 gbm artifact with no linear `coef` block for the
experiment to zero, so that harness cannot express its own lever any more. It is a real dead
experiment and wants its own package. `src/inseason/backtest/trades.ts:68` calls `getConfig(db)` with
no league, so a trade backtest for a named league still reads the ACTIVE league's flex rules; that
file is outside this package's ownership. [Orchestrator, same day: fixed -- `getConfig(db, opts.leagueId)`.]

## 6. Status at the end of the second wave (2026-09-16, "close the gaps; the goal is an accurate edge")

Owner sign-off given for the three D25 corrections and for closing the open list; the in-app Assistant
retired (D26). Packages, in commit order after section 5: WP12 (trainer/script filters), WP9 (Yahoo
started lineups + applied points, real FA pool, discovery, FAB transactions), WP10 (D25), WP8 (Yahoo
model track: blind fold set, blind weekly table, gated weekly artifact, K per format), WP11 (DraftModel
seam + snake model + the Yahoo candidate golden, with the summation-order regression bisected and fixed),
WP13 (the handed-off verbs, Yahoo lineup facts in Yahoo's currency, per-league fingerprint), WP14 (the
minimal UI: three pages, 12 IPC handlers from 31, the renderer roughly halved, the invisible scorecard
routine failure fixed at its root), WP15 (the engine-QA findings: cpcv under plain node, the 14 dead
arbiter resolvers, pvp repopulation test, strengthened tests), plus the UI-QA fixes (the renderer now
follows an out-of-band `ff league-set-active` within the 60 s backstop poll; electronmon ignores
`app/engine/**` so a bundle rebuild cannot spawn a second instance).

Two INDEPENDENT QA passes ran against the intents, not the reports (engine-side 10 items, UI 8 items):
every intent held; every finding either fixed above or recorded here. The incumbent golden reproduced
byte-identical after every package; the ESPN board's values are byte-identical to the pre-session
backup (only the live `ESPN_ADP` column moves); the Yahoo league runs end to end from its own config,
its own artifacts, its own weekly model and its own seeded standings (12/12 teams matching Yahoo's page).

**Still open (recorded, not started):**
- Model: no superflex ADP archive (the honest-arbiter arm for Yahoo cannot run format-natively); no
  Yahoo draft history in the store (the snake room is a generic field, not this league's managers); the
  Yahoo golden is a CANDIDATE tripwire with a nearly saturated playoff axis (read the title column for
  direction); one duplicate surrogate key (Gainwell) explains the single Yahoo team whose lineup facts miss
  Yahoo's published total; `scripts/waiver-horizon.mjs` is a dead experiment (the gbm artifact has no
  linear coefficients to zero); `data/values.csv` (the auto-draft CSV seed, last regenerated Sep 8) no
  longer matches the board rebuilt Sep 15 -- `scripts/value-gates.mjs` fails on it and it PREDATES this
  session; regenerate it deliberately before any auction use.
- Engine: `ff scorecard --league 129048` is wired but unexercised (write-once rows; needs its own run);
  `runScorecard` reads weekly ROWS from the main store for a format league; `ingest-source` has no
  `--league`; `cpcv.mjs` calls the fingerprint without a league (reached via the argv default);
  `tools/push_sheet.py` is orphaned by the UI cut but directly runnable, left in place.
- UI: the Board's "Hide OUT" was removed rather than fixed (the board carries no availability column);
  `webview-selftest`'s Practice Draft check fails environmentally (ESPN moved the control off a button).
- The `ff-draft` MCP server of any EXTERNAL Claude Code session keeps the process it started with;
  restart it to see the new tools and the platform-dispatched sync.

## WP16a -- two pending decisions APPLIED: the level's own prior weight, and the rankings cadence (2026-09-16)

Owner sign-off: *"let's aim for quality, so even if it's not backwards compatible and we have to
rerun things, we should get towards a better edge."* Both changes went the charter way -- measure
before, change, measure after with the same invocations, present the delta, and only then leave it
in place. Full entries: `docs/decisions.md` **D28** and **D29**.

**D28 -- `LEVEL_PRIOR_WEEKS = 1`.** The played-weeks shrink on a player's season LEVEL no longer
borrows `rosBlend.K` (the rest-of-season MEAN blend's weight, ESPN 6 / Yahoo 5); it carries its own
named constant in `src/draft/season.ts`, passed by the ONE production call site
(`simContext.ts:470`) and by `season-calibration.mjs` arm D. On the same `VACUUM INTO` snapshot,
`--artifact-dir data/fold-artifacts-d16 --replacement-frame nfl`, 3000 trials, seed 7, 2018-2025:
preseason **0.2297 -> 0.2297** playoff and **0.0636 -> 0.0636** title (identical by construction at
k = 0), week 8 arm D **0.1336 -> 0.1297**, week 11 arm D **0.0867 -> 0.0850**. Arms A/B/C are
unchanged at both horizons, which is the check that the constant reached only the arm that carries
it. The 0.0001 against M2d's recorded week-11 0.0851 is the sweep grid's rounded factor (0.302 vs
the exact sqrt(1/11) = 0.301511) and was confirmed by re-running at 0.302. Rollback
`FF_SIM_LEVEL_PRIOR_WEEKS=6` reproduces all four before-arms byte-identically (A 0.2342 B 0.1455
C 0.1377 D 0.1336). `copilot-crosscheck --schedule real`: ALL CHECKS PASSED. Live: us 66.45% ->
68.40% playoffs, the field's top rising and its tail falling (the sharpening, visible), invariants
exact. Yahoo uses the same constant by construction; `ff copilot season-odds --league 129048`
REFUSES on the active-board stamp and the board was NOT switched.

**D29 -- the `rankings` routine is on the live schedule, and the retention fans out.**
`settings.scheduler` went from `["actuals","scorecard","decisions"]` to
`["rankings","actuals","scorecard","decisions"]` (interval 15 min unchanged), written through
`ff schedule`. Proved firing twice: `ff inseason-tick --routines rankings` -> 1/1 ok, 815 `wp`
rows, idempotent on the second run; and the RUNNING app's own timer at 21:18:38Z -> 4/4 ok with
`ingest-source weekly` ok. This closes D27's follow-up (a): `ingestWeekly` now appends every scrape
into each format store's own `ranking_history` as well, so `data/formats/sc-a845f67652fb/features.db`
went **67,991 -> 68,806** `wp` rows and its latest scrape 2024-12-27 -> 2026-09-16, making a Yahoo
weekly ECR screen possible later. The fan-out refuses (by name, printed) on an unverified directory
or a store with no archive table, and never creates one.

**Gates.** `npm run typecheck` clean; `npm test` run TWICE (the second after a last one-line
empty-string guard on the rollback env): **1045 tests, 0 fail** both times (1042 pass / 3 skipped,
then 1039 / 6 -- the extra skips are the uv/scikit-learn trainer tests timing out under three
concurrent executors, not this work);
`npx eslint` on every changed file adds no warning (the 8 in `src/data/advanced.ts` are pre-existing
and all above the edited region); the championship backtest run ONCE -> **39.5% / 96%** with the
per-season line byte-identical, per the standing rule that the draft path reads none of this.

**Not done, deliberately:** the `sunday` routine was NOT added to the schedule row (a different
decision, and adding it under cover of this one would be the silent side effect the charter bans);
the Yahoo board was NOT switched to take a Yahoo season-odds number; `K_u` is still one number
standing in for a per-player, per-position quantity, and weeks 2-3 and 12+ remain unsampled.

---

## WP17 STATUS -- the live usage-feed regression, diagnosed and (mostly) closed (2026-09-16)

**The finding it acts on.** M2h measured that seven served weekly columns were 100% NULL at the 2026
week-2 serve while prior seasons carried 78-93% at the same week, worth **-0.71 points per lineup per
week**. Diagnosed per column against row counts rather than by reading code: the raw feeds for 2026
were INGESTED (snap counts 1,492 rows, week 1; player-week 1,118 rows, week 1) and three separate
builders threw the values away.

* `prior_snap_share` -- `buildLiveWeekContextInto` wrote a literal NULL and DELETEd the live week's
  archive row. FIXED: carried forward by the same functions the historical builder uses.
* `td_fd` / `td_ts` / `td_attempts` / `td_rush_yards` -- `forwardBoard.ts` wrote all four as NULL, and
  `buildForwardInto` read them off the LAST PLAYED row, which carries "through w-2" and is therefore
  empty in week 2 by construction. BOTH FIXED.
* `prior_route_share` -- NOT FIXABLE. `pbp_participation_2026.csv` 404s upstream; the feed stops
  after 2025. The lineup caveat now names it (`assumptions.basisNote`: "DEGRADED -- ... prior_route_share").
* `t4_sd` -- structural (needs two played games); 0% at week 2 of every season, correctly.

**Result at the live week (decision population, 2026 wk2):** `prior_snap_share` 0% -> **80%** (band
77-80%), the four ratios 0% -> **77%** (band 87-88%, inside tolerance), `prior_route_share` still 0%
and reported DARK. The Yahoo store (`data/formats/sc-a845f67652fb`) via `--forward-only`: identical
shape, 0% -> 80% / 78%. `ff copilot lineup --league 462233` week 2 moved **91.7 -> 91.4** projected
points with the TE/FLEX assignment changing (Loveland <-> Likely) -- the order of magnitude the mask
measured.

**A second defect found while fixing it.** `buildLiveWeekContextInto` resolved its target week from
UTC, so after ~8pm ET the live week's availability block was written to the week AFTER the one the
lineup was being set for (measured: target week 3 at 21:51 local while the lineup was week 2). Now on
`localToday()`, the rule `currentWeek` already documents.

**Guards added**, both fault-injected in both directions: `assertUsageWired` refuses a silently empty
usage column when the feed has rows for a settled week, and `liveWeekCoverage` compares the live week
against the same week in prior seasons (`ok`/`below`/`dark`/`none`) -- printed by
`scripts/weekly-availability-coverage.mjs` and appended to the lineup caveat.

**Store safety.** `data/ff.db.bak-prewp17-2026-09-16` (integrity ok) taken first; seasons <= 2025 in
`feat_player_week_model`, `feat_player_week` and `feat_player_week_context` are byte-identical
before and after by sha256, in the main store AND the format store.

**Not done:** `prior_route_share` cannot be filled at all while nflverse does not publish the feed --
it degrades to the anchor and says so, which is the honest state, not a fix. The refresh rides the
`actuals` routine rather than a routine of its own, because `ingest-raw` / `build-live-context` are
not in the tick's `HANDLERS` map and `src/ff.ts` was owned by a concurrent executor.

## WP16b STATUS -- D27 APPLIED: the weekly expert consensus now SERVES (2026-09-17)

**Signed off on the same sentence as D28/D29** ("let's aim for quality, so even if it's not
backwards compatible and we have to rerun things, we should get towards a better edge"), which is
what authorised the two downstream breakages below rather than working around them.

`data/weekly-artifact.json` 25 features -> **27** (`+ecr_wk_rank`, `+ecr_wk_sd`), md5
`a3871f4c...` -> `89e133ec...`. `WEEKLY_SERVE` did not move: it already named that file at
QB/RB/WR/TE. Rollback is `data/weekly-artifact.pre-d27-2026-09-16.json`, and the copy-back was
verified on a SCRATCH copy -- md5 returns to `a3871f4c...` and the consumer's loader reproduces all
six golden rows at 25 features, with the live file untouched.

**Four code changes, each because the promotion exposed something the old shape could not say:**

1. **The stamp is no longer the filename.** A new model in the SAME file reads identically to the old
   one if the record only carries the name, so a step change in a write-once series would be
   unexplainable. Each `weekly` scorecard row now carries the serving artifact's own `fittedAt` and
   feature count, read off the file that produced it, and `WEEKLY_SERVE_SWITCHED_ON` moves when the
   SERVE changes (mapping *or* artifact), not only when the table does. `runScorecard` also notes, at
   snapshot time and derived from the served artifact's own feature list, that from the promotion week
   the `weekly` kind IS the consensus model -- so the `weekly_ecr_candidate` series converging with it
   is legible rather than alarming. Both properties fault-injected in
   `test/weekly-serve-switch.test.ts` (5/5; reducing the stamp, and `INSERT OR IGNORE` ->
   `INSERT OR REPLACE`, each turn exactly one test red).
2. **`ff evaluate-weekly`'s flagless `--features` is the served artifact's own list**, not the literal
   `all` -- a MOVING set that grows with every DECLARED candidate and had the canonical run fitting
   29 columns against a 25-column serve, two of them previously rejected. Verified: a flagless run
   reports `features` identical to `featuresUsed`, the 27 the artifact fits.
3. **`scripts/inseason-backtest-lineup.mjs --artifact <path>`** -- a candidate can now be scored
   against real managers without being promoted first. It reaches the floor/challenger arms only; the
   `served` arm REFUSES it by name, because that arm is a per-position TABLE and one file applied to
   six positions under the name "served" is a number about a mapping nobody has. (The first version
   applied it to both file arms and printed the identical 89.07 twice -- caught, fixed.) The
   arm-summary tail is also now derived from the table by file, replacing enumeration that had gone
   stale and was printing "QB/RB/WR/TE/K/DST come from the floor", wrong about five of six.
4. `src/inseason/backtest/context.ts` `loadModel(name, artifactPath?)` carries the override and the
   refusal.

**The manager backtest, both arms from ONE script version** (league 462233, 1,896 team-weeks,
2018-2025; manager 89.64, hindsight 102.12): challenger **89.07 -> 89.32**, served **89.30 -> 89.55**
(gain vs manager -0.34 -> **-0.09**; beats own manager 47.9% -> 48.6%; median 49.0% -> 49.2%). The
eight-season bootstrap CIs overlap almost entirely, so this is a consistent nudge, not a measured win;
P37 still FAILS. The decision rested on the CRPS screen, not this table.

**Two things the promotion legitimately broke, both fixed rather than suppressed:**

- `test/weekly-contribution-ledger.test.ts` pinned M2g's `SHIPPED` to the served artifact and went
  red -- the pin working. The driver moved to 27 with a new `ecr` family; the published ledger was
  measured on the 25 and now says so in a banner. Re-running it is an open follow-up.
- `test/weekly-lineup-seam.test.ts` went red on "a QUESTIONABLE player was benched", and it was a
  MERIT change, not the availability rule: on the synthetic fully-imputed fixture the promoted model
  projects a 5.0/g receiver at 17.6 and displaces the 14.1/g man the test names -- the D27 write-up's
  own finding about imputed rows, one layer out. The assertion is now PAIRED (same roster, same
  projections, flag vs no flag), which cannot be confused by merit and still catches a status acting
  as a benching rule.

**YAHOO 129048: NOT promoted, and the reason changed.** Section 14.5's two blockers are closed -- the
format store's `ranking_history` carries 2026 (815 `wp` rows, via D29's fan-out) and its weekly table
was rebuilt on blind lines with both columns (168,270 rows; the `prior_pts[Y] == pts[Y-1]` control
503/503 and the not-the-half-PPR-copy control both pass; coverage tracks the root store). The NEW
blocker is a baseline question: the format's shipped weekly artifact was fitted `--features all`, so
its 27 columns include `rz_share_td` and `prior_vol_cv`, the two candidates the ESPN track REJECTED.
A candidate built from the ESPN served list plus the consensus pair differs from it by FOUR columns,
so that contrast would credit the consensus with two unrelated removals. That confounded file has
been moved out of the format directory, because `ff scorecard --league 129048` resolves
`weekly-artifact.candidate-ecr.json` from there and would have frozen a permanently mislabelled
candidate series from it. Deciding the Yahoo baseline is the prerequisite; the screen itself is
2 arms x 14 folds x ~4.7 min.

> **CLOSED 2026-09-17 by D31 (WP18), and the answer was to stop asking which four columns.** The
> baseline question dissolves once the format is held to the SAME design the ESPN serve carries
> (26 columns after D30), because then there is no bespoke Yahoo feature list to decide -- the list is
> read off the served file's bytes, which is the rule WP16b already imposed on
> `ff evaluate-weekly`. `scripts/weekly-format-design-screen.mjs` ran exactly the 2 arms x 14 folds
> this paragraph scoped, on the format's own `features.db`, scored through
> `ff evaluate-weekly --league 129048` so the decision metric uses that league's superflex template.
> The D30 design beats the confounded incumbent by **+0.02798 pooled CRPS over 14 seasons (13/14,
> clears its 0.02158 floor)** and **+0.04964 on the 2021-2025 holdout (5/5, floor 0.04057)**, passes
> all three gate clauses, and gains **+0.63 / +0.58 points a lineup**. It is promoted into the format
> directory; the confounded file is the rollback copy `weekly-artifact.pre-d31-2026-09-17.json` and is
> off the serving path. `ff copilot lineup --league 129048` still REFUSES on the active-board stamp
> (recorded, not worked around -- the active league was not switched); what is asserted is that
> `evaluate-weekly --league 129048 --resolve-only` names the re-pinned file. One real gap surfaced and
> is NOT fixed: `weeklyPopulationProblem` compares a declared population hash against
> `dataPath("ff.db")` only, so a FORMAT artifact's staleness is unchecked by it -- which is how this
> file came to be stale in two ways at once (an accidental design and a population the store no longer
> signs). Numbers, controls and the population-drift diagnosis: D31 in `docs/decisions.md`.

**Gates.** `npm run typecheck` clean. `npx eslint .` 0 errors, 46 warnings -- the same 46 M2a and
M2b recorded, none in a file touched here. `npm test` **1058 tests, 1056 pass, 0 fail, 2 skipped**
(both skips pre-existing and unrelated: "a curve-only projection is EXACTLY the base", skipped
because the shipped artifact is trained). Championship backtest
`--league 462233 --full --no-lookahead --inflation --seasons 1999-2024 --n 150`: **39.5%
championships / 96% playoffs**, and the per-season line reproduces the recorded run BYTE-FOR-BYTE --
the control that says nothing here reached the draft path.
