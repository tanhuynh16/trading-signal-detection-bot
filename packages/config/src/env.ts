import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { ConfigurationError } from '@sdb/shared';

/**
 * Spec §25: secrets come from environment variables, never from committed
 * files. Spec §19/§27: invalid configuration must fail loudly at startup rather
 * than degrade at runtime, so this throws instead of falling back to defaults
 * for anything that has no safe default.
 */

const addressList = z
  .string()
  .transform((value) => value.split(',').map((entry) => entry.trim().toLowerCase()))
  .pipe(z.array(z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a 0x address')).min(1));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Spec §10.2: WebSocket drives discovery; HTTP serves reads and multicall.
  BASE_RPC_HTTP_URL: z.string().url(),
  BASE_RPC_WSS_URL: z.string().url(),
  BASE_CHAIN_ID: z.coerce.number().int().positive().default(8453),

  // Spec §11: quote-token allowlist is configuration-driven.
  QUOTE_TOKEN_ALLOWLIST: addressList,

  // Phase 6 only; absent in earlier phases, so notifications stay disabled.
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  API_PORT: z.coerce.number().int().positive().default(3000),

  // Spec §10.2: replay overlap so a restart cannot skip blocks.
  DISCOVERY_BLOCK_OVERLAP: z.coerce.number().int().nonnegative().default(50),

  STRATEGY_VERSION: z.string().min(1).default('base-meme-v1'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  loadDotenv();
  const parsed = envSchema.safeParse({ ...process.env, ...source });
  if (!parsed.success) {
    // Report every problem at once; do not leak the values themselves.
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only: drop the memoized env so a fresh one is parsed. */
export function resetEnvCache(): void {
  cached = null;
}
