import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@sdb/shared';
import { loadEnv } from './env.js';

const WETH = '0x4200000000000000000000000000000000000006';

const minimal = {
  DATABASE_URL: 'postgres://sdb:sdb@localhost:5432/sdb',
  REDIS_URL: 'redis://localhost:6379',
  BASE_RPC_HTTP_URL: 'https://base-mainnet.example/v2/key',
  BASE_RPC_WSS_URL: 'wss://base-mainnet.example/v2/key',
  QUOTE_TOKEN_ALLOWLIST: WETH,
} as NodeJS.ProcessEnv;

describe('env', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const env = loadEnv(minimal);
    expect(env.BASE_CHAIN_ID).toBe(8453);
    expect(env.API_PORT).toBe(3000);
    expect(env.STRATEGY_VERSION).toBe('base-meme-v1');
  });

  it('lowercases the quote-token allowlist (spec §11 canonical form)', () => {
    const env = loadEnv({
      ...minimal,
      QUOTE_TOKEN_ALLOWLIST: WETH.toUpperCase().replace('0X', '0x'),
    });
    expect(env.QUOTE_TOKEN_ALLOWLIST).toEqual([WETH]);
  });

  it('fails loudly on a missing required secret rather than defaulting', () => {
    const { DATABASE_URL: _omitted, ...rest } = minimal;
    expect(() => loadEnv({ ...rest, DATABASE_URL: '' })).toThrow(ConfigurationError);
  });

  it('rejects a malformed address in the allowlist', () => {
    expect(() => loadEnv({ ...minimal, QUOTE_TOKEN_ALLOWLIST: '0x123' })).toThrow(
      ConfigurationError,
    );
  });

  it('leaves telegram credentials optional before phase 6', () => {
    expect(loadEnv(minimal).TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});
