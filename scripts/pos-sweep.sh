#!/usr/bin/env bash
# Sweep each positional value multiplier against the SHIPPED baseline (aggr 0.7). One position at a
# time, everything else at its lever value, so each row answers "is our book too high/low HERE".
set -u
cd "$(dirname "$0")/.." || exit 1
OUT=data/pos-sweep.txt
: > "$OUT"
N=${N:-400}
# PIN every multiplier on the command line. Passing only the swept position leaves the others at
# whatever the PERSISTED config happens to hold -- and if that config is edited mid-run (it was, on
# 2026-09-04), the baseline moves between rows and the table silently stops being comparable. The
# tell was that the three "x1" rows, which are the same deterministic run, disagreed.
for pos in QB RB WR TE; do
  for m in 0.7 0.85 1 1.15; do
    mults="QB:1,RB:1,WR:1,TE:1"
    mults=$(echo "$mults" | sed "s/$pos:1/$pos:$m/")
    line=$(npm run ff -- backtest --full --no-lookahead --inflation --seasons 2015-2024 --n "$N" --pos-mult "$mults" 2>&1 | grep -oE "CHAMPIONSHIPS: [0-9.]+%.*playoffs: [0-9]+%")
    printf '%s x%-5s %s\n' "$pos" "$m" "$line" | tee -a "$OUT"
  done
done
echo "DONE" | tee -a "$OUT"
