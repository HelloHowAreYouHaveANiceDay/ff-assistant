/**
 * CHANGE METRICS -- alternative encodings of "how much has a player's role changed", each reducing the
 * point-in-time role series to a (recent, baseline) pair. The projector's multiplier on the frozen line
 * is the shared transform clamp( ((recent+s)/(baseline+s))^alpha, [lo,hi] ), so the ONLY thing that
 * varies across metrics is how recent-vs-baseline is measured. Phase 2 used SMA(3)-vs-to-date; this
 * family lets the accuracy diagnostic pick the best encoding under holdout discipline.
 *
 * A metric returns null when the series is too short for it -- the projector then falls back to frozen.
 */
export interface ChangeMetric {
  name: string;
  est(prior: number[]): { recent: number; baseline: number } | null;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** SMA(n): recent = mean of last n games, baseline = mean of ALL prior games (the Phase-2 default). */
const sma = (n: number): ChangeMetric => ({
  name: `sma${n}/todate`,
  est: (p) => (p.length >= 2 ? { recent: mean(p.slice(-n)), baseline: mean(p) } : null),
});

/** EWMA(halflife): recent = exponentially weighted mean (most recent weighted most), baseline = to-date
 *  mean. A smoother recent estimate than a hard window -- old games fade instead of dropping out. */
const ewma = (halflife: number): ChangeMetric => ({
  name: `ewma${halflife}/todate`,
  est: (p) => {
    if (p.length < 2) return null;
    const decay = Math.pow(0.5, 1 / halflife);
    let wsum = 0, vsum = 0, w = 1;
    for (let i = p.length - 1; i >= 0; i--) { vsum += w * p[i]; wsum += w; w *= decay; } // newest gets w=1
    return { recent: vsum / wsum, baseline: mean(p) };
  },
});

/** CROSSOVER(short, long): recent = short MA, baseline = long MA -- the classic fast/slow crossover. */
const crossover = (short: number, long: number): ChangeMetric => ({
  name: `cross${short}/${long}`,
  est: (p) => (p.length >= long ? { recent: mean(p.slice(-short)), baseline: mean(p.slice(-long)) } : null),
});

/** SLOPE(k): OLS slope over the last k games projected half a window forward vs the window mean -- a
 *  true rate-of-change rather than a level difference. recent > baseline iff the trend is rising. */
const slope = (k: number): ChangeMetric => ({
  name: `slope${k}`,
  est: (p) => {
    if (p.length < k) return null;
    const y = p.slice(-k);
    const xbar = (k - 1) / 2, ybar = mean(y);
    let num = 0, den = 0;
    for (let i = 0; i < k; i++) { num += (i - xbar) * (y[i] - ybar); den += (i - xbar) ** 2; }
    const b = den ? num / den : 0;
    return { recent: ybar + b * (k / 2), baseline: ybar };  // extrapolate half a window past the centre
  },
});

/** The full family the accuracy diagnostic compares. sma3/todate is the Phase-2 incumbent. */
export const CHANGE_METRICS: ChangeMetric[] = [
  sma(2), sma(3), sma(4), sma(5),
  ewma(1), ewma(2), ewma(3),
  crossover(2, 4), crossover(2, 5), crossover(3, 6),
  slope(3), slope(4), slope(5),
];

/** The shared multiplier on the frozen line, given a metric's (recent, baseline). */
export function multiplierOf(
  est: { recent: number; baseline: number },
  p: { alpha: number; smoothing: number; lo: number; hi: number },
): number {
  // role is a share in [0,1]; a slope extrapolation can over/undershoot, so clamp to >=0 before the
  // ratio -- otherwise a negative recent makes Math.pow(negative, fractional-alpha) = NaN.
  const recent = Math.max(0, est.recent), baseline = Math.max(0, est.baseline);
  const ratio = (recent + p.smoothing) / (baseline + p.smoothing);
  return Math.min(p.hi, Math.max(p.lo, Math.pow(ratio, p.alpha)));
}
