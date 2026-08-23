import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { loadEnv } from '@sdb/config';
import { createDatabase } from '@sdb/database';
import { bootstrap, createLogger, registerSecret } from '@sdb/shared';
import { runReadinessChecks } from './health.js';

const logger = createLogger({ name: 'api' });

// Spec §19/§27: bad configuration aborts startup loudly instead of degrading.
const env = bootstrap('api configuration is invalid', () => loadEnv(), logger);

// Spec §25: teach the logger the real secret values so a provider error that
// quotes its own request URL cannot leak the API key (§24).
for (const secret of [
  env.BASE_RPC_HTTP_URL,
  env.BASE_RPC_WSS_URL,
  env.DATABASE_URL,
  env.REDIS_URL,
  env.TELEGRAM_BOT_TOKEN,
]) {
  registerSecret(secret);
}

const { db, close: closeDb } = createDatabase(env.DATABASE_URL, { max: 4 });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

const app = Fastify({ loggerInstance: logger });

/** Liveness: the process is up. Never touches a dependency. */
app.get('/health', async () => ({ status: 'ok', strategyVersion: env.STRATEGY_VERSION }));

/** Readiness: every dependency the pipeline needs is reachable. */
app.get('/ready', async (_request, reply) => {
  const checks = await runReadinessChecks({ db, redis, rpcUrl: env.BASE_RPC_HTTP_URL });
  const ok = checks.every((check) => check.ok);
  return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down api');
  await app.close();
  await redis.quit().catch(() => redis.disconnect());
  await closeDb();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await redis.connect();
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: env.API_PORT }, 'api listening');
} catch (error) {
  logger.fatal({ err: error }, 'api failed to start');
  process.exit(1);
}
