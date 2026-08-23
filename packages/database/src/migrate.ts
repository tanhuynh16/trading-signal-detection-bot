/**
 * Applies pending Drizzle migrations, then exits. Runs as a one-shot container
 * before the worker/api start (see docker-compose.yml).
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createLogger } from '@sdb/shared';
import { createDatabase } from './client.js';

const logger = createLogger({ name: 'migrate' });

const url = process.env.DATABASE_URL;
if (!url) {
  logger.fatal('DATABASE_URL is required to run migrations');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../drizzle');

const { db, close } = createDatabase(url, { max: 1 });
try {
  await migrate(db, { migrationsFolder });
  logger.info({ migrationsFolder }, 'migrations applied');
} catch (error) {
  logger.fatal({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await close();
}
