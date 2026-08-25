import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Spec §12 logical schema.
 *
 * Numeric conventions (plan G4): no float anywhere.
 *   usd/price  -> numeric(38, 18)
 *   raw uint256 -> numeric(78, 0)
 *   block numbers -> bigint
 * The pg driver returns numerics as strings; conversion happens at the domain
 * boundary via @sdb/shared/decimal.
 */
const usd = (name: string) => numeric(name, { precision: 38, scale: 18 });
const raw = (name: string) => numeric(name, { precision: 78, scale: 0 });

/** Spec §3: every row records when we learned it, distinct from event time. */
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: integer('chain_id').notNull(),
    address: text('address').notNull(),
    symbol: text('symbol'),
    name: text('name'),
    decimals: integer('decimals'),
    totalSupplyRaw: raw('total_supply_raw'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    addressUnique: uniqueIndex('tokens_chain_address_uq').on(t.chainId, t.address),
  }),
);

export const pools = pgTable(
  'pools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id),
    chainId: integer('chain_id').notNull(),
    dex: text('dex').notNull(),
    address: text('address').notNull(),
    quoteTokenAddress: text('quote_token_address').notNull(),
    /** Spec §11: pools with no allowlisted quote token are kept, deprioritized. */
    hasKnownQuoteToken: boolean('has_known_quote_token').notNull().default(true),
    /** Spec §3: block time, distinct from when we observed the event. */
    poolCreatedAt: timestamp('pool_created_at', { withTimezone: true }),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    transactionHash: text('transaction_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    // Spec §10.3: duplicate event delivery must not create a duplicate pool.
    addressUnique: uniqueIndex('pools_chain_address_uq').on(t.chainId, t.address),
    tokenIdx: index('pools_token_idx').on(t.tokenId),
    discoveredIdx: index('pools_discovered_idx').on(t.discoveredAt),
  }),
);

/**
 * Spec §10.2: persist the last processed block per discovery source so a
 * restart replays from cursor - overlap instead of skipping blocks.
 */
export const discoveryCursors = pgTable('discovery_cursors', {
  source: text('source').primaryKey(),
  lastProcessedBlock: bigint('last_processed_block', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tokenSnapshots = pgTable(
  'token_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => pools.id),
    /** Spec §13: identity for idempotent snapshot jobs. 'T0', '30s', '5m', ... */
    scheduledOffset: text('scheduled_offset').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    /** Block timestamp: when the chain state was true. */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    /** Wall clock: when we captured it. */
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    priceUsd: usd('price_usd'),
    marketCapUsd: usd('market_cap_usd'),
    liquidityUsd: usd('liquidity_usd'),
    baseReserveRaw: raw('base_reserve_raw'),
    quoteReserveRaw: raw('quote_reserve_raw'),
    volumeUsd5m: usd('volume_usd_5m'),
    buyCount5m: integer('buy_count_5m'),
    sellCount5m: integer('sell_count_5m'),
    uniqueBuyers5m: integer('unique_buyers_5m'),
    createdAt: createdAt(),
  },
  (t) => ({
    // Spec §13: replaying a snapshot job must not produce a second row.
    jobIdentity: uniqueIndex('token_snapshots_pool_offset_uq').on(t.poolId, t.scheduledOffset),
    poolTimeIdx: index('token_snapshots_pool_time_idx').on(t.poolId, t.capturedAt),
  }),
);

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => pools.id),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    wallet: text('wallet').notNull(),
    side: text('side').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    baseAmountRaw: raw('base_amount_raw').notNull(),
    quoteAmountRaw: raw('quote_amount_raw').notNull(),
    usdValue: usd('usd_value'),
    priceUsd: usd('price_usd'),
    createdAt: createdAt(),
  },
  (t) => ({
    // A log is uniquely identified by tx + log index; re-ingestion is a no-op.
    logIdentity: uniqueIndex('trades_tx_log_uq').on(t.txHash, t.logIndex),
    poolTimeIdx: index('trades_pool_time_idx').on(t.poolId, t.occurredAt),
    walletIdx: index('trades_wallet_idx').on(t.wallet),
  }),
);

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: integer('chain_id').notNull(),
    address: text('address').notNull(),
    /** 'seed' for the manually curated list (§15.5); 'observed' otherwise. */
    source: text('source').notNull(),
    alphaScore: numeric('alpha_score', { precision: 6, scale: 3 }),
    /** Spec §15.5: scores are versioned; recalculation must not lose history. */
    alphaScoreVersion: text('alpha_score_version'),
    metrics: jsonb('metrics'),
    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    addressUnique: uniqueIndex('wallets_chain_address_uq').on(t.chainId, t.address),
  }),
);

