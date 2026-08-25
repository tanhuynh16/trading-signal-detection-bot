import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, notifierCircuit } from '@sdb/database';
import { InvalidDataError } from '@sdb/shared';
import {
  decide,
  failureCodeOf,
  isGlobalFailure,
  onFailure,
  onSuccess,
  readCircuit,
  writeCircuit,
  type CircuitConfig,
} from './circuit.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const NOTIFIER = 'telegram';
const config: CircuitConfig = { enabled: true, failureThreshold: 3, openDurationMs: 300_000 };
const forbidden = new InvalidDataError('telegram rejected the message (403)', { httpStatus: 403 });

/** Drive one failure through the full read → decide → persist cycle. */
async function applyFailure(error: unknown, exhausted = false) {
  const snapshot = await readCircuit(db, NOTIFIER);
  const global = isGlobalFailure(error, exhausted);
  const transition = onFailure(snapshot, { global, config });
  await writeCircuit(db, NOTIFIER, transition, {
    code: failureCodeOf(error),
    reason: error instanceof Error ? error.message : String(error),
  });
  return transition;
}

async function applySuccess() {
  const snapshot = await readCircuit(db, NOTIFIER);
  const transition = onSuccess(snapshot);
  await writeCircuit(db, NOTIFIER, transition, null);
  return transition;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${notifierCircuit}`);
});
afterAll(async () => {
  await db.execute(sql`TRUNCATE ${notifierCircuit}`);
  await close();
});

describe('durable circuit state (requirement 3)', () => {
  it('creates the row on first observation', async () => {
    expect(await readCircuit(db, NOTIFIER)).toBeNull();
    await applyFailure(forbidden);

    const snapshot = (await readCircuit(db, NOTIFIER))!;
    expect(snapshot.state).toBe('CLOSED');
    expect(snapshot.consecutiveFailures).toBe(1);
    expect(snapshot.lastFailureCode).toBe('HTTP_403');
  });

  it('survives a fresh connection — the point of persisting it', async () => {
    for (let i = 0; i < 3; i += 1) await applyFailure(forbidden);

    // A separate handle stands in for a restarted process.
    const other = createDatabase(url, { max: 1 });
    try {
      const snapshot = (await readCircuit(other.db, NOTIFIER))!;
      expect(snapshot.state).toBe('OPEN');
      expect(snapshot.consecutiveFailures).toBe(3);
      expect(snapshot.reopenAfter).not.toBeNull();
    } finally {
      await other.close();
    }
  });

  it('opens after exactly the configured threshold', async () => {
    const first = await applyFailure(forbidden);
    const second = await applyFailure(forbidden);
    const third = await applyFailure(forbidden);

    expect(first.justOpened).toBe(false);
    expect(second.justOpened).toBe(false);
    expect(third.justOpened).toBe(true);
    expect((await readCircuit(db, NOTIFIER))!.state).toBe('OPEN');
  });

  it('preserves opened_at across a failed probe', async () => {
    // "How long has alerting been down" must stay answerable.
    for (let i = 0; i < 3; i += 1) await applyFailure(forbidden);
    const openedAt = (await readCircuit(db, NOTIFIER))!.openedAt;

    await applyFailure(forbidden); // a probe that fails and re-opens
    expect((await readCircuit(db, NOTIFIER))!.openedAt).toEqual(openedAt);
  });
});

describe('refusing delivery while open (requirement 4)', () => {
  it('declines and reports when to retry', async () => {
    for (let i = 0; i < 3; i += 1) await applyFailure(forbidden);

    const verdict = decide(await readCircuit(db, NOTIFIER), config);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.retryAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('caps attempts at the threshold across many evaluations', async () => {
    // The measured defect: Phase 6 saw one failed send per evaluation. Here ten
    // evaluations attempt delivery only until the circuit opens.
    let attempted = 0;
    for (let i = 0; i < 10; i += 1) {
      const verdict = decide(await readCircuit(db, NOTIFIER), config);
      if (!verdict.allow) continue;
      attempted += 1;
      await applyFailure(forbidden);
    }
    expect(attempted).toBe(3);
  });
});

describe('recovery (requirement 6)', () => {
  it('a success closes the circuit and clears the counter', async () => {
    for (let i = 0; i < 3; i += 1) await applyFailure(forbidden);
    expect((await readCircuit(db, NOTIFIER))!.state).toBe('OPEN');

    const transition = await applySuccess();
    expect(transition.justClosed).toBe(true);

    const snapshot = (await readCircuit(db, NOTIFIER))!;
    expect(snapshot.state).toBe('CLOSED');
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.reopenAfter).toBeNull();
    expect(snapshot.lastSuccessAt).not.toBeNull();
  });

  it('admits a probe once the window has elapsed', async () => {
    for (let i = 0; i < 3; i += 1) await applyFailure(forbidden);
    // Age the window rather than waiting five minutes.
    await db.execute(
      sql`UPDATE ${notifierCircuit} SET reopen_after = now() - interval '1 minute'`,
    );

    const verdict = decide(await readCircuit(db, NOTIFIER), config);
    expect(verdict).toEqual({ allow: true, probe: true });
  });

  it('retains last_success_at after a later failure', async () => {
    await applySuccess();
    const success = (await readCircuit(db, NOTIFIER))!.lastSuccessAt;
    await applyFailure(forbidden);
    expect((await readCircuit(db, NOTIFIER))!.lastSuccessAt).toEqual(success);
  });
});

describe('per-message failures never open the circuit', () => {
  it('ignores repeated 400s', async () => {
    // One token with a pathological symbol must not silence every other token.
    const badRequest = new InvalidDataError('telegram rejected the message (400)', {
      httpStatus: 400,
    });
    for (let i = 0; i < 10; i += 1) await applyFailure(badRequest);

    const snapshot = await readCircuit(db, NOTIFIER);
    expect(snapshot!.state).toBe('CLOSED');
    expect(snapshot!.consecutiveFailures).toBe(0);
    expect(decide(snapshot, config).allow).toBe(true);
  });

  it('a 400 does not reset a counter built from global failures', async () => {
    await applyFailure(forbidden);
    await applyFailure(forbidden);
    await applyFailure(
      new InvalidDataError('telegram rejected the message (400)', { httpStatus: 400 }),
    );
    expect((await readCircuit(db, NOTIFIER))!.consecutiveFailures).toBe(2);
  });
});

describe('disabled breaker', () => {
  it('never refuses delivery', async () => {
    const off = { ...config, enabled: false };
    for (let i = 0; i < 5; i += 1) {
      const snapshot = await readCircuit(db, NOTIFIER);
      const transition = onFailure(snapshot, { global: true, config: off });
      await writeCircuit(db, NOTIFIER, transition, { code: 'HTTP_403', reason: 'x' });
    }
    expect(decide(await readCircuit(db, NOTIFIER), off).allow).toBe(true);
  });
});
