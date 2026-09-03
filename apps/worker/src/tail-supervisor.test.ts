import { describe, expect, it, vi } from 'vitest';
import { TAIL_FAILURE_ALARM, TailSupervisor } from './tail-supervisor.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ok = async () => undefined;
const boom = async () => {
  throw new Error('provider exploded');
};

describe('TailSupervisor', () => {
  it('runs every tail even when an earlier one throws', async () => {
    // The regression. Both tails used to await sequentially inside ONE
    // try/catch, so a swap-tail throw meant the transfer tail never ran —
    // measured as two days of 0 trades AND 0 holder rows from a single fault.
    const log = logger();
    const sup = new TailSupervisor(log);
    const transfer = vi.fn(ok);

    await sup.drain('swap', 100n, boom);
    await sup.drain('transfer', 100n, transfer);

    expect(transfer).toHaveBeenCalledTimes(1);
    expect(sup.failures('swap')).toBe(1);
    expect(sup.failures('transfer')).toBe(0);
  });

  it('never throws, so a tail outage cannot stop discovery', async () => {
    const sup = new TailSupervisor(logger());
    await expect(sup.drain('swap', 1n, boom)).resolves.toBe(false);
  });

  it('keeps the replay overlap for a tail whose drain threw', async () => {
    // firstDrain gates the overlap that covers a crash between "logs fetched"
    // and "cursor committed". A drain that threw has exactly that exposure, so
    // it must retry WITH the overlap rather than lose it.
    const sup = new TailSupervisor(logger());
    const seen: boolean[] = [];
    const record = async (_h: bigint, first: boolean) => {
      seen.push(first);
      throw new Error('still broken');
    };

    await sup.drain('swap', 1n, record);
    await sup.drain('swap', 2n, record);

    expect(seen).toEqual([true, true]);
  });

  it('drops the overlap only after a drain actually succeeds', async () => {
    const sup = new TailSupervisor(logger());
    const seen: boolean[] = [];
    const record = async (_h: bigint, first: boolean) => {
      seen.push(first);
    };

    await sup.drain('swap', 1n, record);
    await sup.drain('swap', 2n, record);

    expect(seen).toEqual([true, false]);
  });

  it('does not let one tail’s success clear another’s overlap', async () => {
    const sup = new TailSupervisor(logger());
    const seen: boolean[] = [];

    await sup.drain('swap', 1n, ok);
    await sup.drain('transfer', 1n, async (_h, first) => {
      seen.push(first);
    });

    expect(seen).toEqual([true]);
  });

  it('warns while a failure could still be a hiccup', async () => {
    const log = logger();
    const sup = new TailSupervisor(log);

    await sup.drain('swap', 1n, boom);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('escalates to an error once a tail is persistently down', async () => {
    // §27: the failure must be written down as a fault. A silent swallow is why
    // 828 signals were scored with no trade data and nothing said so.
    const log = logger();
    const sup = new TailSupervisor(log);

    for (let i = 0; i < TAIL_FAILURE_ALARM; i += 1) {
      await sup.drain('swap', BigInt(i), boom);
    }

    expect(sup.failures('swap')).toBe(TAIL_FAILURE_ALARM);
    expect(log.error).toHaveBeenCalledTimes(1);
    const [, message] = log.error.mock.calls[0]!;
    expect(message).toContain('incomplete_tail_coverage');
  });

  it('resets the failure count and announces recovery', async () => {
    const log = logger();
    const sup = new TailSupervisor(log);

    await sup.drain('swap', 1n, boom);
    await sup.drain('swap', 2n, boom);
    await sup.drain('swap', 3n, ok);

    expect(sup.failures('swap')).toBe(0);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![0]).toMatchObject({ afterFailures: 2 });
  });

  it('reports no failures for a tail that has never run', () => {
    expect(new TailSupervisor(logger()).failures('swap')).toBe(0);
  });
});
