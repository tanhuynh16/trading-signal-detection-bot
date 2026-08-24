import { z } from 'zod';
import type { SecurityProvider, SecurityReport, RiskFlag } from '@sdb/domain';
import { TransientProviderError, type Address } from '@sdb/shared';

/**
 * GoPlus token-security adapter.
 *
 * Enrichment only. Measured behaviour on Base: a mature token returns 39
 * fields, but a one-minute-old token returns 10 — with is_honeypot,
 * is_mintable, is_blacklisted all absent and the tax fields empty strings — and
 * it was still 10 fields six minutes later. GoPlus does not index tokens inside
 * this bot's operating window, so it can never be the source of a critical
 * verdict. The simulator covers those; this fills the rest when it happens to
 * have data.
 *
 * The rule that makes this safe: an absent field becomes UNKNOWN, never "safe".
 */

/**
 * GoPlus encodes booleans as the STRINGS '0' and '1', and uses '' for "not
 * analysed". Treating '' as falsey would silently read "unknown" as "clean",
 * which is the exact failure mode §14 exists to prevent.
 */
const flagString = z.string().optional();

const tokenSecuritySchema = z
  .object({
    is_honeypot: flagString,
    cannot_buy: flagString,
    cannot_sell_all: flagString,
    is_blacklisted: flagString,
    is_whitelisted: flagString,
    transfer_pausable: flagString,
    trading_cooldown: flagString,
    is_mintable: flagString,
    can_take_back_ownership: flagString,
    hidden_owner: flagString,
    owner_change_balance: flagString,
    is_proxy: flagString,
    buy_tax: flagString,
    sell_tax: flagString,
    transfer_tax: flagString,
    owner_percent: flagString,
    creator_percent: flagString,
    lp_holder_count: flagString,
    holder_count: flagString,
    holders: z.array(z.object({ percent: flagString }).passthrough()).optional(),
    lp_holders: z.array(z.object({ percent: flagString, is_locked: z.number().optional() }).passthrough()).optional(),
  })
  .passthrough();

const responseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  result: z.record(z.string(), tokenSecuritySchema).optional(),
});

export type GoPlusConfig = {
  baseUrl: string;
  chainId: number;
  timeoutMs: number;
};

type Tri = true | false | null;

/** '1' -> true, '0' -> false, '' or absent -> null (unknown). */
function tri(value: string | undefined): Tri {
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

/** Parse a percentage-ish string; '' and absent are unknown, not zero. */
function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The normalized shape the risk rules consume. Every field is tri-state so a
 * rule can distinguish "known safe" from "we have no idea".
 */
export type GoPlusFindings = {
  isHoneypot: Tri;
  cannotBuy: Tri;
  cannotSellAll: Tri;
  isBlacklisted: Tri;
  transferPausable: Tri;
  tradingCooldown: Tri;
  isMintable: Tri;
  canTakeBackOwnership: Tri;
  hiddenOwner: Tri;
  ownerChangeBalance: Tri;
  buyTax: number | null;
  sellTax: number | null;
  transferTax: number | null;
  ownerPercent: number | null;
  creatorPercent: number | null;
  top10Percent: number | null;
  lpHolderCount: number | null;
  holderCount: number | null;
  /** True when GoPlus returned essentially nothing — a brand-new token. */
  unindexed: boolean;
};

export function normalizeGoPlus(raw: unknown): GoPlusFindings {
  const parsed = tokenSecuritySchema.safeParse(raw);
  const v = parsed.success ? parsed.data : {};

  const holders = v.holders ?? [];
  const top10 = holders
    .slice(0, 10)
    .map((h) => num(h.percent))
    .filter((p): p is number => p !== null)
    .reduce((sum, p) => sum + p, 0);

  const findings: GoPlusFindings = {
    isHoneypot: tri(v.is_honeypot),
    cannotBuy: tri(v.cannot_buy),
    cannotSellAll: tri(v.cannot_sell_all),
    isBlacklisted: tri(v.is_blacklisted),
    transferPausable: tri(v.transfer_pausable),
    tradingCooldown: tri(v.trading_cooldown),
    isMintable: tri(v.is_mintable),
    canTakeBackOwnership: tri(v.can_take_back_ownership),
    hiddenOwner: tri(v.hidden_owner),
    ownerChangeBalance: tri(v.owner_change_balance),
    buyTax: num(v.buy_tax),
    sellTax: num(v.sell_tax),
    transferTax: num(v.transfer_tax),
    ownerPercent: num(v.owner_percent),
    creatorPercent: num(v.creator_percent),
    top10Percent: holders.length > 0 ? top10 : null,
    lpHolderCount: num(v.lp_holder_count),
    holderCount: num(v.holder_count),
    unindexed: false,
  };

  // "Unindexed" is the normal state for a token minutes old. Recognising it
  // explicitly keeps it out of the flag list as a finding in its own right,
  // rather than emitting a dozen separate UNKNOWN_ flags.
  findings.unindexed =
    findings.isHoneypot === null &&
    findings.isMintable === null &&
    findings.buyTax === null &&
    findings.sellTax === null;

  return findings;
}

export class GoPlusSecurityProvider implements SecurityProvider {
  readonly name = 'goplus';

  constructor(private readonly config: GoPlusConfig) {}

  async analyzeToken(tokenAddress: Address, poolAddress: Address): Promise<SecurityReport> {
    const url = `${this.config.baseUrl}/api/v1/token_security/${this.config.chainId}?contract_addresses=${tokenAddress}`;

    let payload: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) {
        throw new TransientProviderError(`goplus responded ${response.status}`);
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof TransientProviderError) throw error;
      throw new TransientProviderError('goplus request failed', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      // Schema drift. Treat as no data rather than guessing at the shape —
      // §25 requires validating provider responses.
      return { tokenAddress, poolAddress, flags: [], raw: payload, fetchedAt: new Date() };
    }

    // GoPlus lowercases the address key in its response.
    const entry = parsed.data.result?.[tokenAddress.toLowerCase()];
    return {
      tokenAddress,
      poolAddress,
      flags: [] as RiskFlag[], // flags are derived by the rule engine, not here
      raw: entry ?? parsed.data,
      fetchedAt: new Date(),
    };
  }
}
