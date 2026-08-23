import type { PublicClient } from 'viem';
import type { Address as SdbAddress } from '@sdb/shared';
import { fromUnixSeconds, InvalidDataError, TransientProviderError } from '@sdb/shared';
import type {
  BlockchainProvider,
  SimulationRequest,
  SimulationResult,
} from '@sdb/domain';

/**
 * Spec §9 BlockchainProvider over viem. Every failure is classified into the
 * §23 retryable/permanent split here, so callers never have to interpret a
 * vendor's error text.
 */
export class ViemBlockchainProvider implements BlockchainProvider {
  constructor(private readonly client: PublicClient) {}

  async getCode(address: SdbAddress): Promise<`0x${string}`> {
    try {
      const code = await this.client.getCode({ address });
      return code ?? '0x';
    } catch (error) {
      throw new TransientProviderError(`getCode failed for ${address}`, {
        cause: message(error),
      });
    }
  }

  async getBlockNumber(): Promise<bigint> {
    try {
      return await this.client.getBlockNumber();
    } catch (error) {
      throw new TransientProviderError('getBlockNumber failed', { cause: message(error) });
    }
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<Date> {
    try {
      const block = await this.client.getBlock({ blockNumber });
      // A missing timestamp means the block was reorged out from under us,
      // which no amount of retrying fixes.
      if (block?.timestamp === undefined) {
        throw new InvalidDataError(`block ${blockNumber} has no timestamp`);
      }
      return fromUnixSeconds(block.timestamp);
    } catch (error) {
      if (error instanceof InvalidDataError) throw error;
      throw new TransientProviderError(`getBlock failed for ${blockNumber}`, {
        cause: message(error),
      });
    }
  }

  /**
   * Read-only simulation. Used by the risk engine (Phase 3) for buy/sell
   * probing; a revert is a legitimate result, not an error, so it is reported
   * as `success: false` rather than thrown.
   */
  async simulate(call: SimulationRequest): Promise<SimulationResult> {
    try {
      const result = await this.client.call({
        account: call.from,
        to: call.to,
        data: call.data,
        ...(call.value !== undefined ? { value: call.value } : {}),
        ...(call.blockNumber !== undefined ? { blockNumber: call.blockNumber } : {}),
      });
      return {
        success: true,
        returnData: result.data ?? null,
        gasUsed: null,
        revertReason: null,
      };
    } catch (error) {
      return {
        success: false,
        returnData: null,
        gasUsed: null,
        revertReason: message(error),
      };
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
