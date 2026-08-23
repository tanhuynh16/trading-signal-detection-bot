import { sql } from 'drizzle-orm';
import type { Database } from '@sdb/database';
import type { Redis } from 'ioredis';

export type CheckResult = { name: string; ok: boolean; latencyMs: number; error?: string };

async function timed(name: string, probe: () => Promise<unknown>): Promise<CheckResult> {
  const started = Date.now();
  try {
    await probe();
    return { name, ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Readiness probes the dependencies the pipeline cannot run without: Postgres,
 * Redis and the Base RPC. Liveness (`/health`) stays deliberately trivial so a
 * slow dependency never triggers a container restart loop.
 */
export async function runReadinessChecks(deps: {
  db: Database;
  redis: Redis;
  rpcUrl: string;
}): Promise<CheckResult[]> {
  return Promise.all([
    timed('postgres', () => deps.db.execute(sql`select 1`)),
    timed('redis', () => deps.redis.ping()),
    timed('base-rpc', async () => {
      const response = await fetch(deps.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`rpc responded ${response.status}`);
      const body = (await response.json()) as { result?: string; error?: unknown };
      if (!body.result) throw new Error(`rpc returned no result`);
      return body.result;
    }),
  ]);
}
