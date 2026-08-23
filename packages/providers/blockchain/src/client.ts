import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { ConfigurationError } from '@sdb/shared';

/**
 * The single place viem and the RPC vendor are named. Spec §9: everything above
 * this file talks to `BlockchainProvider`, never to viem or Alchemy directly.
 */
export type ChainClients = {
  /** Reads, multicall, eth_getLogs. */
  http: PublicClient;
  /** New-head subscription only; discovery still drains via HTTP (see runner). */
  ws: PublicClient | null;
  close: () => Promise<void>;
};

export function createChainClients(options: {
  httpUrl: string;
  wsUrl?: string | undefined;
  expectedChainId?: number;
}): ChainClients {
  const expected = options.expectedChainId ?? base.id;
  if (expected !== base.id) {
    // The Uniswap V2 factory shares an address with BNB Chain, so a
    // misconfigured chain would silently index the wrong network's pools.
    throw new ConfigurationError(
      `this build targets Base (${base.id}); refusing to run against chain ${expected}`,
    );
  }

  const httpClient = createPublicClient({
    chain: base,
    transport: http(options.httpUrl, { batch: true, retryCount: 0 }),
  });

  const wsClient = options.wsUrl
    ? createPublicClient({
        chain: base,
        transport: webSocket(options.wsUrl, { retryCount: 0, keepAlive: true }),
      })
    : null;

  return {
    http: httpClient as PublicClient,
    ws: wsClient as PublicClient | null,
    close: async () => {
      // viem exposes the socket lazily; ignore if it was never opened.
      const transport = wsClient?.transport as { getRpcClient?: () => Promise<{ close(): void }> };
      const rpc = await transport?.getRpcClient?.().catch(() => null);
      rpc?.close();
    },
  };
}

/**
 * Startup guard: proves the endpoint really is Base before we index anything.
 * A wrong chain is silent corruption, not a crash, so it must be checked.
 */
export async function assertChainId(client: PublicClient): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== base.id) {
    throw new ConfigurationError(
      `RPC endpoint reports chain ${actual}, expected Base (${base.id})`,
    );
  }
}
