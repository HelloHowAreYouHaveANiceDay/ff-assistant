#!/usr/bin/env bash
# Full validation campaign for the draft model.
#
# Every run PINS its whole config on the command line. Nothing reads the persisted config, so an
# edit to settings.config mid-campaign cannot move a baseline between rows -- that contamination
# happened on 2026-09-04 and was only caught because three supposedly-identical "x1" rows disagreed.
#
# Runs are SEQUENTIAL on purpose: two concurrent backtests on this machine turned a 2-minute job
# into a 2-hour stall.
#
# Output: data/full-sweep.tsv, one row per run, with the config that produced it.
set -u
cd "$(dirname "$0")/.." || exit 1
OUT=data/full-sweep.tsv
N=${N:-400}
SEASONS=2015-2024

# Shipped baseline at the time of writing.
B_AGGR=0.7; B_BENCH=0.25; B_RES=15; B_SHARE=0.35; B_PREM=2; B_MKT=0.30; B_MULT="QB:1,RB:1,WR:1,TE:1"

if [ ! -f "$OUT" ]; then
  printf 'group\tlabel\tn\taggr\tbench\treserve\tshare\tpremium\tmarketSd\tmults\tinfl\tchamps\tplayoffs\n' > "$OUT"
fi

# run <group> <label> <n> <aggr> <bench> <reserve> <share> <premium> <marketSd> <mults> <infl:1|0>
run() {
  local group=$1 label=$2 n=$3 aggr=$4 bench=$5 res=$6 share=$7 prem=$8 mkt=$9 mults=${10} infl=${11}
  # Skip work already recorded, so the campaign can be resumed after an interruption.
  if grep -qP "^${group}\t${label}\t${n}\t" "$OUT" 2>/dev/null; then
    echo "skip  $group/$label (already recorded)"; return
  fi
  local inflflag=""; [ "$infl" = "1" ] && inflflag="--inflation"
  local out champs play
  out=$(npm run ff -- backtest --full --no-lookahead $inflflag --seasons "$SEASONS" --n "$n" \
        --aggr "$aggr" --bench-discount "$bench" --starter-reserve "$res" --max-share "$share" \
        --premium "$prem" --market-noise "$mkt" --pos-mult "$mults" 2>&1)
  champs=$(echo "$out" | grep -oE "CHAMPIONSHIPS: [0-9.]+%" | grep -oE "[0-9.]+")
  play=$(echo "$out"  | grep -oE "playoffs: [0-9]+%"      | grep -oE "[0-9]+")
  if [ -z "$champs" ]; then champs="ERR"; play="ERR"; echo "$out" | tail -3; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$group" "$label" "$n" "$aggr" "$bench" "$res" "$share" "$prem" "$mkt" "$mults" "$infl" "$champs" "$play" >> "$OUT"
  printf '%-10s %-22s champs %-6s playoffs %s\n' "$group" "$label" "$champs" "$play"
}

echo "=== 1. positional multipliers (each pinned, others at 1) ==="
for pos in QB RB WR TE; do
  for m in 0.7 0.85 1 1.15; do
    mults=$(echo "QB:1,RB:1,WR:1,TE:1" | sed "s/$pos:1/$pos:$m/")
    run pos "$pos-x$m" "$N" $B_AGGR $B_BENCH $B_RES $B_SHARE $B_PREM $B_MKT "$mults" 1
  done
done

echo "=== 2. starterReserve x maxShare (both were tuned at aggr 1.0) ==="
for res in 8 12 15 20 25; do
  for share in 0.25 0.35 0.45; do
    run reserve "r$res-s$share" "$N" $B_AGGR $B_BENCH $res $share $B_PREM $B_MKT "$B_MULT" 1
  done
done

echo "=== 3. premium (applied AFTER shading, so it partially undoes it; never swept) ==="
for prem in 0 1 2 4 6; do
  run premium "p$prem" "$N" $B_AGGR $B_BENCH $B_RES $B_SHARE $prem $B_MKT "$B_MULT" 1
done

echo "=== 4. live inflation on/off (its +2pt claim was measured at aggr 1.0) ==="
run infl "inflation-on"  "$N" $B_AGGR $B_BENCH $B_RES $B_SHARE $B_PREM $B_MKT "$B_MULT" 1
run infl "inflation-off" "$N" $B_AGGR $B_BENCH $B_RES $B_SHARE $B_PREM $B_MKT "$B_MULT" 0

echo "=== 5. benchDiscount re-verified at the shipped aggr ==="
for b in 1 0.5 0.35 0.25 0.15 0.05; do
  run bench "b$b" "$N" $B_AGGR $b $B_RES $B_SHARE $B_PREM $B_MKT "$B_MULT" 1
done

echo "=== 6. aggr x marketSd -- is the shading optimum robust to how sharp the ROOM is? ==="
echo "===    marketSd is a pure assumption: calibrate never measures it ==="
for mkt in 0.20 0.30 0.45; do
  for aggr in 0.6 0.7 0.85 1.0; do
    run robust "mkt$mkt-a$aggr" "$N" $aggr $B_BENCH $B_RES $B_SHARE $B_PREM $mkt "$B_MULT" 1
  done
done

echo "=== 7. aggr fine grid at the shipped assumptions ==="
for aggr in 0.55 0.6 0.65 0.7 0.75 0.8 0.9; do
  run aggr "a$aggr" "$N" $aggr $B_BENCH $B_RES $B_SHARE $B_PREM $B_MKT "$B_MULT" 1
done

echo "=== 8. reserve x share EXTENDED -- the first grid's best cell (r8/s0.25) sat on its EDGE, ==="
echo "===    which means the optimum was never bracketed. Go down and out until it turns over. ==="
# reserve 0 is the boundary case: the soft per-starter reserve vanishes and only the hard $1-per-open-
# slot floor remains. Including it matters -- if the best cell is still an edge, the answer is that
# the reserve is doing nothing useful, not that "lower is better" forever.
for res in 0 2 4 6 8; do
  for share in 0.15 0.20 0.25; do
    run reserve2 "r$res-s$share" "$N" $B_AGGR $B_BENCH $res $share $B_PREM $B_MKT "$B_MULT" 1
  done
done

echo "=== 9. aggr x reserve -- these are TWO mechanisms for the same caution, so the true optimum ==="
echo "===    may be a ridge that no one-at-a-time sweep can see. Shading was tuned at reserve 15; ==="
echo "===    if reserve drops, the best aggr may rise back toward 1.0. ==="
for aggr in 0.7 0.8 0.9 1.0; do
  for res in 2 6 12; do
    run ridge "a$aggr-r$res" "$N" $aggr $B_BENCH $res 0.25 $B_PREM $B_MKT "$B_MULT" 1
  done
done

echo "ALL DONE" | tee -a "$OUT"
