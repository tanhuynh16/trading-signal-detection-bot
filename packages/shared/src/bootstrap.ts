import { SdbError } from './errors.js';
import { rootLogger, type Logger } from './logger.js';

/**
 * Startup-time failures should read as one actionable line, not a stack trace.
 * A ConfigurationError means an operator typed something wrong; dumping V8
 * frames at them buries the five field names that actually matter.
 */
export function fatal(message: string, error: unknown, logger: Logger = rootLogger): never {
  if (error instanceof SdbError) {
    logger.fatal({ code: error.code, ...error.context }, `${message}: ${error.message}`);
  } else {
    logger.fatal({ err: error }, message);
  }
  process.exit(1);
}

/** Run a startup step, converting any throw into a clean fatal exit. */
export function bootstrap<T>(message: string, step: () => T, logger?: Logger): T {
  try {
    return step();
  } catch (error) {
    fatal(message, error, logger);
  }
}
