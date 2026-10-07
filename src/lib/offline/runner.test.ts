import { describe, expect, it } from 'vitest';
import { createRunner } from './runner';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('createRunner', () => {
  it('shares one sync between callers who ask while it runs', async () => {
    let runs = 0;
    const { open, opened } = gate();
    const runner = createRunner(async () => {
      runs += 1;
      await opened;
      return runs;
    });
    const first = runner.sync();
    const second = runner.sync();
    open();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(runs).toBe(1);
  });

  it('runs a fresh sync once the last one has finished', async () => {
    let runs = 0;
    const runner = createRunner(async () => ++runs);
    await runner.sync();
    expect(await runner.sync()).toBe(2);
  });

  it('never overlaps exclusive work with a sync', async () => {
    const order: string[] = [];
    const { open, opened } = gate();
    const runner = createRunner(async () => {
      order.push('sync:start');
      await opened;
      order.push('sync:end');
    });
    const syncing = runner.sync();
    const replacing = runner.exclusive(async () => {
      order.push('replace');
    });
    open();
    await Promise.all([syncing, replacing]);
    expect(order).toEqual(['sync:start', 'sync:end', 'replace']);
  });

  it('keeps going after work that failed', async () => {
    const runner = createRunner(async () => 'ok');
    await expect(
      runner.exclusive(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(await runner.sync()).toBe('ok');
  });
});
