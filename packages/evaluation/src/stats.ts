/**
 * Statistics for §22, chosen for skew.
 *
 * §22 gives an explicit warning: "do not tune strategy based only on average
 * return; meme-token outcomes may have highly skewed distributions." Every
 * choice here follows from that. One token that goes 40x drags a mean somewhere
 * no individual outcome ever was, so the median leads and the mean is never
 * reported without the distribution beside it. Rank correlation replaces
 * Pearson for the same reason.
 *
 * Everything is pure and takes plain numbers, so the arithmetic can be checked
 * against known values rather than against the database.
 */

/** Sorted copy; every quantile below assumes it. */
const sorted = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/**
 * Linear-interpolated quantile, matching the `percentile_cont` used in the
 * Phase 7 audit queries so hand-written SQL cross-checks agree.
 */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const list = sorted(values);
  if (list.length === 1) return list[0]!;

  const position = (list.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return list[lower]!;
  return list[lower]! + (position - lower) * (list[upper]! - list[lower]!);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export type Distribution = {
  n: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
};

export function distribution(values: readonly number[]): Distribution {
  const list = sorted(values);
  return {
    n: list.length,
    min: list[0] ?? null,
    p10: quantile(list, 0.1),
    p25: quantile(list, 0.25),
    median: quantile(list, 0.5),
    p75: quantile(list, 0.75),
    p90: quantile(list, 0.9),
    max: list[list.length - 1] ?? null,
    mean: mean(list),
  };
}

export type WinRate = {
  wins: number;
  n: number;
  rate: number | null;
  /** Wilson score interval, 95%. */
  low: number | null;
  high: number | null;
};

/**
 * Win rate with a Wilson score interval rather than a normal approximation.
 *
 * At the sample sizes this project currently has — often under 20 — the normal
 * approximation produces intervals that run below 0 or above 1, and collapses
 * to zero width at 0% or 100%, which reads as certainty from five data points.
 * Wilson stays inside [0,1] and stays wide when n is small, which is the whole
 * point of showing an interval at all.
 */
export function winRate(returns: readonly number[], z = 1.96): WinRate {
  const n = returns.length;
  if (n === 0) return { wins: 0, n: 0, rate: null, low: null, high: null };

  // A zero return is not a win. Flat is flat.
  const wins = returns.filter((value) => value > 0).length;
  const p = wins / n;

  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));

  return {
    wins,
    n,
    rate: p,
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

/**
 * Gross profit over gross loss.
 *
 * `null` means undefined (no trades); `Infinity` means no losing trades at all.
 * Both are reported as words rather than numbers — a profit factor printed as
 * some enormous figure invites reading it as a very good strategy instead of as
 * "too few trades to have lost yet".
 */
export function profitFactor(returns: readonly number[]): number | null {
  if (returns.length === 0) return null;
  let profit = 0;
  let loss = 0;
  for (const value of returns) {
    if (value > 0) profit += value;
    else loss += Math.abs(value);
  }
  if (loss === 0) return profit === 0 ? null : Number.POSITIVE_INFINITY;
  return profit / loss;
}

/** Average ranks, so ties do not distort the correlation. */
function ranks(values: readonly number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const out = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.value === indexed[i]!.value) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[indexed[k]!.index] = averageRank;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman rank correlation.
 *
 * Rank-based rather than Pearson because meme returns are heavily skewed: a
 * single 40x would dominate a Pearson coefficient and make an unrelated feature
 * look predictive. Ranks ask the question actually worth asking — does a higher
 * feature score tend to come with a higher return — without letting one outlier
 * answer it alone.
 *
 * Returns null when fewer than three pairs survive, or when either side is
 * constant (a correlation with a flat variable is undefined, not zero).
 */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;

  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = mean(rx)!;
  const my = mean(ry)!;

  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < rx.length; i += 1) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    numerator += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  if (dx2 === 0 || dy2 === 0) return null;
  return numerator / Math.sqrt(dx2 * dy2);
}

/**
 * Pair a feature with its outcome, dropping samples where the feature was not
 * measured.
 *
 * §15's rule carried into analysis: a null component means "we could not
 * measure it", and coercing it to 0 would invent a low score for every token
 * whose smart-money data was absent — then correlate that invention against
 * returns. The pair is dropped and the surviving count reported instead.
 */
export function pairMeasured(
  samples: readonly { feature: number | null; outcome: number }[],
): { xs: number[]; ys: number[]; measured: number; total: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sample of samples) {
    if (sample.feature === null) continue;
    xs.push(sample.feature);
    ys.push(sample.outcome);
  }
  return { xs, ys, measured: xs.length, total: samples.length };
}
