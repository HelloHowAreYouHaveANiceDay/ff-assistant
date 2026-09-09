# Draft-day runbook

The exact steps to run the agent for the REAL league draft (462233, seacaptaindate.com, 16-team
$200 auction; **half-PPR** -- the synced ESPN settings say `ppr: 0.5`). All commands from
`H:/working/ff-assistant`. The agent bids from the SQLite `player_value` table; you co-pilot from
`data/cheatsheet.md`. Rebuild both from ONE `ff refresh` so every surface agrees (see step 2).

## The evening before

1. **App up + logged in** (only human step): `cd app && npm start`, then log into ESPN in the app
   window. The login persists across restarts (`persist:espn` partition), so this is once per machine.
   **Use `--app` on every draft verb** -- that drives the app's own embedded browser and is the path
   all 10 validation mock drafts ran through. (The older bro path, `bro session start espn` with no
   `--app` flag, still works and remains the fallback; plain `--port 9223` does NOT -- Playwright
   cannot see the Electron webview and hands the draft verbs the app's UI window instead.)
2. **Rebuild projections + values fresh** (the #1 edge is an independent, current projection).
   The CANONICAL sequence is all-TypeScript and must be run as ONE build, in this order:
   ```
   npm run ff -- refresh       # ingest -> project -> assemble (writes data/points.csv AND player_value)
   npm run ff -- values        # -> data/values.csv   (the offline mirror: cheatsheet/sim/tests)
   npm run ff -- cheatsheet    # -> data/cheatsheet.md (your co-pilot sheet, same build)
   node scripts/value-gates.mjs   # sanity-assert the book; MUST print ALL GATES PASS
   node scripts/scoring-history.mjs   # MUST print ALL MATCH (needs the desktop app open)
   ```
   `scoring-history.mjs` asks ESPN directly what format this league will actually run -- teams,
   budget, roster slots, reception points -- and diffs it against the synced config the values were
   computed from. Both scripts exit non-zero on failure, so they are safe to chain. A slot or
   team-count mismatch invalidates the whole value curve (the FLEX count is what the weighted
   baseline allocates), so fix it BEFORE drafting rather than discovering it live.
   `tools/build_projections.py` is the LEGACY Python pipeline -- it is not part of this sequence
   and running it will fork the curve. Do not mix them.

   Verify by the gates, never by a success line: `value-gates.mjs` checks points.csv >= 450 rows
   (a partial nflverse fetch shrinks it silently), the positional book totals (TE $380-470, WR
   >= $1,050, top TE <= $75 -- a TE book near $800 means the FLEX-baseline fix regressed), and
   that values.csv's top-12 matches `player_value`'s.

   Without a value table the agent uses ESPN's on-screen values (legal, competitive, but no edge).
2b. **Refresh the NEWS aggregator and read it** (general league-neutral feed, then tailored to you):
   ```
   uv run --with nflreadpy --with polars --with feedparser --with requests tools/build_player_news.py  # -> data/player-news.csv
   npm run ff -- news                                                 # your draftable players with news
   ```
   Layer 1 (`build_player_news.py`) aggregates a GENERAL per-player feed -- nflverse injuries +
   depth-chart role + live RSS headlines (ESPN/Yahoo/CBS/PFT/RotoWire/Yardbarker) + Sleeper trending
   adds/drops, no league assumptions. Layer 2 (`ff news`)
   tailors it to YOUR value table: AVOID (OUT) / WATCH (Questionable) / BURIED (depth) flags plus the
   live headlines for players you'd draft. Read-only -- the bidder does NOT auto-apply it yet; use it
   to set `--avoids` or to bid with your eyes open. (`--no-headlines` for just the flags.)
3. **Confirm the config on the trustworthy harness** (championship rate, not season points):
   ```
   npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150
   ```
   Expect **~33%** championships / ~94% playoffs. A very different number means an input drifted --
   find it before drafting. Shipped levers (2026-09-05): **aggr 0.7, benchDiscount 0.25,
   starterReserve 4, maxShare 0.25, premium 2**, all positional multipliers 1.0, inflation ON.
   `node scripts/read-config.mjs` prints what the engine will ACTUALLY use (stored config wins over
   code defaults). `ff sim` is a season-points proxy only -- never pick the config from it.
4. **Generate the cheat sheet:** `npm run ff -- cheatsheet` -> `data/cheatsheet.md`. Keep it open.
4b. **Full draft board (Google-Sheets table):**
   ```
   uv run --with nflreadpy --with polars --with requests tools/build_report.py   # -> data/player-report.csv + .tsv
   ```
   One exhaustive row per player (~28 cols): OUR value/rank + proj pts + team/bye + bio (age, exp,
   ht/wt, 40yd) + per-source rankings to compare (Us/ECR/ESPN positional, ECR + best/worst,
   ESPN_Rank, ESPN_ADP, Rostered%, Sleeper buzz) + last-year pts/games + depth + latest-news (linked).
   Paste `data/player-report.tsv` into A1, or File > Import the `.csv`.
   **Live Google Sheet in ONE command** (rebuilds news+report, then pushes data+formatting+news links):
   ```
   uv run python tools/push_sheet.py --spreadsheet <id-or-url>        # refresh an existing sheet
   uv run python tools/push_sheet.py                                  # create a new sheet, prints URL
   ```
   Add `--no-rebuild` to push the current CSV without refetching. Uses bim-cli's google driver
   (`bim google login` once if auth lapses).
4c. **Interactive board (the desktop app)** -- the live, league-synced Board page in Fantasy
   Mission Control: `cd app && npm start` (dev) or run the installed app.
   ```
   cd app && npm run build:engine && npm start
   ```
   Search, position filter, click-to-sort, tier coloring, green vsECR sleeper highlights, injury/
   durability/buzz badges, live ownership, and an always-present Assistant. (The old standalone
   `tools/build_ui.py` HTML board was superseded by this app.)

## What the cheat sheet gives you (the human copilot view)

- **Tiers by position** -- tier BREAKS are the decision points: pay up to stay in a tier, wait once
  a tier empties (the next tier is a cliff cheaper).
- **Budget plan** -- 2-3 studs (~$120 on the top 3), ~$40 for mid-value, >=$1/slot for depth. The
  room is stars-and-scrubs (61% of picks $1-5): stay disciplined, let bidding wars pass.
- **Nomination drain plan** -- nominate a top QB/TE early to bleed the known payers (Maria Jose/
  Nick/Eli on QB; McDermott/Ari on TE). Human-only edge (rational bots don't tilt), so it's a live
  read, not something the agent auto-does. QB/TE go cheap once the payers are spent -- wait them out.

## When the draft room opens

5. **Enter the real room:** `npm run ff -- enter-draft --app` (expect `IN THE DRAFT ROOM ...leagueId=462233`).
   For a rehearsal use `npm run ff -- launch-practice --app` instead. Do NOT run `enter-draft`
   before the room opens -- a duplicate draft connection kicks your seat.
6. **Sanity-check the reads** against the real settings:
   ```
   npm run ff -- roster --app       # slot layout matches the real league (incl. any extra slots)
   npm run ff -- read-block --app   # if a player is up: name/pos/offer/myMax/canBid look right
   npm run ff -- board              # available players + values (reads the store, no browser)
   ```

## Run the draft

7. **Full-auto:** `npm run ff -- auto-draft --app` -- no `--csv`, and check the startup line.
   A single-instance lock prevents a second agent sharing your seat; if it refuses to start it prints
   the exact `taskkill` command for the stale one.
   - **Confirm `[auto-draft] value source:` reads `sqlite:player_value(...)` before the first bid**
     (`ff.ts` prints it at startup, with the row count). That table is the freshest surface,
     written by `ff refresh`.
   - `--csv data/values.csv` is a FALLBACK, not an override: the CSV is read only when the DB
     lookup returned zero rows (`ff.ts`: `if (Object.keys(values).length === 0 && csv)`). So
     passing it cannot displace a healthy `player_value` -- but it also does not protect you, and
     it makes the startup line ambiguous. Leave it off; read the value-source line instead.
     If that line says `csv:` or `espn`, the DB table is empty -- STOP and re-run step 2.
   - Fills a full legal roster in budget; bids our values with budget discipline; **live inflation
     ON** (reprices as money/talent leave, +~2 champ pts). The bid log shows `infl=` and `[$ left,
     open N]`. It runs to a full roster (defaults to 1600 rounds and a draft-over/stall guard) --
     the last bench slots fill in the cheap late phase; that is normal.
   - A per-draft log lands at `data/draft-log-*.json` (every pick, remaining $, global +
     per-position inflation) for review.

## Toggles (defaults are the backtested winners -- change only with reason)

- `--no-inflation` -- disable live inflation repricing (default ON, +~2 pts).
- **Every lever has a CLI flag, derived from `LEVER_SPECS`** (`src/draft/levers.ts`) -- there is no
  hand-maintained flag list to fall out of sync, so a lever added there is measurable by the backtest
  immediately. Current set: `--tier-break --max-kdst --starter-reserve --bench-reserve --max-share
  --aggr --premium --sleeper-threshold --bench-discount --mult-qb --mult-rb --mult-wr --mult-te`.
  Shipped defaults are **aggr 0.7 / starterReserve 4 / maxShare 0.25 / premium 2 / benchDiscount
  0.25**, multipliers 1.0 (higher reserve = more balanced/less concentration). These are the
  backtested winners; `node scripts/read-config.mjs` prints what the engine will ACTUALLY use.
- `--lever-off <key>` -- set one lever to its declared no-op value. Not every lever has one:
  `tierBreak`, `maxKDst`, `maxShare` and `sleeperThreshold` always do something, so they declare none
  and the flag refuses them rather than writing an illegal value.
- An out-of-range lever value is **clamped loudly** (`NOTE: --aggr 9 is outside its allowed range;
  clamped to 2`), so a sweep can never quietly report a number for a config that never ran.
- `--stall-min N` -- stop after N min of no new league picks (default 10; WARN at ~3 min).
- **`FF_STRATEGY=v3` selects the DERIVED bidder instead of the shipped one, and you almost certainly
  do not want it on draft day.** V3 (`src/draft/strategyV3.ts`) replaces the five hand-tuned levers
  with three computed terms -- a roster-aware marginal, a price from inverting the budget path, and a
  winner's-curse shading derived from dispersion and the number of live bidders. It is fully wired,
  connected in both directions (`node --import tsx scripts/v3-connected.mjs`) and backtestable, and
  the arbiter rejected it twice. Phase 3: **53.4% playoffs against V2's 88.9% over thirteen seasons,
  worse in twelve of twelve**. Track A (2026-09-09) fixed the two defects that failure named -- the
  marginal now prices a starting slot against POSITIONAL REPLACEMENT rather than the waiver wire, and
  the shading uses only the PRIVATE part of our uncertainty -- and the answer did not change:
  **59.7% playoffs against V2's 88.9%, -29.17pp paired, still worse in twelve of twelve**
  (docs/validation.md, Track A). It exists so the idea can be picked up again, not so it can be used;
  what is left to fix is the analytic surrogate itself, not its inputs.
  Four sensitivity arms: `FF_V3_SHADE=off` (no shading at all), `FF_V3_OURSD=full` (our whole spread,
  the pre-2026-09-09 double-count), `FF_V3_OURSD=0` (market spread only, which in this harness is
  what the shipped private component already computes), and `FF_V3_BASELINE=off` (the waiver-floor
  marginal, i.e. the pre-2026-09-09 value term).
- REJECTED by backtest, off by default, don't enable to "win": `--pos-inflation`, `--drain-nom`,
  `--waivers` (all measured neutral-to-negative -- see docs/edges.md). `--scarcity` was removed from
  `auto-draft` entirely (rejected + its live wiring was wrong); it survives only in `backtest`.

## Watch + override

- Keep the bro browser window VISIBLE. You see every bid.
- **Take a player yourself:** just bid above the agent's cap on it. The agent never bids past OUR
  value for a player, so once you push a player above its cap it stops contesting that player and
  moves on. (It does not detect "you" specifically -- it simply won't overpay its own value; earlier
  runbook text said it "yields when not the high bidder," which was backwards.)
- **Pause it (Step 9):** create an empty `data/PAUSE` file -- the agent keeps READING the room but
  places no bids or nominations and logs `PAUSED`; delete the file to resume (logs `RESUMED`).
- **Hard stop:** Ctrl-C the `auto-draft` process. Re-run `auto-draft` to resume; ESPN autopick covers
  gaps while it is down. (If your seat's ESPN auto-draft is ON, it will also fill during a PAUSE --
  turn it OFF in the draft room if you want the PAUSE to hand the wheel fully to you.)

## If it disconnects / errors mid-draft

- ESPN allows ONE draft connection -- do NOT open a second draft tab. If `auto-draft` exits mid-
  draft, just re-run it: it re-attaches, reads live state, and resumes. ESPN autopick covers your
  team in the gap. Never close the last browser tab (that quits Chrome and ends the bro session).

## Caveats to watch live

- `enter-draft`/`nominate()` success paths are verified up to what a mock allows -- watch the first
  nomination turn (does the agent nominate, or does ESPN auto-nominate?).
- If the real roster has slots we haven't seen (IDP/OP/IR), confirm `roster` shows them and the
  agent isn't skipping a needed position.

## What's validated vs not (trust the right things)

- **Validated + shipped (2026-09-05):** independent+current values; **bid shading `aggr` 0.7** (the
  winner's-curse correction, the largest single lever, ~+10pp); `benchDiscount` 0.25 (+4.4pp); live
  inflation ON, clamped [0.8,1.4] (+4.2pp); `starterReserve` 4 / `maxShare` 0.25; `premium` 2; all
  positional multipliers 1.0. **~33% championships / 94% playoffs** on 25 scored seasons
  (1999-2024), ~5x random, and it replicates on a 1999-2013 holdout no tuning ever saw.
  docs/validation.md. (The flagless arbiter reads 38.1% / 96% since Phase 2c rebuilt the bot field;
  the posture is the same one.)
- **Measured FLAT under the honest arbiter (2026-09-09, Phase 3), and it changes what is worth
  fiddling with on the day:** `starterReserve` 4 vs 0 produces BYTE-IDENTICAL trials -- the soft
  reserve never binds at `aggr 0.7` -- and `premium` 2 vs 0 and `maxShare` 0.25 vs 0.50 are both
  inside the noise on five seasons. `benchDiscount` is the one still doing work (-5.6pp when turned
  off). Nothing was changed on the strength of it: five seasons cannot adjudicate a lever measured on
  25. But if you are tempted to nudge the reserve mid-draft, it is not connected.

### The full lever set (what `node scripts/read-config.mjs` should print)

`aggr 0.7` · `benchDiscount 0.25` · `starterReserve 4` · `benchReserve 1` · `maxShare 0.25` ·
`premium 2` · `multQB/RB/WR/TE 1/1/1/1` · `tierBreak 0.75` · `maxKDst 2` · `sleeperThreshold 5`

The last three are board/display knobs, not bidding: `tierBreak` sets where a positional tier
breaks, `maxKDst` hard-caps any K/DST bid at $2, `sleeperThreshold` is the vsECR cutoff for the
board's sleeper flag. All 13 travel in code, so a fresh machine gets them automatically.

**The CALENDAR is not a lever either, and it is not carried in code.** The league's regular-season
length, playoff field, bracket weeks, seeding rule and divisions live in one `format` block in
`settings.config`, written either from ESPN or by the owner, and every consumer reads it. There is
no default: a consumer that finds no block THROWS rather than assuming 14 weeks and a 7-team field.

```
npm run ff -- format show     # both blocks (ESPN's and the stored one) and which is IN FORCE
npm run ff -- format sync     # re-read ESPN through the app bridge (read-only; app must be running)
```

Check it before draft day, because **this league has changed its calendar twice**: 13 weeks with
playoffs in 14/15/16 through 2020, 14 weeks with playoffs in 15/16/17 from 2021, and four divisions
plus a 7-team field from 2025. ESPN's settings for 2026 currently say **14 regular weeks, playoffs
15/16/17, 7 teams, tiebreak TOTAL_POINTS_SCORED, four divisions**.

**If the owner says the league plays 13 weeks with playoffs in 14/15/16, that is an OWNER OVERRIDE
and must be set explicitly** -- it is a legitimate thing for a league to agree among itself, and
ESPN's stored settings will not reflect it:

```
npm run ff -- format set --reg-weeks 13 --playoff-weeks 14,15,16 --seeding division-winners-first
```

The override is stored with `source: "owner-override"` and the date, ESPN's block is kept beside it
as `formatEspn`, and `ff format show` prints the disagreement rather than hiding it. A later
`ff format sync` refreshes ESPN's block but will NOT silently replace an override (`--adopt` does).

Seeding is `record` (wins, then points-for) or `division-winners-first` (each division's best team
takes a top seed, the rest fill by record). This league's own 2018-2025 seeds are consistent with
BOTH -- no season can tell them apart -- so `division-winners-first` is used where divisions exist
on ESPN's documented behaviour, and that is an assumption. See `docs/validation.md`, Track E.

The calendar affects the BACKTEST bracket and the season simulator -- never bidding -- so a wrong
value changes the championship number you validate against, not what the agent does in the draft.
Measured: 13 weeks moves the tripwire by +1.5pp and division seeding by +0.7pp, neither separable
from noise at 25 seasons.
- **Human-only (not auto):** nomination gamesmanship.
- **Not yet live:** in-season lineup SUBMIT (recommend path works offline: `ff lineup --roster`).

## Setting this up on a DIFFERENT computer

Most state is in the repo; four things are not, because they are either derived, personal, or
browser-local. One command rebuilds all of them:

```
git clone <repo> && cd ff-assistant
npm install better-sqlite3      # MUST be first -- see the install trap below
npm install
(cd app && npm install)
cd app && npm start             # then LOG INTO ESPN in the app window, once
cd .. && bash scripts/bootstrap-machine.sh
```

> **Install trap, verified on a clean clone (2026-09-05, Node v24.14.1 / npm 11.11.0).** A plain
> `npm install` FAILS: better-sqlite3 13.0.3 falls back to a node-gyp SOURCE build, which needs a
> C++ toolchain this machine does not have. It is not a warning -- it aborts the whole install, so
> `tsx` never lands and no `ff` command runs at all. **Retrying does not help.** Installing
> better-sqlite3 explicitly FIRST resolves the prebuilt binary, after which `npm install` completes
> normally. The bootstrap script now preflights both modules and fails with this instruction rather
> than letting you discover it mid-setup.

**End-to-end verified on a fresh clone:** bootstrap ran clean, all value gates passed, the ESPN
config cross-check reported ALL MATCH, tests 72/72, and the backtest reproduced this machine
EXACTLY -- 32.9% championships / 94% playoffs. The tuned levers arrived from code as designed
(`aggr 0.7, benchDiscount 0.25, starterReserve 4, maxShare 0.25`).

**Travels with the repo (nothing to do):** the tuned levers -- they live in `src/draft/levers.ts`
(`DEFAULT_LEVERS`) and a fresh `data/ff.db` is seeded from `DEFAULT_CONFIG`, so `aggr`,
`benchDiscount`, `starterReserve` and `maxShare` arrive automatically. Also `data/points.csv`,
`data/values.csv`, and everything under `src/`, `docs/`, `scripts/`.

> **Precedence trap:** `getConfig` deep-merges the STORED levers OVER the code defaults. On a fresh
> machine there is no stored value, so the code wins and you get the tuned config. On a machine with
> an existing `data/ff.db`, a stale stored lever wins over a newer code default and nothing warns
> you. `node scripts/read-config.mjs` prints what the engine will actually use -- trust that, not
> the source file.

**Rebuilt by the script (all gitignored):** `data/ff.db` (league settings, `player_value`, board),
`data/managers.json` (opponent profiles -- personal league data, deliberately not shipped),
`data/history-*.csv` (backtest seasons, scored under THIS league's rules), `data/cheatsheet.md`.

**Cannot be scripted or copied:** the ESPN login. It lives in the Electron webview's persistent
partition (`persist:espn`), which is per-machine browser storage. Logging in once on the new machine
is the only manual step, and it survives app restarts thereafter.

The script ends by running `value-gates.mjs` and `scoring-history.mjs`, so a broken bootstrap fails
loudly instead of leaving you to discover it during the draft.
