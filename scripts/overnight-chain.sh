#!/usr/bin/env bash
# THE OVERNIGHT CHAIN. Measurements only -- it ships nothing and changes no lever.
#
# The charter allows persistence on ANALYSIS and stops at deploys, so this runs unattended: it
# gates the three arms already in flight, rebuilds the weekly features to populate two new columns,
# and runs the arms that depend on that rebuild. Every ADMIT/REJECT it prints is a measurement for
# the owner to sign off on, never an action.
#
# ORDERING IS THE WHOLE POINT, and it is enforced rather than hoped for:
#   - the rebuild REWRITES feat_player_week_model, which the running evaluations read per fold, so
#     it must not start until every one of them has finished. Editing the trainer under a running
#     fold already destroyed three arms once tonight.
#   - after the rebuild, the OLD base arm is no longer a valid pair for anything. A rebuild can move
#     any column, so pairing a post-rebuild candidate against a pre-rebuild baseline would be two
#     facts sampled from two separate runs -- the error this repo names explicitly. base2 is
#     re-run for that reason and that reason alone.
#
# set -o pipefail because an exit code read through a pipe is the pipe's, not the command's.
set -o pipefail

cd /h/working/ff-assistant || exit 1
S=/c/Users/TLDR/AppData/Local/Temp/claude/H--working-ff-assistant/1ac0e82e-cc20-466b-8f06-08caf8b704e4/scratchpad
LOG=$S/chain.log
exec >>"$LOG" 2>&1
say() { echo "[$(date '+%H:%M:%S')] $*"; }

say "=== CHAIN START ==="

# ---- 1. WAIT for the three in-flight arms -------------------------------------------------------
say "waiting for base/cand/rz to finish..."
until [ -f "$S/status-base.txt" ] && [ -f "$S/status-cand.txt" ] && [ -f "$S/status-rz.txt" ]; do
  sleep 60
done
for a in base cand rz; do say "  $a exit=$(cat "$S/status-$a.txt")"; done

# A non-zero exit, or an implausibly small json, means the arm died. Gating a dead arm would
# compare noise to noise, so the chain refuses rather than printing a verdict it cannot support.
for a in base cand rz; do
  st=$(cat "$S/status-$a.txt")
  sz=$(wc -c < "$S/eval-$a.json")
  if [ "$st" != "0" ] || [ "$sz" -lt 10000 ]; then
    say "ABORT: arm $a exit=$st size=$sz -- it did not produce a real evaluation."
    say "  stderr tail:"; tail -5 "$S/eval-$a.err"
    exit 1
  fi
done
say "all three arms produced real output."

# ---- 2. GATE the two pairings -------------------------------------------------------------------
for pair in "cand:QB opponent block (5 cols, POS_GATED QB)" "rz:rz_share_td (RB/WR/TE)"; do
  arm=${pair%%:*}; desc=${pair#*:}
  say "--- PAIRED FLOOR: base vs $arm -- $desc"
  node --import tsx scripts/weekly-paired-floor.mjs \
    --baseline "$S/eval-base.json" --candidate "$S/eval-$arm.json" > "$S/gate-$arm.txt" 2>&1
  say "  gate exit=$?"
  cat "$S/gate-$arm.txt"
done

# ---- 3. BACK UP, then rebuild the weekly features ----------------------------------------------
# 931MB against 1.7TB free. This repo has already lost a database to an unguarded file operation;
# the backup is the cheapest possible insurance against losing another.
BK=data/ff.db.bak-chain-$(date '+%Y%m%d-%H%M%S')
say "backing up ff.db -> $BK"
cp data/ff.db "$BK" || { say "ABORT: backup failed"; exit 1; }
say "  backup size: $(wc -c < "$BK") bytes"

# --artifact-dir IS NOT OPTIONAL. Without it every historical season's line is projected from an
# artifact that has SEEN that season, which silently contaminates the entire weekly table with
# lookahead. The blind artifacts were confirmed current (fittedAt 2026-09-19, same as the shipped
# projector) before this chain was written.
say "rebuilding weekly features (2010-2026) with the BLIND artifact dir..."
npm run ff -- build-weekly-features --seasons 2010-2026 --current-season 2026 \
  --artifact-dir data/fold-artifacts-d16 > "$S/rebuild.log" 2>&1
RB=$?
say "  rebuild exit=$RB"
tail -15 "$S/rebuild.log"
[ "$RB" = "0" ] || { say "ABORT: rebuild failed"; exit 1; }

# ---- 4. PROVE THE LEVER IS CONNECTED before measuring it ----------------------------------------
# A column that is present-but-empty and a column with no effect produce the SAME flat result. If
# the rebuild did not populate these, the adot arm would measure a dead lever and report a null
# that looks exactly like a real one. So: assert coverage, and abort loudly if it is not there.
say "checking the new columns actually got populated..."
node - <<'NODE' > "$S/coverage.txt" 2>&1
const D = require("better-sqlite3")("data/ff.db", { readonly: true });
const r = D.prepare(
  `SELECT COUNT(*) n,
          SUM(prior_air_yards_share IS NOT NULL) a,
          SUM(prior_wopr IS NOT NULL) w
     FROM feat_player_week_model
    WHERE pos IN ('WR','TE') AND season BETWEEN 2012 AND 2025`).get();
const pa = (100 * r.a) / r.n, pw = (100 * r.w) / r.n;
console.log(`WR/TE rows ${r.n} | prior_air_yards_share ${r.a} (${pa.toFixed(1)}%) | prior_wopr ${r.w} (${pw.toFixed(1)}%)`);
console.log(pa > 30 && pw > 30 ? "CONNECTED" : "DEAD_LEVER");
D.close();
NODE
cat "$S/coverage.txt"
if ! grep -q "CONNECTED" "$S/coverage.txt"; then
  say "ABORT: the new columns are empty after the rebuild -- the adot arm would measure a dead lever."
  exit 1
fi

# ---- 5. base2 + the adot/WOPR arm, both on the REBUILT table ------------------------------------
sed 's/$/,prior_air_yards_share,prior_wopr/' "$S/base-features.txt" > "$S/adot-features.txt"
say "base2 (re-run on the rebuilt table -- the pre-rebuild base is not a valid pair)"
npm run ff -- evaluate-weekly --json --features "$(cat "$S/base-features.txt")" \
  > "$S/eval-base2.json" 2> "$S/eval-base2.err"; echo $? > "$S/status-base2.txt"
say "  base2 exit=$(cat "$S/status-base2.txt")"

say "adot arm (base + prior_air_yards_share + prior_wopr, POS_GATED WR/TE)"
npm run ff -- evaluate-weekly --json --features "$(cat "$S/adot-features.txt")" \
  > "$S/eval-adot.json" 2> "$S/eval-adot.err"; echo $? > "$S/status-adot.txt"
say "  adot exit=$(cat "$S/status-adot.txt")"

if [ "$(cat "$S/status-base2.txt")" = "0" ] && [ "$(cat "$S/status-adot.txt")" = "0" ]; then
  say "--- PAIRED FLOOR: base2 vs adot"
  node --import tsx scripts/weekly-paired-floor.mjs \
    --baseline "$S/eval-base2.json" --candidate "$S/eval-adot.json" > "$S/gate-adot.txt" 2>&1
  cat "$S/gate-adot.txt"
else
  say "SKIP adot gate: one of the arms failed."
  tail -5 "$S/eval-adot.err"
fi

# The COMBINED arm is deliberately NOT here. It only means anything if something admitted, and
# "does a broader lever already explain this gain" is a question to ask once there is a gain.
say "=== CHAIN DONE ==="
