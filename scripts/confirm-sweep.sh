#!/usr/bin/env bash
# Confirmation pass. The one-at-a-time sweeps produce CANDIDATES; this decides.
#
# Three things the per-dial tables cannot tell us:
#  1. Does the best cell survive at n=800 (SE ~0.42 instead of ~0.8)?
#  2. Is the share optimum still 0.25 once the reserve is low (it was bracketed only at reserve 8)?
#  3. Does WR 0.85 survive re-measurement at the NEW reserve/share? It was found at r15/s0.35,
#     which is no longer the baseline -- exactly how the RB "gain" reversed sign once aggr changed.
set -u
cd "$(dirname "$0")/.." || exit 1
OUT=data/full-sweep.tsv
SEASONS=2015-2024

run() {
  local group=$1 label=$2 n=$3 aggr=$4 bench=$5 res=$6 share=$7 prem=$8 mkt=$9 mults=${10} infl=${11}
  if grep -qP "^${group}\t${label}\t${n}\t" "$OUT" 2>/dev/null; then echo "skip $group/$label"; return; fi
  local inflflag=""; [ "$infl" = "1" ] && inflflag="--inflation"
  local out champs play
  out=$(npm run ff -- backtest --full --no-lookahead $inflflag --seasons "$SEASONS" --n "$n" \
        --aggr "$aggr" --bench-discount "$bench" --starter-reserve "$res" --max-share "$share" \
        --premium "$prem" --market-noise "$mkt" --pos-mult "$mults" 2>&1)
  champs=$(echo "$out" | grep -oE "CHAMPIONSHIPS: [0-9.]+%" | grep -oE "[0-9.]+")
  play=$(echo "$out" | grep -oE "playoffs: [0-9]+%" | grep -oE "[0-9]+")
  [ -z "$champs" ] && { champs=ERR; play=ERR; echo "$out" | tail -3; }
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$group" "$label" "$n" "$aggr" "$bench" "$res" "$share" "$prem" "$mkt" "$mults" "$infl" "$champs" "$play" >> "$OUT"
  printf '%-9s %-24s champs %-6s playoffs %s\n' "$group" "$label" "$champs" "$play"
}

M="QB:1,RB:1,WR:1,TE:1"

echo "=== bracket the share optimum at LOW reserve (it was only bracketed at r8) ==="
for s in 0.30 0.35; do run share2 "r4-s$s" 400 0.7 0.25 4 $s 2 0.30 "$M" 1; done

echo "=== does WR 0.85 survive at the NEW reserve/share baseline? ==="
run wr2 "wr1.0-new"  400 0.7 0.25 4 0.25 2 0.30 "QB:1,RB:1,WR:1,TE:1" 1
run wr2 "wr0.85-new" 400 0.7 0.25 4 0.25 2 0.30 "QB:1,RB:1,WR:0.85,TE:1" 1

echo "=== head-to-head at n=800: SHIPPED vs CANDIDATE ==="
run final "shipped-r15-s0.35" 800 0.7 0.25 15 0.35 2 0.30 "$M" 1
run final "cand-r4-s0.25"     800 0.7 0.25 4  0.25 2 0.30 "$M" 1

echo "CONFIRM DONE"
