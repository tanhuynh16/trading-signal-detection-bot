import { describe, expect, it } from 'vitest';
import { OUTCOME_HORIZONS_MS, SNAPSHOT_OFFSETS_MS, offsetLabel } from './time.js';

describe('time', () => {
  it('labels the spec §13 snapshot offsets', () => {
    expect(SNAPSHOT_OFFSETS_MS.map(offsetLabel)).toEqual([
      'T0',
      '30s',
      '1m',
      '2m',
      '5m',
      '10m',
      '30m',
      '1h',
    ]);
  });

  it('labels the spec §21 outcome horizons', () => {
    expect(OUTCOME_HORIZONS_MS.map(offsetLabel)).toEqual([
      '1m',
      '5m',
      '15m',
      '30m',
      '1h',
      '4h',
      '24h',
    ]);
  });

  it('keeps offsets strictly increasing so job identities stay unique', () => {
    const labels = SNAPSHOT_OFFSETS_MS.map(offsetLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
