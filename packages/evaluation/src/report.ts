import type { CellStats, FeatureStats } from './aggregate.js';

/**
 * Render the §22 tables.
 *
 * The formatting carries a correctness requirement, not just a cosmetic one. A
 * cell below the sample threshold prints INSUFFICIENT *instead of* its numbers,
 * because a number shown next to a warning still gets read as a number. The
 * median leads the mean everywhere, and the profit-factor assumption is
 * restated on every run so the figure cannot travel without it.
 */

const pad = (text: string, width: number, right = false): string =>
  right ? text.padStart(width) : text.padEnd(width);

const pct = (value: number | null, digits = 1): string =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;

const ratio = (value: number | null): string => {
  if (value === null) return 'n/a';
  if (!Number.isFinite(value)) return '∞ (no losses yet)';
  return value.toFixed(2);
};

function table(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => pad(cell, widths[i]!, i > 0)).join('  ');

  return [
    line(headers),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

export function renderBands(cells: readonly CellStats[]): string {
  const rows = cells.map((cell) => {
    const sample = `${cell.n} (${cell.tokens} tok)`;
    if (!cell.sufficient) {
      return [
        cell.band,
        cell.horizon,
        sample,
        String(cell.measured),
        `INSUFFICIENT — need more outcomes`,
        '',
        '',
        '',
        '',
        '',
      ];
    }
    const w = cell.winRate;
    return [
      cell.band,
      cell.horizon,
      sample,
      String(cell.measured),
      `${((w.rate ?? 0) * 100).toFixed(0)}% [${((w.low ?? 0) * 100).toFixed(0)}–${((w.high ?? 0) * 100).toFixed(0)}]`,
      pct(cell.returns.median),
      // §22 lists average return, so it is shown — but after the median and
      // never without the spread, since one 40x moves it somewhere no outcome
      // ever was.
      pct(cell.returns.mean),
      `${pct(cell.returns.p10)} / ${pct(cell.returns.p90)}`,
      `${pct(cell.medianRunup)} / ${pct(cell.medianDrawdown)}`,
      ratio(cell.profitFactor),
    ];
  });

  return table(
    [
      'band',
      'horizon',
      'n',
      'meas',
      'win rate [95% CI]',
      'median',
      'mean',
      'p10 / p90',
      'runup / drawdown',
      'profit factor',
    ],
    rows,
  );
}

export function renderFeatures(features: readonly FeatureStats[]): string {
  const rows = features.map((feature) => [
    feature.feature,
    feature.horizon,
    `${feature.measured}/${feature.total}`,
    feature.sufficient
      ? feature.correlation === null
        ? '— (no variation)'
        : feature.correlation.toFixed(2)
      : 'INSUFFICIENT',
  ]);
  return table(['feature', 'horizon', 'measured/total', 'spearman ρ vs return'], rows);
}

export function renderExclusions(cells: readonly CellStats[]): string {
  const totals: Record<string, number> = {};
  for (const cell of cells) {
    for (const [reason, count] of Object.entries(cell.excluded)) {
      totals[reason] = (totals[reason] ?? 0) + count;
    }
  }
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return 'None — every outcome in the sample was measurable.';
  return table(
    ['excluded reason', 'outcomes'],
    entries.map(([reason, count]) => [reason, String(count)]),
  );
}

export type ReportHeader = {
  strategyVersion: string;
  minSampleSize: number;
  totalOutcomes: number;
  generatedAt: Date;
};

/**
 * A count of samples whose window the tails never ingested.
 *
 * Both tails once failed silently for two days while discovery, snapshots and
 * signalling carried on: 828 of 1,242 signals (67%) were scored with zero trades
 * and zero holder rows behind them. §21's coverage gate contained the damage —
 * every one of those outcomes was written `incomplete_tail_coverage` rather than
 * measured from an empty window — but nothing in the REPORT said so, and a
 * reader counting signals rather than outcomes would have drawn conclusions from
 * a window in which nothing could have been observed.
 */
export type CoverageWarning = { uningested: number; total: number };

export function renderCoverageWarning(w: CoverageWarning): string {
  if (w.uningested === 0) return '';
  const pct = ((100 * w.uningested) / Math.max(w.total, 1)).toFixed(1);
  return [
    '',
    `!! ${w.uningested} of ${w.total} samples (${pct}%) come from windows the swap tail`,
    '   never ingested. Their features are not evidence about anything, and they',
    '   must not be used to calibrate thresholds. Measured outcomes are unaffected:',
    '   the coverage gate already refused to measure them.',
  ].join('\n');
}

export function renderHeader(header: ReportHeader): string {
  return [
    `Strategy evaluation (§22) — strategyVersion=${header.strategyVersion}`,
    `Generated ${header.generatedAt.toISOString()} over ${header.totalOutcomes} outcomes.`,
    '',
    `Cells with fewer than ${header.minSampleSize} measured outcomes report INSUFFICIENT`,
    'rather than a figure. §22 warns against tuning on averages from skewed data,',
    'and a win rate drawn from a handful of outcomes is noise, not evidence.',
    '',
    'Returns are medians with a p10/p90 spread; the mean is deliberately not the',
    'headline. `n` counts outcomes, `tok` counts distinct tokens — outcomes from',
    'one token are correlated, so `tok` is the honest measure of independent evidence.',
    '',
    'Profit factor assumes a notional entry at the frozen signal price and an exit',
    'at the horizon price. That is a measurement convention, not a trade rule:',
    'this system does not trade and makes no claim that these results are tradeable (§28).',
  ].join('\n');
}

export function renderFooter(): string {
  return [
    'Findings only — no recommendation is implied. Any threshold change is a human',
    'decision and mints a new strategyVersion (§22).',
  ].join('\n');
}
