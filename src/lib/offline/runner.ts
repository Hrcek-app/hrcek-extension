export interface Runner<R> {
  /** Starts a sync, or joins the one already started. */
  sync(): Promise<R>;
  /** Runs `work` with nothing else running, in the order asked. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * One thing at a time in the background: two syncs, or a sync and a
 * "Replace with mine", must never send the same entry twice.
 */
export function createRunner<R>(sync: () => Promise<R>): Runner<R> {
  let tail: Promise<unknown> = Promise.resolve();
  let syncing: Promise<R> | null = null;

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  }

  return {
    exclusive,
    sync(): Promise<R> {
      syncing ??= exclusive(sync).finally(() => {
        syncing = null;
      });
      return syncing;
    },
  };
}
