import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

/**
 * One pool per process. `max` is deliberately modest: the worker's concurrency
 * is bounded by BullMQ, and spec §23 centralizes rate limiting rather than
 * relying on connection exhaustion as backpressure.
 */
export function createDatabase(url: string, options: { max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    // Numerics come back as strings; parsing them into JS floats would defeat
    // the whole point of numeric(38,18) (plan G4).
    transform: { undefined: null },
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}

export { schema };