/** Spec §15.4: deterministic heuristics only. No graph database (§28). */
export const walletClusters = pgTable(
  'wallet_clusters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clusterKey: text('cluster_key').notNull(),
    walletAddress: text('wallet_address').notNull(),
    /** 'same_funder' | 'same_funding_tx' | 'similar_funding_time' | ... */
    evidenceType: text('evidence_type').notNull(),
    evidence: jsonb('evidence').notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    membership: uniqueIndex('wallet_clusters_key_wallet_uq').on(t.clusterKey, t.walletAddress),
    walletIdx: index('wallet_clusters_wallet_idx').on(t.walletAddress),
  }),
);

/** Spec §15.3: holder balances, maintained by the Transfer indexer (Phase 4b). */
export const holderBalances = pgTable(
  'holder_balances',
  {
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id),
    wallet: text('wallet').notNull(),
    balanceRaw: raw('balance_raw').notNull(),
    firstAcquiredAt: timestamp('first_acquired_at', { withTimezone: true }).notNull(),
    lastUpdatedBlock: bigint('last_updated_block', { mode: 'bigint' }).notNull(),
  },
  (t) => ({
    pk: uniqueIndex('holder_balances_token_wallet_uq').on(t.tokenId, t.wallet),
    balanceIdx: index('holder_balances_token_balance_idx').on(t.tokenId, t.balanceRaw),
  }),
);

export const riskResults = pgTable(
  'risk_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id),
    poolId: uuid('pool_id').references(() => pools.id),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    /** 'PASS' | 'WARNING' | 'FAIL' (§14) */
    status: text('status').notNull(),
    /** 0 = safest, 100 = riskiest (§14.2) */
    riskScore: numeric('risk_score', { precision: 6, scale: 3 }).notNull(),
    flags: jsonb('flags').notNull(),
    /** Spec §14.1: retain the raw security-provider response. */
    providerName: text('provider_name'),
    providerRaw: jsonb('provider_raw'),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenTimeIdx: index('risk_results_token_time_idx').on(t.tokenId, t.evaluatedAt),
  }),
);

export const featureSets = pgTable(
  'feature_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => pools.id),
    calculatedAt: timestamp('calculated_at', { withTimezone: true }).notNull(),
    featureVersion: text('feature_version').notNull(),
    /**
     * Which snapshot this feature set was computed for ('T0', '30s', ...).
     * Nullable so rows written before this column existed keep NULL, which
     * Postgres treats as distinct in the unique index below.
     */
    scheduledOffset: text('scheduled_offset'),
    /** Spec §15: nulls are represented explicitly, never coerced to 0. */
    values: jsonb('values').notNull(),
    normalizedValues: jsonb('normalized_values').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    // Without this a retried feature job inserts a SECOND row: BullMQ's jobId
    // stops re-enqueueing but not the 5 configured retry attempts. Every other
    // pipeline table already carries an equivalent guard.
    jobIdentity: uniqueIndex('feature_sets_pool_offset_uq').on(t.poolId, t.scheduledOffset),
    poolTimeIdx: index('feature_sets_pool_time_idx').on(t.poolId, t.calculatedAt),
  }),
);

export const signals = pgTable(
  'signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Monotonic insert order. `created_at` defaults to now(), which is
     * TRANSACTION START time — identical for every statement in a transaction.
     * Two overlapping transactions can therefore write rows whose created_at
     * order contradicts their commit order, and ordering "latest state" by it
     * returned a stale row, causing a transition to be applied twice. A
     * sequence is allocated at insert time, so under the per-token advisory
     * lock it strictly follows commit order.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => pools.id),
    createdAt: createdAt(),
    /** 'NEW' | 'WATCHING' | 'INTERESTING' | 'STRONG_SIGNAL' | 'EXPIRED' (§18) */
    state: text('state').notNull(),
    alphaScore: numeric('alpha_score', { precision: 6, scale: 3 }).notNull(),
    /** Spec §27: score output must include the component breakdown. */
    components: jsonb('components').notNull(),
    /** Plan G1: fraction of scoring weight backed by a non-null component. */
    coverage: numeric('coverage', { precision: 5, scale: 4 }).notNull(),
    /** Spec §21/§22: frozen at emission; never rewritten. */
    strategyVersion: text('strategy_version').notNull(),
    featureSetId: uuid('feature_set_id').references(() => featureSets.id),
    alertLevel: text('alert_level').notNull(),
    /** Reference price at signal time, frozen for outcome math (§21). */
    signalPriceUsd: usd('signal_price_usd'),
    signalBlockNumber: bigint('signal_block_number', { mode: 'bigint' }),
  },
  (t) => ({
    tokenTimeIdx: index('signals_token_time_idx').on(t.tokenId, t.createdAt),
    tokenSeqIdx: index('signals_token_seq_idx').on(t.tokenId, t.seq),
    stateIdx: index('signals_state_idx').on(t.state),
  }),
);

