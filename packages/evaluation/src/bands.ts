/**
 * §17 score bands, for comparing outcomes by band (§22).
 *
 * The two interior boundaries are already strategy configuration
 * (`scoring.interestingThreshold`, `scoring.strongThreshold`), so they are read
 * rather than hard-coded: when a threshold moves, the bands follow it and the
 * change mints a new strategyVersion, which is exactly what §22 requires. The
 * outer two — 40 and 90 — have no configured home and come from the §17 table.
 *
 * Bands are half-open `[from, to)` except the last, so a score of exactly 60
 * lands in INTERESTING rather than ambiguously between bands.
 */

/** §17: below this a candidate is ignored entirely. */
export const IGNORE_CEILING = 40;
/** §17: the top band, still alert-only in the MVP (§28). */
export const HIGH_CONVICTION_FLOOR = 90;

export type ScoreBand = {
  label: string;
  from: number;
  to: number;
};

export function scoreBands(config: {
  interestingThreshold: number;
  strongThreshold: number;
}): ScoreBand[] {
  return [
    { label: 'IGNORE', from: 0, to: IGNORE_CEILING },
    { label: 'WATCHING', from: IGNORE_CEILING, to: config.interestingThreshold },
    { label: 'INTERESTING', from: config.interestingThreshold, to: config.strongThreshold },
    { label: 'STRONG', from: config.strongThreshold, to: HIGH_CONVICTION_FLOOR },
    // Inclusive upper bound: a perfect 100 has to land somewhere.
    { label: 'HIGH_CONVICTION', from: HIGH_CONVICTION_FLOOR, to: Number.POSITIVE_INFINITY },
  ];
}

export function bandFor(score: number, bands: readonly ScoreBand[]): ScoreBand | null {
  return bands.find((band) => score >= band.from && score < band.to) ?? null;
}
