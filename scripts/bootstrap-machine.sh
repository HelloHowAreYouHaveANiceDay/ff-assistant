#!/usr/bin/env bash
# Rebuild everything a SECOND MACHINE needs that git does not carry.
#
# What travels in the repo (nothing to do):
#   - the tuned levers. They live in src/draft/levers.ts (DEFAULT_LEVERS) and a fresh data/ff.db is
#     seeded from DEFAULT_CONFIG, so aggr/benchDiscount/reserve/maxShare arrive automatically.
#     NOTE the precedence: getConfig deep-merges STORED levers OVER code defaults, so on a machine
#     with an existing db, a stale stored value wins. `node scripts/read-config.mjs` shows the truth.
#   - data/points.csv and data/values.csv (checked in), src/, docs/, scripts/.
#
# What does NOT travel (this script rebuilds it):
#   - data/ff.db        league settings + player_value + board   (gitignored)
#   - data/managers.json opponent profiles                       (gitignored: per-league personal data)
#   - data/history-*.csv backtest seasons                        (gitignored: derived, league-scored)
#   - data/cheatsheet.md                                          (gitignored: derived)
#
# What CANNOT be scripted: the ESPN login. It lives in the Electron webview's persistent partition
# ("persist:espn"), which is per-machine browser storage, not a file we can copy safely.
#
# PREREQUISITES (do these first, by hand):
#   1. git clone, then install deps -- IN THIS ORDER, because a plain `npm install` FAILS:
#        npm install better-sqlite3     # fetches the PREBUILT binary
#        npm install                    # everything else
#        (cd app && npm install)
#      Verified on a clean clone 2026-09-05, Node v24.14.1 / npm 11.11.0: a bare `npm install`
#      makes better-sqlite3 13.0.3 fall back to a node-gyp SOURCE build, which needs MSVC and dies
#      -- and it aborts the whole install, so tsx never lands either and nothing runs. Retrying does
#      NOT help. Installing better-sqlite3 explicitly first resolves the prebuild and the rest then
#      completes. See docs/draft-day-runbook.md.
#   2. `cd app && npm start`
#   3. log into ESPN inside the app window, once
# Then run this from the repo root:  bash scripts/bootstrap-machine.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n=== %s\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1"; exit 1; }

say "0. preflight: dependencies actually load"
node -e "require('better-sqlite3')" 2>/dev/null   || fail "better-sqlite3 will not load. Run: npm install better-sqlite3 && npm install  (see header)"
npx tsx --version >/dev/null 2>&1 || fail "tsx missing -- the npm install did not complete (see header)"

say "0b. checking the app is running and logged in"
curl -s -m 5 http://127.0.0.1:9223/json/version >/dev/null 2>&1 \
  || fail "no app on CDP 9223. Start it (cd app && npm start) and log into ESPN first."
node scripts/mcp-call.mjs read_needs '{}' >/dev/null 2>&1 || true

say "1. league settings from ESPN (size, scoring, roster slots, your team)"
# league_sync is an MCP tool rather than a CLI verb, so it is driven through the stdio surface.
node scripts/mcp-call.mjs discover_leagues '{}' 2>/dev/null | tail -2
node scripts/mcp-call.mjs league_sync '{}' 2>/dev/null | tail -2

say "2. opponent profiles from the league's full draft history"
# --years 14 not the default 4: the league has run since 2012, and maxBuy (the bots' budget-anxiety
# cap) and leagueShare are both materially better with 98 team-seasons than with 54.
npm run ff -- scrape-league --years 14 2>&1 | tail -2

say "3. backtest history from nflverse (network, no login needed)"
npm run ff -- build-history --seasons 1999-2024 2>&1 | tail -1

say "3b. models FITTED FROM that history -- variance, correlation, bootstrap pools"
# These must be refitted HERE, after step 3, not trusted from the repo. variance-model.json and
# correlation-model.json are checked in, so a fresh clone gets a copy -- but a copy fitted against
# whatever history the last committer had. Refitting binds them to the history this machine just
# built. rank-outcomes.json is 2.1 MB and gitignored, so it does not travel at all and MUST be built.
node --import tsx scripts/fit-variance.mjs    2>&1 | tail -1
node --import tsx scripts/fit-correlation.mjs 2>&1 | tail -1
node --import tsx scripts/fit-bootstrap.mjs   2>&1 | tail -1
test -s data/rank-outcomes.json || fail "rank-outcomes.json missing -- season-odds cannot run"

say "3c. the point-in-time feature tables, the picks fact table, and the projection artifact"
# The projector REFUSES to run without an artifact rather than falling back to a bare curve, so this
# step is not optional -- `ff projections` fails loudly without it, on purpose. The features must be
# built first: the artifact's quantile heads are measured from feat_player_season.
npm run ff -- build-features --seasons 1999-"$(date +%Y)" 2>&1 | head -2
npm run ff -- build-picks 2>&1 | head -1
npm run ff -- build-artifact --curve-only 2>&1 | head -1
test -s data/projection-artifact.json || fail "projection-artifact.json missing -- `ff projections` cannot run"

say "4. projections, values and the co-pilot cheatsheet -- ONE build, so every surface agrees"
npm run ff -- refresh 2>&1 | tail -1
npm run ff -- values 2>&1 | tail -1
npm run ff -- cheatsheet >/dev/null 2>&1 && echo "cheatsheet written"

say "5. gates -- verify by assertion, never by a success line"
node --import tsx scripts/value-gates.mjs || fail "value gates failed: the book is wrong, do not draft on it"
node scripts/scoring-history.mjs || fail "league format/scoring does not match the synced config"

say "6. what the engine will actually use"
node scripts/read-config.mjs

printf '\nBootstrap complete. Sanity-check before drafting:\n'
printf '  npm test                      # expect all green\n'
printf '  npm run ff -- backtest --full --no-lookahead --inflation --seasons 1999-2024 --n 150\n'
printf '  (expect roughly 33%% championships; a very different number means an input drifted)\n'
