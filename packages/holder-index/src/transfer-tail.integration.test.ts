import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, holderBalances, pools, tokens } from '@sdb/database';
import { ZERO_ADDRESS } from '@sdb/shared';
import { applyTransfers, NON_HOLDER_ADDRESSES, type DecodedTransfer } from './transfer-tail.js';

/** Requires: docker compose up -d postgres */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://sdb:sdb@localhost:5432/sdb';
const { db, close } = createDatabase(url, { max: 4 });

const CHAIN = 8453;
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const w = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const at = new Date('2026-08-24T12:00:00Z');

async function seed() {
  const [token] = await db
    .insert(tokens)
    .values({ chainId: CHAIN, address: TOKEN, firstSeenAt: at })
    .returning({ id: tokens.id });
  await db.insert(pools).values({
    tokenId: token!.id,
    chainId: CHAIN,
    dex: 'uniswap-v2',
    address: '0xccccccccccccccccccccccccccccccccccccccc1',
    quoteTokenAddress: '0x4200000000000000000000000000000000000006',
    discoveredAt: at,
    blockNumber: 1n,
    transactionHash: `0x${'1'.repeat(64)}`,
  });
  return token!.id;
}

const transfer = (from: string, to: string, value: bigint, block = 1n): DecodedTransfer => ({
  token: TOKEN as `0x${string}`,
  from: from as `0x${string}`,
  to: to as `0x${string}`,
  value,
  blockNumber: block,
});

async function apply(tokenId: string, transfers: DecodedTransfer[]) {
  const times = new Map(transfers.map((t) => [t.blockNumber.toString(), at]));
  return applyTransfers(db, new Map([[TOKEN, tokenId]]), transfers, times);
}

