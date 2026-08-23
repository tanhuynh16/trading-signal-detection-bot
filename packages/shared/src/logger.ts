import pino from 'pino';
import { redactDeep, redactSecrets } from './redact.js';

/**
 * Spec §24: structured logs carry token, pool, job ID, strategyVersion and a
 * correlation ID. Spec §24/§25: credentials must never reach the log stream.
 */
export type LogContext = {
  correlationId?: string;
  tokenId?: string;
  poolId?: string;
  jobId?: string;
  strategyVersion?: string;
  [key: string]: unknown;
};

/**
 * Redaction is deliberately broad. Provider responses and config objects are
 * logged in places, and a leaked RPC URL contains an API key in its path.
 */
const REDACT_PATHS = [
  'apiKey',
  'api_key',
  // NB: no bare 'token' — in this domain that field holds a token contract
  // address, which is public. Redacting it hides the very data we discovered.
  'botToken',
  'privateKey',
  'secret',
  'password',
  'authorization',
  'DATABASE_URL',
  'BASE_RPC_HTTP_URL',
  'BASE_RPC_WSS_URL',
  'TELEGRAM_BOT_TOKEN',
  '*.apiKey',
  '*.botToken',
  '*.privateKey',
  '*.secret',
  '*.password',
  'req.headers.authorization',
];

export type Logger = pino.Logger;

export function createLogger(options: { level?: string; name?: string } = {}): Logger {
  return pino({
    name: options.name ?? 'sdb',
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
      // Field-name redaction cannot catch a key embedded inside an error
      // string, so every value is scrubbed on the way out (§24, §25).
      log: (object) => redactDeep(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg) =>
          typeof arg === 'string' ? redactSecrets(arg) : arg,
        ) as typeof args;
        return method.apply(this, scrubbed);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Bind pipeline context so every downstream line carries the correlation ID. */
export function withContext(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}

export const rootLogger: Logger = createLogger();
