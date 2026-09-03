/**
 * Drain coordination for the global tails.
 *
 * Extracted from `main.ts` so the failure semantics are testable, because they
 * are the part that went wrong. Both tails used to drain sequentially inside a
 * single try/catch: a throw from the swap tail meant the transfer tail never
 * ran, and the shared catch logged one line and let discovery carry on.
 *
 * Measured consequence on 27-28 Aug: 852 pools discovered, 4,826 snapshots and
 * 828 signals recorded with ZERO trades and ZERO holder rows. §21's coverage
 * gate did its job — all 4,542 outcomes over those days were written
 * `incomplete_tail_coverage` instead of being measured from an empty window —
 * but nothing named the cause, because a swallowed error and a quiet market are
 * indistinguishable from outside.
 */

export type TailLogger = {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
};

export type TailDrain = (head: bigint, firstDrain: boolean) => Promise<unknown>;

/**
 * How many drains in a row a tail may fail before it is reported as a fault.
 *
 * One failure is noise — a provider hiccup, already bounded by §23's retries. A
 * tail that has failed this many consecutive passes is not having a bad moment,
 * it is down, and every signal scored meanwhile carries none of its data.
 */
export const TAIL_FAILURE_ALARM = 5;

type TailState = { firstDrain: boolean; consecutiveFailures: number };

export class TailSupervisor {
  private readonly state = new Map<string, TailState>();

  constructor(
    private readonly logger: TailLogger,
    private readonly alarmAfter = TAIL_FAILURE_ALARM,
  ) {}

  /** Consecutive failures for a tail; 0 when healthy or never run. */
  failures(name: string): number {
    return this.state.get(name)?.consecutiveFailures ?? 0;
  }

  /**
   * Drain one tail, isolating its failure from every other tail.
   *
   * Never throws: a tail outage must not stop discovery, which is the one part
   * of the original design that was right. What it must not do is stay quiet.
   */
  async drain(name: string, head: bigint, run: TailDrain): Promise<boolean> {
    let state = this.state.get(name);
    if (state === undefined) {
      state = { firstDrain: true, consecutiveFailures: 0 };
      this.state.set(name, state);
    }

    try {
      await run(head, state.firstDrain);
    } catch (error) {
      state.consecutiveFailures += 1;
      const err = error instanceof Error ? error.message : String(error);
      if (state.consecutiveFailures >= this.alarmAfter) {
        this.logger.error(
          { tail: name, consecutiveFailures: state.consecutiveFailures, err },
          'tail is down; signals are being scored without its data and outcomes ' +
            'will record incomplete_tail_coverage until it recovers',
        );
      } else {
        this.logger.warn({ tail: name, err }, 'tail drain failed; will retry');
      }
      // The first-drain flag is deliberately NOT cleared. It gates the replay
      // overlap that covers a crash between "logs fetched" and "cursor
      // committed" — a drain that threw has precisely that exposure, so it
      // keeps the overlap for its next attempt.
      return false;
    }

    if (state.consecutiveFailures > 0) {
      this.logger.info(
        { tail: name, afterFailures: state.consecutiveFailures },
        'tail recovered',
      );
    }
    state.firstDrain = false;
    state.consecutiveFailures = 0;
    return true;
  }
}