/** Spec §18: state transitions must be persisted. */
export const signalTransitions = pgTable(
  'signal_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => signals.id),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    reason: text('reason').notNull(),
    alphaScore: numeric('alpha_score', { precision: 6, scale: 3 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    signalIdx: index('signal_transitions_signal_idx').on(t.signalId, t.occurredAt),
  }),
);

export const signalOutcomes = pgTable(
  'signal_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => signals.id),
    /** '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '24h' (§21) */
    horizon: text('horizon').notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    priceUsd: usd('price_usd'),
    returnPct: numeric('return_pct', { precision: 20, scale: 6 }),
    maxRunupPct: numeric('max_runup_pct', { precision: 20, scale: 6 }),
    maxDrawdownPct: numeric('max_drawdown_pct', { precision: 20, scale: 6 }),
    /** Spec §27: unavailable provider data is recorded, not silently skipped. */
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
  },
  (t) => ({
    horizonIdentity: uniqueIndex('signal_outcomes_signal_horizon_uq').on(t.signalId, t.horizon),
  }),
);

/**
 * Alert decisions (§18 deduplication).
 *
 * Separate from `signals` because they answer different questions. ADR 0015
 * keeps `signals` as the canonical state-transition entity — one row per state
 * entry, the thing §21 attaches outcomes to. One such signal can legitimately
 * produce several alert decisions over its life: a first alert, then a re-alert
 * when the score moves past `rescoreDelta`, then another when the cooldown
 * lapses. Recording those as extra `signals` rows would corrupt both the state
 * history and the outcome series.
 */
export const signalAlerts = pgTable(
  'signal_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Monotonic insert order; see the note on signals.seq. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    signalId: uuid('signal_id')
      .notNull()
      .references(() => signals.id),
    /** Denormalised so dedup can look up a token's last alert in one query. */
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id),
    /** The evaluation that produced this decision; half the idempotency key. */
    featureSetId: uuid('feature_set_id')
      .notNull()
      .references(() => featureSets.id),
    alertLevel: text('alert_level').notNull(),
    /** Why we decided to alert: FIRST_ALERT | LEVEL_UPGRADED | SCORE_MOVED | COOLDOWN_ELAPSED */
    triggerReason: text('trigger_reason'),
    /** Lifecycle: PENDING | SENT | FAILED | SUPPRESSED */
    status: text('status').notNull(),
    /** Set when status is SUPPRESSED, so a non-alert is auditable too. */
    suppressionReason: text('suppression_reason'),
    alphaScore: numeric('alpha_score', { precision: 6, scale: 3 }).notNull(),
    createdAt: createdAt(),
    /** Filled by Phase 6 on successful delivery. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => ({
    // One decision per signal per evaluation. A retried job re-reads the same
    // feature set and conflicts; a genuine later re-alert carries a new one.
    decisionIdentity: uniqueIndex('signal_alerts_signal_feature_uq').on(
      t.signalId,
      t.featureSetId,
    ),
    // Dedup reads the most recent SENT/PENDING alert for a token.
    tokenStatusIdx: index('signal_alerts_token_status_idx').on(t.tokenId, t.status, t.seq),
  }),
);

/** Spec §23: permanent failures land here rather than retrying forever. */
export const jobsAudit = pgTable(
  'jobs_audit',
  {
    id: serial('id').primaryKey(),
    queue: text('queue').notNull(),
    jobId: text('job_id').notNull(),
    correlationId: text('correlation_id'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    queueIdx: index('jobs_audit_queue_time_idx').on(t.queue, t.occurredAt),
    correlationIdx: index('jobs_audit_correlation_idx').on(t.correlationId),
  }),
);
