#!/usr/bin/env bash
# RUN THE WEEKLY EVALUATION ARMS SO THAT LOSING ONE FOLD DOES NOT LOSE THE NIGHT.
#
# WHAT WENT WRONG. Four arms ran for ~100 minutes and produced NOTHING. A memory spike killed the
# `uv run ... train_weekly.py` subprocess inside one fold; trainHoldout throws, no fold loop
# catches, and main().catch exits 1 -- so a single transient failure at fold 13 of 14 discards
# thirteen completed fits. base died at holdout 2025, cand and rz at 2024, vol at 2019. That is
# not an OOM problem, it is a DURABILITY problem: the work was already on disk and was thrown away.
#
# TWO CHANGES, both using machinery the evaluator already had:
#
#   1. --keep-artifacts <dir> --reuse-artifacts. Each fold is written as weekly-<season>.json and
#      KEPT, and trainHoldout returns an existing one instead of refitting
#      (`if (reuse && existsSync(out))`, and a corrupt file falls through to a fresh train). So a
#      retry RESUMES. A rerun after twelve good folds costs two fits, not fourteen.
#   2. A retry loop per arm, and each arm's dir is its OWN, so two arms can never read each
#      other's folds -- they are fitted on DIFFERENT feature lists and silently sharing one would
#      be the worst kind of contamination: invisible, and it would make the arms agree.
#
# CONCURRENCY IS BOUNDED AT TWO. The machine has 32 cores but memory is the binding constraint --
# it was at 1.9 GB free when the kills happened. Two arms is roughly 4 GB and leaves headroom for
# whatever else on this box decides to allocate 25 GB of browser shells.
#
# THE STATUS FILES ARE WRITTEN BY THIS SCRIPT, not by a launching shell that can be killed
# independently of the work. That is what stranded the last run: the node trees survived, their
# shells did not, and `echo $? > status` never ran.
set -o pipefail
cd /h/working/ff-assistant || exit 1
S=/c/Users/TLDR/AppData/Local/Temp/claude/H--working-ff-assistant/1ac0e82e-cc20-466b-8f06-08caf8b704e4/scratchpad
LOG=$S/arms.log
exec >>"$LOG" 2>&1
say() { echo "[$(date '+%H:%M:%S')] $*"; }

ARMS="${ARMS:-base cand rz vol}"
ATTEMPTS="${ATTEMPTS:-3}"

run_arm() {
  arm=$1
  dir=$S/folds-$arm
  mkdir -p "$dir"
  feats=$(cat "$S/$arm-features.txt")
  for attempt in $(seq 1 "$ATTEMPTS"); do
    have=$(ls "$dir"/weekly-*.json 2>/dev/null | wc -l)
    say "$arm: attempt $attempt starting with $have/14 folds already on disk"
    npm run ff -- evaluate-weekly --json --features "$feats" \
      --keep-artifacts "$dir" --reuse-artifacts \
      > "$S/eval-$arm.json" 2> "$S/eval-$arm.err"
    rc=$?
    if [ "$rc" = "0" ]; then
      say "$arm: SUCCEEDED on attempt $attempt"
      echo 0 > "$S/status-$arm.txt"
      return 0
    fi
    have=$(ls "$dir"/weekly-*.json 2>/dev/null | wc -l)
    say "$arm: attempt $attempt FAILED rc=$rc -- $have/14 folds survive on disk, will resume"
    tail -2 "$S/eval-$arm.err" | sed 's/^/    /'
    sleep 30
  done
  say "$arm: EXHAUSTED $ATTEMPTS attempts"
  echo 1 > "$S/status-$arm.txt"
  return 1
}

say "=== ARMS START: $ARMS (max $ATTEMPTS attempts each, 2 concurrent) ==="
# Stale statuses from the killed run would make the chain think these are done.
for a in $ARMS; do rm -f "$S/status-$a.txt"; done

set -- $ARMS
while [ "$#" -gt 0 ]; do
  a=$1; shift
  b=""; if [ "$#" -gt 0 ]; then b=$1; shift; fi
  run_arm "$a" &
  P1=$!
  if [ -n "$b" ]; then run_arm "$b" & P2=$!; else P2=""; fi
  wait $P1
  [ -n "$P2" ] && wait $P2
  say "pair done: $a $b"
done

say "=== ARMS DONE ==="
for a in $ARMS; do say "  $a exit=$(cat "$S/status-$a.txt" 2>/dev/null || echo MISSING)"; done
