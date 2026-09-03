import { loadEnv, getStrategyConfig } from '@sdb/config';
import { createDatabase } from '@sdb/database';
import { bootstrap, createLogger } from '@sdb/shared';
import { byBandAndHorizon, byCoverage, featureContribution } from './aggregate.js';
import { scoreBands } from './bands.js';
import { horizonsPresent, loadSamples, strategyVersions } from './query.js';
import {
  renderBands,
  renderExclusions,
  renderFeatures,
  renderFooter,
  renderCoverageWarning,
  renderHeader,
} from './report.js';

/**
 * `pnpm evaluate` — the §22 report.
 *
 * Read-only over immutable history, so it can be run as often as wanted and
 * always says the same thing about the same data. That reproducibility is §22's
 * requirement, and it comes free from the inputs being frozen: signals never
 * change, and outcomes only change when repaired under the coverage gate.
 */

const logger = createLogger({ name: 'evaluate' });

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const env = bootstrap('evaluation configuration is invalid', () => loadEnv(), logger);
const minSampleSize = Number(flag('min-n') ?? 30);
const sinceFlag = flag('since');
const since = sinceFlag ? new Date(sinceFlag) : undefined;
const horizonFilter = flag('horizon');

if (Number.isNaN(minSampleSize) || minSampleSize < 1) {
  logger.fatal({ minSampleSize }, '--min-n must be a positive number');
  process.exit(1);
}
if (since && Number.isNaN(since.getTime())) {
  logger.fatal({ since: sinceFlag }, '--since must be a parseable date');
  process.exit(1);
}

const { db, close } = createDatabase(env.DATABASE_URL, { max: 2 });

try {
  const versions = flag('strategy-version')
    ? [flag('strategy-version')!]
    : await strategyVersions(db);

  if (versions.length === 0) {
    console.log('No outcomes recorded yet — nothing to evaluate.');
    process.exit(0);
  }

  const horizons = horizonFilter ? [horizonFilter] : await horizonsPresent(db);
  const config = { minSampleSize };

  // One report per strategyVersion, never pooled: a signal scored under
  // different weights is not comparable evidence, and concatenating them would
  // quietly answer a question nobody asked (§22).
  for (const version of versions) {
    const samples = await loadSamples(db, {
      strategyVersion: version,
      ...(since ? { since } : {}),
      ...(horizonFilter ? { horizon: horizonFilter } : {}),
    });
    if (samples.length === 0) continue;

    const strategy = getStrategyConfig(version);
    const bands = scoreBands(strategy.scoring);
    const cells = byBandAndHorizon(samples, bands, horizons, config);

    console.log('');
    console.log(
      renderHeader({
        strategyVersion: version,
        minSampleSize,
        totalOutcomes: samples.length,
        generatedAt: new Date(),
      }),
    );

    // §22: say plainly when part of the sample was scored over a window the
    // tails never read, so nobody calibrates on it by accident.
    const uningested = samples.filter(
      (sample) => sample.failureReason === 'incomplete_tail_coverage',
    ).length;
    const warning = renderCoverageWarning({ uningested, total: samples.length });
    if (warning) console.log(warning);

    console.log('\n── Outcomes by score band ' + '─'.repeat(50));
    console.log(renderBands(cells));

    console.log('\n── Feature contribution (association, not causation) ' + '─'.repeat(23));
    console.log(renderFeatures(featureContribution(samples, horizons, config)));

    // One table across all horizons: rendering per horizon produced separate
    // tables whose columns did not line up, which makes them hard to compare.
    console.log('\n── Outcomes by evidence coverage ' + '─'.repeat(43));
    const coverageRows = horizons.flatMap((horizon) => byCoverage(samples, horizon, config));
    console.log(
      coverageRows.length > 0 ? renderBands(coverageRows) : 'No outcomes to group.',
    );

    console.log('\n── Unmeasurable outcomes ' + '─'.repeat(51));
    console.log(renderExclusions(cells));

    console.log('');
    console.log(renderFooter());
    console.log('');
  }
} catch (error) {
  logger.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    'evaluation failed',
  );
  process.exitCode = 1;
} finally {
  await close();
}