async function balances() {
  const rows = await db
    .select({ wallet: holderBalances.wallet, balance: holderBalances.balanceRaw })
    .from(holderBalances);
  return new Map(rows.map((r) => [r.wallet, BigInt(r.balance)]));
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${holderBalances}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE ${holderBalances}, ${pools}, ${tokens} RESTART IDENTITY CASCADE`);
  await close();
});

describe('transfer application (spec §15.3 via ADR 0005)', () => {
  it('credits the recipient of a mint', async () => {
    const tokenId = await seed();
    await apply(tokenId, [transfer(ZERO_ADDRESS, w(1), 1000n)]);

    const map = await balances();
    expect(map.get(w(1))).toBe(1000n);
    // The zero address is mint/burn, never a holder — counting it would
    // inflate holder_count and distort concentration (§15.3).
    expect(map.has(ZERO_ADDRESS)).toBe(false);
  });

  it('moves balance between wallets', async () => {
    const tokenId = await seed();
    await apply(tokenId, [transfer(ZERO_ADDRESS, w(1), 1000n)]);
    await apply(tokenId, [transfer(w(1), w(2), 400n, 2n)]);

    const map = await balances();
    expect(map.get(w(1))).toBe(600n);
    expect(map.get(w(2))).toBe(400n);
  });

  it('drops a wallet to zero when it sells out', async () => {
    const tokenId = await seed();
    await apply(tokenId, [transfer(ZERO_ADDRESS, w(1), 1000n)]);
    await apply(tokenId, [transfer(w(1), w(2), 1000n, 2n)]);

    const map = await balances();
    expect(map.get(w(1))).toBe(0n);
  });

  it('sums multiple transfers to the same wallet in one batch', async () => {
    const tokenId = await seed();
    await apply(tokenId, [
      transfer(ZERO_ADDRESS, w(1), 100n),
      transfer(ZERO_ADDRESS, w(1), 250n),
    ]);
    expect((await balances()).get(w(1))).toBe(350n);
  });

  it('handles uint256-scale balances without loss', async () => {
    const tokenId = await seed();
    const huge = 10n ** 30n + 7n;
    await apply(tokenId, [transfer(ZERO_ADDRESS, w(1), huge)]);
    // A float would round this; numeric(78,0) must return it exactly.
    expect((await balances()).get(w(1))).toBe(huge);
  });

  it('ignores transfers for tokens it is not tracking', async () => {
    const tokenId = await seed();
    const other = { ...transfer(ZERO_ADDRESS, w(1), 100n), token: w(999) as `0x${string}` };
    expect(await apply(tokenId, [other])).toBe(0);
  });

  it('excludes the burn sink as well as the zero address', () => {
    expect(NON_HOLDER_ADDRESSES.has(ZERO_ADDRESS)).toBe(true);
    expect(NON_HOLDER_ADDRESSES.size).toBe(2);
  });

  it('accumulates rather than overwriting across separate drains', async () => {
    // Two drains touching the same wallet must sum. A read-modify-write here
    // would lose one of them under concurrency.
    const tokenId = await seed();
    await apply(tokenId, [transfer(ZERO_ADDRESS, w(1), 100n)]);
    await apply(tokenId, [transfer(ZERO_ADDRESS, w(1), 100n, 2n)]);
    expect((await balances()).get(w(1))).toBe(200n);
  });
});

describe('balances funded before the cursor (partial observation)', () => {
  it('clamps at zero instead of storing a negative balance', async () => {
    // The wallet was funded before this tail started reading, so we only ever
    // see it spend. Measured before the clamp: 739 such rows across 123 tokens,
    // worst at -1.5e28.
    const tokenId = await seed();
    const spender = w(0x51);

    await apply(tokenId, [transfer(spender, w(0x52), 500n)]);

    const [row] = await db
      .select({
        balanceRaw: holderBalances.balanceRaw,
        partiallyObserved: holderBalances.partiallyObserved,
      })
      .from(holderBalances)
      .where(sql`${holderBalances.wallet} = ${spender}`);

    expect(BigInt(row!.balanceRaw)).toBe(0n);
    expect(row!.partiallyObserved).toBe(true);
  });

  it('clamps an existing balance driven negative by a later outflow', async () => {
    const tokenId = await seed();
    const wallet = w(0x53);

    await apply(tokenId, [transfer(ZERO_ADDRESS, wallet, 100n, 1n)]);
    await apply(tokenId, [transfer(wallet, w(0x54), 400n, 2n)]);

    const [row] = await db
      .select({
        balanceRaw: holderBalances.balanceRaw,
        partiallyObserved: holderBalances.partiallyObserved,
      })
      .from(holderBalances)
      .where(sql`${holderBalances.wallet} = ${wallet}`);

    expect(BigInt(row!.balanceRaw)).toBe(0n);
    expect(row!.partiallyObserved).toBe(true);
  });

  it('leaves a fully observed wallet unflagged', async () => {
    const tokenId = await seed();
    const wallet = w(0x55);

    await apply(tokenId, [transfer(ZERO_ADDRESS, wallet, 900n, 1n)]);
    await apply(tokenId, [transfer(wallet, w(0x56), 400n, 2n)]);

    const [row] = await db
      .select({
        balanceRaw: holderBalances.balanceRaw,
        partiallyObserved: holderBalances.partiallyObserved,
      })
      .from(holderBalances)
      .where(sql`${holderBalances.wallet} = ${wallet}`);

    expect(BigInt(row!.balanceRaw)).toBe(500n);
    expect(row!.partiallyObserved).toBe(false);
  });

  it('keeps the flag once set, even after a later inbound transfer', async () => {
    // Sticky on purpose: a wallet whose inbound history we missed does not
    // become fully observed because we later saw one transfer in. Its balance
    // stays a lower bound.
    const tokenId = await seed();
    const wallet = w(0x57);

    await apply(tokenId, [transfer(wallet, w(0x58), 300n, 1n)]);
    await apply(tokenId, [transfer(ZERO_ADDRESS, wallet, 700n, 2n)]);

    const [row] = await db
      .select({
        balanceRaw: holderBalances.balanceRaw,
        partiallyObserved: holderBalances.partiallyObserved,
      })
      .from(holderBalances)
      .where(sql`${holderBalances.wallet} = ${wallet}`);

    expect(BigInt(row!.balanceRaw)).toBe(700n);
    expect(row!.partiallyObserved).toBe(true);
  });
});
