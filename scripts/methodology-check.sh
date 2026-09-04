#!/usr/bin/env bash
# The statistic I have been quoting is WRONG in a specific way, and this measures the right one.
#
# n=400 x 9 seasons = 3600 trials gives SE ~0.8pp -- but those 3600 are not 3600 independent draws
# from the world. They are 400 noise re-draws over the SAME NINE SEASONS. For the question that
# actually matters -- "will this help in 2026, a season we have never seen" -- the effective sample
# size is closer to 9, not 3600. Within-sim SE understates the real uncertainty a lot.
#
# So: (1) per-season paired comparison + sign test, (2) an explicit first-half / second-half split,
# which is the cheapest available stand-in for a train/test holdout.
set -u
cd "$(dirname "$0")/.." || exit 1
N=${N:-400}

runcfg() { # <label> <seasons> <aggr> <reserve> <share>
  local label=$1 seasons=$2 aggr=$3 res=$4 share=$5
  local out
  out=$(npm run ff -- backtest --full --no-lookahead --inflation --seasons "$seasons" --n "$N" \
        --aggr "$aggr" --bench-discount 0.25 --starter-reserve "$res" --max-share "$share" \
        --premium 2 --market-noise 0.30 --pos-mult "QB:1,RB:1,WR:1,TE:1" 2>&1)
  local champs perseason
  champs=$(echo "$out" | grep -oE "CHAMPIONSHIPS: [0-9.]+%" | grep -oE "[0-9.]+")
  perseason=$(echo "$out" | grep -oE "per season:.*" | sed 's/per season: *//')
  printf '%-26s %-10s champs %-6s | %s\n' "$label" "$seasons" "$champs" "$perseason"
}

echo "=== FULL RANGE, per season (the 9 numbers that actually carry the generalisation) ==="
runcfg "shipped r15/s0.35"   2015-2024 0.7 15 0.35
runcfg "candidate r4/s0.25"  2015-2024 0.7 4  0.25
runcfg "no-shading aggr1.0"  2015-2024 1.0 15 0.35

echo
echo "=== SPLIT-HALF: does the effect hold in BOTH halves independently? ==="
echo "=== (tuning used all 9 seasons, so this is a weak holdout -- but a disagreement here would ==="
echo "===  be decisive evidence the gain is season-specific rather than real) ==="
for half in 2015-2019 2020-2024; do
  runcfg "shipped r15/s0.35"  "$half" 0.7 15 0.35
  runcfg "candidate r4/s0.25" "$half" 0.7 4  0.25
  runcfg "no-shading aggr1.0" "$half" 1.0 15 0.35
done
echo "METHOD DONE"
