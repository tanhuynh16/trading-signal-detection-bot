import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  featureSets,
  pools,
  riskResults,
  signalAlerts,
  signalTransitions,
  signals,
  tokenSnapshots,
  tokens,
} from '@sdb/database';
import { InvalidDataError, TransientProviderError } from '@sdb/shared';
import { loadAlertPayload, markFailed, markSent, pendingAlerts } from './payload.js';
import { renderAlert } from './format.js';
import { FailingNotifier, RecordingNotifier, TelegramNotifier } from './telegram.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const WETH = '0x4200000000000000000000000000000000000006';
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

let seq = 0;
async function seedAlert(over: { symbol?: string | null; status?: string } = {}) {
  seq += 1;
  const [token] = await db
    .insert(tokens)
    .values({
      chainId: CHAIN,
      address: w(1000 + seq),
      symbol: over.symbol === undefined ? 'PEPE' : over.symbol,
      firstSeenAt: new Date(),
      decimals: 18,
    })
    .returning({ id: tokens.id });
  const [pool] = await db
    .insert(pools)
    .values({
      tokenId: token!.id,
      chainId: CHAIN,
      dex: 'uniswap-v2',
      address: w(5000 + seq),
      quoteTokenAddress: WETH,
      discoveredAt: new Date(Date.now() - 12 * 60_000),
      blockNumber: 1n,
      transactionHash: `0x${seq.toString(16).padStart(64, '0')}`,
    })
    .returning({ id: pools.id });
  await db.insert(tokenSnapshots).values({
    tokenId: token!.id,
    poolId: pool!.id,
    scheduledOffset: 'T0',
    blockNumber: 1n,
    observedAt: new Date(),
    capturedAt: new Date(),
    marketCapUsd: '420000',
    liquidityUsd: '96000',
  });
  await db.insert(riskResults).values({
    tokenId: token!.id,
    poolId: pool!.id,
    evaluatedAt: new Date(),
    status: 'WARNING',
    riskScore: '30.000',
    flags: [{ code: 'HOLDER_CONCENTRATION', severity: 'HIGH', message: 'top 10 hold 42%' }],
  });
  const [featureSet] = await db
    .insert(featureSets)
    .values({
      tokenId: token!.id,
      poolId: pool!.id,
      calculatedAt: new Date(),
      featureVersion: 'features-v1',
      scheduledOffset: `t${seq}`,
      values: {},
      normalizedValues: {},
    })
    .returning({ id: featureSets.id });
  const [signal] = await db
    .insert(signals)
    .values({
      tokenId: token!.id,
      poolId: pool!.id,
      state: 'STRONG_SIGNAL',
      alphaScore: '84.000',
      components: [
        { name: 'liquidity', raw: 66, weight: 0.2 },
        { name: 'momentum', raw: 78, weight: 0.3 },
        { name: 'holder', raw: 71, weight: 0.2 },
        { name: 'smartMoney', raw: null, weight: 0.3 },
      ],
      coverage: '0.7000',
      strategyVersion: 'base-meme-v1',
      alertLevel: 'STRONG',
    })
    .returning({ id: signals.id });
  const [alert] = await db
    .insert(signalAlerts)
    .values({
      signalId: signal!.id,
      tokenId: token!.id,
      featureSetId: featureSet!.id,
      alertLevel: 'STRONG',
      status: over.status ?? 'PENDING',
      triggerReason: 'FIRST_ALERT',
      alphaScore: '84.000',
    })
    .returning({ id: signalAlerts.id });

  return { alertId: alert!.id, tokenId: token!.id, poolId: pool!.id };
}

const truncate = sql`TRUNCATE ${signalAlerts}, ${signalTransitions}, ${signals},
  ${riskResults}, ${featureSets}, ${tokenSnapshots}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`;

beforeEach(async () => {
  await db.execute(truncate);
});
afterAll(async () => {
  await db.execute(truncate);
  await close();
});

describe('payload assembly (§20 content)', () => {
  it('gathers everything the message needs in one call', async () => {
    const { alertId } = await seedAlert();
    const payload = (await loadAlertPayload(db, alertId))!;

    expect(payload.symbol).toBe('PEPE');
    expect(payload.alertLevel).toBe('STRONG');
    expect(payload.marketCapUsd).toBe(420_000);
    expect(payload.liquidityUsd).toBe(96_000);
    expect(payload.alphaScore).toBe(84);
    expect(payload.coverage).toBeCloseTo(0.7, 4);
    expect(payload.components).toHaveLength(4);
    expect(payload.riskFlags[0]!.message).toBe('top 10 hold 42%');
    expect(payload.ageMinutes).toBeGreaterThan(11);
  });

  it('renders a complete §20 message from real rows', async () => {
    const { alertId } = await seedAlert();
    const text = renderAlert((await loadAlertPayload(db, alertId))!);

    expect(text).toContain('STRONG SIGNAL');
    expect(text).toContain('MC: $420K');
    expect(text).toContain('Liquidity: $96K');
    expect(text).toContain('• Smart Money: not measured');
    expect(text).toContain('top 10 hold 42%');
    expect(text).toContain('Evidence coverage: 70%');
  });

  it('survives a token with no symbol', async () => {
    const { alertId } = await seedAlert({ symbol: null });
    const text = renderAlert((await loadAlertPayload(db, alertId))!);
    expect(text).toContain('TOKEN: $UNKNOWN');
  });

  it('returns null for an alert that no longer exists', async () => {
    expect(await loadAlertPayload(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('delivery lifecycle (§20)', () => {
  it('transitions PENDING to SENT and stamps sent_at', async () => {
    const { alertId } = await seedAlert();
    const notifier = new RecordingNotifier();
    await notifier.send(renderAlert((await loadAlertPayload(db, alertId))!));

    expect(await markSent(db, alertId)).toBe(true);
    const [row] = await db
      .select({ status: signalAlerts.status, sentAt: signalAlerts.sentAt })
      .from(signalAlerts);
    expect(row!.status).toBe('SENT');
    expect(row!.sentAt).not.toBeNull();
    expect(notifier.sent).toHaveLength(1);
  });

  it('cannot double-send: a second markSent is a no-op', async () => {
    // The status guard is what makes a duplicated job safe, not convention.
    const { alertId } = await seedAlert();
    expect(await markSent(db, alertId)).toBe(true);
    expect(await markSent(db, alertId)).toBe(false);
  });

  it('marks FAILED after retries are exhausted', async () => {
    const { alertId } = await seedAlert();
    const notifier = new FailingNotifier(new TransientProviderError('telegram down'));
    await expect(notifier.send()).rejects.toBeInstanceOf(TransientProviderError);

    expect(await markFailed(db, alertId)).toBe(true);
    const [row] = await db.select({ status: signalAlerts.status }).from(signalAlerts);
    expect(row!.status).toBe('FAILED');
  });

  it('does not mark an already-SENT alert as FAILED', async () => {
    const { alertId } = await seedAlert();
    await markSent(db, alertId);
    expect(await markFailed(db, alertId)).toBe(false);
  });

  it('a FAILED alert stops counting toward dedup, so the signal is not lost', async () => {
    // §20: a Telegram failure must not discard the signal. Phase 5.1's dedup
    // counts only SENT/PENDING, so FAILED makes the token re-alertable.
    const { alertId, tokenId } = await seedAlert();
    await markFailed(db, alertId);

    const counted = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ${signalAlerts}
          WHERE token_id = ${tokenId} AND status IN ('SENT','PENDING')`,
    );
    expect(Number(counted[0]!.n)).toBe(0);
  });

  it('lists pending alerts so a restart can requeue them', async () => {
    const a = await seedAlert();
    await seedAlert({ status: 'SENT' });
    const pending = await pendingAlerts(db);
    expect(pending).toEqual([a.alertId]);
  });
});

describe('transport error classification', () => {
  const notifier = () =>
    new TelegramNotifier({
      botToken: 'test-token',
      chatId: '123',
      baseUrl: 'http://stub.invalid',
      timeoutMs: 50,
    });

  it('treats a 5xx as transient so it retries', async () => {
    const stub = new FailingNotifier(new TransientProviderError('telegram responded 503'));
    await expect(stub.send()).rejects.toMatchObject({ retryable: true });
  });

  it('treats a bad chat id as permanent so it fails fast', async () => {
    // Retrying a 400 five times only buries the real cause behind exhausted
    // attempts.
    const stub = new FailingNotifier(new InvalidDataError('telegram rejected the message (400)'));
    await expect(stub.send()).rejects.toMatchObject({ retryable: false });
  });

  it('treats an unreachable host as transient', async () => {
    await expect(notifier().send('hi')).rejects.toBeInstanceOf(TransientProviderError);
  });
});

describe('permanent failure must not strand an alert (regression)', () => {
  it('marks FAILED immediately rather than leaving it PENDING forever', async () => {
    // Found live: guarded() swallows permanent errors after auditing, so the
    // worker's 'failed' handler never fires. Without marking FAILED at the
    // point of failure the row stayed PENDING — requeued on every restart, and
    // still counting toward dedup, so the token could never re-alert. That is
    // precisely the signal discard §20 forbids.
    const { alertId, tokenId } = await seedAlert();
    const permanent = new InvalidDataError('telegram rejected the message (401)');

    const notifier = new FailingNotifier(permanent);
    let caught: unknown;
    try {
      await notifier.send();
    } catch (error) {
      caught = error;
      if (!(error as { retryable?: boolean }).retryable) await markFailed(db, alertId);
    }

    expect((caught as { retryable: boolean }).retryable).toBe(false);
    const [row] = await db.select({ status: signalAlerts.status }).from(signalAlerts);
    expect(row!.status).toBe('FAILED');

    // And the token is free to alert again.
    const counted = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ${signalAlerts}
          WHERE token_id = ${tokenId} AND status IN ('SENT','PENDING')`,
    );
    expect(Number(counted[0]!.n)).toBe(0);
  });
});
